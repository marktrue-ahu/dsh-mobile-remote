import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, openSync, closeSync, fsyncSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync, lstatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { GitOperationError, digest } from "./git-operations.js";
import { parseGitStatus } from "./git-service.js";

const MAX_CHANGESETS = 32;
const MAX_CHANGESET_FILES = 1000;
const MAX_CHANGESET_PATCH_BYTES = 8 * 1024 * 1024;
const CHANGESET_TTL = 10 * 60 * 1000;
const MAX_MESSAGE = 10_000;
const PATH_RE = /^(?!\/)(?![A-Za-z]:[\\/])(?!(?:^|[\\/])\.\.(?:[\\/]|$))(?!.*\0).+$/;

function invalid(message) { return new GitOperationError("invalid-argument", message); }
function nowMs() { return Date.now(); }
function stableError(code, message = code, options = {}) { return new GitOperationError(code, message, options); }
function trimOutput(text) { return String(text ?? "").trim(); }
function checkPath(path) {
	if (typeof path !== "string" || !PATH_RE.test(path) || path.includes("\\") || /[\x00-\x1f\x7f]/.test(path) || path.split("/").some((part) => part === "" || part === "." || part === "..")) throw invalid("invalid repository path");
	return path;
}
function isBinary(buffer) { return buffer.includes(0); }
function safeRead(root, path) {
	try {
		const full = resolve(root, path);
		const stat = lstatSync(full);
		if (!stat.isFile() || stat.size > 16 * 1024 * 1024) return null;
		return readFileSync(full);
	} catch { return null; }
}
function ensureMessage(message) {
	if (typeof message !== "string" || message.trim() === "") throw invalid("commit message must not be empty");
	if (message.length > MAX_MESSAGE || message.includes("\0")) throw invalid("commit message is too long or contains NUL");
	return message;
}
function parsePatch(patch) {
	if (!patch || /(?:^|\n)(?:Binary files|GIT binary patch)/.test(patch)) return { binary: true, prelude: patch, hunks: [] };
	const lines = patch.split(/(?<=\n)/);
	const starts = [];
	for (let i = 0; i < lines.length; i++) if (lines[i].startsWith("@@ ")) starts.push(i);
	if (starts.length === 0) return { binary: false, prelude: patch, hunks: [] };
	const prelude = lines.slice(0, starts[0]).join("");
	const hunks = starts.map((start, index) => {
		const body = lines.slice(start, starts[index + 1] ?? lines.length).join("");
		return {
			body,
			header: lines[start].trim(),
			additions: body.split(/(?<=\n)/).filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
			deletions: body.split(/(?<=\n)/).filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
		};
	});
	return { binary: false, prelude, hunks };
}
function resolveAuthorizedIndex(root, gitDirOutput, indexOutput) {
	let gitDir;
	let candidate;
	try {
		gitDir = realpathSync(resolve(root, gitDirOutput));
		candidate = resolve(root, indexOutput);
		try { if (lstatSync(candidate).isSymbolicLink()) throw stableError("workspace-not-allowed", "Git index symlinks are not allowed"); } catch (error) { if (error instanceof GitOperationError) throw error; }
		const canonical = existsSync(candidate)
			? realpathSync(candidate)
			: resolve(realpathSync(dirname(candidate)), basename(candidate));
		const escape = relative(gitDir, canonical);
		if (escape === ".." || escape.startsWith(`..${sep}`) || escape === "") throw stableError("workspace-not-allowed", "Git index is outside the repository metadata directory");
		return candidate;
	} catch (error) {
		if (error instanceof GitOperationError) throw error;
		throw stableError("provider-unavailable", "Git index path could not be verified");
	}
}
function syncDirectory(path) {
	try {
		const fd = openSync(path, "r");
		try { fsyncSync(fd); } finally { closeSync(fd); }
	} catch {}
}
function writeAtomic(path, bytes, expectedBytes) {
	const lockPath = `${path}.lock`;
	let fd;
	let installed = false;
	try {
		fd = openSync(lockPath, "wx", 0o600);
		const currentBytes = existsSync(path) ? readFileSync(path) : null;
		const matches = expectedBytes === undefined
			? true
			: expectedBytes === null ? currentBytes === null : Buffer.isBuffer(expectedBytes) && currentBytes?.equals(expectedBytes);
		if (!matches) throw stableError("state-changed", "Git index changed before atomic install", { requiresRefresh: true });
		let offset = 0;
		while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(lockPath, path);
		installed = true;
		syncDirectory(dirname(path));
	} finally {
		if (fd !== undefined) { try { closeSync(fd); } catch {} }
		if (!installed) { try { unlinkSync(lockPath); } catch {} }
	}
}

export function createGitWriteService({ git, operations, now = nowMs, onChanged } = {}) {
	const changeSets = new Map();
	const preconditions = new Map();
	const run = async (argv, root, signal, options = {}) => {
		if (typeof git?.runCommand !== "function") throw stableError("provider-unavailable", "Git command provider unavailable");
		return git.runCommand(argv, root, signal, { env: { GIT_TERMINAL_PROMPT: "0", GIT_INDEX_FILE: undefined, ...options.env } });
	};
	const repositoryRoot = async (repositoryId) => {
		const resolver = git?.repositoryRootForWrite ?? git?.repositoryRoot;
		if (typeof resolver !== "function") throw stableError("provider-unavailable", "Git repository provider unavailable");
		return resolver(repositoryId);
	};
	const cleanup = () => {
		for (const [id, value] of changeSets) if (value.expiresAt <= now()) { changeSets.delete(id); preconditions.delete(value.baseToken); }
		for (const [token, value] of preconditions) if (value.expiresAt !== undefined && value.expiresAt <= now()) preconditions.delete(token);
		while (changeSets.size > MAX_CHANGESETS) {
			const id = changeSets.keys().next().value;
			const value = changeSets.get(id);
			changeSets.delete(id);
			if (value) preconditions.delete(value.baseToken);
		}
	};
	const command = async (root, args, signal, options) => {
		try { return await run(["-C", root, ...args], root, signal, options); }
		catch (error) { if (signal?.aborted) throw stableError("cancelled", "Git operation was cancelled"); throw error; }
	};
	const optional = async (root, args, signal) => { try { return trimOutput(await command(root, args, signal)); } catch (error) { if (signal?.aborted) throw error; return null; } };
	const fileState = async (root, path, signal) => {
		checkPath(path);
		const data = safeRead(root, path);
		const hash = await optional(root, ["hash-object", "--", path], signal);
		return { exists: data !== null, hash, binary: data ? isBinary(data) : false };
	};
	const ensureNormalState = async (root, signal) => {
		const markers = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"];
		for (const marker of markers) {
			const location = await optional(root, ["rev-parse", "--git-path", marker], signal);
			if (location && existsSync(resolve(root, location))) throw stableError("conflicted", "repository is in an in-progress Git state", { requiresRefresh: true });
		}
	};
	const stateFacts = async (root, paths = [], signal) => {
		const statusText = await command(root, ["status", "--porcelain=v1", "-z", "-b"], signal);
		const indexRaw = await command(root, ["diff", "--cached", "--raw", "-z", "--no-renames", "--"], signal);
		const worktreeRaw = await command(root, ["diff", "--raw", "-z", "--no-renames", "--"], signal);
		const head = await optional(root, ["rev-parse", "--verify", "HEAD"], signal);
		const branch = await optional(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal);
		const indexTree = await optional(root, ["write-tree"], signal);
		const files = {};
		for (const path of paths) files[path] = await fileState(root, path, signal);
		return { head, branch, indexTree, statusText, indexRaw, worktreeRaw, files, digest: digest({ head, branch, indexTree, statusText, indexRaw, worktreeRaw, files }) };
	};
	const diffFor = async (root, kind, path, signal) => {
		const args = ["diff", ...(kind === "staged" ? ["--cached"] : []), "--binary", "--full-index", "--no-ext-diff", "--no-renames", "--unified=3", "--", path];
		try { return await command(root, args, signal); } catch (error) {
			if (error?.code === "git-command-failed" && !error?.message) return "";
			throw error;
		}
	};
	const makeChangeSet = async ({ repositoryId, kind = "working" } = {}) => {
		cleanup();
		if (!repositoryId || !["working", "staged"].includes(kind)) throw invalid("repositoryId and kind are required");
		const root = await repositoryRoot(repositoryId);
		const status = parseGitStatus(await command(root, ["status", "--porcelain=v1", "-z", "-b"]));
		const entries = status.entries.filter((entry) => kind === "working" ? entry.worktree !== " " : entry.index !== " " && entry.index !== "?");
		const paths = entries.flatMap((entry) => [entry.path, ...(entry.oldPath ? [entry.oldPath] : [])]);
		const facts = await stateFacts(root, paths);
		if (entries.length > MAX_CHANGESET_FILES) throw stableError("change-set-too-large", "change set contains too many files", { requiresRefresh: true });
		const files = [];
		const records = [];
		let patchBytes = 0;
		for (const entry of entries) {
			const path = checkPath(entry.path);
			if (entry.oldPath) checkPath(entry.oldPath);
			const patch = await diffFor(root, kind, path);
			patchBytes += Buffer.byteLength(patch, "utf8");
			if (patchBytes > MAX_CHANGESET_PATCH_BYTES) throw stableError("change-set-too-large", "change set diff exceeds the size limit", { requiresRefresh: true });
			const parsed = parsePatch(patch);
			const fileId = randomUUID();
			const hunks = parsed.binary ? [] : parsed.hunks.map((hunk) => ({ hunkId: randomUUID(), header: hunk.header, additions: hunk.additions, deletions: hunk.deletions }));
			const file = { fileId, path, ...(entry.oldPath ? { oldPath: entry.oldPath } : {}), index: entry.index, worktree: entry.worktree, rename: entry.rename, binary: parsed.binary || facts.files[path]?.binary === true, hunks };
			files.push(file);
			records.push({ file, patch, parsed, entry });
		}
		const changeSetId = randomUUID();
		const baseToken = randomUUID();
		const value = { changeSetId, repositoryId, kind, stateVersion: facts.digest, baseToken, expiresAt: now() + CHANGESET_TTL, root, facts, files, internal: new Map() };
		for (const record of records) value.internal.set(record.file.fileId, record);
		changeSets.set(changeSetId, value);
		preconditions.set(baseToken, { type: "change-set", repositoryId, changeSetId, expected: facts });
		return { changeSetId, repositoryId, kind, stateVersion: facts.digest, headOid: facts.head, indexTreeOid: facts.indexTree, preconditionToken: baseToken, expiresAt: value.expiresAt, files };
	};
	const getChangeSet = (id, repositoryId) => {
		cleanup();
		const value = changeSets.get(id);
		if (!value || value.repositoryId !== repositoryId || value.expiresAt <= now()) throw stableError("change-set-expired", "change set is missing or expired", { requiresRefresh: true });
		return value;
	};
	const normalizeSelections = (value, changeSet) => {
		if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw invalid("selections must contain 1 to 100 files");
		const selectedIds = new Set();
		return value.map((selection) => {
			if (!selection || typeof selection.fileId !== "string") throw invalid("invalid file selection");
			const file = changeSet.internal.get(selection.fileId);
			if (!file) throw invalid("unknown file selection");
			if (selectedIds.has(selection.fileId)) throw invalid("duplicate file selection");
			selectedIds.add(selection.fileId);
			const hunkIds = selection.hunkIds === undefined ? [] : selection.hunkIds;
			if (!Array.isArray(hunkIds) || hunkIds.length > 100) throw invalid("invalid hunk selection");
			// The public file descriptor is the source of truth for opaque hunk IDs.
			const allowed = new Set((file.file.hunks ?? []).map((hunk) => hunk.hunkId));
			for (const hunkId of hunkIds) if (typeof hunkId !== "string" || !allowed.has(hunkId)) throw invalid("unknown hunk selection");
			if (hunkIds.length > 0 && (file.file.binary || file.file.rename || file.parsed.hunks.length === 0)) throw invalid("binary, rename, or whole-file changes do not support hunk selection");
			return { fileId: selection.fileId, hunkIds: [...hunkIds] };
		});
	};
	const issueStageToken = (changeSet, kind, selections) => {
		const token = `stage_${digest({ baseToken: changeSet.baseToken, kind, selections })}`;
		preconditions.set(token, { type: kind, repositoryId: changeSet.repositoryId, changeSetId: changeSet.changeSetId, selectionsDigest: digest(selections), expected: changeSet.facts, expiresAt: changeSet.expiresAt });
		return token;
	};
	const check = async (operation) => {
		cleanup();
		if (!["git.stage", "git.unstage", "git.commit"].includes(operation.kind)) return;
		const token = preconditions.get(operation.preconditionToken);
		if (!token || token.repositoryId !== operation.repositoryId) throw stableError("state-changed", "precondition expired", { requiresRefresh: true });
		const root = await repositoryRoot(operation.repositoryId);
		if (operation.kind === "git.stage" || operation.kind === "git.unstage") {
			const params = operation.params;
			if (token.changeSetId !== params.changeSetId || token.selectionsDigest !== digest(params.selections)) throw invalid("precondition does not match selections");
			const current = await stateFacts(root, Object.values(token.expected.files).map((_, index) => Object.keys(token.expected.files)[index]));
			if (current.digest !== token.expected.digest) throw stableError("state-changed", "repository changed since the change set was created", { requiresRefresh: true });
		} else {
			if (token.paramsDigest !== digest({ message: operation.params.message })) throw invalid("precondition does not match commit message");
			const head = await optional(root, ["rev-parse", "--verify", "HEAD"]);
			const tree = await optional(root, ["write-tree"]);
			const branch = await optional(root, ["symbolic-ref", "--quiet", "HEAD"]);
			const name = await optional(root, ["config", "--get", "user.name"]);
			const email = await optional(root, ["config", "--get", "user.email"]);
			if (head !== token.expected.head || tree !== token.expected.tree || branch !== token.expected.branch || name !== token.expected.name || email !== token.expected.email) throw stableError("state-changed", "staged tree, HEAD, branch, or commit identity changed", { requiresRefresh: true });
		}
	};
	const stageInternal = async (operation, signal, update) => {
		const changeSet = getChangeSet(operation.params.changeSetId, operation.repositoryId);
		const root = changeSet.root;
		await ensureNormalState(root, signal);
		const tempDir = mkdtempSync(join(tmpdir(), "dsh-git-index-"));
		const tempIndex = join(tempDir, "index");
		let realIndex;
		let originalIndex = null;
		let installed = false;
		try {
			const gitDirOutput = trimOutput(await command(root, ["rev-parse", "--git-dir"], signal));
			const indexOutput = trimOutput(await command(root, ["rev-parse", "--git-path", "index"], signal));
			realIndex = resolveAuthorizedIndex(root, gitDirOutput, indexOutput);
			if (existsSync(realIndex)) {
				originalIndex = readFileSync(realIndex);
				writeAtomic(tempIndex, originalIndex);
			} else {
				await command(root, ["read-tree", "--empty"], signal, { env: { GIT_INDEX_FILE: tempIndex } });
			}
			update({ phase: operation.kind === "git.stage" ? "stage" : "unstage", phaseIndex: 1, phaseCount: 2 });
			for (const selection of operation.params.selections) {
				const file = changeSet.internal.get(selection.fileId);
				if (!file) throw stableError("change-set-expired", "change set is missing", { requiresRefresh: true });
				const env = { GIT_INDEX_FILE: tempIndex };
				if (selection.hunkIds.length > 0) {
					const wanted = new Set(selection.hunkIds);
					const patches = file.parsed.hunks.filter((_, index) => wanted.has(file.file.hunks[index].hunkId));
					const patch = file.parsed.prelude + patches.map((hunk) => hunk.body).join("");
					const patchFile = join(tempDir, `patch-${randomUUID()}.diff`);
					writeAtomic(patchFile, Buffer.from(patch, "utf8"));
					const applyOptions = operation.kind === "git.unstage" ? ["--reverse"] : [];
					try {
						await command(root, ["apply", "--cached", "--binary", "--whitespace=nowarn", "--check", ...applyOptions, patchFile], signal, { env });
						await command(root, ["apply", "--cached", "--binary", "--whitespace=nowarn", ...applyOptions, patchFile], signal, { env });
					} catch (error) {
						if (signal?.aborted) throw error;
						throw stableError("hunk-stale", "selected hunk is no longer applicable", { requiresRefresh: true });
					}
				} else if (operation.kind === "git.stage") {
					const paths = file.file.oldPath ? [file.file.oldPath, file.file.path] : [file.file.path];
					await command(root, ["add", "--all", "--", ...paths], signal, { env });
				} else if (await optional(root, ["rev-parse", "--verify", "HEAD"], signal)) {
					const paths = file.file.oldPath ? [file.file.oldPath, file.file.path] : [file.file.path];
					await command(root, ["reset", "--mixed", "HEAD", "--", ...paths], signal, { env });
				} else {
					await command(root, ["rm", "--cached", "--ignore-unmatch", "--", file.file.path], signal, { env });
				}
			}
			update({ phase: "stage", phaseIndex: 2, phaseCount: 2 });
			const resultIndexTree = trimOutput(await command(root, ["write-tree"], signal, { env: { GIT_INDEX_FILE: tempIndex } }));
			const before = await stateFacts(root, Object.keys(changeSet.facts.files), signal);
			if (before.indexTree !== changeSet.facts.indexTree || before.digest !== changeSet.facts.digest) throw stableError("state-changed", "repository changed before index commit", { requiresRefresh: true });
			const bytes = readFileSync(tempIndex);
			writeAtomic(realIndex, bytes, originalIndex);
			installed = true;
			const after = await stateFacts(root, Object.keys(changeSet.facts.files), signal);
			if (after.files && digest(after.files) !== digest(changeSet.facts.files)) throw stableError("unknown-result", "index updated but worktree changed concurrently", { requiresRefresh: true });
			const actualTree = await optional(root, ["write-tree"], signal);
			if (actualTree !== resultIndexTree) throw stableError("unknown-result", "index result could not be verified", { requiresRefresh: true });
			onChanged?.(operation.repositoryId, "index");
			return { status: "succeeded", result: { repositoryId: operation.repositoryId, headOid: after.head, indexTreeOid: actualTree, indexTree: actualTree, stateVersion: after.digest, changedPaths: operation.params.selections.map((selection) => changeSet.internal.get(selection.fileId)?.file.path).filter(Boolean) } };
		} catch (error) {
			if (installed) throw stableError("unknown-result", "index changed but its final state could not be verified", { requiresRefresh: true });
			if (error?.code === "EEXIST") throw stableError("repository-busy", "Git index is locked");
			throw error;
		} finally {
			try { unlinkSync(tempIndex); } catch {}
			rmSync(tempDir, { recursive: true, force: true });
		}
	};
	const commitPreflight = async ({ repositoryId, message } = {}) => {
		const root = await repositoryRoot(repositoryId);
		await ensureNormalState(root);
		const cleanMessage = ensureMessage(message);
		const head = await optional(root, ["rev-parse", "--verify", "HEAD"]);
		const tree = await optional(root, ["write-tree"]);
		const branch = await optional(root, ["symbolic-ref", "--quiet", "HEAD"]);
		if (!branch || !/^refs\/heads\/(?!\.)(?!.*(?:\.\.|\/\/|@\{))[^^\0\r\n]+$/.test(branch)) throw stableError("invalid-argument", "commit requires a checked out local branch");
		if (!tree) throw stableError("nothing-to-commit", "no staged tree is available");
		const files = trimOutput(await command(root, ["ls-files", "--cached"]));
		const headTree = head ? await optional(root, ["rev-parse", "HEAD^{tree}"]) : null;
		if (!files && !head) throw stableError("nothing-to-commit", "nothing is staged");
		if (head && headTree === tree) throw stableError("nothing-to-commit", "staged tree is unchanged");
		const name = await optional(root, ["config", "--get", "user.name"]);
		const email = await optional(root, ["config", "--get", "user.email"]);
		if (!name || !email) throw stableError("identity-unavailable", "repository commit identity is not configured");
		const token = randomUUID();
		preconditions.set(token, { type: "commit", repositoryId, paramsDigest: digest({ message: cleanMessage }), expected: { head, tree, branch, name, email }, expiresAt: now() + CHANGESET_TTL });
		return { repositoryId, head, headOid: head, stagedTree: tree, stagedTreeOid: tree, branch: branch.replace(/^refs\/heads\//, ""), identity: { name, email }, mobileCommitPolicy: "no-hooks", preconditionToken: token };
	};
	const commitInternal = async (operation, signal, update) => {
		const root = await repositoryRoot(operation.repositoryId);
		const token = preconditions.get(operation.preconditionToken);
		if (!token) throw stableError("state-changed", "commit precondition expired", { requiresRefresh: true });
		let refUpdateStarted = false;
		let refUpdated = false;
		try {
			update({ phase: "commit", phaseIndex: 1, phaseCount: 2 });
			const args = ["commit-tree", token.expected.tree];
			if (token.expected.head) args.push("-p", token.expected.head);
			args.push("--no-gpg-sign", "-m", ensureMessage(operation.params.message));
			const oid = trimOutput(await command(root, args, signal, { env: {
				GIT_AUTHOR_NAME: token.expected.name,
				GIT_AUTHOR_EMAIL: token.expected.email,
				GIT_COMMITTER_NAME: token.expected.name,
				GIT_COMMITTER_EMAIL: token.expected.email,
			} }));
			if (!/^[0-9a-f]{4,64}$/i.test(oid)) throw stableError("unknown-result", "commit object result could not be verified", { requiresRefresh: true });
			const currentTree = await optional(root, ["write-tree"], signal);
			if (currentTree !== token.expected.tree) throw stableError("state-changed", "staged tree changed during commit", { requiresRefresh: true });
			const ref = token.expected.branch;
			refUpdateStarted = true;
			try { await command(root, ["update-ref", ref, oid, token.expected.head ?? ""], signal); refUpdated = true; }
			catch (error) {
				if (signal?.aborted) throw stableError("unknown-result", "branch update result is uncertain", { requiresRefresh: true });
				throw stableError("state-changed", "branch changed during commit", { requiresRefresh: true });
			}
			update({ phase: "commit", phaseIndex: 2, phaseCount: 2 });
			const actualHead = await optional(root, ["rev-parse", "--verify", ref], signal);
			const actualTree = await optional(root, ["rev-parse", `${oid}^{tree}`], signal);
			if (actualHead !== oid || actualTree !== token.expected.tree) throw stableError("unknown-result", "commit ref update could not be verified", { requiresRefresh: true });
			onChanged?.(operation.repositoryId, "head,index");
			return { status: "succeeded", result: { repositoryId: operation.repositoryId, commitOid: oid, oid, headOid: actualHead, parentOid: token.expected.head, treeOid: actualTree, indexTreeOid: currentTree, tree: actualTree, branch: ref.replace(/^refs\/heads\//, "") } };
		} catch (error) {
			if (refUpdated || (refUpdateStarted && error?.code === "cancelled")) throw stableError("unknown-result", "branch update occurred but its final state could not be verified", { requiresRefresh: true });
			throw error;
		}
	};
	const submitStage = async ({ repositoryId, requestId, actor, changeSetId, selections, preconditionToken, unstage = false } = {}) => {
		const changeSet = getChangeSet(changeSetId, repositoryId);
		if (changeSet.baseToken !== preconditionToken || changeSet.kind !== (unstage ? "staged" : "working")) throw stableError("state-changed", "change set precondition does not match", { requiresRefresh: true });
		const normalized = normalizeSelections(selections, changeSet);
		const token = issueStageToken(changeSet, unstage ? "git.unstage" : "git.stage", normalized);
		return operations.submit({ repositoryId, requestId, actor, kind: unstage ? "git.unstage" : "git.stage", params: { changeSetId, selections: normalized }, preconditionToken: token });
	};
	const submitCommit = async ({ repositoryId, requestId, actor, message, preconditionToken, confirm } = {}) => {
		if (confirm !== true) throw stableError("confirmation-required", "commit requires an explicit confirmation");
		const cleanMessage = ensureMessage(message);
		return operations.submit({ repositoryId, requestId, actor, kind: "git.commit", params: { message: cleanMessage }, preconditionToken });
	};
	const capabilities = () => ({
		available: Boolean(git?.capabilities?.().available && operations?.isAvailable?.()),
		writes: Boolean(git?.capabilities?.().available && operations?.isAvailable?.()),
		mobileCommitPolicy: "no-hooks",
		externalConcurrencyProtection: "detect-only",
		features: { changes: true, stageFile: true, stageHunk: true, unstageFile: true, unstageHunk: true, commit: true, commitHooks: false },
		reason: !git?.capabilities?.().available ? "git-provider-unavailable" : !operations?.isAvailable?.() ? "operation-provider-unavailable" : null,
	});
	operations?.registerExecutor?.("git.stage", ({ operation, signal, update }) => stageInternal(operation, signal, update));
	operations?.registerExecutor?.("git.unstage", ({ operation, signal, update }) => stageInternal(operation, signal, update));
	operations?.registerExecutor?.("git.commit", ({ operation, signal, update }) => commitInternal(operation, signal, update));
	operations?.setPreconditionChecker?.(check);
	return { capabilities, createChangeSet: makeChangeSet, commitPreflight, submitStage, submitCommit, check, stop() { changeSets.clear(); preconditions.clear(); } };
}
