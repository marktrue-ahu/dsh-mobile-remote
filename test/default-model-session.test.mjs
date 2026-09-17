import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { apply } from "../lib/index.js";

// Issue #14 回归：不带 model 建会话（POST /sessions）时的默认模型来源。
//
// 缺陷背景：旧实现只读 readSessionConfig(sessionId) —— 那是**新建会话自己**的
// session.control 投影，全新会话必然为空 → 恒定落到 400 no-model-available，
// 且文案把「读不到」误报成「未配置」。默认模型的正确来源是内核的
// `agentDefaultModel` 服务（currentSelection()：没有会话级选择时的默认模型）。
// 本文件断言三件事：
//   A：服务在 → 真的被咨询，且经 apiRpc 把默认 provider/model/effort 绑到新会话（不再 400）；
//   B/D/E：服务缺失 / currentSelection 抛错（旧宿主兼容与防御路径）→ 不崩，仍按老语义 400；
//   C：显式传 model 的老路径一字不改（不咨询默认服务、不读投影）。
// 复用 test/compat-0.1.5.test.mjs 的 harness 形态（fake req/res + 路由抓取 + 事件 fire）。

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

const SESSIONS_PATH = "/m/api/sessions";

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

async function postJson(route, body = {}, path = "/m/api/respond") {
	const req = new FakeRequest(path, "POST");
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

/**
 * 宿主 mock：agents 记录 create 实参、agentPresets 提供默认预设、
 * typertGateway 记录 apiRpc 出站调用、agentDefaultModel 以 currentSelection 提供默认模型。
 * defaultSelection === undefined 表示**服务缺失**（旧宿主）；selectionThrows 模拟服务异常。
 */
function createFakes({ defaultSelection, selectionThrows = false } = {}) {
	const state = { createCalls: [], disposeCount: 0, rpcCalls: [], streamCalls: 0, selectionReads: 0 };
	const agents = {
		async create(options) {
			state.createCalls.push(options);
			return {
				agent: {
					id: `agent:${options.sessionId}`,
					session: { id: options.sessionId, header: { createdAt: Date.now(), cwd: options.meta?.cwd ?? process.cwd() }, snapshotEvents: () => [] },
				},
				async dispose() { state.disposeCount++; },
			};
		},
		list: () => [],
	};
	const agentPresets = {
		defaultId: "mobile-default",
		async resolve(id) { return { id }; },
		async mount() {},
	};
	const gateway = {
		async invokeRpc(endpoint, payload) {
			state.rpcCalls.push({ endpoint, args: payload?.args });
			return { ok: true, value: undefined };
		},
		stream() {
			state.streamCalls++;
			// 全新会话的 session.control 投影为空（无首帧）—— 与真实内核一致，也是旧 bug 的前提
			return (async function* () {})();
		},
	};
	const defaultModelService = defaultSelection === undefined ? undefined : {
		currentSelection() {
			state.selectionReads++;
			if (selectionThrows) throw new Error("agentDefaultModel 服务异常");
			return defaultSelection;
		},
	};
	return { state, agents, agentPresets, gateway, defaultModelService };
}

const overridesFor = (fakes) => ({
	get: (name) =>
		name === "agents" ? fakes.agents
			: name === "agentPresets" ? fakes.agentPresets
				: name === "typertGateway" ? fakes.gateway
					: name === "agentDefaultModel" ? fakes.defaultModelService
						: undefined,
});

const selectModelCall = (state) => state.rpcCalls.find((c) => c.endpoint === "session/selectModel");

test("A(#14): 不带 model 建会话 → 咨询 agentDefaultModel 并绑定其 provider/model/effort", async (t) => {
	const fakes = createFakes({ defaultSelection: { provider: "p-x", model: "m-y", reasoningEffort: "high" } });
	const harness = createHarness(overridesFor(fakes));
	try {
		const res = await postJson(harness.route, { cwd: "/tmp/dsh-fix" }, SESSIONS_PATH);
		assert.equal(res.status, 200, `应成功建会话（实收 ${JSON.stringify(res.body)}）`);
		assert.equal(res.body.ok, true);
		assert.equal(Object.hasOwn(res.body, "error"), false);
		assert.notEqual(res.body.error, "no-model-available", "默认模型可得时不得再报 no-model-available");
		assert.equal(typeof res.body.sessionId, "string");
		assert.equal(res.body.preset, "mobile-default");

		// 修复点：默认模型服务确实被咨询（旧实现只读新会话自己的空投影，此计数恒为 0）
		assert.ok(fakes.state.selectionReads >= 1, "必须调用 ctx.get('agentDefaultModel').currentSelection()");

		// 绑定的就是默认服务的 provider/model/effort（经 @Remote 网关同一通路）
		const select = selectModelCall(fakes.state);
		assert.ok(select, "必须经 apiRpc 调用 session.selectModel");
		assert.deepEqual(select.args, {
			request: { sessionId: res.body.sessionId, provider: "p-x", model: "m-y", reasoningEffort: "high" },
		});
		// 未显式传 model：agentOptions 不带 model（绑定统一走 RPC，与修复前一致）
		assert.deepEqual(fakes.state.createCalls[0].agentOptions, {});
		t.diagnostic(`A session.selectModel 实收：${JSON.stringify(select.args)}`);
	} finally {
		harness.clean();
	}
});

test("B(#14 旧宿主兼容): agentDefaultModel 服务缺失 → 不崩，仍按老语义 400 no-model-available", async () => {
	const fakes = createFakes({}); // defaultSelection === undefined → ctx.get("agentDefaultModel") 返回 undefined
	const harness = createHarness(overridesFor(fakes));
	try {
		const res = await postJson(harness.route, { cwd: "/tmp/dsh-fix" }, SESSIONS_PATH);
		// 服务缺失不得把兼容性修复变成新的兼容问题：请求被正常处理并明确报错
		assert.equal(res.status, 400, `服务缺失时必须明确 400（实收 ${JSON.stringify(res.body)}）`);
		assert.equal(res.body.error, "no-model-available");
		assert.equal(fakes.state.selectionReads, 0, "服务不存在时没有可咨询的对象");
		assert.equal(selectModelCall(fakes.state), undefined, "无默认模型 → 不得绑定模型");
		assert.equal(fakes.state.disposeCount, 1, "必须用 handle.dispose 正式拆除会话（不留孤儿会话）");
	} finally {
		harness.clean();
	}
});

test("C(#14): 显式传 model 的老路径保持不变（不咨询默认服务、不读会话投影）", async () => {
	const fakes = createFakes({ defaultSelection: { provider: "p-default", model: "m-default", reasoningEffort: "high" } });
	const harness = createHarness(overridesFor(fakes));
	try {
		const res = await postJson(harness.route, { cwd: "/tmp/dsh-fix", model: "m-explicit", reasoningEffort: "low" }, SESSIONS_PATH);
		assert.equal(res.status, 200, `显式 model 应成功（实收 ${JSON.stringify(res.body)}）`);
		assert.equal(res.body.ok, true);
		// provider 未显式给出时仍是历史的 deepseek-official 兜底
		const select = selectModelCall(fakes.state);
		assert.ok(select, "显式 model 也走 session.selectModel");
		assert.deepEqual(select.args, {
			request: { sessionId: res.body.sessionId, provider: "deepseek-official", model: "m-explicit", reasoningEffort: "low" },
		});
		assert.equal(fakes.state.selectionReads, 0, "显式路径不得改道去咨询默认模型服务");
		assert.equal(fakes.state.streamCalls, 0, "显式路径不读 session.control 投影（修复前行为）");
		assert.deepEqual(fakes.state.createCalls[0].agentOptions, { model: "m-explicit" });
	} finally {
		harness.clean();
	}
});

test("D(#14): 只给 provider 不给 model → provider 取请求、model 取默认服务，effort 请求优先", async () => {
	const fakes = createFakes({ defaultSelection: { provider: "p-default", model: "m-default", reasoningEffort: "high" } });
	const harness = createHarness(overridesFor(fakes));
	try {
		const res = await postJson(harness.route, { cwd: "/tmp/dsh-fix", provider: "p-body", reasoningEffort: "low" }, SESSIONS_PATH);
		assert.equal(res.status, 200, `应成功建会话（实收 ${JSON.stringify(res.body)}）`);
		const select = selectModelCall(fakes.state);
		assert.deepEqual(select.args, {
			// 优先级：请求 provider > 默认服务 provider；model 取默认服务；effort 请求 > 默认服务
			request: { sessionId: res.body.sessionId, provider: "p-body", model: "m-default", reasoningEffort: "low" },
		});
		assert.deepEqual(fakes.state.createCalls[0].agentOptions, { provider: "p-body" });
	} finally {
		harness.clean();
	}
});

test("E(#14 防御): currentSelection 抛异常 → 不崩，按无默认模型处理并拆除会话", async () => {
	const fakes = createFakes({ defaultSelection: { provider: "p-x", model: "m-y" }, selectionThrows: true });
	const harness = createHarness(overridesFor(fakes));
	try {
		const res = await postJson(harness.route, { cwd: "/tmp/dsh-fix" }, SESSIONS_PATH);
		assert.equal(res.status, 400, `服务异常必须被吞掉并明确报错（实收 ${JSON.stringify(res.body)}）`);
		assert.equal(res.body.error, "no-model-available");
		assert.equal(fakes.state.disposeCount, 1);
		assert.equal(selectModelCall(fakes.state), undefined);
	} finally {
		harness.clean();
	}
});

test("F(#14): currentSelection 返回空值 → 不回退到空 model，明确 400", async () => {
	const fakes = createFakes({ defaultSelection: null }); // 服务在，但当前没有默认选择
	const harness = createHarness(overridesFor(fakes));
	try {
		const res = await postJson(harness.route, { cwd: "/tmp/dsh-fix" }, SESSIONS_PATH);
		assert.equal(res.status, 400);
		assert.equal(res.body.error, "no-model-available");
		assert.equal(selectModelCall(fakes.state), undefined, "不得用空字符串 model 去绑定");
		assert.equal(fakes.state.disposeCount, 1);
	} finally {
		harness.clean();
	}
});
