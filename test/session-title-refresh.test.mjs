import assert from "node:assert/strict";
import test from "node:test";

import { createSessionTitleRefresher } from "../lib/session-title-refresh.js";

const deferred = () => {
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
};

const waitFor = async (predicate, message) => {
	for (let i = 0; i < 100; i += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	assert.fail(message);
};

test("revision 命中复用持久化标题，变化后才折叠新日志", async () => {
	const stored = new Map([["a", { revision: "r1", title: "标题 A" }]]);
	let reads = 0;
	const refresher = createSessionTitleRefresher({
		readRevision: async (id) => id === "gone" ? null : "r1",
		readTitles: async (ids) => {
			reads += ids.length;
			return new Map(ids.map((id) => [id, { ok: true, title: `fresh ${id}` }]));
		},
		getCachedTitle: (id, revision) => {
			const entry = stored.get(id);
			return entry?.revision === revision ? { hit: true, title: entry.title } : { hit: false };
		},
		setCachedTitle: (id, revision, title) => stored.set(id, { revision, title }),
	});

	assert.deepEqual(await refresher.refresh(["a"]), new Map([["a", "标题 A"]]));
	assert.equal(reads, 0, "相同 revision 不得重读日志");
	stored.set("a", { revision: "r0", title: "过期标题" });
	assert.deepEqual(await refresher.refresh(["a"]), new Map([["a", "fresh a"]]));
	assert.equal(reads, 1, "revision 变化必须回源一次");
	refresher.dispose();
});

test("并发调用共享一个在途折叠；一个等待者取消不取消另一个", async () => {
	const started = deferred();
	const finishRevision = deferred();
	let revisionCalls = 0;
	let foldCalls = 0;
	let internalSignal;
	const refresher = createSessionTitleRefresher({
		readRevision: (_id, signal) => {
			revisionCalls += 1;
			internalSignal = signal;
			started.resolve();
			return new Promise((resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				finishRevision.promise.then(() => resolve("r1"), reject);
			});
		},
		readTitles: async (ids) => {
			foldCalls += 1;
			return new Map(ids.map((id) => [id, { ok: true, title: `标题 ${id}` }]));
		},
	});
	const firstAbort = new AbortController();
	const secondAbort = new AbortController();
	const first = refresher.refresh(["shared"], { signal: firstAbort.signal, budgetMs: 1000 });
	await started.promise;
	const second = refresher.refresh(["shared"], { signal: secondAbort.signal, budgetMs: 1000 });
	firstAbort.abort(new Error("first client disconnected"));
	assert.deepEqual(await first, new Map());
	assert.equal(internalSignal.aborted, false, "另一等待者仍在等时不得取消共享工作");
	finishRevision.resolve();
	assert.deepEqual(await second, new Map([["shared", "标题 shared"]]));
	assert.equal(revisionCalls, 1, "并发请求不得重复 stat");
	assert.equal(foldCalls, 1, "并发请求不得重复标题折叠");
	refresher.dispose();
});

test("最后一个 HTTP 等待者断开会取消在途读取", async () => {
	const started = deferred();
	let sourceAborted = false;
	const refresher = createSessionTitleRefresher({
		readRevision: (_id, signal) => new Promise((resolve, reject) => {
			started.resolve();
			signal.addEventListener("abort", () => {
				sourceAborted = true;
				reject(signal.reason);
			}, { once: true });
		}),
		readTitles: async () => new Map(),
	});
	const request = new AbortController();
	const result = refresher.refresh(["only"], { signal: request.signal, budgetMs: 1000 });
	await started.promise;
	request.abort(new Error("client disconnected"));
	assert.deepEqual(await result, new Map());
	await refresher.whenIdle();
	assert.equal(sourceAborted, true, "没人等待时应把取消传到上游 stat");
	refresher.dispose();
});

test("响应预算到期后保留共享工作作为后台预热", async () => {
	const started = deferred();
	const finishRevision = deferred();
	let sourceAborted = false;
	let folds = 0;
	const refresher = createSessionTitleRefresher({
		readRevision: (_id, signal) => new Promise((resolve, reject) => {
			started.resolve();
			signal.addEventListener("abort", () => {
				sourceAborted = true;
				reject(signal.reason);
			}, { once: true });
			finishRevision.promise.then(() => resolve("r1"), reject);
		}),
		readTitles: async (ids) => {
			folds += ids.length;
			return new Map(ids.map((id) => [id, { ok: true, title: `标题 ${id}` }]));
		},
	});
	const result = await refresher.refresh(["warm"], { budgetMs: 10 });
	assert.deepEqual(result, new Map(), "未完成的标题应允许短码兜底");
	await started.promise;
	assert.equal(sourceAborted, false, "预算到期是后台预热，不等同于客户端断开");
	finishRevision.resolve();
	await refresher.whenIdle();
	assert.equal(folds, 1, "后台预热应补齐标题");
	refresher.dispose();
});

test("stat 与标题折叠并发均受四路上限约束", async () => {
	let active = 0;
	let maxActive = 0;
	const enter = async (work) => {
		active += 1;
		maxActive = Math.max(maxActive, active);
		try {
			await new Promise((resolve) => setTimeout(resolve, 2));
			return await work();
		} finally {
			active -= 1;
		}
	};
	const refresher = createSessionTitleRefresher({
		readRevision: (id) => enter(() => `r-${id}`),
		readTitles: async (ids) => {
			const pairs = await Promise.all(ids.map((id) => enter(() => [id, { ok: true, title: id }])));
			return new Map(pairs);
		},
		concurrency: 4,
	});
	const ids = Array.from({ length: 17 }, (_, i) => `s-${i}`);
	const result = await refresher.refresh(ids, { budgetMs: 1000 });
	assert.equal(result.size, ids.length);
	assert.ok(maxActive <= 4, `observed ${maxActive} concurrent source reads`);
	refresher.dispose();
});
