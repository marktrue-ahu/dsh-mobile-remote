// issue #96 review P2：handler 级旧 GET + bootstrap 与立即 force 共享 in-flight，
// 用慢 npm（每个 view 500ms）验证 15s 兼容路径不会重复出网/超时。

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const PLUGIN = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const PKG = PLUGIN.name;
const VERSION = PLUGIN.version;
const CARRIER_VERSION = `${VERSION}-app`;
const ALIAS = `${PKG}-app`;
const INTEGRITY = "sha512-" + Buffer.from("plugin-integrity").toString("base64");
const CARRIER_INTEGRITY = "sha512-" + Buffer.from("carrier-integrity").toString("base64");

class FakeResponse extends EventEmitter {
  constructor() { super(); this.headersSent = false; this.chunks = []; }
  writeHead(statusCode, headers = {}) { this.statusCode = statusCode; this.headers = headers; this.headersSent = true; }
  write(chunk) { this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return true; }
  end(chunk = "") { if (chunk !== "") this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); this.emit("finish"); }
  destroy() { this.emit("close"); }
}
class FakeRequest extends EventEmitter {
  constructor(url, method = "GET", headers = {}) {
    super(); this.url = url; this.method = method;
    this.headers = { host: "127.0.0.1", "x-mobile-token": TOKEN, ...headers };
    this.socket = { remoteAddress: "127.0.0.1" };
  }
}

function context() {
  const routes = [];
  const services = new Map([
    ["agents", { list: () => [], get: () => undefined }],
    ["sessions", { list: () => [], get: () => undefined }],
  ]);
  const ctx = {
    webServer: { host: "127.0.0.1", port: 43141, register(spec) { routes.push(spec); return () => {}; } },
    logger: { warn() {}, info() {} },
    get(name) { return services.get(name); },
    provide(name, value) { services.set(name, value); },
    on() { return () => {}; },
    effect(cb) { const d = cb?.(); return typeof d === "function" ? d : () => {}; },
    inject() {},
  };
  const dispose = apply(ctx, {
    path: "/m", authToken: TOKEN, cookieName: "dsh_mobile_token", trustedHosts: [],
    sessionTtlMs: 60_000, rechargeUrl: "", maxConnections: 8, pushUrls: [], pushCooldownMs: 60_000,
    doneGraceMs: 1000, pushContent: "minimal", rateLimit: {}, lanBridge: { enabled: false, port: 3080, host: "127.0.0.1" },
    pluginUpdateManifest: "npm",
  });
  return {
    route: routes.find((r) => r.path === "/m/api").handler,
    dispose,
  };
}

async function request(route, path, { method = "GET", body = null } = {}) {
  const headers = {};
  if (body !== null) headers["content-length"] = String(Buffer.byteLength(body));
  const req = new FakeRequest(path, method, headers);
  const res = new FakeResponse();
  const finished = new Promise((resolve) => res.once("finish", resolve));
  route(req, res);
  if (body !== null) process.nextTick(() => { req.emit("data", Buffer.from(body)); req.emit("end"); });
  await finished;
  const text = Buffer.concat(res.chunks).toString("utf8");
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.statusCode, json };
}

test("#96 review handler：慢 npm 下 bootstrap + 立即 force 只跑一轮 npm view，旧 GET 命中缓存", async () => {
  const root = mkdtempSync(join(tmpdir(), "update-check-handler-"));
  const bin = join(root, "bin");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(bin, { recursive: true });
  const counter = join(root, "count");
  writeFileSync(counter, "0");
  const script = join(bin, "npm");
  writeFileSync(script, `#!/bin/sh
echo x >> "${counter}"
/bin/sleep 0.5
case "$2" in
  "${PKG}") echo '{"alpha":"${VERSION}"}' ;;
  "${PKG}@${VERSION}") echo '{"version":"${VERSION}","optionalDependencies":{"${ALIAS}":"npm:${PKG}@${CARRIER_VERSION}"},"dist":{"integrity":"${INTEGRITY}"}}' ;;
  "${PKG}@${CARRIER_VERSION}") echo '{"version":"${CARRIER_VERSION}","dist":{"integrity":"${CARRIER_INTEGRITY}"}}' ;;
  *) echo '{}' ;;
esac
`);
  chmodSync(script, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  const h = context();
  try {
    // bootstrap 触发惰性检查（不阻塞响应）
    const boot = await request(h.route, "/m/api/bootstrap");
    assert.equal(boot.status, 200);
    // 立即 force：必须复用 bootstrap 的 in-flight，而不是再跑 3 次 npm view。
    const post = await request(h.route, "/m/api/plugin-update/check", {
      method: "POST",
      body: JSON.stringify({ force: true }),
    });
    assert.equal(post.status, 200);
    assert.equal(post.json.state, "checking");
    assert.ok(post.json.checkId);
    await new Promise((r) => setTimeout(r, 1800));
    const count = Number(readFileSync(counter, "utf8").trim().split("\n").length);
    assert.equal(count, 3, `bootstrap+force 应只跑 dist-tags+plugin+carrier 共 3 次，实际 ${count}`);
    const status = await request(h.route, `/m/api/plugin-update/check?checkId=${encodeURIComponent(post.json.checkId)}`);
    assert.equal(status.status, 200);
    assert.equal(status.json.state, "done");

    // 旧 GET：缓存命中立即返回（最多再 3 次以内的总计数，不新增一轮）。
    const before = Number(readFileSync(counter, "utf8").trim().split("\n").length);
    const started = Date.now();
    const legacy = await request(h.route, "/m/api/plugin-update/check");
    assert.equal(legacy.status, 200);
    assert.ok(Date.now() - started < 400, "缓存命中旧 GET 应立即返回");
    const after = Number(readFileSync(counter, "utf8").trim().split("\n").length);
    assert.equal(after, before, "旧 GET 缓存命中不得新增 npm view");
  } finally {
    process.env.PATH = oldPath;
    h.dispose?.();
    rmSync(root, { recursive: true, force: true });
  }
});
