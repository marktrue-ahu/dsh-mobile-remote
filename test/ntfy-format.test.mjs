import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { apply } from "../lib/index.js";

// Issue #12 回归：ntfy 出站推送的 wire 形状 + 真实投递。
//
// 缺陷背景：配置里的 url 是 **topic URL**（https://ntfy.sh/<topic>）。ntfy 的 JSON 发布
// 只对根 URL（https://ntfy.sh/，body 里另带 topic）生效；旧实现把 {title,message} JSON
// POST 到 topic URL，ntfy 遂把整段 JSON 当纯文本正文 → 通知标题丢失、手机正文是一坨 JSON。
// 修复形状：POST topic URL，content-type: text/plain; charset=utf-8，标题走 X-Title 头，
// 正文是纯详情文本；只有这个形状 ntfy 才会解析出 title 字段。
//
// 补正（第二层缺陷）：X-Title 的值含中文/emoji 时不能原样进 undici 头值——WebIDL 的
// ByteString 转换要求每个码点 ≤ 0xFF，原样下发会在**建连之前**抛 TypeError，推送整条失败。
// 现实现先把标题按 RFC 2047 编码成 ASCII 编码字（=?UTF-8?B?...?=，按 UTF-8 码点分片），
// ntfy 端会解码回原文（B 的真实回读 + 独立探针均证实）。
//
// 本文件是「字节级 wire 形状 + 公网真实投递」双重复现：
//   A：本地回声服务器 → 断言四格式（generic/ntfy/bark/serverchan）字节级形状；
//   B：ntfy.sh 真实主题 → 回读记录必须带 title 字段（#12 的直接观测量，附同主题对照）；
//   C：minimal 脱敏在真实投递链路上不泄露会话标题/详情；
//   D：正向钉桩——插件实际下发的 X-Title 是 ASCII 安全、undici 可接受、可往返还原的编码字。
// 复用 test/compat-0.1.5.test.mjs 的 harness 形态（fake req/res + 路由抓取 + 事件 fire）。

const NTFY_BASE = "https://ntfy.sh";
// /push-test 路由固定的测试文案（与 lib/index.js 的 /push-test 实现一一对应）
const TEST_KIND_LABEL = "🔔 测试通知";
const TEST_TITLE = "配置验证";
const TEST_DESP = "收到即说明该通道配置正确（来自 DSH Remote）";
// pushToChannel 的标题拼接：`${kindLabel} · ${title}`（分隔符 U+00B7）
const TEST_FULL_TITLE = `${TEST_KIND_LABEL} · ${TEST_TITLE}`;

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
	lanBridge: { enabled: false },
	approvalMode: "desktop",
};

const configWith = (pushUrls, extra = {}) => ({ ...CONFIG, pushUrls, ...extra });

class FakeResponse extends EventEmitter {
	constructor() {
		super();
		this.headersSent = false;
		this.destroyed = false;
		this.writableLength = 0;
		this.chunks = [];
	}
	writeHead(statusCode, headers) {
		this.statusCode = statusCode;
		this.headers = headers;
		this.headersSent = true;
	}
	write(chunk) {
		this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
		return true;
	}
	end(chunk = "") {
		if (chunk !== "") this.write(chunk);
		this.emit("finish");
	}
	destroy() {
		if (this.destroyed) return;
		this.destroyed = true;
		this.emit("close");
	}
}

class FakeRequest extends EventEmitter {
	constructor(url, method = "GET") {
		super();
		this.url = url;
		this.method = method;
		this.headers = { host: "127.0.0.1", "x-mobile-token": CONFIG.authToken, "content-type": "application/json" };
		this.socket = { remoteAddress: "127.0.0.1" };
	}
}

function createHarness(overrides = {}, config = CONFIG) {
	const routes = [];
	const listeners = new Map();
	const cleanups = [];
	const ctx = {
		webServer: { host: "127.0.0.1", port: 43120, register(spec) { routes.push(spec); return () => {}; } },
		logger: overrides.logger ?? { warn() {}, info() {} },
		get(name) {
			const override = overrides.get?.(name);
			if (override !== undefined) return override;
			const fallback = overrides.fallback?.(name);
			return fallback;
		},
		provide() {},
		effect(fn) { const c = fn?.(); cleanups.push(c); return c; },
		inject() {},
		on(event, fn) { listeners.set(event, fn); return () => listeners.delete(event); },
	};
	apply(ctx, config);
	return {
		route: routes.find((r) => r.path === `${config.path}/api`).handler,
		fire(event, ...args) { return listeners.get(event)?.(...args); },
		clean() { for (const c of cleanups.reverse()) c?.(); },
	};
}

async function postJson(route, body = {}, path = "/m/api/respond") {
	const req = new FakeRequest(path, "POST");
	const res = new FakeResponse();
	const done = new Promise((resolve) => res.once("finish", resolve));
	route(req, res);
	queueMicrotask(() => {
		req.emit("data", Buffer.from(JSON.stringify(body)));
		req.emit("end");
	});
	await done;
	return { status: res.statusCode, body: JSON.parse(res.chunks.at(-1)) };
}

/** 本地 HTTP 回声服务器：记录每个请求（method/path/headers/raw body）并回 200。 */
async function startEchoServer() {
	const records = [];
	const server = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			records.push({
				method: req.method,
				path: new URL(req.url ?? "/", "http://x").pathname,
				headers: req.headers,
				raw: Buffer.concat(chunks).toString("utf8"),
			});
			res.writeHead(200, { "content-type": "application/json" });
			res.end("{}");
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	return {
		records,
		base: `http://127.0.0.1:${port}`,
		async close() {
			// 先关 listener 再强拆 keep-alive 连接，避免 server.close() 等连接空闲超时
			const closed = new Promise((resolve) => server.close(resolve));
			server.closeAllConnections?.();
			await closed;
		},
	};
}

/** ntfy 公网主题随机名（时间戳 + 随机后缀，避免撞已有主题）。 */
const ntfyTopic = (tag) => `dsh-fix12-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** RFC 2047 编码字解码（=?UTF-8?B?...?=，多片以空格连接）——即 ntfy 服务端所做之事。 */
function decodeRfc2047(value) {
	return String(value)
		.split(" ")
		.map((word) => {
			const m = /^=\?UTF-8\?B\?([^?]*)\?=$/.exec(word);
			return m ? Buffer.from(m[1], "base64").toString("utf8") : word;
		})
		.join("");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** ntfy.sh 匿名限额对**读和写都生效**：HTTP 429 是环境限制，不是被测行为。 */
const isQuotaError = (err) => /HTTP 429/.test(String(err ?? ""));

/** 经 harness 发 /push-test：真实失败（含 wire 形状错误，如 undici ByteString）原样返回交断言；
 *  只有 HTTP 429 才退避重试，重试仍被限流才 skip——既不把环境限制报成产品缺陷，也不吞掉真实失败。 */
async function pushTestWithinQuota(t, harness, { attempts = 3, waitMs = 15_000 } = {}) {
	let last = null;
	for (let i = 1; i <= attempts; i++) {
		const res = await postJson(harness.route, {}, "/m/api/push-test");
		assert.equal(res.status, 200);
		last = res.body.results?.[0];
		if (last?.ok === true || !isQuotaError(last?.error)) return last;
		if (i < attempts) {
			t.diagnostic(`ntfy.sh 发布被限流（第 ${i}/${attempts} 次）：${last.error}；${waitMs}ms 后重试`);
			await sleep(waitMs);
		}
	}
	t.skip(`ntfy.sh 匿名发布限流（429，重试 ${attempts} 次仍未通过）：公网限额属环境限制，非被测行为`);
	return null;
}

/** 对照组直发（ntfy 官方文档形状）：429 同样退避重试，仍限流则 skip 并返回 null。 */
async function rawPublishWithinQuota(t, url, init, { attempts = 3, waitMs = 15_000 } = {}) {
	for (let i = 1; i <= attempts; i++) {
		const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
		if (res.status !== 429) return res;
		if (i < attempts) {
			t.diagnostic(`ntfy.sh 对照发布被限流（第 ${i}/${attempts} 次）；${waitMs}ms 后重试`);
			await sleep(waitMs);
		}
	}
	t.skip(`ntfy.sh 匿名发布限流（429，重试 ${attempts} 次仍未通过）：公网限额属环境限制，非被测行为`);
	return null;
}

/** GET /<topic>/json?poll=1 → 换行分隔 JSON 记录数组（poll=1 取缓存后立即关闭；直连不走代理）。
 *  429 = ntfy.sh 匿名读接口限流（≈12 次/分钟，与主题无关）→ 返回 null 交调用方退避，
 *  绝不把限流误报成「记录不存在」。 */
async function ntfyPoll(topic) {
	const res = await fetch(`${NTFY_BASE}/${topic}/json?poll=1`, { signal: AbortSignal.timeout(20_000) });
	if (res.status === 429) return null;
	assert.equal(res.status, 200, `ntfy poll HTTP ${res.status}`);
	const text = await res.text();
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line));
}

/** 轮询直到出现满足 predicate 的 message 记录。
 *  公网限流很紧：有效轮询最多 attempts 次（间隔 intervalMs），429 走长退避且不计入有效次数；
 *  一次有效回读都没拿到 = 环境限流 → skip（返回 null），不伪装成「记录不存在」。 */
async function ntfyPollFor(topic, predicate, t, { attempts = 3, intervalMs = 3000, rateLimitMs = 6000 } = {}) {
	let records = [];
	let polls = 0;
	let rounds = 0;
	while (polls < attempts && rounds < attempts + 3) {
		rounds++;
		const polled = await ntfyPoll(topic);
		if (polled === null) {
			await new Promise((resolve) => setTimeout(resolve, rateLimitMs));
			continue;
		}
		polls++;
		records = polled;
		if (records.some((r) => r.event === "message" && predicate(r))) return records;
		if (polls < attempts) await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	if (polls === 0) {
		t.skip(`ntfy.sh 匿名读取限流（连续 ${rounds} 次 429），无法回读主题 ${topic}：环境限制，非被测行为`);
		return null;
	}
	return records;
}

test("A(#12): /push-test 四格式 wire 形状（generic / ntfy / bark / serverchan）", async (t) => {
	const echo = await startEchoServer();
	const cfg = configWith([
		{ name: "g", url: `${echo.base}/generic`, format: "generic" },
		{ name: "n", url: `${echo.base}/ntfy`, format: "ntfy" },
		{ name: "b", url: `${echo.base}/bark`, format: "bark" },
		{ name: "s", url: `${echo.base}/serverchan`, format: "serverchan" },
	]);
	const harness = createHarness({}, cfg);
	try {
		const res = await postJson(harness.route, {}, "/m/api/push-test");
		assert.equal(res.status, 200);
		assert.equal(res.body.ok, true);
		assert.equal(res.body.channels, 4);
		// ntfy 通道必须先送达。X-Title 头若带着 emoji/中文原样下发，undici 会在发出前
		// 抛 ByteString 转换错误（头值不得 > 0xFF）→ 这里直接把真实错误打出来。
		const ntfyResult = res.body.results.find((r) => r.format === "ntfy");
		if (ntfyResult?.ok !== true) {
			t.diagnostic(`A ntfy 通道未送达：${JSON.stringify(ntfyResult)}`);
		}
		assert.equal(ntfyResult?.ok, true, `ntfy 通道发送失败：${ntfyResult?.error ?? "无结果"}`);
		assert.deepEqual(
			res.body.results,
			[
				{ name: "g", format: "generic", ok: true },
				{ name: "n", format: "ntfy", ok: true },
				{ name: "b", format: "bark", ok: true },
				{ name: "s", format: "serverchan", ok: true },
			],
			"四个通道全部 ok:true",
		);
		assert.equal(echo.records.length, 4, "四个通道各发一次（pushToChannel 已 await，响应返回即记录完毕）");

		const byPath = new Map(echo.records.map((r) => [r.path, r]));
		assert.deepEqual([...byPath.keys()].sort(), ["/bark", "/generic", "/ntfy", "/serverchan"]);
		for (const rec of echo.records) {
			assert.equal(rec.method, "POST");
			assert.equal(rec.headers["user-agent"], "dsh-mobile-remote", "统一 UA 标识");
		}

		// generic —— JSON: { kind, title, detail, sessionId, time }
		const generic = byPath.get("/generic");
		assert.equal(generic.headers["content-type"], "application/json");
		const g = JSON.parse(generic.raw);
		assert.deepEqual(Object.keys(g).sort(), ["detail", "kind", "sessionId", "time", "title"]);
		assert.equal(g.kind, "test");
		assert.equal(g.title, TEST_TITLE);
		assert.equal(g.detail, TEST_DESP);
		assert.equal(g.sessionId, "");
		assert.equal(typeof g.time, "number");

		// ntfy（#12 修复形状）—— POST topic URL，纯文本正文 + X-Title 头；
		// 正文**不是** JSON（旧实现把 {title,message} JSON POST 到 topic URL，标题丢失）
		const ntfy = byPath.get("/ntfy");
		assert.equal(ntfy.headers["content-type"], "text/plain; charset=utf-8", "ntfy 正文必须是纯文本");
		// 标题走 X-Title 头，且线上值必须 ASCII 安全：undici 的 ByteString 转换拒绝码点 > 0xFF，
		// 中文/emoji 原样下发会在建连前抛错（整条推送失败）。非 ASCII 标题按 RFC 2047 编码字下发，
		// ntfy 服务端解码回原文（B 的真实回读即证）。
		const ntfyTitle = ntfy.headers["x-title"];
		assert.equal(typeof ntfyTitle, "string", "必须走 X-Title 头承载标题");
		assert.match(ntfyTitle, /^[\x20-\x7E]+$/, "线上头值必须 ASCII 安全（否则 undici 建连前抛 TypeError）");
		assert.match(ntfyTitle, /^=\?UTF-8\?B\?[^?]+\?=$/, "多字节标题必须 RFC 2047 编码字");
		assert.equal(decodeRfc2047(ntfyTitle), TEST_FULL_TITLE, "ntfy 解码后必须还原原标题");
		assert.equal(ntfy.raw, TEST_DESP, "正文是纯详情文本，不含 JSON 包装");
		assert.ok(!ntfy.raw.includes('"message"'), "正文不得是 {title,message} JSON");
		assert.throws(() => JSON.parse(ntfy.raw), "正文不得是合法 JSON");

		// bark —— JSON: { title, body }
		const bark = byPath.get("/bark");
		assert.equal(bark.headers["content-type"], "application/json");
		assert.deepEqual(JSON.parse(bark.raw), { title: TEST_FULL_TITLE, body: TEST_DESP });

		// serverchan —— form: title / desp
		const serverchan = byPath.get("/serverchan");
		assert.equal(serverchan.headers["content-type"], "application/x-www-form-urlencoded");
		const form = new URLSearchParams(serverchan.raw);
		assert.deepEqual([...form.keys()].sort(), ["desp", "title"]);
		assert.equal(form.get("title"), TEST_FULL_TITLE);
		assert.equal(form.get("desp"), TEST_DESP);
	} finally {
		harness.clean();
		await echo.close();
	}
});

test("B(#12): 真实第三方投递 —— ntfy.sh 回读记录必须带 title 字段（关键断言）", async (t) => {
	const topic = ntfyTopic("b");
	const cfg = configWith([{ name: "ntfy-live", url: `${NTFY_BASE}/${topic}`, format: "ntfy" }]);
	const harness = createHarness({}, cfg);
	try {
		const pushResult = await pushTestWithinQuota(t, harness);
		if (pushResult === null) return; // 公网发布限流：已标记 skip

		// 对照实验：往**同一主题**用 ntfy 官方文档形状（ASCII 标题 + X-Title 头）直发，
		// 回读能解析出 title → 证明「读不到 title」不是主题、回读或网络的问题。
		const controlTitle = `FIX12-CONTROL-${Date.now()}`;
		const controlBody = "fix12-control-body";
		const controlRes = await rawPublishWithinQuota(t, `${NTFY_BASE}/${topic}`, {
			method: "POST",
			headers: { "content-type": "text/plain; charset=utf-8", "x-title": controlTitle },
			body: controlBody,
		});
		if (controlRes === null) return; // 同上
		assert.equal(controlRes.status, 200);
		const afterControl = await ntfyPollFor(topic, (r) => r.title === controlTitle, t);
		if (afterControl === null) return;
		const control = afterControl.find((r) => r.event === "message" && r.title === controlTitle);
		assert.ok(control, `对照消息未到达（回读通道本身可用？）：${JSON.stringify(afterControl)}`);
		assert.equal(control.message, controlBody);
		t.diagnostic(`B 对照组（回读通道可用）实收：${JSON.stringify(control)}`);

		// 关键断言：插件经 harness 发出的 /push-test 记录到达主题，且 title 字段 == 预期标题。
		// 这正是 #12 坏掉的东西：旧实现（JSON 发 topic URL）回读到的 title 是 undefined。
		const records = await ntfyPollFor(topic, (r) => r.title === TEST_FULL_TITLE, t);
		if (records === null) return;
		const rec = records.find((r) => r.event === "message" && r.title === TEST_FULL_TITLE);
		if (rec) t.diagnostic(`B 插件实收 ntfy 记录：${JSON.stringify(rec)}`);
		assert.ok(
			rec,
			`ntfy.sh 主题 ${topic} 未收到带 title 的插件推送；推送结果=${JSON.stringify(pushResult)}；实收=${JSON.stringify(records)}`,
		);
		assert.equal(rec.topic, topic);
		assert.equal(rec.title, TEST_FULL_TITLE, "回读记录必须带 title 字段（#12 的直接观测量）");
		assert.equal(rec.message, TEST_DESP, "正文是纯详情文本");
	} finally {
		harness.clean();
	}
});

test("C(#12): minimal 模式脱敏 —— 真实 turn/end→doneGrace 链路不向 ntfy 泄露标题/详情", async (t) => {
	// 合成会话 id：不把任何真实会话标识推到公网主题
	const sessionId = "session-fix12-test-00000000-0000-0000-0000-000000000000";
	const shortId = `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}`; // session-…0000
	const secretTitle = "SECRET-TITLE-MARKER";
	const detailTurn = 987654321; // 详情模板 `任务完成（轮次 ${turn}）` 中的轮次号 = 详情标记
	const doneLabel = "✅ 任务完成";
	const redactedDesp = "详情请在 DSH Remote App 中查看"; // 详情被清空后 pushToChannel 的兜底文案
	const expectedTitle = `${doneLabel} · ${shortId}`; // minimal：只有事件标签 + 会话短码

	const topic = ntfyTopic("c");
	const cfg = configWith([{ name: "ntfy-c", url: `${NTFY_BASE}/${topic}`, format: "ntfy" }]);

	let titleReads = 0;
	const session = {
		id: sessionId,
		header: { createdAt: Date.now(), cwd: "/tmp/fix12" }, // 无 origin=subagent → 走正常「完成」通知路径
		snapshotEvents() {
			titleReads++;
			return [{ seq: 1, type: "session/title", data: { title: secretTitle } }];
		},
	};
	const agents = {
		get: (sid) => (sid === sessionId ? { id: sessionId, status: "idle" } : undefined),
		roots: () => [],
		list: () => [],
	};
	const sessions = { get: (sid) => (sid === sessionId ? session : undefined), list: () => [session] };
	// 捕获插件日志：pushToChannel 的失败原因（含公网 429）只能从这里看到
	const pushLogs = [];
	const harness = createHarness({
		get: (name) => (name === "agents" ? agents : name === "sessions" ? sessions : undefined),
		logger: { warn: (m) => pushLogs.push(String(m)), info: (m) => pushLogs.push(String(m)) },
	}, cfg);
	try {
		// 真实触发链：turn/end(completed) → armDone 暂存 → doneGraceMs(1ms) 后 pushSend（minimal 脱敏）
		harness.fire("session/event", session, {
			type: "turn/end",
			data: { reason: { kind: "completed" }, turn: detailTurn },
		});
		harness.fire("agent/status", { agent: { id: `session:${sessionId}`, session }, status: "idle" });

		const records = await ntfyPollFor(topic, (r) => r.title === expectedTitle, t);
		if (records === null) return;
		const rec = records.find((r) => r.event === "message" && r.title === expectedTitle);
		if (rec) t.diagnostic(`C 实收 ntfy 记录：${JSON.stringify(rec)}`);
		// 未送达且日志显示公网限流 → 环境限制，跳过；其余未送达照旧断言失败（真回归）
		const quotaLog = pushLogs.find((line) => isQuotaError(line));
		if (!rec && quotaLog) {
			t.skip(`ntfy.sh 匿名发布限流导致推送未送达：${quotaLog}（环境限制，非被测行为）`);
			return;
		}
		assert.ok(rec, `任务完成通知未按修复形状到达主题 ${topic}；实收：${JSON.stringify(records)}`);

		// 修复形状下 title 必须是「事件标签 · 会话短码」，正文是兜底脱敏文案
		assert.equal(rec.title, expectedTitle, "标题为「事件标签 · 会话短码」");
		assert.equal(rec.message, redactedDesp, "详情被清空 → 走 pushToChannel 兜底文案");
		const delivered = `${rec.title}\n${rec.message}`;
		assert.ok(!delivered.includes(secretTitle), `会话标题 ${secretTitle} 不得出网；实收：${delivered}`);
		assert.ok(!delivered.includes(String(detailTurn)), `详情（轮次号）不得出网；实收：${delivered}`);
		assert.ok(!delivered.includes("（轮次"), `详情模板不得出网；实收：${delivered}`);
		// 反证：标题确实被插件读到过，脱敏不是因为「标题压根不可见」
		assert.ok(titleReads > 0, "插件读取过会话标题（随后才被 minimal 脱敏）");
	} finally {
		harness.clean();
	}
});

test("D(#12 正向钉桩): 插件实际下发的 X-Title 是 ASCII 安全、undici 可接受、可往返还原的编码字", async (t) => {
	// 运行期约束（本钉桩的由来）：fetch 的头值经 WebIDL ByteString 转换，码点 > 0xFF 直接抛
	// 「Cannot convert argument to a ByteString…」——且发生在建连之前，所以带中文/emoji 的标题
	// **必须**编码后才能上 X-Title 头。本用例不看内部函数，只钉插件真实发出的那串头值。
	const echo = await startEchoServer();
	const harness = createHarness({}, configWith([{ name: "n", url: `${echo.base}/ntfy`, format: "ntfy" }]));
	try {
		const res = await postJson(harness.route, {}, "/m/api/push-test");
		assert.equal(res.status, 200);
		const ntfy = echo.records.find((r) => r.path === "/ntfy");
		assert.ok(ntfy, "ntfy 通道必须真的发出请求（编码失败会连请求都发不出）");
		const wire = ntfy.headers["x-title"];
		assert.equal(typeof wire, "string");

		// ① ASCII 安全：每个字符都在可打印 ASCII 范围内（undici 只接受 ≤ 0xFF，非 ASCII 需编码）
		assert.match(wire, /^[\x20-\x7E]+$/, "头值必须 ASCII 安全");
		// ② undici 可接受：把真实头值交给 Headers 构造不抛错（等价于 fetch 建连前的校验）
		assert.doesNotThrow(() => new Headers({ "x-title": wire }), "头值必须能通过 undici 校验");
		// ③ 可往返还原：按 RFC 2047 解码后逐字等于原标题（ntfy 服务端同款解码；B 为端到端实证）
		assert.equal(decodeRfc2047(wire), TEST_FULL_TITLE, "解码后必须逐字还原原标题");
		// ④ RFC 2047 编码字每片 ≤ 75 字符（实现按 45 字节分片 → base64 60 字符 + 包装）
		for (const word of wire.split(" ")) assert.ok(word.length <= 75, `编码字超长：${word.length} > 75`);
		t.diagnostic(`D 插件实发 x-title：${wire}（${Buffer.byteLength(TEST_FULL_TITLE, "utf8")} 字节 UTF-8 → ${wire.length} 字符 ASCII）`);
	} finally {
		harness.clean();
		await echo.close();
	}
});
