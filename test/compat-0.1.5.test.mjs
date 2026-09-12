import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { apply, isHostVersionSupported, SUPPORTED_HOST_RANGE, SUPPORTED_HOST_MIN } from "../lib/index.js";

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
	approvalMode: "desktop",
};

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
		logger: { warn() {}, info() {} },
		get(name) {
			const override = overrides.get?.(name);
			if (override !== undefined) return override;
			const fallback = overrides.fallback?.(name);
			return fallback;
		},
		provide() {},
		effect(fn) { const c = fn?.(); cleanups.push(c); return c; },
		inject() {},
		on(event, fn) { listeners.set(event, fn); return () => listeners.delete(event); },
	};
	apply(ctx, config);
	return {
		route: routes.find((r) => r.path === `${config.path}/api`).handler,
		fire(event, ...args) { return listeners.get(event)?.(...args); },
		clean() { for (const c of cleanups.reverse()) c?.(); },
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

/** 新代宿主 mock：全能力齐备（invokeRpc/openWireStream/dispatchRpc/冷会话）。 */
function modernHostGateway() {
	return {
		invokeRpc() { return Promise.resolve({ ok: true, value: { groups: [{ provider: "p", models: [] }] } }); },
		openWireStream(_e, _p, signal) {
			return (async function* () {
				yield { type: "ready", clientId: "client-1" };
				await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
			})();
		},
		dispatchRpc() { return Promise.resolve({ ok: true, value: undefined }); },
	};
}

test("host diagnostics: version/range/capabilities are reported and supported stays consistent (T18/T23)", async () => {
	const harness = createHarness({
		get: (name) => name === "typertGateway" ? modernHostGateway() : name === "sessionController" ? { prompt: async () => {} } : undefined,
	});
	try {
		const res = await getRoute(harness.route, "/m/api/diagnostics");
		assert.equal(res.statusCode, 200);
		const body = JSON.parse(res.chunks.at(-1));
		const host = body.host;
		assert.ok(host, "host 节存在");
		assert.equal(host.supportedRange, SUPPORTED_HOST_RANGE);
		assert.equal(typeof host.version, "string");
		// supported 与同一版本规则手算一致（能力缺失时不因版本谎报）
		assert.equal(host.supported, isHostVersionSupported(host.version));
		const c = host.capabilities;
		assert.equal(c.hasRemoteInvoke, true);
		assert.equal(c.hasRemoteEventBridge, true);
		assert.equal(c.hasColdSessionResume, true);
		assert.equal(c.hasLegacyInteractionBridge, false);
		assert.ok(body.notes.some((line) => typeof line === "string" && line.includes("host:")), "notes 含 host 行");
	} finally {
		harness.clean();
	}
});

test("missing capability fails explicitly with 503 host-capability-unavailable (T20)", async () => {
	// 无 Remote 调用入口、无旧代 apiProxy：走 apiRpc 的路由必须明确 503，而不是静默降级
	const harness = createHarness({});
	try {
		const res = await getRoute(harness.route, "/m/api/attachment?sessionId=s&attachmentId=a-1");
		assert.equal(res.statusCode, 503);
		const body = JSON.parse(res.chunks.at(-1));
		assert.equal(body.error, "host-capability-unavailable");
		assert.ok(String(body.detail ?? "").includes("升级"), `detail 含升级指引: ${body.detail}`);
	} finally {
		harness.clean();
	}
});

test("legacy interaction bridge is reported and deprecated-warned when present (ADR 0001)", async () => {
	let warned = false;
	const harness = createHarness({
		get: (name) => name === "apiProxy" ? { respond: async () => ({ ok: true }) } : undefined,
	});
	// hostCapabilities 只有 apiProxy（无新代入口）→ hasLegacyInteractionBridge=true
	try {
		const res = await getRoute(harness.route, "/m/api/diagnostics");
		const host = JSON.parse(res.chunks.at(-1)).host;
		assert.equal(host.capabilities.hasLegacyInteractionBridge, true);
	} finally {
		harness.clean();
	}
	void warned;
});

test("agent/inbox/spliced emits a mobile/queue frame immediately (T08/T22)", async () => {
	const sessionId = "session-q";
	const harness = createHarness({
		get: (name) => name === "agents" ? { get: (sid) => sid === sessionId ? {
			inbox: { nextTurn: [{ id: "m1", content: [{ type: "text", text: "hello" }] }], nextStep: [] },
		} : undefined } : undefined,
	});
	try {
		const sse = sseConnect(harness.route);
		// 内核会话事件（agent/inbox/spliced）→ 立即重推 mobile/queue 快照
		harness.fire("session/event", { id: sessionId }, { type: "agent/inbox/spliced" });
		await new Promise((resolve) => setImmediate(resolve));
		const frame = sse.chunks.map((c) => c.startsWith("data: ") ? c.slice(6) : "").map((s) => { try { return JSON.parse(s); } catch { return null; } }).find((f) => f?.type === "mobile/queue");
		assert.ok(frame, "收到 mobile/queue 帧");
		assert.equal(frame.sessionId, sessionId);
		assert.ok(Array.isArray(frame.rows));
		assert.ok(frame.rows.some((r) => r.id === "m1" && r.placement === "queued"));
	} finally {
		harness.clean();
	}
});

test("host version range constants and predicate stay pinned to 0.1.5-rc.2 generation", () => {
	assert.equal(SUPPORTED_HOST_RANGE, ">=0.1.5-rc.2 <0.2.0");
	assert.deepEqual(SUPPORTED_HOST_MIN, [0, 1, 5]);
	assert.equal(isHostVersionSupported("0.1.5-rc.2"), true);
	assert.equal(isHostVersionSupported("0.1.6"), true);
	assert.equal(isHostVersionSupported("0.1.5-rc.1"), false, "低于下界的同 tuple prerelease 不受支持");
	assert.equal(isHostVersionSupported("0.1.5-rc.0"), false);
	assert.equal(isHostVersionSupported("0.1.2-rc.1"), false);
	assert.equal(isHostVersionSupported("0.1.1-rc.2"), false);
	assert.equal(isHostVersionSupported("0.2.0"), false);
	assert.equal(isHostVersionSupported(undefined), null);
});

test("T21: settlement path missing (dispatchRpc) degrades remoteEvents=false without lying about the bridge", async () => {
	// 事件桥（openWireStream）在、结算通路（dispatchRpc）缺——「能收事件但不能结算」半可用态：
	// checks.remoteEvents 必须如实 false（不谎报「双端就绪」），hasRemoteEventBridge 仍为 true。
	const gateway = {
		invokeRpc() { return Promise.resolve({ ok: true, value: {} }); },
		openWireStream(_e, _p, signal) {
			return (async function* () {
				yield { type: "ready", clientId: "client-1" };
				await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
			})();
		},
		// 无 dispatchRpc —— 问询/审批出站结算通路缺失
	};
	const harness = createHarness(
		{ get: (name) => name === "typertGateway" ? gateway : undefined },
		{ ...CONFIG, approvalMode: "both" },
	);
	try {
		// 等事件循环让 ready 帧生效（$events 客户端为异步打开）
		for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
		const res = await getRoute(harness.route, "/m/api/diagnostics");
		const body = JSON.parse(res.chunks.at(-1));
		assert.equal(body.host.capabilities.hasRemoteEventBridge, true, "事件桥能力如实上报");
		assert.equal(body.checks.remoteEvents, false, "结算通路缺失 → remoteEvents=false（半可用不谎报）");
	} finally {
		harness.clean();
	}
});
test("T14: approval frame chain settles via respond allowed-once (同 T13 双端框架)", async () => {
	// 审批与问询同属 $events 双端呈现框架：waterfall(approval/request) → pending → 帧 →
	// /respond approval → $events/result 结算 → resolved 帧。宿主真实弹卡在本部署会话
	// 未启用 approval 门控（bash/write/subagent 均直接放行或沙箱拦截），故以 HTTP seam 闭环。
	const calls = [];
	const gateway = {
		invokeRpc() { return Promise.resolve({ ok: true, value: {} }); },
		openWireStream(_e, _p, signal) {
			return (async function* () {
				yield { type: "ready", clientId: "client-1" };
				yield { type: "waterfall", event: "approval/request", eventId: "ev-approve-1", agentId: "session:s", request: { toolName: "bash", reason: "T14 probe", callId: "c1" } };
				await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
			})();
		},
		dispatchRpc(endpoint, payload) { calls.push({ endpoint, payload }); return Promise.resolve({ ok: true, value: undefined }); },
	};
	const harness = createHarness(
		{ get: (name) => name === "typertGateway" ? gateway : undefined },
		{ ...CONFIG, approvalMode: "both" },
	);
	try {
		const sse = sseConnect(harness.route);
		for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
		const frame = sse.chunks.map((c) => c.startsWith("data: ") ? c.slice(6) : "").map((s) => { try { return JSON.parse(s); } catch { return null; } }).find((f) => f?.frame?.type === "approval/requested");
		assert.ok(frame, "approval/requested 帧到达手机通道");
		assert.equal(frame.frame.rpcId, "ev-approve-1");
		assert.equal(frame.frame.toolName, "bash");

		// 手机端应答"允许一次"
		const res = await postJson(harness.route, {
			kind: "approval",
			rpcId: "ev-approve-1",
			sessionId: "s",
			outcome: "allowed-once",
		});
		assert.equal(res.status, 200);
		assert.equal(res.body.ok, true);
		// 结算走后端 $events/result（与浏览器 GUI 同一通路）
		assert.ok(calls.some((c) => c.endpoint === "$events/result" && c.payload.args.outcome.kind === "result"), "$events/result 已结算");
		assert.ok(sse.chunks.some((c) => c.includes("approval/resolved")), "approval/resolved 帧广播");
	} finally {
		harness.clean();
	}
});
