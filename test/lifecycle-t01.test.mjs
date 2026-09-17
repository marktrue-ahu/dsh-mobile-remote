import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { apply } from "../lib/index.js";

const CONFIG = {
	path: "/m",
	authToken: "1234567890123456",
	cookieName: "dsh_mobile_token",
	trustedHosts: [],
	sessionTtlMs: 60_000,
	rechargeUrl: "https://example.test/top-up",
	maxConnections: 4,
	pushUrls: [],
	pushCooldownMs: 1,
	doneGraceMs: 1,
	pushContent: "minimal",
	rateLimit: {},
	lanBridge: { enabled: false },
	// mobile 语义：不挂 $events 后台循环，生命周期断言只观察「挂载 → 卸载」这一条链
	approvalMode: "mobile",
};

/** 内核挂起问询的 fail-close 超时（lib/index.js PENDING_TIMEOUT_MS）。 */
const PENDING_TIMEOUT_MS = 120_000;
/** 卸载清理里显式 clearInterval 的三个周期定时器：剪枝 10min / 持存清扫 30s / SSE 心跳 25s。 */
const PERIODIC_INTERVAL_MS = [600_000, 30_000, 25_000];

class FakeResponse extends EventEmitter {
	constructor() {
		super();
		this.headersSent = false;
		this.destroyed = false;
		this.writableLength = 0;
		this.chunks = [];
	}
	writeHead(statusCode, headers) {
		this.statusCode = statusCode;
		this.headers = headers;
		this.headersSent = true;
	}
	write(chunk) {
		this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
		return true;
	}
	end(chunk = "") {
		if (chunk !== "") this.write(chunk);
		this.emit("finish");
	}
	destroy() {
		if (this.destroyed) return;
		this.destroyed = true;
		this.emit("close");
	}
}

class FakeRequest extends EventEmitter {
	constructor(url, method = "GET") {
		super();
		this.url = url;
		this.method = method;
		this.headers = { host: "127.0.0.1", "x-mobile-token": CONFIG.authToken, "content-type": "application/json" };
		this.socket = { remoteAddress: "127.0.0.1" };
	}
}

/**
 * 宿主侧共享注册表（路由 + 事件监听）。
 * `register()` / `ctx.on()` 返回的注销函数是**真实生效**的 spy：既记录调用，又从注册表移除——
 * 这样「卸载后路由注销、监听移除」与「重复加载不重复注册」才是同一份表上的可观测事实。
 */
function createHost() {
	const routes = [];
	const listeners = new Map(); // event -> [{ fn, options }]
	const unsubCalls = []; // { kind, target }
	const spy = (kind, target, remove) => () => {
		unsubCalls.push({ kind, target });
		remove();
	};
	return {
		routes,
		unsubCalls,
		registerRoute(spec) {
			const entry = { spec };
			routes.push(entry);
			return spy("route", spec.path, () => {
				const index = routes.indexOf(entry);
				if (index >= 0) routes.splice(index, 1);
			});
		},
		registerListener(event, fn, options) {
			const entry = { fn, options };
			const list = listeners.get(event) ?? [];
			list.push(entry);
			listeners.set(event, list);
			return spy("event", event, () => {
				const index = list.indexOf(entry);
				if (index >= 0) list.splice(index, 1);
				if (list.length === 0) listeners.delete(event);
			});
		},
		routeHandler(path) {
			return routes.find((entry) => entry.spec.path === path)?.spec.handler;
		},
		listenerEntries(event) {
			return listeners.get(event) ?? [];
		},
		listenerCounts() {
			const counts = new Map();
			for (const [event, list] of listeners) counts.set(event, list.length);
			return counts;
		},
	};
}

/** 旧代交互帧桥之外的任务注册表（ctx.get("jobs")）：其注销函数同样必须被卸载调用。 */
function createJobsRegistry(host) {
	const spy = (target) => {
		const entry = { kind: "jobs", target };
		return () => host.unsubCalls.push(entry);
	};
	return { list: () => [], onJobsChanged: () => spy("jobs/onJobsChanged"), onJobDone: () => spy("jobs/onJobDone") };
}

function createHarness(overrides = {}, config = CONFIG, host = createHost()) {
	const cleanups = [];
	const ctx = {
		webServer: { host: "127.0.0.1", port: 43120, register: host.registerRoute },
		logger: overrides.logger ?? { warn() {}, info() {} },
		get(name) {
			const override = overrides.get?.(name);
			if (override !== undefined) return override;
			return overrides.fallback?.(name);
		},
		provide() {},
		effect(fn) {
			const cleanup = fn?.();
			cleanups.push(cleanup);
			return cleanup;
		},
		inject() {},
		on(event, fn, options) {
			return host.registerListener(event, fn, options);
		},
	};
	apply(ctx, config);
	let cleaned = false;
	return {
		ctx,
		host,
		route: host.routeHandler(`${config.path}/api`),
		fire(event, ...args) {
			const entries = host.listenerEntries(event);
			assert.equal(entries.length, 1, `${event} 应恰有一个监听者（实际 ${entries.length}）`);
			return entries[0].fn(...args);
		},
		clean() {
			if (cleaned) return;
			cleaned = true;
			for (const cleanup of cleanups.reverse()) cleanup?.();
		},
	};
}

async function getRoute(route, url) {
	const req = new FakeRequest(url);
	const res = new FakeResponse();
	const done = new Promise((resolve) => res.once("finish", resolve));
	route(req, res);
	await done;
	return res;
}

function sseConnect(route) {
	const req = new FakeRequest("/m/api/events");
	const res = new FakeResponse();
	route(req, res);
	return res;
}

function frameOf(sse, marker) {
	for (const chunk of sse.chunks) {
		if (!chunk.startsWith("data: ") || !chunk.includes(marker)) continue;
		return JSON.parse(chunk.slice(6)).frame;
	}
	return undefined;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * 定时器 spy：只记录、不改语义（返回真实句柄，保留 unref/clearTimeout 行为），
 * 用于断言「卸载后定时器被清理」而不是仅凭实现自述。
 */
function installTimerSpy() {
	const realSetTimeout = globalThis.setTimeout;
	const realClearTimeout = globalThis.clearTimeout;
	const realSetInterval = globalThis.setInterval;
	const realClearInterval = globalThis.clearInterval;
	const created = [];
	const byHandle = new Map();
	const record = (kind, handle, delay) => {
		const entry = { kind, delay, handle, cleared: false };
		created.push(entry);
		byHandle.set(handle, entry);
		return entry;
	};
	globalThis.setTimeout = (fn, delay, ...args) => {
		const handle = realSetTimeout(fn, delay, ...args);
		record("timeout", handle, delay);
		return handle;
	};
	globalThis.clearTimeout = (handle) => {
		const entry = byHandle.get(handle);
		if (entry) entry.cleared = true;
		return realClearTimeout(handle);
	};
	globalThis.setInterval = (fn, delay, ...args) => {
		const handle = realSetInterval(fn, delay, ...args);
		record("interval", handle, delay);
		return handle;
	};
	globalThis.clearInterval = (handle) => {
		const entry = byHandle.get(handle);
		if (entry) entry.cleared = true;
		return realClearInterval(handle);
	};
	return {
		created,
		timeouts: (delay) => created.filter((entry) => entry.kind === "timeout" && entry.delay === delay),
		intervals: (delay) => created.filter((entry) => entry.kind === "interval" && entry.delay === delay),
		restore() {
			globalThis.setTimeout = realSetTimeout;
			globalThis.clearTimeout = realClearTimeout;
			globalThis.setInterval = realSetInterval;
			globalThis.clearInterval = realClearInterval;
		},
	};
}

test("T01-1 单次 apply 注册路由与事件监听者，且同一事件名不重复注册（诊断可读）", async () => {
	const host = createHost();
	const harness = createHarness({ get: (name) => name === "jobs" ? createJobsRegistry(host) : undefined }, CONFIG, host);
	try {
		// 路由：API 前缀 + 二维码（两枚都是 webServer.register 的注册项）
		assert.equal(typeof harness.route, "function", "API 路由处理器已注册");
		assert.equal(typeof host.routeHandler(`${CONFIG.path}/qr.png`), "function", "二维码路由已注册");
		assert.equal(host.routes.length, 2, "一次 apply 只注册两条路由");

		// 事件监听者：审批/问询瀑布 + 会话/状态/销毁——每个事件名恰好一个监听者
		const counts = host.listenerCounts();
		for (const event of ["approval/request", "user-questions/request", "session/event", "agent/status", "agent/disposed"]) {
			assert.equal(counts.get(event), 1, `${event} 已注册且仅注册一次`);
		}
		for (const [event, count] of counts) {
			assert.equal(count, 1, `${event} 不应重复注册（实际 ${count}）`);
		}

		// 审批/问询必须是 global+prepend 的根监听：否则内核按 agent 作用域过滤时分发不到本插件
		for (const event of ["approval/request", "user-questions/request"]) {
			const entry = host.listenerEntries(event)[0];
			assert.equal(entry.options?.prepend, true, `${event} 需 prepend（排在内核转发监听之前）`);
			assert.equal(entry.options?.global, true, `${event} 需 global（跨 agent 作用域分发）`);
		}

		// 加载成功的外部可观测证据：诊断可读
		const res = await getRoute(harness.route, `${CONFIG.path}/api/diagnostics`);
		assert.equal(res.statusCode, 200);
		const body = JSON.parse(res.chunks.at(-1));
		assert.equal(body.ok, true);
		assert.equal(body.plugin.name, "dsh-mobile-remote");
		assert.equal(body.checks.approvalMode, "mobile");
	} finally {
		harness.clean();
	}
});

test("T01-2 卸载调用全部注销 spy：路由注销、监听者移除、任务注册表监听解绑", () => {
	const host = createHost();
	const harness = createHarness({ get: (name) => name === "jobs" ? createJobsRegistry(host) : undefined }, CONFIG, host);
	try {
		// apply 期间不得提前注销（挂载即注册，卸载才注销）
		assert.deepEqual(host.unsubCalls, [], "apply 期间不应调用任何注销函数");

		harness.clean();

		const byKind = (kind) => host.unsubCalls.filter((call) => call.kind === kind).map((call) => call.target).sort();
		assert.deepEqual(byKind("route"), [`${CONFIG.path}/api`, `${CONFIG.path}/qr.png`], "两条路由的注销函数都被调用");
		assert.deepEqual(byKind("event"), [
			"agent/disposed",
			"agent/status",
			"approval/request",
			"session/event",
			"user-questions/request",
		], "五个 ctx.on 注销函数都被调用");
		assert.deepEqual(byKind("jobs"), ["jobs/onJobDone", "jobs/onJobsChanged"], "任务注册表监听解绑");
		assert.equal(host.routes.length, 0, "卸载后宿主路由表为空");
		assert.equal(host.listenerCounts().size, 0, "卸载后宿主事件表为空");
	} finally {
		harness.clean();
	}
});

test("T01-3 卸载拒绝挂起中的问询（ASK_CANCELLED）并清掉它的 120s 超时定时器", async () => {
	const timerSpy = installTimerSpy();
	const host = createHost();
	const harness = createHarness({ get: (name) => name === "jobs" ? createJobsRegistry(host) : undefined }, CONFIG, host);
	try {
		const sse = sseConnect(harness.route);
		let nextCalled = false;
		// 真实走插件问询通路：waterfall(user-questions/request) → 手机在线独占接管
		const pending = harness.fire("user-questions/request", {
			agent: { session: { id: "s-t01" } },
			questions: [{ id: "q1", question: "继续？", options: [{ label: "是" }, { label: "否" }] }],
		}, () => { nextCalled = true; });
		assert.ok(pending instanceof Promise, "瀑布被手机接管（返回挂起 Promise）");
		const outcome = pending.then(() => ({ resolved: true }), (error) => ({ resolved: false, name: error?.name, code: error?.code }));
		await tick();

		assert.equal(nextCalled, false, "手机在线时不放行内核转发（不弹桌面卡片）");
		assert.ok(frameOf(sse, "question/requested"), "手机已收到 question/requested 帧");

		const held = timerSpy.timeouts(PENDING_TIMEOUT_MS);
		assert.equal(held.length, 1, "挂起问询创建了 120s 超时定时器");
		assert.equal(held[0].cleared, false, "卸载前该定时器仍在计时");

		harness.clean();

		assert.deepEqual(await outcome, { resolved: false, name: "UserQuestionError", code: "ASK_CANCELLED" }, "卸载把挂起问询结算为取消错误而非放任悬挂");
		assert.equal(held[0].cleared, true, "卸载 clearTimeout 了挂起问询的 120s 超时定时器");
		assert.equal(timerSpy.timeouts(PENDING_TIMEOUT_MS).filter((entry) => !entry.cleared).length, 0, "卸载后不残留问询定时器");

		// pendingFrames 同步清空：卸载后重连的手机不应再被回放这张已取消的卡片
		const reconnected = sseConnect(harness.route);
		assert.equal(reconnected.chunks.some((chunk) => chunk.includes("question/requested")), false, "已取消卡片不再回放");
		reconnected.destroy();
	} finally {
		harness.clean();
		timerSpy.restore();
	}
});

test("T01-4 卸载释放已连接的 SSE 客户端，并清理周期定时器", async () => {
	const timerSpy = installTimerSpy();
	const host = createHost();
	const harness = createHarness({ get: (name) => name === "jobs" ? createJobsRegistry(host) : undefined }, CONFIG, host);
	try {
		const sse = sseConnect(harness.route);
		let closeEmitted = false;
		sse.once("close", () => { closeEmitted = true; });
		assert.equal(sse.destroyed, false, "挂载期间连接存活");
		assert.ok(sse.chunks.some((chunk) => chunk.includes("\"hello\"")), "SSE 握手完成");

		// 在线时事件帧可送达（作为「释放后不再送达」的对照）
		const before = sse.chunks.length;
		harness.fire("session/event", { id: "s-t01" }, { type: "session/title", data: { title: "T01" } });
		await tick();
		assert.ok(sse.chunks.length > before, "在线时事件帧送达手机通道");

		for (const delay of PERIODIC_INTERVAL_MS) {
			assert.equal(timerSpy.intervals(delay).length, 1, `${delay}ms 周期定时器已创建`);
		}

		harness.clean();

		assert.equal(sse.destroyed, true, "卸载后 SSE 响应被 destroy 释放");
		assert.equal(closeEmitted, true, "释放触发 close（连接从宿主侧真正断开）");
		for (const delay of PERIODIC_INTERVAL_MS) {
			const records = timerSpy.intervals(delay);
			assert.ok(records.length >= 1 && records.every((entry) => entry.cleared), `${delay}ms 周期定时器已清理`);
		}

		// 卸载后不再向已释放连接写帧
		const after = sse.chunks.length;
		await tick();
		assert.equal(sse.chunks.length, after, "卸载后不再写入已释放连接");
	} finally {
		harness.clean();
		timerSpy.restore();
	}
});

test("T01-5 重复加载（卸载后重新 apply）不重复注册监听/路由", () => {
	const host = createHost();
	const overrides = { get: (name) => name === "jobs" ? createJobsRegistry(host) : undefined };
	const first = createHarness(overrides, CONFIG, host);
	first.clean();
	assert.equal(host.routes.length, 0);
	assert.equal(host.listenerCounts().size, 0);

	const second = createHarness(overrides, CONFIG, host);
	try {
		assert.equal(host.routes.length, 2, "重新加载后路由数仍为 2（无累积）");
		const counts = host.listenerCounts();
		assert.equal(counts.size, 5, "事件名集合不因重复加载而膨胀");
		for (const [event, count] of counts) {
			assert.equal(count, 1, `${event} 重新加载后仍只有一个监听者（实际 ${count}）`);
		}
	} finally {
		second.clean();
	}
	assert.equal(host.routes.length, 0, "再次卸载后路由表为空");
	assert.equal(host.listenerCounts().size, 0, "再次卸载后事件表为空");
});
