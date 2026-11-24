/**
 * issue #177：`$events` 就绪后提问卡是否仍推送到手机（`pendingQuestions=0`）。
 *
 * 用户真机现象：Web GUI 显示「❓ 等待你的操作」，手机 App 没有弹提问卡；
 * SSE hello 的 `pendingQuestions=0` 说明**宿主侧待答条目从未建立**，
 * 不是 App 收到后没渲染。
 *
 * 本文件钉住「`$events` 就绪 + approvalMode=both + 手机在线」这条路径，
 * 以及它的两个邻居（`$events` 不可用、手机离线、mobile/desktop 模式）不被破坏。
 *
 * 关键背景（实现里有**两条**建卡路径，别再混淆）：
 *   ① 瀑布路径 `holdQuestion()`：本插件以 `prepend:true` 抢在宿主转发之前接管，
 *      只有 `mobileHold === true`（即 `$events` **不可用**）时才走；
 *   ② `$events` 路径 `onEventsWaterfall()`：宿主的 api-remotes 把
 *      `user-questions/request` 作为 waterfall 转发给 owner 客户端，本插件自己的
 *      `$events` 流收到 `waterfall` 帧后**也建条目**并广播 `mobile/frame`。
 *
 * 因此「`$events` 就绪 → 不调 `holdQuestion`」本身**不是** bug：卡应由 ② 补发。
 * 真正的判据是 ② 那条路径在真实链路上**是否真的会到达本插件**。
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

/**
 * 假宿主 ctx + 可控 `$events` 流。
 *
 * `eventsMode`：
 *   - `"ready"`：openWireStream 立刻给出 `ready` 帧，之后由测试手动 push 帧；
 *   - `"unavailable"`：openWireStream 抛错（模拟降级路径）。
 */
function createHarness({ eventsMode = "ready", config = {} } = {}) {
	const routes = [];
	const provided = new Map();
	const handlers = new Map();
	const logs = { info: [], warn: [] };
	const rpcCalls = [];
	const dispatchCalls = [];
	/** 测试侧可 push 的 `$events` 帧。 */
	const eventFrames = [];
	let frameWaiter = null;
	let dispose;

	const pushFrame = (frame) => {
		if (frameWaiter !== null) {
			const resolve = frameWaiter;
			frameWaiter = null;
			resolve({ value: frame, done: false });
			return;
		}
		eventFrames.push(frame);
	};

	provided.set("typertGateway", {
		async invokeRpc(endpoint, payload, signal, peer) {
			rpcCalls.push({ endpoint, args: payload?.args, hasPeer: Boolean(peer?.principal) });
			return { ok: true, value: {} };
		},
		async dispatchRpc(endpoint, payload, signal, peer) {
			dispatchCalls.push({ endpoint, args: payload?.args, hasPeer: Boolean(peer?.principal) });
			return { ok: true, value: undefined };
		},
		// 0.2.x 六参形态（>= 6 走带 peer/control 的分支）
		async openWireStream(endpoint, payload, uplink, peer, signal, control) {
			if (eventsMode === "unavailable") throw new Error("$events unavailable（本夹具模拟降级）");
			return (async function* stream() {
				// 首帧 ready：插件据此置 eventsState.ready = true
				yield { type: "ready", clientId: "evt-client-1" };
				for (;;) {
					if (eventFrames.length > 0) {
						yield eventFrames.shift();
						continue;
					}
					const next = await new Promise((resolve) => {
						frameWaiter = resolve;
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
		webServer: { host: "127.0.0.1", port: 43130, register(spec) { routes.push(spec); return () => {}; } },
		logger: { info: (m) => logs.info.push(String(m)), warn: (m) => logs.warn.push(String(m)) },
		get(name) { return provided.get(name); },
		provide(name, value) { provided.set(name, value); },
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
			return () => {};
		},
		effect(callback) { callback?.(); return () => {}; },
		inject() {},
		waterfall: async () => "unavailable",
	};

	dispose = apply(ctx, { ...CONFIG, ...config });

	return {
		route: (path) => routes.find((r) => r.path === path)?.handler,
		question: () => handlers.get("user-questions/request")?.[0],
		approval: () => handlers.get("approval/request")?.[0],
		pushFrame,
		logs,
		rpcCalls,
		dispatchCalls,
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

/** 打开一条 SSE 连接（= 手机在线），保持不关闭。 */
function openPhone(harness) {
	const res = new FakeResponse();
	harness.route("/m/api")(new FakeRequest("/m/api/events"), res);
	return res;
}

/** 从 SSE 缓冲里数某类广播帧。 */
const countFrames = (res, type) =>
	(res.chunks.join("").match(new RegExp(`"type":"${type.replace("/", "\\/")}"`, "g")) ?? []).length;

const questionRequest = (sessionId = "session-A") => ({
	agent: { session: { id: sessionId } },
	questions: [{ id: "q1", question: "选哪个？", options: [{ label: "A" }, { label: "B" }] }],
});

/** 等 `$events` 就绪（插件异步连流 + 收 ready 帧）。 */
async function waitForEventsReady(harness) {
	for (let i = 0; i < 100; i++) {
		const diag = await diagnostics(harness);
		if (diag.checks?.remoteEvents === true) return diag;
		await sleep(5);
	}
	throw new Error("$events 未就绪");
}

// ───────── 核心：$events 就绪 + both + 手机在线 ─────────

test("#177 $events 就绪 + both + 手机在线：瀑布路径放行，但 $events 路径必须建卡并广播", async () => {
	const harness = createHarness({ eventsMode: "ready" });
	try {
		const diag = await waitForEventsReady(harness);
		assert.equal(diag.checks.remoteEvents, true, "$events 必须已就绪（本用例前提）");

		const phone = openPhone(harness);
		await sleep(20);

		// ① 瀑布路径：$events 就绪时插件**不该**抢（让内核/桌面先拿到），这是既有设计
		let nextCalled = 0;
		const handler = harness.question();
		assert.equal(typeof handler, "function", "user-questions/request 必须注册处理器");
		const waterfallResult = handler(questionRequest(), async () => {
			nextCalled += 1;
			return "desktop-answer";
		});
		assert.equal(nextCalled, 1, "$events 就绪时应放行内核转发（桌面弹卡）");

		// ② $events 路径：宿主转发来的 waterfall 帧必须让插件建条目 + 广播给手机
		harness.pushFrame({
			type: "waterfall",
			event: "user-questions/request",
			eventId: "evt-1",
			agentId: "session-A",
			request: { questions: [{ id: "q1", question: "选哪个？", options: [{ label: "A" }, { label: "B" }] }] },
		});
		await sleep(30);

		const after = await diagnostics(harness);
		assert.equal(
			after.checks.pendingQuestions,
			1,
			"$events 就绪时手机侧待答条目必须建立（pendingQuestions=0 就是本 bug）",
		);
		assert.equal(
			countFrames(phone, "question/requested"),
			1,
			'手机必须收到 question/requested 帧（否则不会弹卡）',
		);
		phone.destroy();
		await waterfallResult;
	} finally {
		harness.clean();
	}
});

test("#177 $events 就绪：桌面先答 → 手机收卡（先答生效，不留幽灵卡）", async () => {
	const harness = createHarness({ eventsMode: "ready" });
	try {
		await waitForEventsReady(harness);
		const phone = openPhone(harness);
		await sleep(20);

		harness.pushFrame({
			type: "waterfall",
			event: "user-questions/request",
			eventId: "evt-2",
			agentId: "session-A",
			request: { questions: [{ id: "q1", question: "选哪个？", options: [{ label: "A" }] }] },
		});
		await sleep(30);
		assert.equal((await diagnostics(harness)).checks.pendingQuestions, 1);

		// 桌面 GUI 先答 → 宿主广播 cancel 帧
		harness.pushFrame({ type: "cancel", eventId: "evt-2" });
		await sleep(30);
		assert.equal(
			(await diagnostics(harness)).checks.pendingQuestions,
			0,
			"桌面先答后手机侧条目必须清除（否则幽灵卡）",
		);
		phone.destroy();
	} finally {
		harness.clean();
	}
});

// ───────── 邻居路径不能退化 ─────────

test("#177 $events 不可用 + both + 手机在线：仍由瀑布路径接管（既有行为不变）", async () => {
	const harness = createHarness({ eventsMode: "unavailable" });
	try {
		const diag = await diagnostics(harness);
		assert.equal(diag.checks.remoteEvents, false, "$events 应不可用（本用例前提）");

		const phone = openPhone(harness);
		await sleep(20);

		// 桌面**不答**（挂起）：这样条目不会被先答竞速结算，能观察到「已建条目」。
		// 若让桌面立刻答，dualRoute 会按先答生效结算条目——那是另一条用例。
		let nextCalled = 0;
		const held = harness.question()(questionRequest(), async () => {
			nextCalled += 1;
			return new Promise(() => {});
		});
		await sleep(30);

		const after = await diagnostics(harness);
		assert.equal(after.checks.pendingQuestions, 1, "降级路径仍必须建条目");
		assert.equal(countFrames(phone, "question/requested"), 1, "降级路径仍必须广播");
		// both：桌面也放行（双端竞速），先答生效
		assert.equal(nextCalled, 1, "both 下桌面也应拿到卡");
		phone.destroy();
		void held;
	} finally {
		harness.clean();
	}
});

test("#177 approvalMode=desktop + $events 就绪：手机不建条目、不广播", async () => {
	const harness = createHarness({ eventsMode: "ready", config: { approvalMode: "desktop" } });
	try {
		// desktop 模式不挂 $events 客户端（只 both 挂），所以这里不等就绪
		const phone = openPhone(harness);
		await sleep(20);

		let nextCalled = 0;
		harness.question()(questionRequest(), async () => {
			nextCalled += 1;
			return "desktop";
		});
		await sleep(20);

		assert.equal(nextCalled, 1, "desktop 模式一律放行内核");
		assert.equal((await diagnostics(harness)).checks.pendingQuestions, 0);
		assert.equal(countFrames(phone, "question/requested"), 0, "desktop 模式手机不弹卡");
		phone.destroy();
	} finally {
		harness.clean();
	}
});

test("#177 approvalMode=mobile + $events 就绪：手机独占（不因 $events 就绪而放行）", async () => {
	const harness = createHarness({ eventsMode: "ready", config: { approvalMode: "mobile" } });
	try {
		// mobile 模式不挂 $events 客户端；eventsCapable() 恒 false → mobileHold 为真
		const phone = openPhone(harness);
		await sleep(20);

		let nextCalled = 0;
		const held = harness.question()(questionRequest(), async () => {
			nextCalled += 1;
			return "desktop";
		});
		await sleep(30);

		assert.equal(nextCalled, 0, "mobile 模式手机在线即独占，不得放行桌面");
		assert.equal((await diagnostics(harness)).checks.pendingQuestions, 1);
		assert.equal(countFrames(phone, "question/requested"), 1);
		phone.destroy();
		void held;
	} finally {
		harness.clean();
	}
});

test("#177 手机离线 + $events 就绪：仍建条目并写回放（App 事后打开可补发）", async () => {
	const harness = createHarness({ eventsMode: "ready" });
	try {
		await waitForEventsReady(harness);
		// 不打开手机连接（离线）
		harness.pushFrame({
			type: "waterfall",
			event: "user-questions/request",
			eventId: "evt-3",
			agentId: "session-A",
			request: { questions: [{ id: "q1", question: "选哪个？", options: [{ label: "A" }] }] },
		});
		await sleep(30);

		const diag = await diagnostics(harness);
		assert.equal(diag.checks.pendingQuestions, 1, "离线也必须建条目");
		assert.equal(diag.checks.pendingFrames, 1, "离线必须写回放帧");
	} finally {
		harness.clean();
	}
});

test("#177 agentId 带 session: 前缀：会话归一后仍建卡（issue #120 不退化）", async () => {
	const harness = createHarness({ eventsMode: "ready" });
	try {
		await waitForEventsReady(harness);
		const phone = openPhone(harness);
		await sleep(20);

		harness.pushFrame({
			type: "waterfall",
			event: "user-questions/request",
			eventId: "evt-4",
			agentId: "session:session-B",
			request: { questions: [{ id: "q1", question: "?", options: [{ label: "A" }] }] },
		});
		await sleep(30);

		assert.equal((await diagnostics(harness)).checks.pendingQuestions, 1);
		assert.equal(countFrames(phone, "question/requested"), 1);
		phone.destroy();
	} finally {
		harness.clean();
	}
});

// ───────── 缺陷 A：两条路径同时命中 → 双份卡（本任务要求验证的那一项） ─────────

/**
 * 可达路径（不是假想）：
 *  1. 提问发生在 `$events` **尚未就绪**时 → 瀑布路径 `holdQuestion` 建条目①，
 *     且 both 下 `next()` 放行 → 网关 `startRemoteEvent` 把它挂进
 *     `pendingRemoteEvents`（`dsh-api-gateway/lib/index.js:1117-1134`）。
 *  2. 稍后插件的 `$events` 客户端注册成功 → 网关在**新客户端注册时重推所有 pending**
 *     （同文件 `:1045`）→ 插件 `onEventsWaterfall` 建条目②。
 *  3. 手机收到两张卡；`/respond` 只结算其中一张 → 另一张成为幽灵卡。
 *
 * 根因不是"门控写错"，而是两条路径的条目身份**形态不同且互不去重**：
 *   - 瀑布路径 `phoneKey = ${sessionId}:${Date.now().toString(36)}`
 *   - $events 路径 `phoneKey = ${sessionId}:${eventId}`
 */
function createGatedHarness() {
	const routes = [];
	const provided = new Map();
	const handlers = new Map();
	const logs = { info: [], warn: [] };
	const frames = [];
	let waiter = null;
	let releaseReady;
	const readyGate = new Promise((resolve) => { releaseReady = resolve; });
	let dispose;

	const pushFrame = (frame) => {
		if (waiter !== null) {
			const resolve = waiter;
			waiter = null;
			resolve({ value: frame, done: false });
			return;
		}
		frames.push(frame);
	};

	provided.set("typertGateway", {
		async invokeRpc() { return { ok: true, value: {} }; },
		async dispatchRpc() { return { ok: true, value: undefined }; },
		async openWireStream(endpoint, payload, uplink, peer, signal) {
			return (async function* stream() {
				// 受控就绪：等测试放行后才给 ready 帧，复现「瀑布先到、ready 后到」
				await readyGate;
				yield { type: "ready", clientId: "evt-client-gated" };
				for (;;) {
					if (frames.length > 0) { yield frames.shift(); continue; }
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
			return { signal: new AbortController().signal, principal: { kind: "owner" }, interactions: "answer", dispose() {} };
		},
	});

	const ctx = {
		webServer: { host: "127.0.0.1", port: 43131, register(spec) { routes.push(spec); return () => {}; } },
		logger: { info: (m) => logs.info.push(String(m)), warn: (m) => logs.warn.push(String(m)) },
		get(name) { return provided.get(name); },
		provide(name, value) { provided.set(name, value); },
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
			return () => {};
		},
		effect(callback) { callback?.(); return () => {}; },
		inject() {},
		waterfall: async () => "unavailable",
	};

	dispose = apply(ctx, CONFIG);
	return {
		route: (path) => routes.find((r) => r.path === path)?.handler,
		question: () => handlers.get("user-questions/request")?.[0],
		approval: () => handlers.get("approval/request")?.[0],
		pushFrame,
		releaseReady,
		logs,
		clean() { dispose?.(); },
	};
}

test("#177 双份卡：瀑布先接管 + 就绪后网关重推同一次请求 → 必须只建一个条目", async () => {
	const harness = createGatedHarness();
	try {
		const phone = openPhone(harness);
		await sleep(20);

		// ① ready 尚未置位：瀑布路径接管，both 下同时放行桌面（→ 网关挂起该事件）
		let nextCalled = 0;
		const held = harness.question()(questionRequest(), async () => {
			nextCalled += 1;
			return new Promise(() => {});
		});
		await sleep(30);
		assert.equal(nextCalled, 1, "both 下瀑布路径应放行桌面");

		// ② 就绪 → 网关把同一 pending 事件重推给插件新客户端
		harness.releaseReady();
		await sleep(30);
		// 网关重推的是**同一次请求的投影**：questions 与瀑布路径完全一致。
		harness.pushFrame({
			type: "waterfall",
			event: "user-questions/request",
			eventId: "evt-dup",
			agentId: "session-A",
			request: { questions: questionRequest().questions },
		});
		await sleep(40);

		assert.equal(
			countFrames(phone, "question/requested"),
			1,
			"同一次逻辑提问只能给手机一张卡（两条路径并存时必须去重）",
		);
		assert.equal(
			(await diagnostics(harness)).checks.pendingQuestions,
			1,
			"宿主侧也只能有一个待答条目（否则 /respond 结算其一后另一张成幽灵卡）",
		);
		phone.destroy();
		void held;
	} finally {
		harness.clean();
	}
});

test("#177 双份卡（审批侧）：瀑布先接管 + 就绪后重推 → 只建一个审批条目", async () => {
	const harness = createGatedHarness();
	try {
		const phone = openPhone(harness);
		await sleep(20);

		// ① ready 前：瀑布路径接管审批
		let nextCalled = 0;
		const held = harness.approval()(
			{ agent: { session: { id: "session-A" } }, toolName: "write", callId: "call-1", reason: "x" },
			async () => { nextCalled += 1; return new Promise(() => {}); },
		);
		await sleep(30);
		assert.equal(nextCalled, 1, "both 下瀑布路径应放行桌面");

		// ② 就绪 → 网关重推同一次审批
		harness.releaseReady();
		await sleep(30);
		harness.pushFrame({
			type: "waterfall",
			event: "approval/request",
			eventId: "evt-dup-a",
			agentId: "session-A",
			request: { toolName: "write", callId: "call-1", reason: "x" },
		});
		await sleep(40);

		assert.equal(
			countFrames(phone, "approval/requested"),
			1,
			"同一次审批只能给手机一张卡",
		);
		assert.equal(
			(await diagnostics(harness)).checks.pendingApprovals,
			1,
			"宿主侧也只能有一个待答审批条目",
		);
		phone.destroy();
		void held;
	} finally {
		harness.clean();
	}
});

test("#177 去重不误伤：同一 session 结算后再来一次新提问 → 正常建第二个条目", async () => {
	const harness = createHarness({ eventsMode: "ready" });
	try {
		await waitForEventsReady(harness);
		const phone = openPhone(harness);
		await sleep(20);

		harness.pushFrame({
			type: "waterfall", event: "user-questions/request", eventId: "evt-first",
			agentId: "session-A", request: { questions: [{ id: "q1", question: "1?", options: [{ label: "A" }] }] },
		});
		await sleep(30);
		assert.equal((await diagnostics(harness)).checks.pendingQuestions, 1);

		// 桌面先答 → 条目清理
		harness.pushFrame({ type: "cancel", eventId: "evt-first" });
		await sleep(30);
		assert.equal((await diagnostics(harness)).checks.pendingQuestions, 0);

		// 同一 session 的新提问必须能正常建条目（去重不能变成"永不再弹"）
		harness.pushFrame({
			type: "waterfall", event: "user-questions/request", eventId: "evt-second",
			agentId: "session-A", request: { questions: [{ id: "q2", question: "2?", options: [{ label: "A" }] }] },
		});
		await sleep(30);
		assert.equal((await diagnostics(harness)).checks.pendingQuestions, 1, "新提问必须正常建卡");
		assert.equal(countFrames(phone, "question/requested"), 2, "手机应收到两次（不同提问）");
		phone.destroy();
	} finally {
		harness.clean();
	}
});

test("#177 去重不误伤：不同 session 各自建卡（不跨会话压缩）", async () => {
	const harness = createHarness({ eventsMode: "ready" });
	try {
		await waitForEventsReady(harness);
		const phone = openPhone(harness);
		await sleep(20);

		harness.pushFrame({
			type: "waterfall", event: "user-questions/request", eventId: "evt-s1",
			agentId: "session-A", request: { questions: [{ id: "q1", question: "A?", options: [{ label: "A" }] }] },
		});
		harness.pushFrame({
			type: "waterfall", event: "user-questions/request", eventId: "evt-s2",
			agentId: "session-B", request: { questions: [{ id: "q2", question: "B?", options: [{ label: "A" }] }] },
		});
		await sleep(40);

		assert.equal((await diagnostics(harness)).checks.pendingQuestions, 2, "不同会话必须各自建卡");
		assert.equal(countFrames(phone, "question/requested"), 2);
		phone.destroy();
	} finally {
		harness.clean();
	}
});

test("#177 去重不误伤 R16：同一 callId 的两次**不同**审批仍各自建卡", async () => {
	const harness = createHarness({ eventsMode: "ready" });
	try {
		await waitForEventsReady(harness);
		const phone = openPhone(harness);
		await sleep(20);

		// 同 callId，但 reason 不同 = 两次真实审批（pre-execute + sandbox escalation）
		harness.pushFrame({
			type: "waterfall", event: "approval/request", eventId: "evt-a1",
			agentId: "session-A", request: { toolName: "write", callId: "call-1", reason: "needs approval" },
		});
		harness.pushFrame({
			type: "waterfall", event: "approval/request", eventId: "evt-a2",
			agentId: "session-A", request: { toolName: "write", callId: "call-1", reason: "sandbox escalation" },
		});
		await sleep(40);

		assert.equal(
			(await diagnostics(harness)).checks.pendingApprovals,
			2,
			"R16：同一 callId 的两次不同审批必须各自建条目，去重不得吞掉第二条",
		);
		assert.equal(countFrames(phone, "approval/requested"), 2);
		phone.destroy();
	} finally {
		harness.clean();
	}
});

test("#177 去重不误伤：同 session 的两个**不同**提问各自建卡", async () => {
	const harness = createHarness({ eventsMode: "ready" });
	try {
		await waitForEventsReady(harness);
		const phone = openPhone(harness);
		await sleep(20);

		harness.pushFrame({
			type: "waterfall", event: "user-questions/request", eventId: "evt-q1",
			agentId: "session-A", request: { questions: [{ id: "q1", question: "第一个？", options: [{ label: "A" }] }] },
		});
		harness.pushFrame({
			type: "waterfall", event: "user-questions/request", eventId: "evt-q2",
			agentId: "session-A", request: { questions: [{ id: "q2", question: "第二个？", options: [{ label: "B" }] }] },
		});
		await sleep(40);

		assert.equal(
			(await diagnostics(harness)).checks.pendingQuestions,
			2,
			"两个不同提问必须各自建卡",
		);
		phone.destroy();
	} finally {
		harness.clean();
	}
});

test("#177 反向去重（问询）：瀑布路径重复进入同一次提问 → 不建第二个条目", async () => {
	// 反向场景（`$events` 先建 → 断流 → 瀑布再来）在真实链路上依赖重连时序，难以稳定复现；
	// 这里直接钉住**判据本身**：瀑布路径对同内容的提问也只建一个条目。
	const harness = createHarness({ eventsMode: "unavailable" });
	try {
		const phone = openPhone(harness);
		await sleep(20);

		const asked = { questions: [{ id: "q1", question: "选哪个？", options: [{ label: "A" }] }] };
		const handler = harness.question();
		handler({ agent: { session: { id: "session-A" } }, ...asked }, async () => new Promise(() => {}));
		await sleep(30);
		assert.equal((await diagnostics(harness)).checks.pendingQuestions, 1);

		// 同一次提问再次进入瀑布路径（真实来源：ready 翻 false 后重入）
		handler({ agent: { session: { id: "session-A" } }, ...asked }, async () => new Promise(() => {}));
		await sleep(30);
		assert.equal(
			(await diagnostics(harness)).checks.pendingQuestions,
			1,
			"同一次提问重复进入瀑布路径不得建第二个条目",
		);
		assert.equal(countFrames(phone, "question/requested"), 1, "手机只能收到一张卡");
		phone.destroy();
	} finally {
		harness.clean();
	}
});

test("#177 反向去重（审批）：瀑布路径重复进入同一次审批 → 不建第二个条目", async () => {
	const harness = createHarness({ eventsMode: "unavailable" });
	try {
		const phone = openPhone(harness);
		await sleep(20);

		const req = { agent: { session: { id: "session-A" } }, toolName: "write", callId: "call-9", reason: "once" };
		const handler = harness.approval();
		handler(req, async () => new Promise(() => {}));
		await sleep(30);
		assert.equal((await diagnostics(harness)).checks.pendingApprovals, 1);

		handler(req, async () => new Promise(() => {}));
		await sleep(30);
		assert.equal((await diagnostics(harness)).checks.pendingApprovals, 1, "同一次审批不得建第二个条目");
		assert.equal(countFrames(phone, "approval/requested"), 1);
		phone.destroy();
	} finally {
		harness.clean();
	}
});
