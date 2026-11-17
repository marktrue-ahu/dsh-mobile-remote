// issue #116：宿主管理器拒绝时透传宿主错误码 + 稳定动作枚举（不泄露 diagnostic）。
//
// 覆盖：
//   1. code → nextAction 白名单映射（含未知码保原码 + diagnose）；
//   2. runHostManagerUpdate 的 failed / CALL_FAILED 两条失败通道都带 hostErrorCode/nextAction；
//   3. controller 持久化事务 result 并经 HTTP 公开视图（publicTransaction 白名单）暴露；
//   4. 旧客户端/旧插件兼容：无字段时既有 reason 语义不变；
//   5. 安全：宿主 diagnostic 原文绝不进入响应。
import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable, Writable } from 'node:stream';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { apply } from '../lib/index.js';
import { HOST_MANAGER_ERROR, HOST_MANAGER_NEXT_ACTION, interpretHostManagerUpdate,
  nextActionForHostError, runHostManagerUpdate } from '../lib/host-manager-update.js';

const DIAGNOSTIC = 'SECRET /home/mark/.npmrc registry=https://user:pw@r.example';

function coreVersion(version) {
  return /^\d+\.\d+\.\d+/.exec(version)?.[0] ?? version;
}
function nextCandidate(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
  if (!match) throw new Error(`local version is not semver: ${version}`);
  const core = `${match[1]}.${match[2]}.${match[3]}`;
  const prerelease = match[4] === undefined ? [] : match[4].split('.');
  if (prerelease.length === 0) return { channel: 'latest', candidate: `${match[1]}.${match[2]}.${Number(match[3]) + 1}` };
  const [channel, ordinal] = prerelease;
  return { channel, candidate: `${core}-${channel}.${Number(ordinal) + 1}` };
}

// ── 1. 映射白名单（唯一实现） ─────────────────────────────────────────────
test('宿主错误码 ↔ nextAction：白名单五个动作，未知码保原码 + diagnose', () => {
  const cases = new Map([
    ['stop-profile', HOST_MANAGER_NEXT_ACTION.RESTART_HOST],
    ['bundle-in-use', HOST_MANAGER_NEXT_ACTION.RESTART_HOST],
    ['incompatible-version', HOST_MANAGER_NEXT_ACTION.VERSION_INCOMPATIBLE],
    ['not-bundle', HOST_MANAGER_NEXT_ACTION.INVALID_TARGET],
    ['invalid-spec', HOST_MANAGER_NEXT_ACTION.INVALID_TARGET],
    ['operation-error', HOST_MANAGER_NEXT_ACTION.RETRY_OR_DIAGNOSE],
    ['future-host-code', HOST_MANAGER_NEXT_ACTION.DIAGNOSE],
  ]);
  for (const [code, action] of cases) {
    assert.equal(nextActionForHostError(code), action, code);
  }
  assert.equal(nextActionForHostError(''), '', '空码不是宿主拒绝，不编造动作');
  assert.equal(nextActionForHostError(undefined), '');
  // 动作枚举只有 5 个值（维护者已定契约）。
  assert.deepEqual(new Set(Object.values(HOST_MANAGER_NEXT_ACTION)), new Set([
    'restart-host', 'version-incompatible', 'invalid-target', 'retry-or-diagnose', 'diagnose',
  ]));
});

test('failed：返回 hostErrorCode/nextAction，且绝不透传 diagnostic', () => {
  const failed = interpretHostManagerUpdate({ result: { application: 'failed',
    error: { code: 'stop-profile', diagnostic: DIAGNOSTIC } } });
  assert.equal(failed.reason, HOST_MANAGER_ERROR.REJECTED, '既有 reason 语义保留');
  assert.equal(failed.hostErrorCode, 'stop-profile');
  assert.equal(failed.nextAction, HOST_MANAGER_NEXT_ACTION.RESTART_HOST);
  assert.ok(!JSON.stringify(failed).includes('SECRET'), 'diagnostic 原文不得泄露');
  assert.ok(!JSON.stringify(failed).includes('npmrc'), '路径不得泄露');

  // failed 但没有 error.code：不编造 hostErrorCode，也不给动作（由 reason 文案兜底）。
  const noCode = interpretHostManagerUpdate({ result: { application: 'failed' } });
  assert.equal(noCode.hostErrorCode, '');
  assert.equal(noCode.nextAction, '');
});

test('非宿主拒绝的失败结论不携带动作（不误报 restart-host）', () => {
  for (const application of ['restart-required', 'cancelled', 'overridden']) {
    const result = interpretHostManagerUpdate({ result: { application,
      ...(application === 'restart-required' ? { restartReason: 'no-hmr' } : {}) } });
    assert.equal(result.ok, false);
    assert.equal(result.hostErrorCode, '');
    assert.equal(result.nextAction, '', application);
  }
});

test('CALL_FAILED：宿主 reject 的 error.code 也会映射成 nextAction', async () => {
  const service = { updateBundle: async () => { const e = new Error('disposed'); e.code = 'operation-error'; throw e; } };
  const result = await runHostManagerUpdate({ service, packageName: 'pkg', targetVersion: '2.0.0', installedVersion: '1.0.0' });
  assert.equal(result.reason, HOST_MANAGER_ERROR.CALL_FAILED);
  assert.equal(result.hostErrorCode, 'operation-error');
  assert.equal(result.nextAction, HOST_MANAGER_NEXT_ACTION.RETRY_OR_DIAGNOSE);
});

// ── 2. controller + HTTP 视图 ────────────────────────────────────────────
function harness({ hostResult }) {
  const home = mkdtempSync(join(tmpdir(), 'i116-'));
  process.env.HOME = home;
  const profile = join(home, 'p');
  mkdirSync(profile);
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-mobile-remote': 'file:/fixture' } }));
  const routes = []; const jobs = [];
  const ctx = {
    webServer: { host: '127.0.0.1', port: 39402, register(route) { routes.push(route); return () => {}; } },
    logger: { warn(){}, info(){} },
    get: name => ['agents','sessions'].includes(name) ? { list: () => [], roots: () => [], get: () => undefined } : undefined,
    provide(){}, inject(){}, on: () => () => {}, effect(fn) { return fn(); },
  };
  const config = { path: '/m', authToken: 'a'.repeat(32), cookieName: 'token', trustedHosts: [], sessionTtlMs: 60000,
    rechargeUrl: '', updateDir: '', pluginUpdateManifest: 'npm', updateProfileDir: profile,
    maxConnections: 16, pushUrls: [], pushCooldownMs: 60000, doneGraceMs: 1000, pushContent: 'minimal',
    rateLimit: { maxFailures: 10, windowMs: 60000, blockMs: 60000 }, lanBridge: { enabled: false, host: '127.0.0.1', port: 39402 } };
  const docs = new Map();
  const localVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const { channel, candidate: P } = nextCandidate(localVersion), C = `${P}-app`;
  docs.set('@marktrue/dsh-mobile-remote', { 'dist-tags': { [channel]: P, app: C } });
  docs.set(`@marktrue/dsh-mobile-remote@${P}`, { version: P, dist: { integrity: 'sha512-cGx1Z2lu' },
    optionalDependencies: { '@marktrue/dsh-mobile-remote-app': `npm:@marktrue/dsh-mobile-remote@${C}` } });
  docs.set(`@marktrue/dsh-mobile-remote@${C}`, { version: C, appVersion: `${coreVersion(P)}+39`, dist: { integrity: 'sha512-Y2Fycmllcg==' } });
  apply(ctx, config, { pluginUpdates: {
    npmPackageView: async spec => docs.get(spec) ?? null,
    restartForm: () => 'unsupported',
    schedule: fn => jobs.push(fn),
    runSelfUpdate: async () => { throw new Error('重启通道不应被使用'); },
    hostCapabilities: { packageName: '@marktrue/dsh-mobile-remote', managerAvailable: true, managerReason: '',
      hmrAvailable: true, hmrReason: '', updatable: true, state: 'ready', channel: 'host-manager', installedVersion: localVersion },
    runHostUpdate: async () => hostResult,
  } });
  return { route: routes.find(r => r.kind === 'prefix'), jobs, home };
}

async function request(route, body, path = '/m/api/plugin-update') {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method: path.endsWith('check') || path.endsWith('bootstrap') || path.includes('/log') ? 'GET' : 'POST',
    url: path, headers: { host: '127.0.0.1:39402', 'x-mobile-token': 'a'.repeat(32) }, socket: { remoteAddress: '127.0.0.1' } });
  const chunks = [];
  const res = new Writable({ write(c, _, cb) { chunks.push(Buffer.from(c)); cb(); } });
  res.writeHead = (s) => { res.statusCode = s; return res; };
  const done = once(res, 'finish'); route.handler(req, res); await done;
  const bytes = Buffer.concat(chunks); let json = null; try { json = JSON.parse(bytes.toString()); } catch {}
  return { status: res.statusCode, body: json };
}

test('controller：宿主拒绝的 hostErrorCode/nextAction 进入事务并可从 HTTP 视图读到', async () => {
  const h = harness({ hostResult: { ok: false, channel: 'host-manager', reason: HOST_MANAGER_ERROR.REJECTED,
    from: 'x', to: 'y', step: 'install', restored: false, detail: 'stop-profile',
    hostErrorCode: 'stop-profile', nextAction: HOST_MANAGER_NEXT_ACTION.RESTART_HOST } });
  const before = await request(h.route, undefined, '/m/api/plugin-update/check');
  assert.equal(before.body.pluginUpdate.state, 'update-available', JSON.stringify(before.body));
  const accepted = await request(h.route, {});
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  for (const job of h.jobs) await job();

  // 断了重连/重新检查后，公开状态里的事务摘要必须带两个字段（publicTransaction 白名单）。
  const after = await request(h.route, undefined, '/m/api/plugin-update/check');
  const tx = after.body.pluginUpdate.transaction;
  assert.equal(tx.phase, 'failed');
  assert.equal(tx.result.reason, 'host-manager-rejected');
  assert.equal(tx.result.hostErrorCode, 'stop-profile');
  assert.equal(tx.result.nextAction, 'restart-host');
  assert.ok(!JSON.stringify(after.body).includes('SECRET'), 'diagnostic 不得进入 HTTP 视图');

  // 再次检查后，状态上的动作字段必须清掉（只描述“最近一次宿主拒绝”，不得陈旧挂留）。
  const recheck = await request(h.route, undefined, '/m/api/plugin-update/check');
  assert.equal(recheck.body.pluginUpdate.state, 'update-available');
  assert.equal(recheck.body.pluginUpdate.hostErrorCode, '');
  assert.equal(recheck.body.pluginUpdate.nextAction, '');
});

test('controller：旧插件（无新字段）失败时 result 仍只有 ok/reason（兼容）', async () => {
  const h = harness({ hostResult: { ok: false, channel: 'host-manager', reason: HOST_MANAGER_ERROR.REJECTED,
    from: 'x', to: 'y', step: 'install', restored: false, detail: 'stop-profile' } });
  await request(h.route, undefined, '/m/api/plugin-update/check');
  await request(h.route, {});
  for (const job of h.jobs) await job();
  const after = await request(h.route, undefined, '/m/api/plugin-update/check');
  const result = after.body.pluginUpdate.transaction.result;
  assert.equal(result.reason, 'host-manager-rejected');
  assert.equal('hostErrorCode' in result, false, '没有宿主错误码时不得编造');
  assert.equal('nextAction' in result, false);
});

test('controller：非法 nextAction 被 fail-closed 丢弃（不把任意字符串透给客户端）', async () => {
  const h = harness({ hostResult: { ok: false, channel: 'host-manager', reason: HOST_MANAGER_ERROR.REJECTED,
    from: 'x', to: 'y', step: 'install', restored: false, detail: 'stop-profile',
    hostErrorCode: 'stop-profile', nextAction: '<script>alert(1)</script>' } });
  await request(h.route, undefined, '/m/api/plugin-update/check');
  await request(h.route, {});
  for (const job of h.jobs) await job();
  const after = await request(h.route, undefined, '/m/api/plugin-update/check');
  const result = after.body.pluginUpdate.transaction.result;
  assert.equal(result.hostErrorCode, 'stop-profile');
  assert.equal('nextAction' in result, false, '只接受五个稳定枚举');
});
