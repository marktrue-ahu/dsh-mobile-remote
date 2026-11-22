// issue #162：dormant/inactive 子代理的模型/effort 从持久化 projection 读，
// lastUsed 优先、事件折叠回退；live 行为不变；不泄露正文。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";

const CONFIG = {
  path: "/m", authToken: "test-token-long-enough", cookieName: "dsh_mobile_token", trustedHosts: [],
  sessionTtlMs: 60000, rechargeUrl: "https://example.test", maxConnections: 4,
  pushUrls: [], pushCooldownMs: 1000, doneGraceMs: 1000, pushContent: "minimal",
  rateLimit: {}, lanBridge: { enabled: false }, approvalMode: "desktop",
};

let root;
const projectionFile = (id) => {
  const dir = join(root, "session_projcache", "sessions");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${id}.json`);
};
const writeProjection = (id, lastUsed, extra = {}) => {
  const file = projectionFile(id);
  writeFileSync(file, JSON.stringify({
    version: 7,
    record: {
      identity: { id },
      rows: {
        modelSelection: { ver: 3, seq: 1, val: { lastUsed, pending: null } },
        prompt: { val: "SECRET_PROMPT_BODY" },
        ...extra,
      },
    },
  }));
};
const removeProjection = (id) => {
  try { rmSync(projectionFile(id), { force: true }); } catch {}
};

function harness({ live = false, events = [], noQuery = false, seeded = false } = {}) {
  const routes = [];
  const session = {
    id: "live",
    header: { cwd: "/tmp" },
    snapshotEvents: () => [{ type: "model/selection", data: { provider: "p-live", model: "m-live", reasoningEffort: "low" } }],
  };
  const services = new Map([
    ["agents", { get: (id) => live && id === "live" ? { id, session } : undefined }],
    ["sessions", { get: (id) => live && id === "live" ? session : undefined }],
    ["typertGateway", {
      async invokeRpc() { return { ok: true, value: {} }; },
      async stream() {
        return (async function* () {
          if (live) {
            yield {
              type: "baseline",
              value: {
                projections: {
                  live: {
                    values: {
                      modelSelection: {
                        next: { provider: "p-live", model: "m-live", reasoningEffort: "low" },
                      },
                    },
                  },
                },
              },
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
        if (seeded) {
          const err = new Error("seeded session constructor seed must equal its inherited prefix");
          throw err;
        }
        return { events };
      },
      async listEvents() { return events.map((event, index) => ({ type: event.type, seq: index + 1 })); },
      async readEvent({ seq }) { return { target: { ...events[seq - 1], seq } }; },
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
  return { route: routes.find((r) => r.path === "/m/api").handler, dispose };
}

async function request(route, path) {
  const req = new EventEmitter();
  req.url = path; req.method = "GET";
  req.headers = { host: "127.0.0.1", "x-mobile-token": CONFIG.authToken };
  req.socket = { remoteAddress: "127.0.0.1" };
  const res = new EventEmitter();
  let text = "";
  res.headersSent = false;
  res.writeHead = (status) => { res.statusCode = status; res.headersSent = true; };
  res.write = (value) => { text += value; return true; };
  res.end = (value) => { if (value) text += value; res.emit("finish"); };
  const done = new Promise((resolve) => res.once("finish", resolve));
  route(req, res);
  await done;
  return { status: res.statusCode, body: JSON.parse(text || "{}") };
}

test.before(() => {
  root = mkdtempSync(join(tmpdir(), "dormant-model-"));
  process.env.DSH_STORAGE_ROOT = root;
});
test.after(() => {
  delete process.env.DSH_STORAGE_ROOT;
  rmSync(root, { recursive: true, force: true });
});

test("live 会话行为不变：control next 优先，不读 projection lastUsed", async () => {
  writeProjection("live", { provider: "p-proj", model: "m-proj", reasoningEffort: "max" });
  const h = harness({ live: true });
  try {
    const res = await request(h.route, "/m/api/session-config?sessionId=live");
    assert.equal(res.status, 200);
    assert.equal(res.body.config.provider, "p-live");
    assert.equal(res.body.config.model, "m-live");
    assert.equal(res.body.config.reasoningEffort, "low");
  } finally { h.dispose?.(); removeProjection("live"); }
});

test("dormant 会话无 live agent：projection lastUsed 优先于事件/缺省", async () => {
  writeProjection("9702-dormant", { provider: "workbuddy", model: "deepseek-v4.1-flash", reasoningEffort: "max" });
  const h = harness({ events: [{ seq: 1, type: "model/selection", data: { provider: "old", model: "old-model" } }] });
  try {
    const res = await request(h.route, "/m/api/session-config?sessionId=9702-dormant");
    assert.equal(res.status, 200);
    assert.equal(res.body.config.provider, "workbuddy");
    assert.equal(res.body.config.model, "deepseek-v4.1-flash");
    assert.equal(res.body.config.reasoningEffort, "max");
    assert.equal(JSON.stringify(res.body).includes("SECRET_PROMPT_BODY"), false);
    assert.equal(JSON.stringify(res.body).includes("prompt"), false);
  } finally { h.dispose?.(); removeProjection("9702-dormant"); }
});

test("dormant 无 projection / 无模型事件：不伪造父模型", async () => {
  removeProjection("no-model");
  const h = harness({ events: [{ seq: 1, type: "permission/preset", data: { preset: "workspace-write" } }] });
  try {
    const res = await request(h.route, "/m/api/session-config?sessionId=no-model");
    assert.equal(res.status, 200);
    assert.equal(res.body.config.permissionPreset, "workspace-write");
    assert.equal(res.body.config.model, undefined);
    assert.equal(res.body.config.provider, undefined);
    assert.equal(res.body.config.reasoningEffort, undefined);
  } finally { h.dispose?.(); }
});

test("projection 缺失/损坏时回退事件折叠；旧宿主无 sessionQuery 不崩", async () => {
  const bad = projectionFile("bad-projection");
  mkdirSync(join(root, "session_projcache", "sessions"), { recursive: true });
  writeFileSync(bad, "{not-json");
  const h = harness({ events: [{ seq: 2, type: "model/selection", data: { provider: "ev", model: "event-model", reasoningEffort: "medium" } }] });
  try {
    const res = await request(h.route, "/m/api/session-config?sessionId=bad-projection");
    assert.equal(res.body.config.provider, "ev");
    assert.equal(res.body.config.model, "event-model");
    assert.equal(res.body.config.reasoningEffort, "medium");
  } finally { h.dispose?.(); removeProjection("bad-projection"); }

  const old = harness({ noQuery: true });
  try {
    const res = await request(old.route, "/m/api/session-config?sessionId=old-host");
    assert.equal(res.status, 200);
    assert.equal(res.body.config.model, undefined);
  } finally { old.dispose?.(); }
});

test("seeded 核心缺陷路径：listEvents 回退仍工作，projection 缺失不伪装", async () => {
  const h = harness({ seeded: true, events: [{ seq: 1, type: "model/selection", data: { provider: "seeded", model: "seeded-model" } }] });
  try {
    const res = await request(h.route, "/m/api/session-config?sessionId=seeded");
    assert.equal(res.status, 200);
    assert.equal(res.body.config.provider, "seeded");
    assert.equal(res.body.config.model, "seeded-model");
  } finally { h.dispose?.(); }
});
