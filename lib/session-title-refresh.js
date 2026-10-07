import { performance } from "node:perf_hooks";

export const DEFAULT_TITLE_REFRESH_BUDGET_MS = 1500;
export const DEFAULT_TITLE_REFRESH_CONCURRENCY = 4;

/**
 * Coalesce title refreshes for one corpus pass. Each batch observes revisions
 * before folding, and a batch never reads more titles than the bounded worker
 * width. HTTP waiters may leave independently; the shared pass is cancelled
 * only after its last waiter leaves, unless a timed-out response promoted it to
 * deliberate background warm-up.
 */
export const createSessionTitleRefresher = ({
	readRevision,
	readTitles,
	getCachedTitle,
	setCachedTitle,
	onCacheChange = () => {},
	concurrency = DEFAULT_TITLE_REFRESH_CONCURRENCY,
} = {}) => {
	if (typeof readTitles !== "function") throw new TypeError("readTitles must be a function");
	if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new RangeError("concurrency must be a positive safe integer");
	let currentRun = null;
	let disposed = false;

	const finishRun = (run) => {
		run.done = true;
		if (currentRun === run) currentRun = null;
		run.resolve();
	};

	const processRun = async (run) => {
		const { signal } = run.controller;
		try {
			while (!disposed && !signal.aborted && run.queue.length > 0) {
				const batch = run.queue.splice(0, concurrency);
				const inspected = await Promise.all(batch.map(async (id) => {
					if (typeof readRevision !== "function") return { id, revision: null };
					try {
						const revision = await readRevision(id, signal);
						return { id, revision: typeof revision === "string" && revision !== "" ? revision : null };
					} catch (error) {
						if (signal.aborted) throw error;
						return { id, revision: null };
					}
				}));
				if (signal.aborted || disposed) break;

				const toFold = [];
				for (const item of inspected) {
					const cached = getCachedTitle?.(item.id, item.revision);
					if (cached?.hit) run.results.set(item.id, cached.title);
					else toFold.push(item);
				}

				if (toFold.length > 0 && !signal.aborted && !disposed) {
					let folded;
					try {
						folded = await readTitles(toFold.map(({ id }) => id), signal);
					} catch (error) {
						if (signal.aborted) throw error;
						folded = new Map();
					}
					if (signal.aborted || disposed) break;
					for (const { id, revision } of toFold) {
						const result = folded?.get?.(id);
						if (!result?.ok) continue;
						const title = typeof result.title === "string" && result.title !== "" ? result.title : null;
						setCachedTitle?.(id, revision, title);
						run.results.set(id, title);
					}
				}
				onCacheChange();
			}
		} catch {
			// An aborted or faulty refresh is a cache miss, never an endpoint failure.
		} finally {
			finishRun(run);
		}
	};

	const addIds = (run, ids) => {
		for (const id of ids) {
			if (typeof id !== "string" || id === "" || run.seen.has(id)) continue;
			run.seen.add(id);
			run.queue.push(id);
		}
	};

	const createRun = (ids) => {
		let resolve;
		const promise = new Promise((done) => { resolve = done; });
		const run = {
			controller: new AbortController(),
			queue: [],
			seen: new Set(),
			results: new Map(),
			waiters: 0,
			background: false,
			done: false,
			promise,
			resolve,
		};
		addIds(run, ids);
		currentRun = run;
		void processRun(run);
		return run;
	};

	const refresh = async (ids, { signal, budgetMs = DEFAULT_TITLE_REFRESH_BUDGET_MS } = {}) => {
		if (disposed || signal?.aborted) return new Map();
		const uniqueIds = [...new Set(ids)].filter((id) => typeof id === "string" && id !== "");
		if (uniqueIds.length === 0) return new Map();
		if (!Number.isFinite(budgetMs) || budgetMs < 0) throw new RangeError("budgetMs must be a non-negative finite number");

		let run = currentRun;
		if (!run || run.done) run = createRun(uniqueIds);
		else addIds(run, uniqueIds);
		run.waiters += 1;
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			run.waiters -= 1;
			if (!run.done && !run.background && run.waiters === 0) {
				run.controller.abort(new Error("all session-title refresh waiters left"));
			}
		};

		let timer;
		let abortHandler;
		const interrupted = new Promise((resolve) => {
			if (signal) {
				abortHandler = () => resolve("aborted");
				signal.addEventListener("abort", abortHandler, { once: true });
			}
			timer = setTimeout(() => resolve("budget"), budgetMs);
		});
		const outcome = await Promise.race([
			run.promise.then(() => "done"),
			interrupted,
		]);
		clearTimeout(timer);
		if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);

		if (outcome === "budget" && !signal?.aborted && !run.done) run.background = true;
		const aborted = signal?.aborted === true;
		release();
		return aborted ? new Map() : new Map(run.results);
	};

	return {
		refresh,
		dispose() {
			disposed = true;
			currentRun?.controller.abort(new Error("session-title refresher disposed"));
		},
		/** Test seam: resolve when the current single-flight pass settles. */
		whenIdle() {
			return currentRun?.promise ?? Promise.resolve();
		},
	};
};
