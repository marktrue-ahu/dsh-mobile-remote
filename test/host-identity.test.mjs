// issue #60 R15：宿主稳定身份（bootstrap plugin.hostId）与测试注入的持久化/原子发布。

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync, utimesSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
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
	// round5-1：新鲜但无效的内容视为"另一个进程写入中"，只等待不删除；
	// 崩溃残留需 mtime>5s 才允许清理重建。
	const old = new Date(Date.now() - 10_000);
	utimesSync(hostIdentityFile(home), old, old);
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
	// 文件已存在且损坏为空（mtime 陈旧 → 崩溃残留）：多进程同时修复也必须收敛到同一新身份。
	writeFileSync(hostIdentityFile(home), "");
	const stale = new Date(Date.now() - 10_000);
	utimesSync(hostIdentityFile(home), stale, stale);
	const repaired = await resolveConcurrently(home, 6);
	assert.equal(new Set(repaired).size, 1, `损坏修复也必须单赢家：${JSON.stringify(repaired)}`);
	assert.equal(readFileSync(hostIdentityFile(home), "utf8").trim(), repaired[0]);
});

/** 子进程解析身份；把结果/错误码作为唯一 stdout 输出。 */
function resolveInChild(home) {
	const pluginUrl = pathToFileURL(new URL("../lib/index.js", import.meta.url).pathname).href;
	const code = `const m = await import(process.env.PLUGIN_URL); try { process.stdout.write('OK:' + m.resolveHostIdentity({ home: process.env.TEST_HOME })); } catch (error) { process.stdout.write('ERR:' + String(error?.code ?? error?.message ?? error)); }`;
	return new Promise((resolve, reject) => {
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
	});
}

test("round5-1：写入者（wx 已占位）超过等待上限未发布时，等待者不得无锁写身份", async () => {
	const home = mkdtempSync(join(tmpdir(), "r15-held-"));
	const file = hostIdentityFile(home);
	mkdirSync(join(home, ".dsh", "mobile-remote"), { recursive: true });
	// 模拟持锁者在 writeSync 前被 SIGSTOP：身份文件已被 wx 创建但内容为空、mtime 新鲜。
	writeFileSync(file, "", { mode: 0o600 });
	try {
		const result = await resolveInChild(home); // 内部等待 3s 后超时
		assert.match(result, /^ERR:HOST_IDENTITY_LOCK_UNAVAILABLE$/, `等待者必须显式降级而不是发布：${result}`);
		assert.equal(readFileSync(file, "utf8"), "", "等待者绝不能覆盖/删除新鲜的空身份文件");
		// 持锁者恢复并写入后，后续竞争者读取同一身份。
		const winner = "11111111-1111-4111-8111-111111111111";
		writeFileSync(file, `${winner}\n`);
		const identities = await resolveConcurrently(home, 4);
		assert.deepEqual(new Set(identities), new Set([winner]));
	} finally {
		/* 临时目录由系统回收 */
	}
});

test("round4-1：陈旧锁（mtime>5s）清理后必须重新抢锁才发布", () => {
	const home = mkdtempSync(join(tmpdir(), "r15-stale-"));
	const file = hostIdentityFile(home);
	mkdirSync(join(home, ".dsh", "mobile-remote"), { recursive: true });
	writeFileSync(file, "", { mode: 0o600 });
	const old = new Date(Date.now() - 10_000);
	utimesSync(file, old, old);
	const identity = resolveHostIdentity({ home });
	assert.match(identity, /^[0-9a-f-]{36}$/i);
	assert.equal(readFileSync(file, "utf8").trim(), identity, "崩溃残留空文件必须被替换为有效身份");
});

test("round4-1：open 非 EEXIST 失败且无有效文件 → 抛可诊断错误且不写文件", () => {
	const home = mkdtempSync(join(tmpdir(), "r15-broken-"));
	// 让插件状态目录路径被一个**文件**占用：mkdirSync 会 ENOTDIR。
	writeFileSync(join(home, ".dsh"), "not-a-directory");
	assert.throws(
		() => resolveHostIdentity({ home }),
		(error) => error?.code === "HOST_IDENTITY_LOCK_UNAVAILABLE",
	);
	assert.equal(existsSync(hostIdentityFile(home)), false);
});

test("round4-1：状态目录不可写时 bootstrap 降级为进程内 hostId（不写文件）", async () => {
	const home = mkdtempSync(join(tmpdir(), "r15-degraded-"));
	writeFileSync(join(home, ".dsh"), "not-a-directory");
	const h = harness(home);
	const body = await bootstrap(h.route);
	assert.match(body.plugin?.hostId ?? "", /^[0-9a-f-]{36}$/i, "降级仍要给出非空 hostId 供 App 使用");
	assert.equal(existsSync(hostIdentityFile(home)), false, "降级路径不得创建共享身份文件");
	assert.equal(body.plugin?.hostId === body.plugin?.instanceId, false);
	h.clean();
});

test("round5-1：两个 cleaner 交错清理陈旧残留也只能产生一个 UUID", async () => {
	const home = mkdtempSync(join(tmpdir(), "r15-cleaners-"));
	const file = hostIdentityFile(home);
	mkdirSync(join(home, ".dsh", "mobile-remote"), { recursive: true });
	writeFileSync(file, "", { mode: 0o600 });
	const old = new Date(Date.now() - 10_000);
	utimesSync(file, old, old);
	const identities = await resolveConcurrently(home, 2);
	assert.equal(new Set(identities).size, 1, `两个 cleaner 交错必须收敛同一 UUID：${JSON.stringify(identities)}`);
	assert.equal(readFileSync(file, "utf8").trim(), identities[0]);
});

test("round5-1 TOCTOU：A 暂停期间 B 发布有效身份，A 的 rename 只能移到有效文件并恢复", () => {
	const home = mkdtempSync(join(tmpdir(), "r15-toctou-"));
	const file = hostIdentityFile(home);
	mkdirSync(join(home, ".dsh", "mobile-remote"), { recursive: true });
	writeFileSync(file, "", { mode: 0o600 });
	const old = new Date(Date.now() - 10_000);
	utimesSync(file, old, old);
	const winner = "22222222-2222-4222-8222-222222222222";
	// A 观察到陈旧残留后暂停；B 在此窗口完成 wx 写入并返回（路径已是有效身份）。
	const resolved = resolveHostIdentity({
		home,
		onBeforeRename: () => { writeFileSync(file, `${winner}\n`); },
	});
	assert.equal(resolved, winner, "A 只能返回已发布的 B 身份，不能返回自己的 UUID");
	assert.equal(readFileSync(file, "utf8").trim(), winner);
	const leftovers = readdirSync(join(home, ".dsh", "mobile-remote")).filter((name) => name.includes(".quarantine."));
	assert.deepEqual(leftovers, [], "有效文件被隔离后必须恢复，不能残留隔离文件");
});

test("round5-1 TOCTOU：隔离后路径已被另一个有效身份占用时安全丢弃隔离文件", () => {
	const home = mkdtempSync(join(tmpdir(), "r15-toctou2-"));
	const file = hostIdentityFile(home);
	mkdirSync(join(home, ".dsh", "mobile-remote"), { recursive: true });
	writeFileSync(file, "", { mode: 0o600 });
	const old = new Date(Date.now() - 10_000);
	utimesSync(file, old, old);
	const other = "33333333-3333-4333-8333-333333333333";
	const resolved = resolveHostIdentity({
		home,
		onQuarantined: () => { writeFileSync(file, `${other}\n`); },
	});
	assert.equal(resolved, other, "路径已被有效占用时返回路径值并丢弃隔离文件");
	assert.equal(readFileSync(file, "utf8").trim(), other);
	const leftovers = readdirSync(join(home, ".dsh", "mobile-remote")).filter((name) => name.includes(".quarantine."));
	assert.deepEqual(leftovers, [], "隔离文件必须被安全丢弃");
});

test("round5-1 inode 校验：写入后路径被替换，赢家不得返回自己的 UUID", () => {
	const home = mkdtempSync(join(tmpdir(), "r15-inode-"));
	const file = hostIdentityFile(home);
	mkdirSync(join(home, ".dsh", "mobile-remote"), { recursive: true });
	const other = "44444444-4444-4444-8444-444444444444";
	const resolved = resolveHostIdentity({
		home,
		onBeforeInodeCheck: () => {
			unlinkSync(file);
			writeFileSync(file, `${other}\n`);
		},
	});
	assert.equal(resolved, other, "路径已不是自己的 inode 时必须返回已发布值，而不是未持久化的 UUID");
	assert.equal(readFileSync(file, "utf8").trim(), other);
});

test("round6-1 D1：有效隔离文件恢复绝不覆盖并发 wx 发布者", () => {
	const home = mkdtempSync(join(tmpdir(), "r15-restore-"));
	const file = hostIdentityFile(home);
	mkdirSync(join(home, ".dsh", "mobile-remote"), { recursive: true });
	writeFileSync(file, "", { mode: 0o600 });
	const old = new Date(Date.now() - 10_000);
	utimesSync(file, old, old);
	// A 的观察窗口内有人把文件写成有效身份 X → A 会把它作为 quarantine 移走。
	const quarantined = "55555555-5555-4555-8555-555555555555";
	let winnerFromB = null;
	const pluginUrl = pathToFileURL(new URL("../lib/index.js", import.meta.url).pathname).href;
	const childCode = `const m = await import(process.env.PLUGIN_URL); process.stdout.write(m.resolveHostIdentity({ home: process.env.TEST_HOME }));`;
	const resolved = resolveHostIdentity({
		home,
		onBeforeRename: () => { writeFileSync(file, `${quarantined}\n`); },
		onBeforeRestore: () => {
			// A 把有效文件移入 quarantine、路径短暂空闲；真实 B 进程此刻赢得 wx 并发布 Y。
			const child = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
				env: { ...process.env, PLUGIN_URL: pluginUrl, TEST_HOME: home },
				encoding: "utf8",
			});
			assert.equal(child.status, 0, child.stderr);
			winnerFromB = child.stdout.trim();
		},
	});
	assert.match(winnerFromB ?? "", /^[0-9a-f-]{36}$/i, "B 必须已发布有效身份");
	assert.equal(resolved, winnerFromB, "A 不得覆盖 B 的合法发布，必须返回 B 的 UUID");
	assert.equal(readFileSync(file, "utf8").trim(), winnerFromB, "磁盘必须是 B 的身份");
	const leftovers = readdirSync(join(home, ".dsh", "mobile-remote")).filter((name) => name.includes(".quarantine."));
	assert.deepEqual(leftovers, [], "隔离文件必须被丢弃，不能残留");
});
