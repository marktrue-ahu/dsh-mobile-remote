import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { once } from 'node:events';
import { test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'update-admission-'));
process.env.HOME = home;
const { apply } = await import('../lib/index.js');
const { readTransaction, transactionFile, readLock, updateLockPath, releaseLock } = await import('../lib/plugin-update-transaction.js');
const manifest = {
  schema: 1,
  app: { version: '3.3.0+70', file: 'app.apk', size: 3, sha256: 'a'.repeat(64), url: 'https://release.test/app-70.apk' },
  plugin: { version: '3.3.0', file: 'plugin.tgz', size: 3, sha256: 'b'.repeat(64), contentSha256: 'c'.repeat(64), url: 'https://release.test/plugin-70.tgz' },
};
let installed = 0;
let jobs = [];
const fetchImpl = async () => new Response(JSON.stringify(manifest), { headers: { 'content-type': 'application/json' } });

function harness(options = {}) {
  const profile = join(home, `profile-${Math.random().toString(36).slice(2)}`);
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
  apply(ctx, config, { pluginUpdates: { fetchImpl, restartForm: () => 'web-foreground',
    schedule: fn => jobs.push(fn), runSelfUpdate: async () => { installed++; return { ok: true }; }, ...options } });
  return { route: routes.find(r => r.kind === 'prefix' && r.path === '/m/api'), logs, dispose: () => cleanup?.(), profile };
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
    assert.equal((await request(h.route, undefined, '/m/api/bootstrap')).status, 200);
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
