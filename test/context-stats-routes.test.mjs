// issue #158 / ADR 0038：上下文统计只读端点的契约。
//
// 四量分离：pressure / breakdown / tokenUsage / timing 各自独立；缺投影省略字段，
// 不返回 0 冒充；不返回 prompt/正文/工具定义内容。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let apply;
let testHome;

test.before(async () => {
	testHome = await mkdtemp(join(tmpdir(), "dsh-mobile-context-stats-"));
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

// wireValues 是客户端可见的 wire view（与宿主 unit 的 wire.view 同形状）：
//   contextPressure: {pressureTokens?,projectedTokens?,contextWindow?}
//   contextBreakdown: {systemTokens,toolsTokens,messageTokens}
//   tokenUsage: {uncachedInputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}
//   sessionStats: {turns,steps,llmMs,toolMs,ttftMs,ttftSteps,decodeMs,decodeTokens}
// rawStates 刻意返回错误形状（tokenUsage.totals / contextBreakdown.breakdown /
// contextPressure 无 projected），用于证明 endpoint 只读 snapshot.values。
function createHarness({
	wireValues = {},
	rawStates = {},
	asOfSeq = 7,
	failKeys = new Set(),
	cuts = {},
	sessionExists = true,
} = {}) {
	const routes = [];
	const events = [{ seq: 1, type: "turn/start", data: { turn: 1 } }, { seq: 7, type: "turn/end", data: { turn: 1 } }];
	const session = sessionExists ? { id: "s-158", snapshotEvents: () => events } : undefined;
	const provided = new Map([
		["sessions", { get: (id) => (id === "s-158" ? session : undefined), list: () => (session ? [session] : []) }],
		["sessionProjections", {
			snapshot: (s, keys) => {
				if (s !== session) return { asOfSeq: -1, values: {} };
				const key = Array.isArray(keys) ? keys[0] : undefined;
				// 模拟某个 unit 的 viewSchema 抛错：只影响该 key 的单独读取。
				if (key && failKeys.has(key)) throw new Error(`viewSchema failed: ${key}`);
				const cut = key && Object.hasOwn(cuts, key) ? cuts[key] : asOfSeq;
				return {
					asOfSeq: cut,
					values: key
						? (wireValues[key] === undefined ? {} : { [key]: wireValues[key] })
						: wireValues,
				};
			},
			// 旧实现读的就是 raw state；这里给错误形状，若再回退 stateOf 测试会立刻失败。
			stateOf: (s, key) => (s === session ? rawStates[key] : undefined),
		}],
	]);
	const ctx = {
		webServer: { host: "127.0.0.1", port: 43130, register(spec) { routes.push(spec); return () => {}; } },
		logger: { warn() {}, info() {} },
		get(name) { return provided.get(name); },
		provide(name, value) { provided.set(name, value); },
		on() { return () => {}; },
		effect(callback) { const d = callback?.(); return typeof d === "function" ? d : () => {}; },
		inject() {},
	};
	const dispose = apply(ctx, CONFIG, {});
	return { route: routes.find((r) => r.path === "/m/api").handler, clean() { dispose?.(); } };
}

async function call(route, url = "/m/api/context-stats?sessionId=s-158", method = "GET") {
	const req = new FakeRequest(url, method);
	const res = new FakeResponse();
	const finished = new Promise((resolve) => res.once("finish", resolve));
	route(req, res);
	await finished;
	const raw = res.chunks.join("");
	let body;
	try { body = JSON.parse(raw); } catch { body = raw; }
	return { status: res.statusCode, body };
}

const FULL = {
	contextPressure: { pressureTokens: 1000, projectedTokens: 1200, contextWindow: 8000 },
	contextBreakdown: { systemTokens: 400, toolsTokens: 600, messageTokens: 800 },
	tokenUsage: { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 300, cacheWriteTokens: 100 },
	sessionStats: { turns: 2, steps: 4, llmMs: 1000, toolMs: 500, ttftMs: 400, ttftSteps: 2, decodeMs: 2000, decodeTokens: 100 },
};

test("完整投影：四块字段/百分比/缓存命中率/TTFT/TPS/来源/asOfSeq", async () => {
	const h = createHarness({ wireValues: FULL });
	const { status, body } = await call(h.route);
	h.clean();
	assert.equal(status, 200);
	assert.equal(body.ok, true);
	assert.equal(body.sessionId, "s-158");
	assert.deepEqual(body.pressure, { pressureTokens: 1000, projectedTokens: 1200, contextWindow: 8000, percent: 15 });
	assert.deepEqual(body.breakdown, { systemTokens: 400, toolsTokens: 600, messageTokens: 800, estimated: true });
	assert.deepEqual(body.tokenUsage, { uncachedInput: 100, output: 50, cacheRead: 300, cacheWrite: 100, cacheHitRate: 0.6 });
	assert.equal(body.timing.turns, 2);
	assert.equal(body.timing.steps, 4);
	assert.equal(body.timing.avgTtftMs, 200);
	assert.equal(body.timing.tps, 50);
	assert.deepEqual(body.sources, { pressure: "provider", breakdown: "heuristic", tokenUsage: "provider", timing: "session-stats" });
	assert.equal(body.asOfSeq, 7);
	// 只统计不返回正文/工具定义。
	const raw = JSON.stringify(body);
	assert.equal(raw.includes("content"), false);
	assert.equal(raw.includes("prompt"), false);
});

test("缺投影：省略四块、不返回 0 冒充（仅 ok/sessionId/asOfSeq）", async () => {
	const h = createHarness({ wireValues: {} });
	const { status, body } = await call(h.route);
	h.clean();
	assert.equal(status, 200);
	assert.deepEqual(body, { ok: true, sessionId: "s-158", asOfSeq: 7 });
});

test("部分投影：缺的 block 省略，不整页失败", async () => {
	const h = createHarness({
		wireValues: {
			contextPressure: { contextWindow: 8000 },
			contextBreakdown: { systemTokens: 1, toolsTokens: 2 }, // 缺 messageTokens
			tokenUsage: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
		},
	});
	const { status, body } = await call(h.route);
	h.clean();
	assert.equal(status, 200);
	assert.deepEqual(body.pressure, { contextWindow: 8000 }, "没有 tokens 时不算 percent");
	assert.equal(body.breakdown, undefined);
	assert.equal(body.tokenUsage.cacheHitRate, 0, "billed>0 时 cacheRead=0 是真实 0");
	assert.equal(body.timing, undefined);
	assert.deepEqual(body.sources, { pressure: "provider", tokenUsage: "provider" });
});

test("zero billed：不计算 cacheHitRate，不伪造 0 命中率", async () => {
	const h = createHarness({
		wireValues: {
			tokenUsage: { uncachedInputTokens: 0, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
		},
	});
	const { body } = await call(h.route);
	h.clean();
	assert.equal(body.tokenUsage.cacheHitRate, undefined);
	assert.equal(body.tokenUsage.output, 5);
});

test("只读 wire snapshot：raw state 的错误形状不得泄漏/回退", async () => {
	const h = createHarness({
		wireValues: {
			contextPressure: { pressureTokens: 1000, projectedTokens: 5000, contextWindow: 8000 },
			contextBreakdown: { systemTokens: 400, toolsTokens: 600, messageTokens: 800 },
			tokenUsage: { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 300, cacheWriteTokens: 100 },
			sessionStats: { turns: 1, steps: 1, llmMs: 10, toolMs: 20, ttftMs: 30, ttftSteps: 1, decodeMs: 40, decodeTokens: 5 },
		},
		rawStates: {
			// 真实 raw state 形状：tokenUsage 顶层是 totals/last；breakdown 包一层；
			// pressure 没有 projectedTokens。
			tokenUsage: { totals: { uncachedInputTokens: 999 }, last: null },
			contextBreakdown: { breakdown: { systemTokens: 999, toolsTokens: 999, messageTokens: 999 } },
			contextPressure: { pressureTokens: 111, contextWindow: 9999 },
		},
	});
	const { body } = await call(h.route);
	h.clean();
	assert.equal(body.pressure.projectedTokens, 5000, "projected 必须来自 wire.view");
	assert.equal(body.pressure.percent, 63, "percent 用 projected/window 而非 raw pressure");
	assert.equal(body.breakdown.systemTokens, 400, "breakdown 必须来自 wire 扁平值");
	assert.equal(body.tokenUsage.uncachedInput, 100, "tokenUsage 必须来自 wire 扁平值");
	assert.equal(body.timing.turns, 1);
	assert.equal(body.asOfSeq, 7);
});

test("单个 unit/viewSchema 抛错：只降级该块，其余块仍返回", async () => {
	const h = createHarness({
		wireValues: FULL,
		failKeys: new Set(["contextBreakdown"]),
	});
	const { status, body } = await call(h.route);
	h.clean();
	assert.equal(status, 200);
	assert.equal(body.breakdown, undefined, "损坏的 breakdown 只降级自己");
	assert.ok(body.pressure && body.tokenUsage && body.timing, "健康块不得被连坐");
	assert.deepEqual(body.sources, {
		pressure: "provider",
		tokenUsage: "provider",
		timing: "session-stats",
	});
	assert.equal(body.asOfSeq, undefined, "缺一块时不得给全局原子 cut");
	assert.deepEqual(body.asOfSeqByBlock, {
		pressure: 7,
		tokenUsage: 7,
		timing: 7,
	});
});

test("各块 cut 不一致：不给全局 asOfSeq，按块如实标注", async () => {
	const h = createHarness({
		wireValues: FULL,
		cuts: { contextPressure: 5, contextBreakdown: 6, tokenUsage: 7, sessionStats: 8 },
	});
	const { body } = await call(h.route);
	h.clean();
	assert.equal(body.asOfSeq, undefined);
	assert.deepEqual(body.asOfSeqByBlock, {
		pressure: 5,
		breakdown: 6,
		tokenUsage: 7,
		timing: 8,
	});
});

test("会话不存在 404；缺 sessionId 400；方法不符拒绝", async () => {
	const h = createHarness({ sessionExists: false });
	assert.equal((await call(h.route)).status, 404);
	assert.equal((await call(h.route, "/m/api/context-stats")).status, 400);
	assert.equal((await call(h.route, "/m/api/context-stats?sessionId=s-158", "POST")).status, 405);
	h.clean();
});
