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
  function start(url, { method = "GET" } = {}) {
    const req = new Request(url, method);
    const res = new Response();
    const finished = new Promise((resolve) => res.once("finish", resolve));
    route(req, res);
    return { req, res, finished };
  }
  return { request, start, provide(name, value) { provided.set(name, value); }, dispose() { dispose?.(); } };
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

test("issue #109 P2：time 缺失仍可见；空 assistant/系统注入不算可见消息", async () => {
  const h = harness({
    noQuery: true,
    liveSessions: [
      liveSession("time-missing", [{ seq: 1, type: "user/message", data: { message: { id: "u", content: [{ type: "text", text: "hi" }] } } }]),
      liveSession("empty-assistant", [assistantEvent(2, 2000, "")]),
      liveSession("injected", [{ seq: 3, type: "user/message", time: 3000, data: { message: { id: "i", content: [{ type: "text", text: "plugin" }] }, source: { kind: "plugin" } } }]),
      liveSession("assistant-ok", [assistantEvent(4, 4000, "answer")]),
    ],
  });
  try {
    const def = await h.request("/m/api/sessions");
    assert.deepEqual(def.body.sessions.map((s) => s.id).sort(), ["assistant-ok", "time-missing"]);
  } finally { h.dispose(); }
});

test("issue #109 P2：旧空缓存不删——先空后出现消息，下一次请求仍保留", async () => {
  let events = [configEvent(1)];
  const h = harness();
  h.provide("sessionQuery", {
    async listSessions() { return [recorded("target")]; },
    async readSession() { return { events }; },
    async readTitleSnapshots(ids) { return ids.map((id) => ({ status: "fulfilled", value: { title: { title: id } } })); },
  });
  try {
    const first = await h.request("/m/api/sessions");
    assert.deepEqual(first.body.sessions, [], "旧空会话默认隐藏");
    events = [{ seq: 2, type: "user/message", data: { message: { id: "u", content: [{ type: "text", text: "new" }] } } }];
    const second = await h.request("/m/api/sessions");
    assert.deepEqual(second.body.sessions.map((s) => s.id), ["target"],
      "本次读取到可见消息时不得被旧 ok 缓存误删（time 缺失也要保留）");
  } finally { h.dispose(); }
});

test("issue #109 P2：120 会话超预算不删、总时长有硬上限、读取并发≤4", async () => {
  let active = 0;
  let maxActive = 0;
  let reads = 0;
  const records = Array.from({ length: 120 }, (_, i) => recorded(`s-${i}`));
  const h = harness();
  h.provide("sessionQuery", {
    async listSessions() { return records; },
    readSession() {
      reads += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      // 永不 resolve 的读：必须被单次 deadline/总预算 race 掉，不能挂住请求。
      return new Promise(() => {});
    },
    async readTitleSnapshots(ids) { return ids.map((id) => ({ status: "fulfilled", value: { title: { title: id } } })); },
  });
  try {
    const started = performance.now();
    const res = await h.request("/m/api/sessions");
    const elapsed = performance.now() - started;
    assert.equal(res.status, 200);
    assert.equal(res.body.sessions.length, 120, "未确认的会话必须保留，不得因超预算删除");
    assert.ok(elapsed >= 2300 && elapsed < 4500, `总预算应约 2.5s，实际 ${elapsed}`);
    assert.ok(reads >= 1, "至少进入读取");
    // 并发上限由独立有限延迟用例精确断言；这里挂起读的底层 promise 无法取消，
    // active 计数会保留到进程结束，故只验证硬时限+不删。
  } finally { h.dispose(); }
});

test("issue #109 P2：同步可见性读取并发≤4（有限延迟场景）", async () => {
  let active = 0;
  let maxActive = 0;
  const records = Array.from({ length: 120 }, (_, i) => recorded(`c-${i}`));
  const h = harness();
  h.provide("sessionQuery", {
    async listSessions() { return records; },
    async readSession() {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { events: [userEvent(1, 1000)] };
    },
    async readTitleSnapshots(ids) { return ids.map((id) => ({ status: "fulfilled", value: { title: { title: id } } })); },
  });
  try {
    const res = await h.request("/m/api/sessions");
    assert.equal(res.status, 200);
    assert.equal(res.body.sessions.length, 120);
    assert.ok(maxActive <= 4, `并发上限应为 4，实际 ${maxActive}`);
  } finally { h.dispose(); }
});

test("issue #109 P2：请求取消后不再写响应（readSession 挂起也不无限等待）", async () => {
  const h = harness();
  h.provide("sessionQuery", {
    async listSessions() { return [recorded("cancelled")]; },
    readSession() { return new Promise(() => {}); },
    async readTitleSnapshots(ids) { return ids.map((id) => ({ status: "fulfilled", value: { title: { title: id } } })); },
  });
  try {
    const pending = h.start("/m/api/sessions");
    await new Promise((resolve) => setTimeout(resolve, 60));
    pending.res.emit("close"); // 客户端断开
    let finished = false;
    pending.finished.then(() => { finished = true; });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(finished, false, "断开后不得写响应");
  } finally { h.dispose(); }
});
