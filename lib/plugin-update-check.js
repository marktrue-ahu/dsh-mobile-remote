// issue #96：插件更新检查快照 + 有界异步检查任务。
//
// - 一次检查总 deadline（默认 12s）严格小于旧 App 的 15s 兼容窗口；
//   单次 npm view 仍可 20s，但整次检查 race 到 deadline 时返回明确 check-timeout，
//   绝不返回半结果。
// - 成功快照 5min、失败/unavailable 30s；force 绕过读缓存；cache key 含更新源/本地版本，
//   源配置或本地版本变化自然失效；宿主更新成功后调用 invalidate()。
// - 异步任务只存内存 map + TTL；同 key in-flight 去重；不持久化、不复用更新事务。
import { randomUUID } from "node:crypto";

export const UPDATE_CHECK_STATE = Object.freeze({
	CHECKING: "checking",
	DONE: "done",
	ERROR: "error",
});

const TIMEOUT_RESULT = {
	state: "unavailable",
	reason: "check-timeout",
	source: "npm",
};

function isFailureResult(result) {
	return result?.state !== "update-available" && result?.state !== "up-to-date" && result?.state !== "local-ahead";
}

/**
 * @param {object} options
 * @param {() => Promise<object>} options.checkFn 真正的 update check（不得自行吞掉总超时）
 * @param {() => string} [options.cacheKey] 更新源/本地版本指纹
 * @param {number} [options.checkTimeoutMs] 整次检查 deadline；必须 < 15000
 * @param {number} [options.successTtlMs]
 * @param {number} [options.failureTtlMs]
 * @param {number} [options.taskTtlMs] checkId 结果保留时长
 */
export function createUpdateCheckService({
	checkFn,
	cacheKey = () => "",
	checkTimeoutMs = 12_000,
	successTtlMs = 5 * 60 * 1000,
	failureTtlMs = 30 * 1000,
	taskTtlMs = 10 * 60 * 1000,
	now = () => Date.now(),
	newCheckId = () => randomUUID(),
} = {}) {
	if (typeof checkFn !== "function") throw new TypeError("checkFn is required");
	// 成功快照与失败短缓存分开：失败结果不进入“更新检查快照”（CONTEXT 契约），
	// 只有成功结果可供展示/提交复用；失败/unavailable 单独 30s 短缓存防止风暴。
	const snapshot = { key: "", result: null, at: 0 };
	const failureCache = { key: "", result: null, at: 0 };
	const tasks = new Map();
	let activeTask = null;
	let inFlight = null; // { key, promise }
	// 代际：invalidate/强制重查后旧 runCheck 的迟到写回必须被丢弃。
	let generation = 0;

	function freshResult(key) {
		if (snapshot.result !== null &&
			snapshot.key === key &&
			now() - snapshot.at < successTtlMs) return snapshot.result;
		if (failureCache.result !== null &&
			failureCache.key === key &&
			now() - failureCache.at < failureTtlMs) return failureCache.result;
		return null;
	}

	function staleResult() {
		return {
			state: "unavailable",
			reason: "check-stale",
			source: "npm",
			checkedAt: new Date().toISOString(),
		};
	}
	function rememberFailure(key, result) {
		failureCache.key = key;
		failureCache.result = result;
		failureCache.at = now();
		// 更新检查失败后，旧成功快照不再代表当前检查结果，必须失效。
		snapshot.result = null;
		snapshot.key = "";
		snapshot.at = 0;
	}
	function rememberSuccess(key, result) {
		snapshot.key = key;
		snapshot.result = result;
		snapshot.at = now();
		failureCache.result = null;
		failureCache.key = "";
		failureCache.at = 0;
	}

	function timeoutError() {
		return Object.assign(new Error("check-timeout"), { code: "check-timeout" });
	}

	function runWithDeadline() {
		let timer = null;
		const deadline = new Promise((_, reject) => {
			timer = setTimeout(() => reject(timeoutError()), checkTimeoutMs);
			timer.unref?.();
		});
		return Promise.race([Promise.resolve().then(checkFn), deadline]).finally(() => {
			if (timer) clearTimeout(timer);
		});
	}

	async function runCheck(key, runGeneration) {
		let result;
		try {
			result = await runWithDeadline();
			if (result?.state === "checking") return result;
		} catch (error) {
			if (error?.code === "check-timeout") {
				result = { ...TIMEOUT_RESULT, checkedAt: new Date().toISOString() };
			} else {
				// review P2：checkFn 任意异常都脱敏成稳定失败结果并进入失败短缓存，
				// 不原样返回 message，也避免连续两次 throw 都打 npm。
				result = {
					state: "unavailable",
					reason: "check-failed",
					source: "npm",
					checkedAt: new Date().toISOString(),
				};
			}
		}
		if (!result || typeof result !== "object") {
			result = {
				state: "unavailable",
				reason: "check-failed",
				source: "npm",
				checkedAt: new Date().toISOString(),
			};
		}
		const stamped = typeof result.checkedAt === "string" ? result : { ...result, checkedAt: new Date().toISOString() };
		// 旧代结果不写缓存，但调用方必须拿到明确的非 null stale 结果（可重试）。
		if (runGeneration !== generation) return staleResult();
		if (isFailureResult(stamped)) rememberFailure(key, stamped);
		else rememberSuccess(key, stamped);
		return stamped;
	}

	async function check({ force = false } = {}) {
		const key = String(cacheKey() ?? "");
		if (!force) {
			const cached = freshResult(key);
			if (cached) return cached;
		}
		// bootstrap + 立即 force：仍复用同一个 in-flight（不重复出网）。
		if (inFlight && inFlight.key === key) return inFlight.promise;
		// force 且没有可复用 in-flight：换代，旧在途结果不得回填。
		if (force) generation += 1;
		const runGeneration = generation;
		const promise = (async () => {
			try {
				return await runCheck(key, runGeneration);
			} finally {
				if (inFlight?.promise === promise) inFlight = null;
			}
		})();
		inFlight = { key, promise };
		return promise;
	}

	function scheduleTaskExpiry(task) {
		const timer = setTimeout(() => {
			if (tasks.get(task.checkId) === task) tasks.delete(task.checkId);
		}, taskTtlMs);
		timer.unref?.();
		task.expiryTimer = timer;
		if (activeTask === task) activeTask = null;
		return () => clearTimeout(timer);
	}

	function startAsync({ force = false } = {}) {
		const key = String(cacheKey() ?? "");
		if (activeTask && activeTask.state === UPDATE_CHECK_STATE.CHECKING && activeTask.key === key) {
			return { state: UPDATE_CHECK_STATE.CHECKING, checkId: activeTask.checkId };
		}
		const checkId = newCheckId();
		const task = {
			checkId,
			key,
			state: UPDATE_CHECK_STATE.CHECKING,
			startedAt: now(),
			result: null,
			error: null,
			promise: null,
			expiryTimer: null,
		};
		tasks.set(checkId, task);
		activeTask = task;
		// 异步任务与同步 GET 共享同一个 check promise（含 deadline、缓存、in-flight 去重）。
		task.promise = check({ force }).then(
			(result) => {
				task.result = result;
				task.state = UPDATE_CHECK_STATE.DONE;
				task.finishedAt = now();
				scheduleTaskExpiry(task);
				return result;
			},
			(error) => {
				task.state = UPDATE_CHECK_STATE.ERROR;
				// issue #96 review P2：HTTP 只回稳定 code，绝不返回 error.message（可能含路径）。
				task.error = error?.code === "check-timeout" ? "check-timeout" : "check-failed";
				task.finishedAt = now();
				scheduleTaskExpiry(task);
				return null;
			},
		);
		return { state: UPDATE_CHECK_STATE.CHECKING, checkId };
	}

	function getAsync(checkId) {
		const task = tasks.get(String(checkId ?? ""));
		if (!task) return { status: 404, body: { state: "error", error: "check-not-found" } };
		if (task.state === UPDATE_CHECK_STATE.CHECKING) {
			const age = now() - (task.startedAt ?? now());
			if (age > taskTtlMs) {
				tasks.delete(task.checkId);
				return { status: 410, body: { state: "error", error: "check-expired" } };
			}
			return { status: 200, body: { state: "checking", checkId: task.checkId } };
		}
		if (task.state === UPDATE_CHECK_STATE.ERROR) {
			return { status: 200, body: { state: "error", checkId: task.checkId, error: task.error } };
		}
		return { status: 200, body: { state: "done", checkId: task.checkId, result: task.result } };
	}

	async function checkSync() {
		return check({ force: false });
	}

	async function checkForSubmit() {
		// 优先 5min 成功快照；过期时等待当前 async 任务（同一 in-flight）或启动有 deadline 检查。
		return check({ force: false });
	}

	function invalidate() {
		generation += 1;
		snapshot.result = null;
		snapshot.key = "";
		snapshot.at = 0;
		failureCache.result = null;
		failureCache.key = "";
		failureCache.at = 0;
		// issue #96 review P2：同时清掉 checkId 结果与 in-flight 去重；旧 checkId 不再 done。
		for (const task of tasks.values()) {
			if (task.expiryTimer) clearTimeout(task.expiryTimer);
		}
		tasks.clear();
		activeTask = null;
		inFlight = null;
	}

	return {
		check,
		checkSync,
		checkForSubmit,
		startAsync,
		getAsync,
		invalidate,
		snapshot: () => snapshot.result,
		failureSnapshot: () => failureCache.result,
		_checkTimeoutMs: checkTimeoutMs,
	};
}
