// #36 S1-P1/P2 接线集成测试（lib/index.js）：
//   P1 LAN 桥三态 + 桌面形态自适应（私有网卡 / 持久化端口 / 候选探测 / 诊断字段）
//   P2 updateDir 默认目录（人工区与 carrier/托管区同目录）+ 诊断 updateDirSource
//
// 风格与 test/app-carrier-routes.test.mjs 一致：apply + 假 ctx + MockResponse；真实端口只用
// 测试临时端口（绝不占用 3081-3089），自动模式通过 runtime.lanBridge 注入候选端口与
// pickAddress 来规避真实网卡/真实端口。
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { once } from "node:events";
import { test } from "node:test";
import { readPersistedBridge } from "../lib/desktop-form.js";
import { publishRelease, selectRelease } from "../lib/app-carrier-store.js";
import { pluginContentDigest } from "../lib/plugin-content-digest.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const COOKIE_NAME = "dsh_mobile_token";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const WORKTREE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN_NAME = "@marktrue/dsh-mobile-remote";
const PLUGIN_VERSION = JSON.parse(readFileSync(join(WORKTREE_ROOT, "package.json"), "utf8")).version;

let apply;
let Config;
let orderEndpointOrigins;
let resolveDshHome;
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

function createContext({ upstreamPort = 3080, services = {}, webServerHost = "127.0.0.1" } = {}) {
	const routes = [];
	let effectCleanup;
	const ctx = {
		webServer: {
			host: webServerHost,
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
	const { config: overrides = {}, runtime = {}, services = {}, upstreamPort = 3080, webServerHost = "127.0.0.1" } = options ?? {};
	const harness = createContext({ upstreamPort, services, webServerHost });
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
	({ apply, Config, orderEndpointOrigins, resolveDshHome } = await import("../lib/index.js"));
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

// ═══════════════════════════════════════════════════════════════════════════
// #36 follow-up（issue note 1509）：可信 Desktop 身份 + 手机端点契约
// ═══════════════════════════════════════════════════════════════════════════

const DESKTOP_VERSIONS = { electron: "44.7.0", node: "24.21.0" };
const asRoot = process.getuid?.() === 0;
// W2：Windows DSH 0.2.1-rc.2 实机核验的宿主启动入口（Electron-as-Node 的 argv[1]）。
const DESKTOP_HOST_ENTRY = "C:\\Program Files\\DeepSeek\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js";
const desktopProfileContext = (home) => ({
	name: "desktop",
	dir: join(home, ".dsh", "profiles", "desktop"),
	home: join(home, ".dsh"),
});

async function bootstrapOf(api) {
	return (await request(api, { url: "/m/api/bootstrap", headers: { "x-mobile-token": TOKEN } })).json();
}

async function qrConfigOf(api) {
	return (await request(api, { url: "/m/api/qr-config" })).json();
}

/** 断言"没有把本机私有 IP 拼到回环 webserver 端口"的假地址（#36 实机误导 URL）。 */
function assertNoFakeLoopbackUrl(urls, webPort) {
	const text = JSON.stringify(urls);
	assert.equal(text.includes(`:${webPort}`) && /(?:192\.168|10\.\d|172\.(?:1[6-9]|2\d|3[01])\.\d)\.\d+:/.test(text), false, `不得出现私有IP:回环端口 假地址：${text}`);
}

test("P0：当前活跃 profileContext=desktop + Electron 标记 → 自动开桥（formSource=desktop-profile，按 desktop profileKey 持久化）", async () => {
	await withIsolatedHome(async (home) => {
		await mkdir(join(home, ".dsh", "profiles", "desktop"), { recursive: true });
		const bridgePort = await freePort();
		const upstreamPort = await freePort();
		await withHarness({
			upstreamPort,
			config: {},
			// 真实宿主经 ctx 提供 profileContext；这里同时注入（形态证据与 profileKey 同源）。
			services: { profileContext: desktopProfileContext(home) },
			runtime: {
				formEvidence: {
					profileContext: desktopProfileContext(home),
					versions: DESKTOP_VERSIONS,
					hostEntry: DESKTOP_HOST_ENTRY,
					hasDesktopBrowserAccess: false,
				},
				lanBridge: { candidates: [bridgePort], pickAddress: () => "127.0.0.1" },
			},
		}, async ({ api }) => {
			const bridge = await waitForBridge(api, true);
			assert.equal(bridge.source, "auto-desktop");
			assert.equal(bridge.phase, "listening");
			assert.equal(bridge.requestedMode, "auto");
			const diag = await diagnosticsOf(api);
			assert.equal(diag.body.runtime.form, "desktop");
			assert.equal(diag.body.runtime.formSource, "desktop-profile");
			assert.equal(diag.body.runtime.formReason, "");
			// 持久化用宿主 profile 名 "desktop"（不是 DSH_PROFILE 兜底 web）。
			assert.deepEqual(
				readPersistedBridge({ dshHome: join(home, ".dsh"), profileKey: "desktop" }),
				{ port: bridgePort, host: "127.0.0.1" },
			);
		});
	});
});

test("P0：desktop 目录经 symlink/junction 等价仍可信（平台路径等价，不是 basename 比对）", async () => {
	await withIsolatedHome(async (home) => {
		const actual = join(home, ".dsh", "profiles", "desktop");
		await mkdir(actual, { recursive: true });
		const link = join(home, "desktop-junction");
		await symlink(actual, link);
		await withHarness({
			config: {},
			runtime: {
				formEvidence: {
					profileContext: { name: "desktop", dir: link, home: join(home, ".dsh") },
					versions: DESKTOP_VERSIONS,
					hostEntry: DESKTOP_HOST_ENTRY,
					hasDesktopBrowserAccess: false,
				},
				lanBridge: { candidates: [await freePort()], pickAddress: () => "127.0.0.1" },
			},
		}, async ({ api }) => {
			const diag = await diagnosticsOf(api);
			assert.equal(diag.body.runtime.form, "desktop");
			assert.equal(diag.body.runtime.formSource, "desktop-profile");
			assert.equal(diag.body.runtime.formReason, "");
		});
	});
});

test("P0：缺 Electron 宿主证据 → 不自动开桥（formReason=desktop-launch-evidence-missing）", async () => {
	await withIsolatedHome(async (home) => {
		await withHarness({
			config: {},
			runtime: {
				formEvidence: {
					profileContext: desktopProfileContext(home),
					versions: { node: "24.21.0" },
					hasDesktopBrowserAccess: false,
				},
			},
		}, async ({ api }) => {
			const diag = await diagnosticsOf(api);
			assert.equal(diag.body.runtime.form, "cli");
			assert.equal(diag.body.runtime.formSource, "unknown");
			assert.equal(diag.body.runtime.formReason, "desktop-launch-evidence-missing");
			const bridge = diag.body.runtime.lanBridge;
			assert.equal(bridge.source, "auto-skipped");
			assert.equal(bridge.reason, "form-unknown");
			assert.equal(bridge.phase, "skipped");
			assert.equal(bridge.requestedMode, "auto");
		});
	});
});

test("P0：profile 名非 desktop（即使有 Electron 标记）→ 不自动开桥（profile-not-desktop）", async () => {
	await withIsolatedHome(async (home) => {
		await withHarness({
			config: {},
			runtime: {
				formEvidence: {
					profileContext: { name: "web", dir: join(home, ".dsh", "profiles", "web"), home: join(home, ".dsh") },
					versions: DESKTOP_VERSIONS,
					hostEntry: DESKTOP_HOST_ENTRY,
					hasDesktopBrowserAccess: false,
				},
			},
		}, async ({ api }) => {
			const diag = await diagnosticsOf(api);
			assert.equal(diag.body.runtime.form, "cli");
			assert.equal(diag.body.runtime.formReason, "profile-not-desktop");
			assert.equal(diag.body.runtime.lanBridge.reason, "form-unknown");
		});
	});
});

test("P0：desktop 名但目录不是 <home>/profiles/desktop → profile-dir-untrusted（同名目录不授权）", async () => {
	await withIsolatedHome(async (home) => {
		await withHarness({
			config: {},
			runtime: {
				formEvidence: {
					profileContext: {
						name: "desktop",
						dir: join(home, ".dsh", "profiles", "desktop-copy"),
						home: join(home, ".dsh"),
					},
					versions: DESKTOP_VERSIONS,
					hostEntry: DESKTOP_HOST_ENTRY,
					hasDesktopBrowserAccess: false,
				},
			},
		}, async ({ api }) => {
			const diag = await diagnosticsOf(api);
			assert.equal(diag.body.runtime.form, "cli");
			assert.equal(diag.body.runtime.formReason, "profile-dir-untrusted");
			assert.equal(diag.body.runtime.lanBridge.reason, "form-unknown");
		});
	});
});

test("P0：只有磁盘上的同名 profiles/desktop 目录、无 profileContext → 不自动开桥（不扫描磁盘猜身份）", async () => {
	await withIsolatedHome(async (home) => {
		await mkdir(join(home, ".dsh", "profiles", "desktop"), { recursive: true });
		await withHarness({
			config: {},
			runtime: {
				formEvidence: { profileContext: null, versions: DESKTOP_VERSIONS, hasDesktopBrowserAccess: false },
			},
		}, async ({ api }) => {
			const diag = await diagnosticsOf(api);
			assert.equal(diag.body.runtime.form, "cli");
			assert.equal(diag.body.runtime.formReason, "profile-context-missing");
			assert.equal(diag.body.runtime.lanBridge.reason, "form-unknown");
			assert.equal(diag.body.runtime.lanBridge.phase, "skipped");
		});
	});
});

test("P0：既有 DSH_DESKTOP=1 仍最高优先（environment），即使 profileContext 说 web", async () => {
	await withIsolatedHome(async (home) => {
		const bridgePort = await freePort();
		process.env.DSH_DESKTOP = "1";
		await withHarness({
			config: {},
			runtime: {
				formEvidence: {
					profileContext: { name: "web", dir: join(home, ".dsh", "profiles", "web"), home: join(home, ".dsh") },
					versions: {},
					hasDesktopBrowserAccess: false,
				},
				lanBridge: { candidates: [bridgePort], pickAddress: () => "127.0.0.1" },
			},
		}, async ({ api }) => {
			const bridge = await waitForBridge(api, true);
			assert.equal(bridge.source, "auto-desktop");
			const diag = await diagnosticsOf(api);
			assert.equal(diag.body.runtime.formSource, "environment");
		});
	});
});

test("P0：显式 lanBridge.enabled=false 永远压过可信 Desktop 形态（requestedMode=off，不监听）", async () => {
	await withIsolatedHome(async (home) => {
		await withHarness({
			config: { lanBridge: { enabled: false } },
			runtime: {
				formEvidence: {
					profileContext: desktopProfileContext(home),
					versions: DESKTOP_VERSIONS,
					hostEntry: DESKTOP_HOST_ENTRY,
					hasDesktopBrowserAccess: false,
				},
				lanBridge: { candidates: [await freePort()], pickAddress: () => "127.0.0.1" },
			},
		}, async ({ api }) => {
			const diag = await diagnosticsOf(api);
			const bridge = diag.body.runtime.lanBridge;
			assert.equal(bridge.enabled, false);
			assert.equal(bridge.listening, false);
			assert.equal(bridge.source, "config");
			assert.equal(bridge.phase, "disabled");
			assert.equal(bridge.requestedMode, "off");
			assert.equal(bridge.reason, "disabled-by-config");
		});
	});
});

test("P0：可信 Desktop 但无私有地址 → auto-skipped/no-private-address，端点不可用但不造假 URL", async () => {
	await withIsolatedHome(async (home) => {
		await mkdir(join(home, ".dsh", "profiles", "desktop"), { recursive: true });
		await withHarness({
			config: {},
			runtime: {
				formEvidence: {
					profileContext: desktopProfileContext(home),
					versions: DESKTOP_VERSIONS,
					hostEntry: DESKTOP_HOST_ENTRY,
					hasDesktopBrowserAccess: false,
				},
				lanBridge: { pickAddress: () => null },
			},
		}, async ({ api }) => {
			const bridge = await waitForBridgeState(api, (value) => value.phase === "skipped");
			assert.equal(bridge.reason, "no-private-address");
			const boot = await bootstrapOf(api);
			assert.deepEqual([...boot.server.urls], []);
			assert.equal(boot.connection.state, "unavailable");
			assert.equal(boot.connection.reason, "no-private-address");
			const qr = await qrConfigOf(api);
			assert.deepEqual([...qr.urls], []);
		});
	});
});

test("P0：诊断不泄露本机路径（form/formSource/formReason 均为稳定代号）", async () => {
	await withIsolatedHome(async (home) => {
		await mkdir(join(home, ".dsh", "profiles", "desktop"), { recursive: true });
		await withHarness({
			config: {},
			runtime: {
				formEvidence: {
					profileContext: desktopProfileContext(home),
					versions: DESKTOP_VERSIONS,
					hostEntry: DESKTOP_HOST_ENTRY,
					hasDesktopBrowserAccess: false,
				},
				lanBridge: { candidates: [await freePort()], pickAddress: () => "127.0.0.1" },
			},
		}, async ({ api }) => {
			const diag = await diagnosticsOf(api);
			const serialized = JSON.stringify(diag.body.runtime);
			assert.equal(serialized.includes(home), false, "诊断不得包含本机路径");
			assert.equal(serialized.includes(".dsh"), false, "诊断不得包含 profile 路径");
			assert.equal(serialized.includes("44.7.0"), false, "诊断不得回显 Electron 版本明细（非必要）");
			assert.match(diag.body.runtime.formSource, /^(?:environment|desktopBrowserAccess|desktop-profile|unknown)$/);
		});
	});
});

// ── 手机端点契约 / 假 fallback 修复（note 1509 §5）─────────────────────────

test("端点：loopback webserver + 无桥 → server.urls=[]、qr.urls=[]，绝无 私有IP:回环端口 假地址", async () => {
	await withIsolatedHome(async () => {
		await withHarness({ config: {} }, async ({ api }) => {
			const boot = await bootstrapOf(api);
			assert.deepEqual([...boot.server.urls], []);
			assert.equal(boot.connection.state, "unavailable");
			assert.equal(boot.connection.reason, "form-unknown");
			assert.equal(boot.connection.source, "none");
			assert.ok(boot.connection.hint.length > 0);
			assertNoFakeLoopbackUrl(boot.server.urls, boot.server.port);

			const qr = await qrConfigOf(api);
			assert.deepEqual([...qr.urls], []);
			assert.equal(qr.connection.state, "unavailable");
			assert.equal(qr.localUrl, "http://127.0.0.1:3080/m", "本机诊断地址只在本机字段，不混入手机 urls");
			assert.equal(qr.appDownloadUrl, null);
			assertNoFakeLoopbackUrl(qr.urls, boot.server.port);
		});
	});
});

test("端点：publicOrigin 就绪 → bootstrap/qr 共用同一手机可达基址，下载码同源", async () => {
	await withIsolatedHome(async (home) => {
		const updateDir = await mkdtemp(join(home, "update-origin-"));
		writeHostManifest(updateDir);
		await withHarness({ config: { updateDir, publicOrigin: "https://remote.example.com" } }, async ({ api }) => {
			const boot = await bootstrapOf(api);
			assert.deepEqual([...boot.server.urls], ["https://remote.example.com"]);
			assert.equal(boot.connection.state, "ready");
			assert.equal(boot.connection.source, "configured");
			const qr = await qrConfigOf(api);
			assert.deepEqual([...qr.urls], ["https://remote.example.com/m"]);
			assert.equal(qr.connection.state, "ready");
			assert.equal(qr.appDownloadUrl, "https://remote.example.com/m/api/update/apk");
			assert.equal(qr.download.state, "ready");
		});
	});
});

test("端点：webserver 实际监听在具体局域网 IP → 发布该 IP 与真实端口（web-lan）", async () => {
	await withIsolatedHome(async () => {
		const upstreamPort = await freePort();
		await withHarness({ upstreamPort, webServerHost: "192.168.50.142", config: {} }, async ({ api }) => {
			const boot = await bootstrapOf(api);
			assert.deepEqual([...boot.server.urls], [`http://192.168.50.142:${upstreamPort}`]);
			assert.equal(boot.connection.state, "ready");
			assert.equal(boot.connection.source, "web-lan");
			const qr = await qrConfigOf(api);
			assert.deepEqual([...qr.urls], [`http://192.168.50.142:${upstreamPort}/m`]);
		});
	});
});

test("端点：已监听桥通配 0.0.0.0 → 只枚举适用 IPv4 网卡，不发布通配字面量/回环", async () => {
	await withIsolatedHome(async () => {
		const bridgePort = await freePort();
		await withHarness({
			config: { lanBridge: { enabled: true, host: "0.0.0.0", port: bridgePort } },
			runtime: { phoneEndpoints: { addresses: ["192.168.50.142", "10.0.0.7", "127.0.0.1"] } },
		}, async ({ api }) => {
			await waitForBridge(api, true);
			const boot = await bootstrapOf(api);
			assert.deepEqual([...boot.server.urls], [`http://192.168.50.142:${bridgePort}`, `http://10.0.0.7:${bridgePort}`]);
			assert.equal(boot.connection.source, "lan-bridge");
			const qr = await qrConfigOf(api);
			assert.deepEqual([...qr.urls], [`http://192.168.50.142:${bridgePort}/m`, `http://10.0.0.7:${bridgePort}/m`]);
			assert.equal(JSON.stringify(boot.server.urls).includes("0.0.0.0"), false);
			assert.equal(JSON.stringify(boot.server.urls).includes("127.0.0.1"), false);
		});
	});
});

test("端点：桥仅绑回环（desktop 强制回环场景）→ 不发布桥地址；无 web-LAN 时 unavailable", async () => {
	await withIsolatedHome(async () => {
		const bridgePort = await freePort();
		await withHarness({
			config: {},
			services: { desktopBrowserAccess: { rendererHeader: { name: "x-dsh-desktop-renderer", value: "1" } } },
			runtime: { lanBridge: { candidates: [bridgePort], pickAddress: () => "127.0.0.1" } },
		}, async ({ api }) => {
			const bridge = await waitForBridge(api, true);
			assert.equal(bridge.port, bridgePort);
			const boot = await bootstrapOf(api);
			assert.deepEqual([...boot.server.urls], [], "回环桥不是手机端点");
			assert.equal(boot.connection.state, "unavailable");
			assert.equal(boot.connection.reason, "loopback-only");
			const qr = await qrConfigOf(api);
			assert.deepEqual([...qr.urls], []);
			assert.equal(qr.connection.reason, "loopback-only");
		});
	});
});

test("端点：桥启动中 → connection=starting（有界 pending，不是永久不可用），完成后转明确态", async () => {
	await withIsolatedHome(async () => {
		const bridgePort = await freePort();
		await withHarness({
			config: {},
			services: { desktopBrowserAccess: { rendererHeader: { name: "x-dsh-desktop-renderer", value: "1" } } },
			runtime: {
				lanBridge: {
					candidates: [bridgePort],
					pickAddress: () => "127.0.0.1",
					canBind: async () => {
						await new Promise((resolve) => setTimeout(resolve, 250));
						return true;
					},
				},
			},
		}, async ({ api }) => {
			// 桥仍在探测端口：ready 之前必须明确报 starting（不能假 ready、也不能画假二维码）。
			const pending = await qrConfigOf(api);
			assert.equal(pending.connection.state, "starting");
			assert.deepEqual([...pending.urls], []);
			assert.equal(pending.appDownloadUrl, null);
			// 完成后落到明确态：桥实际监听但仅回环 → loopback-only（不再 starting）。
			const bridge = await waitForBridge(api, true);
			assert.equal(bridge.phase, "listening");
			const settled = await qrConfigOf(api);
			assert.notEqual(settled.connection.state, "starting");
			assert.equal(settled.connection.reason, "loopback-only");
		});
	});
});

test("端点：桥监听失败 → 不保留任何 stale 二维码（connection=unavailable/bridge-failed）", async () => {
	await withIsolatedHome(async () => {
		const occupied = await occupyPort();
		try {
			await withHarness({
				config: { lanBridge: { enabled: true, host: "127.0.0.1", port: occupied.port } },
			}, async ({ api }) => {
				const bridge = await waitForBridgeState(api, (value) => value.reason === "listen-error");
				assert.equal(bridge.phase, "failed");
				const boot = await bootstrapOf(api);
				assert.deepEqual([...boot.server.urls], []);
				assert.equal(boot.connection.state, "unavailable");
				assert.equal(boot.connection.reason, "listen-error", "连接页应直接显示桥的稳定失败原因");
				const qr = await qrConfigOf(api);
				assert.deepEqual([...qr.urls], []);
				assert.equal(qr.appDownloadUrl, null);
			});
		} finally {
			await occupied.release();
		}
	});
});

test("端点：APK 已就绪但无手机端点 → appArtifact 保持 ok，appDownloadUrl=null，download 报 address-projection-unavailable", async () => {
	await withIsolatedHome(async (home) => {
		const updateDir = await mkdtemp(join(home, "update-no-endpoint-"));
		writeHostManifest(updateDir);
		await withHarness({ config: { updateDir } }, async ({ api }) => {
			const qr = await qrConfigOf(api);
			assert.equal(qr.appArtifact.state, "ok", "产物本身状态不得被网络不可达改写");
			assert.equal(qr.appDownloadUrl, null);
			assert.equal(qr.download.state, "missing");
			assert.equal(qr.download.reason, "address-projection-unavailable");
			assert.ok(qr.download.hint.length > 0);
		});
	});
});

test("端点：reserved 本机 URL 不进入手机候选；qr-config 方括号 IPv6 回环也不冒充手机地址", async () => {
	await withIsolatedHome(async () => {
		await withHarness({ config: {}, webServerHost: "::1" }, async ({ api }) => {
			const boot = await bootstrapOf(api);
			assert.deepEqual([...boot.server.urls], []);
			assert.notEqual(boot.connection.state, "ready");
			const qr = await qrConfigOf(api);
			assert.deepEqual([...qr.urls], []);
		});
	});
});

// ── R8（36-s1-review）补覆盖：默认端口计划 / dispose 清理与重载不留旧 listener ──

test("R8：显式 enabled=true 未配 port → 计划端口仍为 3080（旧默认语义，不静默改端口）", async () => {
	await withIsolatedHome(async () => {
		await withHarness({ config: { lanBridge: { enabled: true, host: "127.0.0.1" } } }, async ({ api }) => {
			const bridge = await waitForBridgeState(api, (value) => ["listening", "failed", "disabled", "skipped"].includes(value.phase));
			assert.equal(bridge.port, 3080, "未配 port 时旧默认 3080 必须保留");
			assert.equal(bridge.host, "127.0.0.1");
			assert.equal(bridge.source, "config");
			assert.equal(bridge.requestedMode, "on");
			// 本机 3080 常被宿主占用：允许 listen-error；空闲环境则真实监听（dispose 会关闭）。
			assert.ok(bridge.listening === true || bridge.reason === "listen-error", `实际 phase=${bridge.phase} reason=${bridge.reason}`);
		});
	});
});

test("R8：dispose 关闭 bridge listener（端口释放、无残留），重载实例可重新监听", async () => {
	await withIsolatedHome(async () => {
		const bridgePort = await freePort();
		const first = createContext({ upstreamPort: 3080 });
		apply(first.ctx, config({ lanBridge: { enabled: true, host: "127.0.0.1", port: bridgePort } }), {});
		const firstApi = apiRouteOf(first.routes);
		try {
			const bridge = await waitForBridge(firstApi, true);
			assert.equal(bridge.listening, true, "第一实例必须真实监听");
			first.dispose();
			// dispose 后端口必须释放：能重新 listen 同一端口（否则说明 listener 泄漏）。
			await new Promise((resolve) => setTimeout(resolve, 50));
			const probe = createServer();
			probe.listen(bridgePort, "127.0.0.1");
			await once(probe, "listening");
			await new Promise((resolve) => probe.close(resolve));

			// 重载（新实例，同端口）：不得因旧实例残留而 listen 失败。
			const second = createContext({ upstreamPort: 3080 });
			apply(second.ctx, config({ lanBridge: { enabled: true, host: "127.0.0.1", port: bridgePort } }), {});
			const secondApi = apiRouteOf(second.routes);
			try {
				const reloaded = await waitForBridge(secondApi, true);
				assert.equal(reloaded.listening, true, "重载实例应能重新监听同一端口");
				assert.equal(reloaded.phase, "listening");
			} finally {
				second.dispose();
			}
		} finally {
			first.dispose();
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// T16（task-21）复核修复：B1 / W1 / W2 负例 / W5 矩阵缺口 / NIT
// ═══════════════════════════════════════════════════════════════════════════

// ── W2：Desktop launch marker 负例（Electron-only 不再授权）─────────────────

test("W2：Electron 运行时 + profile 事实但缺 dsh-desktop-host argv marker → 不自动开桥", async () => {
	await withIsolatedHome(async (home) => {
		await mkdir(join(home, ".dsh", "profiles", "desktop"), { recursive: true });
		await withHarness({
			config: {},
			runtime: {
				formEvidence: {
					profileContext: desktopProfileContext(home),
					versions: DESKTOP_VERSIONS,
					hostEntry: "",
					hasDesktopBrowserAccess: false,
				},
			},
		}, async ({ api }) => {
			const diag = await diagnosticsOf(api);
			assert.equal(diag.body.runtime.form, "cli");
			assert.equal(diag.body.runtime.formSource, "unknown");
			assert.equal(diag.body.runtime.formReason, "desktop-host-marker-missing");
			assert.equal(diag.body.runtime.lanBridge.source, "auto-skipped");
			assert.equal(diag.body.runtime.lanBridge.reason, "form-unknown");
			// 诊断不得回显 argv/路径。
			const serialized = JSON.stringify(diag.body.runtime);
			assert.equal(serialized.includes("dsh-desktop-host"), false);
			assert.equal(serialized.includes(home), false);
		});
	});
});

test("W5：updateProfileDir 指向 profiles/desktop 但无宿主 marker → 不授权（拒绝配置/目录推断）", async () => {
	await withIsolatedHome(async (home) => {
		const desktopDir = join(home, ".dsh", "profiles", "desktop");
		await mkdir(desktopDir, { recursive: true });
		await withHarness({
			config: { updateProfileDir: desktopDir },
			runtime: {
				formEvidence: { profileContext: null, versions: DESKTOP_VERSIONS, hostEntry: "", hasDesktopBrowserAccess: false },
			},
		}, async ({ api }) => {
			const diag = await diagnosticsOf(api);
			assert.equal(diag.body.runtime.form, "cli");
			assert.equal(diag.body.runtime.formReason, "profile-context-missing");
			assert.equal(diag.body.runtime.lanBridge.reason, "form-unknown");
		});
	});
});

test("W5：外置 DSH_HOME（HOME 之外）的正例；host-managed 根之外的 desktop 目录 → profile-dir-untrusted", async () => {
	await withIsolatedHome(async (home) => {
		const externalHome = await mkdtemp(join(tmpdir(), "dsh-external-home-"));
		try {
			const desktopDir = join(externalHome, "profiles", "desktop");
			await mkdir(desktopDir, { recursive: true });
			const bridgePort = await freePort();
			await withHarness({
				config: {},
				runtime: {
					formEvidence: {
						profileContext: { name: "desktop", dir: desktopDir, home: externalHome },
						versions: DESKTOP_VERSIONS,
						hostEntry: DESKTOP_HOST_ENTRY,
						hasDesktopBrowserAccess: false,
					},
					lanBridge: { candidates: [bridgePort], pickAddress: () => "127.0.0.1" },
				},
			}, async ({ api }) => {
				const bridge = await waitForBridge(api, true);
				assert.equal(bridge.source, "auto-desktop");
				const diag = await diagnosticsOf(api);
				assert.equal(diag.body.runtime.form, "desktop");
				assert.equal(diag.body.runtime.formSource, "desktop-profile");
			});

			// 反例：dir 在外部 home 的 profiles/web（非 desktop 实际目录语义），必须 fail-closed。
			const webDir = join(externalHome, "profiles", "web");
			await mkdir(webDir, { recursive: true });
			await withHarness({
				config: {},
				runtime: {
					formEvidence: {
						profileContext: { name: "desktop", dir: webDir, home: externalHome },
						versions: DESKTOP_VERSIONS,
						hostEntry: DESKTOP_HOST_ENTRY,
						hasDesktopBrowserAccess: false,
					},
				},
			}, async ({ api }) => {
				const diag = await diagnosticsOf(api);
				assert.equal(diag.body.runtime.formReason, "profile-dir-untrusted");
			});
		} finally {
			await rm(externalHome, { recursive: true, force: true });
		}
	});
});

// ── W5：合并层配置三态（bundle/home/profile/overlay 有效 false）─────────────

test("W5：合并层显式 false（来自任一层）永远压过 Desktop fallback；仅 host/port 不变成 false", async () => {
	await withIsolatedHome(async (home) => {
		await mkdir(join(home, ".dsh", "profiles", "desktop"), { recursive: true });
		const trusted = {
			profileContext: desktopProfileContext(home),
			versions: DESKTOP_VERSIONS,
			hostEntry: DESKTOP_HOST_ENTRY,
			hasDesktopBrowserAccess: false,
		};
		// 模拟 bundle/home/profile/overlay 合并后的有效配置：home 层 enabled:false，profile 层有 port。
		const mergedOff = config();
		mergedOff.lanBridge = { enabled: false, port: 3081, host: "0.0.0.0" };
		await withHarness({ config: mergedOff, runtime: { formEvidence: trusted } }, async ({ api }) => {
			const bridge = (await diagnosticsOf(api)).body.runtime.lanBridge;
			assert.equal(bridge.enabled, false);
			assert.equal(bridge.source, "config");
			assert.equal(bridge.requestedMode, "off");
			assert.equal(bridge.reason, "disabled-by-config");
		});
		// 仅 host/port（无 enabled）≠ 显式 false：可信 Desktop 仍 auto 开桥。
		const bridgePort = await freePort();
		const mergedAuto = config();
		mergedAuto.lanBridge = { host: "0.0.0.0", port: bridgePort };
		await withHarness({
			config: mergedAuto,
			runtime: { formEvidence: trusted, lanBridge: { pickAddress: () => "127.0.0.1" } },
		}, async ({ api }) => {
			const bridge = await waitForBridgeState(api, (value) => ["listening", "failed"].includes(value.phase));
			assert.equal(bridge.requestedMode, "auto");
			assert.equal(bridge.source, "auto-desktop");
			assert.equal(bridge.port, bridgePort);
		});
	});
});

// ── B1：下载面独立于控制连接认证 ────────────────────────────────────────────

test("B1：auth 自动生成失败 + 端点 ready + APK ok → 下载码仍有效；connection 不可用；匿名 APK 权限不扩大", { skip: asRoot ? "root 无视权限位" : false }, async () => {
	const base = await mkdtemp(join(tmpdir(), "dsh-b1-fixture-"));
	const updateDir = join(base, "update");
	const fixture = writeHostManifest(updateDir);
	const home = await mkdtemp(join(tmpdir(), "dsh-b1-home-"));
	const saved = { HOME: process.env.HOME, DSH_HOME: process.env.DSH_HOME };
	try {
		await chmod(home, 0o500); // 状态目录不可写 → 口令自动生成失败
		process.env.HOME = home;
		process.env.DSH_HOME = join(home, ".dsh");
		await withHarness({ config: { updateDir, publicOrigin: "https://remote.example.com", authToken: "" } }, async ({ api }) => {
			const qr = await qrConfigOf(api);
			// 端点与 APK 都 ready：匿名下载码必须存在且正确。
			assert.deepEqual([...qr.urls], ["https://remote.example.com/m"]);
			assert.equal(qr.appDownloadUrl, "https://remote.example.com/m/api/update/apk");
			assert.equal(qr.download.state, "ready");
			assert.equal(qr.appArtifact.state, "ok");
			// 控制连接因认证不可用 → unavailable（独立表达，不误伤下载）。
			assert.equal(qr.connection.state, "unavailable");
			assert.equal(qr.connection.reason, "auth-token-unavailable");
			// bootstrap 受保护：fail-closed 401 auth-not-configured（不因下载独立而放宽）。
			const boot = await request(api, { url: "/m/api/bootstrap", headers: { "x-mobile-token": "x".repeat(16) } });
			assert.equal(boot.status, 401);
			assert.equal(boot.json().error, "auth-not-configured");
			// 其它移动接口仍 401（权限未扩大）。
			const diag = await request(api, { url: "/m/api/diagnostics", headers: { "x-mobile-token": "x".repeat(16) } });
			assert.equal(diag.status, 401);
			// 匿名例外仍只有既有精确 APK 路由：GET 可用、别的写方法/路由不放宽。
			const apk = await request(api, { url: "/m/api/update/apk" });
			assert.equal(apk.status, 200);
			assert.deepEqual(apk.body, fixture.bytes);
			const apkHead = await request(api, { url: "/m/api/update/apk", method: "HEAD" });
			assert.equal(apkHead.status, 200);
			const apkPost = await request(api, { url: "/m/api/update/apk", method: "POST" });
			assert.equal(apkPost.status, 401, "匿名例外只覆盖精确 GET/HEAD，POST 仍被认证围栏拒绝");
			const qrPng = await request(api, { url: "/m/qr.png?text=x" });
			assert.equal(qrPng.status, 401, "qr.png 仍需本机特权/口令围栏，不因下载独立放宽");
		});
	} finally {
		if (saved.HOME === undefined) delete process.env.HOME;
		else process.env.HOME = saved.HOME;
		if (saved.DSH_HOME === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = saved.DSH_HOME;
		await chmod(home, 0o700);
		await rm(home, { recursive: true, force: true });
		await rm(base, { recursive: true, force: true });
	}
});

// ── W1：公开更新投影不得从 Host/trustedHosts 推断端口 ──────────────────────

/** schema-1 清单 + app/plugin 段（用于验证 URL 投影）。 */
async function writeSchema1Manifest(dir) {
	await mkdir(dir, { recursive: true });
	const apkBytes = Buffer.from("w1-fixture-apk\n");
	const tgzBytes = Buffer.from("w1-fixture-plugin-tgz\n");
	await writeFile(join(dir, "mobile.apk"), apkBytes);
	await writeFile(join(dir, "plugin.tgz"), tgzBytes);
	await writeFile(join(dir, "manifest.json"), JSON.stringify({
		schema: 1,
		version: "3.2.0+57",
		apk: "mobile.apk",
		size: apkBytes.length,
		sha256: sha256(apkBytes),
		app: { version: "3.2.0+57", file: "mobile.apk", size: apkBytes.length, sha256: sha256(apkBytes) },
		plugin: { version: "3.2.0", file: "plugin.tgz", size: tgzBytes.length, sha256: sha256(tgzBytes) },
	}));
	return { apkBytes, tgzBytes };
}

test("W1：伪造 Host:loopback:9999 / trustedHosts:9999 不得进入 manifest/bootstrap 公开投影", async () => {
	await withIsolatedHome(async (home) => {
		const updateDir = join(home, "update-w1");
		await writeSchema1Manifest(updateDir);
		await withHarness({ config: { updateDir } }, async ({ api }) => {
			// loopback webserver、无桥、无 publicOrigin：Host 端口伪造必须被忽略。
			const forgedLoopback = await request(api, {
				url: "/m/api/update/manifest",
				host: "127.0.0.1:9999",
				headers: { "x-mobile-token": TOKEN },
			});
			assert.equal(forgedLoopback.status, 200);
			assert.equal(JSON.stringify(forgedLoopback.json()).includes(":9999"), false, "不得从 Host 端口派生公开 URL");
			const boot = await request(api, {
				url: "/m/api/bootstrap",
				host: "127.0.0.1:9999",
				headers: { "x-mobile-token": TOKEN },
			});
			assert.equal(boot.status, 200);
			assert.equal(JSON.stringify(boot.json()).includes(":9999"), false);
			// 本机直连兼容投影只能使用真实监听端口（3080），不得出现 Host 注入的 9999。
			if (boot.json().currentRelease) {
				assert.equal(JSON.stringify(boot.json().currentRelease).includes(":3080"), true);
			}
			assert.deepEqual([...boot.json().server.urls], [], "手机端点列表仍为空（loopback 不是手机端点）");
		});

		// trustedHosts 只是主机名白名单，不是代理身份：Host 端口同样不能成为公开基址。
		await withHarness({ config: { updateDir, trustedHosts: ["proxy.example.com"] } }, async ({ api }) => {
			const forgedTrusted = await request(api, {
				url: "/m/api/update/manifest",
				host: "proxy.example.com:9999",
				headers: { "x-mobile-token": TOKEN },
			});
			assert.equal(forgedTrusted.status, 200);
			assert.equal(JSON.stringify(forgedTrusted.json()).includes(":9999"), false);
		});

		// 正例：显式 publicOrigin 才能生成手机可见绝对地址（也证明投影链路仍工作）。
		await withHarness({ config: { updateDir, publicOrigin: "https://remote.example.com" } }, async ({ api }) => {
			const body = (await request(api, { url: "/m/api/update/manifest", headers: { "x-mobile-token": TOKEN } })).json();
			assert.equal(body.manifest.app.url, "https://remote.example.com/m/api/update/apk");
			assert.equal(body.manifest.plugin.url, "https://remote.example.com/m/api/update/plugin");
		});
	});
});

// ── W5：artifact missing × endpoint ready/unavailable 组合 ──────────────────

test("W5：artifact missing × endpoint ready → appArtifact missing、appDownloadUrl null、download 报 artifacts 原因", async () => {
	await withIsolatedHome(async (home) => {
		const emptyDir = join(home, "update-empty");
		await mkdir(emptyDir, { recursive: true });
		await withHarness({ config: { updateDir: emptyDir, publicOrigin: "https://remote.example.com" } }, async ({ api }) => {
			const qr = await qrConfigOf(api);
			assert.equal(qr.connection.state, "ready");
			assert.equal(qr.appArtifact.state, "missing");
			assert.equal(qr.appDownloadUrl, null);
			assert.equal(qr.download.state, "missing");
			// reason 必须是稳定代号，且保持产物自身原因（不是网络投影原因）。
			assert.match(qr.download.reason, /^[a-z0-9][a-z0-9._-]{0,63}$/);
			assert.notEqual(qr.download.reason, "address-projection-unavailable");
		});
	});
});

test("W5：artifact missing × endpoint unavailable → appArtifact 仍 missing（不被网络原因覆写）、download 独立", async () => {
	await withIsolatedHome(async () => {
		await withHarness({ config: {} }, async ({ api }) => {
			const qr = await qrConfigOf(api);
			assert.equal(qr.connection.state, "unavailable");
			assert.equal(qr.appArtifact.state, "missing");
			assert.equal(qr.appDownloadUrl, null);
			assert.equal(qr.download.state, "missing");
			// 无端点时 download.reason 保持产物自身原因，而不是 address-projection-unavailable。
			assert.notEqual(qr.download.reason, "address-projection-unavailable");
		});
	});
});

test("W2（T16 rev6）：生产路径 argv（Electron-as-Node 真实形状）能识别 dsh-desktop-host marker → auto-desktop", async () => {
	await withIsolatedHome(async (home) => {
		await mkdir(join(home, ".dsh", "profiles", "desktop"), { recursive: true });
		const bridgePort = await freePort();
		const runtimeDir = "C:\\Program Files\\DeepSeek\\DeepSeek Harness\\resources\\app.asar\\dsh";
		const hostEntry = `${runtimeDir}\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js`;
		// 实测 ELECTRON_RUN_AS_NODE=1 时 process.argv = [exe, entry, runtimeDir, projectDir, primaryRuntime, ...]；
		// --expose-internals 在 process.execArgv，不在 argv。这里用同一形状验证生产推导（不传 hostEntry seam）。
		const argv = [
			"C:\\Program Files\\DeepSeek\\DeepSeek Harness\\DeepSeek Harness.exe",
			hostEntry,
			runtimeDir,
			join(home, ".dsh", "profiles", "desktop"),
			"C:\\Program Files\\DeepSeek\\DeepSeek Harness\\resources\\runtime\\primary-runtime",
			"C:\\Program Files\\DeepSeek\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\dependencies\\pnpm\\bin\\pnpm.mjs",
			"C:\\Program Files\\DeepSeek\\DeepSeek Harness\\resources\\runtime\\bin",
		];
		await withHarness({
			config: {},
			runtime: {
				formEvidence: {
					profileContext: desktopProfileContext(home),
					versions: DESKTOP_VERSIONS,
					argv,
					hasDesktopBrowserAccess: false,
				},
				lanBridge: { candidates: [bridgePort], pickAddress: () => "127.0.0.1" },
			},
		}, async ({ api }) => {
			const bridge = await waitForBridge(api, true);
			assert.equal(bridge.source, "auto-desktop");
			const diag = await diagnosticsOf(api);
			assert.equal(diag.body.runtime.formSource, "desktop-profile");
			assert.equal(diag.body.runtime.formReason, "");
		});
	});
});

test("W2（T16 rev6）：通用 Electron argv（非 dsh-desktop-host 入口）→ fail-closed", async () => {
	await withIsolatedHome(async (home) => {
		await mkdir(join(home, ".dsh", "profiles", "desktop"), { recursive: true });
		await withHarness({
			config: {},
			runtime: {
				formEvidence: {
					profileContext: desktopProfileContext(home),
					versions: DESKTOP_VERSIONS,
					argv: ["C:\\SomeElectronApp\\app.exe", "C:\\SomeElectronApp\\resources\\app.asar\\main.js", "arg1"],
					hasDesktopBrowserAccess: false,
				},
			},
		}, async ({ api }) => {
			const diag = await diagnosticsOf(api);
			assert.equal(diag.body.runtime.form, "cli");
			assert.equal(diag.body.runtime.formReason, "desktop-host-marker-missing");
			assert.equal(diag.body.runtime.lanBridge.source, "auto-skipped");
			assert.equal(diag.body.runtime.lanBridge.reason, "form-unknown");
		});
	});
});

// ── W1（reopen 复核）：loopback-only listener 下，Host 不能伪造本机网卡的 LAN 公开地址 ──

test("W1：loopback-only + 伪造 Host=<本机真实网卡IP>:<真实web端口> → 不得生成 LAN 公开 URL", async () => {
	const lanAddresses = Object.values(networkInterfaces())
		.flatMap((entries) => entries ?? [])
		.filter((entry) => entry.family === "IPv4" && !entry.internal)
		.map((entry) => entry.address);
	if (lanAddresses.length === 0) return; // 无外部 IPv4 环境：该风险无法构造，跳过
	const lanIp = lanAddresses[0];
	await withIsolatedHome(async (home) => {
		const updateDir = join(home, "w1-lan-host");
		await writeFile(join(updateDir, "x"), "x").catch(() => {});
		await mkdir(updateDir, { recursive: true });
		const apkBytes = Buffer.from("w1-lan-apk\n");
		await writeFile(join(updateDir, "mobile.apk"), apkBytes);
		await writeFile(join(updateDir, "manifest.json"), JSON.stringify({
			version: "3.2.0+57",
			apk: "mobile.apk",
			size: apkBytes.length,
			sha256: sha256(apkBytes),
			notes: "w1 forged LAN host",
		}));
		// webserver 只绑回环（fake ctx host=127.0.0.1）；伪造 Host 用本机真实网卡 IP + 真实端口。
		await withHarness({ config: { updateDir } }, async ({ api }) => {
			const manifest = await request(api, {
				url: "/m/api/update/manifest",
				host: `${lanIp}:3080`,
				headers: { "x-mobile-token": TOKEN },
			});
			assert.equal(manifest.status, 200);
			const manifestText = JSON.stringify(manifest.json());
			assert.equal(manifestText.includes(`${lanIp}:3080`), false, "loopback-only 时不得把本机网卡 IP 拼成公开地址");
			const boot = await request(api, {
				url: "/m/api/bootstrap",
				host: `${lanIp}:3080`,
				headers: { "x-mobile-token": TOKEN },
			});
			assert.equal(boot.status, 200);
			assert.equal(JSON.stringify(boot.json()).includes(`${lanIp}:3080`), false);
			assert.deepEqual([...boot.json().server.urls], [], "server.urls 仍为空（loopback 不是手机端点）");
			// 伪造非回环 Host 也不能借 trustedHosts 变成公开基址。
			const trusted = await request(api, {
				url: "/m/api/update/manifest",
				host: `proxy.example.com:3080`,
				headers: { "x-mobile-token": TOKEN },
			});
			if (trusted.status === 200) {
				assert.equal(JSON.stringify(trusted.json()).includes("proxy.example.com"), false);
			}
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// T17/task-24：收口 T18 的 W1-b / W5-a（W3-a 客户端见 qr-client-payload）
// ═══════════════════════════════════════════════════════════════════════════

// ── W1-b：wildcard 多网卡按请求来源在既有 origins 内选择 ─────────────────────

test("W1-b helper：orderEndpointOrigins 只在既有 origins 内按 bridge/Host 选择，绝不构造新 IP/端口", () => {
	const origins = ["http://192.168.50.142:39401", "http://10.0.0.7:39401"];
	assert.deepEqual(orderEndpointOrigins(origins, { hostname: "10.0.0.7" }), [origins[1], origins[0]]);
	assert.deepEqual(orderEndpointOrigins(origins, { bridgeLocalAddress: "10.0.0.7" }), [origins[1], origins[0]]);
	// bridge 事实优先于 Host。
	assert.deepEqual(
		orderEndpointOrigins(origins, { bridgeLocalAddress: "10.0.0.7", hostname: "192.168.50.142" }),
		[origins[1], origins[0]],
	);
	// Host 端口伪造只按主机名匹配，返回的仍是既有 origin（真实端口）。
	assert.deepEqual(orderEndpointOrigins(origins, { hostname: "10.0.0.7:9999" }), [origins[1], origins[0]]);
	// 未知 host / 未知 bridge 地址 → 原顺序，且元素集合完全一致。
	assert.deepEqual(orderEndpointOrigins(origins, { hostname: "192.168.1.2", bridgeLocalAddress: "10.9.9.9" }), origins);
	const reordered = orderEndpointOrigins(origins, { hostname: "10.0.0.7" });
	assert.equal(reordered.every((origin) => origins.includes(origin)), true, "不得构造新 origin");
	assert.deepEqual([...new Set(reordered)].sort(), [...origins].sort());
});

test("W1-b HTTP：wildcard 多网卡时 manifest/currentRelease 按请求 Host 选择已监听 origin（端口不被 Host 改写）", async () => {
	await withIsolatedHome(async (home) => {
		const updateDir = join(home, "w1b-multinic-update");
		await writeSchema1Manifest(updateDir);
		const upstreamPort = await freePort();
		await withHarness({
			upstreamPort,
			// 真实 webserver 绑定通配 0.0.0.0（web 版形态），endpoint 枚举出两块网卡。
			webServerHost: "0.0.0.0",
			config: { updateDir, trustedHosts: ["10.0.0.7", "192.168.50.142", "10.9.9.9"] },
			runtime: { phoneEndpoints: { addresses: ["192.168.50.142", "10.0.0.7"] } },
		}, async ({ api }) => {
			// 请求来自第二块网卡 → 使用第二 origin。
			const second = await request(api, {
				url: "/m/api/update/manifest",
				host: `10.0.0.7:${upstreamPort}`,
				headers: { "x-mobile-token": TOKEN },
			});
			assert.equal(second.status, 200);
			assert.equal(second.json().manifest.app.url, `http://10.0.0.7:${upstreamPort}/m/api/update/apk`);
			const bootSecond = await request(api, {
				url: "/m/api/bootstrap",
				host: `10.0.0.7:${upstreamPort}`,
				headers: { "x-mobile-token": TOKEN },
			});
			assert.equal(bootSecond.json().server.urls[0], `http://10.0.0.7:${upstreamPort}`);

			// 请求来自第一块网卡 → 第一 origin。
			const first = await request(api, {
				url: "/m/api/update/manifest",
				host: `192.168.50.142:${upstreamPort}`,
				headers: { "x-mobile-token": TOKEN },
			});
			assert.equal(first.json().manifest.app.url, `http://192.168.50.142:${upstreamPort}/m/api/update/apk`);

			// 伪造端口不改写真实端点端口（仍是 endpoint 的真实端口）。
			const forged = await request(api, {
				url: "/m/api/update/manifest",
				host: "10.0.0.7:9999",
				headers: { "x-mobile-token": TOKEN },
			});
			assert.equal(JSON.stringify(forged.json()).includes(":9999"), false);
			assert.equal(forged.json().manifest.app.url, `http://10.0.0.7:${upstreamPort}/m/api/update/apk`);

			// Host 主机名不在 origin 集合（但通过 Host 白名单）→ 回退 origins[0]，不构造新地址。
			const unknown = await request(api, {
				url: "/m/api/update/manifest",
				host: `10.9.9.9:${upstreamPort}`,
				headers: { "x-mobile-token": TOKEN },
			});
			assert.equal(unknown.status, 200);
			assert.equal(unknown.json().manifest.app.url, `http://192.168.50.142:${upstreamPort}/m/api/update/apk`);
		});
	});
});

// ── W5-a#1：真实 Config schema 三态（层叠最终值）────────────────────────────

test("W5-a#1：真实 Config schema——有效 false 明确 off；仅 host/port 不合成 enabled；最终 typed Config 传入 apply 生效", async () => {
	// 本仓测试无法运行 dsh 宿主的 bundle/home/profile/overlay patch composer（在宿主进程内）；
	// 这里以宿主合并后的**最终 YAML 值**喂真实 schemastery Config，验证 typed 边界，再传入 apply。
	const layeredOff = Config({ path: "/m", lanBridge: { enabled: false, port: 3081, host: "0.0.0.0" } });
	assert.equal(layeredOff.lanBridge.enabled, false);
	assert.equal(layeredOff.lanBridge.port, 3081);
	const layeredPartial = Config({ path: "/m", lanBridge: { host: "0.0.0.0", port: 3081 } });
	assert.equal(layeredPartial.lanBridge.enabled, undefined, "仅 host/port 不得被 schema 合成 enabled");
	const layeredMissing = Config({ path: "/m" });
	assert.equal(layeredMissing.lanBridge.enabled, undefined);
	assert.equal(layeredMissing.lanBridge.port, undefined);

	await withIsolatedHome(async (home) => {
		await mkdir(join(home, ".dsh", "profiles", "desktop"), { recursive: true });
		const trusted = {
			profileContext: desktopProfileContext(home),
			versions: DESKTOP_VERSIONS,
			hostEntry: DESKTOP_HOST_ENTRY,
			hasDesktopBrowserAccess: false,
		};
		// 有效 false（来自任一层，最终 typed 值）→ 明确 off，不被 Desktop fallback 覆盖。
		await withHarness({
			config: { lanBridge: { enabled: layeredOff.lanBridge.enabled, port: layeredOff.lanBridge.port, host: layeredOff.lanBridge.host } },
			runtime: { formEvidence: trusted },
		}, async ({ api }) => {
			const bridge = (await diagnosticsOf(api)).body.runtime.lanBridge;
			assert.equal(bridge.requestedMode, "off");
			assert.equal(bridge.enabled, false);
			assert.equal(bridge.source, "config");
		});
		// 仅 port/host（enabled 未合成）→ 仍是 auto（可信 Desktop 下自动开）。
		const bridgePort = await freePort();
		await withHarness({
			config: { lanBridge: { host: layeredPartial.lanBridge.host, port: bridgePort } },
			runtime: { formEvidence: trusted, lanBridge: { pickAddress: () => "127.0.0.1" } },
		}, async ({ api }) => {
			const bridge = await waitForBridgeState(api, (value) => ["listening", "failed"].includes(value.phase));
			assert.equal(bridge.requestedMode, "auto");
			assert.equal(bridge.source, "auto-desktop");
			assert.equal(bridge.port, bridgePort);
		});
	});
});

// ── W5-a#2：外置 DSH_HOME env（HOME 外）不参与形态授权 ──────────────────────

test("W5-a#2：外置 DSH_HOME env + profileContext 实际 home/dir：形态只信宿主事实；resolveDshHome 限制不变", async () => {
	await withIsolatedHome(async (home) => {
		const externalHome = await mkdtemp(join(tmpdir(), "w5a-external-dsh-"));
		const saved = process.env.DSH_HOME;
		try {
			const desktopDir = join(externalHome, "profiles", "desktop");
			await mkdir(desktopDir, { recursive: true });
			process.env.DSH_HOME = externalHome; // HOME 之外的宿主 home
			// 既有 resolveDshHome 限制不变：HOME 外的 DSH_HOME 不被采信。
			assert.equal(resolveDshHome(), join(home, ".dsh"));

			// 形态授权只来自 profileContext + marker + Electron（与 env 指向何处无关）。
			const bridgePort = await freePort();
			const profileContext = { name: "desktop", dir: desktopDir, home: externalHome };
			await withHarness({
				config: {},
				// 真实宿主同样经 ctx 提供 profileContext（profileKey 也用它落盘）。
				services: { profileContext },
				runtime: {
					formEvidence: {
						profileContext,
						versions: DESKTOP_VERSIONS,
						hostEntry: DESKTOP_HOST_ENTRY,
						hasDesktopBrowserAccess: false,
					},
					lanBridge: { candidates: [bridgePort], pickAddress: () => "127.0.0.1" },
				},
			}, async ({ api }) => {
				const bridge = await waitForBridge(api, true);
				assert.equal(bridge.source, "auto-desktop");
				// 桥端点持久化仍落在 resolveDshHome(HOME/.dsh)，未写外置 home。
				assert.deepEqual(readPersistedBridge({ dshHome: join(home, ".dsh"), profileKey: "desktop" }), { port: bridgePort, host: "127.0.0.1" });
				assert.equal(existsSync(join(externalHome, "mobile-remote")), false, "不得把 env 外置 home 当成状态目录捷径");
			});

			// 同一 env / 同一外置 desktop 目录，但无 profileContext + 无 marker → 仍 fail-closed。
			await withHarness({
				config: {},
				runtime: {
					formEvidence: {
						profileContext: null,
						versions: DESKTOP_VERSIONS,
						hostEntry: "",
						hasDesktopBrowserAccess: false,
					},
				},
			}, async ({ api }) => {
				const diag = await diagnosticsOf(api);
				assert.equal(diag.body.runtime.form, "cli");
				assert.equal(diag.body.runtime.lanBridge.source, "auto-skipped");
			});
		} finally {
			if (saved === undefined) delete process.env.DSH_HOME;
			else process.env.DSH_HOME = saved;
			await rm(externalHome, { recursive: true, force: true });
		}
	});
});

// ── W5-a#3：updateProfileDir 指向 desktop + Electron 仍不授权 ───────────────

test("W5-a#3：仅 updateProfileDir 指向 profiles/desktop + Electron，无可信 profileContext/argv marker → fail-closed", async () => {
	await withIsolatedHome(async (home) => {
		const desktopDir = join(home, ".dsh", "profiles", "desktop");
		await mkdir(desktopDir, { recursive: true });
		await withHarness({
			config: { updateProfileDir: desktopDir },
			runtime: {
				formEvidence: {
					profileContext: null,
					versions: DESKTOP_VERSIONS,
					argv: ["C:\\SomeElectron\\app.exe", "C:\\SomeElectron\\resources\\app.asar\\main.js"],
					hasDesktopBrowserAccess: false,
				},
			},
		}, async ({ api }) => {
			const diag = await diagnosticsOf(api);
			assert.equal(diag.body.runtime.form, "cli");
			assert.equal(diag.body.runtime.formSource, "unknown");
			assert.equal(diag.body.runtime.formReason, "profile-context-missing");
			assert.equal(diag.body.runtime.lanBridge.source, "auto-skipped");
			assert.equal(diag.body.runtime.lanBridge.reason, "form-unknown");
		});
	});
});

// ── W5-a#4：qr-config artifact ok/missing/mismatch × endpoint ready/unavailable ──

/** 真实托管区夹具（publishRelease + selectRelease），用于 artfact mismatch 组合。 */
async function makeCarrierArtifactFixture() {
	const base = await mkdtemp(join(tmpdir(), "w5a-carrier-"));
	const carrierDir = join(base, "update");
	const profileDir = join(base, "profile-web");
	await mkdir(carrierDir, { recursive: true });
	await mkdir(profileDir, { recursive: true });
	await writeFile(join(profileDir, "package.json"), JSON.stringify({
		name: "web-profile",
		dependencies: { [PLUGIN_NAME]: "file:/fixture-plugin" },
	}));
	const apkBytes = Buffer.from("w5a-fixture-apk\n");
	const tgzBytes = Buffer.from("w5a-fixture-tgz\n");
	const manifest = {
		schema: 1,
		version: "3.2.0+57",
		apk: "app.apk",
		size: apkBytes.length,
		sha256: sha256(apkBytes),
		app: { version: "3.2.0+57", file: "app.apk", size: apkBytes.length, sha256: sha256(apkBytes) },
		plugin: {
			version: PLUGIN_VERSION,
			file: "plugin.tgz",
			size: tgzBytes.length,
			sha256: sha256(tgzBytes),
			contentSha256: pluginContentDigest(WORKTREE_ROOT),
		},
	};
	const artifacts = join(base, "artifacts");
	await mkdir(artifacts, { recursive: true });
	const appPath = join(artifacts, "app.apk");
	const pluginPath = join(artifacts, "plugin.tgz");
	await writeFile(appPath, apkBytes);
	await writeFile(pluginPath, tgzBytes);
	const profileKey = basename(profileDir);
	const published = publishRelease({ updateDir: carrierDir, manifest, appPath, pluginPath, source: "manual", profileKey, profileDir });
	assert.equal(published.ok, true, JSON.stringify(published));
	const selected = selectRelease({ updateDir: carrierDir, profileKey, releaseId: published.releaseId, profileDir });
	assert.equal(selected.ok, true, JSON.stringify(selected));
	return {
		base,
		carrierDir,
		profileDir,
		apkBytes,
		appObjectPath: join(carrierDir, ".app-carrier", "objects", "apk", manifest.app.sha256, "app.apk"),
	};
}

test("W5-a#4：qr-config artifact mismatch × endpoint ready/unavailable（appArtifact 保真、下载仅 endpoint+ok 才 ready）", async () => {
	const fixture = await makeCarrierArtifactFixture();
	const emptyDir = await mkdtemp(join(tmpdir(), "w5a-empty-update-"));
	try {
		// endpoint ready（publicOrigin）+ 初始 ok。
		await withHarness({
			config: { updateDir: fixture.carrierDir, updateProfileDir: fixture.profileDir, publicOrigin: "https://remote.example.com" },
		}, async ({ api }) => {
			const ok = await qrConfigOf(api);
			assert.equal(ok.appArtifact.state, "ok");
			assert.equal(ok.connection.state, "ready");
			assert.equal(ok.download.state, "ready");
			assert.equal(ok.appDownloadUrl, "https://remote.example.com/m/api/update/apk");

			// 篡改托管区当前发布 APK（size 变化）→ mismatch。
			await chmod(fixture.appObjectPath, 0o644);
			await writeFile(fixture.appObjectPath, Buffer.concat([fixture.apkBytes, Buffer.from("tampered")]));
			const mismatch = await qrConfigOf(api);
			assert.equal(mismatch.appArtifact.state, "mismatch", "appArtifact 必须报告 artifact 自身状态");
			assert.equal(mismatch.appArtifact.reason, "app-size-mismatch");
			assert.equal(mismatch.connection.state, "ready", "端点仍 ready");
			assert.equal(mismatch.appDownloadUrl, null, "mismatch 不得生成下载地址");
			assert.equal(mismatch.download.state, "mismatch");
			assert.ok(mismatch.download.reason.length > 0);
		});
		// endpoint unavailable（loopback-only）→ 同一 artifact 状态不被网络原因覆写。
		await withHarness({
			config: { updateDir: fixture.carrierDir, updateProfileDir: fixture.profileDir },
		}, async ({ api }) => {
			const mismatch = await qrConfigOf(api);
			assert.equal(mismatch.appArtifact.state, "mismatch");
			assert.equal(mismatch.connection.state, "unavailable");
			assert.equal(mismatch.appDownloadUrl, null);
			assert.equal(mismatch.download.state, "mismatch");
		});
		// missing × endpoint ready / unavailable。
		await withHarness({
			config: { updateDir: emptyDir, publicOrigin: "https://remote.example.com" },
		}, async ({ api }) => {
			const missingReady = await qrConfigOf(api);
			assert.equal(missingReady.connection.state, "ready");
			assert.equal(missingReady.appArtifact.state, "missing");
			assert.equal(missingReady.appDownloadUrl, null);
			assert.equal(missingReady.download.state, "missing");
		});
		await withHarness({ config: { updateDir: emptyDir } }, async ({ api }) => {
			const missingUnavailable = await qrConfigOf(api);
			assert.equal(missingUnavailable.connection.state, "unavailable");
			assert.equal(missingUnavailable.appArtifact.state, "missing");
			assert.equal(missingUnavailable.appDownloadUrl, null);
			assert.equal(missingUnavailable.download.state, "missing");
		});
	} finally {
		await rm(fixture.base, { recursive: true, force: true });
		await rm(emptyDir, { recursive: true, force: true });
	}
});
