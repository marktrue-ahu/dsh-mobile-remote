/**
 * 宿主代际兼容回归测试（v3.1.6 / issue #19 / ADR 0017）。
 *
 * 为什么需要**两代宿主夹具**：本次四处宿主接口不兼容的共同形态是
 * "服务仍然存在、调用也不报错、但语义已经变了"（能力语义漂移）。
 * 既有极简假 ctx 只能表达"服务在不在"，**表达不了**这一形态——所以那套夹具
 * 对本次的四处问题一处也测不出来。
 *
 * 关键约束：本仓只对 **0.2.x 做真实宿主端到端验证**（本机宿主即 0.2.x），
 * 0.1.x 那条分支**永远不会被真实宿主执行到**。因此本文件的 legacy 部分是
 * 0.1.x 路径的**唯一保护**：它必须让分支真的被执行，而不是只断言参数形状——
 * `settings.get` 那类故障是被 try/catch 吞掉的，形状断言挡不住。
 *
 * 夹具按**真实签名**复刻两代差异（含形参个数——插件正是按 `.length` 判别事件流参数位次的）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
	apply,
	jobsNeedsSessionId,
	jobsCallerFor,
	readSettingsSection,
	wireStreamTakesControl,
	capabilityState,
} from "../lib/index.js";

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
	lanBridge: { enabled: false, port: 3080, host: "127.0.0.1" },
	approvalMode: "both",
};

class FakeResponse extends EventEmitter {
	constructor() {
		super();
		this.headersSent = false;
		this.chunks = [];
	}
	writeHead(statusCode) {
		this.statusCode = statusCode;
		this.headersSent = true;
	}
	write(chunk) {
		this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
		return true;
	}
	end(chunk = "") {
		if (chunk !== "") this.chunks.push(String(chunk));
		this.emit("finish");
	}
	destroy() {
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

async function call(route, { url, method = "GET", body } = {}) {
	const req = new FakeRequest(url, method);
	const res = new FakeResponse();
	const finished = new Promise((resolve) => res.once("finish", resolve));
	route(req, res);
	if (body !== undefined) {
		queueMicrotask(() => {
			req.emit("data", Buffer.from(JSON.stringify(body), "utf8"));
			req.emit("end");
		});
	}
	await finished;
	return { status: res.statusCode, body: JSON.parse(res.chunks.join("") || "{}") };
}

const AGENT = { id: "session-A", session: { id: "session-A", header: { cwd: "/tmp/proj" } }, status: "idle" };

/**
 * 两代宿主夹具。`generation` 决定四处差异的**真实形状**。
 * 所有发往宿主的调用都被记录，断言只针对"插件传出去的东西"与"端点返回的东西"——
 * 不触碰插件内部实现。
 */
function createHarness({ generation }) {
	const modern = generation === "0.2.0";
	const routes = [];
	const provided = new Map();
	const logs = { warn: [], info: [] };
	const seen = {
		jobsList: [], jobsKill: [], settingsGet: [], settingsDescribe: 0,
		eventsSubscribe: [], wireStreamArgs: [], legacyJobCallbacks: 0,
	};

	// ── 任务服务：0.1.x 收 Agent 对象 + 两个回调；0.2.x 收 SessionId 字符串 + 统一事件流 ──
	const jobs = {
		list(caller) { seen.jobsList.push(caller); return []; },
		kill(id, caller, reason) { seen.jobsKill.push({ id, caller, reason }); return "requested"; },
	};
	if (modern) {
		jobs.events = {
			subscribe(filter, listener) { seen.eventsSubscribe.push({ filter, listener }); return () => {}; },
		};
	} else {
		jobs.onJobsChanged = (cb) => { seen.legacyJobCallbacks += 1; return () => {}; };
		jobs.onJobDone = (cb) => { seen.legacyJobCallbacks += 1; return () => {}; };
	}

	// ── 设置服务：0.1.x 有 get(ns)；0.2.x 只有 describe() ──
	const settings = modern
		? { describe() { seen.settingsDescribe += 1; return [{ ns: "providers", value: { baseURL: "https://x.test" } }]; } }
		: { get(ns) { seen.settingsGet.push(ns); return { baseURL: "https://x.test" }; } };

	// ── 事件流：形参个数即代际（插件按 .length 判别信号位次）──
	// 流必须**保持打开**直到 signal 中止：真实 $events 流不会自行结束。若让生成器直接结束，
	// 插件会（正确地）按"断开"处理并进入退避重连——那是另一条路径，会让测试挂着定时器。
	const holdOpenUntilAborted = (signal) => new Promise((resolve) => {
		if (!signal || signal.aborted) return resolve();
		signal.addEventListener("abort", () => resolve(), { once: true });
	});
	const gateway = {
		async invokeRpc() { return { ok: true, value: {} }; },
		async dispatchRpc() { return { ok: true, value: undefined }; },
	};
	if (modern) {
		// 0.2.0 真实签名：signal 是第 5 个形参
		gateway.openWireStream = async function openWireStream(endpoint, payload, uplink, peer, signal, control) {
			seen.wireStreamArgs.push({ endpoint, payload, uplink, peer, signal, control });
			return (async function* ready_() { yield { type: "ready", clientId: "c-1" }; await holdOpenUntilAborted(signal); })();
		};
	} else {
		// 0.1.x 真实签名：signal 是第 3 个形参
		gateway.openWireStream = async function openWireStream(endpoint, payload, signal) {
			seen.wireStreamArgs.push({ endpoint, payload, signal });
			return (async function* ready_() { yield { type: "ready", clientId: "c-1" }; await holdOpenUntilAborted(signal); })();
		};
	}

	// ── 私有成员：两代都提供，但插件必须能识别"缺失" ──
	const permissionPresets = {
		names: ["read-only", "accept-edits"],
		presets: { "accept-edits": { name: "Accept Edits", description: "接受编辑" } },
		apply() { return undefined; },
	};
	const workspaceRegistry = {
		archivedSessionIds: [],
		list: () => [{ id: "ws-1", path: "/tmp/proj", title: "proj", sessionIds: [] }],
		enqueueOperation: async (fn) => fn(),
		requireState: () => ({ archivedSessionIds: [] }),
		setState: async () => undefined,
	};

	provided.set("agents", { get: (id) => (id === "session-A" ? AGENT : undefined), list: () => [AGENT], roots: () => [AGENT] });
	provided.set("sessions", { get: (id) => (id === "session-A" ? { id: "session-A", header: { cwd: "/tmp/proj" } } : undefined), list: () => [{ id: "session-A", header: { cwd: "/tmp/proj" } }] });
	provided.set("jobs", jobs);
	provided.set("settings", settings);
	provided.set("typertGateway", gateway);
	provided.set("permissionPresets", permissionPresets);
	provided.set("workspaceRegistry", workspaceRegistry);
	provided.set("llm", {
		// 必须返回**至少一个带 settingsNs 的可配置提供商**，否则 /llm-providers 根本不会去读设置，
		// 设置读取的两条分支就都不会被执行到（这正是"夹具没驱动到分支"的陷阱）。
		listProviders: () => [],
		listConfigurableProviders: () => [{ provider: "deepseek-official", displayName: "DeepSeek", settingsNs: "providers", settingsPath: [] }],
		listModels: async () => [],
	});
	provided.set("approval", { setPolicy() {}, current: () => "accept-edits" });
	provided.set("credentials", { describe: () => [], resolve: () => undefined });
	provided.set("commands", { list: () => [] });

	const ctx = {
		webServer: { host: "127.0.0.1", port: 43120, register(spec) { routes.push(spec); return () => {}; } },
		logger: { warn: (m) => logs.warn.push(String(m)), info: (m) => logs.info.push(String(m)) },
		get(name) { return provided.get(name); },
		provide(name, value) { provided.set(name, value); },
		on() { return () => {}; },
		effect(callback) {
			const disposer = callback?.();
			return typeof disposer === "function" ? disposer : () => {};
		},
		inject() {},
		waterfall: async () => "unavailable",
	};
	const dispose = apply(ctx, CONFIG);
	const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	return {
		route: routes.find((route) => route.path === "/m/api").handler,
		seen, logs, provided, wait,
		clean() { dispose?.(); },
	};
}

// ───────────────────── 1. 纯谓词（判别器本身） ─────────────────────

test("jobsNeedsSessionId：按事件流存在性判别任务服务的代际", () => {
	assert.equal(jobsNeedsSessionId({ events: { subscribe() {} } }), true);
	assert.equal(jobsNeedsSessionId({ onJobsChanged() {}, onJobDone() {} }), false);
	assert.equal(jobsNeedsSessionId(undefined), false);
});

test("jobsCallerFor：0.2.x 给 SessionId 字符串，0.1.x 给 Agent 对象", () => {
	const modern = { events: { subscribe() {} } };
	const legacy = { onJobsChanged() {} };
	assert.equal(jobsCallerFor(modern, AGENT, "session-A"), "session-A");
	assert.equal(jobsCallerFor(legacy, AGENT, "session-A"), AGENT);
	// caller 缺失时两代都传 undefined（不是 "undefined" 字符串）
	assert.equal(jobsCallerFor(modern, undefined, undefined), undefined);
	assert.equal(jobsCallerFor(legacy, undefined, undefined), undefined);
	// 有 agent 但没有显式 sessionId 时，从 agent 推出 id（并去掉 session: 前缀）
	assert.equal(jobsCallerFor(modern, { id: "session-B" }, undefined), "session-B");
	assert.equal(jobsCallerFor(modern, { id: "session:session-C" }, undefined), "session-C");
});

test("readSettingsSection：0.2.x 走 describe 取 value，0.1.x 走 get", () => {
	const legacy = { get: (ns) => ({ ns, from: "get" }) };
	assert.deepEqual(readSettingsSection(legacy, "providers"), { ns: "providers", from: "get" });

	const modern = { describe: () => [{ ns: "providers", value: { from: "describe" } }, { ns: "other", value: 1 }] };
	assert.deepEqual(readSettingsSection(modern, "providers"), { from: "describe" });
	// 描述符里没有该命名空间 → undefined（调用方按"无此配置"处理，不得抛错）
	assert.equal(readSettingsSection(modern, "absent"), undefined);
	// 宿主读设置时抛错 → 吞掉并返回 undefined，不拖垮调用方
	assert.equal(readSettingsSection({ get: () => { throw new Error("boom"); } }, "providers"), undefined);
	// 两代特征都没有 → undefined
	assert.equal(readSettingsSection({}, "providers"), undefined);
});

test("wireStreamTakesControl：按形参个数判别取消信号位次", () => {
	const legacy = { openWireStream: function (endpoint, payload, signal) {} };
	const modern = { openWireStream: function (endpoint, payload, uplink, peer, signal, control) {} };
	assert.equal(wireStreamTakesControl(legacy), false);
	assert.equal(wireStreamTakesControl(modern), true);
	assert.equal(wireStreamTakesControl({}), false);
});

test("capabilityState：三态（ok / drift / missing）", () => {
	assert.equal(capabilityState(undefined, () => true), "missing");
	assert.equal(capabilityState({ list() {} }, (s) => typeof s.list === "function"), "ok");
	assert.equal(capabilityState({}, (s) => typeof s.list === "function"), "drift");
	// 判定谓词自身抛错也归为 drift（形状不符预期）
	assert.equal(capabilityState({}, () => { throw new Error("x"); }), "drift");
});

// ───────────────────── 2. 0.2.x 宿主（本机真实代际） ─────────────────────

test("0.2.x：/jobs 传给宿主的是 SessionId 字符串（不是 Agent 对象）", async () => {
	const h = createHarness({ generation: "0.2.0" });
	try {
		const res = await call(h.route, { url: "/m/api/jobs?sessionId=session-A" });
		assert.equal(res.status, 200);
		assert.equal(h.seen.jobsList.length, 1);
		assert.equal(typeof h.seen.jobsList[0], "string", "0.2.x 必须传字符串，传对象会恒返回空");
		assert.equal(h.seen.jobsList[0], "session-A");
	} finally { h.clean(); }
});

test("0.2.x：/jobs/kill 传给宿主的是 SessionId 字符串", async () => {
	const h = createHarness({ generation: "0.2.0" });
	try {
		const res = await call(h.route, { url: "/m/api/jobs/kill", method: "POST", body: { jobId: "j-1", sessionId: "session-A" } });
		assert.equal(res.status, 200);
		assert.equal(h.seen.jobsKill.length, 1);
		assert.equal(typeof h.seen.jobsKill[0].caller, "string", "0.2.x 传对象会报'任务属于另一个会话'");
		assert.equal(h.seen.jobsKill[0].caller, "session-A");
	} finally { h.clean(); }
});

test("0.2.x：任务事件走统一的 events.subscribe，而不是已移除的两个旧回调", async () => {
	const h = createHarness({ generation: "0.2.0" });
	try {
		await h.wait(30);
		assert.equal(h.seen.eventsSubscribe.length, 1, "应恰好订阅一次（一个 {owners:'all'} 覆盖两种旧回调）");
		assert.deepEqual(h.seen.eventsSubscribe[0].filter, { owners: "all" });
		assert.equal(typeof h.seen.eventsSubscribe[0].listener, "function");
		assert.equal(h.seen.legacyJobCallbacks, 0);
	} finally { h.clean(); }
});

test("0.2.x：事件流的取消信号落在第 5 位（传错位会让通道永远不就绪）", async () => {
	const h = createHarness({ generation: "0.2.0" });
	try {
		await h.wait(30);
		assert.equal(h.seen.wireStreamArgs.length, 1);
		const args = h.seen.wireStreamArgs[0];
		assert.equal(args.endpoint, "$events");
		assert.ok(args.signal instanceof AbortSignal, "signal 必须真的传进去；为 undefined 时宿主会在 AbortSignal.any 抛错");
		assert.equal(args.uplink, undefined, "第 3 位必须是 uplink（0.2.x 语义），不能把信号塞在这里");
	} finally { h.clean(); }
});

test("0.2.x：设置读取走 describe()，不调用已移除的 get()", async () => {
	const h = createHarness({ generation: "0.2.0" });
	try {
		const res = await call(h.route, { url: "/m/api/llm-providers" });
		assert.equal(res.status, 200);
		assert.ok(h.seen.settingsDescribe > 0, "0.2.x 必须走 describe()");
		assert.equal(h.seen.settingsGet.length, 0, "0.2.x 没有 get()，不应调用");
	} finally { h.clean(); }
});

// ───────────────────── 3. 0.1.x 宿主（真实宿主验不到，靠夹具保护） ─────────────────────

test("0.1.x：/jobs 传给宿主的是 Agent 对象（旧代实现内部取其 .id）", async () => {
	const h = createHarness({ generation: "0.1.5" });
	try {
		const res = await call(h.route, { url: "/m/api/jobs?sessionId=session-A" });
		assert.equal(res.status, 200);
		assert.equal(h.seen.jobsList.length, 1);
		assert.equal(typeof h.seen.jobsList[0], "object", "0.1.x 必须传 Agent 对象；传字符串会被解析成 undefined");
		assert.equal(h.seen.jobsList[0]?.id, "session-A");
	} finally { h.clean(); }
});

test("0.1.x：任务事件仍走两个旧回调（新 API 不存在时不得静默不订阅）", async () => {
	const h = createHarness({ generation: "0.1.5" });
	try {
		await h.wait(30);
		assert.equal(h.seen.legacyJobCallbacks, 2, "onJobsChanged 与 onJobDone 都应被注册");
		assert.equal(h.seen.eventsSubscribe.length, 0);
	} finally { h.clean(); }
});

test("0.1.x：事件流的取消信号落在第 3 位", async () => {
	const h = createHarness({ generation: "0.1.5" });
	try {
		await h.wait(30);
		assert.equal(h.seen.wireStreamArgs.length, 1);
		assert.ok(h.seen.wireStreamArgs[0].signal instanceof AbortSignal, "0.1.x 的 signal 是第 3 个形参");
	} finally { h.clean(); }
});

test("0.1.x：设置读取走 get()", async () => {
	const h = createHarness({ generation: "0.1.5" });
	try {
		const res = await call(h.route, { url: "/m/api/llm-providers" });
		assert.equal(res.status, 200);
		assert.ok(h.seen.settingsGet.length > 0, "0.1.x 必须走 get()");
		assert.equal(h.seen.settingsDescribe, 0);
	} finally { h.clean(); }
});

// ───────────────────── 4. 诊断三态报告（ADR 0017 的硬要求） ─────────────────────

test("诊断：两代都报告宿主能力三态与实际代际选择", async () => {
	for (const generation of ["0.1.5", "0.2.0"]) {
		const h = createHarness({ generation });
		try {
			const res = await call(h.route, { url: "/m/api/diagnostics" });
			assert.equal(res.status, 200);
			const caps = res.body.checks?.hostCapabilities;
			assert.ok(caps && typeof caps === "object", `${generation} 应报告 hostCapabilities`);
			for (const key of ["jobs.callerShape", "jobs.eventsApi", "settings.read", "gateway.wireStream", "permissionPresets.apply", "workspaceRegistry.stateWrite"]) {
				assert.equal(caps[key], "ok", `${generation} 的 ${key} 应为 ok（两代都合法）`);
			}
			const gen = res.body.checks?.hostGeneration;
			assert.equal(gen.jobsCaller, generation === "0.2.0" ? "sessionId" : "agent");
			assert.equal(gen.settingsRead, generation === "0.2.0" ? "describe" : "get");
			assert.equal(gen.wireStreamArgs, generation === "0.2.0" ? "controlArg" : "legacyArg");
		} finally { h.clean(); }
	}
});

test("诊断：私有成员缺失时报 drift 并给出可执行原因（不静默）", async () => {
	const h = createHarness({ generation: "0.2.0" });
	try {
		// 模拟"服务在、但插件要用的私有成员没了"——这正是能力语义漂移的形态
		h.provided.set("permissionPresets", { names: ["read-only"] }); // 无 apply
		h.provided.set("workspaceRegistry", { list: () => [] }); // 无 enqueueOperation/requireState/setState
		const res = await call(h.route, { url: "/m/api/diagnostics" });
		assert.equal(res.status, 200);
		assert.equal(res.body.checks.hostCapabilities["permissionPresets.apply"], "drift");
		assert.equal(res.body.checks.hostCapabilities["workspaceRegistry.stateWrite"], "drift");
		const notes = res.body.notes ?? [];
		assert.ok(notes.some((n) => String(n).includes("宿主能力非全绿")), "降级必须出现在 notes 里，而不只是状态值");
	} finally { h.clean(); }
});

// ───────────────────── 5. apiProxy 死代码清除后的行为 ─────────────────────

test("/respond：待办不在本地清单时返回 404 并说明真实原因（不再归咎于'内核过旧'）", async () => {
	const h = createHarness({ generation: "0.2.0" });
	try {
		const res = await call(h.route, {
			url: "/m/api/respond",
			method: "POST",
			body: { rpcId: "rpc-does-not-exist", kind: "approval", sessionId: "session-A", approvalId: "a-1", outcome: "allow" },
		});
		assert.equal(res.status, 404);
		assert.equal(res.body.error, "respond-not-pending");
		assert.ok(!String(res.body.detail ?? "").includes("apiProxy"), "错误原因不得再提已移除的 apiProxy");
	} finally { h.clean(); }
});
