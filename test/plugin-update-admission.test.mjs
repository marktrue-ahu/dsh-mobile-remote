import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { createHash as hashOf } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { once } from 'node:events';
import { test } from 'node:test';

// #35 起口令必须显式配置或由宿主自动生成；admission 用例与鉴权无关，用固定口令 + 默认 token 头。
const AUTH_TOKEN = 'fixture-admission-token';
const home = mkdtempSync(join(tmpdir(), 'update-admission-'));
process.env.HOME = home;
const { apply } = await import('../lib/index.js');
const { appendOperationLog } = await import('../lib/plugin-update-log.js');
const { readTransaction, transactionFile, readLock, updateLockPath, releaseLock, finishOwnedTerminal } = await import('../lib/plugin-update-transaction.js');
const manifest = {
  schema: 1,
  app: { version: '3.3.0+70', file: 'app.apk', size: 3, sha256: 'a'.repeat(64), url: 'https://release.test/app-70.apk' },
  plugin: { version: '3.3.0', file: 'plugin.tgz', size: 3, sha256: 'b'.repeat(64), contentSha256: 'c'.repeat(64), url: 'https://release.test/plugin-70.tgz' },
};
const NPM_PACKAGE_NAME = '@marktrue/dsh-mobile-remote';
const NPM_PLUGIN_VERSION = '3.3.0-alpha.1';
const NPM_CARRIER_VERSION = `${NPM_PLUGIN_VERSION}-app`;
const NPM_DOCS = new Map([
  [NPM_PACKAGE_NAME, { 'dist-tags': { latest: '3.2.1-alpha.1', alpha: NPM_PLUGIN_VERSION, app: NPM_CARRIER_VERSION } }],
  [`${NPM_PACKAGE_NAME}@${NPM_PLUGIN_VERSION}`, {
    version: NPM_PLUGIN_VERSION,
    dist: { integrity: `sha512-${Buffer.from('plugin').toString('base64')}` },
    contentSha256: 'c'.repeat(64),
    optionalDependencies: { '@marktrue/dsh-mobile-remote-app': `npm:${NPM_PACKAGE_NAME}@${NPM_CARRIER_VERSION}` },
  }],
  [`${NPM_PACKAGE_NAME}@${NPM_CARRIER_VERSION}`, {
    version: NPM_CARRIER_VERSION, appVersion: '3.3.0+70', pluginContentSha256: 'c'.repeat(64),
    dist: { integrity: `sha512-${Buffer.from('carrier').toString('base64')}` },
  }],
]);
const npmPackageView = async spec => NPM_DOCS.get(spec) ?? null;
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
  // T16/W1：endpoint view 依据真实监听的 webServer.host/port 生成手机可达地址。
  const webServerHost = options.webServerHost ?? '127.0.0.1';
  const ctx = {
    webServer: { host: webServerHost, port: 39401, register(route) { routes.push(route); return () => {}; } },
    logger: { warn: m => logs.push(String(m)), info: m => logs.push(String(m)) },
    get: name => ['agents','sessions'].includes(name) ? { list: () => [], roots: () => [], get: () => undefined } : undefined,
    provide() {}, inject() {}, on: () => () => {}, effect(fn) { cleanup = fn(); return cleanup; },
  };
  const config = {
    path: '/m', authToken: AUTH_TOKEN, cookieName: 'token', trustedHosts: [], sessionTtlMs: 60000,
    rechargeUrl: '', updateDir: '', pluginUpdateManifest: 'npm', updateProfileDir: profile,
    maxConnections: 16, pushUrls: [], pushCooldownMs: 60000, doneGraceMs: 1000, pushContent: 'minimal',
    rateLimit: { maxFailures: 10, windowMs: 60000, blockMs: 60000 }, lanBridge: { enabled: false, host: '127.0.0.1', port: 39401 }, ...options.config,
  };
  const { pluginUpdates: pluginOverrides = {}, ...restOptions } = options;
  apply(ctx, config, { ...restOptions, pluginUpdates: { fetchImpl, npmPackageView, restartForm: () => 'web-foreground',
    schedule: fn => jobs.push(fn), runSelfUpdate: async () => { installed++; return { ok: true }; },
    ...(restOptions.persist ? { persist: restOptions.persist } : {}), ...pluginOverrides } });
  return { route: routes.find(r => r.kind === 'prefix' && /\/api$/.test(r.path)), mount: config.path, home: testHome, logs, dispose: () => cleanup?.(), profile };
}
async function request(route, body, path = '/m/api/plugin-update', headers = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method: path.endsWith('bootstrap') || path.endsWith('/plugin-update/check') || path.includes('/plugin-update/log') || path.includes('/update/') ? 'GET' : 'POST', url: path, headers: { host: '127.0.0.1:39401', 'x-mobile-token': AUTH_TOKEN, ...headers }, socket: { remoteAddress: '127.0.0.1' } });
  const chunks = [];
  const res = new Writable({ write(chunk, _, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
  res.writeHead = (status) => { res.statusCode = status; return res; };
  const done = once(res, 'finish'); route.handler(req, res); await done;
  const bytes = Buffer.concat(chunks); let json = null; try { json = JSON.parse(bytes.toString()); } catch { /* artifact bytes */ }
  return { status: res.statusCode, body: json, bytes };
}

test('C1: actual NPM update-available handler freezes candidate before accepted; retry starts one worker', async () => {
  const jobsBefore = jobs.length;
  const h = harness(); const savedFetch = global.fetch; global.fetch = fetchImpl;
  try {
    const r = await request(h.route, { opId: 'request-accepted' });
    assert.equal(r.status, 200, JSON.stringify({ body: r.body, logs: h.logs }));
    assert.equal(r.body.action, 'accepted');
    const tx = readTransaction(transactionFile(home));
    assert.equal(tx.opId, r.body.opId);
    assert.equal(tx.release, null);
    assert.equal(tx.npmCandidate.plugin.version, NPM_PLUGIN_VERSION);
    assert.equal(tx.npmCandidate.carrier.appVersion, '3.3.0+70');
    assert.equal(jobs.length, jobsBefore + 1); assert.equal(installed, 0);
    const again = await request(h.route, { opId: 'request-accepted' });
    assert.equal(again.body.opId, tx.opId); assert.equal(jobs.length, jobsBefore + 1);
    const busy = await request(h.route, { opId: 'different-request' });
    assert.equal(busy.status, 409); assert.equal(busy.body.transaction.opId, tx.opId);
    // Reads remain responsive while the scheduled install has not even run.
    const boot = await request(h.route, undefined, '/m/api/bootstrap');
    assert.equal(boot.status, 200, JSON.stringify({ body: boot.body, logs: h.logs.slice(-4) }));
  } finally { global.fetch = savedFetch; const holder = readLock(updateLockPath(home)); if (holder) { const tx = readTransaction(transactionFile(home)); const { writeOwnedTransaction } = await import('../lib/plugin-update-transaction.js'); writeOwnedTransaction(transactionFile(home), { ...tx, phase: 'failed' }, { lockPath: updateLockPath(home), lease: holder }); releaseLock(updateLockPath(home), holder); } h.dispose(); }
});

test('NPM read-only check returns a sanitized candidate without scheduling installation', async () => {
  const packageName = '@marktrue/dsh-mobile-remote';
  const pluginVersion = '3.2.2-alpha.2';
  const carrierVersion = `${pluginVersion}-app`;
  const docs = new Map([
    [packageName, { 'dist-tags': { latest: '3.2.1-alpha.3', alpha: pluginVersion, app: carrierVersion } }],
    [`${packageName}@${pluginVersion}`, {
      version: pluginVersion,
      dist: { integrity: `sha512-${Buffer.from('plugin').toString('base64')}` },
      optionalDependencies: { '@marktrue/dsh-mobile-remote-app': `npm:${packageName}@${carrierVersion}` },
    }],
    [`${packageName}@${carrierVersion}`, {
      version: carrierVersion, appVersion: '3.2.2+26',
      dist: { integrity: `sha512-${Buffer.from('carrier').toString('base64')}` },
    }],
  ]);
  const npmPackageView = async (spec) => docs.get(spec) ?? null;
  const h = harness({ config: { pluginUpdateManifest: 'npm' }, pluginUpdates: { npmPackageView } });
  const pkgBefore = readFileSync(join(h.profile, 'package.json'), 'utf8');
  const jobsBefore = jobs.length, installedBefore = installed;
  try {
    const r = await request(h.route, undefined, '/m/api/plugin-update/check');
    assert.equal(r.status, 200, JSON.stringify({ body: r.body, logs: h.logs }));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.pluginUpdate.source, 'npm');
    assert.equal(r.body.pluginUpdate.state, 'update-available');
    assert.equal(r.body.pluginUpdate.candidate.plugin.version, pluginVersion);
    assert.equal(r.body.pluginUpdate.candidate.carrier.appVersion, '3.2.2+26');
    assert.equal(JSON.stringify(r.body).includes('dist.tarball'), false);
    assert.equal(JSON.stringify(r.body).includes(AUTH_TOKEN), false);
    assert.equal(readFileSync(join(h.profile, 'package.json'), 'utf8'), pkgBefore);
    assert.equal(jobs.length, jobsBefore);
    assert.equal(installed, installedBefore);
  } finally { h.dispose(); }
});

test('NPM POST rejects a candidate that changed after the user confirmed its version', async () => {
  const testHome = mkdtempSync(join(tmpdir(), 'update-npm-version-confirm-'));
  const h = harness({ homeDir: testHome });
  const jobsBefore = jobs.length;
  try {
    const r = await request(h.route, { opId: 'confirmed-wrong-version', targetVersion: '0.0.0' });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, 'candidate-changed');
    assert.equal(r.body.check.candidate.plugin.version, NPM_PLUGIN_VERSION);
    assert.equal(readTransaction(transactionFile(testHome)), null);
    assert.equal(jobs.length, jobsBefore);
  } finally { h.dispose(); }
});

test('NPM POST freezes the exact candidate and gives it to the async worker', async () => {
  const oldHome = process.env.HOME;
  const testHome = mkdtempSync(join(tmpdir(), 'update-npm-submit-'));
  const packageName = '@marktrue/dsh-mobile-remote';
  const pluginVersion = '3.2.2-alpha.2';
  const carrierVersion = `${pluginVersion}-app`;
  const docs = new Map([
    [packageName, { 'dist-tags': { latest: '3.2.1-alpha.3', alpha: pluginVersion, app: carrierVersion } }],
    [`${packageName}@${pluginVersion}`, {
      version: pluginVersion,
      dist: { integrity: `sha512-${Buffer.from('plugin').toString('base64')}` },
      optionalDependencies: { '@marktrue/dsh-mobile-remote-app': `npm:${packageName}@${carrierVersion}` },
    }],
    [`${packageName}@${carrierVersion}`, {
      version: carrierVersion, appVersion: '3.2.2+26', pluginContentSha256: 'b'.repeat(64),
      dist: { integrity: `sha512-${Buffer.from('carrier').toString('base64')}` },
    }],
  ]);
  let workerArgs = null;
  const jobsBefore = jobs.length;
  const h = harness({
    homeDir: testHome,
    config: { pluginUpdateManifest: 'npm' },
    pluginUpdates: {
      npmPackageView: async (spec) => docs.get(spec) ?? null,
      runSelfUpdate: async (args) => { workerArgs = args; return { ok: true }; },
    },
  });
  try {
    const r = await request(h.route, { opId: 'npm-candidate-accepted' });
    assert.equal(r.status, 200, JSON.stringify({ body: r.body, logs: h.logs }));
    assert.equal(r.body.action, 'accepted');
    assert.equal(r.body.transaction.targetAppVersion, '3.2.2+26');
    const tx = readTransaction(transactionFile(testHome));
    assert.equal(tx.targetVersion, pluginVersion);
    assert.equal(tx.npmCandidate.plugin.version, pluginVersion);
    assert.equal(tx.npmCandidate.carrier.version, carrierVersion);
    assert.equal(tx.release, null);
    const scheduled = jobs.splice(jobsBefore);
    assert.equal(scheduled.length, 1);
    await scheduled[0]();
    assert.equal(workerArgs.npmCandidate.plugin.version, pluginVersion);
    assert.equal(workerArgs.plugin.version, pluginVersion);
  } finally {
    const holder = readLock(updateLockPath(testHome));
    if (holder) {
      const tx = readTransaction(transactionFile(testHome));
      const { writeOwnedTransaction } = await import('../lib/plugin-update-transaction.js');
      writeOwnedTransaction(transactionFile(testHome), { ...tx, phase: 'failed' }, { lockPath: updateLockPath(testHome), lease: holder });
      releaseLock(updateLockPath(testHome), holder);
    }
    jobs.splice(jobsBefore);
    h.dispose();
    process.env.HOME = oldHome;
  }
});

test('legacy carrier metadata triggers preparation before any profile mutation', async () => {
  const testHome = mkdtempSync(join(tmpdir(), 'update-legacy-prepare-'));
  const pluginVersion = '3.2.2-alpha.2';
  const carrierVersion = `${pluginVersion}-app`;
  const docs = new Map([
    [NPM_PACKAGE_NAME, { 'dist-tags': { latest: '3.2.1-alpha.3', alpha: pluginVersion, app: carrierVersion } }],
    [`${NPM_PACKAGE_NAME}@${pluginVersion}`, {
      version: pluginVersion,
      dist: { integrity: `sha512-${Buffer.from('plugin').toString('base64')}` },
      optionalDependencies: { '@marktrue/dsh-mobile-remote-app': `npm:${NPM_PACKAGE_NAME}@${carrierVersion}` },
    }],
    [`${NPM_PACKAGE_NAME}@${carrierVersion}`, {
      version: carrierVersion,
      dist: { integrity: `sha512-${Buffer.from('carrier').toString('base64')}` },
    }],
  ]);
  const h = harness({ homeDir: testHome, pluginUpdates: { npmPackageView: async spec => docs.get(spec) ?? null } });
  const profileBefore = readFileSync(join(h.profile, 'package.json'), 'utf8');
  const jobsBefore = jobs.length;
  try {
    const r = await request(h.route, { opId: 'legacy-needs-prepare' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.action, 'prepare-required');
    assert.equal(r.body.check.candidate.carrier.legacyMetadataMissing, true);
    assert.equal(readTransaction(transactionFile(testHome)), null);
    assert.equal(readFileSync(join(h.profile, 'package.json'), 'utf8'), profileBefore);
    assert.equal(jobs.length, jobsBefore);
  } finally { h.dispose(); }
});

test('legacy NPM prepare reveals the carrier build before the final update confirmation', async () => {
  const oldHome = process.env.HOME;
  const testHome = mkdtempSync(join(tmpdir(), 'update-legacy-confirm-'));
  const pluginVersion = '3.2.2-alpha.2';
  const carrierVersion = `${pluginVersion}-app`;
  const docs = new Map([
    [NPM_PACKAGE_NAME, { 'dist-tags': { latest: '3.2.1-alpha.3', alpha: pluginVersion, app: carrierVersion } }],
    [`${NPM_PACKAGE_NAME}@${pluginVersion}`, {
      version: pluginVersion,
      dist: { integrity: `sha512-${Buffer.from('plugin').toString('base64')}` },
      optionalDependencies: { '@marktrue/dsh-mobile-remote-app': `npm:${NPM_PACKAGE_NAME}@${carrierVersion}` },
    }],
    [`${NPM_PACKAGE_NAME}@${carrierVersion}`, {
      version: carrierVersion,
      dist: { integrity: `sha512-${Buffer.from('carrier').toString('base64')}` },
    }],
  ]);
  const preparedDigest = 'd'.repeat(64);
  let workerArgs = null;
  const jobsBefore = jobs.length;
  const h = harness({
    homeDir: testHome,
    config: { pluginUpdateManifest: 'npm' },
    pluginUpdates: {
      npmPackageView: async spec => docs.get(spec) ?? null,
      prepareNpmArtifacts: async ({ workDir }) => ({
        ok: true, workDir,
        pluginPackageDir: join(workDir, 'plugin-package'),
        carrierPackageDir: join(workDir, 'carrier-package'),
        pluginTgzPath: join(workDir, 'plugin.tgz'),
        carrierTgzPath: join(workDir, 'carrier.tgz'),
        pluginContentSha256: preparedDigest,
        carrierAppVersion: '3.2.2+26',
        manifest: { schema: 1, app: { version: '3.2.2+26' }, plugin: { version: pluginVersion, contentSha256: preparedDigest } },
      }),
      runSelfUpdate: async args => { workerArgs = args; return { ok: true }; },
    },
  });
  const profileBefore = readFileSync(join(h.profile, 'package.json'), 'utf8');
  try {
    const prepared = await request(h.route, { opId: 'legacy-final-confirm' }, '/m/api/plugin-update/prepare');
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    assert.equal(prepared.body.action, 'prepared');
    assert.equal(prepared.body.candidate.carrier.appVersion, '3.2.2+26');
    assert.equal(prepared.body.candidate.carrier.legacyMetadataMissing, false);
    assert.equal(readTransaction(transactionFile(testHome)), null);
    assert.equal(readFileSync(join(h.profile, 'package.json'), 'utf8'), profileBefore);
    assert.equal(jobs.length, jobsBefore);

    const accepted = await request(h.route, { opId: 'legacy-final-confirm', prepareId: prepared.body.prepareId });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.action, 'accepted');
    const tx = readTransaction(transactionFile(testHome));
    assert.equal(tx.npmCandidate.carrier.appVersion, '3.2.2+26');
    assert.equal(tx.npmCandidate.plugin.contentSha256, preparedDigest);
    assert.equal(readFileSync(join(h.profile, 'package.json'), 'utf8'), profileBefore, 'profile is unchanged until the async confirmed worker runs');
    const scheduled = jobs.splice(jobsBefore);
    assert.equal(scheduled.length, 1);
    await scheduled[0]();
    assert.equal(workerArgs.preparedNpmArtifacts.pluginContentSha256, preparedDigest);
  } finally {
    const holder = readLock(updateLockPath(testHome));
    if (holder) {
      const tx = readTransaction(transactionFile(testHome));
      const { writeOwnedTransaction } = await import('../lib/plugin-update-transaction.js');
      writeOwnedTransaction(transactionFile(testHome), { ...tx, phase: 'failed' }, { lockPath: updateLockPath(testHome), lease: holder });
      releaseLock(updateLockPath(testHome), holder);
    }
    jobs.splice(jobsBefore);
    h.dispose();
    process.env.HOME = oldHome;
  }
});

test('authenticated log replay returns live pnpm output sanitized by operation ID', async () => {
  const oldHome = process.env.HOME;
  const testHome = mkdtempSync(join(tmpdir(), 'update-log-replay-'));
  const opId = 'npm-log-replay';
  const jobsBefore = jobs.length;
  let h = harness({
    homeDir: testHome,
    pluginUpdates: {
      runSelfUpdate: async args => {
        args.onStep('install');
        args.onOutput('stdout', 'pnpm install started\n');
        args.onOutput('stderr', 'Authorization: Bearer hidden-install-token\n');
        return { ok: true };
      },
    },
  });
  let hAfterRestart = null;
  try {
    const accepted = await request(h.route, { opId });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    const scheduled = jobs.splice(jobsBefore);
    assert.equal(scheduled.length, 1);
    await scheduled[0]();

    const replay = await request(h.route, undefined, `/m/api/plugin-update/log?opId=${opId}&afterSeq=0`);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.opId, opId);
    assert.ok(replay.body.events.some(event => event.stream === 'stdout' && event.text.includes('pnpm install started')));
    const serialized = JSON.stringify(replay.body.events);
    assert.equal(serialized.includes('hidden-install-token'), false);
    assert.equal(serialized.includes('Authorization: Bearer'), false);
    assert.equal(serialized.includes('[REDACTED]'), true);
    const tx = readTransaction(transactionFile(testHome));
    appendOperationLog({ home: testHome, generation: tx.lease.generation, stage: 'supervisor', text: 'health confirmation complete', redactPaths: [testHome] });

    h.dispose(); h = null;
    hAfterRestart = harness({ homeDir: testHome });
    const replayAfterRestart = await request(hAfterRestart.route, undefined, `/m/api/plugin-update/log?opId=${opId}&afterSeq=0`);
    assert.equal(replayAfterRestart.status, 200, JSON.stringify(replayAfterRestart.body));
    assert.ok(replayAfterRestart.body.events.some(event => event.text.includes('pnpm install started')));
    assert.ok(replayAfterRestart.body.events.some(event => event.stage === 'supervisor' && event.text.includes('health confirmation complete')));

    const unauthorized = await request(hAfterRestart.route, undefined, `/m/api/plugin-update/log?opId=${opId}`, { 'x-mobile-token': '' });
    assert.equal(unauthorized.status, 401);
  } finally {
    const holder = readLock(updateLockPath(testHome));
    if (holder) {
      const tx = readTransaction(transactionFile(testHome));
      const { writeOwnedTransaction } = await import('../lib/plugin-update-transaction.js');
      writeOwnedTransaction(transactionFile(testHome), { ...tx, phase: 'failed' }, { lockPath: updateLockPath(testHome), lease: holder });
      releaseLock(updateLockPath(testHome), holder);
    }
    jobs.splice(jobsBefore);
    h?.dispose();
    hAfterRestart?.dispose();
    process.env.HOME = oldHome;
  }
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
  // T16/W1：trustedHosts 只是主机名白名单，公开 URL 的端口必须等于真实监听端口
  // （harness webServer.port=39401）；未监听端口（如 :3080/:9999）一律不得进入公开投影。
  // endpoint view 以**真实监听**的 webServer.host 为准（192.168.1.9:39401），Host 头不再是公开基址来源。
  const h = harness({ webServerHost: '192.168.1.9', config: { updateDir: dir, pluginUpdateManifest: 'off', trustedHosts: ['192.168.1.9'] } });
  try {
    const r = await request(h.route, undefined, '/m/api/update/manifest', { host: '192.168.1.9:39401' });
    assert.equal(r.status, 200);
    assert.equal(r.body.manifest.app.url, 'http://192.168.1.9:39401/m/api/update/apk');
    assert.equal(r.body.manifest.plugin.url, 'http://192.168.1.9:39401/m/api/update/plugin');
    // 伪造未监听端口（旧实现会原样投影）必须被拒绝：无 URL，而不是 :9999。
    const forged = await request(h.route, undefined, '/m/api/update/manifest', { host: '192.168.1.9:9999' });
    assert.equal(forged.status, 200);
    assert.equal(JSON.stringify(forged.body).includes(':9999'), false, '不得从 Host 伪造未监听端口');
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
    assert.equal((await request(h.route, undefined, '/m/api/update/manifest', { 'x-mobile-token': '' })).status, 401);
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

test('E2: phone POST accepted returns the NPM candidate without registry or loopback URLs', async () => {
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
    webServerHost: '192.0.2.9',
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
    const candidate = r.body.check.candidate;
    assert.equal(r.body.check.source, 'npm');
    assert.equal(candidate.plugin.version, NPM_PLUGIN_VERSION);
    assert.equal(candidate.carrier.appVersion, '3.3.0+70');
    assert.equal(JSON.stringify(r.body).includes('127.0.0.1'), false, 'NPM candidate response must not expose local source URLs');
    assert.equal(JSON.stringify(r.body).includes('dist.tarball'), false, 'NPM packument URLs stay host-side');
    // 独立 HOME：无需清理别人的状态，但收敛自己的在飞事务更干净
    const holder = readLock(updateLockPath(testHome));
    if (holder) {
      finishOwnedTerminal(transactionFile(testHome), { phase: 'failed', result: { ok: false, reason: 'fixture-done' }, expectedPhases: ['staging'] },
        { lockPath: updateLockPath(testHome), lease: holder, currentFile: transactionFile(testHome) });
    }
  } finally { h.dispose(); }
});

test('E3: non-default mount path accepts NPM updates without leaking host URLs', async () => {
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
    webServerHost: '192.0.2.9',
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
    assert.equal(r.body.action, 'accepted', `非默认挂载路径仍应接受 NPM 更新事务：${JSON.stringify(r.body.check)}`);
    assert.equal(r.body.check.source, 'npm');
    assert.equal(r.body.check.candidate.plugin.version, NPM_PLUGIN_VERSION);
    assert.equal(JSON.stringify(r.body).includes('127.0.0.1'), false, 'NPM update status must not project local URLs');
  } finally { h.dispose(); }
});

test('F1: NPM candidate projection never leaks packument tarball URLs or registry credentials', async () => {
  const f1Home = mkdtempSync(join(tmpdir(), 'f1-home-'));
  const secretUrl = 'http://private-registry.example/package.tgz?token=should-not-leak';
  const packageView = async (spec) => {
    if (spec === NPM_PACKAGE_NAME) return { 'dist-tags': { latest: NPM_PLUGIN_VERSION, alpha: NPM_PLUGIN_VERSION, app: NPM_CARRIER_VERSION } };
    if (spec === `${NPM_PACKAGE_NAME}@${NPM_PLUGIN_VERSION}`) return {
      version: NPM_PLUGIN_VERSION,
      dist: { integrity: `sha512-${Buffer.from('plugin').toString('base64')}`, tarball: secretUrl },
      optionalDependencies: { '@marktrue/dsh-mobile-remote-app': `npm:${NPM_PACKAGE_NAME}@${NPM_CARRIER_VERSION}` },
    };
    if (spec === `${NPM_PACKAGE_NAME}@${NPM_CARRIER_VERSION}`) return {
      version: NPM_CARRIER_VERSION, appVersion: '3.3.0+70', pluginContentSha256: 'c'.repeat(64),
      dist: { integrity: `sha512-${Buffer.from('carrier').toString('base64')}`, tarball: secretUrl },
    };
    return null;
  };
  const h = harness({
    homeDir: f1Home,
    webServerHost: '192.0.2.9',
    config: { authToken: 'fixture-only-token', trustedHosts: ['192.0.2.9'], pluginUpdateManifest: 'npm' },
    pluginUpdates: { npmPackageView: packageView },
  });
  try {
    const headers = { host: '192.0.2.9:39401', 'x-mobile-token': 'fixture-only-token' };
    const check = await request(h.route, undefined, '/m/api/plugin-update/check', headers);
    assert.equal(check.status, 200, JSON.stringify(check.body));
    assert.equal(check.body.pluginUpdate.candidate.plugin.version, NPM_PLUGIN_VERSION);
    const serializedCheck = JSON.stringify(check.body);
    assert.equal(serializedCheck.includes(secretUrl), false);
    assert.equal(serializedCheck.includes('should-not-leak'), false);

    const accepted = await request(h.route, { opId: 'f1-npm' }, '/m/api/plugin-update', headers);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    const tx = readTransaction(transactionFile(f1Home));
    assert.equal(tx.npmCandidate.plugin.version, NPM_PLUGIN_VERSION);
    const serializedTx = JSON.stringify(tx);
    assert.equal(serializedTx.includes(secretUrl), false);
    assert.equal(serializedTx.includes('should-not-leak'), false);
  } finally {
    const holder = readLock(updateLockPath(f1Home));
    if (holder) {
      const tx = readTransaction(transactionFile(f1Home));
      const { writeOwnedTransaction } = await import('../lib/plugin-update-transaction.js');
      writeOwnedTransaction(transactionFile(f1Home), { ...tx, phase: 'failed' }, { lockPath: updateLockPath(f1Home), lease: holder });
      releaseLock(updateLockPath(f1Home), holder);
    }
    h.dispose();
  }
});

test('W1/T16: public manifest URL never uses a Host/trustedHosts port that is not a real listener', async () => {
  const dir = join(home, 'w1-port-artifacts'); mkdirSync(dir);
  const apk = Buffer.from('apk-w1'), tgz = Buffer.from('tgz-w1');
  const digest = b => hashOf('sha256').update(b).digest('hex');
  writeFileSync(join(dir, 'app.apk'), apk); writeFileSync(join(dir, 'plugin.tgz'), tgz);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schema: 1, version: '3.3.0+70', apk: 'app.apk', size: apk.length, sha256: digest(apk),
    app: { version: '3.3.0+70', file: 'app.apk', size: apk.length, sha256: digest(apk) },
    plugin: { version: '3.3.0', file: 'plugin.tgz', size: tgz.length, sha256: digest(tgz), contentSha256: 'c'.repeat(64) } }));
  const h = harness({ webServerHost: '192.168.1.9', config: { updateDir: dir, pluginUpdateManifest: 'off', trustedHosts: ['192.168.1.9'] } });
  try {
    // 公开基址只来自真实监听视图（webServer.host=192.168.1.9 + 真实端口 39401）。
    const real = await request(h.route, undefined, '/m/api/update/manifest', { host: '192.168.1.9:39401' });
    assert.equal(real.status, 200);
    assert.equal(real.body.manifest.app.url, 'http://192.168.1.9:39401/m/api/update/apk');
    // 伪造 Host 端口不得覆盖真实监听视图（任何 Host 都不能引入未监听端口）。
    for (const host of ['192.168.1.9:9999', '127.0.0.1:9999']) {
      const forged = await request(h.route, undefined, '/m/api/update/manifest', { host });
      assert.equal(forged.status, 200, host);
      assert.equal(JSON.stringify(forged.body).includes(':9999'), false, host);
      // 只有当 Host 是回环时走本机兼容分支；其余一律取真实监听视图，不出现未监听端口。
      assert.match(forged.body.manifest.app.url, /^http:\/\/(?:192\.168\.1\.9|127\.0\.0\.1):39401\/m\/api\/update\/apk$/, host);
    }
    // 不被允许的 Host 由既有 Host 围栏拒绝（不因投影逻辑放宽）。
    const outsider = await request(h.route, undefined, '/m/api/update/manifest', { host: 'evil.example:9999' });
    assert.equal(outsider.status, 403);
  } finally { h.dispose(); }
});
