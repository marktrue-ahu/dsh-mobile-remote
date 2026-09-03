import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdtempSync, openSync, closeSync, fsyncSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync, lstatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { GitOperationError, digest } from "./git-operations.js";
import { parseGitStatus } from "./git-service.js";

const MAX_CHANGESETS = 32;

/** Stable DTO for every accepted asynchronous Git write. Kept pure for contract tests. */
export function acceptedOperationResponse(operation, queryUrl) {
	const id = operation?.operationId;
	const url = queryUrl ?? (id ? `/git/operations/${encodeURIComponent(id)}` : null);
	return {
		ok: true,
		accepted: true,
		operationId: id,
		requestId: operation?.requestId,
		status: operation?.status,
		deduplicated: operation?.deduplicated === true,
		queryUrl: url,
		queryLink: url,
		operation,
	};
}
const MAX_CHANGESET_FILES = 1000;
const MAX_CHANGESET_PATCH_BYTES = 8 * 1024 * 1024;
const CHANGESET_TTL = 10 * 60 * 1000;
const MAX_MESSAGE = 10_000;
const PATH_RE = /^(?!\/)(?![A-Za-z]:[\\/])(?!(?:^|[\\/])\.\.(?:[\\/]|$))(?!.*\0).+$/;
let disabledHooksDirectory;
function withoutHooks(args) {
	disabledHooksDirectory ??= mkdtempSync(join(tmpdir(), "dsh-git-disabled-hooks-"));
	return ["-c", `core.hooksPath=${disabledHooksDirectory}`, ...args];
}

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

export function createGitWriteService({ git, operations, now = nowMs, onChanged, preconditionSecret, providerSecret } = {}) {
	const injectedSecret = preconditionSecret ?? providerSecret;
	const secret = Buffer.isBuffer(injectedSecret) ? injectedSecret : Buffer.from(typeof injectedSecret === "string" ? injectedSecret : randomBytes(32));
	const changeSets = new Map();
	const preconditions = new Map();
	const run = async (argv, root, signal, options = {}) => {
		if (typeof git?.runCommand !== "function") throw stableError("provider-unavailable", "Git command provider unavailable");
		return git.runCommand(argv, root, signal, { input: options.input, env: { GIT_TERMINAL_PROMPT: "0", GIT_INDEX_FILE: undefined, ...options.env } });
	};
	const repositoryRoot = async (repositoryId) => {
		const resolver = git?.repositoryRootForWrite ?? git?.repositoryRoot;
		if (typeof resolver !== "function") throw stableError("provider-unavailable", "Git repository provider unavailable");
		return resolver(repositoryId);
	};
	const domainsFor = async (repositoryId, kind, params = {}) => {
		if (typeof git?.writeDomains !== "function") throw stableError("provider-incompatible", "Git provider does not support write coordination");
		if (typeof git?.coordinationDomains === "function") {
			try {
				const domains = await git.coordinationDomains(repositoryId, kind.startsWith("git.") ? kind : `git.${kind}`, params);
				if (!Array.isArray(domains) || !domains.length || domains.some((domain) => typeof domain !== "string" || domain === "")) throw new Error("invalid domains");
				return [...new Set(domains)];
			} catch (error) {
				if (error instanceof GitOperationError) throw error;
				throw stableError("provider-unavailable", "Git write coordination is unavailable");
			}
		}
		let value;
		try { value = await git.writeDomains(repositoryId); } catch (error) {
			if (error instanceof GitOperationError) throw error;
			throw stableError("provider-unavailable", "Git write coordination is unavailable");
		}
		const common = value?.commonDomain;
		const worktree = value?.worktreeDomain;
		const domains = kind === "stage" || kind === "unstage" ? [worktree] : kind === "commit" ? [common, worktree] : kind === "branch-switch" ? (params.remoteRef ? [common, worktree] : [worktree]) : kind === "branch-rename" ? [common, worktree] : [common];
		if (!domains.length || domains.some((domain) => typeof domain !== "string" || domain === "")) throw stableError("provider-incompatible", "Git provider returned invalid write coordination domains");
		return [...new Set(domains)];
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
	const command = async (root, args, signal, options = {}) => {
		try { return await run(["-C", root, ...args], root, signal, options); }
		catch (error) {
			if (signal?.aborted) throw stableError("cancelled", "Git operation was cancelled");
			if (/unable to create|cannot lock|another git process|\.lock/i.test(String(error?.message ?? ""))) throw stableError("repository-busy", "Git repository is locked");
			throw error;
		}
	};
	const optional = async (root, args, signal) => {
		try { return trimOutput(await command(root, args, signal)); }
		catch (error) {
			if (signal?.aborted || ["cancelled", "provider-unavailable", "git-provider-unavailable", "repository-busy", "workspace-not-allowed", "not-git-repository"].includes(error?.code)) throw error;
			return null;
		}
	};
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
		const unmerged = await command(root, ["ls-files", "--unmerged", "-z"], signal);
		if (unmerged.length > 0) throw stableError("conflicted", "repository has unmerged index entries", { requiresRefresh: true });
	};
	const validateBranchName = async (root, name, signal) => {
		if (typeof name !== "string" || name === "" || name.startsWith("-") || /[\x00-\x20~^:?*\\[\\]\\\\]/.test(name) || name.includes("..") || name.includes("@{")) throw invalid("invalid local branch name");
		try { await command(root, ["check-ref-format", `refs/heads/${name}`], signal); }
		catch (error) {
			if (error?.code === "git-command-failed" && error?.exitCode === 1) throw invalid("invalid local branch name");
			throw error;
		}
		return name;
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
	const switchRiskPaths = async (root, facts, targetOid, entries, signal) => {
		const paths = [...new Set(entries.flatMap((entry) => [entry.path, ...(entry.oldPath ? [entry.oldPath] : [])]))].map(checkPath);
		const risks = [];
		for (const path of paths) {
			const entry = entries.find((item) => item.path === path || item.oldPath === path);
			let risk;
			if (entry?.index === "?" && entry?.worktree === "?") risk = Boolean(await optional(root, ["ls-tree", "-r", "--name-only", targetOid, "--", path], signal));
			else risk = facts.head ? Boolean(await optional(root, ["diff", "--name-only", facts.head, targetOid, "--", path], signal)) : false;
			if (risk) risks.push(path);
		}
		return risks;
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
		await domainsFor(repositoryId, kind === "staged" ? "unstage" : "stage");
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
	const writeToken = (type, repositoryId, params, expected, expiresAt = now() + CHANGESET_TTL) => {
		const payload = JSON.stringify({ type, repositoryId, paramsDigest: digest(params), expected, expiresAt });
		const mac = createHmac("sha256", secret).update(payload).digest();
		const token = `write_${Buffer.from(payload).toString("base64url")}.${mac.toString("base64url")}`;
		preconditions.set(token, { type, repositoryId, paramsDigest: digest(params), expected, expiresAt });
		return token;
	};
	const verifyWriteToken = (token) => {
		if (typeof token !== "string" || !token.startsWith("write_")) return null;
		try {
			const separator = token.indexOf(".", 6);
			if (separator < 0 || token.indexOf(".", separator + 1) >= 0) return null;
			const payload = Buffer.from(token.slice(6, separator), "base64url");
			const supplied = Buffer.from(token.slice(separator + 1), "base64url");
			const expectedMac = createHmac("sha256", secret).update(payload).digest();
			if (supplied.length !== expectedMac.length || !timingSafeEqual(supplied, expectedMac)) return null;
			const record = JSON.parse(payload.toString("utf8"));
			if (!record || typeof record !== "object" || typeof record.type !== "string" || typeof record.repositoryId !== "string" || typeof record.paramsDigest !== "string" || !record.expected || typeof record.expected !== "object" || !Number.isFinite(record.expiresAt) || record.expiresAt <= now()) return null;
			return record;
		} catch { return null; }
	};
	const writeRecord = (token) => {
		const parsed = verifyWriteToken(token);
		if (!parsed) return null;
		const cached = preconditions.get(token);
		return cached && cached.repositoryId === parsed.repositoryId && cached.type === parsed.type ? cached : parsed;
	};
	const check = async (operation) => {
		cleanup();
		if (!["git.stage", "git.unstage", "git.commit", "git.branch-create", "git.branch-rename", "git.branch-switch"].includes(operation.kind)) return;
		const token = operation.kind.startsWith("git.branch-") ? branchRecord(operation.preconditionToken) : writeRecord(operation.preconditionToken) ?? preconditions.get(operation.preconditionToken);
		if (!token || token.repositoryId !== operation.repositoryId) throw stableError("state-changed", "precondition expired", { requiresRefresh: true });
		const root = await repositoryRoot(operation.repositoryId);
		if (operation.kind === "git.branch-create" || operation.kind === "git.branch-rename" || operation.kind === "git.branch-switch") {
			if (token.type !== operation.kind || token.paramsDigest !== digest(operation.params)) throw invalid("precondition does not match branch parameters");
			await ensureNormalState(root);
			const current = await stateFacts(root, []);
			if (operation.kind === "git.branch-create") {
				if (current.head !== token.expected.head || await optional(root, ["rev-parse", "--verify", token.expected.newRef]) !== null || (token.expected.remoteRef && await optional(root, ["rev-parse", "--verify", token.expected.remoteRef]) !== token.expected.startOid)) throw stableError("state-changed", "branch creation precondition changed", { requiresRefresh: true });
			} else if (operation.kind === "git.branch-rename") {
				const oldOid = await optional(root, ["rev-parse", "--verify", token.expected.oldRef]);
				const isCurrent = current.branch === operation.params.oldName;
				if (current.head !== token.expected.head || isCurrent !== token.expected.current || oldOid !== token.expected.oldOid || await optional(root, ["rev-parse", "--verify", token.expected.newRef]) !== null) throw stableError("state-changed", "branch rename precondition changed", { requiresRefresh: true });
			} else {
				const expectedPaths = Object.keys(token.expected.files ?? {});
				const observed = expectedPaths.length > 0 ? await stateFacts(root, expectedPaths) : current;
				const observedStatus = parseGitStatus(observed.statusText);
				const same = observed.head === token.expected.head && observed.branch === token.expected.branch && observed.indexTree === token.expected.indexTree
					&& digest({ entries: observedStatus.entries, counts: observedStatus.counts }) === digest(token.expected.status)
					&& digest(observed.files) === digest(token.expected.files);
				if (!same || await optional(root, ["rev-parse", "--verify", token.expected.targetRef]) !== token.expected.targetOid) throw stableError("state-changed", "branch switch precondition changed", { requiresRefresh: true });
			}
		} else if (operation.kind === "git.stage" || operation.kind === "git.unstage") {
			const params = operation.params;
			if (token.type !== operation.kind || token.paramsDigest !== digest(params) || !params.plan || token.expected.planDigest !== digest(params.plan)) throw invalid("precondition does not match selections");
			const expectedFacts = params.plan.facts;
			if (!expectedFacts || typeof expectedFacts !== "object" || !expectedFacts.files || typeof expectedFacts.files !== "object") throw invalid("invalid durable stage plan");
			const current = await stateFacts(root, Object.keys(expectedFacts.files));
			if (current.digest !== expectedFacts.digest) throw stableError("state-changed", "repository changed since the change set was created", { requiresRefresh: true });
		} else {
			if (token.type !== "git.commit" || token.paramsDigest !== digest(operation.params)) throw invalid("precondition does not match commit message");
			const head = await optional(root, ["rev-parse", "--verify", "HEAD"]);
			const tree = await optional(root, ["write-tree"]);
			const branch = await optional(root, ["symbolic-ref", "--quiet", "HEAD"]);
			const name = await optional(root, ["config", "--get", "user.name"]);
			const email = await optional(root, ["config", "--get", "user.email"]);
			if (head !== token.expected.head || tree !== token.expected.tree || branch !== token.expected.branch || name !== token.expected.name || email !== token.expected.email) throw stableError("state-changed", "staged tree, HEAD, branch, or commit identity changed", { requiresRefresh: true });
		}
	};
	const branchToken = (type, repositoryId, params, expected) => {
		const payload = JSON.stringify({ type, repositoryId, params, expected, expiresAt: now() + CHANGESET_TTL });
		const mac = createHmac("sha256", secret).update(payload).digest();
		const token = `branch_${Buffer.from(payload).toString("base64url")}.${mac.toString("base64url")}`;
		preconditions.set(token, { type, repositoryId, paramsDigest: digest(params), expected, expiresAt: JSON.parse(payload).expiresAt });
		return token;
	};
	// Branch tokens are self-contained: the map is only an in-process optimization.
	// This lets durable queued operations survive provider reconstruction.
	const verifyBranchToken = (token) => {
		if (typeof token !== "string" || !token.startsWith("branch_")) return null;
		try {
			const separator = token.indexOf(".", 7);
			if (separator < 0 || token.indexOf(".", separator + 1) >= 0) return null;
			const encoded = token.slice(7, separator);
			const supplied = Buffer.from(token.slice(separator + 1), "base64url");
			const payload = Buffer.from(encoded, "base64url");
			const expectedMac = createHmac("sha256", secret).update(payload).digest();
			if (supplied.length !== expectedMac.length || !timingSafeEqual(supplied, expectedMac)) return null;
			const record = JSON.parse(payload.toString("utf8"));
			if (!record || typeof record !== "object" || typeof record.type !== "string" || typeof record.repositoryId !== "string" || !record.params || typeof record.params !== "object" || !record.expected || typeof record.expected !== "object" || !Number.isFinite(record.expiresAt) || record.expiresAt <= now()) return null;
			return record;
		} catch { return null; }
	};
	const branchRecord = (token) => {
		const parsed = verifyBranchToken(token);
		if (!parsed) return null;
		const cached = preconditions.get(token);
		return cached && cached.repositoryId === parsed.repositoryId && cached.type === parsed.type ? cached : { ...parsed, paramsDigest: digest(parsed.params) };
	};
	const validateRemoteRef = async (root, value, signal) => {
		if (typeof value !== "string" || !value.startsWith("refs/remotes/") || value.length <= 13) throw invalid("remoteRef must be a remote-tracking ref");
		try { await command(root, ["check-ref-format", value], signal); }
		catch (error) {
			if (error?.code === "git-command-failed" && error?.exitCode === 1) throw invalid("remoteRef must be a remote-tracking ref");
			throw error;
		}
		const parts = value.slice("refs/remotes/".length).split("/");
		const remote = parts.shift();
		if (!remote || !(await optional(root, ["remote"], signal))?.split(/\r?\n/).includes(remote)) throw invalid("remote is not configured");
		const exact = await optional(root, ["for-each-ref", `--format=%(refname)%09%(objectname)`, value], signal);
		const [ref, oid] = String(exact ?? "").split("\t");
		if (ref !== value || !oid) throw stableError("target-changed", "remote branch no longer exists", { requiresRefresh: true });
		return { remote, oid };
	};
	const linkedWorktrees = async (root, signal) => {
		const text = await command(root, ["worktree", "list", "--porcelain"], signal);
		const result = [];
		let current;
		for (const line of `${text}\n`.split(/\r?\n/)) {
			if (line === "") { if (current) result.push(current); current = undefined; continue; }
			const split = line.indexOf(" ");
			if (split < 0) continue;
			const key = line.slice(0, split); const value = line.slice(split + 1);
			if (key === "worktree") { if (current) result.push(current); current = { path: value, branch: null }; }
			else if (current && key === "branch") current.branch = value;
		}
		return result;
	};
	const assertRenameAvailable = async (root, oldBranch, signal) => {
		const oldRef = `refs/heads/${oldBranch}`;
		const worktrees = await linkedWorktrees(root, signal);
		const other = worktrees.find((item) => item.branch === oldRef && resolve(item.path) !== resolve(root));
		if (other) throw stableError("repository-busy", "branch is checked out in another linked worktree", { requiresRefresh: true });
		return worktrees.some((item) => item.branch === oldRef && resolve(item.path) === resolve(root));
	};
	const branchPreflight = async ({ repositoryId, action = "create", name, newName, oldName, startOid, remoteRef, targetRef, targetBranch, localName } = {}) => {
		const root = await repositoryRoot(repositoryId);
		await ensureNormalState(root);
		await domainsFor(repositoryId, action === "switch" ? "branch-switch" : action === "rename" ? "branch-rename" : "branch-create");
		const facts = await stateFacts(root, []);
		if (action === "create") {
			const branch = await validateBranchName(root, name);
			const newRef = `refs/heads/${branch}`;
			if (await optional(root, ["rev-parse", "--verify", newRef]) !== null) throw stableError("branch-exists", "local branch already exists");
			let sourceOid = startOid;
			if (remoteRef !== undefined) {
				const remote = await validateRemoteRef(root, remoteRef);
				sourceOid = remote.oid;
			} else if (sourceOid !== undefined && sourceOid !== null) {
				if (!/^[0-9a-f]{40,64}$/i.test(String(sourceOid)) || !(await optional(root, ["rev-parse", "--verify", `${sourceOid}^{commit}`]))) throw invalid("startOid must identify a commit");
			} else {
				sourceOid = facts.head;
				if (!sourceOid) throw stableError("invalid-argument", "cannot create a branch from unborn HEAD");
			}
			const params = { name: branch, ...(remoteRef ? { remoteRef } : {}), startOid: sourceOid };
			const token = branchToken("git.branch-create", repositoryId, params, { head: facts.head, newRef, startOid: sourceOid, ...(remoteRef ? { remoteRef } : {}) });
			return { action, name: branch, startOid: sourceOid, remoteRef: remoteRef ?? null, params, stateVersion: facts.digest, preconditionToken: token };
		}
		if (action === "rename") {
			const oldBranch = await validateBranchName(root, oldName);
			const newBranch = await validateBranchName(root, name ?? newName);
			const oldRef = `refs/heads/${oldBranch}`; const newRef = `refs/heads/${newBranch}`;
			const oldOid = await optional(root, ["rev-parse", "--verify", oldRef]);
			if (!oldOid) throw stableError("branch-not-found", "local branch does not exist");
			const currentRename = await assertRenameAvailable(root, oldBranch);
			if (await optional(root, ["rev-parse", "--verify", newRef]) !== null) throw stableError("branch-exists", "local branch already exists");
			const params = { oldName: oldBranch, name: newBranch, oldOid };
			const config = await configEntries(root, oldBranch);
			const token = branchToken("git.branch-rename", repositoryId, params, { head: facts.head, oldRef, newRef, oldOid, config, current: currentRename });
			return { action, oldName: oldBranch, name: newBranch, oldOid, params, stateVersion: facts.digest, preconditionToken: token };
		}
		if (action === "switch") {
			const requested = targetRef ?? targetBranch ?? "";
			const isRemote = typeof requested === "string" && requested.startsWith("refs/remotes/");
			if (isRemote && !/^refs\/remotes\/(?!\.)(?!.*(?:\.\.|\/\/|@\{))[^\0\r\n]+$/.test(requested)) throw invalid("targetRef must be a remote-tracking ref");
			let remoteInfo;
			if (isRemote) remoteInfo = await validateRemoteRef(root, requested);
			if (isRemote && (typeof localName !== "string" || localName === "")) throw invalid("localName is required for remote branch switch");
			const inferredLocal = isRemote ? localName : String(requested).replace(/^refs\/heads\//, "");
			const target = await validateBranchName(root, inferredLocal);
			const resolvedRef = isRemote ? requested : `refs/heads/${target}`;
			const targetOid = remoteInfo?.oid ?? await optional(root, ["for-each-ref", `--format=%(refname)%09%(objectname)`, resolvedRef]).then((v) => { const [r, o] = String(v ?? "").trim().split("\t"); return r === resolvedRef ? o : null; });
			if (!targetOid) throw stableError("target-changed", "target branch does not exist", { requiresRefresh: true });
			if (isRemote && await optional(root, ["rev-parse", "--verify", `refs/heads/${target}`]) !== null) throw stableError("branch-exists", "local tracking branch already exists; switch to it directly");
			if (facts.branch === target && !isRemote) return { action, safe: true, noop: true, targetBranch: target, targetOid, stateVersion: facts.digest, preconditionToken: null };
			const status = parseGitStatus(facts.statusText);
			const dirtyPaths = status.entries.flatMap((entry) => [entry.path, ...(entry.oldPath ? [entry.oldPath] : [])]);
			const switchFacts = dirtyPaths.length > 0 ? await stateFacts(root, dirtyPaths) : facts;
			const riskPaths = await switchRiskPaths(root, switchFacts, targetOid, status.entries, undefined);
			if (riskPaths.length > 0) return { action, safe: false, targetBranch: target, targetRef: resolvedRef, targetOid, stateVersion: facts.digest, allowedActions: ["commit", "computer", "cancel"], impact: { dirtyEntries: status.entries.length, riskPaths } };
			const params = { targetBranch: target, targetRef: resolvedRef, targetOid, ...(isRemote ? { remoteRef: requested, localName: target } : {}) };
			const expectedStatus = parseGitStatus(switchFacts.statusText);
			const token = branchToken("git.branch-switch", repositoryId, params, { head: switchFacts.head, branch: switchFacts.branch, digest: switchFacts.digest, indexTree: switchFacts.indexTree, status: { entries: expectedStatus.entries, counts: expectedStatus.counts }, files: switchFacts.files, targetRef: resolvedRef, targetOid, targetBranch: target });
			return { action, safe: true, targetBranch: target, targetRef: resolvedRef, targetOid, ...(status.entries.length > 0 ? { impact: { dirtyEntries: status.entries.length, riskPaths: [] } } : {}), params, stateVersion: facts.digest, preconditionToken: token };
		}
		throw invalid("unknown branch action");
	};
	const refValue = async (root, ref) => await optional(root, ["rev-parse", "--verify", ref]);
	const trackingConfig = async (root, name) => ({
		remote: await optional(root, ["config", "--get", `branch.${name}.remote`]),
		merge: await optional(root, ["config", "--get", `branch.${name}.merge`]),
	});
	const configEntries = async (root, name) => {
		const text = await optional(root, ["config", "--null", "--get-regexp", `^branch\\.${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\.`]);
		const entries = [];
		for (const record of String(text ?? "").split("\0").filter(Boolean)) {
			const split = record.indexOf("\n");
			if (split > 0) entries.push([record.slice(0, split), record.slice(split + 1)]);
		}
		return entries;
	};
	const renameBranchConfig = async (root, oldName, newName, signal) => {
		await command(root, ["config", "--rename-section", `branch.${oldName}`, `branch.${newName}`], signal);
	};
	const strictConfigEntries = async (root, name) => {
		const prefix = `branch.${name}.`;
		const text = await command(root, ["config", "--null", "--list"]);
		return String(text ?? "").split("\0").filter(Boolean).flatMap((record) => {
			const split = record.indexOf("\n");
			return split > 0 && record.slice(0, split).startsWith(prefix) ? [[record.slice(0, split), record.slice(split + 1)]] : [];
		});
	};
	const branchCreateInternal = async (operation, signal, update) => {
		const root = await repositoryRoot(operation.repositoryId); update({ phase: "branch-create", phaseIndex: 1, phaseCount: 2 });
		const ref = `refs/heads/${operation.params.name}`;
		const desiredConfig = operation.params.remoteRef ? { remote: operation.params.remoteRef.split("/")[2], merge: `refs/heads/${operation.params.remoteRef.slice("refs/remotes/".length).split("/").slice(1).join("/")}` } : null;
		let sideEffectStarted = false;
		const outcome = async (originalError) => {
			const actual = await refValue(root, ref); const cfg = await trackingConfig(root, operation.params.name);
			const head = await optional(root, ["rev-parse", "--verify", "HEAD"]);
			const expectedHead = branchRecord(operation.preconditionToken)?.expected?.head;
			const remoteOid = desiredConfig ? (await optional(root, ["for-each-ref", `--format=%(refname)%09%(objectname)`, operation.params.remoteRef]))?.split("\t")[1] : null;
			const complete = actual === operation.params.startOid && head === expectedHead && (!desiredConfig || (remoteOid === operation.params.startOid && cfg.remote === desiredConfig.remote && cfg.merge === desiredConfig.merge));
			const unchanged = actual === null && head === expectedHead && (!desiredConfig || (cfg.remote === null && cfg.merge === null));
			if (complete) return { status: "succeeded", result: { branch: operation.params.name, oid: actual, switched: false } };
			if (unchanged && originalError) throw originalError;
			if (unchanged) throw stableError("cancelled", "Git operation was cancelled");
			throw stableError("unknown-result", "branch creation result is uncertain", { requiresRefresh: true });
		};
		try {
			if (operation.params.remoteRef) {
				const remote = await validateRemoteRef(root, operation.params.remoteRef, signal);
				if (remote.oid !== operation.params.startOid) throw stableError("target-changed", "remote branch changed before creation", { requiresRefresh: true });
			}
			sideEffectStarted = true;
			await command(root, ["update-ref", ref, operation.params.startOid, ""], signal);
			if (desiredConfig) { await command(root, ["config", `branch.${operation.params.name}.remote`, desiredConfig.remote], signal); await command(root, ["config", `branch.${operation.params.name}.merge`, desiredConfig.merge], signal); }
			const result = await outcome(); update({ phase: "branch-create", phaseIndex: 2, phaseCount: 2 }); onChanged?.(operation.repositoryId, "branches"); return result;
		} catch (error) {
			if (sideEffectStarted) return outcome(error);
			throw error;
		}
	};
	const branchRenameInternal = async (operation, signal, update) => {
		const root = await repositoryRoot(operation.repositoryId); update({ phase: "branch-rename", phaseIndex: 1, phaseCount: 2 });
		const oldRef = `refs/heads/${operation.params.oldName}`; const newRef = `refs/heads/${operation.params.name}`;
		const wasCurrent = await assertRenameAvailable(root, operation.params.oldName, signal);
		const expectedConfig = branchRecord(operation.preconditionToken)?.expected?.config ?? [];
		const observedConfig = await configEntries(root, operation.params.oldName, signal);
		if (digest(observedConfig) !== digest(expectedConfig)) throw stableError("state-changed", "branch configuration changed before rename", { requiresRefresh: true });
		let configMutationStarted = false;
		let refMutationStarted = false;
		const migratedConfig = expectedConfig.map(([key, value]) => [key.replace(`branch.${operation.params.oldName}.`, `branch.${operation.params.name}.`), value]);
		const readState = async () => ({
			newOid: await refValue(root, newRef),
			oldOid: await refValue(root, oldRef),
			head: await optional(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
			oldConfig: await strictConfigEntries(root, operation.params.oldName),
			newConfig: await strictConfigEntries(root, operation.params.name),
		});
		const isPreState = (state) => state.oldOid === operation.params.oldOid && state.newOid === null && (!wasCurrent || state.head === operation.params.oldName) && digest(state.oldConfig) === digest(expectedConfig) && state.newConfig.length === 0;
		const isPostState = (state) => state.newOid === operation.params.oldOid && state.oldOid === null && (!wasCurrent || state.head === operation.params.name) && digest(state.newConfig) === digest(migratedConfig) && state.oldConfig.length === 0;
		const isConfigMigratedWithUnchangedRefs = (state) => state.oldOid === operation.params.oldOid && state.newOid === null && (!wasCurrent || state.head === operation.params.oldName) && digest(state.oldConfig) === digest([]) && digest(state.newConfig) === digest(migratedConfig);
		const rollbackConfig = async () => {
			try {
				await renameBranchConfig(root, operation.params.name, operation.params.oldName);
				return isPreState(await readState());
			} catch { return false; }
		};
		const outcome = async (originalError) => {
			let state;
			try { state = await readState(); } catch { throw stableError("unknown-result", "branch rename result is uncertain", { requiresRefresh: true }); }
			if (isPostState(state)) return { status: "succeeded", result: { oldName: operation.params.oldName, name: operation.params.name, oid: state.newOid } };
			if (isPreState(state) && originalError) throw originalError;
			if (isConfigMigratedWithUnchangedRefs(state)) {
				if (await rollbackConfig()) throw originalError ?? stableError("cancelled", "Git operation was cancelled");
				throw stableError("unknown-result", "branch rename rollback is uncertain", { requiresRefresh: true });
			}
			throw stableError("unknown-result", "branch rename result is uncertain", { requiresRefresh: true });
		};
		try {
			if (expectedConfig.length > 0) { configMutationStarted = true; await renameBranchConfig(root, operation.params.oldName, operation.params.name, signal); }
			const input = `start\ncreate ${newRef} ${operation.params.oldOid}\ndelete ${oldRef} ${operation.params.oldOid}\nprepare\ncommit\n`;
			refMutationStarted = true;
			await command(root, ["update-ref", "--stdin"], signal, { input });
			if (wasCurrent) await command(root, ["symbolic-ref", "HEAD", newRef], signal);
			const result = await outcome(); update({ phase: "branch-rename", phaseIndex: 2, phaseCount: 2 }); onChanged?.(operation.repositoryId, "branches,head"); return result;
		} catch (error) {
			if (refMutationStarted || configMutationStarted) return outcome(error);
			throw error;
		}
	};
	const verifySwitchOutcome = async (operation, expected, root, originalError) => {
		try {
			const facts = await stateFacts(root, Object.keys(expected?.files ?? {}), undefined);
			const status = parseGitStatus(facts.statusText);
			const indexStatus = digest({ entries: status.entries, counts: status.counts });
			const expectedStatus = digest(expected?.status);
			const files = digest(facts.files) === digest(expected?.files);
			const target = facts.head === operation.params.targetOid && facts.branch === operation.params.targetBranch;
			const preState = expected && facts.head === expected.head && facts.branch === expected.branch && facts.indexTree === expected.indexTree && indexStatus === expectedStatus && files;
			// 切换到不同树的分支后 write-tree 必然改变，不能用切换前 indexTree 比对成功态；
			// 干净/安全切换的不变式是工作区与索引的状态条目集合（indexStatus/files）保持不变。
			if (target && (!expected || (indexStatus === expectedStatus && files))) return { status: "succeeded", result: { branch: facts.branch, oid: facts.head } };
			if (preState && originalError) throw originalError;
		} catch (error) {
			if (error === originalError || error?.code === "cancelled" || error?.code === "git-command-failed") throw error;
		}
		throw stableError("unknown-result", "branch switch result is uncertain", { requiresRefresh: true });
	};
	const branchSwitchInternal = async (operation, signal, update) => {
		const root = await repositoryRoot(operation.repositoryId); update({ phase: "branch-switch", phaseIndex: 1, phaseCount: 2 });
		let changed = false;
		const { targetBranch, remoteRef } = operation.params;
		const expected = branchRecord(operation.preconditionToken)?.expected;
		try {
			await command(root, withoutHooks(remoteRef ? ["switch", "--track", "-c", targetBranch, remoteRef] : ["switch", "--no-guess", targetBranch]), signal); changed = true;
			const result = await verifySwitchOutcome(operation, expected, root);
			update({ phase: "branch-switch", phaseIndex: 2, phaseCount: 2 });
			onChanged?.(operation.repositoryId, "branches,head,index");
			return result;
		} catch (error) {
			if (changed || signal?.aborted) return verifySwitchOutcome(operation, expected, root, error);
			throw error;
		}
	};
	const submitBranch = async ({ repositoryId, requestId, actor, action, params, preconditionToken } = {}) => {
		const verified = verifyBranchToken(preconditionToken);
		const expected = branchRecord(preconditionToken);
		if (!verified || !expected || expected.repositoryId !== repositoryId || expected.type !== `git.branch-${action}` || digest(verified.params) !== digest(params)) throw stableError("state-changed", "branch precondition does not match", { requiresRefresh: true });
		const branchKind = expected.type === "git.branch-switch" ? "branch-switch" : expected.type === "git.branch-create" ? "branch-create" : "branch-rename";
		const coordinationParams = { ...params };
		if (branchKind === "branch-rename") coordinationParams.current = expected.expected.current;
		const coordinationDomains = await domainsFor(repositoryId, branchKind, coordinationParams);
		return operations.submit({ repositoryId, requestId, actor, kind: expected.type, params, preconditionToken, coordinationDomains });
	};
	const stageInternal = async (operation, signal, update) => {
		const root = await repositoryRoot(operation.repositoryId);
		let changeSet;
		if (operation.params.plan) {
			const plan = operation.params.plan;
			if (!plan || typeof plan !== "object" || !plan.facts || !Array.isArray(plan.records)) throw invalid("invalid durable stage plan");
			const internal = new Map();
			for (const item of plan.records) {
				if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || !item[1] || typeof item[1] !== "object") throw invalid("invalid durable stage plan");
				internal.set(item[0], item[1]);
			}
			changeSet = { facts: plan.facts, internal };
		} else {
			changeSet = getChangeSet(operation.params.changeSetId, operation.repositoryId);
		}
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
		await domainsFor(repositoryId, "commit");
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
		const token = writeToken("git.commit", repositoryId, { message: cleanMessage }, { head, tree, branch, name, email });
		return { repositoryId, head, headOid: head, stagedTree: tree, stagedTreeOid: tree, branch: branch.replace(/^refs\/heads\//, ""), identity: { name, email }, mobileCommitPolicy: "no-hooks", preconditionToken: token };
	};
	const commitInternal = async (operation, signal, update) => {
		const root = await repositoryRoot(operation.repositoryId);
		const token = writeRecord(operation.preconditionToken) ?? preconditions.get(operation.preconditionToken);
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
		const kind = unstage ? "git.unstage" : "git.stage";
		const facts = { digest: changeSet.facts.digest, indexTree: changeSet.facts.indexTree, files: changeSet.facts.files };
		const plan = { facts, records: normalized.map((selection) => {
			const record = changeSet.internal.get(selection.fileId);
			return [selection.fileId, { file: record.file, parsed: record.parsed, entry: record.entry }];
		}) };
		const params = { changeSetId, selections: normalized, plan };
		const token = writeToken(kind, repositoryId, params, { planDigest: digest(plan) }, changeSet.expiresAt);
		return operations.submit({ repositoryId, requestId, actor, kind, params, preconditionToken: token, coordinationDomains: await domainsFor(repositoryId, unstage ? "unstage" : "stage") });
	};
	const submitCommit = async ({ repositoryId, requestId, actor, message, preconditionToken, confirm } = {}) => {
		if (confirm !== true) throw stableError("confirmation-required", "commit requires an explicit confirmation");
		const cleanMessage = ensureMessage(message);
		return operations.submit({ repositoryId, requestId, actor, kind: "git.commit", params: { message: cleanMessage }, preconditionToken, coordinationDomains: await domainsFor(repositoryId, "commit") });
	};
	const capabilities = () => ({
		available: Boolean(typeof git?.writeDomains === "function" && git?.capabilities?.().available && operations?.isAvailable?.()),
		writes: Boolean(typeof git?.writeDomains === "function" && git?.capabilities?.().available && operations?.isAvailable?.()),
		mobileCommitPolicy: "no-hooks",
		externalConcurrencyProtection: "detect-only",
		features: { changes: true, stageFile: true, stageHunk: true, unstageFile: true, unstageHunk: true, commit: true, commitHooks: false, branchCreate: true, branchSwitch: true, branchRename: true, protectedSwitch: true },
		reason: typeof git?.writeDomains !== "function" ? "provider-incompatible" : !git?.capabilities?.().available ? "git-provider-unavailable" : !operations?.isAvailable?.() ? "operation-provider-unavailable" : null,
	});
	operations?.registerExecutor?.("git.stage", ({ operation, signal, update }) => stageInternal(operation, signal, update));
	operations?.registerExecutor?.("git.unstage", ({ operation, signal, update }) => stageInternal(operation, signal, update));
	operations?.registerExecutor?.("git.commit", ({ operation, signal, update }) => commitInternal(operation, signal, update));
	operations?.registerExecutor?.("git.branch-create", ({ operation, signal, update }) => branchCreateInternal(operation, signal, update));
	operations?.registerExecutor?.("git.branch-rename", ({ operation, signal, update }) => branchRenameInternal(operation, signal, update));
	operations?.registerExecutor?.("git.branch-switch", ({ operation, signal, update }) => branchSwitchInternal(operation, signal, update));
	const removePreconditionChecker = typeof operations?.addPreconditionChecker === "function" ? operations.addPreconditionChecker(check) : undefined;
	if (!removePreconditionChecker) operations?.setPreconditionChecker?.(check);
	return { capabilities, createChangeSet: makeChangeSet, commitPreflight, submitStage, submitCommit, branchPreflight, submitBranch, check, stop() { removePreconditionChecker?.(); changeSets.clear(); preconditions.clear(); } };
}
