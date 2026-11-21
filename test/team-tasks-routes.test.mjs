/**
 * GitLab #143：只读任务板端点契约。
 *
 * 数据来自宿主 `agentTeams` 服务（TeamTaskView）；移动端只暴露
 * id/subject/status/ownerId/ownerName/blockedBy/ready，过滤 deleted，不返回
 * description/writeScopes/revision，且不提供任何写操作。
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
};

class FakeResponse extends EventEmitter {
	constructor() {
		super();
		this.statusCode = 0;
		this.headers = {};
		this.chunks = [];
	}
	writeHead(statusCode, headers = {}) { this.statusCode = statusCode; this.headers = headers; }
	write(chunk) { this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return true; }
	end(chunk = "") { if (chunk !== "") this.write(chunk); this.emit("finish"); }
	destroy() { this.destroyed = true; this.emit("close"); }
}

class FakeRequest extends EventEmitter {
	constructor(url, method = "GET") {
		super();
		this.url = url;
		this.method = method;
		this.headers = { host: "127.0.0.1", "x-mobile-token": CONFIG.authToken };
		this.socket = { remoteAddress: "127.0.0.1" };
	}
}

function createHarness({ session = null, team = null } = {}) {
	const routes = [];
	const provided = new Map();
	if (session) {
		provided.set("agents", { get: (id) => id === session.id ? session : undefined });
		provided.set("sessions", { get: (id) => id === session.id ? session.session : undefined });
	}
	if (team) provided.set("agentTeams", team);
	const ctx = {
		webServer: { host: "127.0.0.1", port: 43120, register(spec) { routes.push(spec); return () => {}; } },
		logger: { warn() {}, info() {} },
		get(name) { return provided.get(name); },
		provide(name, value) { provided.set(name, value); },
		on() { return () => {}; },
		effect(callback) { const disposer = callback?.(); return typeof disposer === "function" ? disposer : () => {}; },
		inject() {},
		waterfall: async () => "unavailable",
	};
	const dispose = apply(ctx, CONFIG);
	return {
		route: routes.find((route) => route.path === "/m/api").handler,
		clean() { dispose?.(); },
	};
}

async function call(route, { url, method = "GET" } = {}) {
	const req = new FakeRequest(url, method);
	const res = new FakeResponse();
	const finished = new Promise((resolve) => res.once("finish", resolve));
	route(req, res);
	await finished;
	const text = Buffer.concat(res.chunks).toString("utf8");
	let body;
	try { body = JSON.parse(text); } catch { body = text; }
	return { status: res.statusCode, body };
}

const liveSession = { id: "s1", session: { id: "s1", header: { cwd: "/work" } } };

const TASKS = [
	{ id: "task-1", revision: 1, subject: "调查 SSE 泄漏", description: "secret description", status: "completed", blockedBy: [], writeScopes: ["src/a.ts"], ownerId: "s1", ownerName: "lead", ready: false },
	{ id: "task-2", revision: 2, subject: "实现路径安全", description: "do not show", status: "in_progress", blockedBy: [], writeScopes: [], ownerId: "s2" },
	{ id: "task-3", revision: 3, subject: "等待依赖", description: "hidden", status: "pending", blockedBy: ["task-1", "task-2"], writeScopes: [], ready: false },
	{ id: "task-4", revision: 1, subject: "已删除的任务", description: "gone", status: "deleted", blockedBy: [], writeScopes: [] },
];

test("team/tasks：旧宿主没有 agentTeams → supported=false，不伪造空板", async () => {
	const h = createHarness({ session: liveSession });
	try {
		const res = await call(h.route, { url: "/m/api/team/tasks?sessionId=s1" });
		assert.equal(res.status, 200);
		assert.equal(res.body.ok, true);
		assert.equal(res.body.supported, false);
		assert.deepEqual(res.body.tasks, []);
	} finally { h.clean(); }
});

test("team/tasks：团队未启用 → enabled=false + 空任务，不读任务", async () => {
	let listed = false;
	const h = createHarness({
		session: liveSession,
		team: { isEnabled: () => false, listTasks: () => { listed = true; return TASKS; } },
	});
	try {
		const res = await call(h.route, { url: "/m/api/team/tasks?sessionId=s1" });
		assert.equal(res.status, 200);
		assert.equal(res.body.supported, true);
		assert.equal(res.body.enabled, false);
		assert.deepEqual(res.body.tasks, []);
		assert.equal(listed, false, "未启用团队时不应触碰任务读取");
	} finally { h.clean(); }
});

test("team/tasks：只读字段白名单、deleted 过滤、ready 派生", async () => {
	const h = createHarness({
		session: liveSession,
		team: { isEnabled: () => true, listTasks: () => TASKS },
	});
	try {
		const res = await call(h.route, { url: "/m/api/team/tasks?sessionId=s1" });
		assert.equal(res.status, 200);
		assert.equal(res.body.enabled, true);
		assert.equal(res.body.tasks.length, 3, "deleted 不得下发");
		const byId = new Map(res.body.tasks.map((task) => [task.id, task]));
		assert.equal(byId.has("task-4"), false);
		for (const task of res.body.tasks) {
			assert.deepEqual(Object.keys(task).sort(), ["blockedBy", "id", "ownerId", "ownerName", "ready", "status", "subject"].filter((key) => task[key] !== undefined).sort());
			assert.equal("description" in task, false);
			assert.equal("writeScopes" in task, false);
			assert.equal("revision" in task, false);
			assert.equal(Array.isArray(task.blockedBy), true);
		}
		assert.equal(byId.get("task-3").ready, false);
		assert.equal(byId.get("task-1").ready, false);
		assert.equal(byId.get("task-2").ready, false, "只有 pending 任务可能 ready");
	} finally { h.clean(); }
});

test("team/tasks：投影失败 → 200 + failure，保留 supported/enabled 事实", async () => {
	const h = createHarness({
		session: liveSession,
		team: { isEnabled: () => true, listTasks: () => { throw new Error("投影损坏：bad checkpoint"); } },
	});
	try {
		const res = await call(h.route, { url: "/m/api/team/tasks?sessionId=s1" });
		assert.equal(res.status, 200);
		assert.equal(res.body.supported, true);
		assert.equal(res.body.enabled, true);
		assert.match(res.body.failure, /投影损坏/);
		assert.deepEqual(res.body.tasks, []);
	} finally { h.clean(); }
});

test("team/tasks：缺 sessionId → 400；未知会话 → 404；只读（POST 405）", async () => {
	const h = createHarness({ session: liveSession, team: { isEnabled: () => true, listTasks: () => [] } });
	try {
		const missing = await call(h.route, { url: "/m/api/team/tasks" });
		assert.equal(missing.status, 400);
		assert.equal(missing.body.error, "bad-request");
		const unknown = await call(h.route, { url: "/m/api/team/tasks?sessionId=nope" });
		assert.equal(unknown.status, 404);
		assert.equal(unknown.body.error, "session-not-found");
		const post = await call(h.route, { url: "/m/api/team/tasks?sessionId=s1", method: "POST" });
		assert.equal(post.status, 405);
		assert.equal(post.body.error, "method-not-allowed");
	} finally { h.clean(); }
});
