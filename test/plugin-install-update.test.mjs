// issue #146：配置渠道安装/升级 + 宿主事务/自动回滚投影。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let apply;
let testHome;
test.before(async () => {
	testHome = await mkdtemp(join(tmpdir(), "dsh-mobile-plugin-install-"));
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
		webServer: { host: "127.0.0.1", port: 43140, register(spec) { routes.push(spec); return () => {}; } },
		logger: { warn() {}, info() {} },
		get(name) { return provided.get(name); },
		provide(name, value) { provided.set(name, value); },
		on(event, handler) { handlers.push([event, handler]); return () => {}; },
		effect(callback) { const d = callback?.(); return typeof d === "function" ? d : () => {}; },
		inject() {},
	};
	const dispose = apply(ctx, CONFIG);
	return {
		route: routes.find((r) => r.path === "/m/api").handler,
		handlers,
		clean() { dispose?.(); },
	};
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

const bundle = (name, overrides = {}) => ({
	name, version: "1.0.0", enabled: true, official: false, availability: "profile",
	installed: true, optional: false, removable: true, rows: [], overrides: [], ...overrides,
});
const catalog = (name, version = "1.0.0") => bundle(name, {
	installed: false, availability: "missing", version, installTarget: { spec: `${name}@${version}`, version },
});

const inventory = (pluginManager) => createHarness({
	pluginManager,
	pluginInventory: { async list() { return { entries: [] }; } },
});

async function waitOp(route, opId) {
	for (let i = 0; i < 100; i++) {
		const res = await call(route, `/m/api/plugin-inventory/op?opId=${encodeURIComponent(opId)}`);
		if (res.body?.operation?.status !== "running") return res.body.operation;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error("operation did not settle");
}

const installable = async (route) => (await call(route, "/m/api/plugin-inventory")).body.installable;

test("清单扩展：安装候选来自宿主 installTarget；已安装 bundle 标记 canUpdate", async () => {
	const h = inventory({ async listBundles() { return [bundle("dsh-installed", { update: "registry" }), catalog("dsh-new", "2.0.0")]; } });
	try {
		const { body } = await call(h.route, "/m/api/plugin-inventory");
		assert.equal(body.installable.length, 1);
		assert.equal(body.installable[0].name, "dsh-new");
		assert.equal(body.installable[0].version, "2.0.0");
		const installed = body.plugins.find((p) => p.packageName === "dsh-installed");
		assert.equal(installed.management.canUpdate, true);
		assert.equal(installed.updateKind, "registry");
	} finally { h.clean(); }
});

test("安装成功：只用宿主 spec，进度事件可见，成功后版本刷新", async () => {
	let calls = 0;
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	const manager = {
		async listBundles() { return [catalog("dsh-new", "2.0.0")]; },
		async installBundle(spec, options) {
			calls += 1;
			assert.equal(spec, "dsh-new@2.0.0", "spec 必须来自宿主 installTarget");
			assert.equal(options.expected.version, "2.0.0");
			assert.equal(typeof options.requestId, "string");
			const state = h.handlers.find(([event]) => event === "plugin-manager/install-state")?.[1];
			state?.({ requestId: options.requestId, phase: "installing" });
			await gate;
			state?.({ requestId: options.requestId, phase: "applying" });
			return { application: "applied", changed: true, version: "2.0.0", stage: "install", target: spec };
		},
	};
	const h = inventory(manager);
	try {
		const started = await call(h.route, "/m/api/plugin-inventory/install", { method: "POST", body: { name: "dsh-new", spec: "evil-package" } });
		assert.equal(started.status, 200);
		assert.equal(started.body.operation.status, "running");
		const opId = started.body.operation.opId;
		const mid = await call(h.route, `/m/api/plugin-inventory/op?opId=${opId}`);
		assert.equal(mid.body.operation.steps.find((s) => s.key === "install").state, "running");
		release();
		const done = await waitOp(h.route, opId);
		assert.equal(done.status, "succeeded");
		assert.equal(done.version, "2.0.0");
		assert.equal(calls, 1);
		assert.equal(done.steps.every((s) => s.state === "done"), true);
	} finally { h.clean(); }
});

test("安装失败：宿主自动回滚在结果中可见；异常逃逸标记结果未知", async () => {
	const h = inventory({
		async listBundles() { return [catalog("dsh-bad")]; },
		async installBundle() {
			return { application: "failed", changed: false, error: { code: "incompatible-version" }, stage: "install", target: "dsh-bad@1.0.0" };
		},
	});
	try {
		const started = await call(h.route, "/m/api/plugin-inventory/install", { method: "POST", body: { name: "dsh-bad" } });
		const done = await waitOp(h.route, started.body.operation.opId);
		assert.equal(done.status, "failed");
		assert.equal(done.errorCode, "incompatible-version");
		assert.equal(done.rolledBack, true);
		assert.equal(done.outcomeUnknown, false);
	} finally { h.clean(); }

	const h2 = inventory({
		async listBundles() { return [catalog("dsh-boom")]; },
		async installBundle() { throw new Error("/home/secret stack"); },
	});
	try {
		const started = await call(h2.route, "/m/api/plugin-inventory/install", { method: "POST", body: { name: "dsh-boom" } });
		const done = await waitOp(h2.route, started.body.operation.opId);
		assert.equal(done.status, "failed");
		assert.equal(done.outcomeUnknown, true);
		assert.equal(JSON.stringify(done).includes("/home/secret"), false);
	} finally { h2.clean(); }
});

test("升级成功/需重启：宿主事务结果透传，不需手工 npm", async () => {
	let received;
	const h = inventory({
		async listBundles() { return [bundle("dsh-up", { update: "registry" })]; },
		async updateBundle(name, version, options) {
			received = { name, version, options };
			return { from: "1.0.0", to: "1.1.0", step: "install", result: { application: "restart-required", changed: true, version: "1.1.0", stage: "install", target: `${name}@${version}` } };
		},
	});
	try {
		const started = await call(h.route, "/m/api/plugin-inventory/update", { method: "POST", body: { name: "dsh-up", version: "1.1.0", spec: "evil" } });
		assert.equal(started.status, 200);
		const done = await waitOp(h.route, started.body.operation.opId);
		assert.equal(done.status, "succeeded");
		assert.equal(done.version, "1.1.0");
		assert.equal(done.restartRequired, true);
		assert.deepEqual({ name: received.name, version: received.version }, { name: "dsh-up", version: "1.1.0" });
		assert.equal(typeof received.options.requestId, "string");
		assert.equal("spec" in received.options, false, "registry 升级不接受 App 传 Git spec");
	} finally { h.clean(); }
});

test("升级失败：已恢复到旧版本 / 恢复失败分别可见；不伪造成功", async () => {
	let restoreMode = "ok";
	const h = inventory({
		async listBundles() { return [bundle("dsh-up", { update: "registry" })]; },
		async updateBundle() {
			return {
				from: "1.0.0", to: "1.1.0", step: "install",
				result: { application: "failed", changed: false, error: { code: "operation-error" }, stage: "install", target: "dsh-up@1.1.0" },
				restore: restoreMode === "ok"
					? { application: "applied", changed: true, version: "1.0.0", stage: "install", target: "dsh-up@1.0.0" }
					: { application: "failed", changed: false, error: { code: "operation-error" }, stage: "install", target: "dsh-up@1.0.0" },
			};
		},
	});
	try {
		const started = await call(h.route, "/m/api/plugin-inventory/update", { method: "POST", body: { name: "dsh-up", version: "1.1.0" } });
		const rolled = await waitOp(h.route, started.body.operation.opId);
		assert.equal(rolled.status, "failed");
		assert.equal(rolled.rolledBack, true);
		assert.equal(rolled.rollbackFailed, false);
		restoreMode = "failed";
		const started2 = await call(h.route, "/m/api/plugin-inventory/update", { method: "POST", body: { name: "dsh-up", version: "1.1.0" } });
		const broken = await waitOp(h.route, started2.body.operation.opId);
		assert.equal(broken.status, "failed");
		assert.equal(broken.rollbackFailed, true);
	} finally { h.clean(); }
});

test("版本检查：只对 registry 可升级 bundle；返回 newer 列表/拒绝原因", async () => {
	const h = inventory({
		async listBundles() { return [bundle("dsh-up", { update: "registry" }), bundle("dsh-git", { update: "git" }), bundle("dsh-fixed")]; },
		async listVersions(name) {
			assert.equal(name, "dsh-up");
			return { status: "listed", installed: "1.0.0", registry: "https://registry.test", attempts: [], omitted: 0, versions: [
				{ version: "1.2.0", tags: ["latest"], prerelease: false, bundle: true },
				{ version: "1.1.0", tags: [], prerelease: false, bundle: true, incompatible: { name, version: "1.1.0", runtimeVersion: "0.2.2", requirements: { "engines.dsh": ">=0.3.0" } } },
			] };
		},
	});
	try {
		const ok = await call(h.route, "/m/api/plugin-inventory/versions?name=dsh-up");
		assert.equal(ok.status, 200);
		assert.equal(ok.body.versions[0].version, "1.2.0");
		assert.match(ok.body.versions[1].incompatible.requirements, /engines\.dsh/);
		assert.equal((await call(h.route, "/m/api/plugin-inventory/versions?name=dsh-git")).status, 409);
		assert.equal((await call(h.route, "/m/api/plugin-inventory/versions?name=nope")).status, 404);
	} finally { h.clean(); }

	const refused = inventory({
		async listBundles() { return [bundle("dsh-up", { update: "registry" })]; },
		async listVersions() { return { status: "refused", problem: "network", reason: "offline", attempts: [] }; },
	});
	try {
		const res = await call(refused.route, "/m/api/plugin-inventory/versions?name=dsh-up");
		assert.equal(res.status, 200);
		assert.equal(res.body.status, "refused");
		assert.equal(res.body.problem, "network");
	} finally { refused.clean(); }
});

test("安装/升级约束与取消：不可安装、非 registry、重复操作、取消链路", async () => {
	let releaseInstall;
	const installGate = new Promise((resolve) => { releaseInstall = resolve; });
	let cancelled = 0;
	const h = inventory({
		async listBundles() { return [catalog("dsh-new"), bundle("dsh-git", { update: "git" })]; },
		async installBundle() { await installGate; return { application: "cancelled", changed: false, stage: "install", target: "dsh-new@1.0.0" }; },
		async cancelInstall(requestId) { cancelled += 1; assert.equal(typeof requestId, "string"); return { status: "cancelled" }; },
	});
	try {
		assert.equal((await call(h.route, "/m/api/plugin-inventory/install", { method: "POST", body: { name: "dsh-nope" } })).status, 400);
		assert.equal((await call(h.route, "/m/api/plugin-inventory/update", { method: "POST", body: { name: "dsh-git", version: "1.1.0" } })).status, 409);
		const started = await call(h.route, "/m/api/plugin-inventory/install", { method: "POST", body: { name: "dsh-new" } });
		assert.equal(started.status, 200);
		const duplicate = await call(h.route, "/m/api/plugin-inventory/install", { method: "POST", body: { name: "dsh-new" } });
		assert.equal(duplicate.status, 409);
		const cancel = await call(h.route, "/m/api/plugin-inventory/op/cancel", { method: "POST", body: { opId: started.body.operation.opId } });
		assert.equal(cancel.status, 200);
		assert.equal(cancel.body.cancel, "cancelled");
		assert.equal(cancelled, 1);
		releaseInstall();
		const done = await waitOp(h.route, started.body.operation.opId);
		assert.equal(done.status, "cancelled");
		assert.equal(done.cancelled, true);
		// 方法约束
		assert.equal((await call(h.route, "/m/api/plugin-inventory/install")).status, 405);
	} finally { h.clean(); }
});
