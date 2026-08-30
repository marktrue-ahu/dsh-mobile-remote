import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { GitOperationError, canonicalJson, digest } from "./git-operations.js";
import { parseGitStatus } from "./git-service.js";

const TOKEN_TTL = 10 * 60 * 1000;
const CHALLENGE_TTL = 2 * 60 * 1000;
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const REMOTE_STABLE_CODES = new Set(["cancelled", "state-changed", "target-changed", "repository-busy", "provider-unavailable", "provider-incompatible", "auth-failed", "network-error", "remote-rejected", "non-fast-forward", "remote-invalid-response", "provider-invalid-response", "unknown-result", "conflicted", "dirty-worktree", "detached-head", "branch-not-found", "remote-not-found", "target-not-found", "workspace-not-allowed", "not-git-repository", "invalid-argument", "no-intermediate-state", "unsupported-intermediate-state", "abort-incomplete"]);

function invalid(message) { return new GitOperationError("invalid-argument", message); }
function stableError(code, message = code, options = {}) { return new GitOperationError(code, message, options); }
function trim(value) { return String(value ?? "").trim(); }
function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
function isOid(value) { return typeof value === "string" && OID.test(value); }
function safeRemoteUrl(value) {
	if (value === null || value === undefined || value === "[local-remote]") return value ?? null;
	if (typeof value !== "string" || value.length > 2048) return null;
	if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(value)) return "[local-remote]";
	try {
		const url = new URL(value);
		if (url.protocol === "file:") return "file://";
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		return url.toString().replace(/\/$/, "");
	} catch {
		const scp = /^(?:[^@/\s]+@)?([^:/\s]+):([^\s]+)$/.exec(value);
		return scp ? `${scp[1]}:${scp[2].replace(/[?#].*$/, "")}` : null;
	}
}
function safeBranch(value) {
	return typeof value === "string" && value !== "" && !value.startsWith("-") && !value.startsWith("refs/") && !value.endsWith("/") && !value.endsWith(".") && !value.includes("//") && !/(^|\/)\./.test(value) && !/[\x00-\x20~^:?*[\\\]]/.test(value) && !value.includes("..") && !value.includes("@{");
}
function stageView(id, kind, phaseIndex) { return { id, kind, status: "pending", phaseIndex, preFacts: null, postFacts: null, sideEffects: [], skipReason: null }; }

export function createGitRemoteService({ git, operations, now = () => Date.now(), onChanged, preconditionSecret, providerSecret } = {}) {
	const injectedSecret = preconditionSecret ?? providerSecret;
	const secret = Buffer.isBuffer(injectedSecret) ? injectedSecret : Buffer.from(typeof injectedSecret === "string" ? injectedSecret : randomUUID());
	const records = new Map();
	const challenges = new Map();
	const notifyChanged = (repositoryId, changeKinds) => { try { onChanged?.(repositoryId, changeKinds); } catch {} };

	const repositoryRoot = async (repositoryId) => {
		if (typeof repositoryId !== "string" || repositoryId === "") throw invalid("repositoryId is required");
		const resolver = git?.repositoryRootForWrite ?? git?.repositoryRoot;
		if (typeof resolver !== "function") throw stableError("provider-unavailable", "Git repository provider unavailable");
		return resolver(repositoryId);
	};
	const run = async (root, args, signal, options = {}) => {
		if (typeof git?.runCommand !== "function") throw stableError("provider-unavailable", "Git command provider unavailable");
		return git.runCommand(["-C", root, ...args], root, signal, {
			input: options.input,
			env: {
				GIT_TERMINAL_PROMPT: "0",
				GIT_SSH_COMMAND: "ssh -oBatchMode=yes",
				...options.env,
			},
		});
	};
	const command = async (root, args, signal, options = {}) => {
		try { return await run(root, args, signal, options); }
		catch (error) {
			if (signal?.aborted) throw stableError("cancelled", "Git operation was cancelled");
			if (error instanceof GitOperationError) throw error;
			if (/unable to create|cannot lock|another git process|\.lock/i.test(String(error?.message ?? ""))) throw stableError("repository-busy", "Git repository is locked");
			throw error;
		}
	};
	const remoteError = (error) => {
		if (error instanceof GitOperationError && REMOTE_STABLE_CODES.has(error.code)) return error;
		const text = String(error?.message ?? "");
		if (/non-fast-forward|fetch first|would be overwritten|stale info/i.test(text)) return stableError("non-fast-forward", "remote rejected the update", { retryable: false, requiresRefresh: true });
		if (/authentication|could not read Username|publickey|credential|access denied|permission denied/i.test(text)) return stableError("auth-failed", "remote authentication failed", { retryable: false });
		if (/hook declined|remote rejected|pre-receive|prohibited by|denied/i.test(text)) return stableError("remote-rejected", "remote rejected the operation", { requiresRefresh: true });
		if (/could not resolve|connection|network|timed out|timeout|unable to access|socket|dns/i.test(text)) return stableError("network-error", "remote connection failed", { retryable: true });
		if (error?.code === "git-provider-unavailable") return stableError("provider-unavailable", "Git repository provider unavailable");
		return stableError("remote-error", "remote operation failed", { requiresRefresh: true });
	};
	const remoteCommand = async (root, args, signal, options = {}) => {
		try { return await command(root, args, signal, options); }
		catch (error) { throw remoteError(error); }
	};
	const optional = async (root, args, signal, options = {}) => {
		try { return trim(await command(root, args, signal, options)); }
		catch (error) { if (signal?.aborted || ["provider-unavailable", "git-provider-unavailable"].includes(error?.code)) throw error; return null; }
	};
	const remoteNames = async (root, signal) => (await command(root, ["remote"], signal)).split(/\r?\n/).map(trim).filter(Boolean).filter((value) => REMOTE_NAME.test(value));
	const requireRemote = async (root, remote, signal) => {
		if (typeof remote !== "string" || !REMOTE_NAME.test(remote)) throw invalid("remote must be a configured remote name");
		if (!(await remoteNames(root, signal)).includes(remote)) throw stableError("remote-not-found", "remote is not configured");
		return remote;
	};
	const validateBranch = async (root, branch, signal) => {
		if (!safeBranch(branch)) throw invalid("branch must be a local branch name");
		try { await command(root, ["check-ref-format", `refs/heads/${branch}`], signal); }
		catch { throw invalid("branch must be a valid branch name"); }
		return branch;
	};
	const localRef = (branch) => `refs/heads/${branch}`;
	const remoteRef = (branch) => `refs/heads/${branch}`;
	const trackingRef = (remote, branch) => `refs/remotes/${remote}/${branch}`;
	const currentBranch = async (root, signal) => await optional(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal);
	const localOid = async (root, branch, signal) => await optional(root, ["rev-parse", "--verify", localRef(branch)], signal);
	const trackingOid = async (root, remote, branch, signal) => await optional(root, ["rev-parse", "--verify", trackingRef(remote, branch)], signal);
	const configVersion = async (root, remote, signal) => {
		const escaped = remote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const value = await optional(root, ["config", "--null", "--get-regexp", `^remote\\.${escaped}\\.`], signal);
		return digest(value ?? "");
	};
	const remoteTargetOid = async (root, remote, branch, signal) => {
		const output = trim(await remoteCommand(root, ["ls-remote", "--heads", remote, remoteRef(branch)], signal));
		if (!output) return null;
		const [oid, ref] = output.split(/\r?\n/)[0].split(/\s+/);
		if (ref !== remoteRef(branch) || !isOid(oid)) throw stableError("remote-invalid-response", "remote returned an invalid branch reference", { requiresRefresh: true });
		return oid;
	};
	const inProgress = async (root, signal) => {
		for (const kind of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
			const path = await optional(root, ["rev-parse", "--git-path", kind], signal);
			if (path && existsSync(resolve(root, path))) return { kind: kind === "MERGE_HEAD" ? "merge" : "other" };
		}
		for (const kind of ["rebase-merge", "rebase-apply"]) {
			const path = await optional(root, ["rev-parse", "--git-path", kind], signal);
			if (path && existsSync(resolve(root, path))) return { kind: "rebase" };
		}
		const unmerged = await optional(root, ["ls-files", "--unmerged", "-z"], signal);
		if (unmerged) return { kind: "merge", unmerged: true };
		return null;
	};
	const conflictPaths = async (root, signal) => {
		const output = await optional(root, ["ls-files", "--unmerged", "-z"], signal);
		const paths = [];
		for (const record of String(output ?? "").split("\0")) {
			const tab = record.lastIndexOf("\t");
			const path = tab >= 0 ? record.slice(tab + 1) : "";
			if (path && !paths.includes(path)) paths.push(path);
		}
		return paths.slice(0, 100);
	};
	const localFacts = async (root, signal) => {
		const statusText = await command(root, ["status", "--porcelain=v1", "-z", "-b"], signal);
		const status = parseGitStatus(statusText);
		const head = await currentHead(root, signal);
		const branch = await currentBranch(root, signal);
		const indexTree = await optional(root, ["write-tree"], signal);
		const dirty = { entries: status.entries, counts: status.counts };
		return { head, branch, indexTree, clean: status.entries.length === 0, dirtyDigest: digest(dirty), status, stateVersion: digest({ head, branch, indexTree, dirty }) };
	};
	const currentHead = async (root, signal) => await optional(root, ["rev-parse", "--verify", "HEAD"], signal);
	const remoteFacts = async (root, params, signal, includeTarget = true) => {
		await requireRemote(root, params.remote, signal);
		const config = await configVersion(root, params.remote, signal);
		const tracking = await trackingOid(root, params.remote, params.branch, signal);
		const target = includeTarget ? await remoteTargetOid(root, params.remote, params.branch, signal) : null;
		return { remote: params.remote, branch: params.branch, remoteConfigVersion: config, remoteTrackingOid: tracking, targetOid: target, remoteRef: remoteRef(params.branch), trackingRef: trackingRef(params.remote, params.branch) };
	};
	const resolveTarget = async (root, input = {}, signal) => {
		let remote = input.remote;
		let branch = input.branch ?? input.targetBranch;
		let localBranch = input.localBranch ?? input.sourceBranch;
		if (remote !== undefined || branch !== undefined) {
			if (remote === undefined || branch === undefined) throw stableError("target-required", "remote and branch must be selected together");
		} else {
			localBranch ??= await currentBranch(root, signal);
			if (!localBranch) throw stableError("upstream-required", "detached HEAD has no implicit synchronization target");
			const upstream = await optional(root, ["config", "--get", `branch.${localBranch}.remote`], signal);
			const merge = await optional(root, ["config", "--get", `branch.${localBranch}.merge`], signal);
			if (!upstream || !merge?.startsWith("refs/heads/")) throw stableError("upstream-required", "select a remote and target branch");
			remote = upstream;
			branch = merge.slice("refs/heads/".length);
		}
		await requireRemote(root, remote, signal);
		await validateBranch(root, branch, signal);
		if (localBranch !== undefined) await validateBranch(root, localBranch, signal);
		return { remote, branch, ...(localBranch ? { localBranch } : {}) };
	};
	const ensureCleanBranch = async (root, facts, expectedBranch) => {
		if (!facts.branch) throw stableError("detached-head", "pull requires a checked out local branch", { requiresRefresh: true });
		if (expectedBranch && facts.branch !== expectedBranch) throw stableError("state-changed", "current local branch changed", { requiresRefresh: true });
		const state = await inProgress(root);
		if (state) throw stableError("conflicted", "repository is in a Git intermediate state", { requiresRefresh: true, nextActions: ["computer", "model", ...(state.kind === "merge" || state.kind === "rebase" ? ["abort"] : [])] });
		if (!facts.clean) throw stableError("dirty-worktree", "pull requires a clean worktree", { requiresRefresh: true });
	};
	const sameLocal = (facts, expected) => Boolean(expected && facts.head === expected.head && facts.branch === expected.branch && facts.indexTree === expected.indexTree && facts.dirtyDigest === expected.dirtyDigest);
	const signed = (prefix, type, repositoryId, params, expected, ttl = TOKEN_TTL) => {
		const payload = canonicalJson({ version: 1, type, repositoryId, params, expected, expiresAt: now() + ttl });
		const body = Buffer.from(payload, "utf8").toString("base64url");
		const mac = createHmac("sha256", secret).update(payload).digest("base64url");
		const token = `${prefix}${body}.${mac}`;
		records.set(token, { type, repositoryId, paramsDigest: digest(params), expected, expiresAt: JSON.parse(payload).expiresAt });
		return token;
	};
	const verifySigned = (token, prefix = "remote_") => {
		if (typeof token !== "string" || !token.startsWith(prefix)) return null;
		try {
			const value = token.slice(prefix.length);
			const separator = value.indexOf(".");
			if (separator < 1 || value.indexOf(".", separator + 1) >= 0) return null;
			const payload = Buffer.from(value.slice(0, separator), "base64url");
			const supplied = Buffer.from(value.slice(separator + 1), "base64url");
			const expectedMac = createHmac("sha256", secret).update(payload).digest();
			if (supplied.length !== expectedMac.length || !timingSafeEqual(supplied, expectedMac)) return null;
			const record = JSON.parse(payload.toString("utf8"));
			if (!record || record.version !== 1 || typeof record.type !== "string" || typeof record.repositoryId !== "string" || !record.params || !record.expected || !Number.isFinite(record.expiresAt) || record.expiresAt <= now()) return null;
			return record;
		} catch { return null; }
	};
	const tokenRecord = (token) => {
		const parsed = verifySigned(token);
		if (!parsed) return null;
		const cached = records.get(token);
		return cached && cached.repositoryId === parsed.repositoryId && cached.type === parsed.type ? cached : { ...parsed, paramsDigest: digest(parsed.params) };
	};
	const createPreflightToken = (type, repositoryId, params, expected) => signed("remote_", type, repositoryId, params, expected);
	const verifyOperationToken = (operation, record) => {
		const params = operation.params ?? {};
		if (!record || record.repositoryId !== operation.repositoryId || record.type !== operation.kind || record.paramsDigest !== digest(params ?? {})) throw stableError("state-changed", "remote operation precondition does not match", { requiresRefresh: true });
	};

	const check = async (operation) => {
		if (!["git.fetch", "git.pull", "git.push", "git.sync", "git.abort"].includes(operation?.kind)) return;
		try {
			const record = tokenRecord(operation.preconditionToken);
			verifyOperationToken(operation, record);
			const root = await repositoryRoot(operation.repositoryId);
			const params = operation.params;
			if (operation.kind === "git.abort") {
				const state = await inProgress(root);
				const facts = await localFacts(root);
				const domains = await operationDomains(operation.repositoryId, operation.kind, params);
				if (!state || state.kind !== record.expected.kind || (record.expected.intermediateDigest && digest(state) !== record.expected.intermediateDigest) || (record.expected.stateVersion && facts.stateVersion !== record.expected.stateVersion) || (record.expected.coordinationDigest && digest(domains) !== record.expected.coordinationDigest)) throw stableError("state-changed", "Git intermediate state changed", { requiresRefresh: true });
				return;
			}
			const remote = await remoteFacts(root, params, undefined, operation.kind !== "git.fetch");
			if (remote.remoteConfigVersion !== record.expected.remoteConfigVersion || remote.remoteTrackingOid !== record.expected.remoteTrackingOid) throw stableError("state-changed", "remote configuration or tracking ref changed", { requiresRefresh: true });
			if (operation.kind === "git.fetch") return;
			const facts = await localFacts(root);
			if (!sameLocal(facts, record.expected.local)) throw stableError("state-changed", "local repository facts changed", { requiresRefresh: true });
			if (operation.kind === "git.push" && remote.targetOid !== record.expected.destinationOid) throw stableError("target-changed", "remote destination changed", { requiresRefresh: true });
			if ((operation.kind === "git.pull" || operation.kind === "git.sync") && remote.targetOid !== record.expected.targetOid) throw stableError("target-changed", "remote target changed", { requiresRefresh: true });
		} catch (error) {
			if (error instanceof GitOperationError && REMOTE_STABLE_CODES.has(error.code)) throw error;
			throw remoteError(error);
		}
	};

	const normalizeStrategy = (strategy) => {
		if (strategy === undefined || strategy === null || strategy === "") return "merge";
		if (!["merge", "rebase"].includes(strategy)) throw stableError("invalid-strategy", "pull strategy must be merge or rebase");
		return strategy;
	};
	const makeRemotePreflight = async ({ repositoryId, kind, remote, branch, targetBranch, localBranch, sourceBranch: requestedSourceBranch, strategy, setUpstream, force, correlationId, ...unknown } = {}) => {
		if (Object.keys(unknown).length > 0) throw invalid("unsupported remote operation parameter");
		if (kind !== "git.push" && force !== undefined) throw invalid("force is only valid for push and is not supported");
		if (kind === "git.push" && force !== undefined && force !== false) throw invalid("force push is not supported");
		branch ??= targetBranch;
		localBranch ??= requestedSourceBranch;
		const root = await repositoryRoot(repositoryId);
		const target = await resolveTarget(root, { remote, branch, localBranch }, undefined);
		const facts = await localFacts(root);
		const remoteState = await remoteFacts(root, target, undefined, true);
		const missingSyncTarget = kind === "git.sync" && !remoteState.targetOid && !remoteState.remoteTrackingOid;
		if (!remoteState.targetOid && kind !== "git.push" && !missingSyncTarget) throw stableError("target-not-found", "remote branch does not exist");
		const cleanStrategy = normalizeStrategy(strategy);
		if (["git.pull", "git.sync"].includes(kind)) await ensureCleanBranch(root, facts, target.localBranch ?? facts.branch);
		const sourceBranch = target.localBranch ?? facts.branch;
		if (["git.push", "git.pull", "git.sync"].includes(kind) && !sourceBranch) throw stableError("detached-head", "operation requires a checked out local branch");
		if (sourceBranch) await validateBranch(root, sourceBranch);
		const sourceOid = sourceBranch ? await localOid(root, sourceBranch) : null;
		if (["git.push", "git.sync"].includes(kind) && !sourceOid) throw stableError("branch-not-found", "local source branch does not exist");
		const normalized = kind === "git.fetch"
			? { remote: target.remote, branch: target.branch }
			: kind === "git.pull"
				? { remote: target.remote, branch: target.branch, localBranch: sourceBranch, strategy: cleanStrategy }
				: kind === "git.push"
					? { remote: target.remote, branch: target.branch, localBranch: sourceBranch, setUpstream: setUpstream === true }
					: { remote: target.remote, branch: target.branch, localBranch: sourceBranch, strategy: cleanStrategy, setUpstream: setUpstream === true };
		if (!["git.push", "git.sync"].includes(kind) && setUpstream !== undefined) throw invalid("setUpstream is only supported for push or sync");
		if (["git.push", "git.sync"].includes(kind) && setUpstream !== undefined && typeof setUpstream !== "boolean") throw invalid("setUpstream must be boolean");
		const expected = {
			remoteConfigVersion: remoteState.remoteConfigVersion,
			remoteTrackingOid: remoteState.remoteTrackingOid,
			...(kind === "git.push" ? { destinationOid: remoteState.targetOid, sourceOid, local: facts } : {}),
			...(kind === "git.fetch" ? { targetOid: remoteState.targetOid } : {}),
			...(kind === "git.pull" || kind === "git.sync" ? { targetOid: remoteState.targetOid, local: facts } : {}),
		};
		const token = createPreflightToken(kind, repositoryId, normalized, expected);
		const impact = {
			remote: target.remote,
			branch: target.branch,
			remoteRef: remoteRef(target.branch),
			trackingRef: trackingRef(target.remote, target.branch),
			...(sourceBranch ? { localBranch: sourceBranch, sourceOid } : {}),
			...(kind === "git.pull" || kind === "git.sync" ? { strategy: cleanStrategy, clean: facts.clean } : {}),
			...(kind === "git.push" ? { destinationOid: remoteState.targetOid, setUpstream: normalized.setUpstream } : {}),
		};
		return { operationKind: kind, repositoryId, params: normalized, stateVersion: facts.stateVersion, preconditionToken: token, target: impact, impact, expected: { targetOid: remoteState.targetOid, destinationOid: remoteState.targetOid, localBranch: sourceBranch, sourceOid }, remote: { name: target.remote, branch: target.branch, remoteRef: remoteRef(target.branch), remoteTrackingOid: remoteState.remoteTrackingOid }, aheadBehind: await aheadBehind(root, kind === "git.push" ? sourceOid : facts.head, remoteState.targetOid) };
	};
	const aheadBehind = async (root, head, targetOid) => {
		if (!head || !targetOid) return { ahead: 0, behind: 0 };
		try {
			const output = trim(await command(root, ["rev-list", "--left-right", "--count", `${head}...${targetOid}`]));
			const [ahead, behind] = output.split(/\s+/).map(Number);
			return { ahead: Number.isFinite(ahead) ? ahead : 0, behind: Number.isFinite(behind) ? behind : 0 };
		} catch { return { ahead: 0, behind: 0 }; }
	};

	const terminalStageStatus = (value) => ["succeeded", "failed", "cancelled", "conflicted", "unknown-result", "skipped"].includes(value) ? value : "failed";
	const stageUpdate = (stages, id, patch, update) => {
		const index = stages.findIndex((stage) => stage.id === id);
		if (index < 0) return;
		stages[index] = { ...stages[index], ...clone(patch) };
		update({ stages: clone(stages) });
	};
	const markStageError = (stages, id, outcome, update) => {
		stageUpdate(stages, id, { status: terminalStageStatus(outcome.status), ...(outcome.error ? { errorCode: outcome.error.code } : {}), ...(outcome.result?.preFacts ? { preFacts: outcome.result.preFacts } : {}), ...(outcome.result?.postFacts ? { postFacts: outcome.result.postFacts } : {}), ...(outcome.result?.sideEffects ? { sideEffects: outcome.result.sideEffects } : {}), ...(outcome.result?.skipReason ? { skipReason: outcome.result.skipReason } : {}), ...(outcome.result?.fetchResultId ? { fetchResultId: outcome.result.fetchResultId } : {}), ...(outcome.result?.fetchedTargetOid ? { fetchedTargetOid: outcome.result.fetchedTargetOid } : {}), ...(outcome.result?.sourceOid ? { sourceOid: outcome.result.sourceOid } : {}), ...(outcome.result?.destinationOid ? { destinationOid: outcome.result.destinationOid } : {}) }, update);
	};
	const stopRemaining = (stages, afterId, reason, update) => {
		let after = false;
		for (const stage of stages) {
			if (stage.id === afterId) { after = true; continue; }
			if (after && stage.status === "pending") {
				stage.status = "skipped";
				stage.skipReason = reason;
			}
		}
		update({ stages: clone(stages) });
	};
	const readFetchPost = async (root, params) => {
		const facts = await remoteFacts(root, params, undefined, true);
		return { remoteConfigVersion: facts.remoteConfigVersion, remoteTrackingOid: facts.remoteTrackingOid, targetOid: facts.targetOid, remoteRef: facts.remoteRef, trackingRef: facts.trackingRef };
	};
	const fetchStage = async ({ operation, root, params, expected, stages, stageId = "fetch", update, signal }) => {
		let pre;
		try { pre = await readFetchPost(root, params); }
		catch (error) { const outcome = { status: error.code ?? "failed", error: remoteError(error), result: { preFacts: null, postFacts: null, sideEffects: [] } }; markStageError(stages, stageId, outcome, update); return outcome; }
		stageUpdate(stages, stageId, { status: "running", preFacts: pre }, update);
		if (expected.remoteConfigVersion !== pre.remoteConfigVersion || expected.remoteTrackingOid !== pre.remoteTrackingOid) {
			const error = stableError("state-changed", "remote configuration or tracking ref changed", { requiresRefresh: true });
			const outcome = { status: "failed", error, result: { preFacts: pre, postFacts: pre, sideEffects: [] } };
			markStageError(stages, stageId, outcome, update); return outcome;
		}
		let mutationStarted = false;
		try {
			mutationStarted = true;
			await remoteCommand(root, ["fetch", "--no-tags", params.remote, `${remoteRef(params.branch)}:${trackingRef(params.remote, params.branch)}`], signal);
			const post = await readFetchPost(root, params);
			if (!post.remoteTrackingOid || post.remoteTrackingOid !== post.targetOid || (expected.targetOid && post.targetOid !== expected.targetOid)) throw stableError("unknown-result", "fetch result could not be verified", { requiresRefresh: true });
			const result = { status: "succeeded", result: { preFacts: pre, postFacts: post, sideEffects: post.remoteTrackingOid !== pre.remoteTrackingOid ? ["remote-tracking-ref-updated"] : [], fetchResultId: randomUUID(), remote: params.remote, branch: params.branch, fetchedTargetOid: post.remoteTrackingOid } };
			markStageError(stages, stageId, result, update);
			if (post.remoteTrackingOid !== pre.remoteTrackingOid) notifyChanged(operation?.repositoryId, "remote-tracking");
			return result;
		} catch (error) {
			let post;
			try { post = await readFetchPost(root, params); } catch { post = null; }
			let finalError = remoteError(error);
			let status = finalError.code === "cancelled" ? "cancelled" : "failed";
			if (post && post.remoteTrackingOid !== pre.remoteTrackingOid) {
				status = "unknown-result";
				finalError = stableError("unknown-result", "fetch changed the remote-tracking ref but its result is uncertain", { requiresRefresh: true });
			} else if (!post && mutationStarted && ["network-error", "remote-error", "cancelled"].includes(finalError.code)) {
				status = "unknown-result";
				finalError = stableError("unknown-result", "fetch result is uncertain", { requiresRefresh: true });
			} else if (finalError.code === "cancelled" && !mutationStarted) status = "cancelled";
			const changed = Boolean(post && post.remoteTrackingOid !== pre.remoteTrackingOid);
			const outcome = { status, error: finalError, result: { preFacts: pre, postFacts: post, sideEffects: changed ? ["remote-tracking-ref-may-have-changed"] : [] } };
			markStageError(stages, stageId, outcome, update);
			if (changed) notifyChanged(operation?.repositoryId, "remote-tracking");
			return outcome;
		}
	};

	const integrateStage = async ({ operation, root, params, targetOid, stages, stageId = "integrate", update, signal }) => {
		let pre;
		try { pre = await localFacts(root); await ensureCleanBranch(root, pre, params.localBranch); }
		catch (error) { const outcome = { status: error.code === "conflicted" ? "conflicted" : "failed", error, result: { preFacts: pre ?? null, postFacts: null, sideEffects: [] } }; markStageError(stages, stageId, outcome, update); return outcome; }
		stageUpdate(stages, stageId, { status: "running", preFacts: pre }, update);
		if (!isOid(targetOid) || !(await optional(root, ["rev-parse", "--verify", `${targetOid}^{commit}`], undefined))) {
			const error = stableError("target-changed", "fetched target commit is unavailable", { requiresRefresh: true });
			const outcome = { status: "failed", error, result: { preFacts: pre, postFacts: null, sideEffects: [] } };
			markStageError(stages, stageId, outcome, update); return outcome;
		}
		let mutationStarted = false;
		try {
			const contains = pre.head && await isAncestor(root, targetOid, pre.head);
			if (contains) {
				const result = { status: "skipped", result: { preFacts: pre, postFacts: pre, sideEffects: [], skipReason: "already-contains-fetched-target", targetOid } };
				markStageError(stages, stageId, result, update); return result;
			}
			mutationStarted = true;
			const args = params.strategy === "rebase" ? ["rebase", "--no-autostash", "--no-verify", targetOid] : ["merge", "--no-edit", "--no-verify", targetOid];
			await command(root, args, signal, { env: { GIT_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no" } });
			const post = await localFacts(root);
			const state = await inProgress(root);
			if (state || !post.clean || !post.head || !(await isAncestor(root, targetOid, post.head))) throw stableError("unknown-result", "integrated repository state could not be verified", { requiresRefresh: true });
			const result = { status: "succeeded", result: { preFacts: pre, postFacts: post, sideEffects: [params.strategy === "rebase" ? "local-history-rebased" : "local-history-merged"], targetOid, headOid: post.head } };
			markStageError(stages, stageId, result, update);
			notifyChanged(operation?.repositoryId, "head,index,worktree");
			return result;
		} catch (error) {
			let post;
			try { post = await localFacts(root); } catch { post = null; }
			const state = await inProgress(root).catch(() => null);
			let finalError = error instanceof GitOperationError ? error : remoteError(error);
			let status = finalError.code === "cancelled" ? "cancelled" : "failed";
			if (state) {
				status = "conflicted";
				const paths = await conflictPaths(root).catch(() => []);
				finalError = stableError("conflicted", `${params.strategy} stopped with conflicts`, { requiresRefresh: true, nextActions: ["abort", "computer", "model"], facts: { kind: state.kind, paths } });
			} else if (post && (!sameLocal(post, pre) || mutationStarted && post.head !== pre.head)) {
				status = "unknown-result";
				finalError = stableError("unknown-result", "local integration result is uncertain", { requiresRefresh: true });
			} else if (!post && mutationStarted) {
				status = "unknown-result";
				finalError = stableError("unknown-result", "local integration result is uncertain", { requiresRefresh: true });
			}
			const changed = Boolean(post && (post.head !== pre.head || post.indexTree !== pre.indexTree || post.dirtyDigest !== pre.dirtyDigest || state));
			const outcome = { status, error: finalError, result: { preFacts: pre, postFacts: post, sideEffects: changed ? ["local-state-may-have-changed"] : [] } };
			markStageError(stages, stageId, outcome, update);
			if (changed) notifyChanged(operation?.repositoryId, "head,index,worktree");
			return outcome;
		}
	};
	const isAncestor = async (root, ancestor, descendant) => {
		try { await command(root, ["merge-base", "--is-ancestor", ancestor, descendant]); return true; } catch { return false; }
	};

	const verifyPushConfig = async (root, params) => {
		const remote = await optional(root, ["config", "--get", `branch.${params.localBranch}.remote`]);
		const merge = await optional(root, ["config", "--get", `branch.${params.localBranch}.merge`]);
		return remote === params.remote && merge === remoteRef(params.branch);
	};
	const pushStage = async ({ repositoryId, root, params, expected, stages, stageId = "push", update, signal }) => {
		let preLocal;
		let remote;
		try { preLocal = await localFacts(root); remote = await remoteFacts(root, params, undefined, true); }
		catch (error) { const outcome = { status: "failed", error: remoteError(error), result: { preFacts: null, postFacts: null, sideEffects: [] } }; markStageError(stages, stageId, outcome, update); return outcome; }
		const preDestination = remote.targetOid;
		const sourceOid = await localOid(root, params.localBranch);
		const pre = { local: preLocal, destinationOid: preDestination, sourceOid, remoteConfigVersion: remote.remoteConfigVersion, remoteTrackingOid: remote.remoteTrackingOid };
		stageUpdate(stages, stageId, { status: "running", preFacts: pre }, update);
		if (!sameLocal(preLocal, expected.local) || preDestination !== expected.destinationOid || sourceOid !== expected.sourceOid || (expected.remoteConfigVersion !== undefined && remote.remoteConfigVersion !== expected.remoteConfigVersion) || (expected.remoteTrackingOid !== undefined && remote.remoteTrackingOid !== expected.remoteTrackingOid)) {
			const error = stableError("state-changed", "local source or remote destination changed", { requiresRefresh: true });
			const outcome = { status: "failed", error, result: { preFacts: pre, postFacts: pre, sideEffects: [] } };
			markStageError(stages, stageId, outcome, update); return outcome;
		}
		if (preDestination === sourceOid && !params.setUpstream) {
			const result = { status: "skipped", result: { preFacts: pre, postFacts: pre, sideEffects: [], skipReason: "remote-already-at-local-source", sourceOid, destinationOid: preDestination } };
			markStageError(stages, stageId, result, update); return result;
		}
		let mutationStarted = false;
		let configStarted = false;
		try {
			mutationStarted = true;
			await remoteCommand(root, ["push", "--no-verify", params.remote, `${localRef(params.localBranch)}:${remoteRef(params.branch)}`], signal);
			if (params.setUpstream) {
				configStarted = true;
				await command(root, ["config", `branch.${params.localBranch}.remote`, params.remote], signal);
				await command(root, ["config", `branch.${params.localBranch}.merge`, remoteRef(params.branch)], signal);
			}
			const postRemote = await remoteFacts(root, params, undefined, true);
			const trackingMatches = expected.remoteTrackingOid === undefined || postRemote.remoteTrackingOid === expected.remoteTrackingOid || postRemote.remoteTrackingOid === sourceOid;
			if (postRemote.targetOid !== sourceOid || (expected.remoteConfigVersion !== undefined && postRemote.remoteConfigVersion !== expected.remoteConfigVersion) || !trackingMatches || (params.setUpstream && !(await verifyPushConfig(root, params)))) throw stableError("unknown-result", "push result could not be verified", { requiresRefresh: true });
			const postLocal = await localFacts(root);
			const result = { status: "succeeded", result: { preFacts: pre, postFacts: { local: postLocal, destinationOid: postRemote.targetOid, sourceOid, remoteConfigVersion: postRemote.remoteConfigVersion, remoteTrackingOid: postRemote.remoteTrackingOid }, sideEffects: ["remote-branch-updated"], sourceOid, destinationOid: postRemote.targetOid, remote: params.remote, branch: params.branch, setUpstream: params.setUpstream } };
			markStageError(stages, stageId, result, update);
			notifyChanged(repositoryId, params.setUpstream ? "remote,config" : "remote");
			return result;
		} catch (error) {
			let postRemote = null;
			let postLocal = null;
			try { postRemote = await remoteFacts(root, params, undefined, true); } catch {}
			const destinationOid = postRemote?.targetOid ?? null;
			try { postLocal = await localFacts(root); } catch {}
			let finalError = remoteError(error);
			let status = finalError.code === "cancelled" ? "cancelled" : "failed";
			const remoteFactsChanged = Boolean(postRemote && ((expected.remoteConfigVersion !== undefined && postRemote.remoteConfigVersion !== expected.remoteConfigVersion) || (expected.remoteTrackingOid !== undefined && postRemote.remoteTrackingOid !== expected.remoteTrackingOid && postRemote.remoteTrackingOid !== sourceOid)));
			let configVerified = !params.setUpstream;
			if (params.setUpstream && destinationOid === sourceOid) { try { configVerified = await verifyPushConfig(root, params); } catch { configVerified = false; } }
			if (destinationOid === sourceOid && preDestination !== sourceOid) {
				status = "unknown-result";
				finalError = stableError("unknown-result", "remote destination changed but push result is uncertain", { requiresRefresh: true });
			} else if (remoteFactsChanged) {
				status = "unknown-result";
				finalError = stableError("unknown-result", "remote state changed while push result was pending", { requiresRefresh: true });
			} else if (!postRemote && mutationStarted && ["network-error", "remote-error", "cancelled"].includes(finalError.code)) {
				status = "unknown-result";
				finalError = stableError("unknown-result", "push result is uncertain", { requiresRefresh: true });
			} else if (destinationOid === sourceOid && configVerified) {
				status = "succeeded";
				finalError = undefined;
			} else if (destinationOid !== preDestination && destinationOid !== sourceOid) {
				status = "unknown-result";
				finalError = stableError("unknown-result", "remote destination changed but push result is uncertain", { requiresRefresh: true });
			} else if (configStarted || (mutationStarted && finalError.code === "cancelled" && destinationOid === sourceOid)) {
				status = "unknown-result";
				finalError = stableError("unknown-result", "push changed state but its final result is uncertain", { requiresRefresh: true });
			}
			const changed = destinationOid !== preDestination || configStarted || remoteFactsChanged || status === "unknown-result";
			const outcome = { status, ...(finalError ? { error: finalError } : {}), result: { preFacts: pre, postFacts: { local: postLocal, destinationOid, sourceOid, ...(postRemote ? { remoteConfigVersion: postRemote.remoteConfigVersion, remoteTrackingOid: postRemote.remoteTrackingOid } : {}) }, sideEffects: changed ? ["remote-state-may-have-changed"] : [] } };
			markStageError(stages, stageId, outcome, update);
			if (changed) notifyChanged(repositoryId, configStarted ? "remote,config" : "remote");
			return outcome;
		}
	};

	const runPullLike = async (operation, signal, update, sync = false) => {
		const root = await repositoryRoot(operation.repositoryId);
		const params = operation.params;
		const expected = tokenRecord(operation.preconditionToken)?.expected ?? {};
		const stages = clone(operation.stages ?? (sync ? [stageView("fetch", "fetch", 1), stageView("integrate", params.strategy, 2), stageView("push", "push", 3)] : [stageView("fetch", "fetch", 1), stageView("integrate", params.strategy, 2)]));
		let fetched;
		let targetOid = expected.targetOid;
		const missingRemoteTarget = sync && expected.targetOid === null && expected.remoteTrackingOid === null;
		if (missingRemoteTarget) {
			try {
				const facts = await readFetchPost(root, params);
				if (facts.targetOid !== null || facts.remoteTrackingOid !== null) throw stableError("state-changed", "remote target changed before sync", { requiresRefresh: true });
				stageUpdate(stages, "fetch", { status: "skipped", preFacts: facts, postFacts: facts, skipReason: "remote-target-missing" }, update);
			} catch (error) {
				const finalError = remoteError(error);
				const outcome = { status: finalError.code === "cancelled" ? "cancelled" : "failed", error: finalError, result: { preFacts: null, postFacts: null, sideEffects: [] } };
				markStageError(stages, "fetch", outcome, update);
				stopRemaining(stages, "fetch", "previous-stage-failed", update);
				return { status: outcome.status, result: { stages }, error: finalError };
			}
			try {
				const facts = await localFacts(root);
				stageUpdate(stages, "integrate", { status: "skipped", preFacts: facts, postFacts: facts, skipReason: "remote-target-missing" }, update);
			} catch (error) {
				const finalError = remoteError(error);
				const outcome = { status: finalError.code === "cancelled" ? "cancelled" : "failed", error: finalError, result: { preFacts: null, postFacts: null, sideEffects: [] } };
				markStageError(stages, "integrate", outcome, update);
				stopRemaining(stages, "integrate", "previous-stage-failed", update);
				return { status: outcome.status, result: { stages }, error: finalError };
			}
		} else {
			update({ phase: "fetch", phaseIndex: 1, phaseCount: stages.length, stages });
			fetched = await fetchStage({ operation, root, params, expected, stages, update, signal });
			if (fetched.status !== "succeeded") { if (sync) stopRemaining(stages, "fetch", "previous-stage-failed", update); return { status: fetched.status, result: { stages, ...(fetched.result ?? {}) }, ...(fetched.error ? { error: fetched.error } : {}) }; }
			targetOid = fetched.result.fetchedTargetOid;
			update({ phase: "integrate", phaseIndex: 2, phaseCount: stages.length, stages });
			const integrated = await integrateStage({ operation, root, params, targetOid, stages, update, signal });
			if (integrated.status !== "succeeded" && integrated.status !== "skipped") { if (sync) stopRemaining(stages, "integrate", "previous-stage-failed", update); return { status: integrated.status, result: { stages, fetchResultId: fetched.result.fetchResultId }, ...(integrated.error ? { error: integrated.error } : {}) }; }
			if (!sync) return { status: "succeeded", result: { stages, fetchResultId: fetched.result.fetchResultId, fetchedTargetOid: targetOid, headOid: integrated.result?.postFacts?.head ?? integrated.result?.preFacts?.head } };
		}
		let currentLocal;
		let destination;
		let sourceOid;
		try {
			currentLocal = await localFacts(root);
			destination = await remoteTargetOid(root, params.remote, params.branch);
			sourceOid = await localOid(root, params.localBranch);
		} catch (error) {
			const finalError = remoteError(error);
			const outcome = { status: finalError.code === "cancelled" ? "cancelled" : "failed", error: finalError, result: { preFacts: null, postFacts: null, sideEffects: [] } };
			markStageError(stages, "push", outcome, update);
			return { status: outcome.status, result: { stages, ...(fetched?.result?.fetchResultId ? { fetchResultId: fetched.result.fetchResultId } : {}) }, error: finalError };
		}
		if (!sourceOid) {
			const error = stableError("branch-not-found", "local source branch does not exist");
			const outcome = { status: "failed", error, result: { preFacts: { local: currentLocal, destinationOid: destination, sourceOid }, postFacts: null, sideEffects: [] } };
			markStageError(stages, "push", outcome, update);
			return { status: "failed", result: { stages, ...(fetched?.result?.fetchResultId ? { fetchResultId: fetched.result.fetchResultId } : {}) }, error };
		}
		if (destination !== targetOid) {
			const error = stableError("target-changed", "remote destination changed during sync", { requiresRefresh: true });
			const outcome = { status: "failed", error, result: { preFacts: { local: currentLocal, destinationOid: destination, sourceOid }, postFacts: null, sideEffects: [] } };
			markStageError(stages, "push", outcome, update);
			return { status: "failed", result: { stages, ...(fetched?.result?.fetchResultId ? { fetchResultId: fetched.result.fetchResultId } : {}) }, error };
		}
		if (destination === sourceOid && !params.setUpstream) {
			stageUpdate(stages, "push", { status: "skipped", skipReason: "remote-already-at-local-source", preFacts: { local: currentLocal, destinationOid: destination, sourceOid }, postFacts: { local: currentLocal, destinationOid: destination, sourceOid } }, update);
			return { status: "succeeded", result: { stages, ...(fetched?.result?.fetchResultId ? { fetchResultId: fetched.result.fetchResultId } : {}), ...(targetOid ? { fetchedTargetOid: targetOid } : {}), headOid: currentLocal.head } };
		}
		update({ phase: "push", phaseIndex: 3, phaseCount: stages.length, stages });
		const pushed = await pushStage({ repositoryId: operation.repositoryId, root, params, expected: { remoteConfigVersion: expected.remoteConfigVersion, remoteTrackingOid: targetOid, local: currentLocal, destinationOid: destination, sourceOid }, stages, update, signal });
		return { status: pushed.status, result: { stages, ...(fetched?.result?.fetchResultId ? { fetchResultId: fetched.result.fetchResultId } : {}), ...(targetOid ? { fetchedTargetOid: targetOid } : {}) }, ...(pushed.error ? { error: pushed.error } : {}) };
	};

	const fetchInternal = async (operation, signal, update) => {
		const root = await repositoryRoot(operation.repositoryId);
		const stages = [stageView("fetch", "fetch", 1)];
		update({ phase: "fetch", phaseIndex: 1, phaseCount: 1, stages });
		const expected = tokenRecord(operation.preconditionToken)?.expected ?? {};
		const outcome = await fetchStage({ operation, root, params: operation.params, expected, stages, update, signal });
		return { status: outcome.status, result: { stages, ...(outcome.result ?? {}) }, ...(outcome.error ? { error: outcome.error } : {}) };
	};
	const pullInternal = (operation, signal, update) => runPullLike(operation, signal, update, false);
	const syncInternal = (operation, signal, update) => runPullLike(operation, signal, update, true);
	const pushInternal = async (operation, signal, update) => {
		const root = await repositoryRoot(operation.repositoryId);
		const stages = [stageView("push", "push", 1)];
		update({ phase: "push", phaseIndex: 1, phaseCount: 1, stages });
		const expected = tokenRecord(operation.preconditionToken)?.expected ?? {};
		const outcome = await pushStage({ repositoryId: operation.repositoryId, root, params: operation.params, expected, stages, update, signal });
		return { status: outcome.status, result: { stages, ...(outcome.result ?? {}) }, ...(outcome.error ? { error: outcome.error } : {}) };
	};

	const abortState = async (root, signal) => {
		const state = await inProgress(root, signal);
		if (!state) throw stableError("no-intermediate-state", "repository has no merge or rebase to abort");
		const facts = await localFacts(root, signal);
		return { ...state, intermediateDigest: digest(state), head: facts.head, branch: facts.branch, stateVersion: facts.stateVersion };
	};
	const abortPreflight = async ({ repositoryId } = {}) => {
		const root = await repositoryRoot(repositoryId);
		const state = await abortState(root);
		if (!['merge', 'rebase'].includes(state.kind)) throw stableError("unsupported-intermediate-state", "only merge and rebase can be aborted from mobile", { requiresRefresh: true, nextActions: ["computer", "model"] });
		const params = { kind: state.kind };
		const coordinationDomains = await operationDomains(repositoryId, "git.abort", params);
		const expected = { kind: state.kind, intermediateDigest: state.intermediateDigest, stateVersion: state.stateVersion, coordinationDigest: digest(coordinationDomains) };
		const preconditionToken = createPreflightToken("git.abort", repositoryId, params, expected);
		return { operationKind: "git.abort", repositoryId, params, stateVersion: state.stateVersion, coordinationDomains, preconditionToken, impact: { kind: state.kind, paths: await conflictPaths(root) }, requiresConfirmation: true, summary: `${state.kind} operation will be aborted` };
	};
	const abortInternal = async (operation, signal, update) => {
		const root = await repositoryRoot(operation.repositoryId);
		const stages = [stageView("abort", "abort", 1)];
		update({ phase: "abort", phaseIndex: 1, phaseCount: 1, stages });
		let pre;
		try { pre = await abortState(root); } catch (error) { const outcome = { status: "failed", error, result: { stages } }; markStageError(stages, "abort", outcome, update); return outcome; }
		stageUpdate(stages, "abort", { status: "running", preFacts: pre }, update);
		let started = false;
		try {
			started = true;
			await command(root, [pre.kind === "rebase" ? "rebase" : "merge", "--abort"], signal);
			const post = await inProgress(root);
			const postFacts = await localFacts(root);
			if (post || postFacts.head !== pre.head || postFacts.branch !== pre.branch || !postFacts.clean) throw stableError("abort-incomplete", "abort did not restore a clean local state", { requiresRefresh: true });
			const outcome = { status: "succeeded", result: { stages, preFacts: pre, postFacts: { intermediate: null, local: postFacts }, sideEffects: ["intermediate-state-aborted"] } };
			markStageError(stages, "abort", outcome, update); notifyChanged(operation.repositoryId, "head,index,worktree"); return outcome;
		} catch (error) {
			const post = await inProgress(root).catch(() => null);
			const postFacts = await localFacts(root).catch(() => null);
			let finalError = remoteError(error);
			const unchanged = Boolean(post && digest(post) === pre.intermediateDigest && postFacts?.stateVersion === pre.stateVersion);
			let status = finalError.code === "cancelled" && unchanged ? "cancelled" : "failed";
			if (started && !unchanged) {
				status = "unknown-result";
				finalError = stableError("unknown-result", "abort result is uncertain", { requiresRefresh: true });
			}
			const outcome = { status, error: finalError, result: { stages, preFacts: pre, postFacts: { intermediate: post, local: postFacts }, sideEffects: unchanged ? [] : ["intermediate-state-may-have-changed"] } };
			markStageError(stages, "abort", outcome, update); return outcome;
		}
	};

	const issueConfirmation = async ({ repositoryId, confirmationRequestId, actor = "shared-auth-token", operationType = "git.abort", params, preconditionToken } = {}) => {
		if (typeof repositoryId !== "string" || repositoryId === "") throw invalid("repositoryId is required");
		if (typeof confirmationRequestId !== "string" || !REQUEST_ID.test(confirmationRequestId)) throw invalid("confirmationRequestId is required");
		if (operationType !== "git.abort") throw invalid("only abort confirmations are supported");
		if (!params || typeof params !== "object" || Array.isArray(params)) throw invalid("confirmation params are required");
		if (typeof actor !== "string" || actor === "") throw invalid("actor is required");
		if (typeof preconditionToken !== "string") throw stableError("state-changed", "precondition token is invalid", { requiresRefresh: true });
		const record = tokenRecord(preconditionToken);
		const paramsDigest = digest(params);
		const preconditionDigest = digest(preconditionToken);
		const actorDigest = digest(actor);
		if (!record || record.repositoryId !== repositoryId || record.type !== operationType || record.paramsDigest !== paramsDigest) throw stableError("state-changed", "precondition token is invalid", { requiresRefresh: true });
		const coordinationDomains = await operationDomains(repositoryId, operationType, params);
		const coordinationDigest = digest(coordinationDomains);
		if (record.expected.coordinationDigest && record.expected.coordinationDigest !== coordinationDigest) throw stableError("state-changed", "operation coordination changed", { requiresRefresh: true });
		const key = `${repositoryId}:${confirmationRequestId}`;
		const requestDigest = digest({ repositoryId, operationType, paramsDigest, preconditionDigest, actorDigest, coordinationDigest });
		const stored = operations?.getConfirmation?.(key);
		if (stored && stored.expiresAt > now()) {
			if (stored.requestDigest !== requestDigest) throw new GitOperationError("idempotency-conflict", "confirmationRequestId is already bound to different parameters");
			if (!verifyChallenge(stored.challengeId)) throw stableError("state-changed", "stored confirmation is invalid", { requiresRefresh: true });
			return { challengeId: stored.challengeId, expiresAt: stored.expiresAt, summary: stored.summary, deduplicated: true };
		}
		const existing = challenges.get(key);
		if (existing && existing.expiresAt > now()) {
			if (existing.requestDigest !== requestDigest) throw new GitOperationError("idempotency-conflict", "confirmationRequestId is already bound to different parameters");
			return { challengeId: existing.challengeId, expiresAt: existing.expiresAt, summary: existing.summary, deduplicated: true };
		}
		const payloadObject = { version: 1, challengeId: randomUUID(), repositoryId, operationType, paramsDigest, preconditionDigest, actorDigest, coordinationDigest, summary: "Abort the current Git merge or rebase", expiresAt: now() + CHALLENGE_TTL };
		const payload = canonicalJson(payloadObject);
		const body = Buffer.from(payload, "utf8").toString("base64url");
		const mac = createHmac("sha256", secret).update(payload).digest("base64url");
		const challengeId = `challenge_${body}.${mac}`;
		const value = { ...payloadObject, challengeId, requestDigest };
		const persisted = operations?.recordConfirmation?.({ key, challengeId, requestDigest, expiresAt: value.expiresAt, summary: value.summary });
		const result = persisted?.deduplicated ? persisted : value;
		if (result.challengeId !== challengeId && !verifyChallenge(result.challengeId)) throw stableError("state-changed", "stored confirmation is invalid", { requiresRefresh: true });
		challenges.set(key, { ...value, challengeId: result.challengeId });
		return { challengeId: result.challengeId, expiresAt: result.expiresAt, summary: result.summary, deduplicated: persisted?.deduplicated === true };
	};
	const verifyChallenge = (challengeId) => {
		if (typeof challengeId !== "string" || !challengeId.startsWith("challenge_")) return null;
		try {
			const value = challengeId.slice("challenge_".length);
			const separator = value.indexOf(".");
			if (separator < 1) return null;
			const payload = Buffer.from(value.slice(0, separator), "base64url");
			const supplied = Buffer.from(value.slice(separator + 1), "base64url");
			const expected = createHmac("sha256", secret).update(payload).digest();
			if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
			const record = JSON.parse(payload.toString("utf8"));
			return record?.version === 1 && record.expiresAt > now() ? record : null;
		} catch { return null; }
	};
	const consumeConfirmation = async ({ challengeId, repositoryId, actor, operationType, params, preconditionToken, requestId }) => {
		if (!REQUEST_ID.test(String(requestId ?? ""))) throw invalid("requestId is required");
		if (!params || typeof params !== "object" || Array.isArray(params)) throw stableError("confirmation-required", "confirmation challenge is invalid or expired");
		const challenge = verifyChallenge(challengeId);
		const coordinationDomains = await operationDomains(repositoryId, operationType, params);
		if (!challenge || challenge.repositoryId !== repositoryId || challenge.operationType !== operationType || challenge.paramsDigest !== digest(params) || challenge.preconditionDigest !== digest(preconditionToken) || challenge.actorDigest !== digest(actor) || (challenge.coordinationDigest && challenge.coordinationDigest !== digest(coordinationDomains))) throw stableError("confirmation-required", "confirmation challenge is invalid or expired");
		return challenge;
	};

	const operationDomains = async (repositoryId, kind, params) => {
		if (typeof git?.coordinationDomains !== "function") throw stableError("provider-incompatible", "Git provider does not expose write coordination");
		try {
			const domains = await git.coordinationDomains(repositoryId, kind, params);
			if (!Array.isArray(domains) || domains.length === 0 || domains.some((domain) => typeof domain !== "string" || domain === "")) throw new Error("invalid coordination domains");
			return [...new Set(domains)].sort();
		} catch (error) {
			if (error instanceof GitOperationError) throw error;
			throw stableError("provider-unavailable", "Git write coordination is unavailable");
		}
	};
	const submit = async ({ repositoryId, requestId, actor, kind, params = {}, preconditionToken } = {}) => {
		if (typeof operations?.submit !== "function") throw stableError("provider-unavailable", "Git operation provider unavailable");
		const record = tokenRecord(preconditionToken);
		verifyOperationToken({ repositoryId, kind, params }, record);
		const domains = await operationDomains(repositoryId, kind, params);
		return operations.submit({ repositoryId, requestId, actor, kind, params, preconditionToken, coordinationDomains: domains, stages: kind === "git.sync" ? [stageView("fetch", "fetch", 1), stageView("integrate", params.strategy, 2), stageView("push", "push", 3)] : undefined });
	};
	const submitFetch = (input = {}) => submit({ ...input, kind: "git.fetch" });
	const submitPull = (input = {}) => submit({ ...input, kind: "git.pull" });
	const submitPush = (input = {}) => submit({ ...input, kind: "git.push" });
	const submitSync = (input = {}) => submit({ ...input, kind: "git.sync" });
	const submitAbort = async ({ repositoryId, requestId, actor = "shared-auth-token", params = {}, preconditionToken, challengeId } = {}) => {
		if (typeof operations?.submit !== "function") throw stableError("provider-unavailable", "Git operation provider unavailable");
		if (!REQUEST_ID.test(String(requestId ?? ""))) throw invalid("requestId is required");
		const record = tokenRecord(preconditionToken);
		verifyOperationToken({ repositoryId, kind: "git.abort", params }, record);
		const challenge = await consumeConfirmation({ challengeId, repositoryId, actor, operationType: "git.abort", params, preconditionToken, requestId });
		return operations.submit({ repositoryId, requestId, actor, kind: "git.abort", params, preconditionToken, coordinationDomains: await operationDomains(repositoryId, "git.abort", params), recoveryExempt: true, confirmation: { challengeId, requestId, coordinationDigest: challenge.coordinationDigest } });
	};
	const handoff = async ({ repositoryId, operationId, target, reason, requestId, expectedRevision, facts } = {}) => {
		if (typeof operations.handoff !== "function") throw stableError("provider-incompatible", "operation provider does not support handoff");
		return operations.handoff({ repositoryId, operationId, target, reason, requestId, expectedRevision, facts });
	};

	const remoteFactsView = (repositoryId, value) => {
		const invalidResponse = () => stableError("provider-invalid-response", "Git provider returned invalid remote facts", { requiresRefresh: true });
		if (!value || typeof value !== "object" || Array.isArray(value) || value.repositoryId !== repositoryId || !Array.isArray(value.remotes) || !Array.isArray(value.localBranches) || typeof value.stateVersion !== "string" || value.stateVersion === "") throw invalidResponse();
		if (value.remotes.length > 100 || value.localBranches.length > 1000) throw invalidResponse();
		const remoteNamesSeen = new Set();
		const remotes = value.remotes.map((remote) => {
			if (!remote || typeof remote !== "object" || typeof remote.name !== "string" || !REMOTE_NAME.test(remote.name) || remoteNamesSeen.has(remote.name) || !Array.isArray(remote.branches) || remote.branches.length > 1000) throw invalidResponse();
			remoteNamesSeen.add(remote.name);
			const fetchUrl = safeRemoteUrl(remote.fetchUrl);
			const pushUrl = safeRemoteUrl(remote.pushUrl);
			if ((remote.fetchUrl !== undefined && remote.fetchUrl !== null && fetchUrl === null) || (remote.pushUrl !== undefined && remote.pushUrl !== null && pushUrl === null)) throw invalidResponse();
			const branchNames = new Set();
			const branches = remote.branches.map((branch) => {
				if (!branch || typeof branch !== "object" || !safeBranch(branch.branch) || branchNames.has(branch.branch) || branch.remoteRef !== trackingRef(remote.name, branch.branch) || !isOid(branch.oid)) throw invalidResponse();
				branchNames.add(branch.branch);
				return { branch: branch.branch, remoteRef: branch.remoteRef, oid: branch.oid };
			});
			return { name: remote.name, fetchUrl: fetchUrl ?? null, pushUrl: pushUrl ?? null, branches };
		});
		const localNames = new Set();
		const localBranches = value.localBranches.map((branch) => {
			if (!branch || typeof branch !== "object" || !safeBranch(branch.name) || localNames.has(branch.name) || (branch.oid !== null && !isOid(branch.oid)) || (branch.upstream !== null && branch.upstream !== undefined && (typeof branch.upstream !== "string" || branch.upstream.length > 256 || /[\x00-\x20]/.test(branch.upstream)))) throw invalidResponse();
			localNames.add(branch.name);
			return { name: branch.name, oid: branch.oid ?? null, upstream: branch.upstream ?? null };
		});
		return { repositoryId, remotes, localBranches, stateVersion: value.stateVersion };
	};
	const capabilities = () => {
		let baseAvailable = false;
		try { baseAvailable = Boolean(git?.capabilities?.()?.available); } catch {}
		const remoteReader = typeof git?.remotes === "function";
		const coordination = typeof git?.coordinationDomains === "function";
		const operationAvailable = Boolean(operations?.isAvailable?.());
		const readable = Boolean(baseAvailable && remoteReader);
		const available = Boolean(readable && operationAvailable && coordination);
		return { available, writes: available, externalConcurrencyProtection: "detect-only", operationPersistence: true, idempotency: true, recovery: true, preconditions: true, features: { remotes: readable, fetch: available, pull: available, pullMerge: available, pullRebase: available, push: available, sync: available, abort: available, handoff: Boolean(operations?.handoff), forcePush: false }, reason: !baseAvailable ? "git-provider-unavailable" : !operationAvailable ? "operation-provider-unavailable" : !remoteReader || !coordination ? "provider-incompatible" : null };
	};
	const removePreconditionChecker = typeof operations?.addPreconditionChecker === "function" ? operations.addPreconditionChecker(check) : undefined;
	if (!removePreconditionChecker) operations?.setPreconditionChecker?.(check);
	operations?.registerExecutor?.("git.fetch", ({ operation, signal, update }) => fetchInternal(operation, signal, update));
	operations?.registerExecutor?.("git.pull", ({ operation, signal, update }) => pullInternal(operation, signal, update));
	operations?.registerExecutor?.("git.push", ({ operation, signal, update }) => pushInternal(operation, signal, update));
	operations?.registerExecutor?.("git.sync", ({ operation, signal, update }) => syncInternal(operation, signal, update));
	operations?.registerExecutor?.("git.abort", ({ operation, signal, update }) => abortInternal(operation, signal, update));
	return {
		capabilities,
		remotes: async (repositoryId) => {
			if (typeof repositoryId !== "string" || repositoryId === "") throw invalid("repositoryId is required");
			if (typeof git?.remotes !== "function") throw stableError("provider-incompatible", "Git provider does not expose remote facts");
			try { return remoteFactsView(repositoryId, await git.remotes(repositoryId)); }
			catch (error) { throw remoteError(error); }
		},
		fetchPreflight: (input) => makeRemotePreflight({ ...input, kind: "git.fetch" }),
		pullPreflight: (input) => makeRemotePreflight({ ...input, kind: "git.pull" }),
		pushPreflight: (input) => makeRemotePreflight({ ...input, kind: "git.push" }),
		syncPreflight: (input) => makeRemotePreflight({ ...input, kind: "git.sync" }),
		submitFetch, submitPull, submitPush, submitSync,
		abortPreflight,
		issueConfirmation,
		submitAbort,
		handoff,
		check,
		stop() { removePreconditionChecker?.(); records.clear(); challenges.clear(); },
	};
}
