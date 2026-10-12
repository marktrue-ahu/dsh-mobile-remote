import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { createHash as hashOf } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { once } from 'node:events';
import { test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'update-admission-'));
process.env.HOME = home;
const { apply } = await import('../lib/index.js');
const { readTransaction, transactionFile, readLock, updateLockPath, releaseLock, finishOwnedTerminal } = await import('../lib/plugin-update-transaction.js');
const manifest = {
  schema: 1,
  app: { version: '3.3.0+70', file: 'app.apk', size: 3, sha256: 'a'.repeat(64), url: 'https://release.test/app-70.apk' },
  plugin: { version: '3.3.0', file: 'plugin.tgz', size: 3, sha256: 'b'.repeat(64), contentSha256: 'c'.repeat(64), url: 'https://release.test/plugin-70.tgz' },
};
let installed = 0;
let jobs = [];
const fetchImpl = async () => new Response(JSON.stringify(manifest), { headers: { 'content-type': 'application/json' } });

function harness(options = {}) {
  // 每个用例独立 HOME：事务/锁不跨用例残留（否则后面的 POST 会莫名 update-busy）。
  const testHome = options.homeDir ?? home;
  process.env.HOME = testHome;
  const profile = join(testHome, `profile-${Math.random().toString(36).slice(2)}`);
  mkdirSync(profile); writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-mobile-remote': 'file:/fixture-old' } }));
  const routes = []; const logs = []; let cleanup;
  const ctx = {
    webServer: { host: '127.0.0.1', port: 39401, register(route) { routes.push(route); return () => {}; } },
    logger: { warn: m => logs.push(String(m)), info: m => logs.push(String(m)) },
    get: name => ['agents','sessions'].includes(name) ? { list: () => [], roots: () => [], get: () => undefined } : undefined,
    provide() {}, inject() {}, on: () => () => {}, effect(fn) { cleanup = fn(); return cleanup; },
  };
  const config = {
    path: '/m', authToken: '', cookieName: 'token', trustedHosts: [], sessionTtlMs: 60000,
    rechargeUrl: '', updateDir: '', pluginUpdateManifest: 'https://release.test/manifest.json', updateProfileDir: profile,
    maxConnections: 16, pushUrls: [], pushCooldownMs: 60000, doneGraceMs: 1000, pushContent: 'minimal',
    rateLimit: { maxFailures: 10, windowMs: 60000, blockMs: 60000 }, lanBridge: { enabled: false, host: '127.0.0.1', port: 39401 }, ...options.config,
  };
  const { pluginUpdates: pluginOverrides = {}, ...restOptions } = options;
  apply(ctx, config, { ...restOptions, pluginUpdates: { fetchImpl, restartForm: () => 'web-foreground',
    schedule: fn => jobs.push(fn), runSelfUpdate: async () => { installed++; return { ok: true }; },
    ...(restOptions.persist ? { persist: restOptions.persist } : {}), ...pluginOverrides } });
  return { route: routes.find(r => r.kind === 'prefix' && /\/api$/.test(r.path)), mount: config.path, home: testHome, logs, dispose: () => cleanup?.(), profile };
}
async function request(route, body, path = '/m/api/plugin-update', headers = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method: path.endsWith('bootstrap') || path.includes('/update/') ? 'GET' : 'POST', url: path, headers: { host: '127.0.0.1:39401', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
  const chunks = [];
  const res = new Writable({ write(chunk, _, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
  res.writeHead = (status) => { res.statusCode = status; return res; };
  const done = once(res, 'finish'); route.handler(req, res); await done;
  const bytes = Buffer.concat(chunks); let json = null; try { json = JSON.parse(bytes.toString()); } catch { /* artifact bytes */ }
  return { status: res.statusCode, body: json, bytes };
}

test('C1: actual update-available handler persists release before accepted; retry starts one worker', async () => {
  const h = harness(); const savedFetch = global.fetch; global.fetch = fetchImpl;
  try {
    const r = await request(h.route, { opId: 'request-accepted' });
    assert.equal(r.status, 200, JSON.stringify({ body: r.body, logs: h.logs }));
    assert.equal(r.body.action, 'accepted');
    const tx = readTransaction(transactionFile(home));
    assert.equal(tx.opId, r.body.opId);
    assert.deepEqual(tx.release.app, manifest.app);
    assert.equal(jobs.length, 1); assert.equal(installed, 0);
    const again = await request(h.route, { opId: 'request-accepted' });
    assert.equal(again.body.opId, tx.opId); assert.equal(jobs.length, 1);
    const busy = await request(h.route, { opId: 'different-request' });
    assert.equal(busy.status, 409); assert.equal(busy.body.transaction.opId, tx.opId);
    // Reads remain responsive while the scheduled install has not even run.
    const boot = await request(h.route, undefined, '/m/api/bootstrap');
    assert.equal(boot.status, 200, JSON.stringify({ body: boot.body, logs: h.logs.slice(-4) }));
  } finally { global.fetch = savedFetch; const holder = readLock(updateLockPath(home)); if (holder) { const tx = readTransaction(transactionFile(home)); const { writeOwnedTransaction } = await import('../lib/plugin-update-transaction.js'); writeOwnedTransaction(transactionFile(home), { ...tx, phase: 'failed' }, { lockPath: updateLockPath(home), lease: holder }); releaseLock(updateLockPath(home), holder); } h.dispose(); }
});

test('C1: failed admission persistence releases lease without scheduling a worker', async () => {
  const h = harness({ persist: () => { throw new Error('fixture-ENOSPC'); } });
  const r = await request(h.route, { opId: 'request-ENOSPC' });
  assert.equal(r.status, 500); assert.equal(r.body.error, 'update-state-write-failed');
  const holder = readLock(updateLockPath(home));
  assert.notEqual(holder?.opId, 'request-ENOSPC');
  h.dispose();
});

test('C2: malformed client IDs are rejected before any filesystem/download side effect', async () => {
  const sentinel = join(home, 'profiles', 'web', 'sentinel');
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true }); writeFileSync(sentinel, 'keep');
  const h = harness();
  try {
    for (const opId of ['../../profiles/web', '../x', '/tmp/absolute', 'a/b', 'a\\b', '', 'x'.repeat(200)]) {
      const r = await request(h.route, { opId });
      assert.equal(r.status, 400, opId); assert.equal(r.body.error, 'invalid-operation-id');
      assert.equal(existsSync(sentinel), true); assert.equal(readFileSync(sentinel, 'utf8'), 'keep');
    }
  } finally { h.dispose(); }
});

test('D3: host manifest projects phone-reachable routes for BOTH artifacts (never loopback, never a fake file path)', async () => {
  const dir = join(home, 'd3-artifacts'); mkdirSync(dir);
  const apk = Buffer.from('apk'), tgz = Buffer.from('tgz');
  const digest = bytes => hashOf('sha256').update(bytes).digest('hex');
  writeFileSync(join(dir, 'app.apk'), apk); writeFileSync(join(dir, 'plugin.tgz'), tgz);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schema: 1, version: '3.3.0+70', apk: 'app.apk', size: apk.length, sha256: digest(apk),
    app: { version: '3.3.0+70', file: 'app.apk', size: apk.length, sha256: digest(apk) },
    plugin: { version: '3.3.0', file: 'plugin.tgz', size: tgz.length, sha256: digest(tgz), contentSha256: 'c'.repeat(64) } }));
  const h = harness({ config: { updateDir: dir, pluginUpdateManifest: 'off', trustedHosts: ['192.168.1.9'] } });  // 信任集合按 hostname（端口被剥离）
  try {
    const r = await request(h.route, undefined, '/m/api/update/manifest', { host: '192.168.1.9:3080' });
    assert.equal(r.status, 200);
    assert.equal(r.body.manifest.app.url, 'http://192.168.1.9:3080/m/api/update/apk');
    assert.equal(r.body.manifest.plugin.url, 'http://192.168.1.9:3080/m/api/update/plugin');
    assert.equal(/\/api\/update\/[^/]*\.apk$/.test(r.body.manifest.app.url), false, '不得虚构文件路由');
    assert.equal(r.body.manifest.app.url.includes('127.0.0.1'), false, '手机上的 127.0.0.1 是手机自己');
    // 固定快照必须与主机检查产出的候选一致（同一份产物、同一地址）
    const { fixedReleaseSnapshot } = await import('../lib/plugin-self-update.js');
    const snapshot = fixedReleaseSnapshot(r.body.manifest, 'http://192.168.1.9:3080/m/api/update/manifest');
    assert.equal(snapshot.app.url, r.body.manifest.app.url);
    assert.equal(snapshot.app.sha256, r.body.manifest.app.sha256);
  } finally { h.dispose(); }
});

test('W1: actual protected host producer feeds manifest and tgz consumers', async () => {
  const { createHash } = await import('node:crypto');
  const { fetchReleaseManifest, downloadVerified, UPDATE_SOURCE_KIND } = await import('../lib/plugin-self-update.js');
  const dir = join(home, 'artifacts'); mkdirSync(dir);
  const apk = Buffer.from('apk-fixture'), tgz = Buffer.from('tgz-fixture');
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(dir, 'app.apk'), apk); writeFileSync(join(dir, 'plugin.tgz'), tgz);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schema: 1, version: '3.3.0+70', apk: 'app.apk', size: apk.length, sha256: digest(apk),
    app: { version: '3.3.0+70', file: 'app.apk', size: apk.length, sha256: digest(apk) },
    plugin: { version: '3.3.0', file: 'plugin.tgz', size: tgz.length, sha256: digest(tgz), contentSha256: 'c'.repeat(64) } }));
  const token = 'fixture-only-protected-token', origin = 'http://127.0.0.1:39401';
  const h = harness({ config: { authToken: token, updateDir: dir, pluginUpdateManifest: 'off' } });
  try {
    assert.equal((await request(h.route, undefined, '/m/api/update/manifest')).status, 401);
    const fakeNetwork = async (url, opts) => { const reply = await request(h.route, undefined, new URL(url).pathname, opts.headers); return new Response(reply.bytes, { status: reply.status }); };
    const auth = { token, trustedOrigin: origin };
    const release = await fetchReleaseManifest({ source: { kind: UPDATE_SOURCE_KIND.CUSTOM, url: `${origin}/m/api/update/manifest` }, fetchImpl: fakeNetwork, auth });
    assert.equal(release.ok, true, release.error);
    assert.equal(release.manifest.plugin.url, `${origin}/m/api/update/plugin`);
    const destPath = join(home, 'downloaded.tgz');
    const result = await downloadVerified({ url: release.manifest.plugin.url, destPath, sha256: digest(tgz), size: tgz.length, auth, fetchImpl: fakeNetwork });
    assert.equal(result.ok, true, result.error); assert.deepEqual(readFileSync(destPath), tgz);
  } finally { h.dispose(); }
});

test('E2: phone POST accepted returns a phone-reachable fixed APK route, not the host loopback locator', async () => {
  const dir = join(home, 'e2-artifacts'); mkdirSync(dir);
  const apk = Buffer.from('apk'), tgz = Buffer.from('tgz');
  const digest = b => hashOf('sha256').update(b).digest('hex');
  writeFileSync(join(dir, 'app.apk'), apk); writeFileSync(join(dir, 'plugin.tgz'), tgz);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schema: 1, version: '3.3.0+70', apk: 'app.apk', size: apk.length, sha256: digest(apk),
    app: { version: '3.3.0+70', file: 'app.apk', size: apk.length, sha256: digest(apk) },
    plugin: { version: '3.3.0', file: 'plugin.tgz', size: tgz.length, sha256: digest(tgz), contentSha256: 'c'.repeat(64) } }));
  const token = 'fixture-only-token';
  const manifestPath = '/m/api/update/manifest';
  const testHome = mkdtempSync(join(tmpdir(), 'e2-home-'));
  const h = harness({
    homeDir: testHome,
    config: { updateDir: dir, authToken: token, trustedHosts: ['192.0.2.9'], pluginUpdateManifest: `http://127.0.0.1:39401${manifestPath}` },
    pluginUpdates: {
      // 宿主的清单请求者是自己（回环），不是发 POST 的手机
      fetchImpl: async (url, opts) => {
        const reply = await request(h.route, undefined, new URL(url).pathname, { host: '127.0.0.1:39401', ...opts.headers });
        return new Response(reply.bytes, { status: reply.status });
      },
      schedule: () => {},
    },
  });
  try {
    const r = await request(h.route, { opId: 'phone-request' }, '/m/api/plugin-update', { host: '192.0.2.9:39401', 'x-mobile-token': token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const release = r.body.check.release;
    assert.equal(release.app.url, 'http://192.0.2.9:39401/m/api/update/apk', '返回给手机的必须是手机可达地址');
    assert.equal(release.plugin.url, 'http://192.0.2.9:39401/m/api/update/plugin');
    assert.equal(release.app.url.includes('127.0.0.1'), false);
    assert.equal(release.app.sha256, digest(apk), '固定发布身份不得改写');
    assert.equal(release.app.size, apk.length);
    // 独立 HOME：无需清理别人的状态，但收敛自己的在飞事务更干净
    const holder = readLock(updateLockPath(testHome));
    if (holder) {
      finishOwnedTerminal(transactionFile(testHome), { phase: 'failed', result: { ok: false, reason: 'fixture-done' }, expectedPhases: ['staging'] },
        { lockPath: updateLockPath(testHome), lease: holder, currentFile: transactionFile(testHome) });
    }
  } finally { h.dispose(); }
});

test('E3: non-default mount path keeps credentials on the host loopback fetch', async () => {
  const dir = join(home, 'e3-artifacts'); mkdirSync(dir);
  const apk = Buffer.from('apk'), tgz = Buffer.from('tgz');
  const digest = b => hashOf('sha256').update(b).digest('hex');
  writeFileSync(join(dir, 'app.apk'), apk); writeFileSync(join(dir, 'plugin.tgz'), tgz);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schema: 1, version: '3.3.0+70', apk: 'app.apk', size: apk.length, sha256: digest(apk),
    app: { version: '3.3.0+70', file: 'app.apk', size: apk.length, sha256: digest(apk) },
    plugin: { version: '3.3.0', file: 'plugin.tgz', size: tgz.length, sha256: digest(tgz), contentSha256: 'c'.repeat(64) } }));
  const token = 'fixture-only-token';
  const h = harness({
    homeDir: mkdtempSync(join(tmpdir(), 'e3-home-')),
    config: { path: '/phone', updateDir: dir, authToken: token, trustedHosts: ['192.0.2.9'],
      pluginUpdateManifest: 'http://127.0.0.1:39401/phone/api/update/manifest' },
    pluginUpdates: {
      fetchImpl: async (url, opts) => {
        const reply = await request(h.route, undefined, new URL(url).pathname, { host: '127.0.0.1:39401', ...opts.headers });
        return new Response(reply.bytes, { status: reply.status });
      },
      schedule: () => {},
    },
  });
  try {
    const r = await request(h.route, { opId: 'phone-path' }, `${h.mount}/api/plugin-update`, { host: '192.0.2.9:39401', 'x-mobile-token': token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.action, 'accepted', `非默认挂载路径不得因缺 basePath 被剥凭据：${JSON.stringify(r.body.check)}`);
    assert.equal(r.body.check.release.app.url, 'http://192.0.2.9:39401/phone/api/update/apk');
  } finally { h.dispose(); }
});

test('F1: queued worker keeps the internal loopback locator while public views stay phone-reachable', async () => {
  const { pluginContentDigest } = await import('../lib/plugin-content-digest.js');
  const { writeFileSync: writeSync } = await import('node:fs');
  const dir = join(home, 'f1-artifacts'); mkdirSync(dir);
  const apk = Buffer.from('apk'), tgz = Buffer.from('tgz-bytes');
  const digest = b => hashOf('sha256').update(b).digest('hex');
  // 真实 worker 会复算解包内容标识：夹具的 contentSha256 必须与 stub runTar 产出的内容一致
  const staged = join(home, 'f1-staged'); mkdirSync(join(staged, 'lib'), { recursive: true });
  writeSync(join(staged, 'package.json'), JSON.stringify({ name: 'dsh-mobile-remote', version: '3.3.0' }));
  writeSync(join(staged, 'lib', 'index.js'), "export const v = 'new';\n");
  const contentSha256 = pluginContentDigest(staged);
  const installedRoot = join(home, 'f1-installed'); mkdirSync(join(installedRoot, 'lib'), { recursive: true });
  writeSync(join(installedRoot, 'package.json'), JSON.stringify({ name: 'dsh-mobile-remote', version: '3.2.0' }));
  writeSync(join(installedRoot, 'lib', 'index.js'), "export const v = 'old';\n");
  writeFileSync(join(dir, 'app.apk'), apk); writeFileSync(join(dir, 'plugin.tgz'), tgz);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schema: 1, version: '3.3.0+70', apk: 'app.apk', size: apk.length, sha256: digest(apk),
    app: { version: '3.3.0+70', file: 'app.apk', size: apk.length, sha256: digest(apk) },
    plugin: { version: '3.3.0', file: 'plugin.tgz', size: tgz.length, sha256: digest(tgz), contentSha256 } }));
  const token = 'fixture-only-token';
  const seen = [];
  let h;
  const f1Home = mkdtempSync(join(tmpdir(), 'f1-home-'));
  h = harness({
    homeDir: f1Home,
    config: { updateDir: dir, authToken: token, trustedHosts: ['192.0.2.9'],
      pluginUpdateManifest: 'http://127.0.0.1:39401/m/api/update/manifest' },
    pluginUpdates: {
      // 真的排队执行 worker（默认 harness 只收集不执行）
      schedule: fn => setImmediate(fn),
      // 用**真实** runSelfUpdate（harness 默认 stub 只返回 ok、不推进事务，测不到下载与凭据）
      runSelfUpdate: (opts) => import('../lib/plugin-self-update.js').then(m => m.runSelfUpdate(opts)),
      // 真实 worker 走这里取清单与包；记录是否带了回环凭据
      fetchImpl: async (url, opts) => {
        seen.push({ url, token: opts?.headers?.['x-mobile-token'] });
        const reply = await request(h.route, undefined, new URL(url).pathname, { host: '127.0.0.1:39401', ...(opts?.headers ?? {}) });
        return new Response(reply.bytes, { status: reply.status });
      },
      workerOptions: {
        installedRoot, pluginRoot: installedRoot,
        freezeImpl: () => ({ ok: true, entry: '/fixture' }),
        spawnArmedImpl: () => ({ ok: true, mode: 'fixture' }),
        awaitReadyImpl: async () => ({ ok: true, ready: { pid: process.pid } }),
        runInstall: async () => ({ ok: true }),
        runTar: async (_tgz, dest) => {
          mkdirSync(join(dest, 'package', 'lib'), { recursive: true });
          writeSync(join(dest, 'package', 'package.json'), JSON.stringify({ name: 'dsh-mobile-remote', version: '3.3.0' }));
          writeSync(join(dest, 'package', 'lib', 'index.js'), "export const v = 'new';\n");
          return { ok: true };
        },
      },
    },
  });
  try {
    const headers = { host: '192.0.2.9:39401', 'x-mobile-token': token };
    const accepted = await request(h.route, { opId: 'f1-phone' }, '/m/api/plugin-update', headers);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.check.release.app.url, 'http://192.0.2.9:39401/m/api/update/apk');
    // 让排队 worker 真的跑完（轮询而非固定等待）
    let persisted = readTransaction(transactionFile(f1Home));
    for (let i = 0; i < 60 && persisted?.phase === 'staging'; i++) {
      await new Promise(r => setTimeout(r, 50));
      persisted = readTransaction(transactionFile(f1Home));
    }
    assert.equal(persisted.phase, 'restart-pending', `worker 必须成功落位：${JSON.stringify({ result: persisted.result, logs: h.logs.slice(-5) })}`);
    assert.equal(persisted.release.plugin.url, 'http://127.0.0.1:39401/m/api/update/plugin', '内部事务必须保留回环 locator');
    assert.equal(persisted.release.app.url, 'http://127.0.0.1:39401/m/api/update/apk');
    assert.ok(seen.some(s => s.url.includes('127.0.0.1') && s.token === token), 'worker 必须带回环凭据读受保护产物');
    // 公开出口（bootstrap）仍必须是手机可达视图，且身份固定
    const boot = await request(h.route, undefined, '/m/api/bootstrap', headers);
    const pub = boot.body.pluginUpdate.transaction.release;
    assert.equal(pub.app.url, 'http://192.0.2.9:39401/m/api/update/apk');
    assert.equal(pub.plugin.url, 'http://192.0.2.9:39401/m/api/update/plugin');
    assert.equal(pub.app.sha256, digest(apk));
    assert.equal(pub.plugin.contentSha256, contentSha256);
    const holder = readLock(updateLockPath(f1Home));
    if (holder) finishOwnedTerminal(transactionFile(f1Home), { phase: 'failed', result: { ok: false, reason: 'fixture-done' }, expectedPhases: ['restart-pending'] },
      { lockPath: updateLockPath(f1Home), lease: holder, currentFile: transactionFile(f1Home) });
  } finally { h.dispose(); }
});
