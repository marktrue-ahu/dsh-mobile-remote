import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { apply } from "../lib/index.js";

// Issue #13 回归：模型探测（POST /llm-providers/probe）必须按内核
// LlmModelDiscoveryRequest 契约下发字段 —— { provider?, baseURL?, api?, apiKey? }。
//
// 缺陷背景：旧实现发的是 { baseURL, protocol, credential }。protocol / credential 都不在
// 契约内，而 TS 接口不做运行期校验 → 多余字段被内核静默丢弃：用户填的 Key 根本发不出去，
// 需要鉴权的提供商必然 401（表现成「Key 无效」，实为字段名写错）。
// 本文件用记录参数的 fake llm 服务抓取 discoverModels 的实参，逐字段断言：
//   A：带 apiKey + protocol → 实参含 apiKey / api，且**不含** credential / protocol（回归护栏）；
//   B：不传 apiKey → 实参不含 apiKey（也不含 credential）；
//   C：apiKey 为空白串 → trim 后视为未填 → 实参不含 apiKey；
//   D：不传 protocol → 实参不含 api；
//   E：安全边界（仅允许配置目录声明的命名空间）不因字段改名而失效。
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

const PROBE_PATH = "/m/api/llm-providers/probe";
const NS = "llm-providers.test-provider";

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

/** 记录 discoverModels 实参的 fake llm 服务；listConfigurableProviders 决定合法命名空间。 */
function fakeLlm({ configurable = [{ provider: "test-provider", displayName: "Test", settingsNs: NS }] } = {}) {
	const calls = [];
	const listCalls = [];
	return {
		calls,
		listCalls,
		service: {
			async listConfigurableProviders() {
				listCalls.push(true);
				return configurable;
			},
			async discoverModels(ns, request) {
				calls.push({ ns, request });
				return [{ id: "model-1", name: "Model One" }];
			},
		},
	};
}

test("A(#13): probe 实测下发内核契约字段 apiKey/api，且不含 credential/protocol", async (t) => {
	const llm = fakeLlm();
	const harness = createHarness({ get: (name) => (name === "llm" ? llm.service : undefined) });
	try {
		const baseURL = "https://api.example.test/v1";
		const apiKey = "sk-live-abc123";
		const res = await postJson(harness.route, { settingsNs: NS, baseURL, protocol: "openai-completions", apiKey }, PROBE_PATH);

		assert.equal(res.status, 200, `probe 应成功：${JSON.stringify(res.body)}`);
		assert.equal(res.body.ok, true);
		assert.equal(res.body.fallback, false, "适配器自带探测 → 不走 /models 回退");
		assert.deepEqual(res.body.models, [{ id: "model-1", name: "Model One" }]);

		// 抓到的实参就是修复点：命名空间 + 请求对象
		assert.equal(llm.calls.length, 1, "discoverModels 恰好调用一次");
		const { ns, request } = llm.calls[0];
		assert.equal(ns, NS, "第一实参是 settingsNs");
		assert.equal(request.baseURL, baseURL);
		// 关键断言：内核契约字段
		assert.equal(request.apiKey, apiKey, "用户填的 Key 必须以下发（契约字段 apiKey）");
		assert.equal(request.api, "openai-completions", "协议以下发（契约字段 api，而非 protocol）");
		assert.deepEqual(Object.keys(request).sort(), ["api", "apiKey", "baseURL"], "请求对象只含契约字段");
		// 回归护栏：旧实现的字段名不得出现
		assert.equal(Object.hasOwn(request, "credential"), false, "不得再发 credential（旧实现字段）");
		assert.equal(Object.hasOwn(request, "protocol"), false, "不得再发 protocol（旧实现字段）");

		// 反证：旧形状确实过不了上面的断言（本用例对 #13 有牙齿）
		const legacyShape = { baseURL, protocol: "openai-completions", credential: apiKey };
		assert.throws(() => assert.deepEqual(legacyShape, request), "旧形状必须无法通过本用例");
		assert.equal(Object.hasOwn(legacyShape, "apiKey"), false, "旧形状确实丢掉了 Key");
		t.diagnostic(`A discoverModels 实收：ns=${ns} request=${JSON.stringify(request)}`);
	} finally {
		harness.clean();
	}
});

test("B(#13): 不传 apiKey → 请求对象不含 apiKey（也不含 credential）", async () => {
	const llm = fakeLlm();
	const harness = createHarness({ get: (name) => (name === "llm" ? llm.service : undefined) });
	try {
		const res = await postJson(harness.route, { settingsNs: NS, baseURL: "https://api.example.test/v1" }, PROBE_PATH);
		assert.equal(res.status, 200);
		const { request } = llm.calls[0];
		assert.deepEqual(Object.keys(request).sort(), ["baseURL"], "无 Key/协议时只发 baseURL");
		assert.equal(Object.hasOwn(request, "apiKey"), false, "未填 Key 不得出现 apiKey 字段（下游按缺省处理）");
		assert.equal(Object.hasOwn(request, "credential"), false);
	} finally {
		harness.clean();
	}
});

test("C(#13): apiKey 为空白串 → trim 后视为未填，不出现 apiKey 字段", async () => {
	const llm = fakeLlm();
	const harness = createHarness({ get: (name) => (name === "llm" ? llm.service : undefined) });
	try {
		const res = await postJson(harness.route, { settingsNs: NS, baseURL: "https://api.example.test/v1", apiKey: "   " }, PROBE_PATH);
		assert.equal(res.status, 200);
		const { request } = llm.calls[0];
		assert.equal(Object.hasOwn(request, "apiKey"), false, "空白 Key 不得下发（避免把空凭证当有效凭证）");
		assert.equal(Object.hasOwn(request, "credential"), false);
	} finally {
		harness.clean();
	}
});

test("D(#13): 不传 protocol → 请求对象不含 api；apiKey 仍照常下发", async () => {
	const llm = fakeLlm();
	const harness = createHarness({ get: (name) => (name === "llm" ? llm.service : undefined) });
	try {
		const res = await postJson(harness.route, { settingsNs: NS, baseURL: "https://api.example.test/v1", apiKey: "sk-only-key" }, PROBE_PATH);
		assert.equal(res.status, 200);
		const { request } = llm.calls[0];
		assert.equal(request.apiKey, "sk-only-key");
		assert.equal(Object.hasOwn(request, "api"), false, "未指定协议时不得出现 api 字段");
		assert.equal(Object.hasOwn(request, "protocol"), false);
	} finally {
		harness.clean();
	}
});

test("E(#13): 命名空间白名单护栏不因字段改名而失效（未声明 → 400 且不触发探测）", async () => {
	const llm = fakeLlm();
	const harness = createHarness({ get: (name) => (name === "llm" ? llm.service : undefined) });
	try {
		const res = await postJson(harness.route, { settingsNs: "llm-providers.not-declared", baseURL: "https://api.example.test/v1", apiKey: "sk-x" }, PROBE_PATH);
		assert.equal(res.status, 400);
		assert.equal(res.body.error, "unknown-namespace");
		assert.equal(llm.calls.length, 0, "未声明的命名空间不得触发 discoverModels");
	} finally {
		harness.clean();
	}
});
