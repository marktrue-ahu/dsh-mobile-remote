// issue #162：dormant/inactive 子代理的模型/effort 从宿主权威 projection cache 读。
// P1：pending(next) > 事件折叠 > lastUsed；P2：只用 cachedSnapshot，不直读 projcache 文件。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { apply } from "../lib/index.js";

const CONFIG = {
  path: "/m", authToken: "test-token-long-enough", cookieName: "dsh_mobile_token", trustedHosts: [],
  sessionTtlMs: 60000, rechargeUrl: "https://example.test", maxConnections: 4,
  pushUrls: [], pushCooldownMs: 1000, doneGraceMs: 1000, pushContent: "minimal",
  rateLimit: {}, lanBridge: { enabled: false }, approvalMode: "desktop",
};

const header = (id) => ({ id, version: 1, createdAt: 1, cwd: "/tmp", isSeeded: false });
const pick = (provider, model, effort) => ({ provider, model, ...(effort ? { reasoningEffort: effort } : {}) });

function harness({ live = false, events = [], noQuery = false, seeded = false, cache, surface } = {}) {
  const routes = [];
  const cacheCalls = [];
  const resumeCalls = [];
  const session = {
    id: "live",
    header: header("live"),
    snapshotEvents: () => [{ type: "model/selection", data: pick("p-live", "m-live", "low") }],
  };
  const resumedAgent = { id: "resume", status: "idle", followup() {} };
  const services = new Map([
    ["agents", {
      get: (id) => live && id === "live" ? { id, session } : undefined,
      resume: async (args) => {
        resumeCalls.push(args);
        return { agent: { ...resumedAgent, id: args.resumeSessionId } };
      },
    }],
    ["sessions", { get: (id) => live && id === "live" ? session : undefined }],
    ["typertGateway", {
      async invokeRpc() { return { ok: true, value: {} }; },
      async stream() {
        return (async function* () {
          if (live) {
            yield {
              type: "baseline",
              value: { projections: { live: { values: { modelSelection: { next: pick("p-live", "m-live", "low") } } } } },
            };
          } else {
            yield { type: "baseline", value: { projections: {} } };
          }
        })();
      },
    }],
  ]);
  if (!noQuery) {
    services.set("sessionQuery", {
      async readSession(id) {
        if (seeded) throw new Error("seeded session constructor seed must equal its inherited prefix");
        return { session: header(id), events };
      },
      async readSurface(id) {
        if (surface === undefined) return { session: header(id), events: [] };
        if (surface instanceof Error) throw surface;
        return surface;
      },
      async listEvents() { return events.map((event, index) => ({ type: event.type, seq: index + 1 })); },
      async readEvent({ seq }) { return { target: { ...events[seq - 1], seq } }; },
    });
  }
  if (cache !== undefined) {
    services.set("sessionProjectionCache", {
      cachedSnapshot(meta, keys) {
        cacheCalls.push({ id: meta.id, keys });
        if (cache instanceof Error) throw cache;
        return cache;
      },
    });
  }
  const ctx = {
    webServer: { host: "127.0.0.1", port: 3080, register(route) { routes.push(route); return () => {}; } },
    logger: { info() {}, warn() {} },
    get: (name) => services.get(name),
    provide: (name, value) => services.set(name, value),
    on: () => () => {},
    effect: (cb) => { const d = cb?.(); return typeof d === "function" ? d : () => {}; },
    inject() {}, waterfall: async () => "unavailable",
  };
  const dispose = apply(ctx, CONFIG);
  return { route: routes.find((r) => r.path === "/m/api").handler, cacheCalls, resumeCalls, dispose };
}

async function request(route, path, body) {
  const req = new EventEmitter();
  req.url = path; req.method = body === undefined ? "GET" : "POST";
  req.headers = { host: "127.0.0.1", "x-mobile-token": CONFIG.authToken, "content-type": "application/json" };
  req.socket = { remoteAddress: "127.0.0.1" };
  const res = new EventEmitter();
  let text = "";
  res.headersSent = false;
  res.writeHead = (status) => { res.statusCode = status; res.headersSent = true; };
  res.write = (value) => { text += value; return true; };
  res.end = (value) => { if (value) text += value; res.emit("finish"); };
  const done = new Promise((resolve) => res.once("finish", resolve));
  route(req, res);
  if (body !== undefined) queueMicrotask(() => {
    req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end");
  });
  await done;
  return { status: res.statusCode, body: JSON.parse(text || "{}") };
}

const projection = (lastUsed, next, asOfSeq = 10) => ({ asOfSeq, values: { modelSelection: { lastUsed, next } } });

test("live 会话行为不变：control next 优先，不读 projection cache", async () => {
  const h = harness({ live: true, cache: projection(pick("p-proj", "m-proj", "max"), pick("p-proj", "m-proj", "max")) });
  try {
    const res = await request(h.route, "/m/api/session-config?sessionId=live");
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.config.provider, res.body.config.model, res.body.config.reasoningEffort], ["p-live", "m-live", "low"]);
    assert.equal(h.cacheCalls.length, 0);
  } finally { h.dispose?.(); }
});

test("P1：cache asOfSeq 旧（B pending）但事件 C 更新 → config 用 C 并标降级", async () => {
  const h = harness({
    events: [{ seq: 11, type: "model/selection", data: pick("c", "model-c", "high") }],
    cache: projection(pick("a", "model-a", "medium"), pick("b", "model-b", "max"), 10),
  });
  try {
    const res = await request(h.route, "/m/api/session-config?sessionId=dormant-b");
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.config.provider, res.body.config.model, res.body.config.reasoningEffort], ["c", "model-c", "high"]);
    assert.equal(res.body.configDegraded, true);
    assert.deepEqual(h.cacheCalls[0].keys, ["modelSelection"]);
  } finally { h.dispose?.(); }
});

test("dormant：cache 覆盖最新事件时 pending B 优先于事件 A", async () => {
  const h = harness({
    events: [{ seq: 1, type: "model/selection", data: pick("event", "event-model", "low") }],
    cache: projection(pick("a", "model-a", "medium"), pick("b", "model-b", "max"), 10),
  });
  try {
    const res = await request(h.route, "/m/api/session-config?sessionId=dormant-cache-fresh");
    assert.deepEqual([res.body.config.provider, res.body.config.model, res.body.config.reasoningEffort], ["b", "model-b", "max"]);
    assert.equal(res.body.config.configDegraded, undefined);
  } finally { h.dispose?.(); }
});

test("P2 seeded 回退：从 readSurface header 取 cache-only 模型", async () => {
  const id = "seeded-cache-only";
  const h = harness({
    seeded: true,
    events: [],
    surface: { session: header(id), events: [] },
    cache: projection(pick("seed", "seed-model", "max"), pick("seed", "seed-model", "max"), 7),
  });
  try {
    const res = await request(h.route, `/m/api/session-config?sessionId=${id}`);
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.config.provider, res.body.config.model, res.body.config.reasoningEffort], ["seed", "seed-model", "max"]);
    assert.equal(h.cacheCalls.length, 1);
    assert.equal(h.cacheCalls[0].id, id);
  } finally { h.dispose?.(); }
});

test("P2 seeded 回退无可信 header：不读 cache，config/resume 都带降级标记", async () => {
  const h = harness({
    seeded: true,
    events: [{ seq: 1, type: "model/selection", data: pick("event", "event-model", "low") }],
    surface: new Error("surface unavailable"),
    cache: projection(pick("seed", "seed-model", "max"), pick("seed", "seed-model", "max"), 7),
  });
  try {
    const res = await request(h.route, "/m/api/session-config?sessionId=seeded-no-header");
    assert.equal(res.body.config.model, "event-model");
    assert.equal(res.body.configDegraded, true, "header 未确认时即使事件回退成功也必须降级");
    assert.equal(h.cacheCalls.length, 0);

    const send = await request(h.route, "/m/api/send", { sessionId: "seeded-no-header", text: "hi" });
    assert.equal(send.status, 200);
    assert.equal(send.body.configDegraded, true, "resume 响应必须带降级标记");
    assert.deepEqual(h.resumeCalls[0].agentOptions, {
      provider: "event", model: "event-model", reasoningEffort: "low",
    });
  } finally { h.dispose?.(); }
});

test("dormant：cache stale 且无 pending → 重放事件优先于 lastUsed；无模型则省略", async () => {
  const h = harness({
    events: [{ seq: 1, type: "model/selection", data: pick("event", "event-model", "low") }],
    cache: projection(pick("a", "model-a", "medium"), pick("a", "model-a", "medium"), 0),
  });
  try {
    const res = await request(h.route, "/m/api/session-config?sessionId=dormant-event");
    assert.deepEqual([res.body.config.provider, res.body.config.model, res.body.config.reasoningEffort], ["event", "event-model", "low"]);
    assert.equal(res.body.configDegraded, true);
  } finally { h.dispose?.(); }

  const empty = harness({ events: [], cache: undefined });
  try {
    const res = await request(empty.route, "/m/api/session-config?sessionId=no-model");
    assert.equal(res.body.config.model, undefined);
    assert.equal(res.body.config.provider, undefined);
  } finally { empty.dispose?.(); }
});

test("P1 resume：stale cache B、事件 C → agentOptions 用 C", async () => {
  const h = harness({
    events: [{ seq: 11, type: "model/selection", data: pick("c", "model-c", "high") }],
    cache: projection(pick("a", "model-a", "medium"), pick("b", "model-b", "max"), 10),
  });
  try {
    const res = await request(h.route, "/m/api/send", { sessionId: "resume", text: "hi" });
    assert.equal(res.status, 200);
    assert.deepEqual(h.resumeCalls[0].agentOptions, { provider: "c", model: "model-c", reasoningEffort: "high" });
    assert.equal(res.body.configDegraded, true);
  } finally { h.dispose?.(); }
});

test("P2：缺 cache 服务/ID 重建/版本不匹配不读磁盘投影、不冒充权威", async () => {
  // 磁盘上放一份“lastUsed=A”旧文件；没有 cache 服务时不得使用它。
  const oldRoot = process.env.DSH_STORAGE_ROOT;
  process.env.DSH_STORAGE_ROOT = "/tmp/does-not-matter";
  try {
    const h = harness({ events: [] });
    try {
      const res = await request(h.route, "/m/api/session-config?sessionId=recreated");
      assert.equal(res.status, 200);
      assert.equal(res.body.config.model, undefined);
    } finally { h.dispose?.(); }
  } finally {
    if (oldRoot === undefined) delete process.env.DSH_STORAGE_ROOT;
    else process.env.DSH_STORAGE_ROOT = oldRoot;
  }

  const recreated = harness({ events: [], cache: undefined });
  try {
    const res = await request(recreated.route, "/m/api/session-config?sessionId=recreated");
    assert.equal(res.body.config.model, undefined);
  } finally { recreated.dispose?.(); }

  const recreatedProjection = harness({ events: [], cache: null });
  try {
    const res = await request(recreatedProjection.route, "/m/api/session-config?sessionId=recreated");
    assert.equal(res.body.config.model, undefined, "ID 重建后的 cache 不匹配不得冒充旧模型");
    assert.equal(recreatedProjection.cacheCalls.length, 1);
  } finally { recreatedProjection.dispose?.(); }

  const stale = harness({ events: [{ seq: 9, type: "model/selection", data: pick("event", "event-model") }], cache: new Error("version-mismatch") });
  try {
    const res = await request(stale.route, "/m/api/session-config?sessionId=stale");
    assert.equal(res.body.config.provider, "event");
    assert.equal(res.body.config.model, "event-model");
  } finally { stale.dispose?.(); }
});

test("旧宿主无 cache 服务：事件折叠可用，不崩", async () => {
  const h = harness({ events: [{ seq: 1, type: "model/selection", data: pick("old", "old-model", "high") }], noQuery: false, cache: undefined });
  try {
    const res = await request(h.route, "/m/api/session-config?sessionId=old-host");
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.config.provider, res.body.config.model, res.body.config.reasoningEffort], ["old", "old-model", "high"]);
  } finally { h.dispose?.(); }
});
