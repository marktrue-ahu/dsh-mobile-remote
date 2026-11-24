// issue #175 P3：插件市场索引（CRUD）+ 搜索 + SSRF 防护。
//
// 本文件的重心是 **SSRF 负例**：`search(url)` 会真的去抓那个 URL，所以 `url` 必须
// 命中宿主当前已配置的索引列表；否则等于把手机输入直接交给 fetch（可被用来探测内网、
// 读取内网服务响应、或让电脑端代打请求）。
//
// 其它契约：
//   - 索引是**电脑端配置**（写操作走 `pluginMarket.setIndexes` → `settings.update`）；
//   - 索引 URL 校验只 http(s)、无凭据/fragment/query、无控制字符、长度有界、数量 ≤ 8；
//   - **不补尾斜杠**（与 registry 的 normalizeRegistry 语义不同）；
//   - 老宿主无 `pluginMarket` → 200 + supported:false（写 409）。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let apply;
let testHome;

test.before(async () => {
  testHome = await mkdtemp(join(tmpdir(), "dsh-mobile-plugin-market-"));
  process.env.HOME = testHome;
  ({ apply } = await import("../lib/index.js"));
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

function createHarness({ pluginMarket, settings } = {}) {
  const routes = [];
  const provided = new Map([["sessions", { get: () => undefined, list: () => [] }]]);
  if (pluginMarket !== undefined) provided.set("pluginMarket", pluginMarket);
  // 默认给一个可写的 settings 替身（宿主 setIndexes 需要 settings.update）。
  provided.set("settings", settings ?? { async update() { return {}; } });
  const ctx = {
    webServer: { host: "127.0.0.1", port: 43180, register(spec) { routes.push(spec); return () => {}; } },
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

/**
 * 假的市场服务：索引列表可写、`search` 记录被调用的 URL。
 *
 * **关键**：`search` 只记录，不真发请求；SSRF 防护由插件侧保证，
 * 因此如果插件侧漏校验，这里的 `searchCalls` 就会记录到未配置的 URL → 测试直接抓到。
 */
function fakeMarket(initialIndexes = []) {
  let indexes = initialIndexes.map((url) => (typeof url === "string" ? { url } : url));
  const state = { searchCalls: [], setCalls: [], fetchCount: 0 };
  return {
    state,
    get indexes() { return indexes; },
    listIndexes() { return indexes.map((row) => ({ ...row })); },
    async setIndexes(urls) {
      state.setCalls.push([...urls]);
      indexes = urls.map((url) => ({ url }));
    },
    async search(url, query) {
      state.searchCalls.push({ url, query });
      state.fetchCount += 1;
      return {
        url,
        title: 'Test index',
        description: 'an index',
        metadata: { anything: '请勿透出' },
        fetchedAt: 1700000000000,
        entries: [{
          name: 'dsh-market-plugin',
          title: 'Market plugin',
          description: 'from the market',
          category: 'custom',
          labels: ['a'],
          defaultVersion: '1.2.0',
          installation: { status: 'not-installed' },
          versions: [{
            version: '1.2.0',
            prerelease: false,
            deprecated: '',
            install: { spec: 'dsh-market-plugin@1.2.0', registry: 'https://registry.npmjs.org/' },
            compatibility: { compatible: true, requirements: {} },
            update: false,
          }],
        }],
        total: 1,
        nextOffset: null,
      };
    },
  };
}

// ── 1. 索引读 ──────────────────────────────────────────────────

test("GET market/indexes：透传 listIndexes，writable 按运行时探测", async () => {
  const market = fakeMarket([
    { url: 'https://example.test/index.json', title: 'Official', description: 'the index' },
    { url: 'https://broken.test/index.json', error: 'Index URL is not in canonical form' },
  ]);
  const h = createHarness({ pluginMarket: market });
  try {
    const { status, body } = await call(h.route, "/m/api/plugin-inventory/market/indexes");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.supported, true);
    assert.equal(body.writable, true, '有 setIndexes + settings.update → 可写');
    assert.equal(body.indexes.length, 2);
    assert.equal(body.indexes[0].url, 'https://example.test/index.json');
    assert.equal(body.indexes[0].title, 'Official');
    assert.equal(body.indexes[0].error, '', '无错误时为空串（不是缺字段）');
    assert.equal(body.indexes[1].error, 'Index URL is not in canonical form', '索引 error 如实透出');
    assert.equal(body.defaults.count, 1, '可用索引数（无 error）');
  } finally { h.clean(); }
});

test("GET market/indexes：老宿主无 pluginMarket → 200 + supported:false（不是 404/500）", async () => {
  const h = createHarness({});
  try {
    const { status, body } = await call(h.route, "/m/api/plugin-inventory/market/indexes");
    assert.equal(status, 200);
    assert.equal(body.supported, false);
    assert.equal(body.writable, false);
    assert.deepEqual(body.indexes, []);
    assert.equal(body.reason, 'plugin-market-unavailable');
  } finally { h.clean(); }
});

test("GET market/indexes：listIndexes 抛错 → 仍 200 + supported:false（降级不 500）", async () => {
  const market = {
    listIndexes() { throw new Error('boom /home/mark/secret'); },
    async setIndexes() {},
    async search() { throw new Error('unused'); },
  };
  const h = createHarness({ pluginMarket: market });
  try {
    const { status, body, raw } = await call(h.route, "/m/api/plugin-inventory/market/indexes");
    assert.equal(status, 200);
    assert.equal(body.supported, false);
    assert.equal(raw.includes('/home/mark/secret'), false);
    assert.equal(raw.includes('boom'), false);
  } finally { h.clean(); }
});

test("GET market/indexes：无 setIndexes → writable:false，但读仍可用", async () => {
  const market = {
    listIndexes() { return [{ url: 'https://example.test/index.json' }]; },
    async search() { throw new Error('unused'); },
  };
  const h = createHarness({ pluginMarket: market });
  try {
    const { body } = await call(h.route, "/m/api/plugin-inventory/market/indexes");
    assert.equal(body.supported, true);
    assert.equal(body.writable, false);
    assert.equal(body.reason, 'settings-write-unavailable');
  } finally { h.clean(); }
});

test("GET market/indexes：无 settings 服务 → writable:false（宿主 setIndexes 会抛 settings-unavailable）", async () => {
  const market = fakeMarket([{ url: 'https://example.test/index.json' }]);
  const h = createHarness({ pluginMarket: market });
  // 覆盖成「没有 settings」：createHarness 默认注入，这里换掉。
  try {
    // 直接调用端点即可：settings 存在但缺少 update 也应判不可写。
    const h2 = createHarness({ pluginMarket: market, settings: { update: undefined } });
    try {
      const { body } = await call(h2.route, "/m/api/plugin-inventory/market/indexes");
      assert.equal(body.writable, false, 'settings.update 不是函数 → 不可写');
    } finally { h2.clean(); }
  } finally { h.clean(); }
});

// ── 2. 索引写（CRUD） ───────────────────────────────────────────

test("POST market/indexes：写入后 GET 反映新值（不乐观回显入参，回读宿主）", async () => {
  const market = fakeMarket([]);
  const h = createHarness({ pluginMarket: market });
  try {
    const urls = ['https://a.test/index.json', 'https://b.test/sub/index.json'];
    const write = await call(h.route, "/m/api/plugin-inventory/market/indexes", { method: "POST", body: { urls } });
    assert.equal(write.status, 200);
    assert.equal(write.body.ok, true);
    assert.deepEqual(market.state.setCalls, [urls], '原样交给宿主 setIndexes');
    assert.deepEqual(write.body.indexes.map((row) => row.url), urls, '回读宿主实际值');

    const read = await call(h.route, "/m/api/plugin-inventory/market/indexes");
    assert.deepEqual(read.body.indexes.map((row) => row.url), urls, '保存后 GET 反映新值');
  } finally { h.clean(); }
});

test("POST market/indexes：去重保序（规范化后比较）", async () => {
  const market = fakeMarket([]);
  const h = createHarness({ pluginMarket: market });
  try {
    const { status, body } = await call(h.route, "/m/api/plugin-inventory/market/indexes", {
      method: "POST",
      body: { urls: ['https://a.test/x', 'https://a.test/x', 'https://b.test/y', 'https://a.test/x'] },
    });
    assert.equal(status, 200);
    assert.deepEqual(market.state.setCalls[0], ['https://a.test/x', 'https://b.test/y'], '去重且保序');
    assert.equal(body.ok, true);
  } finally { h.clean(); }
});

test("POST market/indexes：**不补尾斜杠**（与 registry 语义不同）", async () => {
  const market = fakeMarket([]);
  const h = createHarness({ pluginMarket: market });
  try {
    await call(h.route, "/m/api/plugin-inventory/market/indexes", {
      method: "POST",
      body: { urls: ['https://example.test/plugins/index.json'] },
    });
    assert.deepEqual(
      market.state.setCalls[0],
      ['https://example.test/plugins/index.json'],
      '索引 URL 的路径必须原样保留，不能补斜杠',
    );
  } finally { h.clean(); }
});

test("POST market/indexes：非法 URL 被拒且分类准确，不回显原文", async () => {
  const cases = [
    ['file:///etc/passwd', 'unsupported-protocol'],
    ['ftp://example.test/index.json', 'unsupported-protocol'],
    ['https://user:pw@example.test/index.json', 'has-credentials'],
    ['https://example.test/index.json#frag', 'has-fragment'],
    ['https://example.test/index.json?token=abc', 'has-query'],
    ['/relative/index.json', 'unparsable'],
    ['not a url', 'whitespace'],
    ['', 'empty'],
    ['https://example.test/' + 'a'.repeat(2048), 'too-long'],
    ['https://exa\u0000mple.test/', 'control-char'],
  ];
  for (const [bad, detail] of cases) {
    const market = fakeMarket([]);
    const h = createHarness({ pluginMarket: market });
    try {
      const { status, body, raw } = await call(h.route, "/m/api/plugin-inventory/market/indexes", {
        method: "POST",
        body: { urls: [bad] },
      });
      assert.equal(status, 400, `${detail}: ${JSON.stringify(bad)}`);
      assert.equal(body.error, 'index-invalid', detail);
      assert.equal(body.detail, detail, `${JSON.stringify(bad)} → ${detail}`);
      assert.equal(body.index, 0, '指出第一个出错的序号');
      assert.equal(market.state.setCalls.length, 0, `${detail}: 校验失败不得写`);
      // 不回显原文（凭据/长串）。
      if (bad.includes('pw')) assert.equal(raw.includes('pw'), false, '不回显凭据');
      if (bad.length > 100) assert.equal(raw.includes(bad.slice(0, 40)), false, '不回显超长原文');
    } finally { h.clean(); }
  }
});

test("POST market/indexes：数量上限 8 条", async () => {
  const market = fakeMarket([]);
  const h = createHarness({ pluginMarket: market });
  try {
    const tooMany = Array.from({ length: 9 }, (_, i) => `https://i${i}.test/index.json`);
    const { status, body } = await call(h.route, "/m/api/plugin-inventory/market/indexes", { method: "POST", body: { urls: tooMany } });
    assert.equal(status, 400);
    assert.equal(body.detail, 'too-many');
    assert.equal(market.state.setCalls.length, 0);

    const exactly8 = tooMany.slice(0, 8);
    const ok = await call(h.route, "/m/api/plugin-inventory/market/indexes", { method: "POST", body: { urls: exactly8 } });
    assert.equal(ok.status, 200, '8 条应通过');
  } finally { h.clean(); }
});

test("POST market/indexes：body 形状不对 → 400 bad-request；不支持写 → 409", async () => {
  const market = fakeMarket([]);
  const h = createHarness({ pluginMarket: market });
  try {
    for (const body of [{}, { urls: 'x' }, { urls: null }, []]) {
      const { status, body: res } = await call(h.route, "/m/api/plugin-inventory/market/indexes", { method: "POST", body });
      assert.equal(status, 400, JSON.stringify(body));
      assert.equal(res.error, 'bad-request');
    }
    assert.equal(market.state.setCalls.length, 0);
  } finally { h.clean(); }

  const readOnly = { listIndexes: () => [], async search() {} };
  const h2 = createHarness({ pluginMarket: readOnly });
  try {
    const { status, body } = await call(h2.route, "/m/api/plugin-inventory/market/indexes", { method: "POST", body: { urls: [] } });
    assert.equal(status, 409);
    assert.equal(body.error, 'settings-write-unavailable');
  } finally { h2.clean(); }

  const h3 = createHarness({});
  try {
    const { status, body } = await call(h3.route, "/m/api/plugin-inventory/market/indexes", { method: "POST", body: { urls: [] } });
    assert.equal(status, 409);
    assert.equal(body.error, 'plugin-market-unavailable');
  } finally { h3.clean(); }
});

test("POST market/indexes：宿主 setIndexes 抛 settings-unavailable → 409 settings-write-unavailable", async () => {
  const market = {
    listIndexes() { return []; },
    async setIndexes() {
      const error = new Error('no settings');
      error.code = 'plugin-market/settings-unavailable';
      throw error;
    },
    async search() {},
  };
  const h = createHarness({ pluginMarket: market });
  try {
    const { status, body } = await call(h.route, "/m/api/plugin-inventory/market/indexes", { method: "POST", body: { urls: [] } });
    assert.equal(status, 409);
    assert.equal(body.error, 'settings-write-unavailable');
  } finally { h.clean(); }
});

test("market/indexes：PUT/DELETE 等其它方法 → 405", async () => {
  const market = fakeMarket([]);
  const h = createHarness({ pluginMarket: market });
  try {
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      const { status } = await call(h.route, "/m/api/plugin-inventory/market/indexes", { method, body: {} });
      assert.equal(status, 405, method);
    }
  } finally { h.clean(); }
});

// ── 3. SSRF（本任务的安全重点） ─────────────────────────────────

test("SSRF 负例：search 传**未配置**的 url → 400 unknown-index，且绝不调用宿主 search", async () => {
  const market = fakeMarket([{ url: 'https://configured.test/index.json' }]);
  const h = createHarness({ pluginMarket: market });
  try {
    const { status, body } = await call(
      h.route,
      `/m/api/plugin-inventory/market/search?url=${encodeURIComponent('https://evil.internal:8080/admin')}`,
    );
    assert.equal(status, 400);
    assert.equal(body.error, 'unknown-index');
    // **核心断言**：宿主 search 一次都没被调用 —— 证明 URL 没有进入抓取路径。
    assert.deepEqual(market.state.searchCalls, [], '未配置的 URL 不得触发任何抓取');
    assert.equal(market.state.fetchCount, 0);
  } finally { h.clean(); }
});

test("SSRF 负例：近似已配置 URL 的变体也拒绝（不做前缀/子串匹配）", async () => {
  const configured = 'https://configured.test/plugins/index.json';
  const market = fakeMarket([{ url: configured }]);
  const h = createHarness({ pluginMarket: market });
  try {
    // 每种都是「看起来像」但不是同一个 URL 的变体。
    const variants = [
      'https://configured.test/plugins/index.json/',        // 多尾斜杠
      'https://configured.test/plugins/index.json?x=1',     // 加 query
      'https://configured.test/plugins/index.json#f',       // 加 fragment
      'https://configured.test/plugins/other.json',         // 兄弟路径
      'https://configured.test.evil.test/index.json',       // 后缀伪装
      'https://sub.configured.test/plugins/index.json',     // 子域
      'http://configured.test/plugins/index.json',          // 换 scheme（http≠https）
      'https://configured.test:8443/plugins/index.json',    // 换端口
      'https://configured.test/plugins/../index.json',      // 路径穿越（URL 归一后不同）
    ];
    for (const variant of variants) {
      const { status, body } = await call(
        h.route,
        `/m/api/plugin-inventory/market/search?url=${encodeURIComponent(variant)}`,
      );
      assert.equal(status, 400, `应拒绝：${variant}`);
      // 两种拒绝路径都算合格：
      //   - `index-invalid`：形态校验先拦下（带 query/fragment 等）；
      //   - `unknown-index`：形态合法但不在已配置列表。
      // 真正的安全断言是「一次抓取都没发生」（见下方），不是具体落在哪个码上。
      assert.ok(
        body.error === 'unknown-index' || body.error === 'index-invalid',
        `应被拒绝（unknown-index 或 index-invalid），实际 ${body.error}：${variant}`,
      );
    }
    assert.deepEqual(market.state.searchCalls, [], '所有变体都不得触发抓取');
  } finally { h.clean(); }
});

test("SSRF 负例：SSRF 目标用 file:/ftp:/内网地址同样拒绝，且报的是 unknown-index 或 index-invalid", async () => {
  const market = fakeMarket([{ url: 'https://configured.test/index.json' }]);
  const h = createHarness({ pluginMarket: market });
  try {
    const cases = [
      ['file:///etc/passwd', 'index-invalid'],
      ['ftp://internal.test/index.json', 'index-invalid'],
      ['http://127.0.0.1:6379/', 'unknown-index'],
      ['http://169.254.169.254/latest/meta-data/', 'unknown-index'],
      ['http://192.168.1.1/admin', 'unknown-index'],
      ['http://localhost:3080/m/api/bootstrap', 'unknown-index'],
    ];
    for (const [target, expected] of cases) {
      const { status, body } = await call(
        h.route,
        `/m/api/plugin-inventory/market/search?url=${encodeURIComponent(target)}`,
      );
      assert.equal(status, 400, target);
      assert.equal(body.error, expected, target);
    }
    assert.deepEqual(market.state.searchCalls, [], '内网/元数据/file 目标一概不得抓取');
    assert.equal(market.state.fetchCount, 0, '抓取计数必须为 0（双保险）');
  } finally { h.clean(); }
});

test("SSRF 正例：**已配置**的 url 才会真正调用宿主 search", async () => {
  const configured = 'https://configured.test/plugins/index.json';
  const market = fakeMarket([{ url: configured }]);
  const h = createHarness({ pluginMarket: market });
  try {
    const { status, body } = await call(
      h.route,
      `/m/api/plugin-inventory/market/search?url=${encodeURIComponent(configured)}`,
    );
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(market.state.searchCalls.length, 1, '已配置的 url 应触发一次 search');
    assert.equal(market.state.searchCalls[0].url, configured);
  } finally { h.clean(); }
});

test("SSRF 正例：写入新索引后，该 url 立即可用于 search（配置即授权）", async () => {
  const market = fakeMarket([]);
  const h = createHarness({ pluginMarket: market });
  try {
    const url = 'https://new.test/index.json';
    // 写入前：拒绝。
    const before = await call(h.route, `/m/api/plugin-inventory/market/search?url=${encodeURIComponent(url)}`);
    assert.equal(before.status, 400);
    assert.equal(before.body.error, 'unknown-index');

    // 写入后：允许（用户显式把它加进配置，等于明确授权这个源）。
    await call(h.route, "/m/api/plugin-inventory/market/indexes", { method: "POST", body: { urls: [url] } });
    const after = await call(h.route, `/m/api/plugin-inventory/market/search?url=${encodeURIComponent(url)}`);
    assert.equal(after.status, 200);
    assert.equal(market.state.searchCalls.length, 1);
  } finally { h.clean(); }
});

test("SSRF：索引已被配置但宿主标记 error → 409 index-unusable，且不抓取", async () => {
  const url = 'https://broken.test/index.json';
  const market = fakeMarket([{ url, error: 'Index URL is not in canonical form' }]);
  const h = createHarness({ pluginMarket: market });
  try {
    const { status, body } = await call(h.route, `/m/api/plugin-inventory/market/search?url=${encodeURIComponent(url)}`);
    assert.equal(status, 409);
    assert.equal(body.error, 'index-unusable');
    assert.deepEqual(market.state.searchCalls, [], '不可用索引不得抓取');
  } finally { h.clean(); }
});

test("SSRF：缺 url → 400 bad-request（不默认第一个索引）", async () => {
  const market = fakeMarket([{ url: 'https://configured.test/index.json' }]);
  const h = createHarness({ pluginMarket: market });
  try {
    const { status, body } = await call(h.route, "/m/api/plugin-inventory/market/search");
    assert.equal(status, 400);
    assert.equal(body.error, 'bad-request');
    assert.deepEqual(market.state.searchCalls, []);
  } finally { h.clean(); }
});

test("SSRF：老宿主无 pluginMarket → 200 + supported:false（不抓取、不报错）", async () => {
  const h = createHarness({});
  try {
    const { status, body } = await call(h.route, "/m/api/plugin-inventory/market/search?url=https%3A%2F%2Fx.test%2Fi.json");
    assert.equal(status, 200);
    assert.equal(body.supported, false);
    assert.equal(body.reason, 'plugin-market-unavailable');
  } finally { h.clean(); }
});

// ── 4. search 的查询参数与结果投影 ─────────────────────────────

test("market/search：offset/limit/text/category 透传，边界归一成稳定码", async () => {
  const url = 'https://configured.test/index.json';
  const market = fakeMarket([{ url }]);
  const h = createHarness({ pluginMarket: market });
  try {
    const q = new URLSearchParams({ url, offset: '20', limit: '10', text: 'voice', category: 'custom' });
    const { status, body } = await call(h.route, `/m/api/plugin-inventory/market/search?${q}`);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(market.state.searchCalls[0].query, { offset: 20, limit: 10, text: 'voice', category: 'custom' });

    for (const [bad, field] of [
      ['offset=-1', 'offset'],
      ['offset=abc', 'offset'],
      ['offset=1.5', 'offset'],
      ['limit=0', 'limit'],
      ['limit=101', 'limit'],
      ['limit=xyz', 'limit'],
    ]) {
      const { status: s, body: b } = await call(h.route, `/m/api/plugin-inventory/market/search?url=${encodeURIComponent(url)}&${bad}`);
      assert.equal(s, 400, bad);
      assert.equal(b.error, 'invalid-query', bad);
      assert.equal(b.detail, field, bad);
    }
    // 失败不应新增抓取（只有前面那条合法请求）。
    assert.equal(market.state.searchCalls.length, 1);
  } finally { h.clean(); }
});

test("market/search：默认 limit=20、offset=0", async () => {
  const url = 'https://configured.test/index.json';
  const market = fakeMarket([{ url }]);
  const h = createHarness({ pluginMarket: market });
  try {
    await call(h.route, `/m/api/plugin-inventory/market/search?url=${encodeURIComponent(url)}`);
    assert.deepEqual(market.state.searchCalls[0].query, { offset: 0, limit: 20 });
  } finally { h.clean(); }
});

test("market/search：结果移除绝对路径/本地文件线索，安装目标由宿主给出", async () => {
  const url = 'https://configured.test/index.json';
  const market = fakeMarket([{ url }]);
  const h = createHarness({ pluginMarket: market });
  try {
    const { body } = await call(h.route, `/m/api/plugin-inventory/market/search?url=${encodeURIComponent(url)}`);
    const entry = body.entries[0];
    assert.equal(entry.name, 'dsh-market-plugin');
    assert.equal(entry.defaultVersion, '1.2.0');
    assert.equal(entry.versions[0].install.spec, 'dsh-market-plugin@1.2.0', '安装目标由宿主算好');
    assert.equal(entry.versions[0].install.registry, 'https://registry.npmjs.org/');
    // `metadata` 是任意宿主文档内容，不投影（避免带出本地路径/内部字段）。
    assert.equal('metadata' in entry, false);
    assert.equal(JSON.stringify(body).includes('/home/'), false, '结果不含本地绝对路径');
    assert.equal(JSON.stringify(body).includes('file://'), false);
  } finally { h.clean(); }
});

test("market/search：宿主 search 抛 fetch-failed → 502 index-fetch-failed（不泄露原文）", async () => {
  const url = 'https://configured.test/index.json';
  const market = {
    listIndexes() { return [{ url }]; },
    async setIndexes() {},
    async search() {
      const error = new Error('connect ECONNREFUSED /home/mark/secret');
      error.code = 'plugin-market/fetch-failed';
      throw error;
    },
  };
  const h = createHarness({ pluginMarket: market });
  try {
    const { status, body, raw } = await call(h.route, `/m/api/plugin-inventory/market/search?url=${encodeURIComponent(url)}`);
    assert.equal(status, 502);
    assert.equal(body.error, 'index-fetch-failed');
    assert.equal(raw.includes('/home/mark/secret'), false);
    assert.equal(raw.includes('ECONNREFUSED'), false);
  } finally { h.clean(); }
});

test("market/search：非 GET → 405", async () => {
  const market = fakeMarket([{ url: 'https://configured.test/index.json' }]);
  const h = createHarness({ pluginMarket: market });
  try {
    const { status } = await call(h.route, "/m/api/plugin-inventory/market/search?url=x", { method: "POST", body: {} });
    assert.equal(status, 405);
  } finally { h.clean(); }
});

test("market/search：索引 URL 里的 query/fragment 在 search 时同样被拒（不只写时校验）", async () => {
  // 即使这种 URL 出现在宿主配置里（配置可能被别处写坏），search 也不接受带 query/fragment 的形态。
  const url = 'https://configured.test/index.json?token=abc';
  const market = fakeMarket([{ url }]);
  const h = createHarness({ pluginMarket: market });
  try {
    const { status, body } = await call(h.route, `/m/api/plugin-inventory/market/search?url=${encodeURIComponent(url)}`);
    assert.equal(status, 400);
    assert.equal(body.error, 'index-invalid');
    assert.deepEqual(market.state.searchCalls, []);
  } finally { h.clean(); }
});
