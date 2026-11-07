// 验证：宿主管理器通道在 harness 里被选中并完成（不触发重启 runner）
import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable, Writable } from 'node:stream';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { apply } from '../lib/index.js';

const AUTH_TOKEN = 'a'.repeat(32);
let home = '';

function harness() {
  // 每个用例独立 HOME：事务文件/锁不跨用例残留。
  home = mkdtempSync(join(tmpdir(), 'hostchan-'));
  process.env.HOME = home;
  const profile = join(home, `p-${Math.random().toString(36).slice(2)}`);
  mkdirSync(profile);
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-mobile-remote': 'file:/fixture' } }));
  const routes = []; const jobs = [];
  let hostUpdateCalls = 0;
  const ctx = {
    webServer: { host: '127.0.0.1', port: 39402, register(route) { routes.push(route); return () => {}; } },
    logger: { warn(){}, info(){} },
    get: name => ['agents','sessions'].includes(name) ? { list: () => [], roots: () => [], get: () => undefined } : undefined,
    provide(){}, inject(){}, on: () => () => {}, effect(fn) { return fn(); },
  };
  const config = { path: '/m', authToken: AUTH_TOKEN, cookieName: 'token', trustedHosts: [], sessionTtlMs: 60000,
    rechargeUrl: '', updateDir: '', pluginUpdateManifest: 'npm', updateProfileDir: profile,
    maxConnections: 16, pushUrls: [], pushCooldownMs: 60000, doneGraceMs: 1000, pushContent: 'minimal',
    rateLimit: { maxFailures: 10, windowMs: 60000, blockMs: 60000 }, lanBridge: { enabled: false, host: '127.0.0.1', port: 39402 } };
  const docs = new Map();
  const P = '3.2.4-alpha.8', C = `${P}-app`;
  docs.set('@marktrue/dsh-mobile-remote', { 'dist-tags': { latest: '3.2.4-alpha.5', alpha: P, app: C } });
  docs.set(`@marktrue/dsh-mobile-remote@${P}`, { version: P, dist: { integrity: 'sha512-cGx1Z2lu' },
    optionalDependencies: { '@marktrue/dsh-mobile-remote-app': `npm:@marktrue/dsh-mobile-remote@${C}` } });
  docs.set(`@marktrue/dsh-mobile-remote@${C}`, { version: C, appVersion: '3.2.4+39', dist: { integrity: 'sha512-Y2Fycmllcg==' } });
  apply(ctx, config, { pluginUpdates: {
    npmPackageView: async spec => docs.get(spec) ?? null,
    restartForm: () => 'unsupported',
    schedule: fn => jobs.push(fn),
    runSelfUpdate: async () => { throw new Error('重启通道不应被使用'); },
    hostCapabilities: { packageName: '@marktrue/dsh-mobile-remote', managerAvailable: true, managerReason: '',
      hmrAvailable: true, hmrReason: '', updatable: true, state: 'ready', channel: 'host-manager', installedVersion: '3.2.4-alpha.5' },
    runHostUpdate: async ({ targetVersion }) => { hostUpdateCalls++; return { ok: true, channel: 'host-manager', reason: '', from: '3.2.4-alpha.5', to: targetVersion, step: 'install', restored: false }; },
  } });
  return { route: routes.find(r => r.kind === 'prefix'), jobs, profile, get calls() { return hostUpdateCalls; } };
}
async function request(route, body, path = '/m/api/plugin-update') {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method: path.endsWith('check') || path.endsWith('bootstrap') || path.includes('/update/') || path.includes('/log') ? 'GET' : 'POST',
    url: path, headers: { host: '127.0.0.1:39402', 'x-mobile-token': AUTH_TOKEN }, socket: { remoteAddress: '127.0.0.1' } });
  const chunks = [];
  const res = new Writable({ write(c, _, cb) { chunks.push(Buffer.from(c)); cb(); } });
  res.writeHead = (s) => { res.statusCode = s; return res; };
  const done = once(res, 'finish'); route.handler(req, res); await done;
  const bytes = Buffer.concat(chunks); let json = null; try { json = JSON.parse(bytes.toString()); } catch {}
  return { status: res.statusCode, body: json };
}

test('宿主管理器通道：capabilities 报 host-manager，提交后不走重启 runner', async () => {
  const h = harness();
  const boot = await request(h.route, undefined, '/m/api/bootstrap');
  assert.equal(boot.status, 200);
  assert.equal(boot.body.pluginUpdate.updateChannel, 'host-manager');
  assert.equal(boot.body.pluginUpdate.canSelfUpdate, true);
  assert.equal(boot.body.pluginUpdate.canRestartHost, false);
  assert.equal(boot.body.pluginUpdate.restartForm, 'unsupported');
  assert.match(boot.body.pluginUpdate.updateChannelDescription, /无需重启/);
  // guidance 也必须描述真实通道，而不是让用户去跑 pnpm install
  assert.equal(boot.body.pluginUpdate.guidance.mode, 'auto');
  assert.deepEqual(boot.body.pluginUpdate.guidance.commands, []);
});

test('宿主管理器通道：提交走 runHostUpdate，事务 settled 且不重启', async () => {
  const h = harness();
  const before = await request(h.route, undefined, '/m/api/plugin-update/check');
  assert.equal(before.body.pluginUpdate.state, 'update-available', JSON.stringify(before.body));

  const accepted = await request(h.route, {});
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.action, 'accepted');
  assert.equal(accepted.body.channel, 'host-manager');
  const opId = accepted.body.opId;
  assert.ok(opId);

  // 排队的 worker 必须由 schedule 驱动（测试里手动跑）
  assert.equal(h.jobs.length >= 1, true);
  for (const job of h.jobs) await job();
  assert.equal(h.calls, 1, '应调用宿主管理器一次');

  const { readTransaction, transactionFile } = await import('../lib/plugin-update-transaction.js');
  const tx = readTransaction(transactionFile(home));
  assert.equal(tx.opId, opId);
  assert.equal(tx.phase, 'settled');
  assert.equal(tx.hostManager, true);
  assert.equal(tx.result.ok, true);
  assert.equal(tx.result.matched, 'host-manager');
});
