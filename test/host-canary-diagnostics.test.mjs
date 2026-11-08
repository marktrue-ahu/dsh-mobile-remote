import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { HINT_CODES, INSTALL_ERROR_CODES } from '../tools/host-canary/diagnostics.mjs';
import { makeRuntimeWorker, makeInstallWorker, runMockDockerCommand, dockerCliDriver, parseWorkerOutput, createStderrCollector } from '../tools/host-canary/smoke.mjs';
import { buildReports } from '../tools/host-canary/collect.mjs';
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const id = 'c'.repeat(64);
const privateText = "credential='synthetic-private-token' hostname='internal.example' authToken='" + 'a'.repeat(64) + "' /private/path";
async function fixture(t, prefix = 'canary-test-') {
  const root = await mkdtemp(join(await realpath(tmpdir()),prefix));
  t.after(() => rm(root,{recursive:true,force:true}));
  return root;
}
function generatedFailure(raw) {
  const original=makeRuntimeWorker();
  const start=original.indexOf("try {\n  const base = '/tmp/canary'");
  const end=original.indexOf('} catch (error) {',start);
  assert.ok(start>0&&end>start);
  return original.slice(0,start)+`try { stderrCollector={destroy(){}}; throw Object.assign(new Error(${JSON.stringify(raw)}),{code:'host-process-exited-hint-module-not-found'}); `+original.slice(end);
}
async function generatedDocker(root,raw) {
  const worker=join(root,'generated-worker.mjs'),binary=join(root,'mock-docker');
  await writeFile(worker,generatedFailure(raw));
  await writeFile(binary,'#!/usr/bin/env node\n'+
    "const {spawnSync}=require('node:child_process');if(process.argv[2]==='wait'){process.stdout.write('2\\n');process.stderr.write('ordinary warning\\n');}else{const r=spawnSync(process.execPath,["+JSON.stringify(worker)+"],{encoding:'utf8'});process.stdout.write(r.stdout);process.stderr.write('HOST_DIAG: injected-secret /private/path\\n');if(r.status!==2)process.exit(3);}",{mode:0o700});
  return binary;
}

test('generated worker no longer emits temporary diagnostics or raw secrets', () => {
  const result=spawnSync(process.execPath,['--input-type=module','--eval',generatedFailure(privateText)],{encoding:'utf8',timeout:5000});
  assert.equal(result.status,2,result.stderr);assert.equal(result.stderr,'');
  assert.deepEqual(JSON.parse(result.stdout),{ok:false,errorCode:'host-process-exited-hint-module-not-found',checks:[]});
  assert.doesNotMatch(result.stdout,/HOST_DIAG|synthetic-private-token|internal\.example|a{64}|private/);
});

test('Docker warnings never contaminate stdout IDs/statuses or ordinary command results', async () => {
  const commands = [];
  const driver = dockerCliDriver(async args => {
    commands.push(args[0]);
    if (args[0] === 'create') return {code:0,stdout:id,stderr:'harmless warning'};
    if (args[0] === 'wait') return {code:0,stdout:'2',stderr:'harmless warning'};
    if (args[0] === 'logs') return {code:0,stdout:JSON.stringify({ok:false,errorCode:'worker-failed',checks:[]}),stderr:'harmless daemon warning'};
    throw Error('unexpected operation');
  });
  assert.equal(await driver.create(['create']),id);
  assert.equal((await driver.wait(id,undefined,'runtime')).errorCode,'worker-failed');
  assert.deepEqual(commands,['create','wait','logs']);
});

test('real command capture ignores stderr and relays only fixed worker result', async t => {
  const root=await fixture(t), binary=await generatedDocker(root,privateText);
  const harness=`import {runMockDockerCommand,dockerCliDriver} from ${JSON.stringify(new URL('../tools/host-canary/smoke.mjs',import.meta.url).href)};
    const driver=dockerCliDriver(args=>runMockDockerCommand(${JSON.stringify(binary)},args,{env:{PATH:process.env.PATH},timeout:3000}));
    const result=await driver.wait(${JSON.stringify(id)},undefined,'runtime');process.stdout.write(JSON.stringify(result));`;
  const r=spawnSync(process.execPath,['--input-type=module','--eval',harness],{encoding:'utf8',timeout:10000});
  assert.equal(r.status,0,r.stderr);assert.equal(r.stderr,'');
  assert.equal(JSON.parse(r.stdout).errorCode,'host-process-exited-hint-module-not-found');
  assert.doesNotMatch(r.stdout,/HOST_DIAG|injected-secret|private/);
});

test('malformed runtime payload is rejected with a fixed error', () => {
  for (const data of [null,{}, {ok:false,errorCode:'worker-failed'}, {ok:true,checks:null},{ok:true,checks:'secret'}]) {
    assert.throws(()=>parseWorkerOutput('runtime',2,data),e=>e.code==='docker-output-invalid');
  }
});

test('every specific code survives the actual generated catch, driver and artifact collector', async t => {
  const root = await fixture(t), sha='a'.repeat(40), version='0.2.2-rc.1';
  const dir=join(root,'host-canary-'+version);await mkdir(dir);
  const original=makeRuntimeWorker();
  const start=original.indexOf("try {\n  const base = '/tmp/canary'");
  const end=original.indexOf('} catch (error) {',start);
  assert.ok(start>0&&end>start);
  for(const code of HINT_CODES){
    // Run the *generated catch* in a subprocess without evaluating plugin code or
    // starting a host. This tests exactly the closure that was previously missing codes.
    const script=original.slice(0,start)+`try { throw Object.assign(new Error('synthetic-private-token'),{code:${JSON.stringify(code)}}); `+original.slice(end);
    const r=spawnSync(process.execPath,['--input-type=module','--eval',script],{encoding:'utf8',timeout:5000});
    assert.equal(r.status,2,code);assert.equal(r.stderr,'',code);
    const data=JSON.parse(r.stdout);assert.equal(data.errorCode,code);
    const driver=dockerCliDriver(async args=>({code:0,stdout:args[0]==='wait'?'2':r.stdout}));
    assert.equal((await driver.wait(id,undefined,'runtime')).errorCode,code);
    for(const name of ['first','second'])await writeFile(join(dir,name+'.json'),JSON.stringify({schema:1,hostVersion:version,pluginSha:sha,status:'infrastructure-failure',stage:'runtime',errorCode:code,checks:[]}));
    const [row]=buildReports({matrix:{include:[{hostVersion:version,sources:['latest'],isCandidate:true}]},root,runId:'123',runAttempt:'1',pluginSha:sha});
    assert.equal(row.first.errorCode,code);assert.equal(row.second.errorCode,code);
  }
});

test('generated import preflight preserves error.code before a collector exists', () => {
  const original=makeRuntimeWorker();
  const bodyStart=original.indexOf("try {\n  const base = '/tmp/canary'");
  const catchStart=original.indexOf('} catch (error) {',bodyStart);
  const checkStart=original.indexOf('  // Self-check BEFORE spawning the host:');
  const checkEnd=original.indexOf('  // Capture stdout as well as stderr:',checkStart);
  assert.ok(checkStart>bodyStart&&checkEnd>checkStart);
  for(const [errorCode,message,expected] of [
    ['MODULE_NOT_FOUND','synthetic-private-token','host-plugin-import-missing-module'],
    ['ERR_DLOPEN_FAILED','synthetic-private-token','host-plugin-import-native-load'],
    ['ERR_MODULE_NOT_FOUND',"Cannot find package 'qrcode'",'host-process-exited-hint-missing-qrcode'],
  ]){
    let block=original.slice(checkStart,checkEnd);
    const expression="await import('/profile/dsh/profiles/canary/node_modules/@marktrue/dsh-mobile-remote/lib/index.js')";
    assert.ok(block.includes(expression));
    block=block.replace(expression,`await Promise.reject(Object.assign(new Error(${JSON.stringify(message)}),{code:${JSON.stringify(errorCode)}}))`);
    const script=original.slice(0,bodyStart)+'try {\n'+block+original.slice(catchStart);
    const r=spawnSync(process.execPath,['--input-type=module','--eval',script],{encoding:'utf8',timeout:5000});
    assert.equal(r.status,2);assert.equal(r.stderr,'');assert.equal(JSON.parse(r.stdout).errorCode,expected);
    assert.doesNotMatch(r.stdout,/synthetic-private-token/);
  }
});

test('actual generated install preflight failure serializes exactly one JSON', () => {
  let script=makeInstallWorker('0.2.2-rc.1');
  script=script.replace("import { execFileSync } from 'node:child_process';",'const execFileSync = () => {};');
  script=script.replace("import { mkdirSync, symlinkSync } from 'node:fs';",'const mkdirSync = () => {}, symlinkSync = () => {};');
  script=script.replace("const packed = (await import('node:fs')).readdirSync('/tmp/plugin-dist').filter(f => f.endsWith('.tgz'));","const packed = ['fixture.tgz'];");
  script=script.replace("const { createRequire } = await import('node:module');","const createRequire = () => ({resolve() { throw new Error('synthetic-private-token'); }});");
  const r=spawnSync(process.execPath,['--input-type=module','--eval',script],{encoding:'utf8',timeout:5000});
  assert.equal(r.status,2);assert.equal(r.stderr,'');
  const data=JSON.parse(r.stdout);assert.equal(data.errorCode,'host-process-exited-hint-missing-schemastery');
  assert.equal(parseWorkerOutput('install',2,data).errorCode,data.errorCode);
  for(const code of INSTALL_ERROR_CODES)assert.equal(parseWorkerOutput('install',2,{ok:false,errorCode:code}).errorCode,code);
});

test('stdout finishing first does not discard later stderr during the shared drain budget', async () => {
  const out=new PassThrough(), err=new PassThrough(), collector=createStderrCollector(err,out);
  try {
    let drained=false;const pending=collector.drain(250).then(()=>{drained=true;});
    out.end();await new Promise(r=>setImmediate(r));assert.equal(drained,false);
    err.end('EROFS');await pending;
    assert.equal(collector.hint(),'host-process-exited-hint-erofs');
    assert.equal(out.listenerCount('end'),0);assert.equal(err.listenerCount('end'),0);
  } finally {collector.destroy();}
});

test('actual workflow Bash retries without logging or uploading diagnostic text', async t => {
  const root=await fixture(t),tool=join(root,'tools/host-canary'),runner=join(root,'runner');
  await mkdir(tool,{recursive:true});await mkdir(runner);
  await writeFile(join(tool,'smoke.mjs'),`import {writeFileSync} from 'node:fs';
    const out=process.argv[process.argv.indexOf('--out')+1];
    writeFileSync(out,JSON.stringify({attempt:out.endsWith('first.json')?1:2}));
    process.stdout.write('HOST_DIAG: injected-secret /private/path\\n');
    process.stderr.write('HOST_DIAG: injected-secret /private/path\\n');process.exit(2);`);
  const yml=await readFile(join(repo,'.github/workflows/host-compatibility-canary.yml'),'utf8');
  const block=yml.match(/- name: Isolated host smoke and independent retry[\s\S]*?run: \|\n([\s\S]*?)\n      - name:/)?.[1];
  assert.ok(block);const script=block.split('\n').map(l=>l.replace(/^          /,'')).join('\n');
  const r=spawnSync('bash',['--noprofile','--norc','-e','-o','pipefail','-c',script],{cwd:root,encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH,RUNNER_TEMP:runner,GITHUB_WORKSPACE:root,HOST_VERSION:'0.2.2-rc.1'}});
  assert.equal(r.status,0,r.stderr);assert.equal(r.stderr,'');
  assert.doesNotMatch(r.stdout,/HOST_DIAG|injected-secret|private\/path/);
  assert.match(r.stdout,/first=2 second=2/);
  for(const attempt of ['first','second'])assert.ok(JSON.parse(await readFile(join(runner,'canary-results',attempt+'.json'),'utf8')));
  assert.match(yml,/path: \$\{\{ runner\.temp \}\}\/canary-results\/\*\.json/);
  assert.doesNotMatch(yml,/HOST_DIAG|print-diagnostics/);
});

test('child host disables only native cache without weakening noexec isolation', () => {
  const script=makeRuntimeWorker();
  assert.match(script,/env:\{\.\.\.process\.env,NARB_DISABLE_NATIVE_CACHE:'1'\}/);
  assert.doesNotMatch(script,/--expose-internals/);
});
