// issue #109：/m/api/sessions 默认排除「零可见消息」空会话；includeEmpty=1 返回全部。
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

class Response extends EventEmitter {
  constructor() { super(); this.chunks = []; this.headersSent = false; }
  writeHead(statusCode) { this.statusCode = statusCode; this.headersSent = true; }
  write(chunk) { this.chunks.push(String(chunk)); return true; }
  end(chunk = "") { this.chunks.push(String(chunk)); this.emit("finish"); }
  destroy() { this.emit("close"); }
}
class Request extends EventEmitter {
  constructor(url, method = "GET") {
    super(); this.url = url; this.method = method;
    this.headers = { host: "127.0.0.1", "x-mobile-token": CONFIG.authToken };
    this.socket = { remoteAddress: "127.0.0.1" };
  }
}

const recorded = (id, header = {}) => ({ header: { id, createdAt: header.createdAt ?? 1000, cwd: "/tmp/proj", ...header }, live: header.live ?? false, persisted: true });
const liveSession = (id, events, header = {}) => ({ id, header: { id, createdAt: 1000, cwd: "/tmp/proj", ...header }, snapshotEvents: () => events });
const userEvent = (seq, time) => ({ seq, type: "user/message", time, data: { message: { id: `u${seq}`, content: [{ type: "text", text: "hi" }] } } });
const assistantEvent = (seq, time, text = "ok") => ({ seq, type: "assistant/message", time, data: { message: { id: `a${seq}`, content: [{ type: "text", text }] } } });
const configEvent = (seq) => ({ seq, type: "permission/preset", time: 500, data: { preset: "read-only" } });

function harness({ records = [], liveSessions = [], query = null, noQuery = false, archived = [] } = {}) {
  const routes = [];
  const provided = new Map();
  const liveMap = new Map(liveSessions.map((s) => [s.id, s]));
  provided.set("sessions", { get: (id) => liveMap.get(id), list: () => liveSessions });
  if (!noQuery) {
    provided.set("sessionQuery", query ?? {
      listSessions: async () => records,
      async readTitleSnapshots(ids) { return ids.map((id) => ({ status: "fulfilled", value: { title: { title: `标题 ${id}` } } })); },
    });
  }
  provided.set("workspaceRegistry", {
    list: () => [],
    archivedSessionIds: archived,
    requireState: () => ({ archivedSessionIds: archived }),
    setState: async () => undefined,
    enqueueOperation: async (fn) => fn(),
  });
  const ctx = {
    webServer: { host: "127.0.0.1", port: 43120, register(spec) { routes.push(spec); return () => {}; } },
    logger: { warn() {}, info() {} },
    get(name) { return provided.get(name); }, provide(name, value) { provided.set(name, value); },
    on() { return () => {}; }, effect(cb) { return cb?.() ?? (() => {}); }, inject() {},
  };
  const dispose = apply(ctx, CONFIG);
  const route = routes.find((r) => r.path === "/m/api")?.handler;
  assert.equal(typeof route, "function");
  async function request(url, { method = "GET" } = {}) {
    const req = new Request(url, method);
    const res = new Response();
    const finished = new Promise((resolve) => res.once("finish", resolve));
    route(req, res);
    await finished;
    return { status: res.statusCode, body: JSON.parse(res.chunks.join("") || "{}") };
  }
  return { request, provide(name, value) { provided.set(name, value); }, dispose() { dispose?.(); } };
}

function fixtureQuery() {
  const events = new Map([
    ["dormant-empty", [configEvent(1)]],
    ["dormant-message", [configEvent(1), userEvent(2, 2000)]],
    ["dormant-tool-only", [{ seq: 3, type: "tool/call", time: 3000, data: { callId: "c" } }]],
  ]);
  return {
    async listSessions() {
      return ["live-empty", "live-message", "dormant-empty", "dormant-message", "dormant-tool-only", "archived-empty"]
        .map((id) => recorded(id, { live: id.startsWith("live-") }));
    },
    async readSession(id) { return { events: events.get(id) ?? [] }; },
    async readTitleSnapshots(ids) { return ids.map((id) => ({ status: "fulfilled", value: { title: { title: `标题 ${id}` } } })); },
  };
}

test("issue #109：默认排除零可见消息；includeEmpty=1 返回全部；仅配置/工具空会话不出现", async () => {
  const h = harness({
    liveSessions: [
      liveSession("live-empty", [configEvent(1)]),
      liveSession("live-message", [userEvent(1, 1000)]),
      liveSession("fallback-empty-live", []),
    ],
    archived: ["archived-empty"],
  });
  h.provide("sessionQuery", fixtureQuery());
  try {
    const def = await h.request("/m/api/sessions");
    assert.equal(def.status, 200, JSON.stringify(def.body));
    const ids = def.body.sessions.map((s) => s.id);
    assert.deepEqual(ids.sort(), ["dormant-message", "live-message"]);
    assert.ok(!ids.includes("dormant-empty"));
    assert.ok(!ids.includes("dormant-tool-only"), "tool/call 不算可见对话消息");
    assert.ok(!ids.includes("archived-empty"));
    // 排序：dormant-message 2000 > live-message 1000；标题仍为已折叠标题而非裸 id
    assert.deepEqual(def.body.sessions.map((s) => s.id), ["dormant-message", "live-message"]);
    for (const row of def.body.sessions) assert.ok(typeof row.title === "string" && row.title !== "", "标题不得回退为空");
    assert.match(def.body.sessions.find((s) => s.id === "dormant-message").title, /标题 /);

    const all = await h.request("/m/api/sessions?includeEmpty=1");
    assert.equal(all.status, 200);
    const allIds = all.body.sessions.map((s) => s.id).sort();
    assert.deepEqual(allIds, [
      "archived-empty", "dormant-empty", "dormant-message", "dormant-tool-only", "live-empty", "live-message",
    ]);
    assert.equal(all.body.sessions.find((s) => s.id === "archived-empty").archived, true);

    for (const value of ["0", "true", "", "yes"]) {
      const got = await h.request(`/m/api/sessions?includeEmpty=${encodeURIComponent(value)}`);
      assert.ok(!got.body.sessions.some((s) => s.id === "dormant-empty"), `includeEmpty=${value} 应按 false`);
    }
  } finally { h.dispose(); }
});

test("issue #109：旧宿主无 sessionQuery（fallback 分支）同样过滤空会话", async () => {
  const h = harness({
    noQuery: true,
    liveSessions: [
      liveSession("empty-live", [configEvent(1)]),
      liveSession("message-live", [assistantEvent(2, 2000)]),
    ],
  });
  try {
    const def = await h.request("/m/api/sessions");
    assert.deepEqual(def.body.sessions.map((s) => s.id), ["message-live"]);
    const all = await h.request("/m/api/sessions?includeEmpty=1");
    assert.deepEqual(all.body.sessions.map((s) => s.id).sort(), ["empty-live", "message-live"]);
  } finally { h.dispose(); }
});

test("issue #109：已释放/归档空会话默认隐藏；有消息的归档会话保留 archived 标记", async () => {
  const h = harness({ archived: ["empty-archived", "message-archived"] });
  h.provide("sessionQuery", {
    async listSessions() {
      return [recorded("empty-archived"), recorded("message-archived")];
    },
    async readSession(id) {
      return { events: id === "message-archived" ? [userEvent(1, 5000)] : [configEvent(1)] };
    },
    async readTitleSnapshots(ids) { return ids.map((id) => ({ status: "fulfilled", value: { title: { title: id } } })); },
  });
  try {
    const def = await h.request("/m/api/sessions");
    assert.deepEqual(def.body.sessions.map((s) => s.id), ["message-archived"]);
    assert.equal(def.body.sessions[0].archived, true);
    const all = await h.request("/m/api/sessions?includeEmpty=1");
    assert.deepEqual(all.body.sessions.map((s) => s.id).sort(), ["empty-archived", "message-archived"]);
  } finally { h.dispose(); }
});

test("issue #109：回填失败/未知的会话不误删（宁可多显示）", async () => {
  const h = harness();
  h.provide("sessionQuery", {
    async listSessions() { return [recorded("unknown")]; },
    async readSession() { throw new Error("persistence failed"); },
    async readTitleSnapshots(ids) { return ids.map(() => ({ status: "rejected" })); },
  });
  try {
    const def = await h.request("/m/api/sessions");
    assert.deepEqual(def.body.sessions.map((s) => s.id), ["unknown"],
      "无法确认空/非空时保留，不能把有消息会话误删");
  } finally { h.dispose(); }
});
