// 对齐状态的**端点契约**：bootstrap 必须随连接一并下发两端对齐状态，
// diagnostics 必须把它作为 PC 端的失配提示入口；两者都不得破坏既有字段。
// 真实服务/重启相关的部分不在自动门禁内（见 AGENT-RULES）。
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { once } from "node:events";
import { test } from "node:test";

let apply;
let testHome;

class MockResponse extends Writable {
	constructor() {
		super();
		this.statusCode = 200;
		this.headers = {};
		this.chunks = [];
	}

	writeHead(status, headers = {}) {
		this.statusCode = status;
		this.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
		return this;
	}

	_write(chunk, encoding, callback) {
		this.chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, encoding));
		callback();
	}

	body() {
		return Buffer.concat(this.chunks);
	}
}

function config(over = {}) {
	return {
		path: "/m",
		// 关闭口令：对齐状态与鉴权无关，这里只测响应契约
		authToken: "",
		cookieName: "dsh_mobile_token",
		trustedHosts: [],
		sessionTtlMs: 60_000,
		rechargeUrl: "",
		updateDir: "",
		// 默认关掉更新检查：这些用例只关心契约，不应产生任何出网行为
		pluginUpdateManifest: "off",
		maxConnections: 16,
		pushUrls: [],
		pushCooldownMs: 60_000,
		doneGraceMs: 1_000,
		pushContent: "minimal",
		rateLimit: { maxFailures: 10, windowMs: 60_000, blockMs: 60_000 },
		lanBridge: { enabled: false, host: "127.0.0.1", port: 3080 },
		...over,
	};
}

function createContext() {
	const routes = [];
	const logs = [];
	let effectCleanup;
	const logger = {
		warn: (m) => logs.push({ level: "warn", message: String(m) }),
		info: (m) => logs.push({ level: "info", message: String(m) }),
	};
	const ctx = {
		webServer: {
			host: "127.0.0.1",
			port: 3080,
			register(route) {
				routes.push(route);
				return () => {};
			},
		},
		logger,
		provide() {},
		get(name) {
			if (name === "agents") return { list: () => [], roots: () => [], get: () => undefined };
			if (name === "sessions") return { list: () => [], get: () => undefined };
			return undefined;
		},
		on() {
			return () => {};
		},
		inject() {},
		effect(fn) {
			effectCleanup = fn();
			return effectCleanup;
		},
	};
	return {
		ctx,
		routes,
		logs,
		dispose() {
			effectCleanup?.();
		},
	};
}

function apiRouteOf(routes) {
	return routes.find((route) => route.kind === "prefix" && route.path === "/m/api");
}

function request(route, { url, headers = {}, method = "GET" }) {
	const req = {
		method,
		url,
		headers: { host: "127.0.0.1:3080", ...headers },
		socket: { remoteAddress: "127.0.0.1" },
		on() {
			return this;
		},
	};
	const res = new MockResponse();
	const finished = once(res, "finish");
	route.handler(req, res);
	return finished.then(() => ({
		status: res.statusCode,
		json: () => JSON.parse(res.body().toString("utf8")),
	}));
}

async function withHarness(callback, over = {}) {
	const harness = createContext();
	apply(harness.ctx, config(over));
	try {
		return await callback({ ...harness, api: apiRouteOf(harness.routes) });
	} finally {
		harness.dispose();
	}
}

test.before(async () => {
	testHome = await mkdtemp(join(tmpdir(), "dsh-mobile-alignment-home-"));
	process.env.HOME = testHome;
	({ apply } = await import("../lib/index.js"));
});

test.after(async () => {
	await rm(testHome, { recursive: true, force: true });
});

test("bootstrap：未上报版本头 → alignment 为 unknown，且 PC 端日志给出提示（自举）", async () => {
	await withHarness(async ({ api, logs }) => {
		const r = await request(api, { url: "/m/api/bootstrap" });
		assert.equal(r.status, 200);
		const body = r.json();
		assert.equal(body.alignment.state, "unknown");
		assert.equal(body.alignment.reason, "app-version-header-missing");
		assert.equal(body.alignment.appVersion, null);
		assert.ok(body.alignment.pluginVersion.length > 0);
		const hint = logs.find((l) => l.message.includes("未上报版本"));
		assert.ok(hint, `未见到提示日志：${JSON.stringify(logs)}`);
		assert.equal(hint.level, "info");
	});
});

test("bootstrap：两端语义版本一致 → ok，且不产生失配提示", async () => {
	await withHarness(async ({ api, logs }) => {
		const pluginVersion = (await request(api, { url: "/m/api/bootstrap" })).json().plugin.version;
		const r = await request(api, {
			url: "/m/api/bootstrap",
			headers: { "x-mobile-app-version": `${pluginVersion}+44` },
		});
		const body = r.json();
		assert.equal(body.alignment.state, "ok");
		assert.equal(body.alignment.appVersion, `${pluginVersion}+44`);
		assert.equal(logs.filter((l) => l.message.includes("落后")).length, 0);
	});
});

test("bootstrap：App 落后 → app-outdated，并给出去更新 App 的提示", async () => {
	await withHarness(async ({ api, logs }) => {
		const r = await request(api, { url: "/m/api/bootstrap", headers: { "x-mobile-app-version": "3.1.5" } });
		const body = r.json();
		assert.equal(body.alignment.state, "app-outdated");
		assert.equal(body.alignment.reason, "app-older-than-plugin");
		const hint = logs.find((l) => l.message.includes("落后于本机插件"));
		assert.ok(hint);
		assert.equal(hint.level, "warn");
	});
});

test("bootstrap：同一结论反复出现时提示只记一次（刷新/重连不会刷屏）", async () => {
	await withHarness(async ({ api, logs }) => {
		for (let i = 0; i < 3; i++) {
			await request(api, { url: "/m/api/bootstrap", headers: { "x-mobile-app-version": "3.1.5" } });
		}
		assert.equal(logs.filter((l) => l.message.includes("落后于本机插件")).length, 1);
	});
});

test("bootstrap：新增 alignment 不破坏既有字段（增量契约）", async () => {
	await withHarness(async ({ api }) => {
		const body = (await request(api, { url: "/m/api/bootstrap" })).json();
		assert.equal(body.ok, true);
		assert.ok(body.plugin && typeof body.plugin.version === "string");
		assert.ok(body.capabilities && typeof body.capabilities.eventTimeline === "object");
		assert.equal(Array.isArray(body.agents), true);
		assert.equal(Array.isArray(body.sessions), true);
		assert.equal(typeof body.alignment, "object");
	});
});

test("diagnostics：checks.appAlignment 是 PC 端的失配提示入口", async () => {
	await withHarness(async ({ api }) => {
		const missing = (await request(api, { url: "/m/api/diagnostics" })).json();
		assert.equal(missing.checks.appAlignment.state, "unknown");
		assert.equal(missing.checks.appAlignment.reason, "app-version-header-missing");

		const outdated = (
			await request(api, { url: "/m/api/diagnostics", headers: { "x-mobile-app-version": "3.0.0" } })
		).json();
		assert.equal(outdated.checks.appAlignment.state, "app-outdated");

		const aligned = (
			await request(api, {
				url: "/m/api/diagnostics",
				headers: { "x-mobile-app-version": missing.plugin.version },
			})
		).json();
		assert.equal(aligned.checks.appAlignment.state, "ok");
	});
});

test("bootstrap：下发插件自更新状态（初始为未检查），并在 diagnostics 可见", async () => {
	await withHarness(async ({ api }) => {
		const boot = (await request(api, { url: "/m/api/bootstrap" })).json();
		assert.equal(typeof boot.pluginUpdate, "object");
		assert.equal(boot.pluginUpdate.state, "unknown");
		assert.equal(boot.pluginUpdate.reason, "not-checked");

		const diag = (await request(api, { url: "/m/api/diagnostics" })).json();
		assert.equal(diag.checks.pluginUpdate.state, "unknown");
	});
});

test("POST /plugin-update：GET 不接受（只允许明确触发）", async () => {
	await withHarness(async ({ api }) => {
		const r = await request(api, { url: "/m/api/plugin-update" });
		assert.equal(r.status, 405);
	});
});

test("POST /plugin-update：来源关闭 → 503；来源非法 → 400（fail-closed，不动本机）", async () => {
	await withHarness(async ({ api }) => {
		const off = await request(api, { url: "/m/api/plugin-update", method: "POST" });
		assert.equal(off.status, 503);
		assert.equal(off.json().error, "update-source-off");
	}, { pluginUpdateManifest: "off" });

	await withHarness(async ({ api }) => {
		const invalid = await request(api, { url: "/m/api/plugin-update", method: "POST" });
		assert.equal(invalid.status, 400);
		assert.equal(invalid.json().error, "update-source-invalid");
	}, { pluginUpdateManifest: "http://insecure.host/m.json" });
});

test("POST /plugin-update：拿不到 profile 目录 → 409，绝不动文件（R3）", async () => {
	// 测试树的祖先里没有声明本插件依赖的 package.json，因此 profile 解析为空——
	// 这正是"不确定就先拒绝"的路径（比盲目改文件安全）。
	await withHarness(async ({ api }) => {
		const r = await request(api, { url: "/m/api/plugin-update", method: "POST" });
		assert.equal(r.status, 409);
		assert.equal(r.json().error, "profile-not-found");
	}, { pluginUpdateManifest: "https://my.host/update/manifest.json" });
});

test("POST /plugin-update：本机形态不支持自重启 → 409（在做任何改动之前就拒绝）", async () => {
	// 形态判定读进程环境（本仓库的测试就跑在 systemd 服务里），所以这里显式清掉相关变量，
	// 让它稳定落到 unsupported；同时给一个真实的 profile 目录，好走到能力判定这一步。
	const saved = {
		INVOCATION_ID: process.env.INVOCATION_ID,
		DSH_PROFILE: process.env.DSH_PROFILE,
		DSH_WEB_FOREGROUND: process.env.DSH_WEB_FOREGROUND,
	};
	delete process.env.INVOCATION_ID;
	delete process.env.DSH_PROFILE;
	delete process.env.DSH_WEB_FOREGROUND;
	const dir = await mkdtemp(join(tmpdir(), "plugin-profile-"));
	try {
		await writeFile(join(dir, "package.json"), JSON.stringify({
			name: "web-profile",
			dependencies: { "dsh-mobile-remote": "file:/somewhere" },
		}));
		await withHarness(async ({ api }) => {
			const r = await request(api, { url: "/m/api/plugin-update", method: "POST" });
			assert.equal(r.status, 409);
			assert.equal(r.json().error, "restart-unsupported");
		}, { pluginUpdateManifest: "https://my.host/update/manifest.json", updateProfileDir: dir });
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		await rm(dir, { recursive: true, force: true });
	}
});
