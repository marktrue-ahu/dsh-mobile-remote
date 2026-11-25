/**
 * issue #177 方案 A：移除离线自动回收，跟随 DSH 本体语义。
 *
 * ## 真因（用户实测复现）
 *
 * 11:13 手机离线时 agent 发起提问 → 12:23 `armOfflineReap` 的
 * `OFFLINE_PENDING_TTL_MS = 70min` 到期，**成对删除条目 + 回放帧**（不结算、
 * 不通知）→ 13:42 手机重连时 `pendingQuestions=0` / `pendingFrames=0`，**无卡**。
 *
 * ## 决定性内部矛盾
 *
 * | 常量 | 值 |
 * |---|---|
 * | `PENDING_FRAMES_TTL`（回放层） | **24 小时** |
 * | `OFFLINE_PENDING_TTL_MS`（回收层） | **70 分钟** |
 *
 * 回放层愿意留 24h，回收层 70min 就删了。而 DSH 本体：
 *   - 网关 `pendingRemoteEvents` **无 TTL**（只在 settle/cancel/Context 释放时删）
 *   - 内核 `ask_user_question` 超时只是「先返回 pending 结果给模型」，**提问仍有效**
 *
 * ## 本文件的判别点（修前红 / 修后绿）
 *
 * 「离线 90 分钟后重连，提问卡应仍可见」—— 修前必红（70min 就删了）。
 *
 * 说明：这里用 mock timers 推进时间，并**先**推进到 90min **再**建立 SSE 连接
 * （模拟「离开 2 小时 → 重连」的真实时序），而不是连接期间等待。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mock } from "node:test";
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

/** 假宿主；`frames` 在 `$events` 就绪后依次推送。 */
function createHarness({ frames = [], config = {} } = {}) {
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
		webServer: { host: "127.0.0.1", port: 43161, register(spec) { routes.push(spec); return () => {}; } },
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

	dispose = apply(ctx, { ...CONFIG, ...config });
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

const diagnostics = async (harness) =>
	(await call(harness.route("/m/api"), { url: "/m/api/diagnostics" })).body;

function openPhone(harness) {
	const res = new FakeResponse();
	harness.route("/m/api")(new FakeRequest("/m/api/events"), res);
	return res;
}

async function waitForEventsReady(harness) {
	for (let i = 0; i < 100; i++) {
		const diag = await diagnostics(harness);
		if (diag.checks?.remoteEvents === true) return;
		await sleep(5);
	}
	throw new Error("$events 未就绪");
}

/** 让被 mock 的定时器推进后，给微任务/IO 一个机会。 */
const flush = () => new Promise((resolve) => setImmediate(resolve));

const questionFrame = (eventId, sessionId = "session-A") => ({
	type: "waterfall",
	event: "user-questions/request",
	eventId,
	agentId: sessionId,
	request: {
		questions: [{ id: "q1", question: "选哪个？", options: [{ label: "A" }] }],
	},
});

const countQuestionFrames = (res) =>
	(res.chunks.join("").match(/"type":"question\/requested"/g) ?? []).length;

// ───────── 核心回归：修前红 / 修后绿 ─────────

test("#177A 离线 90 分钟后重连 → 提问卡仍可见（修前红）", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const harness = createHarness();
	try {
		await waitForEventsReady(harness);

		// 手机离线时提问 → 建条目 + 回放帧
		harness.pushFrame(questionFrame("ev-90min"));
		await flush();
		await flush();

		let diag = await diagnostics(harness);
		assert.equal(diag.checks.pendingQuestions, 1, "前提：离线时条目应已建立");
		assert.equal(diag.checks.pendingFrames, 1, "前提：离线时应已写回放帧");

		// 推进 90 分钟（超过旧的 70min OFFLINE_PENDING_TTL_MS）
		t.mock.timers.tick(90 * 60_000);
		await flush();
		await flush();

		// 手机重连 → 应能看到那张卡
		const phone = openPhone(harness);
		await flush();
		await flush();

		const replayLine = harness.logs.info.find((l) => l.includes("SSE replay asked"));
		assert.ok(
			replayLine,
			`离线 90 分钟后重连必须回放提问卡；实际 info 日志：${JSON.stringify(harness.logs.info)}`,
		);
		assert.equal(countQuestionFrames(phone), 1, "手机必须收到 question/requested 帧");
		diag = await diagnostics(harness);
		assert.equal(diag.checks.pendingFrames, 1, "回放帧不得被回收");
		phone.destroy();
	} finally {
		harness.clean();
		t.mock.timers.reset();
	}
});

test("#177A 离线 25 小时后重连 → 仍可见（不再受任何 TTL 限制）", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const harness = createHarness();
	try {
		await waitForEventsReady(harness);

		harness.pushFrame(questionFrame("ev-25h"));
		await flush();
		await flush();

		// 25 小时：超过 PENDING_FRAMES_TTL(24h) 也超过 OFFLINE_PENDING_TTL_MS(70min)
		t.mock.timers.tick(25 * 3600_000);
		await flush();
		await flush();

		const phone = openPhone(harness);
		await flush();
		await flush();

		assert.equal(countQuestionFrames(phone), 1, "离线 25 小时后重连仍必须可见");
		phone.destroy();
	} finally {
		harness.clean();
		t.mock.timers.reset();
	}
});

test("#177A 离线审批同样不受 70 分钟限制", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const harness = createHarness();
	try {
		await waitForEventsReady(harness);

		harness.pushFrame({
			type: "waterfall",
			event: "approval/request",
			eventId: "ev-a-90",
			agentId: "session-A",
			request: { toolName: "write", callId: "call-1", reason: "test" },
		});
		await flush();
		await flush();
		assert.equal((await diagnostics(harness)).checks.pendingApprovals, 1);

		t.mock.timers.tick(90 * 60_000);
		await flush();
		await flush();

		const phone = openPhone(harness);
		await flush();
		await flush();
		const frames = (phone.chunks.join("").match(/"type":"approval\/requested"/g) ?? []).length;
		assert.equal(frames, 1, "离线 90 分钟后审批卡仍必须可见");
		phone.destroy();
	} finally {
		harness.clean();
		t.mock.timers.reset();
	}
});

// ───────── 在线路径不变 ─────────

test("#177A 在线超时行为不变：默认 60min fail-close 仍生效", async (t) => {
	// 注意：在线 fail-close 的默认值是 `DEFAULT_PENDING_TIMEOUT_MS = 60 * 60_000`
	// （1 小时），不是 120s。可用 config.pendingTimeoutMs 覆盖。
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const harness = createHarness();
	try {
		await waitForEventsReady(harness);
		const phone = openPhone(harness);
		await flush();
		await flush();

		harness.pushFrame(questionFrame("ev-online-timeout"));
		await flush();
		await flush();
		assert.equal((await diagnostics(harness)).checks.pendingQuestions, 1);

		// 未到 60min 前不应 fail-close
		t.mock.timers.tick(59 * 60_000);
		await flush();
		await flush();
		assert.equal(
			(await diagnostics(harness)).checks.pendingQuestions,
			1,
			"未到在线超时阈值前不得 fail-close",
		);

		// 越过 60min → fail-close（cancel）
		t.mock.timers.tick(2 * 60_000);
		await flush();
		await flush();

		assert.equal(
			(await diagnostics(harness)).checks.pendingQuestions,
			0,
			"在线超时必须仍 fail-close（armTimeout 未改）",
		);
		phone.destroy();
	} finally {
		harness.clean();
		t.mock.timers.reset();
	}
});

test("#177A 在线超时可用 config.pendingTimeoutMs 覆盖且仍生效（armTimeout 未改）", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const harness = createHarness({ config: { pendingTimeoutMs: 120_000 } });
	try {
		await waitForEventsReady(harness);
		const phone = openPhone(harness);
		await flush();
		await flush();

		harness.pushFrame(questionFrame("ev-online-120s"));
		await flush();
		await flush();
		assert.equal((await diagnostics(harness)).checks.pendingQuestions, 1);

		t.mock.timers.tick(121_000);
		await flush();
		await flush();
		assert.equal(
			(await diagnostics(harness)).checks.pendingQuestions,
			0,
			"显式 pendingTimeoutMs=120s 时，在线超时仍必须 fail-close",
		);
		phone.destroy();
	} finally {
		harness.clean();
		t.mock.timers.reset();
	}
});

// ───────── 容量兜底 ─────────

test("#177A 容量兜底：条目超过上限时按插入序逐出最旧且成对清理（无幽灵卡）", async (t) => {
	const harness = createHarness();
	try {
		await waitForEventsReady(harness);

		// 推入超过上限（200）的提问帧；每条 questions 不同以免被跨路径去重合并
		const total = 210;
		for (let i = 0; i < total; i += 1) {
			harness.pushFrame({
				type: "waterfall",
				event: "user-questions/request",
				eventId: `ev-cap-${i}`,
				agentId: `session-cap-${i}`, // 不同 session 避免同 session 去重
				request: { questions: [{ id: `q-${i}`, question: `问题 ${i}`, options: [{ label: "A" }] }] },
			});
			await flush();
		}
		await flush();

		const diag = await diagnostics(harness);
		assert.ok(
			diag.checks.pendingQuestions <= 200,
			`pendingQuestions 必须有上限，实际 ${diag.checks.pendingQuestions}`,
		);
		assert.equal(diag.checks.pendingQuestions, 200, "应恰好保留上限条数");
		// 回放层也必须与之对齐（不能条目删了帧还在 → 幽灵卡）
		assert.equal(
			diag.checks.pendingFrames,
			200,
			`回放帧数必须与条目数一致（成对清理），实际 ${diag.checks.pendingFrames}`,
		);

		// 最早的应被逐出：连上手机后不该看到 ev-cap-0
		const phone = openPhone(harness);
		await flush();
		await flush();
		const text = phone.chunks.join("");
		assert.equal(text.includes("ev-cap-0"), false, "最旧的条目应被逐出");
		assert.equal(text.includes(`ev-cap-${total - 1}`), true, "最新的条目必须保留");
		phone.destroy();
	} finally {
		harness.clean();
	}
});

test("#177A 容量逐出必须成对：被逐出条目的回放帧不得残留（#14 幽灵卡负例）", async (t) => {
	const harness = createHarness();
	try {
		await waitForEventsReady(harness);

		// 离线（不连手机）：所有帧都进回放层
		const total = 205;
		for (let i = 0; i < total; i += 1) {
			harness.pushFrame({
				type: "waterfall",
				event: "user-questions/request",
				eventId: `ev-pair-${i}`,
				agentId: `session-pair-${i}`,
				request: { questions: [{ id: `q-${i}`, question: `q${i}`, options: [{ label: "A" }] }] },
			});
			await flush();
		}
		await flush();

		const diag = await diagnostics(harness);
		// 成对：条目数 == 回放帧数（都被裁剪到上限）
		assert.equal(
			diag.checks.pendingQuestions,
			diag.checks.pendingFrames,
			`条目与回放帧必须成对（避免只删一个 → 幽灵卡）：questions=${diag.checks.pendingQuestions} frames=${diag.checks.pendingFrames}`,
		);

		// 逐出的那几条不得出现在回放里
		const phone = openPhone(harness);
		await flush();
		await flush();
		const text = phone.chunks.join("");
		assert.equal(text.includes("ev-pair-0"), false, "被逐出条目不得回放（幽灵卡）");
		phone.destroy();
	} finally {
		harness.clean();
	}
});

// ───────── 结算路径不变 ─────────

test("#177A 离线很久后 /respond 仍能结算（条目没被删）", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const harness = createHarness();
	try {
		await waitForEventsReady(harness);

		harness.pushFrame(questionFrame("ev-respond-90"));
		await flush();
		await flush();

		t.mock.timers.tick(90 * 60_000);
		await flush();
		await flush();

		const phone = openPhone(harness);
		await flush();
		await flush();
		const text = phone.chunks.join("");
		const m = text.match(/"questionId":"([^"]+)"/);
		assert.ok(m, `应有回放帧带 questionId；实际：${text.slice(0, 400)}`);
		const questionId = m[1];
		phone.destroy();

		const res = await call(harness.route("/m/api"), {
			url: "/m/api/respond",
			method: "POST",
			body: {
				sessionId: "session-A",
				kind: "question",
				rpcId: "ev-respond-90",
				questionId,
				answers: [{ id: "q1", selected: ["A"] }],
			},
		});
		assert.equal(res.status, 200, `离线 90 分钟后 /respond 应仍能结算：${JSON.stringify(res.body)}`);
		assert.equal((await diagnostics(harness)).checks.pendingQuestions, 0, "结算后条目应清除");
	} finally {
		harness.clean();
		t.mock.timers.reset();
	}
});

test("#177A 容量兜底覆盖**在线**路径（不只离线；高频道具不得无限增长）", async () => {
	// 审查发现：若容量检查只写在离线分支，在线高频审批会让 Map 无限增长。
	// 本用例在**手机在线**时推入超过上限的条目，断言仍被裁到上限。
	const harness = createHarness();
	try {
		await waitForEventsReady(harness);
		const phone = openPhone(harness);
		await flush();
		await flush();

		const total = 210;
		for (let i = 0; i < total; i += 1) {
			harness.pushFrame({
				type: "waterfall",
				event: "user-questions/request",
				eventId: `ev-online-cap-${i}`,
				agentId: `session-oc-${i}`,
				request: { questions: [{ id: `q-${i}`, question: `q${i}`, options: [{ label: "A" }] }] },
			});
			await flush();
		}
		await flush();

		const diag = await diagnostics(harness);
		assert.ok(
			diag.checks.pendingQuestions <= 200,
			`在线路径也必须受容量约束，实际 ${diag.checks.pendingQuestions}`,
		);
		assert.equal(diag.checks.pendingQuestions, 200);
		assert.equal(diag.checks.pendingFrames, 200, "在线也应条目与回放帧成对");
		phone.destroy();
	} finally {
		harness.clean();
	}
});
