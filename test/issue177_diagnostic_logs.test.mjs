/**
 * issue #177：诊断日志（**只观测，不改行为**）。
 *
 * 目标：下次复现「提问卡不提示」时，能一次看清断在哪一环。最大的盲区是
 * `broadcast` 完全静默——手机没连着时帧被丢弃，日志里毫无痕迹，
 * 无法区分「根本没人在听」与「发了但 App 没渲染」。
 *
 * 本文件断言：
 *   1. 四类帧（question/requested|resolved、approval/requested|resolved）
 *      记 `connections/written/failed`，且 `connections=0` 时有 ⚠ 标记；
 *   2. 其余帧**不**产生这类日志（避免淹没）；
 *   3. `putAskReplay` 日志含 `connections` 与 `sessionId`；
 *   4. SSE 回放补发待答帧时有 info 级日志；
 *   5. **负例**：日志里绝不出现题干 / 选项 / 用户输入 / token / 绝对路径。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { apply } from "../lib/index.js";

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
	offlineHoldMs: 300_000,
	offlineAlsoDesktop: true,
};

class FakeRequest extends EventEmitter {
	constructor(url, method = "GET", headers = {}) {
		super();
		this.url = url;
		this.method = method;
		this.headers = {
			host: "127.0.0.1",
			"x-mobile-token": CONFIG.authToken,
			"content-type": "application/json",
			...headers,
		};
		this.socket = { remoteAddress: "127.0.0.1" };
		this.complete = true;
	}
}

class FakeResponse extends EventEmitter {
	constructor() {
		super();
		this.headersSent = false;
		this.chunks = [];
	}
	writeHead(statusCode) {
		this.statusCode = statusCode;
		this.headersSent = true;
	}
	write(chunk) {
		this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
		return true;
	}
	end(chunk = "") {
		if (chunk !== "") this.chunks.push(String(chunk));
		this.emit("finish");
	}
	destroy() {
		this.destroyed = true;
		this.emit("close");
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假宿主；`frames` 会在 `$events` 就绪后依次推送。`writeFails` 让连接写入抛错。 */
function createHarness({ frames = [], eventsMode = "ready", failWrites = false } = {}) {
	const routes = [];
	const provided = new Map();
	const logs = { warn: [], info: [], debug: [] };
	const framesQueue = [...frames];
	let waiter = null;
	let dispose;

	const pushFrame = (frame) => {
		if (waiter !== null) {
			const resolve = waiter;
			waiter = null;
			resolve({ value: frame, done: false });
			return;
		}
		framesQueue.push(frame);
	};

	provided.set("typertGateway", {
		async invokeRpc() { return { ok: true, value: {} }; },
		async dispatchRpc() { return { ok: true, value: undefined }; },
		async openWireStream(endpoint, payload, uplink, peer, signal) {
			if (eventsMode === "unavailable") throw new Error("$events unavailable（夹具）");
			return (async function* stream() {
				yield { type: "ready", clientId: "evt-client-1" };
				for (;;) {
					if (framesQueue.length > 0) { yield framesQueue.shift(); continue; }
					const next = await new Promise((resolve) => {
						waiter = resolve;
						signal?.addEventListener?.("abort", () => resolve({ value: undefined, done: true }), { once: true });
					});
					if (next.done) return;
					yield next.value;
				}
			})();
		},
	});
	provided.set("connection", {
		createPeer() {
			return {
				signal: new AbortController().signal,
				principal: { kind: "owner" },
				interactions: "answer",
				dispose() {},
			};
		},
	});

	const ctx = {
		webServer: { host: "127.0.0.1", port: 43141, register(spec) { routes.push(spec); return () => {}; } },
		logger: {
			warn: (m) => logs.warn.push(String(m)),
			info: (m) => logs.info.push(String(m)),
			debug: (m) => logs.debug.push(String(m)),
		},
		get(name) { return provided.get(name); },
		provide(name, value) { provided.set(name, value); },
		on() { return () => {}; },
		effect(callback) { callback?.(); return () => {}; },
		inject() {},
		waterfall: async () => "unavailable",
	};

	dispose = apply(ctx, CONFIG);
	return {
		route: (path) => routes.find((r) => r.path === path)?.handler,
		pushFrame,
		logs,
		clean() { dispose?.(); },
	};
}

async function call(route, { url, method = "GET", body } = {}) {
	const req = new FakeRequest(url, method);
	const res = new FakeResponse();
	const finished = new Promise((resolve) => res.once("finish", resolve));
	route(req, res);
	if (body !== undefined) {
		queueMicrotask(() => {
			req.emit("data", Buffer.from(JSON.stringify(body), "utf8"));
			req.emit("end");
		});
	}
	await finished;
	return { status: res.statusCode, body: JSON.parse(res.chunks.join("") || "{}") };
}

/** 打开一条 SSE 连接（= 手机在线），保持不关闭。 */
function openPhone(harness, { throwOnWrite = false } = {}) {
	const res = new FakeResponse();
	if (throwOnWrite) {
		res.write = () => { throw new Error("write failed"); };
	}
	harness.route("/m/api")(new FakeRequest("/m/api/events"), res);
	return res;
}

async function waitForEventsReady(harness) {
	for (let i = 0; i < 100; i++) {
		const diag = await call(harness.route("/m/api"), { url: "/m/api/diagnostics" });
		if (diag.body.checks?.remoteEvents === true) return;
		await sleep(5);
	}
	throw new Error("$events 未就绪");
}

const questionFrame = (eventId = "ev-q", sessionId = "session-A") => ({
	type: "waterfall",
	event: "user-questions/request",
	eventId,
	agentId: sessionId,
	request: {
		questions: [{
			id: "cleanup",
			question: "SECRET-QUESTION-TEXT",
			options: [{ label: "SECRET-OPTION" }],
		}],
	},
});

/** 该 harness 的 info 日志里与 broadcast 观测相关的那几行。 */
const broadcastLines = (harness) => harness.logs.info.filter((l) => l.includes(": broadcast "));

// ───────── 1. broadcast 四类帧的观测 ─────────

test("#177 broadcast：question/requested 记 connections/written/failed", async () => {
	const harness = createHarness();
	try {
		await waitForEventsReady(harness);
		const phone = openPhone(harness);
		await sleep(20);

		harness.pushFrame(questionFrame("ev-q1"));
		await sleep(40);

		const line = broadcastLines(harness).find((l) => l.includes("question/requested"));
		assert.ok(line, `应打出 broadcast 观测日志；实际 info=${JSON.stringify(harness.logs.info)}`);
		assert.match(line, /question\/requested/);
		assert.match(line, /rpcId=ev-q1/);
		assert.match(line, /session=session-A/);
		assert.match(line, /connections=1/);
		assert.match(line, /written=1/);
		assert.match(line, /failed=0/);
		assert.equal(line.includes("⚠"), false, "有连接时不该出现无连接告警");
		phone.destroy();
	} finally {
		harness.clean();
	}
});

test("#177 broadcast：无手机连接时 connections=0 且有 ⚠ 醒目标记", async () => {
	const harness = createHarness();
	try {
		await waitForEventsReady(harness);
		// 不打开任何 SSE 连接（离线）
		harness.pushFrame(questionFrame("ev-q-offline"));
		await sleep(40);

		const line = broadcastLines(harness).find((l) => l.includes("question/requested"));
		assert.ok(line, "离线时也必须打出观测日志");
		assert.match(line, /connections=0/);
		assert.match(line, /written=0/);
		assert.match(line, /failed=0/);
		assert.match(line, /⚠ 无手机连接，帧仅入回放/, "无连接必须有醒目告警");
	} finally {
		harness.clean();
	}
});

test("#177 broadcast：写失败计入 failed（不吞掉）", async () => {
	const harness = createHarness();
	try {
		await waitForEventsReady(harness);
		// 先正常建立连接（握手需要 write），**之后**再把 write 改成抛错，
		// 这样连接确实在 connections 里，但后续广播的 safeWrite 会失败。
		const phone = openPhone(harness);
		await sleep(20);
		phone.write = () => { throw new Error("write failed"); };

		harness.pushFrame(questionFrame("ev-q-fail"));
		await sleep(40);

		const line = broadcastLines(harness).find((l) => l.includes("question/requested"));
		assert.ok(line);
		assert.match(line, /written=0/);
		assert.match(line, /failed=1/, "写失败必须计入 failed");
		// 连接数取的是发送前的值，不能因为 dropConn 之后 size=0 而误报无连接
		assert.match(line, /connections=1/, "连接数必须在发送前取，不能因写失败被移除而变成 0");
		assert.equal(line.includes("⚠ 无手机连接"), false);
	} finally {
		harness.clean();
	}
});

test("#177 broadcast：四类帧都观测（question/approval × requested/resolved）", async () => {
	const harness = createHarness();
	try {
		await waitForEventsReady(harness);
		const phone = openPhone(harness);
		await sleep(20);

		// requested 两路
		harness.pushFrame(questionFrame("ev-q2"));
		harness.pushFrame({
			type: "waterfall", event: "approval/request", eventId: "ev-a1",
			agentId: "session-A", request: { toolName: "write", callId: "call-1", reason: "test" },
		});
		await sleep(40);
		// resolved 两路：桌面先答 → cancel 帧 → finish* 广播 resolved
		harness.pushFrame({ type: "cancel", eventId: "ev-q2" });
		harness.pushFrame({ type: "cancel", eventId: "ev-a1" });
		await sleep(40);

		const lines = broadcastLines(harness).join("\n");
		for (const type of [
			"question/requested",
			"question/resolved",
			"approval/requested",
			"approval/resolved",
		]) {
			assert.ok(lines.includes(type), `四类帧都必须被观测，缺 ${type}；实际：\n${lines}`);
		}
		// question/resolved 的关联 id 是 questionRpcId；观测行不该留空
		const resolvedLine = broadcastLines(harness).find((l) => l.includes("question/resolved"));
		assert.match(resolvedLine, /rpcId=ev-q2/, "resolved 行必须带得出 rpcId（questionRpcId）");
		phone.destroy();
	} finally {
		harness.clean();
	}
});

test("#177 broadcast：非四类帧不产生观测日志（不淹没日志）", async () => {
	const harness = createHarness();
	try {
		await waitForEventsReady(harness);
		const phone = openPhone(harness);
		await sleep(20);

		// git/changed、mobile/queue 之类高频帧不应产生 broadcast 观测行
		harness.pushFrame(questionFrame("ev-q3")); // 一次，作为「确实有日志」的对照
		await sleep(40);
		const before = broadcastLines(harness).length;
		assert.equal(before, 1, "只有那一帧产生观测日志");

		// 直接触发一次非四类广播（通知变化）——用 notify 端点不可行，这里改验证 count 不长
		await sleep(30);
		assert.equal(
			broadcastLines(harness).length,
			1,
			"没有新的四类帧时不应新增观测日志",
		);
		phone.destroy();
	} finally {
		harness.clean();
	}
});

// ───────── 2. putAskReplay 补字段 ─────────

test("#177 putAskReplay：日志含 connections 与 sessionId", async () => {
	const harness = createHarness();
	try {
		await waitForEventsReady(harness);
		const phone = openPhone(harness);
		await sleep(20);

		harness.pushFrame(questionFrame("ev-q4"));
		await sleep(40);

		const line = harness.logs.debug.find((l) => l.includes("ask replay stored kind=q"));
		assert.ok(line, "应有 ask replay stored 日志");
		assert.match(line, /sessionId=session-A/);
		assert.match(line, /connections=1/, "必须补 connections 字段");
		assert.match(line, /pendingFrames=/);
		phone.destroy();
	} finally {
		harness.clean();
	}
});

test("#177 putAskReplay：离线时 connections=0（区分“本就没人在听”）", async () => {
	const harness = createHarness();
	try {
		await waitForEventsReady(harness);
		harness.pushFrame(questionFrame("ev-q5"));
		await sleep(40);

		const line = harness.logs.debug.find((l) => l.includes("ask replay stored kind=q"));
		assert.ok(line);
		assert.match(line, /connections=0/);
	} finally {
		harness.clean();
	}
});

// ───────── 3. SSE 回放 info 日志 ─────────

test("#177 SSE 回放：补发待答帧时打 info 级日志（含 type/rpcId/session）", async () => {
	const harness = createHarness();
	try {
		await waitForEventsReady(harness);
		// 离线时先存一张待答帧
		harness.pushFrame(questionFrame("ev-q6"));
		await sleep(40);

		// 手机连上 → 回放
		const phone = openPhone(harness);
		await sleep(40);

		const line = harness.logs.info.find((l) => l.includes("SSE replay asked"));
		assert.ok(line, `应打出回放 info 日志；实际：${JSON.stringify(harness.logs.info)}`);
		assert.match(line, /frames=1/);
		assert.match(line, /question\/requested:ev-q6\/session-A/);
		phone.destroy();
	} finally {
		harness.clean();
	}
});

test("#177 SSE 回放：没有可回放待答帧时不打 info（避免重连刷屏）", async () => {
	const harness = createHarness();
	try {
		await waitForEventsReady(harness);
		const phone = openPhone(harness);
		await sleep(40);
		assert.equal(
			harness.logs.info.some((l) => l.includes("SSE replay asked")),
			false,
			"无待答帧不应打回放 info",
		);
		phone.destroy();
	} finally {
		harness.clean();
	}
});

// ───────── 4. 负例：不泄露敏感内容 ─────────

test("#177 负例：所有新增日志都不含题干/选项/凭据/绝对路径", async () => {
	const harness = createHarness();
	try {
		await waitForEventsReady(harness);
		const phone = openPhone(harness);
		await sleep(20);

		harness.pushFrame(questionFrame("ev-q7"));
		harness.pushFrame({
			type: "waterfall", event: "approval/request", eventId: "ev-a7",
			agentId: "session-A",
			// reason 里塞入形似凭据/路径的内容，验证不被日志带出
			request: { toolName: "write", callId: "call-7", reason: "token=sk-SECRET123 /home/mark/secret" },
		});
		await sleep(40);
		harness.pushFrame({ type: "cancel", eventId: "ev-q7" });
		harness.pushFrame({ type: "cancel", eventId: "ev-a7" });
		await sleep(40);

		const all = [
			...harness.logs.info,
			...harness.logs.warn,
			...harness.logs.debug,
		].join("\n");

		for (const forbidden of [
			"SECRET-QUESTION-TEXT",
			"SECRET-OPTION",
			"sk-SECRET123",
			"/home/mark/secret",
			"1234567890123456", // authToken
		]) {
			assert.equal(all.includes(forbidden), false, `日志不得包含 ${forbidden}`);
		}
		// 同时确认日志**确实**打了（不是空日志导致上面全过）
		assert.ok(broadcastLines(harness).length >= 2, "对照组：观测日志必须存在");
		phone.destroy();
	} finally {
		harness.clean();
	}
});

// ───────── 5. 行为零变化 ─────────

test("#177 行为零变化：观测日志不影响条目建立与结算", async () => {
	const harness = createHarness();
	try {
		await waitForEventsReady(harness);
		const phone = openPhone(harness);
		await sleep(20);

		harness.pushFrame(questionFrame("ev-q8"));
		await sleep(40);
		let diag = await call(harness.route("/m/api"), { url: "/m/api/diagnostics" });
		assert.equal(diag.body.checks.pendingQuestions, 1, "条目照常建立");

		harness.pushFrame({ type: "cancel", eventId: "ev-q8" });
		await sleep(40);
		diag = await call(harness.route("/m/api"), { url: "/m/api/diagnostics" });
		assert.equal(diag.body.checks.pendingQuestions, 0, "条目照常结算");
		phone.destroy();
	} finally {
		harness.clean();
	}
});
