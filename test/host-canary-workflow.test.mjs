import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
const workflow = readFileSync(new URL('../.github/workflows/host-compatibility-canary.yml', import.meta.url), 'utf8');
const section = (begin, end) => workflow.slice(workflow.indexOf(`  ${begin}:`), end ? workflow.indexOf(`  ${end}:`) : undefined);

test('计划与手动模式明确；仅固定 fork/develop 允许执行', () => {
  assert.match(workflow, /cron: '17 3 \* \* \*'/);
  assert.match(workflow, /cron: '47 3 \* \* 0'/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /default: daily/);
  assert.match(workflow, /group: host-compatibility-canary/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /id-token:|npm publish|push:\s*$/m);
  const guard = section('validate','resolve');
  assert.match(guard, /marktrue-ahu\/dsh-mobile-remote/);
  assert.match(guard, /refs\/heads\/develop/);
  assert.match(guard, /exit 1/);
  assert.match(section('resolve','smoke'), /needs: validate/);
});
test('实际 shell 入口拒绝错误上下文，避免任务全 skipped 却显示成功', () => {
  const guard = section('validate','resolve');
  const script = guard.split('        run: |\n')[1].split('\n').map(l=>l.startsWith('          ')?l.slice(10):l).join('\n');
  for (const [repo,ref,event,want] of [
    ['marktrue-ahu/dsh-mobile-remote','refs/heads/develop','schedule',0],
    ['marktrue-ahu/dsh-mobile-remote','refs/heads/develop','workflow_dispatch',0],
    ['marktrue-ahu/dsh-mobile-remote','refs/heads/main','workflow_dispatch',1],
    ['other/repo','refs/heads/develop','schedule',1],
    ['marktrue-ahu/dsh-mobile-remote','refs/heads/develop','push',1],
  ]) {
    const p = spawnSync('bash',['-c',script],{env:{PATH:process.env.PATH,GITHUB_REPOSITORY:repo,GITHUB_REF:ref,GITHUB_EVENT_NAME:event},encoding:'utf8',timeout:3000});
    assert.equal(p.status,want);
  }
});
test('真实模式 shell 将每日、每周和手动选择映射正确并拒绝未知调度', () => {
  const block = workflow.split('      - name: Determine check mode\n')[1].split('      - name: Resolve one immutable dist-tag snapshot\n')[0];
  const script = block.split('        run: |\n')[1].split('\n').map(l=>l.startsWith('          ')?l.slice(10):l).join('\n');
  const root = mkdtempSync(join(tmpdir(),'dsh-canary-workflow-test-'));
  const output = join(root,'output');
  try {
    for (const [event,schedule,mode,want,status] of [
      ['schedule','17 3 * * *','','daily',0],
      ['schedule','47 3 * * 0','','weekly',0],
      ['workflow_dispatch','','daily','daily',0],
      ['workflow_dispatch','','weekly','weekly',0],
      ['schedule','0 0 * * *','','',1],
      ['workflow_dispatch','','unexpected','',1],
    ]) {
      writeFileSync(output,'');
      const p = spawnSync('bash',['-c',script],{env:{PATH:process.env.PATH,EVENT:event,SCHEDULE:schedule,DISPATCH_MODE:mode,GITHUB_OUTPUT:output},encoding:'utf8',timeout:3000});
      assert.equal(p.status,status);
      if (status === 0) assert.equal(readFileSync(output,'utf8'),`mode=${want}\n`);
      else assert.match(p.stdout,/::error::/);
    }
  } finally {
    const real = realpathSync(root);
    assert.equal(real, root);
    assert.ok(real.startsWith(join(realpathSync(tmpdir()),'dsh-canary-workflow-test-')));
    rmSync(real,{recursive:true,force:true});
  }
});
test('宿主job无issue写权限或可选token；仅独立报告job拥有issue写权限', () => {
  const smoke = section('smoke','report'), reporter = section('report');
  assert.match(smoke,/contents: read/);
  assert.doesNotMatch(smoke,/issues: write|GH_TOKEN|secrets\./);
  assert.match(smoke,/--host-version "\$HOST_VERSION"/);
  assert.match(smoke,/first\.json/); assert.match(smoke,/second\.json/);
  assert.match(smoke,/if \[ "\$first" -ne 0 \]/);
  assert.match(reporter,/issues: write/);
  assert.match(reporter,/GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(reporter,/run: node tools\/host-canary\/collect\.mjs/);
  for(const line of workflow.split('\n').filter(l=>l.includes('uses:'))) assert.match(line,/uses: actions\/[a-z-]+@[0-9a-f]{40} # v[0-9]+/);
  assert.match(workflow,/persist-credentials: false/);
});
