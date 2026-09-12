import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { apply } from "../lib/index.js";

// T15：出站推送链路（/push-test 四格式 wire 形状 / 真实 ntfy.sh 投递 / minimal 脱敏）
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
		logger: { warn() {}, info() {} },
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

async function getRoute(route, url) {
	const req = new FakeRequest(url);
	const res = new FakeResponse();
	const done = new Promise((resolve) => res.once("finish", resolve));
	route(req, res);
	await done;
	return res;
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
const ntfyTopic = (tag) => `dsh-t15-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** GET /<topic>/json?poll=1 → 换行分隔 JSON 记录数组（poll=1 取缓存后立即关闭）。 */
async function ntfyPoll(topic) {
	const res = await fetch(`${NTFY_BASE}/${topic}/json?poll=1`, { signal: AbortSignal.timeout(20_000) });
	assert.equal(res.status, 200, `ntfy poll HTTP ${res.status}`);
	const text = await res.text();
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line));
}

/** 轮询直到出现满足 predicate 的 message 记录（投递是同步入库的，重试只为抵消公网抖动）。 */
async function ntfyPollFor(topic, predicate, { attempts = 10, intervalMs = 600 } = {}) {
	let records = [];
	for (let i = 0; i < attempts; i++) {
		records = await ntfyPoll(topic);
		if (records.some((r) => r.event === "message" && predicate(r))) return records;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	return records;
}

test("A(T15): /push-test 四格式 wire 形状（generic / ntfy / bark / serverchan）", async () => {
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

		// ntfy —— 实测实现是 JSON: { title: `${kindLabel} · ${title}`, message: desp }；
		// 注意：config schema 的注释（lib/index.js:64）写的是「text/plain + X-Title 头」，
		// 与 pushToChannel（lib/index.js:1054-1056）实际发出的 wire 形状不一致——此处断言实现。
		const ntfy = byPath.get("/ntfy");
		assert.equal(ntfy.headers["content-type"], "application/json");
		assert.equal(ntfy.headers["x-title"], undefined, "ntfy 通道不发 X-Title 头（与 schema 注释不符）");
		assert.deepEqual(JSON.parse(ntfy.raw), { title: TEST_FULL_TITLE, message: TEST_DESP });
		assert.equal(ntfy.raw, JSON.stringify({ title: TEST_FULL_TITLE, message: TEST_DESP }), "载荷字节序与实现一致");

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

test("B(T15): 真实第三方投递 —— ntfy.sh 公网主题收到 /push-test 载荷", async (t) => {
	const topic = ntfyTopic("b");
	const cfg = configWith([{ name: "ntfy-live", url: `${NTFY_BASE}/${topic}`, format: "ntfy" }]);
	const harness = createHarness({}, cfg);
	try {
		const res = await postJson(harness.route, {}, "/m/api/push-test");
		assert.equal(res.status, 200);
		assert.deepEqual(res.body.results, [{ name: "ntfy-live", format: "ntfy", ok: true }], "公网通道 ok:true");

		// pushToChannel 为该通道构造的原始载荷（与 A 中断言的 wire 形状同源）
		const expectedPayload = JSON.stringify({ title: TEST_FULL_TITLE, message: TEST_DESP });
		const records = await ntfyPollFor(topic, (r) => r.message === expectedPayload);
		const rec = records.find((r) => r.event === "message" && r.message === expectedPayload);
		assert.ok(rec, `ntfy.sh 主题 ${topic} 未收到预期载荷；实收：${JSON.stringify(records)}`);
		t.diagnostic(`B 实收 ntfy 记录：${JSON.stringify(rec)}`);
		assert.equal(rec.topic, topic);
		// 标题文本与正文文本确实到达了对端（标题以文本形式在载荷内；见下方对照结论）
		assert.ok(rec.message.includes(TEST_FULL_TITLE), "载荷内含预期标题文本");
		assert.ok(rec.message.includes(TEST_DESP), "载荷内含预期正文文本");

		// 对照：同主题改用 ntfy 官方文档形状（text/plain 正文 + X-Title 头）→ 回读能被解析出 title 字段。
		// 用来证明「ntfy 未把插件的 JSON 解析成通知标题」是插件 wire 形状所致，
		// 而不是主题、发布或回读通道的问题。
		const controlTitle = `T15-CONTROL-${Date.now()}`;
		const controlBody = "t15-control-body";
		const controlRes = await fetch(`${NTFY_BASE}/${topic}`, {
			method: "POST",
			headers: { "content-type": "text/plain; charset=utf-8", "X-Title": controlTitle },
			body: controlBody,
			signal: AbortSignal.timeout(20_000),
		});
		assert.equal(controlRes.status, 200);
		const after = await ntfyPollFor(topic, (r) => r.title === controlTitle);
		const control = after.find((r) => r.event === "message" && r.title === controlTitle);
		assert.ok(control, `对照消息未到达：${JSON.stringify(after)}`);
		assert.equal(control.message, controlBody);
		// 已知缺陷（Issue #12）：JSON 发布必须 POST 到根 URL https://ntfy.sh/，不能 POST 到主题 URL。
		// 当前实现把 JSON 发到主题 URL，ntfy 遂把整段 JSON 当纯文本消息体——title 不生效，
		// 手机上看到的正文是一坨 JSON。见 https://docs.ntfy.sh/publish/#publish-as-json
		//
		// 此处**刻意不断言该错误行为**：把 `rec.title === undefined` 写成预期，等于把缺陷固化成
		// “正确行为”，修复后测试反而会失败。只记录观测值，修复（Issue #12）后此块应替换为：
		//     assert.equal(rec.title, TEST_FULL_TITLE);
		t.diagnostic(
			`B 已知缺陷（Issue #12）：rec.title=${JSON.stringify(rec.title)}（因 JSON 发到主题 URL 而未被解析）`,
		);
	} finally {
		harness.clean();
	}
});

test("C(T15): minimal 模式脱敏 —— 真实 turn/end→idle→doneGrace 链路不向 ntfy 泄露标题/详情", async (t) => {
	// 合成会话 id：不把任何真实会话标识推到公网主题
	const sessionId = "session-t15-test-00000000-0000-0000-0000-000000000000";
	const shortId = `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}`; // session-…0000
	const secretTitle = "SECRET-TITLE-MARKER";
	const detailTurn = 987654321; // 详情模板 `任务完成（轮次 ${turn}）` 中的轮次号 = 详情标记
	const doneLabel = "✅ 任务完成";
	const redactedDesp = "详情请在 DSH Remote App 中查看"; // 详情被清空后 pushToChannel 的兜底文案

	const topic = ntfyTopic("c");
	const cfg = configWith([{ name: "ntfy-c", url: `${NTFY_BASE}/${topic}`, format: "ntfy" }]);

	let titleReads = 0;
	const session = {
		id: sessionId,
		header: { createdAt: Date.now(), cwd: "/tmp/t15" }, // 无 origin=subagent → 走正常「完成」通知路径
		// 0.1.2 会话形状：标题来自 session/title 事件
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
	const harness = createHarness({
		get: (name) => (name === "agents" ? agents : name === "sessions" ? sessions : undefined),
	}, cfg);
	try {
		// 真实触发链：turn/end(completed) → armDone 暂存 → agent/status idle → doneGraceMs(1ms) 后 pushSend
		harness.fire("session/event", session, {
			type: "turn/end",
			data: { reason: { kind: "completed" }, turn: detailTurn },
		});
		harness.fire("agent/status", { agent: { id: `session:${sessionId}`, session }, status: "idle" });

		const records = await ntfyPollFor(topic, (r) => `${r.title ?? ""}${r.message ?? ""}`.includes(doneLabel));
		const rec = records.find((r) => r.event === "message" && `${r.title ?? ""}${r.message ?? ""}`.includes(doneLabel));
		assert.ok(rec, `任务完成通知未到达主题 ${topic}；实收：${JSON.stringify(records)}`);
		t.diagnostic(`C 实收 ntfy 记录：${JSON.stringify(rec)}`);

		// 兼容两种对端行为（ntfy 解析 JSON / 原样存 JSON 文本）：断言下发给对端的全部可见文本
		const delivered = [rec.title, rec.message].filter((s) => typeof s === "string").join("\n");
		assert.ok(delivered.includes(`${doneLabel} · ${shortId}`), `标题为「事件标签 · 会话短码」；实收：${delivered}`);
		assert.ok(!delivered.includes(secretTitle), `会话标题 SECRET-TITLE-MARKER 不得出网；实收：${delivered}`);
		assert.ok(!delivered.includes(String(detailTurn)), `详情（轮次号）不得出网；实收：${delivered}`);
		assert.ok(!delivered.includes("（轮次"), `详情模板不得出网；实收：${delivered}`);
		assert.ok(delivered.includes(redactedDesp), `详情被清空 → 走 pushToChannel 兜底文案；实收：${delivered}`);
		// 反证：标题确实被插件读到过，脱敏不是因为「标题压根不可见」
		assert.ok(titleReads > 0, "插件读取过会话标题（随后才被 minimal 脱敏）");
	} finally {
		harness.clean();
	}
});
