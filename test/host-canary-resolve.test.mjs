import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { FIXED_HOSTS, isExactVersion, resolveMatrix, resolveSnapshot } from '../tools/host-canary/resolve.mjs';

const tags = { latest: '0.2.1-rc.5', next: '0.2.1-rc.5', alpha: '0.2.2-alpha.2' };
test('每日只解析各标签一次并按精确版本去重', () => {
  assert.deepEqual(resolveMatrix(tags, 'daily'), {
    schema: 1, mode: 'daily', hosts: [
      { hostVersion: '0.2.1-rc.5', sources: ['latest', 'next'], isCandidate: true },
      { hostVersion: '0.2.2-alpha.2', sources: ['alpha'], isCandidate: true },
    ],
  });
});
test('每周固定两版本，加本轮 latest；若重合保留两个来源并只运行一次', () => {
  assert.deepEqual(FIXED_HOSTS, ['0.2.0-rc.2', '0.2.1-rc.5']);
  const result = resolveMatrix(tags, 'weekly');
  assert.deepEqual(result.hosts, [
    { hostVersion: '0.2.0-rc.2', sources: ['fixed'], isCandidate: false },
    { hostVersion: '0.2.1-rc.5', sources: ['fixed', 'latest'], isCandidate: true },
  ]);
  const newer = resolveMatrix({ latest: '0.2.2-alpha.2' }, 'weekly');
  assert.equal(newer.hosts.length, 3);
  assert.deepEqual(newer.hosts[2], { hostVersion: '0.2.2-alpha.2', sources: ['latest'], isCandidate: true });
});
test('只接受明确版本，不接受range、tag、命令或前导零', () => {
  for (const value of ['0.2.1-rc.5', '1.0.0', '0.2.2-alpha.12']) assert.equal(isExactVersion(value), true);
  for (const value of ['latest', '^0.2.0', '0.2.0;touch /tmp/a', '0.2.0$(id)', '01.2.3', '0.2.1-rc.01', '../2.0.0', '', null, 'x'.repeat(101)]) assert.equal(isExactVersion(value), false, String(value));
  for (const value of [null, {}, { ...tags, next: 'latest' }, { ...tags, alpha: '1.2.3\nMATRIX=hack' }]) assert.throws(() => resolveMatrix(value, 'daily'));
  assert.throws(() => resolveMatrix(tags, 'invalid'), /invalid-mode/);
});
test('仅向固定 registry 请求一次快照，限制超时且拒绝重定向', async () => {
  let calls = 0;
  const result = await resolveSnapshot({ mode: 'daily', fetchImpl: async (url, opts) => {
    calls++;
    assert.equal(url, 'https://registry.npmjs.org/-/package/@deepseek-ai%2Fdsh/dist-tags');
    assert.equal(opts.redirect, 'error');
    assert.ok(opts.signal instanceof AbortSignal);
    assert.ok(!JSON.stringify(opts.headers).includes('Authorization'));
    return new Response(JSON.stringify(tags), { status: 200 });
  } });
  assert.equal(calls, 1);
  assert.equal(result.hosts.length, 2);
});
test('网络/registry/数据错误是基础设施失败，不伪造兼容性结论', async () => {
  await assert.rejects(resolveSnapshot({ mode: 'daily', fetchImpl: async () => { throw new Error('secret'); } }), /registry-unreachable/);
  await assert.rejects(resolveSnapshot({ mode: 'daily', fetchImpl: async () => new Response('{}', { status: 503 }) }), /registry-http-503/);
  await assert.rejects(resolveSnapshot({ mode: 'daily', fetchImpl: async () => new Response('not json') }), /invalid-dist-tags-json/);
});
test('CLI 非法模式不查询任何远端', () => {
  const p = spawnSync(process.execPath, ['tools/host-canary/resolve.mjs', 'invalid'], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 5000 });
  // 不允许无效模式进入网络请求：该断言要求 CLI 在联网前校验参数。
  assert.equal(p.status, 1);
  assert.match(p.stderr, /invalid-mode/);
});
