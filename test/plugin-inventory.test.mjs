// issue #145：插件清单/健康只读端点。
//
// 事实必须来自宿主 pluginManager.listBundles()（版本/来源/启停/错误）与
// pluginInventory.list()（运行期 fiber）；旧宿主缺能力时 supported=false，不伪造清单；
// 端点不提供任何写操作。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let apply;
let testHome;

test.before(async () => {
	testHome = await mkdtemp(join(tmpdir(), "dsh-mobile-plugin-inventory-"));
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
	constructor(url, method = "GET") {
		super(); this.url = url; this.method = method;
		this.headers = { host: "127.0.0.1", "x-mobile-token": CONFIG.authToken };
		this.socket = { remoteAddress: "127.0.0.1" }; this.complete = true; this.readable = true; this.destroyed = false;
	}
	on() { return this; } pause() {}
}

function createHarness({ pluginManager, pluginInventory, sessions } = {}) {
	const routes = [];
	const provided = new Map([
		["sessions", sessions ?? { get: () => undefined, list: () => [] }],
	]);
	if (pluginManager !== undefined) provided.set("pluginManager", pluginManager);
	if (pluginInventory !== undefined) provided.set("pluginInventory", pluginInventory);
	const ctx = {
		webServer: { host: "127.0.0.1", port: 43130, register(spec) { routes.push(spec); return () => {}; } },
		logger: { warn() {}, info() {} },
		get(name) { return provided.get(name); },
		provide(name, value) { provided.set(name, value); },
		on() { return () => {}; },
		effect(callback) { const d = callback?.(); return typeof d === "function" ? d : () => {}; },
		inject() {},
	};
	const dispose = apply(ctx, CONFIG);
	return { route: routes.find((r) => r.path === "/m/api").handler, clean() { dispose?.(); } };
}

async function call(route, url = "/m/api/plugin-inventory", method = "GET") {
	const req = new FakeRequest(url, method);
	const res = new FakeResponse();
	const finished = new Promise((resolve) => res.once("finish", resolve));
	route(req, res);
	await finished;
	const raw = res.chunks.join("");
	let body;
	try { body = JSON.parse(raw); } catch { body = raw; }
	return { status: res.statusCode, body, headers: res.headers };
}

const bundle = (name, overrides = {}) => ({
	name, version: "1.2.3", enabled: true, official: false, availability: "profile",
	installed: true, optional: false, removable: true, rows: [], overrides: [], ...overrides,
});

test("已安装清单：版本/来源/启停/健康/兼容与当前连接标记来自宿主事实", async () => {
	const pluginManager = {
		calls: [],
		async listBundles() {
			this.calls.push("listBundles");
			return [
				bundle("@marktrue/dsh-mobile-remote", {
					version: "3.3.0", official: true, availability: "installation", rows: [{ rowId: "mobile-remote", moduleName: "@marktrue/dsh-mobile-remote", entryId: "entry-mobile" }],
					meta: { title: { zh: "移动端", en: "Mobile Remote" } },
				}),
				bundle("dsh-extra", { version: "2.0.0", source: "github:foo/bar#0123456789012345678901234567890123456789", enabled: false }),
				bundle("dsh-bad", { version: "0.1.0", rows: [{ rowId: "bad", moduleName: "dsh-bad", entryId: "entry-bad" }], error: { code: "incompatible-version", incompatible: [{ name: "dsh-bad", version: "0.1.0", runtimeVersion: "0.2.2", requirements: { "engines.dsh": ">=0.3.0" } }] } }),
			];
		},
		async updateBundle() { throw new Error("read-only endpoint must not call updateBundle"); },
	};
	const pluginInventory = {
		async list() { return { managementAvailable: true, entries: [
			{ entryId: "entry-mobile", moduleName: "@marktrue/dsh-mobile-remote", enabled: true, fiberPhase: "active" },
			{ entryId: "entry-bad", moduleName: "dsh-bad", enabled: true, fiberPhase: "failed", diagnostic: "/home/secret path" },
		] }; },
	};
	const h = createHarness({ pluginManager, pluginInventory });
	try {
		const { status, body } = await call(h.route);
		assert.equal(status, 200);
		assert.equal(body.supported, true);
		assert.equal(typeof body.host.id, "string");
		assert.equal(body.plugins.length, 3);
		const mobile = body.plugins.find((p) => p.packageName === "@marktrue/dsh-mobile-remote");
		assert.equal(mobile.version, "3.3.0");
		assert.equal(mobile.current, true);
		assert.equal(mobile.enabled, true);
		assert.equal(mobile.health.state, "ok");
		assert.equal(mobile.compatibility.state, "unknown");
		assert.deepEqual(mobile.source, { kind: "builtin", label: "内置" });
		const extra = body.plugins.find((p) => p.packageName === "dsh-extra");
		assert.equal(extra.enabled, false);
		assert.equal(extra.health.state, "disabled");
		assert.deepEqual(extra.source, { kind: "git", label: "Git" });
		const bad = body.plugins.find((p) => p.packageName === "dsh-bad");
		assert.equal(bad.health.state, "failed");
		assert.equal(bad.health.reasonCode, "incompatible-version");
		assert.equal(bad.compatibility.ok, false);
		assert.equal(bad.compatibility.state, "incompatible");
		assert.match(bad.compatibility.requirements, /engines\.dsh/);
		// 只读：没有任何写能力/写动作字段；诊断原文（含本机路径）不外泄。
		for (const p of body.plugins) {
			assert.deepEqual(p.management, { readOnly: true });
			assert.equal("install" in p || "uninstall" in p || "toggle" in p || "restart" in p, false);
		}
		assert.equal(JSON.stringify(body).includes("/home/secret"), false);
		assert.deepEqual(pluginManager.calls, ["listBundles"]);
	} finally { h.clean(); }
});

test("旧宿主/缺能力：supported=false 且不返回伪造清单", async () => {
	const h = createHarness({ pluginManager: { async updateBundle() {} } });
	try {
		const { status, body } = await call(h.route);
		assert.equal(status, 200);
		assert.equal(body.supported, false);
		assert.equal(body.reason, "host-plugin-manager-unavailable");
		assert.deepEqual(body.plugins, []);
	} finally { h.clean(); }
});

test("清单读取失败：稳定 503，不泄露内部错误", async () => {
	const h = createHarness({ pluginManager: { async listBundles() { throw new Error("secret /home/path"); } } });
	try {
		const { status, body } = await call(h.route);
		assert.equal(status, 503);
		assert.equal(body.error, "plugin-inventory-unavailable");
		assert.equal(JSON.stringify(body).includes("/home/path"), false);
	} finally { h.clean(); }
});

test("方法约束与 HEAD：写方法 405，HEAD 无 body", async () => {
	const h = createHarness({ pluginManager: { async listBundles() { return []; } } });
	try {
		const post = await call(h.route, "/m/api/plugin-inventory", "POST");
		assert.equal(post.status, 405);
		const head = await call(h.route, "/m/api/plugin-inventory", "HEAD");
		assert.equal(head.status, 200);
		assert.equal(head.body, "");
	} finally { h.clean(); }
});

const enabledBundle = (name, entryIds) => bundle(name, {
	rows: entryIds.map((entryId, index) => ({ rowId: `${name}-${index}`, moduleName: name, ...(entryId ? { entryId } : {}) })),
});

test("健康事实：缺 pluginInventory 服务/抛错/空 entries/无匹配 → unknown，不得冒充 ok", async () => {
	const cases = [
		{ name: "缺服务", inventory: undefined, expect: "unknown" },
		{ name: "服务抛错", inventory: { async list() { throw new Error("boom"); } }, expect: "unknown" },
		{ name: "空 entries", inventory: { async list() { return { entries: [] }; } }, expect: "unknown" },
		{ name: "rows 无匹配", inventory: { async list() { return { entries: [{ entryId: "other", fiberPhase: "active" }] }; } }, expect: "unknown" },
	];
	for (const item of cases) {
		const h = createHarness({
			pluginManager: { async listBundles() { return [enabledBundle("dsh-a", ["entry-a"])]; } },
			pluginInventory: item.inventory,
		});
		try {
			const { status, body } = await call(h.route);
			assert.equal(status, 200, item.name);
			assert.equal(body.plugins[0].health.state, item.expect, item.name);
			assert.notEqual(body.plugins[0].health.state, "ok", item.name);
		} finally { h.clean(); }
	}
});

test("健康事实：pending/loading/unloading → starting；fiberPhase=null → unknown", async () => {
	const phases = ["pending", "loading", "unloading"];
	for (const phase of phases) {
		const h = createHarness({
			pluginManager: { async listBundles() { return [enabledBundle(`dsh-${phase}`, [`entry-${phase}`])]; } },
			pluginInventory: { async list() { return { entries: [{ entryId: `entry-${phase}`, fiberPhase: phase }] }; } },
		});
		try {
			const { body } = await call(h.route);
			assert.equal(body.plugins[0].health.state, "starting", phase);
		} finally { h.clean(); }
	}

	const h = createHarness({
		pluginManager: { async listBundles() { return [enabledBundle("dsh-null", ["entry-null"])]; } },
		pluginInventory: { async list() { return { entries: [{ entryId: "entry-null", fiberPhase: null }] }; } },
	});
	try {
		const { body } = await call(h.route);
		assert.equal(body.plugins[0].health.state, "unknown");
	} finally { h.clean(); }
});

test("兼容性：无宿主 incompatibility 证据 → unknown；incompatible-version → 明确 false", async () => {
	const h = createHarness({
		pluginManager: {
			async listBundles() {
				return [
					enabledBundle("dsh-ok", ["entry-ok"]),
					enabledBundle("dsh-old", ["entry-old"]),
				];
			},
		},
		pluginInventory: { async list() { return { entries: [{ entryId: "entry-ok", fiberPhase: "active" }, { entryId: "entry-old", fiberPhase: "active" }] }; } },
	});
	try {
		const { body } = await call(h.route);
		assert.equal(body.plugins[0].compatibility.state, "unknown");
		assert.equal(body.plugins[0].compatibility.ok, null);
	} finally { h.clean(); }

	const h2 = createHarness({
		pluginManager: {
			async listBundles() {
				return [bundle("dsh-bad", {
					errors: undefined,
					error: { code: "incompatible-version", incompatible: [{ name: "dsh-bad", version: "0.1.0", runtimeVersion: "0.2.2", requirements: { "engines.dsh": ">=0.3.0" } }] },
					enabled: true,
				})];
			},
		},
	});
	try {
		const { body } = await call(h2.route);
		assert.equal(body.plugins[0].compatibility.state, "incompatible");
		assert.equal(body.plugins[0].compatibility.ok, false);
		assert.match(body.plugins[0].compatibility.requirements, /engines\.dsh/);
	} finally { h2.clean(); }
});

test("完整清单：合并独立 plugin entry；与 bundle 重叠按 entryId/moduleName 去重", async () => {
	const h = createHarness({
		pluginManager: {
			async listBundles() {
				return [
					enabledBundle("dsh-bundle", ["entry-shared"]),
					bundle("dsh-empty-bundle", { rows: [] }),
				];
			},
		},
		pluginInventory: {
			async list() {
				return { entries: [
					{ entryId: "entry-shared", moduleName: "dsh-bundle", enabled: true, fiberPhase: "active" },
					{ entryId: "entry-standalone", moduleName: "dsh-standalone", enabled: true, fiberPhase: "active" },
					{ entryId: "entry-failed", moduleName: "dsh-independent-failed", enabled: true, fiberPhase: "failed", diagnostic: "/home/x" },
				] };
			},
		},
	});
	try {
		const { body } = await call(h.route);
		assert.equal(body.supported, true);
		assert.equal(body.complete, true);
		assert.equal(body.plugins.length, 4);
		const standalone = body.plugins.find((p) => p.packageName === "dsh-standalone");
		assert.equal(standalone.independent, true);
		assert.deepEqual(standalone.source, { kind: "entry", label: "配置条目" });
		assert.equal(standalone.version, "");
		assert.equal(standalone.health.state, "ok");
		assert.equal(body.plugins.filter((p) => p.packageName === "dsh-bundle").length, 1, "共享 entry 不得重复");
		const failedEntry = body.plugins.find((p) => p.packageName === "dsh-independent-failed");
		assert.equal(failedEntry.health.state, "failed");
		assert.equal(failedEntry.compatibility.state, "unknown");
		assert.equal(JSON.stringify(body).includes("/home/x"), false);
	} finally { h.clean(); }
});

test("完整清单：任一侧不可得 → supported=false/degraded，不冒充完整", async () => {
	const bundlesOnly = createHarness({
		pluginManager: { async listBundles() { return [enabledBundle("dsh-b", ["entry-b"])]; } },
		pluginInventory: { async list() { throw new Error("runtime boom"); } },
	});
	try {
		const { status, body } = await call(bundlesOnly.route);
		assert.equal(status, 200);
		assert.equal(body.supported, false);
		assert.equal(body.complete, false);
		assert.equal(body.degraded, true);
		assert.equal(body.reason, "runtime-inventory-unavailable");
		assert.equal(body.plugins.length, 1, "bundle 行仍可作为部分数据");
		assert.equal(body.plugins[0].health.state, "unknown");
	} finally { bundlesOnly.clean(); }

	const entriesOnly = createHarness({
		pluginInventory: { async list() { return { entries: [{ entryId: "entry-only", moduleName: "dsh-only", enabled: true, fiberPhase: "active" }] }; } },
	});
	try {
		const { body } = await call(entriesOnly.route);
		assert.equal(body.supported, false);
		assert.equal(body.reason, "host-plugin-manager-unavailable");
		assert.equal(body.plugins.length, 1);
		assert.equal(body.plugins[0].packageName, "dsh-only");
	} finally { entriesOnly.clean(); }
});

test("完整清单：两侧都成功但为空 → supported=true（合法空清单，不是降级）", async () => {
	const h = createHarness({
		pluginManager: { async listBundles() { return []; } },
		pluginInventory: { async list() { return { entries: [] }; } },
	});
	try {
		const { body } = await call(h.route);
		assert.equal(body.supported, true);
		assert.equal(body.complete, true);
		assert.equal(body.degraded, false);
		assert.deepEqual(body.plugins, []);
	} finally { h.clean(); }
});
