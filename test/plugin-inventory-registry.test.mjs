// issue #153：安装源（registry）只读投影 + 校验 + 透传 + 逐项源归因。
//
// 契约要点：
//   - `GET /plugin-inventory/registries` 只读（writable:false 恒 false）；老宿主无
//     `registries()` → **HTTP 200** + supported:false（不是 404/500）；
//   - 凭据安全：带 username/password/query/fragment 的条目**整条丢弃**（不是脱敏回显）；
//   - `validateRegistryUrl` 只管校验与规范化，`detail` 只给类别、不回显原文；
//   - `versions`/`install`/`update` 的 `registry` 只影响本次解析，**不持久化**；
//   - 逐项源归因：不静默换源（requestedRegistry / answeredRegistry / attempts）。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let apply;
let testHome;
test.before(async () => {
	testHome = await mkdtemp(join(tmpdir(), "dsh-mobile-plugin-registry-"));
	process.env.HOME = testHome;
	({ apply } = await import("../lib/index.js"));
});
test.after(async () => { await rm(testHome, { recursive: true, force: true }); });

const CONFIG = {
	path: "/m", authToken: "1234567890123456", cookieName: "dsh_mobile_token", trustedHosts: [],
	sessionTtlMs: 60_000, rechargeUrl: "https://example.test/top-up", maxConnections: 4,
	warmUpOnStart: false, pushUrls: [], pushCooldownMs: 1, doneGraceMs: 1, pushContent: "minimal",
	rateLimit: {}, lanBridge: { enabled: false, port: 3080, host: "127.0.0.1" }, approvalMode: "mobile",
};

class FakeResponse extends EventEmitter {
	constructor() { super(); this.headersSent = false; this.chunks = []; }
	writeHead(statusCode, headers) { this.statusCode = statusCode; this.headers = headers; this.headersSent = true; }
	write(chunk) { this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)); return true; }
	end(chunk = "") { if (chunk !== "") this.chunks.push(String(chunk)); this.writableEnded = true; this.emit("finish"); }
	destroy() { this.destroyed = true; this.emit("close"); }
}
class FakeRequest extends EventEmitter {
	constructor(url, method = "GET", body) {
		super(); this.url = url; this.method = method; this.body = body;
		this.headers = {
			host: "127.0.0.1",
			"x-mobile-token": CONFIG.authToken,
			"content-type": "application/json",
			...(body === undefined ? {} : { "content-length": String(Buffer.byteLength(JSON.stringify(body))) }),
		};
		this.socket = { remoteAddress: "127.0.0.1" }; this.complete = true; this.readable = true; this.destroyed = false;
	}
	on(event, handler) {
		if (event === "data" && this.body !== undefined) setImmediate(() => handler(Buffer.from(JSON.stringify(this.body))));
		if (event === "end") setImmediate(() => handler());
		return this;
	}
	pause() {}
}

function createHarness({ pluginManager, pluginInventory } = {}) {
	const routes = [];
	const handlers = [];
	const provided = new Map([["sessions", { get: () => undefined, list: () => [] }]]);
	if (pluginManager !== undefined) provided.set("pluginManager", pluginManager);
	if (pluginInventory !== undefined) provided.set("pluginInventory", pluginInventory);
	const ctx = {
		webServer: { host: "127.0.0.1", port: 43160, register(spec) { routes.push(spec); return () => {}; } },
		logger: { warn() {}, info() {} },
		get(name) { return provided.get(name); },
		provide(name, value) { provided.set(name, value); },
		on(event, handler) { handlers.push([event, handler]); return () => {}; },
		effect(callback) { const d = callback?.(); return typeof d === "function" ? d : () => {}; },
		inject() {},
	};
	const dispose = apply(ctx, CONFIG);
	return { route: routes.find((r) => r.path === "/m/api").handler, handlers, clean() { dispose?.(); } };
}

async function call(route, url, { method = "GET", body } = {}) {
	const req = new FakeRequest(url, method, body);
	const res = new FakeResponse();
	const finished = new Promise((resolve) => res.once("finish", resolve));
	route(req, res);
	await finished;
	const raw = res.chunks.join("");
	let parsed;
	try { parsed = JSON.parse(raw); } catch { parsed = raw; }
	return { status: res.statusCode, body: parsed };
}

const registryHarness = (registries) => createHarness({
	pluginManager: {
		async listBundles() { return []; },
		...typeof registries === "function" ? { registries } : typeof registries === "object" ? { async registries() { return registries; } } : {},
	},
	pluginInventory: { async list() { return { entries: [] }; } },
});

const bundle = (name, overrides = {}) => ({
	name, version: "1.0.0", enabled: true, official: false, availability: "profile",
	installed: true, optional: false, removable: true, rows: [], overrides: [], ...overrides,
});
const catalog = (name, version = "1.0.0") => bundle(name, {
	installed: false, availability: "missing", version, installTarget: { spec: `${name}@${version}`, version },
});

async function waitOp(route, opId) {
	for (let i = 0; i < 100; i++) {
		const res = await call(route, `/m/api/plugin-inventory/op?opId=${encodeURIComponent(opId)}`);
		if (res.body?.operation?.status !== "running") return res.body.operation;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error("operation did not settle");
}

// ── GET /plugin-inventory/registries ────────────────────────────

test("registries：宿主给出首选/回退/pnpm 源 → 只读、不可写、带 display", async () => {
	const h = registryHarness({
		registry: "https://registry.npmjs.org",
		fallbackRegistries: ["https://registry.npmmirror.com/"],
		resolved: "https://registry.npmjs.org/",
	});
	try {
		const { status, body } = await call(h.route, "/m/api/plugin-inventory/registries");
		assert.equal(status, 200);
		assert.equal(body.ok, true);
		assert.equal(body.supported, true);
		assert.equal(body.writable, false, "本端点永不声明可写");
		assert.equal(body.complete, true);
		const roles = body.registries.map((r) => r.role);
		assert.deepEqual(roles, ["primary", "fallback"]);
		// 规范化：末尾补斜杠（与宿主 normalizeRegistry 幂等）。
		assert.equal(body.registries[0].url, "https://registry.npmjs.org/");
		assert.equal(body.registries[0].display, "registry.npmjs.org/");
		assert.equal(body.registries[1].url, "https://registry.npmmirror.com/");
		for (const entry of body.registries) {
			assert.deepEqual(Object.keys(entry).sort(), ["display", "id", "kind", "role", "url"]);
		}
	} finally { h.clean(); }
});

test("registries：老宿主无 registries()/抛错 → HTTP 200 + supported:false（不是 404/500）", async () => {
	const legacy = registryHarness(undefined);
	try {
		const { status, body } = await call(legacy.route, "/m/api/plugin-inventory/registries");
		assert.equal(status, 200);
		assert.equal(body.supported, false);
		assert.equal(body.reason, "host-registry-unavailable");
		assert.deepEqual(body.registries, []);
		assert.equal(body.writable, false);
	} finally { legacy.clean(); }

	for (const [name, fn] of [
		["抛错", async () => { throw new Error("boom /home/secret"); }],
		["返回非对象", async () => "nope"],
	]) {
		const h = registryHarness(fn);
		try {
			const { status, body } = await call(h.route, "/m/api/plugin-inventory/registries");
			assert.equal(status, 200, name);
			assert.equal(body.supported, false, name);
			assert.equal(JSON.stringify(body).includes("/home/secret"), false, `${name}: 不泄露内部错误`);
		} finally { h.clean(); }
	}
});

test("registries：带凭据/query/fragment 的条目整条丢弃（不是脱敏回显）；支持 localhost/私网", async () => {
	const h = registryHarness({
		registry: "https://user:pass@npm.internal.test/",
		fallbackRegistries: [
			"http://127.0.0.1:4873/",
			"http://192.168.1.9:8081/repository/npm/",
			"https://registry.npmjs.org/?token=abc",
			"https://registry.npmjs.org/#frag",
		],
	});
	try {
		const { status, body } = await call(h.route, "/m/api/plugin-inventory/registries");
		assert.equal(status, 200);
		assert.equal(body.supported, true);
		assert.equal(body.complete, false);
		assert.equal(body.reason, "registry-entries-dropped");
		// 首选（带凭据）整条丢弃 → 只剩两个合法私网回退源。
		assert.deepEqual(body.registries.map((r) => r.url), [
			"http://127.0.0.1:4873/",
			"http://192.168.1.9:8081/repository/npm/",
		]);
		const text = JSON.stringify(body);
		assert.equal(text.includes("user"), false, "不得回显用户名");
		assert.equal(text.includes("pass"), false, "不得回显密码");
		assert.equal(text.includes("token=abc"), false, "不得回显 query");
		assert.equal(text.includes("frag"), false, "不得回显 fragment");
	} finally { h.clean(); }
});

test("registries：registry 为 null（只由 pnpm 配置决定）→ 用 resolved 作信息性 source，不冒充首选", async () => {
	const h = registryHarness({ registry: null, fallbackRegistries: [], resolved: "https://npm.corp.test/" });
	try {
		const { body } = await call(h.route, "/m/api/plugin-inventory/registries");
		assert.equal(body.supported, true);
		assert.equal(body.registries.length, 1);
		assert.equal(body.registries[0].role, "resolved");
		assert.equal(body.registries[0].kind, "pnpm");
		assert.equal(body.registries[0].url, "https://npm.corp.test/");
	} finally { h.clean(); }
});

test("registries：方法约束（POST → 405；HEAD → 200 无 body）", async () => {
	const h = registryHarness({ registry: "https://registry.npmjs.org/", fallbackRegistries: [] });
	try {
		assert.equal((await call(h.route, "/m/api/plugin-inventory/registries", { method: "POST" })).status, 405);
		const head = await call(h.route, "/m/api/plugin-inventory/registries", { method: "HEAD" });
		assert.equal(head.status, 200);
		assert.equal(head.body, "");
	} finally { h.clean(); }
});

// ── validateRegistryUrl 契约（经端点观察，detail 只给类别）────────

test("registry 校验：非法输入一律 400 registry-invalid，detail 只给类别、不回显原文", async () => {
	const h = createHarness({
		pluginManager: { async listBundles() { return [catalog("dsh-new")]; } },
		pluginInventory: { async list() { return { entries: [] }; } },
	});
	try {
		const cases = [
			["file:///tmp/registry", "unsupported-protocol"],
			["data:text/plain,hi", "unsupported-protocol"],
			["git+ssh://git@example.test/repo.git", "unsupported-protocol"],
			["ftp://example.test/", "unsupported-protocol"],
			["/var/lib/registry", "unparsable"],
			["registry.npmjs.org", "unparsable"],
			["", "empty"],
			["https://user:pw@example.test/", "has-credentials"],
			["https://example.test/?q=1", "has-query"],
			["https://example.test/#frag", "has-fragment"],
			["https://exa mple.test/", "whitespace"],
			[`https://example.test/${"a".repeat(2100)}`, "too-long"],
		];
		for (const [registry, detail] of cases) {
			const res = await call(h.route, "/m/api/plugin-inventory/install", { method: "POST", body: { name: "dsh-new", registry } });
			assert.equal(res.status, 400, `${registry} 应被拒绝`);
			assert.equal(res.body.error, "registry-invalid", registry);
			assert.equal(res.body.detail, detail, `${registry} 的类别应可归因`);
			// detail 只给类别：原文（尤其凭据）不得出现在响应里。
			assert.equal(JSON.stringify(res.body).includes("user:pw"), false, "不得回显凭据");
		}
		// 非字符串（数字/对象/布尔）同样拒绝，不抛异常。
		for (const registry of [123, { url: "https://example.test/" }, true]) {
			const res = await call(h.route, "/m/api/plugin-inventory/install", { method: "POST", body: { name: "dsh-new", registry } });
			assert.equal(res.status, 400);
			assert.equal(res.body.detail, "not-string");
		}
	} finally { h.clean(); }
});

test("registry 规范化：末尾补斜杠后透传（与宿主 normalizeRegistry 幂等）", async () => {
	let received;
	const h = createHarness({
		pluginManager: {
			async listBundles() { return [catalog("dsh-new", "2.0.0")]; },
			async installBundle(spec, options) {
				received = { spec, options };
				return { application: "applied", changed: true, version: "2.0.0", stage: "install", target: spec, registries: [options.registry] };
			},
		},
		pluginInventory: { async list() { return { entries: [] }; } },
	});
	try {
		const started = await call(h.route, "/m/api/plugin-inventory/install", {
			method: "POST",
			body: { name: "dsh-new", registry: "https://npm.internal.test/npm" },
		});
		assert.equal(started.status, 200);
		await waitOp(h.route, started.body.operation.opId);
		assert.equal(received.spec, "dsh-new@2.0.0", "spec 仍由宿主 installTarget 决定");
		assert.equal(received.options.registry, "https://npm.internal.test/npm/");
	} finally { h.clean(); }
});

test("install 未传 registry：不向宿主塞 registry 选项（沿用宿主自己的解析顺序）", async () => {
	let options;
	const h = createHarness({
		pluginManager: {
			async listBundles() { return [catalog("dsh-new")]; },
			async installBundle(spec, opts) { options = opts; return { application: "applied", changed: true, version: "1.0.0", stage: "install", target: spec }; },
		},
		pluginInventory: { async list() { return { entries: [] }; } },
	});
	try {
		const started = await call(h.route, "/m/api/plugin-inventory/install", { method: "POST", body: { name: "dsh-new" } });
		await waitOp(h.route, started.body.operation.opId);
		assert.equal("registry" in options, false);
		assert.equal(options.saveExact, true, "installBundle 选项是 saveExact（不是 exact）");
	} finally { h.clean(); }
});

test("versions：registry 透传 + requestedRegistry/answeredRegistry/attempts 归因", async () => {
	const asked = [];
	const h = createHarness({
		pluginManager: {
			async listBundles() { return [bundle("dsh-up", { update: "registry" })]; },
			async listVersions(name, options) {
				asked.push({ name, options });
				return {
					status: "listed",
					installed: "1.0.0",
					registry: "https://npm.internal.test/",
					attempts: [
						{ registry: "https://npm.internal.test/", problem: "network" },
						{ registry: "https://registry.npmjs.org/", problem: "" },
					],
					versions: [{ version: "1.2.0", tags: [], prerelease: false, bundle: true }],
					omitted: 0,
				};
			},
		},
		pluginInventory: { async list() { return { entries: [] }; } },
	});
	try {
		const res = await call(h.route, "/m/api/plugin-inventory/versions?name=dsh-up&registry=" + encodeURIComponent("https://npm.internal.test"));
		assert.equal(res.status, 200);
		assert.equal(asked[0].options.registry, "https://npm.internal.test/");
		assert.equal(res.body.requestedRegistry, "https://npm.internal.test/");
		assert.equal(res.body.answeredRegistry, "https://npm.internal.test/");
		assert.deepEqual(res.body.attempts, [
			{ registry: "https://npm.internal.test/", problem: "network" },
			{ registry: "https://registry.npmjs.org/", problem: "" },
		]);
	} finally { h.clean(); }

	// 不传 registry：requestedRegistry 为 null（不伪装成“用了默认源”）。
	let noOptions;
	const h2 = createHarness({
		pluginManager: {
			async listBundles() { return [bundle("dsh-up", { update: "registry" })]; },
			async listVersions(name, options) {
				noOptions = options;
				return { status: "listed", installed: "1.0.0", registry: "https://registry.npmjs.org/", attempts: [{ registry: "https://registry.npmjs.org/" }], versions: [] };
			},
		},
		pluginInventory: { async list() { return { entries: [] }; } },
	});
	try {
		const res = await call(h2.route, "/m/api/plugin-inventory/versions?name=dsh-up");
		assert.equal(res.status, 200);
		assert.equal(noOptions, undefined);
		assert.equal(res.body.requestedRegistry, null);
		assert.equal(res.body.answeredRegistry, "https://registry.npmjs.org/");
	} finally { h2.clean(); }
});

test("versions：refused 也带归因；非法 registry 在询问宿主前就 400", async () => {
	let called = 0;
	const h = createHarness({
		pluginManager: {
			async listBundles() { return [bundle("dsh-up", { update: "registry" })]; },
			async listVersions() {
				called += 1;
				return { status: "refused", problem: "network", reason: "offline", attempts: [{ registry: "https://x.test/", problem: "network" }] };
			},
		},
		pluginInventory: { async list() { return { entries: [] }; } },
	});
	try {
		const refused = await call(h.route, "/m/api/plugin-inventory/versions?name=dsh-up");
		assert.equal(refused.status, 200);
		assert.equal(refused.body.status, "refused");
		assert.equal(refused.body.attempts.length, 1);
		assert.equal(called, 1);
		const invalid = await call(h.route, "/m/api/plugin-inventory/versions?name=dsh-up&registry=" + encodeURIComponent("file:///tmp/x"));
		assert.equal(invalid.status, 400);
		assert.equal(invalid.body.error, "registry-invalid");
		assert.equal(called, 1, "非法 registry 不得询问宿主");
	} finally { h.clean(); }
});

test("update：registry 透传（否则“检查到的版本装不上”）；非法 registry 400", async () => {
	let received;
	const h = createHarness({
		pluginManager: {
			async listBundles() { return [bundle("dsh-up", { update: "registry" })]; },
			async updateBundle(name, version, options) {
				received = { name, version, options };
				return { from: "1.0.0", to: version, step: "install", result: { application: "applied", changed: true, version, stage: "install", target: `${name}@${version}`, registries: [options.registry] } };
			},
		},
		pluginInventory: { async list() { return { entries: [] }; } },
	});
	try {
		const started = await call(h.route, "/m/api/plugin-inventory/update", {
			method: "POST",
			body: { name: "dsh-up", version: "1.1.0", registry: "https://npm.internal.test" },
		});
		assert.equal(started.status, 200);
		const done = await waitOp(h.route, started.body.operation.opId);
		assert.equal(done.status, "succeeded");
		assert.equal(received.options.registry, "https://npm.internal.test/");
		assert.equal(typeof received.options.requestId, "string");
		// 操作快照带源归因。
		assert.deepEqual(done.registries, ["https://npm.internal.test/"]);
		assert.equal(done.answeredRegistry, "https://npm.internal.test/");
		const invalid = await call(h.route, "/m/api/plugin-inventory/update", {
			method: "POST",
			body: { name: "dsh-up", version: "1.1.0", registry: "https://u:p@x.test/" },
		});
		assert.equal(invalid.status, 400);
		assert.equal(invalid.body.detail, "has-credentials");
	} finally { h.clean(); }
});

test("install 操作快照：registries/attempt/answeredRegistry 逐项归因；失败不声称“是它答的”", async () => {
	const h = createHarness({
		pluginManager: {
			async listBundles() { return [catalog("dsh-new", "2.0.0")]; },
			async installBundle(spec, options) {
				const state = h.handlers.find(([event]) => event === "plugin-manager/install-state")?.[1];
				// 宿主逐次尝试：第一次网络失败，第二次成功。
				state?.({ requestId: options.requestId, phase: "installing", attempt: { registry: "https://a.test/", index: 1, total: 2 } });
				state?.({ requestId: options.requestId, phase: "installing", attempt: { registry: "https://b.test/", index: 2, total: 2 } });
				return { application: "applied", changed: true, version: "2.0.0", stage: "install", target: spec, registries: ["https://a.test/", "https://b.test/"] };
			},
		},
		pluginInventory: { async list() { return { entries: [] }; } },
	});
	try {
		const started = await call(h.route, "/m/api/plugin-inventory/install", { method: "POST", body: { name: "dsh-new" } });
		const done = await waitOp(h.route, started.body.operation.opId);
		assert.equal(done.status, "succeeded");
		assert.deepEqual(done.registries, ["https://a.test/", "https://b.test/"]);
		assert.deepEqual(done.attempt, { index: 2, total: 2 });
		assert.equal(done.answeredRegistry, "https://b.test/");
	} finally { h.clean(); }

	// 失败：registries 记录问过的源，但 answeredRegistry 必须留空（不能说“它答了”）。
	const failing = createHarness({
		pluginManager: {
			async listBundles() { return [catalog("dsh-bad")]; },
			async installBundle(spec) {
				return { application: "failed", changed: false, error: { code: "operation-error" }, stage: "install", target: spec, registries: ["https://a.test/"] };
			},
		},
		pluginInventory: { async list() { return { entries: [] }; } },
	});
	try {
		const started = await call(failing.route, "/m/api/plugin-inventory/install", { method: "POST", body: { name: "dsh-bad" } });
		const done = await waitOp(failing.route, started.body.operation.opId);
		assert.equal(done.status, "failed");
		assert.deepEqual(done.registries, ["https://a.test/"]);
		assert.equal(done.answeredRegistry, null);
	} finally { failing.clean(); }
});

test("卸载/启停：源归因字段恒为空（不借用安装的源信息）", async () => {
	const h = createHarness({
		pluginManager: {
			async listBundles() { return [bundle("dsh-remove", { removable: true }), bundle("dsh-toggle", { update: "registry" })]; },
			async removeBundle(name) { return { application: "applied", changed: true, stage: "remove", target: name, registries: ["https://a.test/"] }; },
			async setBundleEnabled(name) { return { application: "applied", changed: true, stage: "enable", target: name, enabled: true }; },
		},
		pluginInventory: { async list() { return { entries: [] }; } },
	});
	try {
		const removed = await call(h.route, "/m/api/plugin-inventory/uninstall", { method: "POST", body: { name: "dsh-remove" } });
		const removeDone = await waitOp(h.route, removed.body.operation.opId);
		assert.deepEqual(removeDone.registries, []);
		assert.equal(removeDone.answeredRegistry, null);
		assert.equal(removeDone.attempt, null);
		const toggled = await call(h.route, "/m/api/plugin-inventory/toggle", { method: "POST", body: { name: "dsh-toggle", enabled: true } });
		const toggleDone = await waitOp(h.route, toggled.body.operation.opId);
		assert.deepEqual(toggleDone.registries, []);
		assert.equal(toggleDone.answeredRegistry, null);
	} finally { h.clean(); }
});

test("带凭据的宿主 registry 不会通过 ops/versions 泄露", async () => {
	const h = createHarness({
		pluginManager: {
			async listBundles() { return [catalog("dsh-new")]; },
			async installBundle(spec) {
				return {
					application: "applied", changed: true, version: "1.0.0", stage: "install", target: spec,
					registries: ["https://svc:pw@npm.internal.test/", "https://registry.npmjs.org/"],
				};
			},
		},
		pluginInventory: { async list() { return { entries: [] }; } },
	});
	try {
		const started = await call(h.route, "/m/api/plugin-inventory/install", { method: "POST", body: { name: "dsh-new" } });
		const done = await waitOp(h.route, started.body.operation.opId);
		const text = JSON.stringify(done);
		assert.equal(text.includes("svc:pw"), false, "带凭据的条目必须整条丢弃");
		assert.equal(text.includes("pw@"), false);
		assert.deepEqual(done.registries, ["https://registry.npmjs.org/"]);
	} finally { h.clean(); }
});
