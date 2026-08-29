import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";

// B0's task seam. Callers provide repository facts and an executor; this module
// owns durable state, ordering, cancellation, recovery and event projection.

export const OPERATION_STATES = Object.freeze([
	"accepted", "queued", "running", "succeeded", "failed", "cancelled", "conflicted", "unknown-result",
]);
export const TERMINAL_OPERATION_STATES = new Set(["succeeded", "failed", "cancelled", "conflicted", "unknown-result"]);

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const MAX_DETAIL = 240;

export class GitOperationError extends Error {
	constructor(code, message = code, options = {}) {
		super(message);
		this.name = "GitOperationError";
		this.code = code;
		this.retryable = options.retryable ?? false;
		this.requiresRefresh = options.requiresRefresh ?? false;
		this.publicDetail = options.publicDetail;
		this.nextActions = options.nextActions;
		this.facts = options.facts;
	}
}

export function canonicalJson(value) {
	const encode = (item) => {
		if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
		if (typeof item === "number") {
			if (!Number.isFinite(item)) throw new TypeError("canonical JSON does not support non-finite numbers");
			return JSON.stringify(item);
		}
		if (Array.isArray(item)) return `[${item.map(encode).join(",")}]`;
		if (typeof item === "object") {
			const keys = Object.keys(item).filter((key) => item[key] !== undefined).sort();
			return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(item[key])}`).join(",")}}`;
		}
		throw new TypeError(`canonical JSON does not support ${typeof item}`);
	};
	return encode(value);
}

export function digest(value) {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function durableWrite(path, content) {
	const fd = openSync(path, "w", 0o600);
	try {
		const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
		let offset = 0;
		while (offset < buffer.length) offset += writeSync(fd, buffer, offset);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try { chmodSync(path, 0o600); } catch {}
}

function fsyncDirectory(path) {
	try {
		const fd = openSync(path, "r");
		try { fsyncSync(fd); } finally { closeSync(fd); }
	} catch {
		// Windows does not permit opening directories this way; the file fsync
		// remains the strongest portable durability guarantee available there.
	}
}

function atomicWrite(path, content) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		durableWrite(tmp, content);
		renameSync(tmp, path);
		fsyncDirectory(dirname(path));
	} finally {
		try { unlinkSync(tmp); } catch {}
	}
}

function readJson(path) {
	try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function emptyState() {
	return { generation: 0, txIds: [], operations: {}, requestIndex: {}, recoveryBlocks: {} };
}

function normalizeState(value) {
	const state = value && typeof value === "object" ? value : {};
	return {
		generation: Number.isInteger(state.generation) && state.generation >= 0 ? state.generation : 0,
		txIds: Array.isArray(state.txIds) ? state.txIds.filter((x) => typeof x === "string") : [],
		operations: state.operations && typeof state.operations === "object" ? state.operations : {},
		requestIndex: state.requestIndex && typeof state.requestIndex === "object" ? state.requestIndex : {},
		recoveryBlocks: state.recoveryBlocks && typeof state.recoveryBlocks === "object" ? state.recoveryBlocks : {},
	};
}

function domainsOf(operation) {
	if (Array.isArray(operation?.coordinationDomains)) {
		const domains = [...new Set(operation.coordinationDomains.filter((domain) => typeof domain === "string" && domain !== ""))].sort();
		if (domains.length > 0) return domains;
	}
	return typeof operation?.coordinationDomain === "string" && operation.coordinationDomain !== "" ? [operation.coordinationDomain] : [];
}

function recoveryBlockers(value) {
	return Array.isArray(value) ? value.filter((id) => typeof id === "string") : typeof value === "string" ? [value] : [];
}

function hasRecoveryBlock(state, domain) {
	return recoveryBlockers(state.recoveryBlocks[domain]).length > 0;
}

function addRecoveryBlock(state, domains, operationId) {
	for (const domain of domains) {
		const blockers = recoveryBlockers(state.recoveryBlocks[domain]);
		if (!blockers.includes(operationId)) blockers.push(operationId);
		state.recoveryBlocks[domain] = blockers.length === 1 ? blockers[0] : blockers;
	}
}

function removeRecoveryBlock(state, domains, operationId) {
	for (const domain of domains) {
		const blockers = recoveryBlockers(state.recoveryBlocks[domain]).filter((id) => id !== operationId);
		if (blockers.length === 0) delete state.recoveryBlocks[domain];
		else state.recoveryBlocks[domain] = blockers.length === 1 ? blockers[0] : blockers;
	}
}

function applyEvent(state, event) {
	const { type, operationId } = event ?? {};
	if (type === "operations.pruned") {
		for (const id of event.operationIds ?? []) delete state.operations[id];
		for (const [key, value] of Object.entries(state.requestIndex)) if ((event.operationIds ?? []).includes(value?.operationId)) delete state.requestIndex[key];
		return;
	}
	if (type === "operation.created") {
		state.operations[operationId] = event.operation;
		state.requestIndex[event.requestKey] = { operationId, requestDigest: event.requestDigest };
		return;
	}
	const operation = state.operations[operationId];
	if (!operation) return;
	if (type === "operation.updated") {
		Object.assign(operation, event.patch);
		operation.revision = (operation.revision ?? 0) + 1;
		return;
	}
	if (type === "operation.recovery-blocked") {
		operation.revision = (operation.revision ?? 0) + 1;
		operation.recoveryBlocked = true;
		addRecoveryBlock(state, domainsOf(operation), operationId);
		return;
	}
	if (type === "recovery.acknowledged") {
		operation.recoveryBlocked = false;
		operation.recoveryAcknowledgedAt = event.at;
		operation.recoveryRequestId = event.requestId;
		operation.recoveryFacts = event.facts ?? null;
		removeRecoveryBlock(state, domainsOf(operation), operationId);
		operation.revision = (operation.revision ?? 0) + 1;
	}
}

function parseFrames(buffer) {
	const frames = [];
	let offset = 0;
	let corrupt = false;
	while (offset < buffer.length) {
		const newline = buffer.indexOf(10, offset);
		if (newline < 0) break; // A final partial write is safely ignored.
		const line = buffer.subarray(offset, newline);
		offset = newline + 1;
		const first = line.indexOf(58); // ':'
		const second = first < 0 ? -1 : line.indexOf(58, first + 1);
		if (first <= 0 || second <= first + 1) { corrupt = true; break; }
		const length = Number(line.subarray(0, first).toString("ascii"));
		const checksum = line.subarray(first + 1, second).toString("ascii");
		const payload = line.subarray(second + 1);
		if (!Number.isSafeInteger(length) || length !== payload.length || !/^[a-f0-9]{64}$/.test(checksum)) { corrupt = true; break; }
		if (createHash("sha256").update(payload).digest("hex") !== checksum) { corrupt = true; break; }
		try {
			const frame = JSON.parse(payload.toString("utf8"));
			if (typeof frame?.txId !== "string" || !Array.isArray(frame.events)) { corrupt = true; break; }
			frames.push(frame);
		} catch { corrupt = true; break; }
	}
	return { frames, corrupt };
}

export class OperationLedger {
	constructor({ filePath, snapshotPath = `${filePath}.snapshot.json`, now = () => Date.now() }) {
		if (!filePath) throw new TypeError("filePath is required");
		this.filePath = filePath;
		this.snapshotPath = snapshotPath;
		this.now = now;
		mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
		this.state = emptyState();
		this.corrupt = false;
		this.load();
	}

	load() {
		const snapshot = readJson(this.snapshotPath);
		if (snapshot?.state && typeof snapshot.checksum === "string" && digest(snapshot.state) === snapshot.checksum) {
			this.state = normalizeState(snapshot.state);
		}
		const seen = new Set(this.state.txIds);
		let frames = { frames: [], corrupt: false };
		try { frames = parseFrames(readFileSync(this.filePath)); } catch {}
		this.corrupt = frames.corrupt;
		for (const frame of frames.frames) {
			if (seen.has(frame.txId)) continue;
			for (const event of frame.events) applyEvent(this.state, event);
			seen.add(frame.txId);
			this.state.txIds.push(frame.txId);
		}
	}

	transaction(events) {
		if (!Array.isArray(events) || events.length === 0) throw new TypeError("transaction requires events");
		const txId = randomUUID();
		const payload = Buffer.from(canonicalJson({ txId, events }), "utf8");
		const frame = Buffer.from(`${payload.length}:${createHash("sha256").update(payload).digest("hex")}:${payload.toString("utf8")}\n`, "utf8");
		const fd = openSync(this.filePath, "a", 0o600);
		try {
			let offset = 0;
			while (offset < frame.length) offset += writeSync(fd, frame, offset);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		fsyncDirectory(dirname(this.filePath));
		for (const event of events) applyEvent(this.state, event);
		this.state.txIds.push(txId);
		return txId;
	}

	compact() {
		const next = normalizeState({ ...this.state, generation: this.state.generation + 1 });
		atomicWrite(this.snapshotPath, JSON.stringify({ state: next, checksum: digest(next) }));
		// A crash between snapshot rename and truncation is safe: replay skips the
		// txIds already represented by the snapshot.
		durableWrite(this.filePath, "");
		fsyncDirectory(dirname(this.filePath));
		this.state = next;
	}
}

function safeDetail(error) {
	if (typeof error?.publicDetail === "string") return error.publicDetail.slice(0, MAX_DETAIL);
	if (error instanceof GitOperationError && typeof error.message === "string") return error.message.slice(0, MAX_DETAIL);
	return undefined;
}

function publicError(error) {
	const code = typeof error?.code === "string" ? error.code : "git-operation-failed";
	return {
		errorCode: code,
		detail: safeDetail(error),
		retryable: error?.retryable === true,
		requiresRefresh: error?.requiresRefresh === true,
		...(Array.isArray(error?.nextActions) ? { nextActions: error.nextActions } : {}),
	};
}

function lockError(code, path) {
	return new GitOperationError(code, code, { publicDetail: `协调资源暂不可用（${path.split(/[\\/]/).at(-1)}）` });
}

function reclaimDeadLock(path) {
	const owner = readJson(path);
	if (!owner || !Number.isInteger(owner.pid)) return false;
	try {
		process.kill(owner.pid, 0);
		return false;
	} catch (error) {
		if (error?.code !== "ESRCH") return false;
		try { unlinkSync(path); return true; } catch { return false; }
	}
}

function acquireExclusive(path, owner, code) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	try {
		const fd = openSync(path, "wx", 0o600);
		try { writeSync(fd, Buffer.from(JSON.stringify(owner), "utf8")); fsyncSync(fd); } finally { closeSync(fd); }
		return true;
	} catch (error) {
		if (error?.code === "EEXIST" && reclaimDeadLock(path)) return acquireExclusive(path, owner, code);
		if (error?.code === "EEXIST") throw lockError(code, path);
		throw error;
	}
}

function releaseExclusive(path, instanceId) {
	const owner = readJson(path);
	if (owner?.instanceId === instanceId || owner?.operationId === instanceId) {
		try { unlinkSync(path); } catch {}
	}
}

function cursorEncode(offset) { return Buffer.from(String(offset), "utf8").toString("base64url"); }
function cursorDecode(value) {
	if (!value) return 0;
	try {
		const offset = Number(Buffer.from(String(value), "base64url").toString("utf8"));
		if (Number.isInteger(offset) && offset >= 0) return offset;
	} catch {}
	throw new GitOperationError("invalid-argument", "invalid cursor");
}

function clone(value) {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function createGitOperationManager({
	filePath,
	snapshotPath,
	instanceLockPath = `${filePath}.owner`,
	leaseDirectory = `${filePath}.leases`,
	now = () => Date.now(),
	reconcile,
	verifyRecoveryFacts,
	autoStart = false,
	maxOperations = 2000,
} = {}) {
	if (!filePath) throw new TypeError("filePath is required");
	const ledger = new OperationLedger({ filePath, snapshotPath, now });
	const instanceId = randomUUID();
	const executors = new Map();
	const queues = new Map();
	const controllers = new Map();
	const listeners = new Set();
	let started = false;
	let stopping = false;
	let available = !ledger.corrupt;
	let lockOwned = false;
	let startPromise;
	const activeLeases = new Map();

	const emit = (operation, event = "updated") => {
		const view = operationView(operation);
		for (const listener of listeners) {
			try { listener({ type: "git/operation", event, operation: view }); } catch {}
		}
	};
	const operationView = (operation) => {
		if (!operation) return null;
		return {
			operationId: operation.operationId,
			requestId: operation.requestId,
			repositoryId: operation.repositoryId,
			coordinationDomain: operation.coordinationDomain,
			coordinationDomains: domainsOf(operation),
			kind: operation.kind,
			status: operation.status,
			revision: operation.revision,
			phase: operation.phase ?? null,
			phaseIndex: operation.phaseIndex ?? 0,
			phaseCount: operation.phaseCount ?? 1,
			progress: operation.progress ?? null,
			cancellable: operation.status === "queued" || operation.status === "running",
			cancelRequested: operation.cancelRequested === true,
			deduplicated: false,
			createdAt: operation.createdAt,
			updatedAt: operation.updatedAt,
			...(operation.startedAt === undefined ? {} : { startedAt: operation.startedAt }),
			...(operation.finishedAt === undefined ? {} : { finishedAt: operation.finishedAt }),
			...(operation.result === undefined ? {} : { result: clone(operation.result) }),
			...(operation.error ? { error: clone(operation.error), errorCode: operation.error.errorCode, nextActions: operation.error.nextActions ?? [] } : {}),
			...(operation.facts ? { facts: clone(operation.facts) } : {}),
			...(operation.recoveryBlocked ? { recoveryBlocked: true } : {}),
			...(operation.recoveryAcknowledgedAt ? { recoveryAcknowledgedAt: operation.recoveryAcknowledgedAt } : {}),
		};
	};
	const getOperation = (operationId) => ledger.state.operations[operationId];
	const checkAvailable = () => {
		if (!available || !started) throw new GitOperationError("provider-unavailable", "Git operation provider unavailable");
	};
	const isBlocked = (domain) => hasRecoveryBlock(ledger.state, domain);
	const commit = (events, eventName = "updated") => {
		ledger.transaction(events);
		for (const event of events) {
			if (event.operationId) emit(getOperation(event.operationId), eventName);
		}
	};
	const updateOperation = (operationId, patch, eventName = "updated") => {
		const operation = getOperation(operationId);
		if (!operation) throw new GitOperationError("operation-not-found", "operation not found");
		const next = { ...patch, updatedAt: now() };
		commit([{ type: "operation.updated", operationId, patch: next }], eventName);
		return operation;
	};
	const updateProgress = (operationId, patch) => {
		if (stopping) return getOperation(operationId);
		if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new GitOperationError("invalid-argument", "invalid progress update");
		const allowed = new Set(["phase", "phaseIndex", "phaseCount", "progress", "facts"]);
		const keys = Object.keys(patch);
		if (keys.some((key) => !allowed.has(key))) throw new GitOperationError("invalid-argument", "progress update contains a protected field");
		if (patch.phase !== undefined && (typeof patch.phase !== "string" || patch.phase === "")) throw new GitOperationError("invalid-argument", "invalid phase");
		if (patch.phaseIndex !== undefined && (!Number.isInteger(patch.phaseIndex) || patch.phaseIndex < 0)) throw new GitOperationError("invalid-argument", "invalid phaseIndex");
		if (patch.phaseCount !== undefined && (!Number.isInteger(patch.phaseCount) || patch.phaseCount < 1)) throw new GitOperationError("invalid-argument", "invalid phaseCount");
		return updateOperation(operationId, patch, "progress");
	};
	const queueFor = (domain) => {
		let queue = queues.get(domain);
		if (!queue) { queue = []; queues.set(domain, queue); }
		return queue;
	};
	const leasePathFor = (domain) => `${leaseDirectory}/${digest(domain).slice(0, 32)}.lease`;
	const acquireLease = (domains, operationId) => {
		const ordered = [...new Set(domains)].sort();
		const acquired = [];
		try {
			for (const domain of ordered) {
				const path = leasePathFor(domain);
				acquireExclusive(path, { instanceId, operationId, pid: process.pid, at: now() }, "repository-busy");
				acquired.push({ domain, path });
			}
			activeLeases.set(operationId, acquired);
		} catch (error) {
			for (const { path } of acquired) { try { unlinkSync(path); } catch {} }
			throw error;
		}
	};
	const releaseLease = (domains, operationId) => {
		const leases = activeLeases.get(operationId) ?? [...new Set(domains)].sort().map((domain) => ({ domain, path: leasePathFor(domain) }));
		for (const { path } of leases) {
			const owner = readJson(path);
			if (owner?.instanceId === instanceId && owner?.operationId === operationId) { try { unlinkSync(path); } catch {} }
		}
		activeLeases.delete(operationId);
	};
	const pruneIfNeeded = () => {
		const operations = Object.values(ledger.state.operations);
		const excess = operations.length - Math.max(1, maxOperations);
		if (excess <= 0) return;
		const removable = operations
			.filter((op) => TERMINAL_OPERATION_STATES.has(op.status) && !op.recoveryBlocked)
			.sort((a, b) => a.createdAt - b.createdAt)
			.slice(0, excess)
			.map((op) => op.operationId);
		if (removable.length > 0) commit([{ type: "operations.pruned", operationIds: removable }], "pruned");
	};
	const finish = (operationId, outcome) => {
		const operation = getOperation(operationId);
		if (!operation || TERMINAL_OPERATION_STATES.has(operation.status)) return operation;
		const requested = outcome?.status ?? "succeeded";
		const status = OPERATION_STATES.includes(requested) && TERMINAL_OPERATION_STATES.has(requested) ? requested : "failed";
		const patch = {
			status,
			finishedAt: now(),
			...(outcome?.result === undefined ? {} : { result: outcome.result }),
			...(outcome?.facts === undefined ? {} : { facts: outcome.facts }),
			...(outcome?.error ? { error: publicError(outcome.error) } : {}),
		};
		updateOperation(operationId, patch, "terminal");
		if (status === "unknown-result" || status === "conflicted") {
			commit([{ type: "operation.recovery-blocked", operationId }], "blocked");
		}
		pruneIfNeeded();
		return operation;
	};
	const runOne = async (operationId) => {
		const operation = getOperation(operationId);
		if (!operation || TERMINAL_OPERATION_STATES.has(operation.status)) return;
		const domains = domainsOf(operation);
		if (domains.some(isBlocked)) return;
		const executor = executors.get(operation.kind);
		if (!executor) return; // A later provider registration can resume queued work.
		let leased = false;
		try {
			acquireLease(domains, operationId);
			leased = true;
			updateOperation(operationId, { status: "running", startedAt: now(), phase: operation.phase ?? "running", phaseIndex: operation.phaseIndex ?? 0 });
			const controller = new AbortController();
			controllers.set(operationId, controller);
			if (typeof preconditionChecker === "function") await preconditionChecker(clone(operation));
			const outcome = await executor({
				operation: clone(operation),
				signal: controller.signal,
				update: (patch) => updateProgress(operationId, patch),
			});
			if (!stopping) finish(operationId, outcome ?? { status: "succeeded" });
		} catch (error) {
			if (stopping) return;
			const status = ["conflicted", "unknown-result", "cancelled"].includes(error?.code) ? error.code : "failed";
			finish(operationId, { status, error, facts: error?.facts });
		} finally {
			controllers.delete(operationId);
			if (leased) releaseLease(domains, operationId);
		}
	};
	let scheduling = false;
	let scheduleAgain = false;
	const busyDomains = new Set();
	const schedule = async () => {
		if (scheduling) { scheduleAgain = true; return; }
		scheduling = true;
		try {
			do {
				scheduleAgain = false;
				let selected = null;
				for (const queue of queues.values()) {
					const operationId = queue[0];
					const operation = getOperation(operationId);
					if (!operation || operation.status !== "queued") { if (operationId) queue.shift(); continue; }
					const domains = domainsOf(operation);
					if (domains.length > 0 && domains.every((domain) => queueFor(domain)[0] === operationId) && !domains.some(isBlocked) && !domains.some((domain) => busyDomains.has(domain)) && executors.has(operation.kind)) {
						selected = { operationId, domains };
						break;
					}
				}
				if (!selected) break;
				for (const domain of selected.domains) { queueFor(domain).shift(); busyDomains.add(domain); }
				void runOne(selected.operationId).finally(() => {
					for (const domain of selected.domains) busyDomains.delete(domain);
					schedule();
				});
			} while (scheduleAgain);
		} finally {
			scheduling = false;
			if (scheduleAgain) void schedule();
		}
	};
	const enqueue = (operationId) => {
		const operation = getOperation(operationId);
		if (!operation || operation.status !== "queued") return;
		for (const domain of domainsOf(operation)) {
			const queue = queueFor(domain);
			if (!queue.includes(operationId)) queue.push(operationId);
		}
		void schedule();
	};
	let preconditionChecker;

	const reconcileOperation = async (operation) => {
		if (typeof reconcile !== "function") {
			finish(operation.operationId, { status: "unknown-result", error: new GitOperationError("unknown-result", "result requires reconciliation", { requiresRefresh: true }) });
			return;
		}
		try {
			const outcome = await reconcile({ operation: clone(operation) });
			if (!outcome) finish(operation.operationId, { status: "unknown-result", error: new GitOperationError("unknown-result", "result requires reconciliation", { requiresRefresh: true }) });
			else finish(operation.operationId, outcome);
		} catch (error) {
			finish(operation.operationId, { status: "unknown-result", error: new GitOperationError("unknown-result", "result requires reconciliation", { requiresRefresh: true, facts: error?.facts }) });
		}
	};

	const start = () => {
		if (startPromise) return startPromise;
		startPromise = (async () => {
			try {
				if (ledger.corrupt) throw new GitOperationError("provider-unavailable", "operation ledger is corrupt", { requiresRefresh: true });
				acquireExclusive(instanceLockPath, { instanceId, pid: process.pid, at: now() }, "provider-ambiguous");
				lockOwned = true;
				stopping = false;
				available = true;
				started = true;
				for (const operation of Object.values(ledger.state.operations)) {
					if (operation.status === "running") await reconcileOperation(operation);
				}
				for (const operation of Object.values(ledger.state.operations)) if (operation.status === "queued") enqueue(operation.operationId);
			} catch (error) {
				started = false;
				available = !ledger.corrupt;
				if (lockOwned) { releaseExclusive(instanceLockPath, instanceId); lockOwned = false; }
				startPromise = undefined;
				throw error;
			}
		})();
		return startPromise;
	};
	const submit = async ({ repositoryId, requestId, actor = "shared-auth-token", kind, params = {}, coordinationDomain = repositoryId, coordinationDomains, preconditionToken, execute } = {}) => {
		checkAvailable();
		if (!REQUEST_ID.test(String(requestId ?? ""))) throw new GitOperationError("invalid-argument", "invalid requestId");
		if (typeof repositoryId !== "string" || repositoryId === "") throw new GitOperationError("invalid-argument", "repositoryId is required");
		if (typeof kind !== "string" || kind === "") throw new GitOperationError("invalid-argument", "kind is required");
		if (typeof coordinationDomain !== "string" || coordinationDomain === "") throw new GitOperationError("invalid-argument", "coordinationDomain is required");
		const domains = [...new Set((Array.isArray(coordinationDomains) ? coordinationDomains : [coordinationDomain]).filter((domain) => typeof domain === "string" && domain.trim() !== ""))].sort();
		if (domains.length === 0) throw new GitOperationError("invalid-argument", "coordinationDomains is required");
		if (typeof preconditionToken !== "string" || preconditionToken === "") throw new GitOperationError("invalid-argument", "preconditionToken is required");
		const requestKey = `${digest(actor)}:${requestId}`;
		const requestDigest = digest({ repositoryId, coordinationDomain: domains[0], coordinationDomains: domains, kind, params, preconditionToken });
		const existing = ledger.state.requestIndex[requestKey];
		if (existing) {
			if (existing.requestDigest !== requestDigest) throw new GitOperationError("idempotency-conflict", "requestId is already bound to different parameters");
			const view = operationView(getOperation(existing.operationId));
			view.deduplicated = true;
			return view;
		}
		const operationId = randomUUID();
		const operation = {
			operationId, requestId, repositoryId, coordinationDomain: domains[0], coordinationDomains: domains, kind,
			params: clone(params), preconditionToken,
			status: "queued", revision: 1, phase: "queued", phaseIndex: 0, phaseCount: 1,
			createdAt: now(), updatedAt: now(), recoveryBlocked: domains.some(isBlocked),
		};
		commit([{ type: "operation.created", operationId, requestKey, requestDigest, operation }], "accepted");
		if (typeof execute === "function") executors.set(kind, execute);
		enqueue(operationId);
		return operationView(operation);
	};
	const cancel = async (operationId, { requestId, expectedRevision } = {}) => {
		checkAvailable();
		if (!REQUEST_ID.test(String(requestId ?? ""))) throw new GitOperationError("invalid-argument", "invalid requestId");
		const operation = getOperation(operationId);
		if (!operation) throw new GitOperationError("operation-not-found", "operation not found");
		if (operation.cancelRequestId) {
			if (operation.cancelRequestId === requestId) { const view = operationView(operation); view.deduplicated = true; return view; }
			throw new GitOperationError("idempotency-conflict", "operation already has a different cancel request");
		}
		if (!Number.isInteger(expectedRevision) || expectedRevision !== operation.revision) throw new GitOperationError("state-changed", "operation revision changed", { requiresRefresh: true });
		if (operation.status === "queued") {
			for (const queue of queues.values()) {
				const index = queue.indexOf(operationId);
				if (index >= 0) queue.splice(index, 1);
			}
			updateOperation(operationId, { status: "cancelled", finishedAt: now(), phase: "cancelled", cancelRequestId: requestId }, "terminal");
			return operationView(operation);
		}
		if (operation.status !== "running") throw new GitOperationError("operation-not-cancellable", "operation is terminal");
		updateOperation(operationId, { cancelRequested: true, cancelRequestedAt: now(), cancelRequestId: requestId }, "cancel-requested");
		controllers.get(operationId)?.abort();
		return operationView(operation);
	};
	const acknowledgeRecovery = async ({ repositoryId, operationId, facts, requestId, expectedRevision } = {}) => {
		checkAvailable();
		if (!REQUEST_ID.test(String(requestId ?? ""))) throw new GitOperationError("invalid-argument", "invalid requestId");
		const operation = getOperation(operationId);
		if (!operation || operation.repositoryId !== repositoryId) throw new GitOperationError("operation-not-found", "operation not found");
		if (operation.recoveryRequestId) {
			if (operation.recoveryRequestId === requestId) { const view = operationView(operation); view.deduplicated = true; return view; }
			throw new GitOperationError("idempotency-conflict", "operation already has a different recovery request");
		}
		if (operation.status !== "unknown-result" && operation.status !== "conflicted") throw new GitOperationError("invalid-argument", "operation does not block recovery");
		if (!domainsOf(operation).some((domain) => recoveryBlockers(ledger.state.recoveryBlocks[domain]).includes(operationId))) throw new GitOperationError("invalid-argument", "recovery is already acknowledged");
		if (!Number.isInteger(expectedRevision) || expectedRevision !== operation.revision) throw new GitOperationError("state-changed", "operation revision changed", { requiresRefresh: true });
		if (!facts || typeof facts !== "object" || Array.isArray(facts) || facts.confirmed !== true || typeof facts.stateVersion !== "string" || facts.stateVersion === "" || !Number.isFinite(facts.observedAt)) throw new GitOperationError("invalid-argument", "recovery facts must confirm a current read-only state");
		if (typeof verifyRecoveryFacts === "function" && !(await verifyRecoveryFacts({ operation: clone(operation), facts: clone(facts) }))) throw new GitOperationError("state-changed", "recovery facts no longer match the repository", { requiresRefresh: true });
		// Verification may yield to another acknowledgement. Re-read all guards
		// immediately before the synchronous transaction so only one can commit.
		const current = getOperation(operationId);
		if (!current || current.repositoryId !== repositoryId) throw new GitOperationError("operation-not-found", "operation not found");
		if (current.recoveryRequestId) {
			if (current.recoveryRequestId === requestId) { const view = operationView(current); view.deduplicated = true; return view; }
			throw new GitOperationError("idempotency-conflict", "operation already has a different recovery request");
		}
		if (current.status !== "unknown-result" && current.status !== "conflicted") throw new GitOperationError("state-changed", "operation status changed", { requiresRefresh: true });
		if (current.revision !== expectedRevision) throw new GitOperationError("state-changed", "operation revision changed", { requiresRefresh: true });
		if (!domainsOf(current).some((domain) => recoveryBlockers(ledger.state.recoveryBlocks[domain]).includes(operationId))) throw new GitOperationError("state-changed", "recovery is already acknowledged", { requiresRefresh: true });
		const projected = { recoveryBlocks: Object.fromEntries(Object.entries(ledger.state.recoveryBlocks).map(([domain, blockers]) => [domain, clone(blockers)])) };
		removeRecoveryBlock(projected, domainsOf(current), operationId);
		const updates = Object.values(ledger.state.operations)
			.filter((candidate) => candidate.status === "queued")
			.map((candidate) => ({ candidate, recoveryBlocked: domainsOf(candidate).some((domain) => hasRecoveryBlock(projected, domain)) }))
			.filter(({ candidate, recoveryBlocked }) => Boolean(candidate.recoveryBlocked) !== recoveryBlocked)
			.map(({ candidate, recoveryBlocked }) => ({ type: "operation.updated", operationId: candidate.operationId, patch: { recoveryBlocked, updatedAt: now() } }));
		commit([
			{ type: "recovery.acknowledged", operationId, requestId, at: now(), facts: clone(facts) },
			...updates,
		], "recovery-acknowledged");
		for (const candidate of Object.values(ledger.state.operations)) if (candidate.status === "queued") enqueue(candidate.operationId);
		return operationView(current);
	};
	const manager = {
		start,
		stop() {
			stopping = true;
			// Executors are required to honor AbortSignal. Release our leases after
			// requesting termination so a later provider instance is not stranded by
			// an unloaded plugin; the executor's adapter must not start new work once
			// its signal is aborted.
			for (const controller of controllers.values()) controller.abort();
			for (const [operationId, leases] of activeLeases) releaseLease(leases.map((lease) => lease.domain), operationId);
			activeLeases.clear();
			controllers.clear();
			if (lockOwned) releaseExclusive(instanceLockPath, instanceId);
			lockOwned = false;
			started = false;
			available = false;
			startPromise = undefined;
		},
		isAvailable: () => available && started,
		ready: () => startPromise ?? Promise.resolve(),
		registerExecutor(kind, executor) { if (typeof kind !== "string" || typeof executor !== "function") throw new TypeError("executor required"); executors.set(kind, executor); for (const op of Object.values(ledger.state.operations)) if (op.kind === kind && op.status === "queued") enqueue(op.operationId); },
		setPreconditionChecker(checker) { preconditionChecker = checker; },
		submit,
		cancel,
		acknowledgeRecovery,
		get(operationId) { checkAvailable(); return operationView(getOperation(operationId)); },
		list({ repositoryId, status, cursor, limit } = {}) {
			checkAvailable();
			const rawLimit = limit === undefined || limit === null || limit === "" ? 50 : Number(limit);
			if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) throw new GitOperationError("invalid-argument", "limit must be an integer from 1 to 100");
			if (status !== undefined && !OPERATION_STATES.includes(status)) throw new GitOperationError("invalid-argument", "invalid operation status");
			const n = rawLimit;
			const values = Object.values(ledger.state.operations).filter((op) => (!repositoryId || op.repositoryId === repositoryId) && (!status || op.status === status)).sort((a, b) => b.createdAt - a.createdAt || b.operationId.localeCompare(a.operationId));
			const offset = cursorDecode(cursor);
			const page = values.slice(offset, offset + n).map(operationView);
			return { operations: page, nextCursor: offset + page.length < values.length ? cursorEncode(offset + page.length) : null };
		},
		onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
		compact() { checkAvailable(); ledger.compact(); },
		capabilities() {
			return {
				serviceDefinitionVersion: "1.0.0", providerVersion: "0.1.0", gitMobileContractVersion: "2.0.0",
				available: available && started, writes: false,
				operationPersistence: true, idempotency: true, recovery: true, preconditions: true,
				features: { operations: true, operationCancel: true, operationRecovery: true },
			};
		},
	};
	if (autoStart) void start().catch(() => {});
	return manager;
}
