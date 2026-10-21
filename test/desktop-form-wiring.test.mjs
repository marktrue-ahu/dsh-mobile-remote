// #36 S1-P1/P2 接线集成测试（lib/index.js）：
//   P1 LAN 桥三态 + 桌面形态自适应（私有网卡 / 持久化端口 / 候选探测 / 诊断字段）
//   P2 updateDir 默认目录（人工区与 carrier/托管区同目录）+ 诊断 updateDirSource
//
// 风格与 test/app-carrier-routes.test.mjs 一致：apply + 假 ctx + MockResponse；真实端口只用
// 测试临时端口（绝不占用 3081-3089），自动模式通过 runtime.lanBridge 注入候选端口与
// pickAddress 来规避真实网卡/真实端口。
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { once } from "node:events";
import { test } from "node:test";
import { readPersistedBridge } from "../lib/desktop-form.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const COOKIE_NAME = "dsh_mobile_token";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

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
		this.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
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
		authToken: TOKEN,
		cookieName: COOKIE_NAME,
		trustedHosts: [],
		sessionTtlMs: 60_000,
		rechargeUrl: "",
		updateDir: "",
		pluginUpdateManifest: "off",
		maxConnections: 16,
		pushUrls: [],
		pushCooldownMs: 60_000,
		doneGraceMs: 1_000,
		pushContent: "minimal",
		rateLimit: { maxFailures: 10, windowMs: 60_000, blockMs: 60_000 },
		publicOrigin: "",
		// 注意：这里**不**给 lanBridge 默认值——三态测试需要"未配置"这一态。
		...over,
	};
}

function createContext({ upstreamPort = 3080, services = {} } = {}) {
	const routes = [];
	let effectCleanup;
	const ctx = {
		webServer: {
			host: "127.0.0.1",
			port: upstreamPort,
			register(route) {
				routes.push(route);
				return () => {};
			},
		},
		logger: { warn() {}, info() {} },
		provide() {},
		get(name) {
			if (Object.prototype.hasOwnProperty.call(services, name)) return services[name];
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
		dispose() {
			effectCleanup?.();
		},
	};
}

function apiRouteOf(routes) {
	return routes.find((route) => route.kind === "prefix" && route.path === "/m/api");
}

function request(route, {
	url,
	method = "GET",
	host = "127.0.0.1:3080",
	remoteAddress = "127.0.0.1",
	headers = {},
} = {}) {
	const req = {
		method,
		url,
		headers: { host, ...headers },
		socket: { remoteAddress },
		on() {
			return this;
		},
	};
	const res = new MockResponse();
	const finished = once(res, "finish");
	route.handler(req, res);
	return finished.then(() => ({
		status: res.statusCode,
		headers: res.headers,
		body: res.body(),
		json: () => JSON.parse(res.body().toString("utf8")),
	}));
}

async function withHarness(options, callback) {
	const { config: overrides = {}, runtime = {}, services = {}, upstreamPort = 3080 } = options ?? {};
	const harness = createContext({ upstreamPort, services });
	apply(harness.ctx, config(overrides), runtime);
	try {
		return await callback({ ...harness, api: apiRouteOf(harness.routes) });
	} finally {
		harness.dispose();
	}
}

/** 每个用例独立 HOME（默认目录/桥端口状态都落在 HOME 下，避免用例间互相污染）。 */
async function withIsolatedHome(callback) {
	const saved = {
		HOME: process.env.HOME,
		DSH_HOME: process.env.DSH_HOME,
		DSH_PROFILE: process.env.DSH_PROFILE,
		DSH_DESKTOP: process.env.DSH_DESKTOP,
	};
	const home = await mkdtemp(join(tmpdir(), "dsh-desktop-wiring-home-"));
	process.env.HOME = home;
	process.env.DSH_HOME = join(home, ".dsh");
	delete process.env.DSH_PROFILE;
	delete process.env.DSH_DESKTOP;
	try {
		return await callback(home);
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(home, { recursive: true, force: true });
	}
}

/** 取一个当前空闲的高位临时端口（listen 0 后立刻关闭）。 */
async function freePort() {
	const probe = createServer();
	probe.listen(0, "127.0.0.1");
	await once(probe, "listening");
	const port = probe.address().port;
	await new Promise((resolve) => probe.close(resolve));
	return port;
}

async function diagnosticsOf(api) {
	const response = await request(api, { url: "/m/api/diagnostics", headers: { "x-mobile-token": TOKEN } });
	return { status: response.status, body: response.json() };
}

/** 轮询诊断，等待桥的监听状态变成期望值（异步启动 + listen 事件）。 */
async function waitForBridge(api, expected, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	let last = null;
	while (Date.now() < deadline) {
		const diag = await diagnosticsOf(api);
		last = diag.body?.runtime?.lanBridge ?? null;
		if (last && Boolean(last.listening) === expected) return last;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return last;
}

/** 轮询诊断直到 lanBridge 满足谓词（显式端口被占等失败路径用）。 */
async function waitForBridgeState(api, predicate, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	let last = null;
	while (Date.now() < deadline) {
		const diag = await diagnosticsOf(api);
		last = diag.body?.runtime?.lanBridge ?? null;
		if (last && predicate(last)) return last;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return last;
}

/** 占住一个端口（模拟 EADDRINUSE），返回 {port, release()}。 */
async function occupyPort() {
	const blocker = createServer();
	blocker.listen(0, "127.0.0.1");
	await once(blocker, "listening");
	const port = blocker.address().port;
	return {
		port,
		release: () => new Promise((resolve) => blocker.close(resolve)),
	};
}

function writeHostManifest(dir, { name = "app.apk", bytes = Buffer.from("wiring-fixture-apk\n") } = {}) {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, name), bytes);
	writeFileSync(join(dir, "manifest.json"), JSON.stringify({
		version: "3.2.0+57",
		apk: name,
		size: bytes.length,
		sha256: sha256(bytes),
		notes: "desktop-form wiring fixture",
	}));
	return { path: join(dir, name), bytes };
}

test.before(async () => {
	testHome = await mkdtemp(join(tmpdir(), "dsh-desktop-wiring-base-home-"));
	process.env.HOME = testHome;
	({ apply } = await import("../lib/index.js"));
});

test.after(async () => {
	await rm(testHome, { recursive: true, force: true });
});

// ── P2：默认 updateDir ──────────────────────────────────────────────────────

test("P2：未配置 updateDir → 启动创建默认目录（0700），人工区落位后匿名 APK 可下载", async () => {
	await withIsolatedHome(async (home) => {
		await withHarness({ config: { updateDir: "" } }, async ({ api }) => {
			const defaultDir = join(home, ".dsh", "mobile-remote", "update");
			assert.equal(existsSync(defaultDir), true, "启动必须创建默认更新目录");
			assert.equal(statSync(defaultDir).isDirectory(), true);
			assert.equal(statSync(defaultDir).mode & 0o777, 0o700, "默认目录权限必须是 0700");

			// 空目录不冒充"已配置主机源"（#35 语义保持：未就绪 = 503，不是 404）。
			const empty = await request(api, { url: "/m/api/update/apk" });
			assert.equal(empty.status, 503);
			assert.equal(empty.json().error, "app-artifact-not-ready");

			// 诊断：新增 updateDirSource/updateDirReady/updateDirReason，旧字段保留。
			const diag = await diagnosticsOf(api);
			assert.equal(diag.status, 200);
			const carrier = diag.body.carrier;
			assert.equal(carrier.updateDirSource, "default");
			assert.equal(carrier.updateDirConfigured, false);
			assert.equal(carrier.updateDirReady, true);
			assert.equal(carrier.updateDirReason, null);

			// 默认目录 = 人工区：放入清单 + APK 后即可匿名下载（sha256 一致）。
			const fixture = writeHostManifest(defaultDir);
			const download = await request(api, { url: "/m/api/update/apk" });
			assert.equal(download.status, 200, download.body.toString().slice(0, 200));
			assert.deepEqual(download.body, fixture.bytes);
			assert.equal(download.headers["content-type"], "application/vnd.android.package-archive");

			const manifest = await request(api, { url: "/m/api/update/manifest", headers: { "x-mobile-token": TOKEN } });
			assert.equal(manifest.status, 200);
			assert.equal(manifest.json().manifest.sha256, sha256(fixture.bytes));
		});
	});
});

test("P2：显式 updateDir → updateDirSource=config，且不创建/不使用默认目录", async () => {
	await withIsolatedHome(async (home) => {
		const explicitDir = await mkdtemp(join(home, "explicit-update-"));
		await withHarness({ config: { updateDir: explicitDir } }, async ({ api }) => {
			const defaultDir = join(home, ".dsh", "mobile-remote", "update");
			assert.equal(existsSync(defaultDir), false, "显式模式不得创建默认更新目录");

			const diag = await diagnosticsOf(api);
			const carrier = diag.body.carrier;
			assert.equal(carrier.updateDirSource, "config");
			assert.equal(carrier.updateDirConfigured, true);
			assert.equal(carrier.updateDirReady, true);

			// 显式目录为空 → 仍是未就绪；落位后才服务（证明用的是显式目录）。
			assert.equal((await request(api, { url: "/m/api/update/apk" })).status, 503);
			const fixture = writeHostManifest(explicitDir);
			const download = await request(api, { url: "/m/api/update/apk" });
			assert.equal(download.status, 200);
			assert.deepEqual(download.body, fixture.bytes);
			assert.equal(existsSync(join(defaultDir, "manifest.json")), false);
		});
	});
});

test("P2：默认目录不可写 → 只记诊断 update-dir-unwritable，控制面/下载面不崩", async () => {
	await withIsolatedHome(async (home) => {
		const pluginStateDir = join(home, ".dsh", "mobile-remote");
		await mkdir(pluginStateDir, { recursive: true });
		await chmod(pluginStateDir, 0o500);
		try {
			await withHarness({ config: { updateDir: "" } }, async ({ api }) => {
				const diag = await diagnosticsOf(api);
				assert.equal(diag.status, 200, "目录不可写不得影响诊断接口");
				const carrier = diag.body.carrier;
				assert.equal(carrier.updateDirSource, "default");
				assert.equal(carrier.updateDirReady, false);
				assert.equal(carrier.updateDirReason, "update-dir-unwritable");

				// 其余功能正常：bootstrap 200、匿名 APK 走稳定"未就绪"而不是 500/崩溃。
				const boot = await request(api, { url: "/m/api/bootstrap", headers: { "x-mobile-token": TOKEN } });
				assert.equal(boot.status, 200);
				const apk = await request(api, { url: "/m/api/update/apk" });
				assert.equal(apk.status, 503);
				assert.equal(apk.json().error, "app-artifact-not-ready");
			});
		} finally {
			await chmod(pluginStateDir, 0o700);
		}
	});
});

// ── P1：LAN 桥三态 ─────────────────────────────────────────────────────────

test("P1：lanBridge 三态——显式 false → 不监听（source=config，旧字段不删）", async () => {
	await withIsolatedHome(async () => {
		await withHarness({ config: { lanBridge: { enabled: false } } }, async ({ api }) => {
			const diag = await diagnosticsOf(api);
			const bridge = diag.body.runtime.lanBridge;
			// 旧字段保持（enabled/host/port/listening）。
			assert.equal(bridge.enabled, false);
			assert.equal(bridge.listening, false);
			assert.equal(typeof bridge.host, "string");
			assert.equal(typeof bridge.port, "number");
			// 新增三态字段。
			assert.equal(bridge.source, "config");
			assert.equal(bridge.reason, "disabled-by-config");
			assert.ok(bridge.hint.length > 0);
		});
	});
});

test("P1：lanBridge 三态——显式 true → 在配置端口真实监听", async () => {
	await withIsolatedHome(async () => {
		const bridgePort = await freePort();
		const upstreamPort = await freePort();
		await withHarness({
			upstreamPort,
			config: { lanBridge: { enabled: true, host: "127.0.0.1", port: bridgePort } },
		}, async ({ api }) => {
			const bridge = await waitForBridge(api, true);
			assert.equal(bridge.enabled, true);
			assert.equal(bridge.listening, true);
			assert.equal(bridge.host, "127.0.0.1");
			assert.equal(bridge.port, bridgePort);
			assert.equal(bridge.source, "config");
			assert.equal(bridge.portSource, "config");

			// 真实 TCP 可达：上游（假 ctx 的 webServer.port）没有服务 → 桥回 502，证明监听成功。
			const response = await fetch(`http://127.0.0.1:${bridgePort}/m/api/bootstrap`, {
				headers: { "x-mobile-token": TOKEN },
			});
			assert.equal(response.status, 502);
			assert.equal((await response.json()).error, "bridge-unavailable");
		});
	});
});

test("P1：lanBridge 三态——未配置 + 非桌面 → 不监听（auto-skipped/form-unknown）", async () => {
	await withIsolatedHome(async () => {
		await withHarness({ config: {} }, async ({ api }) => {
			const diag = await diagnosticsOf(api);
			const bridge = diag.body.runtime.lanBridge;
			assert.equal(bridge.enabled, false);
			assert.equal(bridge.listening, false);
			assert.equal(bridge.source, "auto-skipped");
			assert.equal(bridge.reason, "form-unknown");
			assert.ok(bridge.hint.includes("lanBridge.enabled"));
		});
	});
});

test("P1：lanBridge 三态——未配置 + 桌面形态 → 自动选端口监听并持久化（source=auto-desktop）", async () => {
	await withIsolatedHome(async (home) => {
		const bridgePort = await freePort();
		const upstreamPort = await freePort();
		process.env.DSH_PROFILE = "wiring-profile";
		await withHarness({
			upstreamPort,
			config: {},
			// 注入桌面形态服务（真实桌面启动器提供 desktopBrowserAccess）。
			services: { desktopBrowserAccess: { rendererHeader: { name: "x-dsh-desktop-renderer", value: "1" } } },
			// 注入候选端口与地址选择：避免占用真实 3081-3089 / 依赖真实网卡。
			runtime: { lanBridge: { candidates: [bridgePort], pickAddress: () => "127.0.0.1" } },
		}, async ({ api }) => {
			const bridge = await waitForBridge(api, true);
			assert.equal(bridge.enabled, true);
			assert.equal(bridge.listening, true);
			assert.equal(bridge.source, "auto-desktop");
			assert.equal(bridge.host, "127.0.0.1");
			assert.equal(bridge.port, bridgePort);
			assert.equal(bridge.portSource, "probe", "新 HOME 没有持久化 → 候选探测");

			// 自动模式必须把端口持久化（重启后手机不必重扫码）。
			const persisted = readPersistedBridge({ dshHome: join(home, ".dsh"), profileKey: "wiring-profile" });
			assert.deepEqual(persisted, { port: bridgePort, host: "127.0.0.1" });
		});
	});
});

test("P1：lanBridge 自动模式——重启复用持久化端口（portSource=persisted）", async () => {
	await withIsolatedHome(async () => {
		const firstPort = await freePort();
		const secondPort = await freePort();
		process.env.DSH_PROFILE = "wiring-profile";
		const services = { desktopBrowserAccess: { rendererHeader: { name: "x-dsh-desktop-renderer", value: "1" } } };
		await withHarness({
			config: {},
			services,
			runtime: { lanBridge: { candidates: [firstPort], pickAddress: () => "127.0.0.1" } },
		}, async ({ api }) => {
			const first = await waitForBridge(api, true);
			assert.equal(first.port, firstPort);
			assert.equal(first.portSource, "probe");
		});
		// 第二个实例（同一 HOME/profile）：应先用持久化端口，而**不是**新候选。
		await withHarness({
			config: {},
			services,
			runtime: { lanBridge: { candidates: [secondPort], pickAddress: () => "127.0.0.1" } },
		}, async ({ api }) => {
			const second = await waitForBridge(api, true);
			assert.equal(second.port, firstPort, "重启后应复用持久化端口");
			assert.equal(second.portSource, "persisted");
		});
	});
});

test("P1：三态字段与既有诊断兼容（bootstrap 的 server.urls 与 qr-config 不崩）", async () => {
	await withIsolatedHome(async () => {
		await withHarness({ config: { lanBridge: { enabled: false } } }, async ({ api }) => {
			const boot = await request(api, { url: "/m/api/bootstrap", headers: { "x-mobile-token": TOKEN } });
			assert.equal(boot.status, 200);
			assert.ok(Array.isArray(boot.json().server.urls));
			assert.equal(boot.json().server.path, "/m");
			const qr = await request(api, { url: "/m/api/qr-config" });
			assert.equal(qr.status, 200);
			assert.ok(Array.isArray(qr.json().urls));
			assert.equal(qr.json().token, TOKEN, "配置非空时以配置为准");
		});
	});
});

test("P1：显式 true 绑定失败 → 只记稳定 reason（listen-error），不自动改端口", async () => {
	await withIsolatedHome(async () => {
		const occupied = await occupyPort();
		const upstreamPort = await freePort();
		try {
			await withHarness({
				upstreamPort,
				config: { lanBridge: { enabled: true, host: "127.0.0.1", port: occupied.port } },
			}, async ({ api }) => {
				const bridge = await waitForBridgeState(api, (value) => value.reason === "listen-error");
				assert.equal(bridge.enabled, false);
				assert.equal(bridge.listening, false);
				assert.equal(bridge.source, "config");
				assert.equal(bridge.port, occupied.port, "显式端口失败不得偷偷换端口");
				assert.equal(bridge.reason, "listen-error");
				assert.ok(bridge.hint.length > 0);
			});
		} finally {
			await occupied.release();
		}
	});
});

test("P1：自动模式无私有地址 → 不开桥（auto-skipped/no-private-address，绝不回退 0.0.0.0）", async () => {
	await withIsolatedHome(async () => {
		await withHarness({
			config: {},
			services: { desktopBrowserAccess: { rendererHeader: { name: "x-dsh-desktop-renderer", value: "1" } } },
			runtime: { lanBridge: { pickAddress: () => null } },
		}, async ({ api }) => {
			const diag = await diagnosticsOf(api);
			const bridge = diag.body.runtime.lanBridge;
			assert.equal(bridge.enabled, false);
			assert.equal(bridge.listening, false);
			assert.equal(bridge.source, "auto-skipped");
			assert.equal(bridge.reason, "no-private-address");
			assert.equal(bridge.host, "", "无私有地址时不得绑定 0.0.0.0/回环");
			assert.ok(bridge.hint.includes("lanBridge.host"));
		});
	});
});

test("P1：自动模式候选端口全被占用 → no-free-port（不漂移到候选区间外）", async () => {
	await withIsolatedHome(async () => {
		const occupied = await occupyPort();
		try {
			await withHarness({
				config: {},
				services: { desktopBrowserAccess: { rendererHeader: { name: "x-dsh-desktop-renderer", value: "1" } } },
				runtime: { lanBridge: { candidates: [occupied.port], pickAddress: () => "127.0.0.1" } },
			}, async ({ api }) => {
				const bridge = await waitForBridgeState(api, (value) => value.reason === "no-free-port");
				assert.equal(bridge.enabled, false);
				assert.equal(bridge.listening, false);
				assert.equal(bridge.source, "auto-desktop");
				assert.equal(bridge.reason, "no-free-port");
				assert.equal(bridge.portSource, "none");
			});
		} finally {
			await occupied.release();
		}
	});
});
