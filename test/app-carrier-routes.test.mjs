// #35 下载面接线契约（设计稿 §5.3/§5.6/§5.7/§5.10）：
//   - 匿名 APK：无参数=当前发布；release+sha256=固定目标（绝不回落 current/latest）；
//   - Range / ETag / HEAD；流开始后 fd 固定，不每组请求重算整文件哈希；
//   - 匿名例外只匹配精确 APK 下载路由 + GET/HEAD，其它移动接口仍鉴权；
//   - 空口令自动生成（存插件状态）→ 401 auth-required；生成失败 → 401 auth-not-configured；
//   - 地址投影只按实际网卡/监听端口或显式 publicOrigin，不采信 Host 之外的转发头；
//   - bootstrap 四字段（currentRelease / currentReleaseHealth / updateTarget / appArtifact）。
//
// 与 test/update-routes.test.mjs 同款 harness：apply + 假 ctx + MockResponse；store 用真实
// 托管区 module 建夹具（publishRelease + selectRelease），断言的是 HTTP 契约而不是实现细节。
import assert from "node:assert/strict";
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, basename } from "node:path";
import { Writable } from "node:stream";
import { once } from "node:events";
import { test } from "node:test";
import { pluginContentDigest } from "../lib/plugin-content-digest.js";
import {
	publishRelease,
	releaseIdentityFromManifest,
	selectRelease,
} from "../lib/app-carrier-store.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const COOKIE_NAME = "dsh_mobile_token";
const PLUGIN_NAME = "@marktrue/dsh-mobile-remote";
const PLUGIN_VERSION = "3.2.0";
const WORKTREE_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** 本实例"实际运行内容"标识：与 apply 内部算出的 selfContentSha256 必须一致。 */
const RUNNING_CONTENT = pluginContentDigest(WORKTREE_ROOT);

const APK_BYTES = (() => {
	const buffer = Buffer.alloc(64 * 1024);
	for (let i = 0; i < buffer.length; i++) buffer[i] = (i * 37 + 11) & 0xff;
	return buffer;
})();
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
		lanBridge: { enabled: false, host: "127.0.0.1", port: 3080 },
		publicOrigin: "",
		...over,
	};
}

function createContext({ upstreamPort = 3080 } = {}) {
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
	return routes.find((route) => route.kind === "prefix" && route.path === "/m/api") ??
		routes.find((route) => route.kind === "prefix");
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
	const { config: overrides = {}, runtime = {} } = options ?? {};
	const harness = createContext();
	apply(harness.ctx, config(overrides), runtime);
	try {
		return await callback({ ...harness, api: apiRouteOf(harness.routes) });
	} finally {
		harness.dispose();
	}
}

function manifestFor({ appVersion, appBytes = APK_BYTES, tgzBytes }) {
	return {
		schema: 1,
		version: appVersion,
		apk: "mobile.apk",
		size: appBytes.length,
		sha256: sha256(appBytes),
		app: { version: appVersion, file: "mobile.apk", size: appBytes.length, sha256: sha256(appBytes) },
		plugin: {
			version: PLUGIN_VERSION,
			file: "plugin.tgz",
			size: tgzBytes.length,
			sha256: sha256(tgzBytes),
			contentSha256: RUNNING_CONTENT,
		},
	};
}

/** 真实托管区夹具：publishRelease（不可变对象 + release 记录）+ selectRelease（current 指针）。 */
async function makeStoreFixture({ versions = ["3.2.0+9"] } = {}) {
	const base = await mkdtemp(join(tmpdir(), "dsh-carrier-routes-"));
	const carrierDir = join(base, "update");
	const profileDir = join(base, "profile-web");
	await mkdir(carrierDir, { recursive: true });
	await mkdir(profileDir, { recursive: true });
	await writeFile(join(profileDir, "package.json"), JSON.stringify({
		name: "web-profile",
		dependencies: { [PLUGIN_NAME]: "file:/fixture-plugin" },
	}));
	const releases = [];
	const profileKey = basename(profileDir);
	for (const [index, appVersion] of versions.entries()) {
		const appBytes = Buffer.from(APK_BYTES);
		appBytes[0] = (appBytes[0] + index) & 0xff;
		const tgzBytes = Buffer.from(`fixture-plugin-tgz-${index}\n`);
		const artifactsDir = join(base, `artifacts-${index}`);
		await mkdir(artifactsDir, { recursive: true });
		const appPath = join(artifactsDir, "mobile.apk");
		const tgzPath = join(artifactsDir, "plugin.tgz");
		await writeFile(appPath, appBytes);
		await writeFile(tgzPath, tgzBytes);
		const manifest = manifestFor({ appVersion, appBytes, tgzBytes });
		const published = publishRelease({
			updateDir: carrierDir, manifest, appPath, pluginPath: tgzPath, source: "manual", profileKey, profileDir,
		});
		assert.equal(published.ok, true, JSON.stringify(published));
		releases.push({ releaseId: published.releaseId, manifest, appBytes, tgzBytes });
	}
	const current = releases[releases.length - 1];
	const selected = selectRelease({ updateDir: carrierDir, profileKey, releaseId: current.releaseId, profileDir });
	assert.equal(selected.ok, true, JSON.stringify(selected));
	return { base, carrierDir, profileDir, profileKey, releases, current };
}

async function withStoreFixture(options, callback) {
	const fixture = await makeStoreFixture(options);
	try {
		return await callback(fixture);
	} finally {
		await rm(fixture.base, { recursive: true, force: true });
	}
}

function storePath(...segments) {
	return join(...segments);
}

test.before(async () => {
	testHome = await mkdtemp(join(tmpdir(), "dsh-carrier-routes-home-"));
	process.env.HOME = testHome;
	({ apply } = await import("../lib/index.js"));
});

test.after(async () => {
	await rm(testHome, { recursive: true, force: true });
});

test("匿名 APK：当前发布 + HEAD/Range/ETag 契约（无整文件哈希也能流式服务）", async () => {
	await withStoreFixture({}, async (fixture) => {
		await withHarness({ config: { updateDir: fixture.carrierDir, updateProfileDir: fixture.profileDir } }, async ({ api }) => {
			const full = await request(api, { url: "/m/api/update/apk" });
			assert.equal(full.status, 200, full.body.toString().slice(0, 200));
			assert.equal(full.headers["content-type"], "application/vnd.android.package-archive");
			assert.equal(full.headers["accept-ranges"], "bytes");
			assert.equal(full.headers.etag, `"${fixture.current.releaseId}"`);
			assert.equal(Number(full.headers["content-length"]), fixture.current.appBytes.length);
			assert.deepEqual(full.body, fixture.current.appBytes);

			const head = await request(api, { url: "/m/api/update/apk", method: "HEAD" });
			assert.equal(head.status, 200);
			assert.equal(Number(head.headers["content-length"]), fixture.current.appBytes.length);
			assert.equal(head.body.length, 0, "HEAD 不得返回响应体");

			const ranged = await request(api, { url: "/m/api/update/apk", headers: { range: "bytes=0-9" } });
			assert.equal(ranged.status, 206);
			assert.equal(ranged.headers["content-range"], `bytes 0-9/${fixture.current.appBytes.length}`);
			assert.deepEqual(ranged.body, fixture.current.appBytes.subarray(0, 10));

			const suffix = await request(api, { url: "/m/api/update/apk", headers: { range: "bytes=-4" } });
			assert.equal(suffix.status, 206);
			assert.deepEqual(suffix.body, fixture.current.appBytes.subarray(-4));

			const outOfRange = await request(api, { url: "/m/api/update/apk", headers: { range: "bytes=999999-" } });
			assert.equal(outOfRange.status, 416);
			assert.equal(outOfRange.headers["content-range"], `bytes */${fixture.current.appBytes.length}`);

			const notModified = await request(api, { url: "/m/api/update/apk", headers: { "if-none-match": full.headers.etag } });
			assert.equal(notModified.status, 304);
			assert.equal(notModified.body.length, 0);
		});
	});
});

test("固定目标：只服务该 releaseId + sha256，绝不回落 current；状态码稳定区分", async () => {
	await withStoreFixture({ versions: ["3.2.0+9", "3.2.0+10"] }, async (fixture) => {
		const [older, newer] = fixture.releases;
		await withHarness({ config: { updateDir: fixture.carrierDir, updateProfileDir: fixture.profileDir } }, async ({ api }) => {
			// 无参数 = current（newer），固定目标 = older 的原字节——两者不同，证明没有"回落"。
			const current = await request(api, { url: "/m/api/update/apk" });
			assert.deepEqual(current.body, newer.appBytes);
			const fixed = await request(api, {
				url: `/m/api/update/apk?release=${older.releaseId}&sha256=${older.manifest.app.sha256}`,
			});
			assert.equal(fixed.status, 200, fixed.body.toString().slice(0, 200));
			assert.deepEqual(fixed.body, older.appBytes);
			assert.equal(fixed.headers.etag, `"${older.releaseId}"`);

			const fixedHead = await request(api, {
				url: `/m/api/update/apk?release=${older.releaseId}&sha256=${older.manifest.app.sha256}`,
				method: "HEAD",
			});
			assert.equal(fixedHead.status, 200);
			assert.equal(fixedHead.body.length, 0);
			assert.equal(Number(fixedHead.headers["content-length"]), older.appBytes.length);

			const wrongSha = await request(api, {
				url: `/m/api/update/apk?release=${older.releaseId}&sha256=${"0".repeat(64)}`,
			});
			assert.equal(wrongSha.status, 400);
			assert.equal(wrongSha.json().error, "bad-request");

			const onlyRelease = await request(api, { url: `/m/api/update/apk?release=${older.releaseId}` });
			assert.equal(onlyRelease.status, 400);
			assert.equal(onlyRelease.json().error, "bad-request");

			const malformed = await request(api, { url: "/m/api/update/apk?release=not-a-release&sha256=xyz" });
			assert.equal(malformed.status, 400);
			assert.equal(malformed.json().error, "bad-request");

			const unknown = await request(api, {
				url: `/m/api/update/apk?release=${"a".repeat(64)}&sha256=${"b".repeat(64)}`,
			});
			assert.equal(unknown.status, 404);
			assert.equal(unknown.json().error, "app-artifact-unknown");
		});
	});
});

test("固定目标过期 → 410 app-artifact-expired；对象缺失 → 503 app-artifact-not-ready", async () => {
	await withStoreFixture({}, async (fixture) => {
		const target = fixture.current;
		await withHarness({ config: { updateDir: fixture.carrierDir, updateProfileDir: fixture.profileDir } }, async ({ api }) => {
			// 1) 对象缺失（记录还在）→ 503，而不是 404/410。
			const appObject = storePath(
				fixture.carrierDir, ".app-carrier", "objects", "apk", target.manifest.app.sha256, "app.apk",
			);
			await rm(appObject, { force: true });
			const notReady = await request(api, {
				url: `/m/api/update/apk?release=${target.releaseId}&sha256=${target.manifest.app.sha256}`,
			});
			assert.equal(notReady.status, 503);
			assert.equal(notReady.json().error, "app-artifact-not-ready");
			assert.equal(notReady.json().reason, "object-missing");

			const currentNotReady = await request(api, { url: "/m/api/update/apk" });
			assert.equal(currentNotReady.status, 503);
			assert.equal(currentNotReady.json().error, "app-artifact-not-ready");

			// 2) 过保留窗口（GC 墓碑：release.json 已删、tombstone 留下）→ 410，且**不重定向**。
			const releaseDir = storePath(fixture.carrierDir, ".app-carrier", "releases", target.releaseId);
			await writeFile(join(releaseDir, "tombstone.json"), JSON.stringify({
				schema: 1, releaseId: target.releaseId, identity: target.manifest, expiredAt: new Date().toISOString(), reason: "fixture-expired",
			}));
			await rm(join(releaseDir, "release.json"), { force: true });
			await rm(join(releaseDir, "manifest.json"), { force: true });
			const expired = await request(api, {
				url: `/m/api/update/apk?release=${target.releaseId}&sha256=${target.manifest.app.sha256}`,
			});
			assert.equal(expired.status, 410);
			assert.equal(expired.json().error, "app-artifact-expired");
			assert.equal(expired.headers.location, undefined, "过期固定目标不得重定向到新版");
		});
	});
});

test("鉴权边界：匿名例外只匹配 APK 路由 + GET/HEAD；其余接口继续鉴权", async () => {
	await withStoreFixture({}, async (fixture) => {
		const target = fixture.current;
		await withHarness({ config: { updateDir: fixture.carrierDir, updateProfileDir: fixture.profileDir } }, async ({ api }) => {
			const anonymous = await request(api, { url: "/m/api/update/apk" });
			assert.equal(anonymous.status, 200);
			const anonymousWrongToken = await request(api, { url: "/m/api/update/apk", headers: { "x-mobile-token": "wrong-token" } });
			assert.equal(anonymousWrongToken.status, 200, "匿名下载不因携带错误口令而拒绝（也不作为口令校验通道）");

			for (const url of [
				"/m/api/update/manifest",
				"/m/api/update/plugin",
				"/m/api/bootstrap",
				"/m/api/diagnostics",
			]) {
				const denied = await request(api, { url });
				assert.equal(denied.status, 401, `${url} 必须继续鉴权`);
				assert.equal(denied.json().error, "auth-required");
			}
			for (const url of ["/m/api/plugin-update", "/m/api/send"]) {
				const denied = await request(api, { url, method: "POST" });
				assert.equal(denied.status, 401, `${url} 必须继续鉴权`);
				assert.equal(denied.json().error, "auth-required");
			}

			// 插件固定目标仍**鉴权**；带口令后服务托管区里的不可变 tgz。
			const pluginUrl = `/m/api/update/plugin?release=${target.releaseId}&sha256=${target.manifest.plugin.sha256}`;
			assert.equal((await request(api, { url: pluginUrl })).status, 401);
			const pluginFixed = await request(api, { url: pluginUrl, headers: { "x-mobile-token": TOKEN } });
			assert.equal(pluginFixed.status, 200);
			assert.equal(pluginFixed.headers["content-type"], "application/gzip");
			assert.deepEqual(pluginFixed.body, target.tgzBytes);
			const pluginRanged = await request(api, {
				url: pluginUrl,
				headers: { "x-mobile-token": TOKEN, range: "bytes=0-3" },
			});
			assert.equal(pluginRanged.status, 206);
			assert.deepEqual(pluginRanged.body, target.tgzBytes.subarray(0, 4));

			const unknownPlugin = await request(api, {
				url: `/m/api/update/plugin?release=${"a".repeat(64)}&sha256=${"b".repeat(64)}`,
				headers: { "x-mobile-token": TOKEN },
			});
			assert.equal(unknownPlugin.status, 404);
			assert.equal(unknownPlugin.json().error, "plugin-artifact-unknown");
		});
	});
});

test("匿名下载与登录限流是独立资源桶（互不消耗/重置）", async () => {
	await withStoreFixture({}, async (fixture) => {
		await withHarness({ config: { updateDir: fixture.carrierDir, updateProfileDir: fixture.profileDir } }, async ({ api }) => {
			// 先把这个来源的登录失败桶打满 → 429（控制面）。
			const attacker = { remoteAddress: "198.51.100.7" };
			let lastStatus = 0;
			for (let attempt = 0; attempt < 11; attempt++) {
				lastStatus = (await request(api, { url: "/m/api/update/manifest", headers: { "x-mobile-token": "wrong" }, ...attacker })).status;
			}
			assert.equal(lastStatus, 429, "登录限流应独立生效");
			// 同一来源的匿名 APK 不受此桶影响。
			const anonymous = await request(api, { url: "/m/api/update/apk", ...attacker });
			assert.equal(anonymous.status, 200, "匿名下载不得与控制面登录限流共用桶");

			// 另一个来源：匿名限流打满后，控制面登录桶仍是干净的（401 而非 429）。
			const downloader = { remoteAddress: "198.51.100.8" };
			let anonymousStatus = 0;
			for (let attempt = 0; attempt < 31; attempt++) {
				anonymousStatus = (await request(api, { url: "/m/api/update/apk", ...downloader })).status;
			}
			assert.equal(anonymousStatus, 429, "匿名下载独立限流应生效");
			const protectedStatus = (await request(api, {
				url: "/m/api/update/manifest", headers: { "x-mobile-token": "wrong" }, ...downloader,
			})).status;
			assert.equal(protectedStatus, 401, "匿名请求不得消耗控制面登录限流桶");
		});
	});
});

test("bootstrap 四字段：currentRelease / currentReleaseHealth / updateTarget / appArtifact + 投影", async () => {
	await withStoreFixture({}, async (fixture) => {
		await withHarness({ config: { updateDir: fixture.carrierDir, updateProfileDir: fixture.profileDir } }, async ({ api }) => {
			const boot = await request(api, {
				url: "/m/api/bootstrap",
				headers: {
					"x-mobile-token": TOKEN,
					// 这些转发头**不得**影响投影（不是受信来源）。
					"x-forwarded-proto": "https",
					"x-forwarded-host": "evil.example",
					"x-forwarded-for": "203.0.113.9",
				},
			});
			assert.equal(boot.status, 200);
			const body = boot.json();

			// 旧 pluginUpdate.* 保留兼容。
			assert.equal(typeof body.pluginUpdate, "object");
			assert.ok(body.pluginUpdate !== null);

			assert.equal(body.currentRelease.releaseId, fixture.current.releaseId);
			const snapshot = body.currentRelease.release;
			assert.equal(snapshot.schema, 1);
			assert.equal(snapshot.app.version, fixture.current.manifest.app.version);
			assert.equal(snapshot.app.sha256, fixture.current.manifest.app.sha256);
			assert.equal(snapshot.plugin.contentSha256, RUNNING_CONTENT);
			// 宿主拼好固定目标 query；协议/端口来自监听形态，不采信 X-Forwarded-Proto。
			assert.equal(
				snapshot.app.url,
				`http://127.0.0.1:3080/m/api/update/apk?release=${fixture.current.releaseId}&sha256=${fixture.current.manifest.app.sha256}`,
			);
			assert.equal(
				snapshot.plugin.url,
				`http://127.0.0.1:3080/m/api/update/plugin?release=${fixture.current.releaseId}&sha256=${fixture.current.manifest.plugin.sha256}`,
			);
			assert.equal(snapshot.manifestUrl, "http://127.0.0.1:3080/m/api/update/manifest");
			assert.equal(snapshot.app.url.includes("evil.example"), false);
			assert.equal(snapshot.app.url.includes("https://"), false);

			assert.equal(body.currentReleaseHealth.state, "confirmed");
			assert.equal(body.currentReleaseHealth.runningContentSha256, RUNNING_CONTENT);
			assert.equal(body.currentReleaseHealth.instanceId, body.plugin.instanceId);
			assert.equal(body.currentReleaseHealth.transaction, null);

			assert.equal(body.updateTarget, null, "没有检查/候选时不得伪造更新目标");

			assert.equal(body.appArtifact.state, "ok");
			assert.equal(body.appArtifact.releaseId, fixture.current.releaseId);
			// 诊断/引导字段不得泄露凭据或本机绝对路径。
			const serialized = JSON.stringify(body);
			assert.equal(serialized.includes(TOKEN), false, "bootstrap 不得回显访问口令");
			assert.equal(serialized.includes(fixture.carrierDir), false, "bootstrap 不得回显本机绝对路径");
		});
	});
});

test("地址投影：自定义挂载路径保留；显式 publicOrigin 优先于 Host/转发头", async () => {
	await withStoreFixture({}, async (fixture) => {
		await withHarness({
			config: { path: "/phone", updateDir: fixture.carrierDir, updateProfileDir: fixture.profileDir },
		}, async ({ api }) => {
			const boot = await request(api, {
				url: "/phone/api/bootstrap",
				headers: { "x-mobile-token": TOKEN },
			});
			assert.equal(boot.status, 200);
			const url = boot.json().currentRelease.release.app.url;
			assert.equal(url.startsWith("http://127.0.0.1:3080/phone/api/update/apk?release="), true, url);
		});
		await withHarness({
			config: {
				updateDir: fixture.carrierDir,
				updateProfileDir: fixture.profileDir,
				publicOrigin: "https://remote.example.com",
			},
		}, async ({ api }) => {
			const boot = await request(api, {
				url: "/m/api/bootstrap",
				host: "127.0.0.1:3080",
				headers: { "x-mobile-token": TOKEN, "x-forwarded-proto": "http", "x-forwarded-host": "10.0.0.1" },
			});
			const snapshot = boot.json().currentRelease.release;
			assert.equal(snapshot.manifestUrl, "https://remote.example.com/m/api/update/manifest");
			assert.equal(snapshot.app.url.startsWith(`https://remote.example.com/m/api/update/apk?release=${fixture.current.releaseId}&sha256=`), true);
			assert.equal(boot.json().appArtifact.state, "ok");
		});
	});
});

test("appArtifact：APK 与清单不一致 → mismatch + 稳定 reason + 修复指引（无路径/凭据）", async () => {
	await withStoreFixture({}, async (fixture) => {
		const appObject = storePath(
			fixture.carrierDir, ".app-carrier", "objects", "apk", fixture.current.manifest.app.sha256, "app.apk",
		);
		await chmod(appObject, 0o644);
		await appendFile(appObject, Buffer.from("tampered"));
		await withHarness({ config: { updateDir: fixture.carrierDir, updateProfileDir: fixture.profileDir } }, async ({ api }) => {
			const boot = await request(api, { url: "/m/api/bootstrap", headers: { "x-mobile-token": TOKEN } });
			const artifact = boot.json().appArtifact;
			assert.equal(artifact.state, "mismatch");
			assert.equal(artifact.reason, "app-size-mismatch");
			assert.equal(typeof artifact.hint, "string");
			assert.ok(artifact.hint.length > 0, "必须给出可执行的修复指引");
			const serialized = JSON.stringify(artifact);
			assert.equal(serialized.includes(fixture.carrierDir), false);
			assert.equal(serialized.includes(TOKEN), false);

			// 下载面：不服务错误字节。
			const download = await request(api, {
				url: `/m/api/update/apk?release=${fixture.current.releaseId}&sha256=${fixture.current.manifest.app.sha256}`,
			});
			assert.equal(download.status, 500);
			assert.equal(download.json().error, "app-artifact-mismatch");
			assert.deepEqual(download.body.includes(Buffer.from("tampered")), false);
		});
	});
});

test("空口令：宿主自动生成强口令（存插件状态，不写 profile）→ 401 auth-required", async () => {
	const savedHome = process.env.HOME;
	const isolatedHome = await mkdtemp(join(tmpdir(), "dsh-gen-auth-home-"));
	process.env.HOME = isolatedHome;
	try {
		await withStoreFixture({}, async (fixture) => {
			let generated;
			await withHarness({
				config: { authToken: "", updateDir: fixture.carrierDir, updateProfileDir: fixture.profileDir },
			}, async ({ api }) => {
				const qr = await request(api, { url: "/m/api/qr-config" });
				assert.equal(qr.status, 200);
				generated = qr.json().token;
				assert.match(generated, /^[A-Za-z0-9_-]{43}$/, "randomBytes(32) → base64url 43 字符");
				assert.equal(qr.json().auth.enabled, true);
				assert.equal(qr.json().auth.source, "generated");

				// 普通请求没带 token → auth-required（不是 auth-not-configured）。
				const denied = await request(api, { url: "/m/api/update/manifest" });
				assert.equal(denied.status, 401);
				assert.equal(denied.json().error, "auth-required");

				// 自动生成的口令与配置口令等价：带上即可访问受保护接口。
				const allowed = await request(api, {
					url: "/m/api/update/manifest",
					headers: { "x-mobile-token": generated },
				});
				assert.equal(allowed.status, 404, "updateDir 未配置主机清单 → 404（已通过鉴权）");

				// 匿名 APK 仍是匿名（且可用）。
				const apk = await request(api, { url: "/m/api/update/apk" });
				assert.equal(apk.status, 200);
			});

			// 持久化：同一 HOME 再加载实例，口令不变（二维码仍"扫码即带口令"）。
			await withHarness({
				config: { authToken: "", updateDir: fixture.carrierDir, updateProfileDir: fixture.profileDir },
			}, async ({ api }) => {
				const qr = await request(api, { url: "/m/api/qr-config" });
				assert.equal(qr.json().token, generated);
			});
			const tokenFile = join(isolatedHome, ".dsh", "mobile-remote", "auth-token");
			assert.equal((await readFile(tokenFile, "utf8")).trim(), generated);
			// 不写用户 profile 配置：profile 目录里没有口令。
			const profileRaw = await readFile(join(fixture.profileDir, "package.json"), "utf8");
			assert.equal(profileRaw.includes(generated), false);
		});
	} finally {
		process.env.HOME = savedHome;
		await rm(isolatedHome, { recursive: true, force: true });
	}
});

test("空口令自动生成失败（状态目录不可写）→ 401 auth-not-configured，匿名 APK 不受影响", async () => {
	const savedHome = process.env.HOME;
	const readOnlyHome = await mkdtemp(join(tmpdir(), "dsh-ro-auth-home-"));
	await chmod(readOnlyHome, 0o500);
	process.env.HOME = readOnlyHome;
	try {
		await withHarness({ config: { authToken: "" } }, async ({ api }) => {
			const denied = await request(api, { url: "/m/api/update/manifest" });
			assert.equal(denied.status, 401);
			assert.equal(denied.json().error, "auth-not-configured");

			const boot = await request(api, { url: "/m/api/bootstrap" });
			assert.equal(boot.status, 401);
			assert.equal(boot.json().error, "auth-not-configured");

			// 匿名 APK 路由不因"认证未配置"变成 401：按产物就绪状态回答。
			const apk = await request(api, { url: "/m/api/update/apk" });
			assert.equal(apk.status, 503);
			assert.equal(apk.json().error, "app-artifact-not-ready");

			// qr-config 仍本机可用，并明确报告认证不可用（不伪造口令）。
			const qr = await request(api, { url: "/m/api/qr-config" });
			assert.equal(qr.status, 200);
			assert.equal(qr.json().token, "");
			assert.equal(qr.json().auth.enabled, false);
			assert.equal(qr.json().auth.source, "unavailable");
		});
	} finally {
		process.env.HOME = savedHome;
		await chmod(readOnlyHome, 0o700);
		await rm(readOnlyHome, { recursive: true, force: true });
	}
});

test("qr-config / qr.png 本机特权入口拒绝可识别代理来源", async () => {
	await withHarness({ config: {} }, async ({ api }) => {
		const local = await request(api, { url: "/m/api/qr-config" });
		assert.equal(local.status, 200);
		assert.equal(Array.isArray(local.json().urls), true);
		assert.equal(local.json().token, TOKEN, "配置非空时以配置为准");

		const proxied = await request(api, { url: "/m/api/qr-config", headers: { "x-forwarded-for": "203.0.113.9" } });
		assert.equal(proxied.status, 403);
		assert.equal(proxied.json().error, "proxy-not-trusted");

		const nonLocal = await request(api, { url: "/m/api/qr-config", remoteAddress: "192.0.2.10" });
		assert.equal(nonLocal.status, 403);
		assert.equal(nonLocal.json().error, "loopback-only");
	});
});

test("随包载体：无托管区指针时作为当前发布，并支持按 releaseId+sha256 匿名下载", async () => {
	const base = await mkdtemp(join(tmpdir(), "dsh-carrier-discovery-"));
	try {
		const pluginRoot = join(base, "plugin-root");
		const carrierDir = join(pluginRoot, "node_modules", "@marktrue", "dsh-mobile-remote-app");
		const appVersion = "3.2.0+9";
		const appBytes = Buffer.from(APK_BYTES);
		const tgzBytes = Buffer.from("carrier-plugin-tgz\n");
		const manifest = manifestFor({ appVersion, appBytes, tgzBytes });
		await mkdir(carrierDir, { recursive: true });
		await writeFile(join(pluginRoot, "package.json"), JSON.stringify({
			name: PLUGIN_NAME,
			version: PLUGIN_VERSION,
			optionalDependencies: { "@marktrue/dsh-mobile-remote-app": `npm:${PLUGIN_NAME}@${PLUGIN_VERSION}-app` },
		}));
		await writeFile(join(carrierDir, "package.json"), JSON.stringify({
			name: PLUGIN_NAME,
			version: `${PLUGIN_VERSION}-app`,
			dsh: { appCarrier: true },
		}));
		await writeFile(join(carrierDir, "mobile.apk"), appBytes);
		await writeFile(join(carrierDir, "manifest.json"), JSON.stringify(manifest));
		const identity = releaseIdentityFromManifest(manifest);
		assert.equal(identity.ok, true, JSON.stringify(identity));

		await withHarness({
			config: { updateDir: "", updateProfileDir: "" },
			runtime: { carrier: { pluginRoot } },
		}, async ({ api }) => {
			const boot = await request(api, { url: "/m/api/bootstrap", headers: { "x-mobile-token": TOKEN } });
			assert.equal(boot.status, 200);
			const body = boot.json();
			assert.equal(body.currentRelease?.releaseId, identity.releaseId);
			assert.equal(body.currentRelease.release.plugin.contentSha256, RUNNING_CONTENT);
			assert.equal(body.appArtifact.state, "ok");
			assert.equal(body.currentReleaseHealth.state, "confirmed");

			// 无参数 = 当前发布（随包载体）字节。
			const current = await request(api, { url: "/m/api/update/apk" });
			assert.equal(current.status, 200);
			assert.deepEqual(current.body, appBytes);

			// 固定目标同一身份 → 匿名可下载（不依赖托管区对象）。
			const fixed = await request(api, {
				url: `/m/api/update/apk?release=${identity.releaseId}&sha256=${sha256(appBytes)}`,
			});
			assert.equal(fixed.status, 200);
			assert.deepEqual(fixed.body, appBytes);
			assert.equal(fixed.headers.etag, `"${identity.releaseId}"`);
		});
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("LAN 桥投影：不把 127.0.0.1 发给手机（用桥的 LAN 侧网卡 + 桥端口）", async () => {
	await withStoreFixture({}, async (fixture) => {
		const routes = [];
		let effectCleanup;
		const upstream = createServer((req, res) => {
			let url;
			try {
				url = new URL(req.url ?? "/", "http://placeholder");
			} catch {
				res.writeHead(400);
				res.end();
				return;
			}
			const route = routes.find((entry) => entry.kind === "prefix" && url.pathname.startsWith(entry.path));
			if (!route) {
				res.writeHead(404);
				res.end();
				return;
			}
			route.handler(req, res);
		});
		upstream.listen(0, "127.0.0.1");
		await once(upstream, "listening");
		const upstreamPort = upstream.address().port;
		const probe = createServer();
		probe.listen(0, "127.0.0.1");
		await once(probe, "listening");
		const bridgePort = probe.address().port;
		await new Promise((resolve) => probe.close(resolve));
		const ctx = {
			webServer: { host: "127.0.0.1", port: upstreamPort, register(route) { routes.push(route); return () => {}; } },
			logger: { warn() {}, info() {} },
			provide() {},
			get: () => undefined,
			on: () => () => {},
			inject() {},
			effect(fn) { effectCleanup = fn(); return effectCleanup; },
		};
		apply(ctx, config({
			updateDir: fixture.carrierDir,
			updateProfileDir: fixture.profileDir,
			lanBridge: { enabled: true, host: "127.0.0.1", port: bridgePort },
		}));
		try {
			let boot;
			for (let attempt = 0; attempt < 100; attempt++) {
				try {
					boot = await fetch(`http://127.0.0.1:${bridgePort}/m/api/bootstrap`, {
						headers: { "x-mobile-token": TOKEN },
					});
					break;
				} catch {
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
			}
			assert.ok(boot, "LAN 桥应已监听");
			assert.equal(boot.status, 200);
			const body = await boot.json();
			const appUrl = new URL(body.currentRelease.release.app.url);
			assert.equal(appUrl.port, String(bridgePort), "投影必须使用桥的监听端口");
			assert.notEqual(appUrl.hostname, "127.0.0.1", "LAN 桥场景不得把 127.0.0.1 发给手机");
			assert.notEqual(appUrl.hostname, "localhost");
			assert.equal(appUrl.pathname, "/m/api/update/apk");
			assert.equal(appUrl.searchParams.get("release"), fixture.current.releaseId);
			assert.equal(appUrl.searchParams.get("sha256"), fixture.current.manifest.app.sha256);

			// 经桥的匿名 APK 下载同样可用（桥只转发 /api 面）。
			const apk = await fetch(`http://127.0.0.1:${bridgePort}/m/api/update/apk`);
			assert.equal(apk.status, 200);
			assert.equal((await apk.arrayBuffer()).byteLength, fixture.current.appBytes.length);
		} finally {
			effectCleanup?.();
			await new Promise((resolve) => upstream.close(resolve));
		}
	});
});

// ── #35 缺口 A：随包载体导入托管区（写侧接线）＋启动 GC ──────────────────────────
// 真机验收发现的缺口：托管区 module 只被读取链引用，导入链路从未接线，匿名下载实际
// 一直靠"载体直读回退"。以下用例钉住：apply 后异步导入落位、重复 apply 幂等、
// 托管区成为读取权威（载体不可发现时仍可服务），以及启动 GC 只回收无引用残留。

/** 轮询等待（导入/GC 在 apply 返回后的 0ms 定时器里跑，测试需要等它落定）。 */
async function waitFor(check, label = "条件", { timeoutMs = 5000, intervalMs = 20 } = {}) {
	const startedAt = Date.now();
	for (;;) {
		const value = await check();
		if (value) return value;
		if (Date.now() - startedAt > timeoutMs) throw new Error(`等待超时：${label}`);
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

/** 读 JSON 文件；不存在/损坏时返回 null（轮询用）。 */
async function readJsonMaybe(file) {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch {
		return null;
	}
}

async function pathExists(target) {
	try {
		await stat(target);
		return true;
	} catch {
		return false;
	}
}

/**
 * "载体已安装 + 空托管区" 夹具：假插件根（package.json 声明精确载体别名）+
 * node_modules 里的载体包（APK + 完整 schema 1 清单，plugin.contentSha256 = 运行内容）。
 * updateDir 为空的独立目录，profileDir 是带 package.json 的真实 profile 目录。
 */
async function makeCarrierImportFixture() {
	const base = await mkdtemp(join(tmpdir(), "dsh-carrier-import-"));
	const pluginRoot = join(base, "plugin-root");
	const carrierRoot = join(pluginRoot, "node_modules", "@marktrue", "dsh-mobile-remote-app");
	const updateDir = join(base, "update");
	const profileDir = join(base, "profile-web");
	await mkdir(carrierRoot, { recursive: true });
	await mkdir(updateDir, { recursive: true });
	await mkdir(profileDir, { recursive: true });
	await writeFile(join(profileDir, "package.json"), JSON.stringify({
		name: "web-profile",
		dependencies: { [PLUGIN_NAME]: "file:/fixture-plugin" },
	}));
	// 与 store 夹具字节区分（首字节不同），便于断言"服务的是载体字节"。
	const appBytes = Buffer.from(APK_BYTES);
	appBytes[0] = (appBytes[0] + 7) & 0xff;
	const tgzBytes = Buffer.from("carrier-plugin-tgz-for-import\n");
	const manifest = manifestFor({ appVersion: "3.2.0+9", appBytes, tgzBytes });
	await writeFile(join(pluginRoot, "package.json"), JSON.stringify({
		name: PLUGIN_NAME,
		version: PLUGIN_VERSION,
		optionalDependencies: { "@marktrue/dsh-mobile-remote-app": `npm:${PLUGIN_NAME}@${PLUGIN_VERSION}-app` },
	}));
	await writeFile(join(carrierRoot, "package.json"), JSON.stringify({
		name: PLUGIN_NAME,
		version: `${PLUGIN_VERSION}-app`,
		dsh: { appCarrier: true },
	}));
	await writeFile(join(carrierRoot, "mobile.apk"), appBytes);
	await writeFile(join(carrierRoot, "manifest.json"), JSON.stringify(manifest));
	const identity = releaseIdentityFromManifest(manifest);
	assert.equal(identity.ok, true, JSON.stringify(identity));
	return {
		base, pluginRoot, carrierRoot, updateDir, profileDir,
		profileKey: basename(profileDir),
		appBytes, manifest, releaseId: identity.releaseId,
		pointerFile: join(updateDir, ".app-carrier", "profiles", basename(profileDir), "current.json"),
		appObjectPath: join(updateDir, ".app-carrier", "objects", "apk", sha256(appBytes), "app.apk"),
		releaseDir: join(updateDir, ".app-carrier", "releases", identity.releaseId),
	};
}

function carrierHarnessOptions(fixture) {
	return {
		config: { updateDir: fixture.updateDir, updateProfileDir: fixture.profileDir },
		runtime: { carrier: { pluginRoot: fixture.pluginRoot } },
	};
}

test("载体导入托管区：apply 后异步落位为当前发布，读取链报告 carrier-store", async () => {
	const fixture = await makeCarrierImportFixture();
	try {
		await withHarness(carrierHarnessOptions(fixture), async ({ api }) => {
			const pointer = await waitFor(async () => {
				const value = await readJsonMaybe(fixture.pointerFile);
				return value?.current?.releaseId === fixture.releaseId ? value : null;
			}, "载体导入落位（profile 当前指针）");
			assert.equal(pointer.current.identity.plugin.contentSha256, RUNNING_CONTENT);
			assert.equal(pointer.profileDir, fixture.profileDir, "指针必须记录真实 profile 目录（GC 存活性判定用）");

			// 托管区出现 releases/<releaseId>/ 与不可变 APK 对象；暂存区不留残留。
			assert.ok(await pathExists(join(fixture.releaseDir, "release.json")), "托管区应有发布记录");
			assert.ok(await pathExists(join(fixture.releaseDir, "manifest.json")), "托管区应有发布清单");
			assert.ok(await pathExists(fixture.appObjectPath), "托管区应有按内容寻址的 APK 对象");
			assert.deepEqual(await readdir(join(fixture.updateDir, ".app-carrier", "staging")), [], "导入完成不应留下暂存");

			// 读取链：托管区当前发布优先（source=carrier-store），匿名下载仍是载体字节。
			const boot = (await request(api, { url: "/m/api/bootstrap", headers: { "x-mobile-token": TOKEN } })).json();
			assert.equal(boot.appArtifact.state, "ok");
			assert.equal(boot.appArtifact.source, "carrier-store");
			assert.equal(boot.currentRelease.releaseId, fixture.releaseId);
			assert.equal(boot.currentReleaseHealth.state, "confirmed");
			const apk = await request(api, { url: "/m/api/update/apk" });
			assert.equal(apk.status, 200);
			assert.deepEqual(apk.body, fixture.appBytes);
			const fixed = await request(api, {
				url: `/m/api/update/apk?release=${fixture.releaseId}&sha256=${sha256(fixture.appBytes)}`,
			});
			assert.equal(fixed.status, 200);
			assert.deepEqual(fixed.body, fixture.appBytes);

			// 诊断可见导入结论（稳定代号；不得回显本机路径/凭据）。
			const diag = (await request(api, { url: "/m/api/diagnostics", headers: { "x-mobile-token": TOKEN } })).json();
			assert.equal(diag.carrier.import.state, "ready");
			assert.equal(diag.carrier.import.releaseId, fixture.releaseId);
			const carrierSerialized = JSON.stringify(diag.carrier);
			assert.equal(carrierSerialized.includes(fixture.updateDir), false, "诊断不得回显本机绝对路径");
			assert.equal(carrierSerialized.includes(TOKEN), false, "诊断不得回显访问口令");

			// 载体原件未被移动/改写（导入只读载体，硬链接/复制语义由托管区 module 决定）。
			assert.deepEqual(await readFile(join(fixture.carrierRoot, "mobile.apk")), fixture.appBytes);
		});
	} finally {
		await rm(fixture.base, { recursive: true, force: true });
	}
});

test("载体导入托管区：重复 apply 幂等（不重复导入、不重写指针）", async () => {
	const fixture = await makeCarrierImportFixture();
	try {
		await withHarness(carrierHarnessOptions(fixture), async () => {
			await waitFor(async () => (await readJsonMaybe(fixture.pointerFile))?.current?.releaseId === fixture.releaseId, "首次导入落位");
		});
		const releasesDir = join(fixture.updateDir, ".app-carrier", "releases");
		const releasesBefore = (await readdir(releasesDir)).filter((name) => /^[a-f0-9]{64}$/.test(name)).sort();
		const pointerBefore = await stat(fixture.pointerFile);
		assert.equal(releasesBefore.length, 1);

		await withHarness(carrierHarnessOptions(fixture), async ({ api }) => {
			const importState = await waitFor(async () => {
				const diag = (await request(api, { url: "/m/api/diagnostics", headers: { "x-mobile-token": TOKEN } })).json();
				const state = diag.carrier?.import;
				return state && state.state !== "pending" ? state : null;
			}, "第二次导入任务完成");
			assert.equal(importState.state, "ready");
			assert.equal(importState.reason, "already-current", "同一 releaseId 应命中幂等跳过");
			assert.equal(importState.releaseId, fixture.releaseId);
		});

		const releasesAfter = (await readdir(releasesDir)).filter((name) => /^[a-f0-9]{64}$/.test(name)).sort();
		const pointerAfter = await stat(fixture.pointerFile);
		assert.deepEqual(releasesAfter, releasesBefore, "重复 apply 不得产生重复发布记录");
		assert.equal(pointerAfter.mtimeMs, pointerBefore.mtimeMs, "幂等路径不得重写当前指针（不重置保留时钟）");
		assert.deepEqual(await readdir(join(fixture.updateDir, ".app-carrier", "staging")), []);
	} finally {
		await rm(fixture.base, { recursive: true, force: true });
	}
});

test("读取链：载体不可发现后仍从托管区当前发布服务（托管区优先、载体回退）", async () => {
	const fixture = await makeCarrierImportFixture();
	try {
		await withHarness(carrierHarnessOptions(fixture), async () => {
			await waitFor(async () => (await readJsonMaybe(fixture.pointerFile))?.current?.releaseId === fixture.releaseId, "首次导入落位");
		});
		// 模拟载体直读回退不可用（载体被移除/装歪）：托管区必须独立服务当前发布。
		await rm(join(fixture.carrierRoot, "mobile.apk"), { force: true });
		await withHarness(carrierHarnessOptions(fixture), async ({ api }) => {
			const boot = (await request(api, { url: "/m/api/bootstrap", headers: { "x-mobile-token": TOKEN } })).json();
			assert.equal(boot.appArtifact.state, "ok");
			assert.equal(boot.appArtifact.source, "carrier-store");
			const apk = await request(api, { url: "/m/api/update/apk" });
			assert.equal(apk.status, 200);
			assert.deepEqual(apk.body, fixture.appBytes);
		});
	} finally {
		await rm(fixture.base, { recursive: true, force: true });
	}
});

test("启动 GC：回收无引用对象与过期暂存，不删当前发布与载体原件", async () => {
	const fixture = await makeCarrierImportFixture();
	try {
		await withHarness(carrierHarnessOptions(fixture), async () => {
			await waitFor(async () => (await readJsonMaybe(fixture.pointerFile))?.current?.releaseId === fixture.releaseId, "首次导入落位");
		});
		const carrierBytes = await readFile(join(fixture.carrierRoot, "mobile.apk"));

		// 构造"过期残留"：无引用的旧对象 + 超出 staging TTL 的未提交暂存（都不参与服务）。
		const staleSha = "b".repeat(64);
		const staleObjectDir = join(fixture.updateDir, ".app-carrier", "objects", "apk", staleSha);
		await mkdir(staleObjectDir, { recursive: true });
		await writeFile(join(staleObjectDir, "app.apk"), Buffer.from("stale-object\n"));
		const staleStagingId = "11111111-2222-3333-4444-555555555555";
		const staleStagingDir = join(fixture.updateDir, ".app-carrier", "staging", staleStagingId);
		await mkdir(staleStagingDir, { recursive: true });
		await writeFile(join(staleStagingDir, "staged.json"), JSON.stringify({
			schema: 1, stagingId: staleStagingId, createdAtMs: Date.now() - 2 * 60 * 60 * 1000,
		}));
		await writeFile(join(staleStagingDir, "app.apk"), Buffer.from("stale-staging\n"));

		let gcState;
		await withHarness(carrierHarnessOptions(fixture), async ({ api }) => {
			gcState = await waitFor(async () => {
				const diag = (await request(api, { url: "/m/api/diagnostics", headers: { "x-mobile-token": TOKEN } })).json();
				const gc = diag.carrier?.garbageCollection;
				if (!gc || gc.state === "pending") return null;
				// 以"残留真的被删掉"为准，避免只看诊断状态与文件系统进度错位。
				if (await pathExists(join(staleObjectDir, "app.apk"))) return null;
				if (await pathExists(staleStagingDir)) return null;
				return gc;
			}, "启动 GC 回收过期残留");
			assert.equal(gcState.state, "ok");
			assert.ok(gcState.removedObjects >= 1, `应回收无引用对象：${JSON.stringify(gcState)}`);
			assert.ok(gcState.removedStaging >= 1, `应回收过期暂存：${JSON.stringify(gcState)}`);
		});

		// 当前发布的对象/记录/指针与载体原件都不得被 GC 删除。
		assert.ok(await pathExists(fixture.appObjectPath));
		assert.deepEqual(await readFile(fixture.appObjectPath), fixture.appBytes);
		assert.ok(await pathExists(join(fixture.releaseDir, "release.json")));
		const pointer = await readJsonMaybe(fixture.pointerFile);
		assert.equal(pointer.current.releaseId, fixture.releaseId);
		assert.deepEqual(await readFile(join(fixture.carrierRoot, "mobile.apk")), carrierBytes);
	} finally {
		await rm(fixture.base, { recursive: true, force: true });
	}
});

// ── #35 缺口 B：连接页下载码数据（/api/qr-config 新增字段）──────────────────────
test("qr-config：下发手机可达的 appDownloadUrl 与 appArtifact 状态（不含口令/本机路径）", async () => {
	await withStoreFixture({}, async (fixture) => {
		// 显式 publicOrigin 让"手机可达绝对地址"在测试里可确定（与 bootstrap 投影一致）。
		await withHarness({
			config: {
				updateDir: fixture.carrierDir,
				updateProfileDir: fixture.profileDir,
				publicOrigin: "https://remote.example.com",
			},
		}, async ({ api }) => {
			const res = await request(api, { url: "/m/api/qr-config" });
			assert.equal(res.status, 200);
			const body = res.json();
			assert.equal(body.appDownloadUrl, "https://remote.example.com/m/api/update/apk");
			assert.equal(body.appArtifact.state, "ok");
			assert.equal(body.appArtifact.releaseId, fixture.current.releaseId);
			assert.deepEqual([...body.urls], ["https://remote.example.com/m"], "二维码地址与下载地址共用同一手机可达基址");
			// 下载码数据不得携带口令，也不得回显本机绝对路径。
			const serialized = JSON.stringify({ appDownloadUrl: body.appDownloadUrl, appArtifact: body.appArtifact });
			assert.equal(serialized.includes(TOKEN), false, "下载码数据不得包含口令");
			assert.equal(serialized.includes(fixture.carrierDir), false, "appArtifact 不得回显本机路径");
		});

		// 未显式配置基址时：有手机可达网卡 → 用它拼 /api/update/apk；只有回环 → null（绝不发回环地址）。
		await withHarness({
			config: { updateDir: fixture.carrierDir, updateProfileDir: fixture.profileDir },
		}, async ({ api }) => {
			const body = (await request(api, { url: "/m/api/qr-config" })).json();
			const nonLoopback = body.urls.find((value) => !String(value).includes("127.0.0.1"));
			if (nonLoopback) {
				assert.equal(body.appDownloadUrl, new URL(nonLoopback).origin + "/m/api/update/apk");
			} else {
				assert.equal(body.appDownloadUrl, null, "没有手机可达地址时不得下发回环下载地址");
			}
			assert.equal(body.appArtifact.state, "ok");
		});
	});
});

test("qr-config：产物未就绪时 appDownloadUrl=null，只给稳定状态（不生成坏码）", async () => {
	await withHarness({ config: {} }, async ({ api }) => {
		const body = (await request(api, { url: "/m/api/qr-config" })).json();
		assert.equal(body.appDownloadUrl, null);
		assert.equal(body.appArtifact.state, "missing");
		assert.match(body.appArtifact.reason, /^[a-z0-9][a-z0-9._-]{0,63}$/, "reason 必须是稳定代号");
		assert.equal(typeof body.appArtifact.hint, "string");
		assert.ok(body.appArtifact.hint.length > 0, "应给可执行的修复指引");
		const serialized = JSON.stringify({ appDownloadUrl: body.appDownloadUrl, appArtifact: body.appArtifact });
		assert.equal(serialized.includes(TOKEN), false);
	});

	// 非 loopback 来源仍 403（下载码数据同样受本机特权入口围栏保护）。
	await withHarness({ config: {} }, async ({ api }) => {
		const denied = await request(api, { url: "/m/api/qr-config", remoteAddress: "192.0.2.10" });
		assert.equal(denied.status, 403);
		assert.equal(denied.json().error, "loopback-only");
	});
});
