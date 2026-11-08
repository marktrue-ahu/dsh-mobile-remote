// issue #60 R15：宿主稳定身份（bootstrap plugin.hostId）与测试注入的持久化/原子发布。

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { apply, hostIdentityFile, resolveHostIdentity } from "../lib/index.js";

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
	writeHead(statusCode) { this.statusCode = statusCode; this.headersSent = true; }
	write(chunk) { this.chunks.push(Buffer.from(String(chunk))); return true; }
	end(chunk = "") { if (chunk !== "") this.write(chunk); this.emit("finish"); }
	destroy() { this.emit("close"); }
}

class FakeRequest extends EventEmitter {
	constructor(url) {
		super();
		this.url = url;
		this.method = "GET";
		this.headers = { host: "127.0.0.1", "x-mobile-token": CONFIG.authToken };
		this.socket = { remoteAddress: "127.0.0.1" };
	}
}

function harness(home) {
	const routes = [];
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	const ctx = {
		webServer: { host: "127.0.0.1", port: 43120, register(spec) { routes.push(spec); return () => {}; } },
		logger: { warn() {}, info() {} },
		get() { return undefined; },
		provide() {},
		on() { return () => {}; },
		effect(callback) { const dispose = callback?.(); return typeof dispose === "function" ? dispose : () => {}; },
		inject() {},
		waterfall: async () => "unavailable",
	};
	const dispose = apply(ctx, CONFIG);
	return {
		route: routes.find((route) => route.path === "/m/api").handler,
		clean() { dispose?.(); process.env.HOME = previousHome; },
	};
}

async function bootstrap(route) {
	const req = new FakeRequest("/m/api/bootstrap");
	const res = new FakeResponse();
	const finished = new Promise((resolve) => res.once("finish", resolve));
	route(req, res);
	await finished;
	return JSON.parse(Buffer.concat(res.chunks).toString("utf8"));
}

test("R15：宿主身份持久化且不同状态目录必然不同", () => {
	const homeA = mkdtempSync(join(tmpdir(), "r15-a-"));
	const homeB = mkdtempSync(join(tmpdir(), "r15-b-"));
	const first = resolveHostIdentity({ home: homeA });
	const second = resolveHostIdentity({ home: homeA });
	assert.equal(first, second, "同一宿主重启/重复读取必须稳定");
	assert.notEqual(first, resolveHostIdentity({ home: homeB }), "不同宿主不得相同");
	assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
	// 文件存在且内容就是该身份（原子发布后的最终状态）。
	assert.equal(readFileSync(hostIdentityFile(homeA), "utf8").trim(), first);
});

test("R15：身份文件损坏/为空时重新生成有效值（不让半截内容当身份）", () => {
	const home = mkdtempSync(join(tmpdir(), "r15-corrupt-"));
	mkdirSync(join(home, ".dsh", "mobile-remote"), { recursive: true });
	writeFileSync(hostIdentityFile(home), "");
	const identity = resolveHostIdentity({ home });
	assert.match(identity, /^[0-9a-f-]{36}$/i);
	assert.equal(readFileSync(hostIdentityFile(home), "utf8").trim(), identity);
});

test("R15：bootstrap 暴露 plugin.hostId（与 instanceId 不同、跨重启稳定）", async () => {
	const home = mkdtempSync(join(tmpdir(), "r15-route-"));
	const a = harness(home);
	const bodyA = await bootstrap(a.route);
	const hostA = bodyA.plugin?.hostId;
	assert.match(hostA ?? "", /^[0-9a-f-]{36}$/i, JSON.stringify(bodyA.plugin));
	assert.notEqual(hostA, bodyA.plugin?.instanceId, "hostId 不能是实例级身份");
	a.clean();

	const b = harness(home);
	const bodyB = await bootstrap(b.route);
	assert.equal(bodyB.plugin?.hostId, hostA, "同一宿主重启后 hostId 稳定");
	b.clean();
});

/** 并发启动 N 个子进程共同解析同一状态目录的宿主身份。 */
async function resolveConcurrently(home, count) {
	const pluginUrl = pathToFileURL(new URL("../lib/index.js", import.meta.url).pathname).href;
	const code = `const m = await import(process.env.PLUGIN_URL); process.stdout.write(m.resolveHostIdentity({ home: process.env.TEST_HOME }));`;
	const jobs = Array.from({ length: count }, () => new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
			env: { ...process.env, PLUGIN_URL: pluginUrl, TEST_HOME: home },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		child.stdout.on("data", (chunk) => { out += String(chunk); });
		child.stderr.on("data", (chunk) => { err += String(chunk); });
		child.on("error", reject);
		child.on("close", (status) => status === 0 ? resolve(out.trim()) : reject(new Error(`child exit ${status}: ${err}`)));
	}));
	return Promise.all(jobs);
}

test("recheck-7：并发初始化/自愈身份文件只有一个赢家（所有进程返回同一 UUID）", async () => {
	const home = mkdtempSync(join(tmpdir(), "r15-concurrent-"));
	const identities = await resolveConcurrently(home, 8);
	assert.equal(new Set(identities).size, 1, `并发进程必须得到同一身份：${JSON.stringify(identities)}`);
	assert.equal(readFileSync(hostIdentityFile(home), "utf8").trim(), identities[0]);
	// 文件已存在且损坏为空：多进程同时修复也必须收敛到同一个新身份。
	writeFileSync(hostIdentityFile(home), "");
	const repaired = await resolveConcurrently(home, 6);
	assert.equal(new Set(repaired).size, 1, `损坏修复也必须单赢家：${JSON.stringify(repaired)}`);
	assert.equal(readFileSync(hostIdentityFile(home), "utf8").trim(), repaired[0]);
});
