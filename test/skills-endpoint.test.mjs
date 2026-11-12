// issue #90：GET /m/api/skills —— 只读透传 DSH ctx.skills.list。
//
// 契约：只下发 name/description/whenToUse/modelInvocable；旧宿主/服务缺失/目录失败
// 返回 200 + {skills: [], unavailable: true}（不 5xx、不阻塞命令）；休眠会话走与
// /commands 相同的 resume 路径；POST 等非只读方法 405。

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { apply } from "../lib/index.js";

const CONFIG = {
	path: "/m", authToken: "1234567890123456", cookieName: "dsh_mobile_token",
	trustedHosts: [], sessionTtlMs: 60_000, rechargeUrl: "https://example.test/top-up",
	maxConnections: 4, pushUrls: [], pushCooldownMs: 1, doneGraceMs: 1,
	pushContent: "minimal", rateLimit: {}, lanBridge: { enabled: false, port: 3080, host: "127.0.0.1" },
	approvalMode: "mobile",
};

class FakeResponse extends EventEmitter {
	constructor() { super(); this.headersSent = false; this.chunks = []; }
	writeHead(statusCode) { this.statusCode = statusCode; this.headersSent = true; }
	write(chunk) { this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)); return true; }
	end(chunk = "") { if (chunk !== "") this.chunks.push(String(chunk)); this.emit("finish"); }
	destroy() { this.destroyed = true; this.emit("close"); }
}
class FakeRequest extends EventEmitter {
	constructor(url, method = "GET") {
		super(); this.url = url; this.method = method;
		this.headers = { host: "127.0.0.1", "x-mobile-token": CONFIG.authToken };
		this.socket = { remoteAddress: "127.0.0.1" };
	}
}

function createHarness({ session, agents, presets, skills, query } = {}) {
	const routes = [];
	const provided = new Map();
	provided.set("sessions", { get: (id) => id === session?.id ? session : undefined });
	if (query !== undefined) provided.set("sessionQuery", query);
	if (agents !== undefined) provided.set("agents", agents);
	if (presets !== undefined) provided.set("agentPresets", presets);
	if (skills !== undefined) provided.set("skills", skills);
	const ctx = {
		webServer: { host: "127.0.0.1", port: 43120, register(spec) { routes.push(spec); return () => {}; } },
		logger: { warn() {}, info() {} },
		get(name) { return provided.get(name); },
		provide(name, value) { provided.set(name, value); },
		on() { return () => {}; },
		effect(cb) { const d = cb?.(); return typeof d === "function" ? d : () => {}; },
		inject() {},
	};
	const dispose = apply(ctx, CONFIG);
	return {
		route: routes.find((route) => route.path === "/m/api").handler,
		clean() { dispose?.(); },
	};
}

async function request(route, path, method = "GET") {
	const req = new FakeRequest(`/m/api${path}`, method);
	const res = new FakeResponse();
	const finished = new Promise((resolve) => res.once("finish", resolve));
	route(req, res);
	await finished;
	return { status: res.statusCode, body: JSON.parse(res.chunks.join("") || "{}") };
}

const agent = (cwd = "/repo") => ({ id: "a1", session: { header: { cwd } } });

test("GET /skills：透传 userInvocable 技能；只下发 name/description/whenToUse/modelInvocable", async () => {
	const calls = [];
	const session = { id: "s1", header: { cwd: "/repo" } };
	const harness = createHarness({
		session,
		agents: { get: () => agent() },
		skills: {
			list: async (options) => {
				calls.push(options);
				return [
					{ name: "grill-me", description: "Grill a plan", whenToUse: "stress-test", path: "/secret/SKILL.md", content: "body", invocation: { userInvocable: true, modelInvocable: true } },
					{ name: "internal", description: "not user", invocation: { userInvocable: false, modelInvocable: true } },
					{ name: "plain", description: "no whenToUse", invocation: { userInvocable: true, modelInvocable: false } },
				];
			},
		},
	});
	try {
		const { status, body } = await request(harness.route, "/skills?sessionId=s1");
		assert.equal(status, 200);
		assert.equal(body.ok, true);
		assert.equal(body.unavailable, undefined);
		assert.deepEqual(body.skills, [
			{ name: "grill-me", description: "Grill a plan", whenToUse: "stress-test", modelInvocable: true },
			{ name: "plain", description: "no whenToUse", modelInvocable: false },
		], "name/description/whenToUse/modelInvocable；path/正文不得下发");
		assert.equal(calls.length, 1);
		assert.equal(calls[0].cwd, "/repo");
		assert.equal(calls[0].scope, calls[0].scope, "应携带会话 scope");
	} finally { harness.clean(); }
});

test("GET /skills：无 skills 服务 / 旧宿主 → 200 + unavailable（不 5xx）", async () => {
	const harness = createHarness({ session: { id: "s1", header: { cwd: "/repo" } }, agents: { get: () => agent() } });
	try {
		const { status, body } = await request(harness.route, "/skills?sessionId=s1");
		assert.equal(status, 200);
		assert.deepEqual(body, { ok: true, skills: [], unavailable: true });
	} finally { harness.clean(); }
});

test("GET /skills：目录 list 抛错 → 200 + unavailable（不阻塞命令）", async () => {
	const harness = createHarness({
		session: { id: "s1", header: { cwd: "/repo" } },
		agents: { get: () => agent() },
		skills: { list: async () => { throw new Error("provider exploded /secret/path"); } },
	});
	try {
		const { status, body } = await request(harness.route, "/skills?sessionId=s1");
		assert.equal(status, 200);
		assert.deepEqual(body, { ok: true, skills: [], unavailable: true });
	} finally { harness.clean(); }
});

test("GET /skills：presets.serviceFor 优先；休眠会话先 resume 再列技能", async () => {
	const calls = [];
	const scoped = { list: async (options) => { calls.push(["scoped", options]); return [{ name: "demo", description: "d", invocation: { userInvocable: true, modelInvocable: true } }]; } };
	const resumeCalls = [];
	const harness = createHarness({
		session: { id: "s1", header: { cwd: "/repo" } },
		query: { readSession: async () => ({ events: [] }) },
		agents: {
			get: (id) => id === "s1" && resumeCalls.length > 0 ? agent() : undefined,
			resume: async ({ resumeSessionId }) => { resumeCalls.push(resumeSessionId); return { agent: agent() }; },
		},
		presets: { defaultId: "standard", resolve: async (id) => ({ id }), mount: async () => {}, serviceFor: () => scoped },
		skills: { list: async () => { throw new Error("global should not be used"); } },
	});
	try {
		const { status, body } = await request(harness.route, "/skills?sessionId=s1");
		assert.equal(status, 200);
		assert.deepEqual(body.skills, [{ name: "demo", description: "d", modelInvocable: true }]);
		assert.deepEqual(resumeCalls, ["s1"]);
		assert.equal(calls[0][1].cwd, "/repo");
	} finally { harness.clean(); }
});

test("GET /skills：缺 sessionId 400；方法非 GET/HEAD 405；恢复后仍无会话 404", async () => {
	const harness = createHarness({
		session: { id: "s1", header: { cwd: "/repo" } },
		agents: { get: () => undefined, resume: async () => { throw new Error("resume failed"); } },
		presets: { defaultId: "standard" },
		skills: { list: async () => [] },
	});
	try {
		assert.equal((await request(harness.route, "/skills")).status, 400);
		assert.equal((await request(harness.route, "/skills?sessionId=s1", "POST")).status, 405);
		assert.equal((await request(harness.route, "/skills?sessionId=missing")).status, 404);
	} finally { harness.clean(); }
});
