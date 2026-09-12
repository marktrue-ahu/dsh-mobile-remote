import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { apply, SUPPORTED_HOST_RANGE } from "../lib/index.js";

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
	approvalMode: "both",
};

/** lib/index.js 的 HOST_UPGRADE_HINT（未导出，按同一常量拼接）。 */
const HOST_UPGRADE_HINT = `请把电脑端 DSH 升级到 ${SUPPORTED_HOST_RANGE} 或同代更高版本`;

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

function createHarness(overrides = {}, config = CONFIG) {
	const routes = [];
	const listeners = new Map();
	const cleanups = [];
	const ctx = {
		webServer: { host: "127.0.0.1", port: 43120, register(spec) { routes.push(spec); return () => {}; } },
		logger: overrides.logger ?? { warn() {}, info() {} },
		get(name) {
			const override = overrides.get?.(name);
			if (override !== undefined) return override;
			return overrides.fallback?.(name);
		},
		provide() {},
		effect(fn) { const cleanup = fn?.(); cleanups.push(cleanup); return cleanup; },
		inject() {},
		on(event, fn, options) { listeners.set(event, { fn, options }); return () => listeners.delete(event); },
	};
	apply(ctx, config);
	return {
		ctx,
		route: routes.find((spec) => spec.path === `${config.path}/api`).handler,
		listenerOptions(event) { return listeners.get(event)?.options; },
		fire(event, ...args) {
			const entry = listeners.get(event);
			assert.ok(entry, `${event} 监听者已注册`);
			return entry.fn(...args);
		},
		clean() { for (const cleanup of cleanups.reverse()) cleanup?.(); },
	};
}

/**
 * 「半可用」宿主网关：事件桥（openWireStream）在、结算通路（dispatchRpc）缺。
 * 即既有 T21 用例的同一降级场景，本文件只补三条缺口断言，不重复 remoteEvents 上报。
 */
function brokenSettlementGateway({ endFirstStream = false } = {}) {
	let opens = 0;
	return {
		opens: () => opens,
		invokeRpc() { return Promise.resolve({ ok: true, value: {} }); },
		openWireStream(_endpoint, _payload, signal) {
			opens += 1;
			const attempt = opens;
			return (async function* () {
				yield { type: "ready", clientId: `client-${attempt}` };
				// endFirstStream：首条流立即结束 → 走 while 重连路径，用于验证告警不在重连循环内
				if (endFirstStream && attempt === 1) return;
				await new Promise((resolve) => {
					if (signal.aborted) resolve();
					else signal.addEventListener("abort", resolve, { once: true });
				});
			})();
		},
		// 无 dispatchRpc —— 问询/审批出站结算通路缺失
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

async function postJson(route, body) {
	const req = new FakeRequest("/m/api/respond", "POST");
	const res = new FakeResponse();
	const done = new Promise((resolve) => res.once("finish", resolve));
	route(req, res);
	queueMicrotask(() => {
		req.emit("data", Buffer.from(JSON.stringify(body)));
		req.emit("end");
	});
	await done;
	return { status: res.statusCode, body: JSON.parse(res.chunks.at(-1)) };
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

async function until(predicate, attempts = 100) {
	for (let i = 0; i < attempts; i++) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return predicate();
}

test("T21-A 结算通路缺失：启动即出现一次「结算通路不可用」告警（含升级指引，重连不重复）", async () => {
	const warned = [];
	const infos = [];
	const logger = { warn: (message) => warned.push(String(message)), info: (message) => infos.push(String(message)) };
	const gateway = brokenSettlementGateway({ endFirstStream: true });
	const settleWarns = () => warned.filter((message) => message.includes("结算通路"));
	const harness = createHarness({ get: (name) => name === "typertGateway" ? gateway : undefined, logger }, CONFIG);
	try {
		// 告警在 apply 内同步打出（位于 while 重连循环之外）→ 属于「启动日志」
		assert.equal(settleWarns().length, 1, `启动即有一条结算通路告警：${JSON.stringify(warned)}`);
		const message = settleWarns()[0];
		assert.ok(message.includes("结算通路"), `含结算通路措辞：${message}`);
		assert.ok(message.includes("dispatchRpc"), `含 dispatchRpc 措辞：${message}`);
		assert.ok(message.includes(HOST_UPGRADE_HINT), `含升级指引：${message}`);
		// 事件桥本身是就绪的（半可用态：能收事件、不能结算），否则本用例测的不是同一条缺口
		assert.ok(await until(() => infos.some((line) => line.includes("$events 双端呈现就绪"))), "$events 事件桥已就绪");

		// 首条流结束 → 1s 退避重连；重连后仍不得重复告警
		assert.ok(await until(() => gateway.opens() >= 2, 300), `已发生重连（实际 opens=${gateway.opens()}）`);
		await tick();
		assert.equal(settleWarns().length, 1, `重连后不重复告警（实际 ${settleWarns().length} 条）`);
	} finally {
		harness.clean();
	}
});

test("T21-B 结算通路缺失 + 手机在线：问询/审批由手机独占应答，不依赖已坏的 $events 结算", async () => {
	const infos = [];
	const logger = { warn() {}, info: (message) => infos.push(String(message)) };
	const harness = createHarness(
		{ get: (name) => name === "typertGateway" ? brokenSettlementGateway() : undefined, logger },
		CONFIG,
	);
	try {
		// 事件桥就绪而结算通路缺失（半可用态）——瀑布据此按 mobile 语义独占接管
		assert.ok(await until(() => infos.some((line) => line.includes("$events 双端呈现就绪"))), "$events 事件桥已就绪");
		for (const event of ["approval/request", "user-questions/request"]) {
			const options = harness.listenerOptions(event);
			assert.equal(options?.prepend, true, `${event} 瀑布监听已 prepend`);
			assert.equal(options?.global, true, `${event} 瀑布监听已 global`);
		}
		const sse = sseConnect(harness.route);

		// ① 问询：手机在线 → 插件挂起瀑布并下发卡片，不放行内核转发（桌面不弹无法应答的卡）
		let nextCalled = false;
		const pending = harness.fire("user-questions/request", {
			agent: { session: { id: "s-t21q" } },
			questions: [{ id: "q1", question: "选一个", options: [{ label: "A" }, { label: "B" }] }],
		}, () => { nextCalled = true; });
		assert.ok(pending instanceof Promise, "问询瀑布被手机独占接管（返回挂起 Promise）");
		const outcome = pending.then((value) => ({ settled: true, value }), (error) => ({ settled: false, code: error?.code ?? error?.name }));
		await tick();
		assert.equal(nextCalled, false, "未放行内核转发 → 不会出现无人能答的桌面卡片");
		const questionFrame = frameOf(sse, "question/requested");
		assert.ok(questionFrame, "手机收到 question/requested 帧");
		assert.equal(questionFrame.sessionId, "s-t21q");
		assert.deepEqual(questionFrame.questions.map((question) => question.id), ["q1"], "帧内携带完整问题列表");

		// 手机 /respond 应答：走本地 answerer 结算（无 dispatchRpc 也成立）
		const answered = await postJson(harness.route, {
			kind: "question",
			rpcId: questionFrame.rpcId,
			sessionId: "s-t21q",
			answers: [{ id: "q1", selected: ["A"] }],
		});
		assert.equal(answered.status, 200);
		assert.deepEqual(answered.body, { ok: true, accepted: true });
		assert.deepEqual(await outcome, { settled: true, value: { answers: [{ id: "q1", selected: ["A"] }] } }, "手机应答结算了挂起问询");
		assert.ok(sse.chunks.some((chunk) => chunk.includes("question/resolved")), "结算后广播 question/resolved 帧");

		// ② 审批：同一降级语义
		nextCalled = false;
		const approval = harness.fire("approval/request", {
			agent: { session: { id: "s-t21a" } }, toolName: "bash", callId: "c1", reason: "T21 probe",
		}, () => { nextCalled = true; });
		assert.ok(approval instanceof Promise, "审批瀑布被手机独占接管");
		const approvalOutcome = approval.then((value) => ({ settled: true, value }), (error) => ({ settled: false, code: error?.code ?? error?.name }));
		await tick();
		assert.equal(nextCalled, false, "审批同样不放行内核转发");
		const approvalFrame = frameOf(sse, "approval/requested");
		assert.ok(approvalFrame, "手机收到 approval/requested 帧");
		assert.equal(approvalFrame.toolName, "bash");

		const approved = await postJson(harness.route, {
			kind: "approval",
			rpcId: approvalFrame.rpcId,
			sessionId: "s-t21a",
			outcome: "allowed-once",
		});
		assert.equal(approved.status, 200);
		assert.deepEqual(approved.body, { ok: true, accepted: true });
		assert.deepEqual(await approvalOutcome, { settled: true, value: "allowed-once" }, "手机应答结算了挂起审批");
		assert.ok(sse.chunks.some((chunk) => chunk.includes("approval/resolved")), "结算后广播 approval/resolved 帧");
	} finally {
		harness.clean();
	}
});

test("T21-C approvalMode=both 且结算通路缺失：非交互主链路照常（/history 200、事件桥仍下发、挂起交互不阻塞）", async () => {
	const infos = [];
	const logger = { warn() {}, info: (message) => infos.push(String(message)) };
	const sessions = {
		get: (sessionId) => sessionId === "s-main"
			? { events: [{ seq: 1, type: "user/message", data: { id: "m1", content: [{ type: "text", text: "主链路" }] } }] }
			: undefined,
	};
	const harness = createHarness({
		get: (name) => name === "typertGateway"
			? brokenSettlementGateway()
			: name === "sessions" ? sessions : undefined,
		logger,
	}, CONFIG);
	try {
		assert.ok(await until(() => infos.some((line) => line.includes("$events 双端呈现就绪"))), "$events 事件桥已就绪");
		const sse = sseConnect(harness.route);

		// ① 非交互路由（会话历史）照常 200 —— 双端呈现降级不影响主链路
		const history = await getRoute(harness.route, `${CONFIG.path}/api/history?sessionId=s-main`);
		assert.equal(history.statusCode, 200);
		const historyBody = JSON.parse(history.chunks.at(-1));
		assert.equal(historyBody.ok, true);
		assert.equal(historyBody.sessionId, "s-main");
		assert.equal(historyBody.events.length, 1);
		assert.equal(historyBody.events[0].type, "user/message");

		// ② 事件桥仍向手机下发帧
		harness.fire("session/event", { id: "s-main" }, { type: "session/title", data: { title: "主链路" } });
		await tick();
		assert.ok(sse.chunks.some((chunk) => chunk.includes("session/event")), "SSE 事件桥仍下发帧");

		// ③ 挂起的问询（手机独占接管中）不阻塞主链路：同刻 /history 仍 200、帧仍下发
		let nextCalled = false;
		const pending = harness.fire("user-questions/request", {
			agent: { session: { id: "s-main" } },
			questions: [{ id: "q1", question: "继续？", options: [{ label: "A" }] }],
		}, () => { nextCalled = true; });
		assert.ok(pending instanceof Promise, "问询被手机接管");
		const outcome = pending.then((value) => ({ settled: true, value }), (error) => ({ settled: false, code: error?.code ?? error?.name }));
		await tick();
		assert.equal(nextCalled, false, "接管期间不放行内核转发");

		const duringHold = await getRoute(harness.route, `${CONFIG.path}/api/history?sessionId=s-main`);
		assert.equal(duringHold.statusCode, 200, "问询挂起期间主链路仍可用");
		const framesBefore = sse.chunks.filter((chunk) => chunk.includes("session/event")).length;
		harness.fire("session/event", { id: "s-main" }, { type: "session/title", data: { title: "仍在线" } });
		await tick();
		assert.ok(sse.chunks.filter((chunk) => chunk.includes("session/event")).length > framesBefore, "挂起期间事件桥仍下发帧");

		// 收尾：手机应答，避免留下挂起瀑布
		const questionFrame = frameOf(sse, "question/requested");
		const answered = await postJson(harness.route, {
			kind: "question",
			rpcId: questionFrame.rpcId,
			sessionId: "s-main",
			answers: [{ id: "q1", selected: ["A"] }],
		});
		assert.equal(answered.status, 200);
		assert.deepEqual(await outcome, { settled: true, value: { answers: [{ id: "q1", selected: ["A"] }] } });
	} finally {
		harness.clean();
	}
});
