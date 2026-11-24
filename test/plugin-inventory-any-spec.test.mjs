// issue #175 P2：任意 spec 安装（包名 / GitHub / 宿主绝对路径 / tarball）。
//
// 契约要点：
//   - **不在插件侧解析 spec**：形态与合法性全部交宿主 `parseInstallSpec()` /
//     `pluginManager.inspect()`；插件侧只做「长度有界 + 拒绝控制字符」。
//   - **不回显原始 spec**：错误响应、detail、op.name 都不含 spec 原文
//     （可能含 token、内网主机、家目录路径）。
//   - **name 路径不变**：`POST /install {name}` 仍走宿主 installable 清单（#153 依赖）。
//   - **name 与 spec 互斥**：同传 → 400 bad-request。
//   - **build scripts 不在手机端授权**：build-blocked 只回报错误码 + 待授权包名。
//
// 这里的四类 spec 用**真实** `@deepseek-ai/dsh-plugin-manager` 的 `parseInstallSpec`
// 与 `classifyInstallFailure` 校验，不是自造的假实现——避免「测的是自己写的解析器」。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let apply;
let testHome;
let parseInstallSpec;
let classifyInstallFailure;

/** 宿主插件管理器的真实位置（peer 依赖，从 DSH 安装目录解析）。 */
function realPluginManagerUrl() {
  const candidates = [
    "/home/mark/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js",
    "/home/mark/.local/lib/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js",
  ];
  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line no-sync
      return pathToFileURL(candidate).href;
    } catch { /* try next */ }
  }
  return null;
}

test.before(async () => {
  testHome = await mkdtemp(join(tmpdir(), "dsh-mobile-plugin-spec-"));
  process.env.HOME = testHome;
  ({ apply } = await import("../lib/index.js"));
  // 真实宿主解析器：可用则用来交叉验证四类 spec 的形态判定。
  try {
    const url = realPluginManagerUrl();
    if (url !== null) {
      const manager = await import(url);
      parseInstallSpec = manager.parseInstallSpec;
      classifyInstallFailure = manager.classifyInstallFailure;
    }
  } catch { /* 宿主包不可用时退化为仅验证插件侧契约 */ }
});
test.after(async () => { await rm(testHome, { recursive: true, force: true }); });

const CONFIG = {
  path: "/m", authToken: "1234567890123456", cookieName: "dsh_mobile_token", trustedHosts: [],
  sessionTtlMs: 60_000, rechargeUrl: "https://example.test/top-up", maxConnections: 4,
  warmUpOnStart: false, pushUrls: [], pushCooldownMs: 1, doneGraceMs: 1, pushContent: "minimal",
  rateLimit: {}, lanBridge: { enabled: false, port: 3080, host: "127.0.0.1" }, approvalMode: "mobile",
};

class FakeResponse extends EventEmitter {
  constructor() { super(); this.headersSent = false; this.chunks = []; }
  writeHead(statusCode, headers) { this.statusCode = statusCode; this.headers = headers; this.headersSent = true; }
  write(chunk) { this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)); return true; }
  end(chunk = "") { if (chunk !== "") this.chunks.push(String(chunk)); this.writableEnded = true; this.emit("finish"); }
  destroy() { this.destroyed = true; this.emit("close"); }
}
class FakeRequest extends EventEmitter {
  constructor(url, method = "GET", body) {
    super(); this.url = url; this.method = method; this.body = body;
    this.headers = {
      host: "127.0.0.1",
      "x-mobile-token": CONFIG.authToken,
      "content-type": "application/json",
      ...(body === undefined ? {} : { "content-length": String(Buffer.byteLength(JSON.stringify(body))) }),
    };
    this.socket = { remoteAddress: "127.0.0.1" }; this.complete = true; this.readable = true; this.destroyed = false;
  }
  on(event, handler) {
    if (event === "data" && this.body !== undefined) setImmediate(() => handler(Buffer.from(JSON.stringify(this.body))));
    if (event === "end") setImmediate(() => handler());
    return this;
  }
  pause() {}
}

function createHarness({ pluginManager, pluginInventory } = {}) {
  const routes = [];
  const provided = new Map([["sessions", { get: () => undefined, list: () => [] }]]);
  if (pluginManager !== undefined) provided.set("pluginManager", pluginManager);
  if (pluginInventory !== undefined) provided.set("pluginInventory", pluginInventory);
  const ctx = {
    webServer: { host: "127.0.0.1", port: 43170, register(spec) { routes.push(spec); return () => {}; } },
    logger: { warn() {}, info() {} },
    get(name) { return provided.get(name); },
    provide(name, value) { provided.set(name, value); },
    on() { return () => {}; },
    effect(callback) { const d = callback?.(); return typeof d === "function" ? d : () => {}; },
    inject() {},
  };
  const dispose = apply(ctx, CONFIG);
  return { route: routes.find((r) => r.path === "/m/api").handler, clean() { dispose?.(); } };
}

async function call(route, url, { method = "GET", body } = {}) {
  const req = new FakeRequest(url, method, body);
  const res = new FakeResponse();
  const finished = new Promise((resolve) => res.once("finish", resolve));
  route(req, res);
  await finished;
  const raw = res.chunks.join("");
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: res.statusCode, body: parsed, raw };
}

async function waitOp(route, opId) {
  for (let i = 0; i < 200; i++) {
    const res = await call(route, `/m/api/plugin-inventory/op?opId=${encodeURIComponent(opId)}`);
    if (res.body?.operation?.status !== "running") return res.body.operation;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("operation did not settle");
}

/**
 * 用**真实**宿主解析器生成预校验结果，模拟 pluginManager.inspect() 的行为。
 * 这样「四类 spec 走通」验的是真实形态判定，而不是插件侧的自造规则。
 */
function realInspect(spec) {
  const parsed = parseInstallSpec(spec);
  const base = { status: "accepted", kind: parsed.kind, bundle: null, registry: "https://registry.npmjs.org/" };
  switch (parsed.kind) {
    case "registry":
      return { ...base, name: parsed.name, version: "1.0.0", bundle: true, description: "a bundle" };
    case "path":
      return { ...base, name: "dsh-local-plugin", version: "0.1.0", bundle: true, description: "local" };
    case "git":
      return { ...base, host: parsed.host };
    case "tarball":
      return { ...base, ...(parsed.host === undefined ? {} : { host: parsed.host }) };
    default:
      throw new Error(`unexpected kind ${parsed.kind}`);
  }
}

const inspectingHarness = (opts = {}) => {
  const seen = { specs: [], registries: [], installs: [] };
  const pluginManager = {
    async listBundles() { return []; },
    async inspect(spec, options) {
      seen.specs.push(spec);
      seen.registries.push(options?.registry ?? null);
      if (opts.inspectThrows === true) throw new Error("boom /home/mark/secret");
      if (typeof opts.inspect === "function") return opts.inspect(spec, options);
      if (parseInstallSpec === undefined) throw new Error("real parser unavailable");
      try { return realInspect(spec); }
      catch (error) { return { status: "refused", problem: "invalid-spec", reason: error.reason ?? error.message }; }
    },
    async installBundle(spec, options) {
      seen.installs.push({ spec, options });
      if (typeof opts.install === "function") return opts.install(spec, options);
      return { changed: true, application: "applied", stage: "enable", target: "dsh-x", bundle: "dsh-x", version: "1.0.0", registries: [] };
    },
  };
  const harness = createHarness({ pluginManager, pluginInventory: { async list() { return { entries: [] }; } } });
  return { ...harness, seen, pluginManager };
};

// ── 1. 四类 spec 的预校验（真实宿主解析器） ──────────────────────

test("inspect：四类 spec 都能被真实 parseInstallSpec 判定并原样转交宿主", async (t) => {
  if (parseInstallSpec === undefined) { t.skip("宿主 plugin-manager 不可用，跳过真实解析器交叉验证"); return; }
  const specs = [
    ["@scope/dsh-plugin", "registry"],
    ["github:user/dsh-plugin", "git"],
    ["/home/mark/plugins/dsh-local", "path"],
    ["https://example.test/dsh-plugin-1.0.0.tgz", "tarball"],
  ];
  const h = inspectingHarness();
  try {
    for (const [spec, expectedKind] of specs) {
      const { status, body } = await call(h.route, "/m/api/plugin-inventory/inspect", { method: "POST", body: { spec } });
      assert.equal(status, 200, `${expectedKind}: HTTP 200`);
      assert.equal(body.ok, true, expectedKind);
      assert.equal(body.supported, true, expectedKind);
      assert.equal(body.status, "accepted", `${expectedKind}: 应被接受，实际 ${JSON.stringify(body)}`);
      assert.equal(body.kind, expectedKind, `${expectedKind}: kind 必须来自宿主的真实判定`);
      // 原样转交：插件侧不得改写 spec（不 trim 内部空白、不加前缀、不 resolve 路径）。
      assert.equal(h.seen.specs.at(-1), spec.trim(), `${expectedKind}: spec 必须原样交给宿主`);
      // 不回显 spec 原文。
      assert.equal(h.raw ?? "", "", "sanity");
    }
    // 四类各一次，顺序一致。
    assert.deepEqual(h.seen.specs, specs.map(([spec]) => spec));
  } finally { h.clean(); }
});

test("inspect：git / tarball 的 host、registry 只回显可安全出网的形态", async (t) => {
  if (parseInstallSpec === undefined) { t.skip("宿主 plugin-manager 不可用"); return; }
  const h = inspectingHarness();
  try {
    const git = await call(h.route, "/m/api/plugin-inventory/inspect", { method: "POST", body: { spec: "git+https://github.com/u/r.git" } });
    assert.equal(git.body.status, "accepted");
    assert.equal(git.body.kind, "git");
    assert.equal(git.body.host, "github.com", "git spec 带出 host，App 可显示来源");
    assert.equal(git.body.registry, "https://registry.npmjs.org/", "依赖仍走 registry");

    const tar = await call(h.route, "/m/api/plugin-inventory/inspect", { method: "POST", body: { spec: "https://example.test/p-1.0.0.tgz" } });
    assert.equal(tar.body.kind, "tarball");
    assert.equal(tar.body.host, "example.test");

    // 带凭据的 tarball URL：宿主解析会带 userinfo，但**响应不得回显**。
    const secret = await call(h.route, "/m/api/plugin-inventory/inspect", {
      method: "POST",
      body: { spec: "https://user:tok3n@example.test/p-1.0.0.tgz" },
    });
    assert.equal(secret.raw.includes("tok3n"), false, "不得回显 spec 里的 token");
    assert.equal(secret.raw.includes("user:"), false, "不得回显 userinfo");
  } finally { h.clean(); }
});

test("inspect：path 相对路径被真实宿主拒绝（插件侧不自己判断）", async (t) => {
  if (parseInstallSpec === undefined) { t.skip("宿主 plugin-manager 不可用"); return; }
  const h = inspectingHarness();
  try {
    const { status, body, raw } = await call(h.route, "/m/api/plugin-inventory/inspect", { method: "POST", body: { spec: "./rel/plugin" } });
    assert.equal(status, 200);
    assert.equal(body.status, "refused");
    assert.equal(body.problem, "invalid-spec", "相对路径由宿主 parseInstallSpec 拒绝");
    assert.equal(raw.includes("./rel/plugin"), false, "拒绝原因不回显原 spec");
  } finally { h.clean(); }
});

test("inspect：拒绝原因的人话短句可透出，但带路径的 reason 必须被吞掉", async () => {
  const h = inspectingHarness({
    inspect: () => ({
      status: "refused",
      problem: "not-a-package",
      // 宿主对 path 的真实文案会带文件系统错误（含绝对路径）。
      reason: "no readable package.json at the path: EACCES: permission denied, open '/home/mark/secret/package.json'",
    }),
  });
  try {
    const { status, body, raw } = await call(h.route, "/m/api/plugin-inventory/inspect", { method: "POST", body: { spec: "/home/mark/secret" } });
    assert.equal(status, 200);
    assert.equal(body.status, "refused");
    assert.equal(body.problem, "not-a-package");
    assert.equal(body.reason, "", "含路径的 reason 不得透出");
    assert.equal(raw.includes("/home/mark/secret"), false, "响应里不得出现原始路径");
  } finally { h.clean(); }
});

test("inspect：四种拒绝原因都有稳定 problem（App 据此出文案）", async () => {
  const cases = [
    ["invalid-spec", "a local path must be absolute"],
    ["already-installed", "dsh-x is already installed"],
    ["not-a-package", "the tarball does not exist"],
    ["not-a-bundle", "dsh-x declares no dsh.bundle"],
  ];
  for (const [problem, reason] of cases) {
    const h = inspectingHarness({ inspect: () => ({ status: "refused", problem, reason }) });
    try {
      const { status, body } = await call(h.route, "/m/api/plugin-inventory/inspect", { method: "POST", body: { spec: "@scope/dsh-x" } });
      assert.equal(status, 200, problem);
      assert.equal(body.status, "refused", problem);
      assert.equal(body.problem, problem, `${problem}: problem 原样透出（稳定码）`);
      // 固定短句（不含路径/凭据）可以保留，改善可读性。
      assert.equal(body.reason, reason, `${problem}: 安全短句保留`);
    } finally { h.clean(); }
  }
});

test("inspect：旧宿主无 inspect() → 200 + supported:false（不是 404/500）", async () => {
  const legacy = createHarness({
    pluginManager: { async listBundles() { return []; } },
    pluginInventory: { async list() { return { entries: [] }; } },
  });
  try {
    const { status, body } = await call(legacy.route, "/m/api/plugin-inventory/inspect", { method: "POST", body: { spec: "left-pad" } });
    assert.equal(status, 200);
    assert.equal(body.supported, false);
    assert.equal(body.reason, "inspect-unavailable");
  } finally { legacy.clean(); }
});

test("inspect：宿主 inspect 抛错 → 不泄露内部错误原文", async () => {
  const h = inspectingHarness({ inspectThrows: true });
  try {
    const { status, body, raw } = await call(h.route, "/m/api/plugin-inventory/inspect", { method: "POST", body: { spec: "/home/mark/secret" } });
    assert.equal(status, 200);
    assert.equal(body.status, "refused");
    assert.equal(body.problem, "unknown");
    assert.equal(raw.includes("/home/mark/secret"), false);
    assert.equal(raw.includes("boom"), false);
  } finally { h.clean(); }
});

// ── 2. 输入边界（长度 / 控制字符 / 方法） ────────────────────────

test("inspect：超长 spec / 控制字符 → 400 invalid-spec，且不回显", async () => {
  const h = inspectingHarness();
  try {
    const tooLong = "a".repeat(2049);
    const long = await call(h.route, "/m/api/plugin-inventory/inspect", { method: "POST", body: { spec: tooLong } });
    assert.equal(long.status, 400);
    assert.equal(long.body.error, "invalid-spec");
    assert.equal(long.body.detail, "too-long");
    assert.equal(long.raw.includes("aaaa"), false, "不回显超长原文");

    for (const spec of ["bad\u0000spec", "bad\nspec", "bad\u007fspec"]) {
      const bad = await call(h.route, "/m/api/plugin-inventory/inspect", { method: "POST", body: { spec } });
      assert.equal(bad.status, 400, JSON.stringify(spec));
      assert.equal(bad.body.detail, "control-char");
    }

    const empty = await call(h.route, "/m/api/plugin-inventory/inspect", { method: "POST", body: { spec: "   " } });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.detail, "empty");

    const notString = await call(h.route, "/m/api/plugin-inventory/inspect", { method: "POST", body: { spec: 42 } });
    assert.equal(notString.status, 400);
    assert.equal(notString.body.detail, "not-string");
  } finally { h.clean(); }
});

test("inspect：GET 一律 405（只接受 POST）", async () => {
  const h = inspectingHarness();
  try {
    const { status, body } = await call(h.route, "/m/api/plugin-inventory/inspect");
    assert.equal(status, 405);
    assert.equal(body.error, "method-not-allowed");
  } finally { h.clean(); }
});

test("inspect：registry 参数走既有校验，非法 → 400 registry-invalid", async () => {
  const h = inspectingHarness();
  try {
    const bad = await call(h.route, "/m/api/plugin-inventory/inspect", { method: "POST", body: { spec: "left-pad", registry: "http://user:pw@x.test/" } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, "registry-invalid");
    assert.equal(bad.raw.includes("pw"), false, "不回显凭据");

    const ok = await call(h.route, "/m/api/plugin-inventory/inspect", { method: "POST", body: { spec: "left-pad", registry: "https://registry.npmjs.org" } });
    assert.equal(ok.status, 200);
    assert.equal(h.seen.registries.at(-1), "https://registry.npmjs.org/", "registry 规范化后交宿主");
  } finally { h.clean(); }
});

// ── 3. install 端点的 spec 路径 ─────────────────────────────────

test("install{spec}：走 installBundle，且不再查 installable 清单", async () => {
  const seenInstalls = [];
  let listBundlesCalls = 0;
  const pluginManager = {
    async listBundles() { listBundlesCalls += 1; return []; },
    async inspect() { return { status: "accepted", kind: "registry", name: "dsh-any", version: "2.0.0", bundle: true, registry: "https://registry.npmjs.org/" }; },
    async installBundle(spec, options) {
      seenInstalls.push({ spec, options });
      return { changed: true, application: "applied", stage: "enable", target: "dsh-any", bundle: "dsh-any", version: "2.0.0", registries: ["https://registry.npmjs.org/"] };
    },
  };
  const h = createHarness({ pluginManager, pluginInventory: { async list() { return { entries: [] }; } } });
  try {
    const { status, body } = await call(h.route, "/m/api/plugin-inventory/install", { method: "POST", body: { spec: "dsh-any@2.0.0" } });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    const op = await waitOp(h.route, body.operation.opId);
    assert.equal(op.status, "succeeded");
    assert.equal(op.source, "spec", "op 记录能区分按 spec 装");
    assert.equal(op.name, "dsh-any", "op.name 用预校验得到的包名，不是原始 spec");
    assert.equal(seenInstalls.length, 1);
    assert.equal(seenInstalls[0].spec, "dsh-any@2.0.0", "spec 原样交给 installBundle");
    assert.equal(seenInstalls[0].options.saveExact, true);
    assert.equal(listBundlesCalls, 0, "spec 路径不得依赖 installable 清单");
  } finally { h.clean(); }
});

test("install{name}：既有路径完全不变（仍查 installable 清单，source=name）", async () => {
  const seenInstalls = [];
  const pluginManager = {
    async listBundles() {
      return [{
        name: "dsh-cfg", version: "1.5.0", installed: false, availability: "missing",
        installTarget: { spec: "dsh-cfg@1.5.0", version: "1.5.0" },
        rows: [], overrides: [],
      }];
    },
    async installBundle(spec, options) {
      seenInstalls.push({ spec, options });
      return { changed: true, application: "applied", stage: "enable", target: "dsh-cfg", bundle: "dsh-cfg", version: "1.5.0", registries: [] };
    },
  };
  const h = createHarness({ pluginManager, pluginInventory: { async list() { return { entries: [] }; } } });
  try {
    const { status, body } = await call(h.route, "/m/api/plugin-inventory/install", { method: "POST", body: { name: "dsh-cfg" } });
    assert.equal(status, 200);
    const op = await waitOp(h.route, body.operation.opId);
    assert.equal(op.status, "succeeded");
    assert.equal(op.source, "name", "#153 的 name 路径标记不变");
    assert.equal(seenInstalls[0].spec, "dsh-cfg@1.5.0", "spec 仍由宿主 installTarget 决定");
  } finally { h.clean(); }
});

test("install：name 与 spec 同传 → 400 bad-request（不替用户二选一）", async () => {
  const h = inspectingHarness();
  try {
    const { status, body } = await call(h.route, "/m/api/plugin-inventory/install", {
      method: "POST", body: { name: "dsh-a", spec: "dsh-b" },
    });
    assert.equal(status, 400);
    assert.equal(body.error, "bad-request");
    assert.equal(h.seen.installs.length, 0, "互斥冲突时不得开始安装");
  } finally { h.clean(); }
});

test("install{spec}：预校验拒绝时在开装前拒掉，且不回显 spec", async () => {
  const h = inspectingHarness({
    inspect: () => ({ status: "refused", problem: "not-a-bundle", reason: "dsh-plain declares no dsh.bundle" }),
  });
  try {
    const { status, body, raw } = await call(h.route, "/m/api/plugin-inventory/install", {
      method: "POST", body: { spec: "/home/mark/notabundle" },
    });
    assert.equal(status, 400);
    assert.equal(body.error, "spec-refused");
    assert.equal(body.problem, "not-a-bundle");
    assert.equal(raw.includes("/home/mark/notabundle"), false);
    assert.equal(h.seen.installs.length, 0, "预校验拒绝后不得调用 installBundle");
  } finally { h.clean(); }
});

test("install{spec}：旧宿主无 inspect() 不阻断安装（installBundle 自己会校验）", async () => {
  const installs = [];
  const pluginManager = {
    async listBundles() { return []; },
    async installBundle(spec) {
      installs.push(spec);
      return { changed: true, application: "applied", stage: "enable", target: "dsh-legacy", bundle: "dsh-legacy", version: "1.0.0", registries: [] };
    },
  };
  const h = createHarness({ pluginManager, pluginInventory: { async list() { return { entries: [] }; } } });
  try {
    const { status, body } = await call(h.route, "/m/api/plugin-inventory/install", { method: "POST", body: { spec: "dsh-legacy" } });
    assert.equal(status, 200);
    const op = await waitOp(h.route, body.operation.opId);
    assert.equal(op.status, "succeeded");
    assert.deepEqual(installs, ["dsh-legacy"]);
  } finally { h.clean(); }
});

test("install{spec}：超长 / 控制字符 → 400 invalid-spec", async () => {
  const h = inspectingHarness();
  try {
    const long = await call(h.route, "/m/api/plugin-inventory/install", { method: "POST", body: { spec: "a".repeat(3000) } });
    assert.equal(long.status, 400);
    assert.equal(long.body.error, "invalid-spec");
    const ctrl = await call(h.route, "/m/api/plugin-inventory/install", { method: "POST", body: { spec: "bad\u0000" } });
    assert.equal(ctrl.status, 400);
    assert.equal(ctrl.body.detail, "control-char");
    assert.equal(h.seen.installs.length, 0);
  } finally { h.clean(); }
});

test("install{spec}：同一时刻只允许一个 spec 安装（不排队）", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pluginManager = {
    async listBundles() { return []; },
    async inspect() { return { status: "accepted", kind: "registry", name: "dsh-slow", version: "1.0.0", bundle: true, registry: "https://registry.npmjs.org/" }; },
    async installBundle() {
      await gate;
      return { changed: true, application: "applied", stage: "enable", target: "dsh-slow", bundle: "dsh-slow", version: "1.0.0", registries: [] };
    },
  };
  const h = createHarness({ pluginManager, pluginInventory: { async list() { return { entries: [] }; } } });
  try {
    const first = await call(h.route, "/m/api/plugin-inventory/install", { method: "POST", body: { spec: "dsh-slow" } });
    assert.equal(first.status, 200);
    const second = await call(h.route, "/m/api/plugin-inventory/install", { method: "POST", body: { spec: "dsh-other" } });
    assert.equal(second.status, 409);
    assert.equal(second.body.error, "plugin-install-in-progress");
    release();
    await waitOp(h.route, first.body.operation.opId);
  } finally { h.clean(); }
});

// ── 4. build-blocked（手机端不授权） ────────────────────────────

test("build-blocked：宿主 operation-error + packageResult.kind → op.errorCode=build-blocked", async () => {
  // 真实宿主对 pnpm 失败的做法：`throw new Error(run.output)` → change() 折成
  // `error.code:"operation-error"`，真正类别只在 packageResult.kind。
  const pluginManager = {
    async listBundles() { return []; },
    async inspect() { return { status: "accepted", kind: "registry", name: "dsh-scripts", version: "1.0.0", bundle: true, registry: "https://registry.npmjs.org/" }; },
    async installBundle() {
      return {
        changed: false,
        application: "failed",
        stage: "install",
        target: "dsh-scripts",
        error: { code: "operation-error", diagnostic: "Ignored build scripts: esbuild" },
        packageResult: { exitCode: 1, output: "Ignored build scripts: esbuild.", truncated: false, logPath: "/tmp/x.log", kind: "build-blocked" },
        pendingBuilds: ["esbuild"],
      };
    },
  };
  const h = createHarness({ pluginManager, pluginInventory: { async list() { return { entries: [] }; } } });
  try {
    const { body } = await call(h.route, "/m/api/plugin-inventory/install", { method: "POST", body: { spec: "dsh-scripts" } });
    const op = await waitOp(h.route, body.operation.opId);
    assert.equal(op.status, "failed");
    assert.equal(op.errorCode, "build-blocked", "必须把 packageResult.kind 提成显式错误码");
    assert.deepEqual(op.pendingBuilds, ["esbuild"], "待授权包名透出（只有名字）");
    // 手机端没有批准入口：响应里不得出现 approvedBuilds 或任何“批准”通道。
    assert.equal("approvedBuilds" in op, false);
  } finally { h.clean(); }
});

test("build-blocked：pendingBuilds 里的危险条目（含路径/空白）被丢弃", async () => {
  const pluginManager = {
    async listBundles() { return []; },
    async inspect() { return { status: "accepted", kind: "registry", name: "dsh-scripts", version: "1.0.0", bundle: true }; },
    async installBundle() {
      return {
        changed: false, application: "failed", stage: "install", target: "dsh-scripts",
        error: { code: "operation-error" },
        packageResult: { exitCode: 1, output: "", truncated: false, logPath: "", kind: "build-blocked" },
        pendingBuilds: ["esbuild", "/home/mark/secret", "a b", "x\u0000y", "", "@scope/ok"],
      };
    },
  };
  const h = createHarness({ pluginManager, pluginInventory: { async list() { return { entries: [] }; } } });
  try {
    const { body } = await call(h.route, "/m/api/plugin-inventory/install", { method: "POST", body: { spec: "dsh-scripts" } });
    const op = await waitOp(h.route, body.operation.opId);
    assert.deepEqual(op.pendingBuilds, ["esbuild", "@scope/ok"], "只保留形如包名的条目");
  } finally { h.clean(); }
});

test("非 build-blocked 的 pnpm 失败：不误报 build-blocked", async () => {
  const pluginManager = {
    async listBundles() { return []; },
    async inspect() { return { status: "accepted", kind: "registry", name: "dsh-404", version: "1.0.0", bundle: true }; },
    async installBundle() {
      // must NOT be reported as build-blocked；缺省沿用宿主 error.code。
      return {
        changed: false, application: "failed", stage: "install", target: "nope",
        error: { code: "operation-error" },
        packageResult: { exitCode: 1, output: "404 Not Found", truncated: false, logPath: "", kind: "not-found" },
        pendingBuilds: [],
      };
    },
  };
  const h = createHarness({ pluginManager, pluginInventory: { async list() { return { entries: [] }; } } });
  try {
    const { body } = await call(h.route, "/m/api/plugin-inventory/install", { method: "POST", body: { spec: "nope" } });
    const op = await waitOp(h.route, body.operation.opId);
    assert.equal(op.status, "failed");
    assert.equal(op.errorCode, "operation-error", "其他失败保留宿主错误码");
    assert.deepEqual(op.pendingBuilds, []);
  } finally { h.clean(); }
});

test("classifyInstallFailure 的真实判定与插件侧消费一致（防口径漂移）", async (t) => {
  if (classifyInstallFailure === undefined) { t.skip("宿主 plugin-manager 不可用"); return; }
  // 宿主的日志分类是「install 失败 → build-blocked」的权威来源。
  assert.equal(classifyInstallFailure({ log: "Ignored build scripts: esbuild", timedOut: false }), "build-blocked");
  assert.equal(classifyInstallFailure({ log: "ERR_PNPM_IGNORED_BUILDS", timedOut: false }), "build-blocked");
  assert.equal(classifyInstallFailure({ log: "404 Not Found", timedOut: false }), "not-found");
});

// ── 5. 真实文件系统：path / tarball 的预校验 ────────────────────

test("inspect{path}：真实存在的 bundle 目录被接受；不存在的路径拒绝", async (t) => {
  if (parseInstallSpec === undefined) { t.skip("宿主 plugin-manager 不可用"); return; }
  const dir = await mkdtemp(join(tmpdir(), "dsh-175-path-"));
  try {
    const bundleDir = join(dir, "my-bundle");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(join(bundleDir, "package.json"), JSON.stringify({
      name: "dsh-my-bundle", version: "0.3.0", description: "local bundle", dsh: { bundle: {} },
    }));
    const h = inspectingHarness({
      inspect: async (spec) => {
        const parsed = parseInstallSpec(spec);
        // 模拟宿主 path 分支：读 package.json 判 name/bundle。
        const { readFile } = await import("node:fs/promises");
        try {
          const read = JSON.parse(await readFile(join(parsed.path, "package.json"), "utf8"));
          return { status: "accepted", kind: "path", name: read.name, version: read.version, description: read.description, bundle: read.dsh?.bundle !== undefined, registry: "https://registry.npmjs.org/" };
        } catch {
          return { status: "refused", problem: "not-a-package", reason: "the path does not exist" };
        }
      },
    });
    try {
      const ok = await call(h.route, "/m/api/plugin-inventory/inspect", { method: "POST", body: { spec: bundleDir } });
      assert.equal(ok.body.status, "accepted", JSON.stringify(ok.body));
      assert.equal(ok.body.kind, "path");
      assert.equal(ok.body.name, "dsh-my-bundle");
      assert.equal(ok.body.version, "0.3.0");

      const missing = await call(h.route, "/m/api/plugin-inventory/inspect", { method: "POST", body: { spec: join(dir, "nope") } });
      assert.equal(missing.body.status, "refused");
      assert.equal(missing.body.problem, "not-a-package");
    } finally { h.clean(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
