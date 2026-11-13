import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { buildReports, publishReports, recoverGlobalHealth, summary, validateMatrix } from '../tools/host-canary/collect.mjs';
import { classify } from '../tools/host-canary/report.mjs';

const sha = 'a'.repeat(40), version = '0.2.2-alpha.2';
const ctx = { runId: '123', runAttempt: '1', pluginSha: sha };
const matrix = { include: [{ hostVersion: version, sources: ['latest', 'alpha'], isCandidate: true }] };
const capabilities = ['jobs.callerShape', 'jobs.eventsApi', 'settings.read', 'gateway.wireStream', 'permissionPresets.apply', 'permissionPresets.catalog', 'workspaceRegistry.stateWrite', 'gateway.eventsPeer', 'subagents.catalog', 'subagents.interrupt'];
const result = (status, overrides = {}) => ({ schema: 1, hostVersion: version, pluginSha: sha, status, stage: status === 'passed' ? 'complete' : 'runtime', checks: status === 'passed' ? ['auth', 'bootstrap', 'diagnostics', ...capabilities.map(name => `host-capability:${name}:ok`)] : status === 'compatibility-failure' ? ['auth'] : [], errorCode: status === 'passed' ? null : status === 'compatibility-failure' ? 'compatibility-check-failed' : 'runtime-timeout', ...overrides });
async function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-canary-collect-test-'));
  const dir = join(root, `host-canary-${version}`);
  mkdirSync(dir);
  try { return await fn({ root, dir, write: (name, obj) => writeFileSync(join(dir, `${name}.json`), JSON.stringify(obj)) }); }
  finally {
    const real = realpathSync(root);
    assert.equal(real, root);
    assert.ok(real.startsWith(join(realpathSync(tmpdir()), 'dsh-canary-collect-test-')));
    rmSync(real, { recursive: true, force: true });
  }
}
test('结果严格绑定版本、SHA、三项检查与CI运行身份', () => fixture(({root,write}) => {
  write('first', result('passed'));
  const [row] = buildReports({matrix,root,...ctx});
  assert.deepEqual(row.data, {schemaVersion:1,hostVersion:version,candidate:true,attempts:[{id:'123-1-1',result:'passed'}]});
  assert.deepEqual(row.sources, ['latest','alpha']);
}));
test('失败需要独立重试；两次兼容失败、后续通过与缺失结果均如实记录', () => fixture(({root,write}) => {
  write('first', result('compatibility-failure'));
  let [row] = buildReports({matrix,root,...ctx});
  assert.equal(row.second.status, 'infrastructure-failure');
  assert.equal(row.second.errorCode, 'missing-or-invalid-retry');
  write('second', result('compatibility-failure'));
  [row] = buildReports({matrix,root,...ctx});
  assert.deepEqual(row.data.attempts, [{id:'123-1-1',result:'compatibility-failure'},{id:'123-1-2',result:'compatibility-failure'}]);
  write('second', result('passed'));
  [row] = buildReports({matrix,root,...ctx});
  assert.equal(row.second.status, 'passed');
  write('first', result('infrastructure-failure',{stage:'install',errorCode:'install-timeout'}));
  write('second', result('compatibility-failure'));
  [row] = buildReports({matrix,root,...ctx});
  const text = summary([{...row,issue:'created',issueNumber:1}],{pluginSha:sha,mode:'daily'});
  assert.ok(text.includes('infrastructure-failure (install-timeout)'));
  assert.ok(text.includes('compatibility-failure'));
}));
test('空文件、错误身份、伪造通过和符号链接均视为基础设施故障', () => fixture(({root,dir,write}) => {
  for (const bad of [result('passed',{pluginSha:'b'.repeat(40)}), result('passed',{hostVersion:'0.2.1-rc.5'}), result('passed',{checks:[]}), result('compatibility-failure',{stage:'install'})]) {
    write('first', bad);
    const [row] = buildReports({matrix,root,...ctx});
    assert.equal(row.first.status, 'infrastructure-failure');
    assert.equal(row.first.errorCode, 'missing-or-invalid-result');
  }
  const link = join(dir,'second.json'); symlinkSync('/etc/passwd',link);
  const [row] = buildReports({matrix,root,...ctx});
  assert.equal(row.second.status,'infrastructure-failure');
}));
test('artifact 目录自身为符号链接时不读取其目标', () => fixture(({root,dir}) => {
  const other='0.2.3';
  writeFileSync(join(dir,'first.json'),JSON.stringify(result('passed',{hostVersion:other})));
  symlinkSync(dir,join(root,`host-canary-${other}`));
  const otherMatrix={include:[{hostVersion:other,sources:['latest'],isCandidate:true}]};
  const [row]=buildReports({matrix:otherMatrix,root,...ctx});
  assert.equal(row.first.status,'infrastructure-failure');
  assert.equal(row.first.errorCode,'missing-or-invalid-result');
  writeFileSync(join(dir,'first.json'),JSON.stringify(result('passed')));
  const rootAlias=join(root,'root-alias'); symlinkSync(root,rootAlias);
  const [aliasRow]=buildReports({matrix,root:rootAlias,...ctx});
  assert.equal(aliasRow.first.status,'infrastructure-failure');
  assert.equal(aliasRow.first.errorCode,'missing-or-invalid-result');
}));
test('兼容失败必须包含顺序正确的认证起始检查，否则按基础设施不确定处理', () => fixture(({root,write}) => {
  for (const checks of [[],['bootstrap'],['auth','diagnostics'],['auth','bootstrap','diagnostics','host-capability:jobs.eventsApi:ok'],['auth','bootstrap','diagnostics',...capabilities.map(name => `host-capability:${name}:ok`)],['auth','bootstrap','diagnostics',...capabilities.map(name => `host-capability:${name}:missing`)]]) {
    write('first',result('compatibility-failure',{checks}));
    write('second',result('compatibility-failure',{checks}));
    const [row] = buildReports({matrix,root,...ctx});
    assert.equal(row.first.status,'infrastructure-failure');
    assert.equal(row.second.status,'infrastructure-failure');
    assert.equal(classify(row.data),'health');
  }
}));
test('健康议题恢复操作不得从最终摘要中丢失', async () => fixture(async ({root,write}) => {
  write('first',result('passed'));
  const entries=buildReports({matrix,root,...ctx});
  const [row]=await publishReports({entries,token:'mock-secret',pluginSha:sha,runId:'123',reportImpl:async () => ({status:'updated',issue:8,health:{status:'updated',issue:9}})});
  assert.deepEqual(row.health,{status:'updated',issue:9});
  const out=summary([row],{pluginSha:sha,mode:'daily'});
  assert.match(out,/健康议题.*updated #9/);
  assert.ok(!out.includes('mock-secret'));
  for (const health of [{status:'updated | mock-secret',issue:9},{status:'updated',issue:'9 | mock-secret'},{status:'updated',issue:-1}]) {
    const [invalid]=await publishReports({entries,token:'mock-secret',pluginSha:sha,runId:'123',reportImpl:async () => ({status:'updated',issue:8,health})});
    assert.equal(invalid.issue,'report-failed');
    assert.ok(!summary([invalid],{pluginSha:sha,mode:'daily'}).includes('mock-secret'));
  }
}));
test('恶意matrix及不可信路径、重复版本和错误CI上下文一律拒绝', () => {
  for(const bad of [null,{include:[]},{include:[{...matrix.include[0],hostVersion:'../../x'}]},{include:[{...matrix.include[0],isCandidate:false}]},{include:[matrix.include[0],matrix.include[0]]},{include:[{...matrix.include[0],sources:['latest\nunsafe']}]}]) assert.throws(()=>validateMatrix(bad));
  assert.throws(()=>buildReports({matrix,root:'relative',...ctx}));
  assert.throws(()=>buildReports({matrix,root:'/tmp',...ctx,runId:'1;evil'}));
  assert.throws(()=>buildReports({matrix,root:'/tmp',...ctx,pluginSha:'secret'}));
});
test('能力三态采用固定白名单；不输出 artifact 内伪造原因或检查项', () => fixture(({root,write}) => {
  const degraded = result('infrastructure-failure', {errorCode:'host-capabilities-inconclusive',checks:['auth','bootstrap','diagnostics',...capabilities.map((name,i)=>`host-capability:${name}:${i===0?'drift':'ok'}`)]});
  write('first', degraded); write('second', degraded);
  const [row] = buildReports({matrix,root,...ctx});
  assert.ok(summary([{...row,issue:'created',issueNumber:1}],{pluginSha:sha,mode:'daily'}).includes('jobs.callerShape:drift'));
  write('first', result('infrastructure-failure',{stage:'sandbox',errorCode:'runtime-sandbox-unavailable'}));
  const [sandbox] = buildReports({matrix,root,...ctx});
  assert.equal(sandbox.first.stage,'sandbox');
  assert.equal(sandbox.first.errorCode,'runtime-sandbox-unavailable');
  assert.equal(classify(sandbox.data),'health');
  for (const code of ['host-process-spawn-failed','host-process-spawn-inconclusive','host-process-exited','host-process-exited-zero','host-process-exited-nonzero','host-process-exited-signal','host-process-exited-hint-eacces','host-process-exited-hint-erofs','host-process-exited-hint-enoent','host-process-exited-hint-enospc','host-process-exited-hint-user-lookup','host-process-exited-hint-module-not-found','host-process-exited-hint-native-load','host-process-exited-hint-startup-audit','host-process-state-inconclusive','host-ready-timeout','host-auth-response-inconclusive','host-identity-inconclusive','host-bundle-unavailable']) {
    write('first', result('infrastructure-failure',{stage:'runtime',errorCode:code}));
    const [row] = buildReports({matrix,root,...ctx});
    assert.equal(row.first.errorCode,code);
    assert.equal(classify(row.data),'health');
  }
  write('first', result('infrastructure-failure',{stage:'secret-token',errorCode:'secret-token'}));
  const [untrusted] = buildReports({matrix,root,...ctx});
  const out = summary([{...untrusted,issue:'created'}],{pluginSha:sha,mode:'daily'});
  assert.ok(!out.includes('secret-token'));
}));
test('完整报告 CLI 严格消费 artifact 并以模拟 GitHub API 输出版本与 SHA', () => fixture(({root,write}) => {
  write('first', result('passed'));
  const source = `globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.github.com/repos/marktrue-ahu/dsh-mobile-remote/issues')) throw new Error('bad destination');
    return new Response(JSON.stringify(init.method === 'GET' ? [] : {number:77}), {status:200});
  };`;
  const preload = `data:text/javascript,${encodeURIComponent(source)}`;
  const env = { ...process.env, GITHUB_RUN_ID:'123', GITHUB_RUN_ATTEMPT:'1', RELEASE_SHA:sha, CANARY_MODE:'daily', CANARY_MATRIX:JSON.stringify(matrix), CANARY_ARTIFACTS:root, RESOLVE_RESULT:'success', SMOKE_RESULT:'success', GH_TOKEN:'mock-secret' };
  delete env.GITHUB_STEP_SUMMARY;
  const p = spawnSync(process.execPath, ['--import', preload, 'tools/host-canary/collect.mjs'], {cwd:new URL('..', import.meta.url),env,encoding:'utf8',timeout:5000});
  assert.equal(p.status,0); assert.ok(p.stdout.includes(version)); assert.ok(p.stdout.includes(sha)); assert.ok(p.stdout.includes('created #77')); assert.ok(!(p.stdout+p.stderr).includes('mock-secret'));
}));
test('解析失败时通过模拟 API 创建全局 health，运行失败且不伪造宿主版本', () => {
  const source = `globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.github.com/repos/marktrue-ahu/dsh-mobile-remote/issues')) throw new Error('bad destination');
    if (init.method !== 'GET' && !JSON.parse(init.body).body.includes('host-canary:health:global')) throw new Error('bad marker');
    return new Response(JSON.stringify(init.method === 'GET' ? [] : {number:88}), {status:200});
  };`;
  const env = {...process.env,GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',RELEASE_SHA:sha,CANARY_MODE:'',CANARY_MATRIX:'',CANARY_ARTIFACTS:'/tmp/no-artifacts',RESOLVE_RESULT:'failure',SMOKE_RESULT:'skipped',GH_TOKEN:'mock-secret'};
  delete env.GITHUB_STEP_SUMMARY;
  const p=spawnSync(process.execPath,['--import',`data:text/javascript,${encodeURIComponent(source)}`,'tools/host-canary/collect.mjs'],{cwd:new URL('..',import.meta.url),env,encoding:'utf8',timeout:5000});
  assert.equal(p.status,1); assert.ok(p.stdout.includes('版本未解析')); assert.ok(p.stdout.includes('created #88')); assert.ok(!(p.stdout+p.stderr).includes('mock-secret'));
});
test('真实报告链遇到已关闭的全局健康议题时不写入且在摘要标明未通知', () => {
  const source = `globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.github.com/repos/marktrue-ahu/dsh-mobile-remote/issues')) throw new Error('bad destination');
    if (init.method !== 'GET') throw new Error('unexpected write');
    return new Response(JSON.stringify([{number:99,state:'closed',state_reason:'completed',body:'<!-- host-canary:health:global -->',user:{id:41898282,login:'github-actions[bot]',type:'Bot'}}]), {status:200});
  };`;
  const env = {...process.env,GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',RELEASE_SHA:sha,CANARY_MODE:'',CANARY_MATRIX:'',CANARY_ARTIFACTS:'/tmp/no-artifacts',RESOLVE_RESULT:'failure',SMOKE_RESULT:'skipped',GH_TOKEN:'mock-secret'};
  delete env.GITHUB_STEP_SUMMARY;
  const p=spawnSync(process.execPath,['--import',`data:text/javascript,${encodeURIComponent(source)}`,'tools/host-canary/collect.mjs'],{cwd:new URL('..', import.meta.url),env,encoding:'utf8',timeout:5000});
  assert.equal(p.status,1);
  assert.match(p.stdout,/health-unreported #99/);
  assert.match(p.stdout,/全局健康议题已关闭.*未自动重开或向议题追加通知/);
  assert.ok(!(p.stdout+p.stderr).includes('mock-secret'));
});
test('只有全部成功才尝试给既有全局 health issue 追加恢复状态', async () => fixture(async ({root,write}) => {
  write('first', result('passed'));
  const entries = buildReports({matrix,root,...ctx}).map(row => ({...row,issue:'unchanged'}));
  let calls = 0;
  const options = {results:entries,smokeResult:'success',...ctx,token:'mock-secret',reportImpl:async (data) => { calls++; assert.deepEqual(data,{schemaVersion:1,hostVersion:null,candidate:false,attempts:[{id:'123-1-1',result:'passed'}]}); return {status:'updated',issue:99}; }};
  assert.deepEqual(await recoverGlobalHealth(options),{status:'updated',issue:99});
  assert.equal(calls,1);
  for (const failure of [
    {...options,smokeResult:'failure'},
    {...options,results:entries.map(r=>({...r,issue:'report-failed'}))},
    {...options,results:entries.map(r=>({...r,second:{status:'infrastructure-failure'}}))},
    {...options,results:[]},
  ]) assert.deepEqual(await recoverGlobalHealth(failure),{status:'not-attempted'});
  assert.equal(calls,1);
}));
test('全局健康议题已关闭时，复发仅显示固定未通知警告，不伪称已创建或更新', async () => {
  const entries = [{ data: { hostVersion:null }, sources:[], first:{status:'infrastructure-failure',stage:'resolve',errorCode:'resolution-or-context-failed'} }];
  const [row] = await publishReports({entries,token:'mock-secret',pluginSha:sha,runId:'123',reportImpl:async () => ({status:'health-unreported',issue:99})});
  assert.equal(row.issue,'health-unreported');
  const out = summary([row],{pluginSha:sha,mode:'unavailable'});
  assert.match(out,/全局健康议题已关闭.*未自动重开或向议题追加通知/);
  assert.match(out,/health-unreported #99/);
  assert.ok(!out.includes('mock-secret'));
});
test('报告串行执行，不传播敏感异常；摘要只输出被验证的字段', async () => fixture(async ({root,write}) => {
  write('first', result('passed',{errorCode:null}));
  const entries = buildReports({matrix,root,...ctx});
  const outputs = await publishReports({entries,token:'secret',pluginSha:sha,runId:'123',reportImpl:async (data) => { assert.equal(data.hostVersion,version);throw new Error('secret'); }});
  assert.equal(outputs[0].issue,'report-failed');
  const out = summary(outputs,{pluginSha:sha,mode:'daily'});
  assert.ok(out.includes(version)); assert.ok(!out.includes('secret'));
  assert.match(out, /报告代码来自当前 develop 提交/);
  assert.match(out, /schema 校验不能独立证明观测真实性/);
}));
