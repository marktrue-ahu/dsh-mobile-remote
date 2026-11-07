import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink, lstat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { DOCKER_IMAGE, HINT_CODES, MISSING_DEPENDENCY_SPECIFIERS, RUNTIME_LIFECYCLE_MS, checkHostedRunner, createChildExitObserver, createDockerExecutor, createLinuxChildMonitor, createSourceArchive, createStderrCollector, dockerCliDriver, dockerCreatePlan, dockerModelAdapter, evaluateResponses, gitArchiveArgs, hostedDockerAdapter, libSnapshot, makeInstallWorker, makeRuntimeWorker, managedDocker, probeMobile, profileFiles, prepareContainerProfile, removeSourceArchive, readLinuxProcessStat, resolveExitedChildHint, runCanary, stderrExitHint, validateDockerMounts, verifyDockerInspection, verifyInstalled, verifyPluginSource, verifyRequiredBundles } from '../tools/host-canary/smoke.mjs';

const imageEnv = ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','NODE_VERSION=24.1.0','YARN_VERSION=1.22.22'];
const profileEnvFor = phase => { const base = phase === 'install' ? '/profile' : '/tmp/canary'; return [`HOME=${base}/home`,`DSH_HOME=${base}/dsh`,`XDG_CONFIG_HOME=${base}/xdg-config`,`XDG_CACHE_HOME=${base}/xdg-cache`,`XDG_DATA_HOME=${base}/xdg-data`,`XDG_STATE_HOME=${base}/xdg-state`,`XDG_RUNTIME_DIR=${base}/xdg-runtime`,`NPM_CONFIG_USERCONFIG=${base}/npmrc`,`NPM_CONFIG_GLOBALCONFIG=${base}/npm-globalrc`]; };
const securityFor = options => ({image:DOCKER_IMAGE,user:`${options.uid}:${options.gid}`,network:options.phase === 'install' ? 'bridge' : 'none',readonly:true,privileged:false,pidMode:'',ipcMode:'private',publishAll:false,pids:256,memory:2147483648,capDrop:['ALL'],securityOpt:['no-new-privileges'],ports:null,capAdd:null,devices:[],deviceRequests:null,groupAdd:null,tmpfs:{'/tmp':'rw,noexec,nosuid,nodev,size=128m'},entrypoint:['node'],cmd:['--input-type=module','--eval',options.phase === 'install' ? makeInstallWorker(options.hostVersion ?? '1.2.3') : makeRuntimeWorker()],env:[...imageEnv,...profileEnvFor(options.phase)],mounts:[{type:'bind',source:options.profile,destination:'/profile',rw:options.phase === 'install'},...(options.phase === 'install' ? [{type:'bind',source:options.source,destination:'/source',rw:false}] : [])]});

test('proposed container worker generates token only in runtime tmpfs', () => {
  const script = makeRuntimeWorker();
  const checked = spawnSync(process.execPath,['--check','--input-type=module'],{input:script,encoding:'utf8'});
  assert.equal(checked.status,0,checked.stderr);
  assert.match(script,/randomBytes\(32\)/);
  assert.match(script,/const base = '\/tmp\/canary'/);
  assert.doesNotMatch(script,/readFile\('\/profile\/token'/);
  assert.match(script,/127\.0\.0\.1/);
  assert.doesNotMatch(script,/3080|console\.log|process\.env\..*TOKEN/);
  // stdout is captured as well as stderr: a startup failure may be reported on
  // stdout, and discarding it left only a catch-all code with no signal.
  assert.match(script,/stdio:\['ignore','pipe','pipe'\]/);
  // The collector must be constructed over BOTH streams.
  assert.match(script,/createStderrCollector\(child\.stderr, child\.stdout\)/);
  // Buffer stays bounded (4096) but retains the NEWEST bytes, so a failure at the
  // end of a long stream is still visible.
  assert.match(script,/const LIMIT = 4096;/);
  assert.match(script,/prefix = \(prefix \+ chunk\)\.slice\(-LIMIT\);/);
  assert.match(script,/stderrCollector\?\.destroy\(\)/);
  assert.doesNotMatch(script,/JSON\.stringify\([^\n]*prefix/);
  for (const code of ['host-process-spawn-failed','host-process-spawn-inconclusive','host-process-exited','host-process-exited-zero','host-process-exited-nonzero','host-process-exited-signal','host-process-exited-hint-eacces','host-process-exited-hint-erofs','host-process-exited-hint-enoent','host-process-exited-hint-enospc','host-process-exited-hint-user-lookup','host-process-exited-hint-module-not-found','host-process-exited-hint-native-load','host-process-exited-hint-startup-audit','host-process-state-inconclusive','host-ready-timeout','host-auth-response-inconclusive']) assert.ok(script.includes(`'${code}'`));
});

// KNOWN-FLAKY #40: this fixture spawns a real fake-host process per mode and
// confirms its identity through /proc. Under load the fixture's own start can
// exceed the fixed wait window, so it intermittently reports "fake host identity
// unavailable" (measured 30-60% on a busy machine, 0% once warmed). That failure
// is fixture timing, not a product defect: the hint/exit-code behaviour it
// exercises is also covered by deterministic tests that inject childState and
// childExitHint directly. Do not treat a flake here as a product regression, and
// do not weaken the security assertions to make it pass.
test('generated worker emits a sanitized hint using only a fake host', async t => {
  if (process.platform !== 'linux') return t.skip('generated worker uses Linux /proc');
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(join(parent,'canary-worker-test-'));
  const expected = join(parent,basename(root));
  const created = await lstat(root);
  const unconfirmed = new Set();
  t.after(async () => {
    // Never remove the fixture while an owned fake host is unconfirmed.
    if (unconfirmed.size) throw Error('fake host exit unconfirmed; fixture retained');
    const info = await lstat(root);
    assert.ok(isAbsolute(root) && /^canary-worker-test-[A-Za-z0-9]+$/.test(basename(root)));
    assert.ok(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0);
    assert.equal(info.uid,process.getuid()); assert.equal(info.dev,created.dev); assert.equal(info.ino,created.ino);
    assert.equal(await realpath(root),expected);
    await rm(expected,{recursive:true,force:true});
  });
  const info = await lstat(root);
  assert.ok(isAbsolute(root) && root === expected && await realpath(root) === expected);
  assert.ok(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0);
  assert.equal(info.uid,process.getuid()); assert.equal(info.dev,created.dev); assert.equal(info.ino,created.ino);
  assert.match(root,/^\/[A-Za-z0-9_./-]+$/);
  const profile = join(root,'profile'), runtime = join(root,'runtime');
  const fixtureProfile = join(profile,'dsh/profiles/canary');
  const host = join(fixtureProfile,'node_modules/@deepseek-ai/dsh');
  const plugin = join(fixtureProfile,'node_modules/@marktrue/dsh-mobile-remote');
  await mkdir(join(host,'lib'),{recursive:true,mode:0o700}); await mkdir(plugin,{recursive:true,mode:0o700});
  await writeFile(join(fixtureProfile,'package.json'),JSON.stringify({name:'fixture',private:true}),{flag:'wx',mode:0o600});
  await writeFile(join(host,'package.json'),JSON.stringify({type:'module'}),{flag:'wx',mode:0o600});
  await writeFile(join(plugin,'package.json'),JSON.stringify({name:'@marktrue/dsh-mobile-remote',version:'1.2.3'}),{flag:'wx',mode:0o600});
  // No loop: record identity first, then exit after a short lived window so the
  // worker can read a baseline identity before this process disappears. Timeout
  // mode stays alive past the worker deadline, then self-exits after 1.8s
  // without relying on a signal.
  const fakeCode = `import {readFileSync,writeFileSync,writeSync} from 'node:fs'; const text=readFileSync('/proc/self/stat','utf8'); const fields=text.slice(text.lastIndexOf(')')+2).trim().split(/\\s+/); if (!/^\\d+$/.test(fields[19])) process.exit(3); writeFileSync(process.env.FAKE_HOST_IDENTITY,JSON.stringify({pid:process.pid,startTime:fields[19]}),{flag:'wx',mode:0o600}); const finish=()=>{try {writeSync(2,'ERR_MODULE_NOT_FOUND secret-token /private/path');} catch {} process.exit(1);}; const mode=process.env.FAKE_HOST_MODE; const exitSoon=action=>setTimeout(action,250); const linger=()=>setTimeout(()=>{},1200); if (mode === 'exit-zero') { exitSoon(()=>process.exit(0)); linger(); } else if (mode === 'exit-nonzero') { exitSoon(()=>process.exit(17)); linger(); } else if (mode === 'exit-signal') { exitSoon(()=>process.kill(process.pid,'SIGTERM')); linger(); } else if (mode === 'startup-audit') { exitSoon(()=>{ writeSync(2,'dsh: startup failed: 2 required plugins did not activate\\nsecret-token /private/path\\n'); process.exit(1); }); linger(); } else if (mode === 'worker-timeout') setTimeout(finish,1800); else { exitSoon(finish); linger(); }`;
  const fakeBin = join(host,'lib/bin.js');
  await writeFile(fakeBin,fakeCode,{flag:'wx',mode:0o600});
  assert.equal(await readFile(fakeBin,'utf8'),fakeCode);
  let script = makeRuntimeWorker();
  const profilePattern = /\/profile(?=\/)/g, runtimePattern = /\/tmp\/canary(?=')/g;
  // The worker references the profile path in a fixed set of places; the preflight
  // dependency resolution added one more. Assert it is at least the paths we rely
  // on being rewritten, without pinning an exact count that churns on every tweak.
  assert.ok([...script.matchAll(profilePattern)].length >= 4);
  assert.equal([...script.matchAll(runtimePattern)].length,2);
  script = script.replace(profilePattern,profile).replace(runtimePattern,runtime);
  const replaceOne = (text,before,after) => { const parts = text.split(before); assert.equal(parts.length,2); return parts.join(after); };
  const reservation = `  const reservation = createServer();\n  await new Promise((ok,bad) => reservation.once('error',bad).listen(0,'127.0.0.1',ok));\n  const port = reservation.address().port;\n  await new Promise(ok => reservation.close(ok));`;
  const request = `  const request = async (path, secret, timeoutMs) => {\n    const headers = secret ? {'x-mobile-token':secret} : {};\n    const res = await fetch('http://127.0.0.1:' + port + path,{headers,signal:AbortSignal.timeout(Math.max(1,Math.floor(timeoutMs)))});\n    let body; try { body = await res.json(); } catch { body = null; }\n    return {status:res.status,body};\n  };`;
  script = replaceOne(script,reservation,'  const port = 0;');
  async function confirmFakeExited(record, expectInitiallyRunning = false) {
    const deadline = performance.now()+2000;
    let identity;
    while (performance.now() < deadline && !identity) {
      try {
        const info = await lstat(record);
        if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw Error('invalid fake identity');
        identity = JSON.parse(await readFile(record,'utf8'));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!identity) await new Promise(resolve => setTimeout(resolve,20));
    }
    if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid <= 0 || typeof identity.startTime !== 'string' || !/^\d+$/.test(identity.startTime)) throw Error('fake host identity unavailable');
    if (expectInitiallyRunning) {
      const initial = readLinuxProcessStat(identity.pid);
      assert.equal(initial.startTime,identity.startTime,'timeout fixture identity changed before observation');
      assert.equal(initial.state,'running','timeout fixture must still be alive after worker termination');
    }
    while (performance.now() < deadline) {
      const state = readLinuxProcessStat(identity.pid);
      // An extant zombie is dead but not necessarily reaped. A different
      // starttime means the recorded process is gone and the PID was reused.
      if (state.startTime === identity.startTime && state.state === 'exited') return 'zombie';
      if (state.startTime && state.startTime !== identity.startTime) return 'reused';
      if (state.startTime === null) {
        try { await lstat(`/proc/${identity.pid}`); }
        catch (error) { if (error.code === 'ENOENT') return 'reaped'; throw error; }
      }
      await new Promise(resolve => setTimeout(resolve,20));
    }
    throw Error('fake host exit unconfirmed; fixture retained');
  }
  for (const mode of ['normal','startup-audit','worker-error','worker-timeout','exit-zero','exit-nonzero','exit-signal']) {
    const record = join(root,`identity-${mode}.json`);
    // Every run receives a fresh tmpfs-like runtime directory.
    const runPath = join(root,`runtime-${mode}`);
    const runScript = script.replaceAll(runtime,runPath);
    const waitForRecord = `await (async () => { const {access}=await import('node:fs/promises'); for(let i=0;i<100;i++){ try {await access(${JSON.stringify(record)});return;} catch {} await new Promise(ok=>setTimeout(ok,10)); } throw Error('fake-host-record-missing'); })();`;
    // Every mode must wait for the fake host to record its identity before the
    // worker can finish and kill it. Otherwise the worker's teardown races the
    // host's identity write and confirmFakeExited fails on scheduler luck alone.
    const mockRequest = ['normal','startup-audit','exit-zero','exit-nonzero','exit-signal'].includes(mode) ? `  const request = async () => ({status:0,body:null}); ${waitForRecord}` :
      mode === 'worker-error' ? `  const request = async () => ({status:0,body:null}); ${waitForRecord} throw Error('synthetic-worker-fault');` :
      `  const request = async () => ({status:0,body:null}); ${waitForRecord} Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);`;
    const mocked = replaceOne(runScript,request,mockRequest);
    assert.doesNotMatch(mocked,/\.listen\(|\bfetch\s*\(/);
    unconfirmed.add(record);
    try {
      const worker = spawnSync(process.execPath,['--input-type=module','--eval',mocked],{cwd:root,env:{PATH:'/usr/bin:/bin',HOME:join(root,'home'),DSH_HOME:join(runPath,'dsh'),XDG_CONFIG_HOME:join(root,'config'),XDG_CACHE_HOME:join(root,'cache'),XDG_DATA_HOME:join(root,'data'),XDG_STATE_HOME:join(root,'state'),XDG_RUNTIME_DIR:join(root,'run'),FAKE_HOST_IDENTITY:record,FAKE_HOST_MODE:mode},encoding:'utf8',timeout:mode === 'worker-timeout' ? 700 : 5000,killSignal:'SIGKILL',maxBuffer:16384});
      assert.doesNotMatch(worker.stdout ?? '',/secret-token|\/private\/path/);
      assert.doesNotMatch(worker.stderr ?? '',/secret-token|\/private\/path/);
      if (mode === 'worker-timeout') assert.equal(worker.error?.code,'ETIMEDOUT');
      else {
        assert.equal(worker.error,undefined); assert.equal(worker.status,2); assert.equal(worker.stderr,'');
        const expectedCode = {normal:'host-process-exited-hint-module-not-found','startup-audit':'host-process-exited-hint-startup-audit','worker-error':'worker-failed','exit-zero':'host-process-exited-zero','exit-nonzero':'host-process-exited-nonzero','exit-signal':'host-process-exited-signal'}[mode];
        assert.deepEqual(JSON.parse(worker.stdout),{ok:false,errorCode:expectedCode,checks:[]});
        assert.doesNotMatch(worker.stdout,/SIGTERM|\b17\b/);
      }
    } finally {
      const disposition = await confirmFakeExited(record,mode === 'worker-timeout');
      assert.ok(['zombie','reaped','reused'].includes(disposition));
      unconfirmed.delete(record);
    }
  }
});

test('archive command uses a fixed committed tree and rejects revisions or options', () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(gitArchiveArgs(sha),['archive','--format=tar',sha,'--','package.json','cordis.patch.yml','lib']);
  assert.throws(() => gitArchiveArgs('--remote=example'));
  assert.throws(() => gitArchiveArgs('HEAD'));
});

test('hosted-runner guard rejects missing or different claims', () => {
  assert.throws(() => checkHostedRunner({}));
  assert.throws(() => checkHostedRunner({GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'self-hosted'}));
  assert.doesNotThrow(() => checkHostedRunner({GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted'}));
});

test('proposed docker commands isolate runtime and reject injected arguments', () => {
  const input = {name:`dsh-canary-${'a'.repeat(32)}`,phase:'install',source:'/tmp/dsh-host-canary-Ab123/source',profile:'/tmp/dsh-host-canary-Ab123/profile',uid:1000,gid:1000,hostVersion:'0.2.1-rc.2',imageEnv};
  const install = dockerCreatePlan(input);
  const runtime = dockerCreatePlan({...input,phase:'runtime'});
  assert.equal(install[install.indexOf('--network')+1],'bridge');
  assert.equal(runtime[runtime.indexOf('--network')+1],'none');
  for (const args of [install,runtime]) {
    for (const flag of ['--read-only','--cap-drop','--security-opt','--pids-limit','--memory','--user']) assert.ok(args.includes(flag));
    assert.ok(args.includes(DOCKER_IMAGE));
    assert.equal(args[args.indexOf('--ipc')+1],'private');
    assert.ok(!args.includes('--pid'));
    assert.ok(!args.some(arg => /docker\.sock|--publish|--privileged/.test(arg)));
  }
  assert.ok(install.some(arg => arg.includes('--ignore-scripts')));
  for (const plan of [install,runtime]) {
    const script = plan[plan.indexOf('--eval') + 1];
    const checked = spawnSync(process.execPath,['--check','--input-type=module'],{input:script,encoding:'utf8'});
    assert.equal(checked.status,0,checked.stderr);
  }
  assert.ok(install.includes('type=bind,src=/tmp/dsh-host-canary-Ab123/source,dst=/source,readonly'));
  assert.ok(!runtime.some(arg => arg.includes('dst=/source')));
  assert.ok(runtime.includes('type=bind,src=/tmp/dsh-host-canary-Ab123/profile,dst=/profile,readonly'));
  assert.ok(runtime.includes('HOME=/tmp/canary/home')); assert.ok(runtime.includes('DSH_HOME=/tmp/canary/dsh'));
  assert.ok(!runtime.some(arg => arg.startsWith('HOME=/profile/')));
  assert.throws(() => dockerCreatePlan({...input,hostVersion:'1.2.3;touch'}));
  assert.throws(() => dockerCreatePlan({...input,profile:'/tmp/profile,readonly'}));
  assert.throws(() => dockerCreatePlan({...input,uid:0}));
  assert.throws(() => dockerCreatePlan({...input,source:'/home/user/secret'}));
  assert.throws(() => dockerCreatePlan({...input,profile:'/tmp/dsh-host-canary-Ab123/profile\n--privileged'}));
  assert.doesNotThrow(() => verifyDockerInspection({security:securityFor(input)},input));
  for (const patch of [{network:'host'},{pidMode:'host'},{pidMode:'container:foreign'},{pidMode:'shareable'},{pidMode:null},{ipcMode:'host'},{ipcMode:'container:foreign'},{ipcMode:'shareable'},{ipcMode:''},{ipcMode:null},{readonly:false},{privileged:true},{capAdd:['SYS_ADMIN']},{devices:[{}]},{ports:{'80/tcp':[]}}, {tmpfs:{'/tmp':'rw,exec'}},{entrypoint:['evil']},{cmd:['--eval','evil']},{env:[...imageEnv,...profileEnvFor(input.phase),'SECRET=unsafe']}]) {
    assert.throws(() => verifyDockerInspection({security:{...securityFor(input),...patch}},input),e => e.code === 'docker-security-mismatch');
  }
});

test('Docker CLI driver validates output and never returns raw logs', async () => {
  const id = 'd'.repeat(64), name = `dsh-canary-${'e'.repeat(32)}`;
  const options = {uid:1000,gid:1000,phase:'runtime',profile:'/tmp/dsh-host-canary-Ab123/profile',source:'/tmp/dsh-host-canary-Ab123/source'};
  const security = securityFor(options);
  const fields = [id,`/${name}`,name,false,security.image,security.user,security.network,security.readonly,security.privileged,security.pidMode,security.ipcMode,security.publishAll,security.pids,security.memory,security.capDrop,security.securityOpt,security.ports,security.mounts.map(mount => ({Type:mount.type,Source:mount.source,Destination:mount.destination,RW:mount.rw})),security.capAdd,security.devices,security.deviceRequests,security.groupAdd,security.tmpfs,security.entrypoint,security.cmd,security.env];
  const execute = async args => {
    if (args[0] === 'pull') { assert.equal(args[1],DOCKER_IMAGE); return {code:0,stdout:''}; }
    if (args[0] === 'image') return {code:0,stdout:JSON.stringify(args.includes('{{json .Config.Env}}') ? imageEnv : [`node${DOCKER_IMAGE.slice(DOCKER_IMAGE.indexOf('@'))}`])};
    if (args[0] === 'create') return {code:0,stdout:id};
    if (args[0] === 'inspect') return {code:0,stdout:fields.map(field => JSON.stringify(field)).join('\u001e')};
    if (args[0] === 'wait') return {code:0,stdout:'0'};
    if (args[0] === 'logs') return {code:0,stdout:JSON.stringify({ok:true})};
    return {code:0,stdout:''};
  };
  const driver = dockerCliDriver(execute);
  await driver.ensureImage();
  const wrongImage = dockerCliDriver(async args => ({code:0,stdout:args[0] === 'image' ? JSON.stringify(['node@sha256:wrong']) : ''}));
  await assert.rejects(wrongImage.ensureImage(),e => e.code === 'docker-image-unverified');
  const unsafeImage = dockerCliDriver(async args => ({code:0,stdout:args[0] === 'image' ? JSON.stringify(args.includes('{{json .Config.Env}}') ? [...imageEnv,'NODE_OPTIONS=--require=evil'] : [`node${DOCKER_IMAGE.slice(DOCKER_IMAGE.indexOf('@'))}`]) : ''}));
  await assert.rejects(unsafeImage.ensureImage(),e => e.code === 'docker-image-unverified');
  assert.equal(await driver.create(['create']),id);
  assert.deepEqual(await driver.inspect(id),{id,name,label:name,running:false,security});
  assert.deepEqual(await driver.wait(id,undefined,'install'),{exitCode:0,ok:true,checks:[],errorCode:null});
  const hostile = dockerCliDriver(async args => args[0] === 'wait' ? {code:0,stdout:'0'} : {code:0,stdout:JSON.stringify({checks:['secret-token']})});
  await assert.rejects(hostile.wait(id,undefined,'runtime'), e => e.code === 'docker-output-invalid' && !String(e).includes('secret-token'));
  const overflowed = dockerCliDriver(async () => ({code:0,stdout:'0',overflow:true}));
  await assert.rejects(overflowed.wait(id,undefined,'install'),e => e.code === 'docker-operation-failed');
  const names = ['jobs.callerShape','jobs.eventsApi','settings.read','gateway.wireStream','permissionPresets.apply','permissionPresets.catalog','workspaceRegistry.stateWrite','gateway.eventsPeer'];
  const checks = ['auth','bootstrap','diagnostics',...names.map(key => `host-capability:${key}:ok`)];
  const parse = (status,data,phase) => dockerCliDriver(async args => ({code:0,stdout:args[0] === 'wait' ? String(status) : JSON.stringify(data)})).wait(id,undefined,phase);
  assert.deepEqual(await parse(0,{ok:true,checks},'runtime'),{exitCode:0,ok:true,checks,errorCode:null});
  for (const [status,data,phase] of [
    [0,{ok:false,checks},'runtime'], [0,{checks},'runtime'], [0,{ok:'true',checks},'runtime'],
    [0,{ok:true,checks,errorCode:'worker-failed'},'runtime'], [0,{ok:true,checks,extra:'secret'},'runtime'],
    [0,{ok:true,checks:checks.slice(0,-1)},'runtime'], [1,{ok:false,errorCode:'worker-failed',checks:[]},'runtime'],
    [2,{ok:false,errorCode:'compatibility-check-failed',checks:[]},'runtime'],
    [1,{ok:false,errorCode:'compatibility-check-failed',checks},'runtime'],
    [1,{ok:false,errorCode:'compatibility-check-failed',checks:[...checks.slice(0,-1),'host-capability:gateway.eventsPeer:missing']},'runtime'],
    [0,{ok:true,checks:[...checks.slice(0,-1),'host-capability:settings.read:drift']},'runtime'],
    [0,{ok:true,checks:[...checks.slice(0,-1),checks[3]]},'runtime'],
    [2,{ok:false,errorCode:'host-capabilities-inconclusive',checks},'runtime'],
    [2,{ok:false,errorCode:'host-capabilities-inconclusive',checks:checks.slice(0,3)},'runtime'],
    [2,{ok:false,errorCode:'unknown-secret',checks:[]},'runtime'],
    [0,{ok:true,extra:'secret'},'install'], [1,{ok:true},'install'], [1,{ok:false,errorCode:'install-failed'},'install'],
    [2,{ok:false,errorCode:'install-failed',checks:[]},'install'], [0,{ok:false,errorCode:'install-failed'},'install'],
  ]) await assert.rejects(parse(status,data,phase),e => e.code === 'docker-output-invalid');
  assert.equal((await parse(2,{ok:false,errorCode:'install-failed'},'install')).errorCode,'install-failed');
  assert.equal((await parse(1,{ok:false,errorCode:'compatibility-check-failed',checks:['auth']},'runtime')).errorCode,'compatibility-check-failed');
  assert.equal((await parse(2,{ok:false,errorCode:'host-capabilities-inconclusive',checks:[...checks.slice(0,-1),'host-capability:gateway.eventsPeer:missing']},'runtime')).errorCode,'host-capabilities-inconclusive');
  for (const code of ['host-process-spawn-failed','host-process-spawn-inconclusive','host-process-exited','host-process-exited-zero','host-process-exited-nonzero','host-process-exited-signal','host-process-exited-hint-eacces','host-process-exited-hint-erofs','host-process-exited-hint-enoent','host-process-exited-hint-enospc','host-process-exited-hint-user-lookup','host-process-exited-hint-module-not-found','host-process-exited-hint-native-load','host-process-exited-hint-startup-audit','host-process-state-inconclusive','host-ready-timeout','host-auth-response-inconclusive']) {
    assert.equal((await parse(2,{ok:false,errorCode:code,checks:[]},'runtime')).errorCode,code);
  }
  await assert.rejects(parse(2,{ok:false,errorCode:'host-start-inconclusive',checks:[]},'runtime'),e => e.code === 'docker-output-invalid');
  const daemonDown = dockerCliDriver(async () => ({code:1,stdout:''}));
  await assert.rejects(daemonDown.inspect(id),e => e.code === 'docker-operation-failed');
  const absent = dockerCliDriver(async args => args[0] === 'inspect' ? {code:1,stdout:''} : {code:0,stdout:''});
  assert.deepEqual(await absent.inspect(id),{kind:'not-found'});
});

test('mock Docker lifecycle requires verified cleanup before success', async () => {
  const options = {name:`dsh-canary-${'b'.repeat(32)}`,phase:'runtime',source:'/tmp/dsh-host-canary-Ab123/source',profile:'/tmp/dsh-host-canary-Ab123/profile',uid:1000,gid:1000,hostVersion:'1.2.3',imageEnv};
  const id = 'c'.repeat(64), calls = []; let removed = false;
  const driver = {
    create: async args => { calls.push('create'); assert.ok(args.includes('--network')); return id; },
    inspect: async value => { assert.equal(value,id); calls.push('inspect'); return removed ? {kind:'not-found'} : {id,name:options.name,label:options.name,running:false,security:securityFor(options)}; },
    authorizeCleanup: () => {},
    start: async () => calls.push('start'), wait: async () => ({exitCode:0}),
    kill: async () => calls.push('kill'), remove: async () => { calls.push('remove'); removed = true; },
  };
  assert.deepEqual(await managedDocker(driver,options,100),{exitCode:0});
  assert.deepEqual(calls,['create','inspect','start','inspect','remove','inspect']);
  removed = false;
  let startedBad = false;
  const unsafe = {...driver,start:async () => { startedBad = true; },inspect:async () => removed ? {kind:'not-found'} : {id,name:options.name,label:options.name,running:false,security:{...securityFor(options),network:'host'}}};
  await assert.rejects(managedDocker(unsafe,options,100),e => e.code === 'docker-security-mismatch');
  assert.equal(startedBad,false); assert.equal(removed,true);
  removed = false;
  let finishStart;
  const lateStart = {...driver,start:async () => new Promise(resolve => { finishStart = resolve; })};
  // Budget must cover create/inspect so start() is actually reached, then the
  // hanging start still exceeds it. 5ms made create/inspect consume the whole
  // budget under load, so start() never ran and this asserted the wrong path.
  await assert.rejects(managedDocker(lateStart,options,50),e => e.code === 'docker-cleanup-unconfirmed');
  assert.equal(removed,true); finishStart();
  removed = false;
  await assert.rejects(managedDocker({...driver,remove:async () => { throw Error('denied'); }},options,100), e => e.code === 'docker-cleanup-unconfirmed');
  await assert.rejects(managedDocker({...driver,create:async () => new Promise(() => {})},options,5), e => e.code === 'docker-cleanup-unconfirmed');
  removed = false;
  let killed = false;
  let operationAborted = false, isRunning = false;
  const hanging = {...driver,start:async () => { isRunning = true; },wait:async (_id,signal) => new Promise(() => { signal.addEventListener('abort',() => { operationAborted = true; },{once:true}); }),inspect:async () => removed ? {kind:'not-found'} : {id,name:options.name,label:options.name,running:isRunning,security:securityFor(options)},kill:async () => { killed = true; isRunning = false; }};
  await assert.rejects(managedDocker(hanging,options,5), e => e.code === 'docker-operation-timeout');
  assert.equal(operationAborted,true); assert.equal(killed,true);
  removed = false; killed = false;
  const controller = new AbortController();
  const aborting = {...hanging,wait:async () => { controller.abort(); return new Promise(() => {}); }};
  await assert.rejects(managedDocker(aborting,options,100,controller.signal), e => e.code === 'interrupted');
  assert.equal(killed,true);
  await assert.rejects(managedDocker({...driver,inspect:async () => ({id,name:'wrong',label:'wrong',running:true}),kill:async () => { throw Error('must not kill foreign container'); }},options,100), e => e.code === 'docker-cleanup-unconfirmed');
});

test('runtime lifecycle uses one shared timeout, not one per operation', async () => {
  const options = {name:`dsh-canary-${'a'.repeat(32)}`,phase:'runtime',source:'/tmp/dsh-host-canary-Ab123/source',profile:'/tmp/dsh-host-canary-Ab123/profile',uid:1000,gid:1000,hostVersion:'1.2.3',imageEnv};
  const id = 'a'.repeat(64); let removed = false, running = false, waitStart = 0, waitDuration = 0;
  const driver = {
    create: async () => { await new Promise(ok => setTimeout(ok,80)); return id; },
    inspect: async () => removed ? {kind:'not-found'} : {id,name:options.name,label:options.name,running,security:securityFor(options)},
    authorizeCleanup: () => {}, start: async () => { running = true; },
    wait: async (_id,signal) => new Promise(() => { waitStart = performance.now(); signal.addEventListener('abort',() => { waitDuration = performance.now()-waitStart; },{once:true}); }),
    kill: async () => {}, remove: async () => { removed = true; },
  };
  await assert.rejects(managedDocker(driver,options,150),e => e.code === 'docker-operation-timeout');
  assert.ok(waitDuration > 0 && waitDuration < 125,`wait duration ${waitDuration}`); assert.equal(removed,true);
});

test('runtime budget covers slow startup, worker and log transfer', async () => {
  assert.equal(RUNTIME_LIFECYCLE_MS,105000);
  const options = {name:`dsh-canary-${'a'.repeat(32)}`,phase:'runtime',source:'/tmp/dsh-host-canary-Ab123/source',profile:'/tmp/dsh-host-canary-Ab123/profile',uid:1000,gid:1000,hostVersion:'1.2.3',imageEnv};
  const id = 'a'.repeat(64); let now = 0, removed = false;
  const driver = {
    create: async () => { now += 8000; return id; },
    inspect: async () => { if (!removed && now === 8000) now += 4000; return removed ? {kind:'not-found'} : {id,name:options.name,label:options.name,running:false,security:securityFor(options)}; },
    authorizeCleanup: () => {}, start: async () => { now += 2000; },
    wait: async () => { now += 75000; now += 14000; return {exitCode:0}; },
    kill: async () => {}, remove: async () => { removed = true; },
  };
  assert.deepEqual(await managedDocker(driver,options,RUNTIME_LIFECYCLE_MS,undefined,() => now),{exitCode:0});
  assert.equal(now,103000); assert.equal(removed,true);
  now = 0; removed = false;
  await assert.rejects(managedDocker({...driver,wait:async () => { now += 75000; now += 17000; return {exitCode:0}; }},options,RUNTIME_LIFECYCLE_MS,undefined,() => now),e => e.code === 'docker-operation-timeout');
  assert.equal(removed,true);
  now = 0; removed = false;
  await assert.rejects(managedDocker({...driver,start:async () => { now += 4000; }},options,RUNTIME_LIFECYCLE_MS,undefined,() => now),e => e.code === 'docker-cleanup-unconfirmed');
});

test('source identity requires exact commit and clean tracked content', async t => {
  const root = await mkdtemp(join(tmpdir(),'canary-test-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const git = (...args) => execFileSync('git',args,{cwd:root,stdio:'pipe',env:{PATH:process.env.PATH,HOME:root,GIT_CONFIG_NOSYSTEM:'1'}}).toString().trim();
  git('init'); git('config','user.email','test@example.invalid'); git('config','user.name','Test');
  await mkdir(join(root,'lib')); await writeFile(join(root,'lib','a.js'),'export default 1;');
  await writeFile(join(root,'package.json'),JSON.stringify({name:'@marktrue/dsh-mobile-remote',version:'1.2.3'}));
  await writeFile(join(root,'.gitignore'),'lib/ignored.js\n');
  await writeFile(join(root,'cordis.patch.yml'),'[]\n');
  git('add','lib/a.js','package.json','.gitignore','cordis.patch.yml'); git('commit','-m','fixture');
  const sha = git('rev-parse','HEAD');
  const archive = execFileSync('git',gitArchiveArgs(sha),{cwd:root});
  const listing = spawnSync('tar',['-tf','-'],{input:archive,encoding:'utf8'});
  assert.equal(listing.status,0);
  assert.match(listing.stdout,/lib\/a\.js/);
  assert.match(listing.stdout,/cordis\.patch\.yml/);
  const env = {PATH:process.env.PATH,HOME:root,GIT_CONFIG_NOSYSTEM:'1'};
  const hash = await verifyPluginSource(root,sha,env);
  assert.match(hash,/^[a-f0-9]{64}$/);
  const archived = await createSourceArchive(root,sha,env);
  try {
    assert.equal(archived.snapshot,hash);
    assert.deepEqual(await validateDockerMounts(archived.root), {source:archived.source,profile:archived.profile});
    await assert.rejects(validateDockerMounts(root),e => e.code === 'docker-mount-invalid');
    let invoked = false;
    await assert.rejects(createDockerExecutor(archived.root,{},async () => { invoked = true; }),e => e.code === 'runner-not-ephemeral');
    const execute = await createDockerExecutor(archived.root,{GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted'},async (bin,args,opts) => {
      invoked = true; assert.equal(bin,'/usr/bin/docker'); assert.deepEqual(args,['version']);
      assert.equal(opts.env.DOCKER_CONFIG,join(archived.root,'docker-config')); assert.equal(opts.env.HOME,join(archived.root,'docker-home'));
      assert.equal(opts.env.DOCKER_HOST,undefined); assert.equal(opts.env.GITHUB_TOKEN,undefined);
      return {code:0,stdout:'ok'};
    });
    assert.equal(invoked,false); assert.equal((await execute(['version'])).code,0); assert.equal(invoked,true);
    await prepareContainerProfile(archived.root);
    await assert.rejects(readFile(join(archived.profile,'token'),'utf8'),e => e.code === 'ENOENT');
    await assert.rejects(readFile(join(archived.profile,'dsh/profiles/canary/cordis.patch.yml'),'utf8'),e => e.code === 'ENOENT');
    await assert.rejects(prepareContainerProfile(archived.root),e => e.code === 'docker-mount-invalid');
    const listed = spawnSync('tar',['-tf',archived.archivePath],{encoding:'utf8'});
    assert.equal(listed.status,0); assert.match(listed.stdout,/lib\/a\.js/);
  } finally { await removeSourceArchive(archived.root); }
  const containers = new Map(); let next = 0, runtimeFailure = null, omitBundle = false;
  const names = ['jobs.callerShape','jobs.eventsApi','settings.read','gateway.wireStream','permissionPresets.apply','permissionPresets.catalog','workspaceRegistry.stateWrite','gateway.eventsPeer'];
  const checks = ['auth','bootstrap','diagnostics',...names.map(name => `host-capability:${name}:ok`)];
  const fake = {
    ensureImage: async () => imageEnv,
    authorizeCleanup: () => {},
    create: async args => {
      const id = (++next).toString(16).padStart(64,'0');
      const name = args[args.indexOf('--name')+1];
      const phase = args[args.indexOf('--network')+1] === 'bridge' ? 'install' : 'runtime';
      const mount = args.find(arg => arg.startsWith('type=bind,src=') && /,dst=\/profile(?:,readonly)?$/.test(arg));
      const profile = mount.slice('type=bind,src='.length,mount.indexOf(',dst=/profile'));
      const source = join(profile,'..','source');
      if (phase === 'install') {
        await assert.rejects(readFile(join(profile,'token'),'utf8'),e => e.code === 'ENOENT');
        await assert.rejects(readFile(join(profile,'dsh/profiles/canary/cordis.patch.yml'),'utf8'),e => e.code === 'ENOENT');
        assert.equal(args.some(arg => arg.includes('authToken')),false);
      } else {
        assert.equal(containers.size,0); // Installation container already removed.
        assert.ok(mount.endsWith(',readonly'));
        await assert.rejects(readFile(join(profile,'token'),'utf8'),e => e.code === 'ENOENT');
        await assert.rejects(readFile(join(profile,'dsh/profiles/canary/cordis.patch.yml'),'utf8'),e => e.code === 'ENOENT');
      }
      containers.set(id,{id,name,label:name,running:false,phase,profile,security:securityFor({uid:process.getuid(),gid:process.getgid(),phase,profile,source})});
      return id;
    },
    inspect: async id => containers.get(id) ?? {kind:'not-found'},
    start: async id => { containers.get(id).running = true; },
    wait: async id => {
      const state = containers.get(id); state.running = false;
      if (state.phase === 'install') {
        const profile = join(state.profile,'dsh/profiles/canary/node_modules');
        const host = join(profile,'@deepseek-ai/dsh'), plugin = join(profile,'@marktrue/dsh-mobile-remote');
        await mkdir(host,{recursive:true}); await mkdir(join(plugin,'lib'),{recursive:true});
        await writeFile(join(host,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh',version:'1.2.3'}));
        for (const name of ['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']) {
          if (omitBundle && name === '@deepseek-ai/dsh-web-app') continue;
          const bundle = join(profile,name); await mkdir(bundle,{recursive:true});
          await writeFile(join(bundle,'package.json'),JSON.stringify({name}));
        }
        await writeFile(join(plugin,'package.json'),JSON.stringify({name:'@marktrue/dsh-mobile-remote',version:'1.2.3'}));
        await writeFile(join(plugin,'lib/a.js'),'export default 1;');
        await writeFile(join(plugin,'cordis.patch.yml'),'[]\n');
      }
      if (state.phase === 'runtime' && runtimeFailure) return {exitCode:2,ok:false,errorCode:runtimeFailure,checks:[]};
      return {exitCode:0,ok:true,checks};
    },
    kill: async id => { containers.get(id).running = false; },
    remove: async id => { containers.delete(id); },
  };
  const logs = new Map();
  const dockerExecute = async args => {
    const [command,...rest] = args;
    if (command === 'pull') return {code:0,stdout:''};
    if (command === 'image') return {code:0,stdout:JSON.stringify(args.includes('{{json .Config.Env}}') ? imageEnv : [`node${DOCKER_IMAGE.slice(DOCKER_IMAGE.indexOf('@'))}`])};
    if (command === 'create') return {code:0,stdout:await fake.create(args)};
    const id = rest.at(-1);
    if (command === 'inspect') {
      const value = await fake.inspect(id);
      if (value.kind === 'not-found') return {code:1,stdout:''};
      const s = value.security;
      const fields = [id,`/${value.name}`,value.label,value.running,s.image,s.user,s.network,s.readonly,s.privileged,s.pidMode,s.ipcMode,s.publishAll,s.pids,s.memory,s.capDrop,s.securityOpt,s.ports,s.mounts.map(m => ({Type:m.type,Source:m.source,Destination:m.destination,RW:m.rw})),s.capAdd,s.devices,s.deviceRequests,s.groupAdd,s.tmpfs,s.entrypoint,s.cmd,s.env];
      return {code:0,stdout:fields.map(field => JSON.stringify(field)).join('\u001e')};
    }
    if (command === 'ps') return {code:0,stdout:''};
    if (command === 'start') { await fake.start(id); return {code:0,stdout:id}; }
    if (command === 'wait') { const phase = containers.get(id).phase; const value = await fake.wait(id); logs.set(id,phase === 'install' ? {ok:true} : value.ok ? {ok:true,checks:value.checks} : {ok:false,errorCode:value.errorCode,checks:value.checks}); return {code:0,stdout:String(value.exitCode)}; }
    if (command === 'logs') return {code:0,stdout:JSON.stringify(logs.get(id))};
    if (command === 'kill') { await fake.kill(id); return {code:0,stdout:id}; }
    if (command === 'rm') { await fake.remove(id); return {code:0,stdout:id}; }
    throw Error('unexpected command');
  };
  const result = await runCanary({hostVersion:'1.2.3',pluginRoot:root,pluginSha:sha},dockerModelAdapter(dockerCliDriver(dockerExecute),{env:{...env,GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted'},uid:process.getuid(),gid:process.getgid()}));
  assert.equal(result.status,'passed'); assert.deepEqual(result.checks,checks); assert.equal(containers.size,0); assert.equal(next,2);
  for (const code of ['host-process-spawn-failed','host-process-spawn-inconclusive','host-process-exited','host-process-exited-zero','host-process-exited-nonzero','host-process-exited-signal','host-process-exited-hint-eacces','host-process-exited-hint-erofs','host-process-exited-hint-enoent','host-process-exited-hint-enospc','host-process-exited-hint-user-lookup','host-process-exited-hint-module-not-found','host-process-exited-hint-native-load','host-process-exited-hint-startup-audit','host-process-state-inconclusive','host-ready-timeout','host-auth-response-inconclusive']) {
    runtimeFailure = code;
    const failure = await runCanary({hostVersion:'1.2.3',pluginRoot:root,pluginSha:sha},dockerModelAdapter(dockerCliDriver(dockerExecute),{env:{...env,GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted'},uid:process.getuid(),gid:process.getgid()}));
    assert.equal(failure.status,'infrastructure-failure'); assert.equal(failure.stage,'runtime'); assert.equal(failure.errorCode,code); assert.deepEqual(failure.checks,[]);
    assert.equal(containers.size,0); assert.doesNotMatch(JSON.stringify(failure),/secret-token|\/private\/path/);
  }
  runtimeFailure = null; omitBundle = true;
  const previous = next;
  const missingBundleResult = await runCanary({hostVersion:'1.2.3',pluginRoot:root,pluginSha:sha},dockerModelAdapter(dockerCliDriver(dockerExecute),{env:{...env,GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted'},uid:process.getuid(),gid:process.getgid()}));
  assert.equal(missingBundleResult.status,'infrastructure-failure'); assert.equal(missingBundleResult.stage,'install'); assert.equal(missingBundleResult.errorCode,'host-bundle-unavailable');
  assert.equal(next,previous+1); assert.equal(containers.size,0); omitBundle = false;
  const contradictoryDriver = {...fake,wait:async id => {
    const phase = containers.get(id).phase;
    await fake.wait(id);
    return phase === 'install' ? {exitCode:0,ok:true,checks:[],errorCode:null} : {exitCode:0,ok:false,checks,errorCode:null};
  }};
  const contradiction = await runCanary({hostVersion:'1.2.3',pluginRoot:root,pluginSha:sha},dockerModelAdapter(contradictoryDriver,{env:{...env,GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted'},uid:process.getuid(),gid:process.getgid()}));
  assert.equal(contradiction.status,'infrastructure-failure'); assert.equal(contradiction.errorCode,'docker-output-invalid'); assert.equal(containers.size,0);
  const runnerEnv = {GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_TOKEN:'secret-not-forwarded'};
  const invoke = async (bin,args,opts) => { assert.equal(bin,'/usr/bin/docker'); assert.equal(opts.env.GITHUB_TOKEN,undefined); assert.equal(opts.env.DOCKER_HOST,undefined); return dockerExecute(args); };
  const forged = await runCanary({hostVersion:'1.2.3',pluginRoot:root,pluginSha:sha},hostedDockerAdapter({runnerEnv,uid:process.getuid()+1,gid:process.getgid(),invoke}));
  assert.equal(forged.errorCode,'runner-identity-mismatch');
  const forgedGid = await runCanary({hostVersion:'1.2.3',pluginRoot:root,pluginSha:sha},hostedDockerAdapter({runnerEnv,uid:process.getuid(),gid:process.getgid()+1,invoke}));
  assert.equal(forgedGid.errorCode,'runner-identity-mismatch');
  const hosted = hostedDockerAdapter({runnerEnv,uid:process.getuid(),gid:process.getgid(),invoke});
  const hostedResult = await runCanary({hostVersion:'1.2.3',pluginRoot:root,pluginSha:sha},hosted);
  assert.equal(hostedResult.status,'passed'); assert.equal(containers.size,0);
  const controller = new AbortController(); let killSeen = false;
  const abortingInvoke = async (bin,args,opts) => {
    if (args[0] === 'wait') { controller.abort(); return new Promise(() => {}); }
    if (args[0] === 'kill') killSeen = true;
    return invoke(bin,args,opts);
  };
  const interruptedResult = await runCanary({hostVersion:'1.2.3',pluginRoot:root,pluginSha:sha},hostedDockerAdapter({runnerEnv,uid:process.getuid(),gid:process.getgid(),signal:controller.signal,invoke:abortingInvoke}));
  assert.equal(interruptedResult.status,'infrastructure-failure'); assert.equal(interruptedResult.errorCode,'interrupted');
  assert.equal(killSeen,true); assert.equal(containers.size,0);
  const runtimeController = new AbortController(); let waits = 0, runtimeKilled = false;
  const runtimeAbortInvoke = async (bin,args,opts) => {
    if (args[0] === 'wait' && ++waits === 2) { runtimeController.abort(); return new Promise(() => {}); }
    if (args[0] === 'kill') runtimeKilled = true;
    return invoke(bin,args,opts);
  };
  const runtimeAbort = await runCanary({hostVersion:'1.2.3',pluginRoot:root,pluginSha:sha},hostedDockerAdapter({runnerEnv,uid:process.getuid(),gid:process.getgid(),signal:runtimeController.signal,invoke:runtimeAbortInvoke}));
  assert.equal(runtimeAbort.status,'infrastructure-failure'); assert.equal(runtimeAbort.errorCode,'interrupted');
  assert.equal(runtimeKilled,true); assert.equal(containers.size,0);
  // A real OS SIGTERM is sent by a temporary mock executable while the
  // Docker wait command is active. Neither Docker nor a DSH host is started.
  const mock = join(root,'mock-docker'), marker = join(root,'mock-cleanup-done');
  const mockScript = `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2), cmd = args[0], file = path.join(process.cwd(),'mock-state.json');
const id = 'f'.repeat(64), image = ${JSON.stringify(DOCKER_IMAGE)}, marker = ${JSON.stringify(marker)};
const output = value => process.stdout.write(value + '\\n');
const get = () => JSON.parse(fs.readFileSync(file,'utf8'));
if (cmd === 'pull') output('');
else if (cmd === 'image') output(JSON.stringify(args.includes('{{json .Config.Env}}') ? ${JSON.stringify(imageEnv)} : ['node' + image.slice(image.indexOf('@'))]));
else if (cmd === 'create') {
  const name = args[args.indexOf('--name')+1], uid = args[args.indexOf('--user')+1];
  const phase = args[args.indexOf('--network')+1], mount = args.find(x => x.startsWith('type=bind,src=') && x.endsWith(',dst=/profile'));
  const profile = mount.slice('type=bind,src='.length,-',dst=/profile'.length), source = path.join(profile,'..','source');
  const env=${JSON.stringify(imageEnv)}.concat(args.flatMap((value,index) => value === '--env' ? [args[index+1]] : []));
  const entrypoint=[args[args.indexOf('--entrypoint')+1]], command=args.slice(args.indexOf(image)+1);
  fs.writeFileSync(file,JSON.stringify({name,uid,phase,profile,source,env,entrypoint,command,running:false})); output(id);
} else if (cmd === 'inspect') {
  if (!fs.existsSync(file)) process.exitCode=1;
  else {
    const s=get(), mounts=[{Type:'bind',Source:s.profile,Destination:'/profile',RW:true}];
    if (s.phase === 'bridge') mounts.push({Type:'bind',Source:s.source,Destination:'/source',RW:false});
    const vals=[id,'/'+s.name,s.name,s.running,image,s.uid,s.phase,true,false,'','private',false,256,2147483648,['ALL'],['no-new-privileges'],null,mounts,null,[],null,null,{'/tmp':'rw,noexec,nosuid,nodev,size=128m'},s.entrypoint,s.command,s.env];
    output(vals.map(v => JSON.stringify(v)).join('\u001e'));
  }
} else if (cmd === 'start') { const s=get(); s.running=true; fs.writeFileSync(file,JSON.stringify(s)); output(id); }
else if (cmd === 'wait') { process.kill(process.ppid,'SIGTERM'); setInterval(() => {},1000); }
else if (cmd === 'kill') { const s=get(); s.running=false; fs.writeFileSync(file,JSON.stringify(s)); output(id); }
else if (cmd === 'rm') { fs.unlinkSync(file); fs.writeFileSync(marker,'cleaned'); output(id); }
else if (cmd === 'ps') output(''); else process.exitCode=1;
`;
  await writeFile(mock,mockScript,{mode:0o700}); await chmod(mock,0o700);
  const moduleUrl = new URL('../tools/host-canary/smoke.mjs',import.meta.url).href;
  const harness = `import {runCanary,hostedDockerAdapter,installCanarySignalHandlers,runMockDockerCommand} from ${JSON.stringify(moduleUrl)};
const [root,sha,mock] = process.argv.slice(1); const controller = new AbortController();
const off = installCanarySignalHandlers(controller);
const invoke = (_bin,args,opts) => runMockDockerCommand(mock,args,opts);
const adapter = hostedDockerAdapter({runnerEnv:{GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted'},uid:process.getuid(),gid:process.getgid(),signal:controller.signal,invoke});
const result = await runCanary({hostVersion:'1.2.3',pluginRoot:root,pluginSha:sha},adapter); off(); process.stdout.write(JSON.stringify(result));`;
  const child = spawnSync(process.execPath,['--input-type=module','--eval',harness,root,sha,mock],{encoding:'utf8',timeout:15000});
  assert.equal(child.status,0,child.stderr);
  const signalResult = JSON.parse(child.stdout);
  assert.equal(signalResult.status,'infrastructure-failure'); assert.equal(signalResult.errorCode,'interrupted');
  assert.equal(await readFile(marker,'utf8'),'cleaned');
  let retainedRoot;
  const failedCleanupInvoke = async (bin,args,opts) => {
    if (args[0] === 'create') retainedRoot = opts.cwd;
    if (args[0] === 'rm') return {code:1,stdout:''};
    return invoke(bin,args,opts);
  };
  const cleanupFailed = await runCanary({hostVersion:'1.2.3',pluginRoot:root,pluginSha:sha},hostedDockerAdapter({runnerEnv,uid:process.getuid(),gid:process.getgid(),invoke:failedCleanupInvoke}));
  assert.equal(cleanupFailed.status,'infrastructure-failure'); assert.equal(cleanupFailed.errorCode,'docker-cleanup-unconfirmed');
  assert.ok((await lstat(retainedRoot)).isDirectory());
  await assert.rejects(readFile(join(retainedRoot,'profile','token'),'utf8'),e => e.code === 'ENOENT');
  await assert.rejects(readFile(join(retainedRoot,'profile','dsh/profiles/canary/cordis.patch.yml'),'utf8'),e => e.code === 'ENOENT');
  for (const id of containers.keys()) await fake.remove(id);
  await removeSourceArchive(retainedRoot);
  await assert.rejects(verifyPluginSource(root,'0'.repeat(40),env), e => e.code === 'source-identity-mismatch');
  await writeFile(join(root,'lib','a.js'),'modified');
  await assert.rejects(verifyPluginSource(root,sha,env), e => e.code === 'source-identity-mismatch');
  await writeFile(join(root,'lib','a.js'),'export default 1;');
  await writeFile(join(root,'lib','untracked.js'),'untracked');
  await assert.rejects(verifyPluginSource(root,sha,env), e => e.code === 'source-identity-mismatch');
  await rm(join(root,'lib','untracked.js'));
  await writeFile(join(root,'lib','ignored.js'),'ignored');
  await assert.rejects(verifyPluginSource(root,sha,env), e => e.code === 'source-identity-mismatch');
});

test('required bundles resolve installation-first without leaving the profile', async t => {
  const root = await mkdtemp(join(tmpdir(),'canary-test-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const names = ['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app'];
  async function make(name) {
    const profile = join(root,name), host = join(profile,'node_modules/@deepseek-ai/dsh');
    await mkdir(host,{recursive:true}); await writeFile(join(host,'package.json'),'{"name":"@deepseek-ai/dsh"}');
    await writeFile(join(profile,'package.json'),'{}'); return {profile,host};
  }
  async function add(modules,name,actual = name) {
    const path = join(modules,name); await mkdir(path,{recursive:true});
    await writeFile(join(path,'package.json'),JSON.stringify({name:actual}));
  }
  const hoisted = await make('hoisted');
  for (const name of names) await add(join(hoisted.profile,'node_modules'),name);
  await verifyRequiredBundles(hoisted.profile);
  const nested = await make('nested');
  for (const name of names) await add(join(nested.host,'node_modules'),name);
  await verifyRequiredBundles(nested.profile);
  const missing = await make('missing'); await add(join(missing.profile,'node_modules'),names[0]);
  await assert.rejects(verifyRequiredBundles(missing.profile),e => e.code === 'host-bundle-unavailable' && e.status === 'infrastructure-failure' && !e.message.includes(root));
  const priority = await make('priority');
  for (const name of names) await add(join(priority.profile,'node_modules'),name);
  await add(join(priority.host,'node_modules'),names[0],'@other/wrong');
  await assert.rejects(verifyRequiredBundles(priority.profile),e => e.code === 'host-bundle-unavailable');
  const escape = await make('escape'), outside = join(root,'outside');
  await add(outside,names[0]); await add(join(escape.profile,'node_modules'),names[1]);
  await mkdir(join(escape.profile,'node_modules/@deepseek-ai'),{recursive:true});
  await symlink(join(outside,names[0]),join(escape.profile,'node_modules',names[0]));
  await assert.rejects(verifyRequiredBundles(escape.profile),e => e.code === 'host-bundle-unavailable');
});

test('installed host identity and complete plugin tree must match', async t => {
  const root = await mkdtemp(join(tmpdir(),'canary-test-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const source = join(root,'source'), profile = join(root,'profile');
  const installed = join(profile,'node_modules/@marktrue/dsh-mobile-remote');
  const host = join(profile,'node_modules/@deepseek-ai/dsh');
  await mkdir(join(source,'lib'),{recursive:true}); await mkdir(join(installed,'lib'),{recursive:true}); await mkdir(host,{recursive:true});
  await writeFile(join(source,'lib','a.js'),'one'); await writeFile(join(installed,'lib','a.js'),'one');
  await writeFile(join(host,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh',version:'1.2.3'}));
  const manifest = {name:'@marktrue/dsh-mobile-remote',version:'3.0.0',main:'lib/a.js',exports:{'.':'./lib/a.js'},dsh:{bundle:{patch:'./cordis.patch.yml'}},scripts:{test:'node test.js'},dependencies:{qrcode:'1.0.0'}};
  const patch = '[]\n', patchHash = createHash('sha256').update(patch).digest('hex');
  await writeFile(join(installed,'package.json'),JSON.stringify({...manifest,_resolved:'file:fixture'}));
  await writeFile(join(installed,'cordis.patch.yml'),patch);
  const snapshot = await libSnapshot(source);
  await verifyInstalled(profile,'1.2.3',snapshot,manifest,patchHash);
  await assert.rejects(verifyInstalled(profile,'1.2.4',snapshot,manifest,patchHash), e => e.code === 'installed-identity-mismatch');
  for (const change of [{main:'evil.js'},{exports:{'.':'./evil.js'}},{dsh:{bundle:{patch:'./evil.yml'}}},{scripts:{postinstall:'evil'}},{dependencies:{qrcode:'99.0.0'}},{bin:'evil.js'},{_resolved:{secret:'unsafe'}}]) {
    await writeFile(join(installed,'package.json'),JSON.stringify({...manifest,...change}));
    await assert.rejects(verifyInstalled(profile,'1.2.3',snapshot,manifest,patchHash),e => e.code === 'installed-identity-mismatch');
  }
  await writeFile(join(installed,'package.json'),JSON.stringify(manifest));
  await writeFile(join(installed,'cordis.patch.yml'),'altered');
  await assert.rejects(verifyInstalled(profile,'1.2.3',snapshot,manifest,patchHash), e => e.code === 'installed-identity-mismatch');
  await writeFile(join(installed,'cordis.patch.yml'),patch);
  await writeFile(join(installed,'lib','a.js'),'other');
  await assert.rejects(verifyInstalled(profile,'1.2.3',snapshot,manifest,patchHash), e => e.code === 'installed-identity-mismatch');
  await writeFile(join(installed,'lib','a.js'),'one');
  await symlink('a.js',join(installed,'lib','linked.js'));
  await assert.rejects(verifyInstalled(profile,'1.2.3',snapshot,manifest,patchHash), e => e.code === 'installed-identity-mismatch');
});

test('profile uses shipped bundles and explicitly safe mobile settings', () => {
  const {manifest,patch} = profileFiles('test-token');
  assert.deepEqual(manifest.dsh.profile.bundles,['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']);
  assert.deepEqual(patch[0].insert[0], {id:'mobile-remote',name:'@marktrue/dsh-mobile-remote',config:{path:'/m',authToken:'test-token',pluginUpdateManifest:'off',lanBridge:{enabled:false},pushUrls:[]}});
});

test('install worker materializes the plugin into the persistent profile tree', () => {
  // Regression: the plugin used to be installed under /tmp (container tmpfs) and
  // only symlinked into /profile. The installer container is removed before the
  // runtime container starts, so the symlink dangled -- and verifyInstalled
  // deliberately rejects plugin symlinks, so the run could never pass.
  const script = makeInstallWorker('0.2.1-rc.5');
  const checked = spawnSync(process.execPath,['--check','--input-type=module'],{input:script,encoding:'utf8'});
  assert.equal(checked.status,0,checked.stderr);
  // Nothing the runtime needs may live only under /tmp.
  assert.doesNotMatch(script,/\/tmp\/plugin-prefix/);
  // The plugin must be copied as a real directory into the mounted profile.
  assert.match(script,/execFileSync\('cp',\['-a'/);
  assert.match(script,/\/profile\/dsh\/profiles\/canary\/node_modules\/@marktrue/);
  // And it must not be linked.
  assert.doesNotMatch(script,/symlinkSync\([^\n]*dsh-mobile-remote/);
});

test('install worker keeps the host closure isolated from plugin peer ranges', () => {
  // Regression: installing the plugin in the same npm command as the host let the
  // plugin's wide peer ranges (">=0.1.0-rc.6 <0.3.0") pull old 0.1.x host packages
  // into the tree and drop @deepseek-ai/dsh-web-app. The host then disabled dozens
  // of rows and exited before serving HTTP. The host must be installed alone, and
  // the plugin resolved in a separate prefix (now a persistent one, then copied in).
  const script = makeInstallWorker('0.2.1-rc.5');
  const checked = spawnSync(process.execPath,['--check','--input-type=module'],{input:script,encoding:'utf8'});
  assert.equal(checked.status,0,checked.stderr);
  assert.match(script,/@deepseek-ai\/dsh@0\.2\.1-rc\.5/);
  assert.match(script,/\/profile\/dsh\/profiles\/plugin/);
  assert.match(script,/--legacy-peer-deps/);
  // The plugin path must NOT be an argument of the host install command.
  assert.doesNotMatch(script,/dsh@\$\{JSON\.stringify\([^)]*\)\}[^\n]*\/tmp\/plugin'/);
});

test('install worker packs the plugin so bundled runtime dependencies are present', () => {
  // Regression: installing the plugin as a local PATH only records the directory and
  // never installs its own "dependencies". The plugin imports qrcode (bundled via
  // "bundleDependencies"), so the host died with module-not-found on every start.
  // Fix: install deps in place, `npm pack`, then install the tarball.
  const script = makeInstallWorker('0.2.2-rc.1');
  const checked = spawnSync(process.execPath,['--check','--input-type=module'],{input:script,encoding:'utf8'});
  assert.equal(checked.status,0,checked.stderr);
  // Dependencies must exist before packing (npm pack bundles from node_modules).
  assert.match(script,/cwd:'\/tmp\/plugin'/);
  assert.match(script,/pack/);
  // The installed artifact must be the tarball, not the source directory.
  assert.match(script,/plugin-dist/);
  // npm pack does not create its destination directory; without an explicit mkdir
  // it exits non-zero (observed 254) and the whole install stage fails.
  assert.match(script,/mkdirSync\('\/tmp\/plugin-dist'/);
  assert.match(script,/\.tgz/);
  // Still isolated from the host closure, and no link-based install remains.
  assert.doesNotMatch(script,/'--install-links'/);
  // Peer resolution MUST stay enabled: this plugin declares peers the host provides
  // (e.g. @deepseek-ai/schemastery). --legacy-peer-deps skips them and the host then
  // dies at startup with module-not-found.
  assert.doesNotMatch(script,/'--legacy-peer-deps'/);
});

test('runtime worker restores the bundle declaration that npm install overwrites', () => {
  // Regression: `npm install --prefix <profile>` rewrites the profile manifest
  // into a dependency list and drops dsh.profile.bundles. The host then loads no
  // bundle, webServer never appears, and this plugin stays pending until the
  // process exits reporting only "1 entry did not activate" -- which the canary
  // surfaced as a generic host startup failure.
  const script = makeRuntimeWorker();
  assert.match(script,/installed\.dsh = desired\.dsh/);
  assert.match(script,/readFile\('\/profile\/dsh\/profiles\/canary\/package\.json'/);
  assert.match(script,/profileFiles\(''\)\.manifest/);
  const checked = spawnSync(process.execPath,['--check','--input-type=module'],{input:script,encoding:'utf8'});
  assert.equal(checked.status,0,checked.stderr);
});

test('mocked canary reports a successful isolated run', async () => {
  const calls = [];
  const checks = ['auth','bootstrap','diagnostics',...['jobs.callerShape','jobs.eventsApi','settings.read','gateway.wireStream','permissionPresets.apply','permissionPresets.catalog','workspaceRegistry.stateWrite','gateway.eventsPeer'].map(name => `host-capability:${name}:ok`)];
  const result = await runCanary({hostVersion:'1.2.3', pluginRoot:'/plugin', pluginSha:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}, {
    prepare: async () => { calls.push('prepare'); return '/isolated'; },
    install: async () => calls.push('install'),
    isolatedRun: async () => { calls.push('isolated'); return checks; },
    cleanup: async () => calls.push('cleanup'),
  });
  assert.deepEqual(calls, ['prepare','install','isolated','cleanup']);
  assert.deepEqual(result, {schema:1, hostVersion:'1.2.3', pluginSha:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', status:'passed', stage:'complete', checks, errorCode:null});
});

test('runtime isolation failure is fail-closed and cleanup still runs without exposing error text', async () => {
  let cleaned = false;
  const result = await runCanary({hostVersion:'1.2.3', pluginRoot:'/plugin', pluginSha:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}, {
    prepare: async () => '/isolated', install: async () => {},
    isolatedRun: async () => { throw new Error('secret-token'); },
    cleanup: async () => { cleaned = true; },
  });
  assert.equal(cleaned, true);
  assert.equal(result.status, 'infrastructure-failure');
  assert.equal(result.stage, 'runtime');
  assert.equal(result.errorCode, 'unexpected-error');
  assert.doesNotMatch(JSON.stringify(result), /secret-token/);
});

test('install failure remains infrastructure failure and always cleans up', async () => {
  let cleaned = false, started = false;
  const result = await runCanary({hostVersion:'1.2.3',pluginRoot:'/plugin',pluginSha:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}, {
    prepare: async () => '/isolated', install: async () => { throw Error('registry error'); },
    isolatedRun: async () => { started = true; }, cleanup: async () => { cleaned = true; },
  });
  assert.equal(result.status, 'infrastructure-failure');
  assert.equal(result.stage, 'install');
  assert.equal(started, false);
  assert.equal(cleaned, true);
});

test('a real 0.2.1-rc.5 payload shape satisfies the probed contract', () => {
  // Shape captured from a real locally installed @deepseek-ai/dsh@0.2.1-rc.5
  // serving this plugin, including fields the canary does not read. One verbatim
  // sample guards against tightening the contract into something no real host
  // actually emits.
  const names = ['jobs.callerShape','jobs.eventsApi','settings.read','gateway.wireStream','permissionPresets.apply','permissionPresets.catalog','workspaceRegistry.stateWrite','gateway.eventsPeer'];
  const caps = Object.fromEntries(names.map(name => [name,'ok']));
  const pid = 24451;
  const unauth = {status:401,body:{error:'auth-required',detail:'访问口令未通过验证'}};
  const bootstrap = {status:200,body:{
    ok:true,
    auth:{enabled:true,source:'config'},
    server:{port:38123,urls:[],path:'/m'},
    connection:{state:'unavailable',source:'none',origins:[],reason:'bridge-disabled'},
    plugin:{name:'dsh-mobile-remote',version:'3.2.3-alpha.1',contentSha256:'16343c3f',pid,instanceId:'71b49ce3'},
    capabilities:{eventTimeline:{version:1,live:true,history:true},turnOutline:{version:1,supported:true},fileRange:{version:1,supported:true},hold:{version:1,onlineMs:120000,offlineMs:300000}},
    alignment:{appVersion:null,pluginVersion:'3.2.3-alpha.1',expectedAppVersion:'3.2.3',state:'unknown'},
    agents:[],sessions:[],
  }};
  const diagnostics = {status:200,body:{
    ok:true,
    plugin:{name:'dsh-mobile-remote',version:'3.2.3-alpha.1',contentSha256:'16343c3f',instanceId:'f84dab1b'},
    runtime:{form:'cli',host:'127.0.0.1',port:38124,authEnabled:true,lanBridge:{enabled:false,listening:false,phase:'disabled'},metrics:{agents:0,sessions:0}},
    services:{webServer:true,agents:true,sessions:true,llm:true,permissionPresets:true,agentPresets:true,workspaceRegistry:true,approval:true,credentials:true,messageFeedback:true,userQuestions:true},
    checks:{hostCapabilities:caps},
  }};
  assert.deepEqual(evaluateResponses(unauth,bootstrap,diagnostics,'3.2.3-alpha.1',pid),
    ['auth','bootstrap','diagnostics',...names.map(name => `host-capability:${name}:ok`)]);
});

test('browser-session-gated capabilities are reported but never decide the verdict', () => {
  // These become 'ok' only after a real browser GUI session connects. The canary
  // never opens a browser by design, so they stay missing/drift; judging them
  // would make every run inconclusive regardless of real compatibility. Their
  // compatibility is the human on-device verification the canary asks for.
  const names = ['jobs.callerShape','jobs.eventsApi','settings.read','gateway.wireStream','permissionPresets.apply','permissionPresets.catalog','workspaceRegistry.stateWrite','gateway.eventsPeer'];
  const pid = 7;
  const unauth = {status:401,body:{error:'auth-required'}};
  const bootstrap = {status:200,body:{ok:true,auth:{enabled:true},plugin:{name:'dsh-mobile-remote',version:'1.0.0',pid},capabilities:{}}};
  const diagnosticsWith = overrides => ({status:200,body:{ok:true,plugin:{name:'dsh-mobile-remote',version:'1.0.0'},runtime:{authEnabled:true,lanBridge:{listening:false}},services:{webServer:true},checks:{hostCapabilities:Object.fromEntries(names.map(n => [n, overrides[n] ?? 'ok']))}}});

  const sessionOnly = evaluateResponses(unauth,bootstrap,diagnosticsWith({'workspaceRegistry.stateWrite':'missing','gateway.eventsPeer':'drift'}),'1.0.0',pid);
  assert.equal(sessionOnly.length, 3 + names.length);
  assert.ok(sessionOnly.includes('host-capability:workspaceRegistry.stateWrite:missing'));
  assert.ok(sessionOnly.includes('host-capability:gateway.eventsPeer:drift'));

  assert.throws(() => evaluateResponses(unauth,bootstrap,diagnosticsWith({'settings.read':'drift'}),'1.0.0',pid), e => e.code === 'host-capabilities-inconclusive');
  assert.throws(() => evaluateResponses(unauth,bootstrap,diagnosticsWith({'gateway.wireStream':'missing'}),'1.0.0',pid), e => e.code === 'host-capabilities-inconclusive');
});

test('response contract checks identity, authentication, diagnostics and capability drift', () => {
  const names = ['jobs.callerShape','jobs.eventsApi','settings.read','gateway.wireStream','permissionPresets.apply','permissionPresets.catalog','workspaceRegistry.stateWrite','gateway.eventsPeer'];
  const caps = Object.fromEntries(names.map(name => [name,'ok']));
  const unauth = {status:401,body:{error:'auth-required'}};
  const bootstrap = {status:200,body:{ok:true,auth:{enabled:true},plugin:{name:'dsh-mobile-remote',version:'1.0.0',pid:123},capabilities:{}}};
  const diagnostics = {status:200,body:{ok:true,plugin:{name:'dsh-mobile-remote',version:'1.0.0'},runtime:{authEnabled:true,lanBridge:{listening:false}},services:{webServer:true},checks:{hostCapabilities:caps}}};
  const checks = evaluateResponses(unauth,bootstrap,diagnostics,'1.0.0',123);
  assert.deepEqual(checks.slice(0,3),['auth','bootstrap','diagnostics']);
  assert.deepEqual(checks.slice(3),names.map(name => `host-capability:${name}:ok`));
  assert.throws(() => evaluateResponses(unauth,bootstrap,diagnostics,'1.0.0',124), e => e.code === 'host-identity-inconclusive' && e.status === 'infrastructure-failure' && e.checks.join(',') === 'auth');
  assert.throws(() => evaluateResponses(unauth,bootstrap,diagnostics,'1.0.0',124,{bootstrap}), e => e.code === 'host-identity-inconclusive');
  const protocolDrift = structuredClone(bootstrap); protocolDrift.body.auth.enabled = false;
  assert.throws(() => evaluateResponses(unauth,protocolDrift,diagnostics,'1.0.0',123,{bootstrap:protocolDrift}), e => e.code === 'compatibility-check-failed');
  caps['settings.read'] = 'drift';
  assert.throws(() => evaluateResponses(unauth,bootstrap,diagnostics,'1.0.0',123), e => e.code === 'host-capabilities-inconclusive' && e.status === 'infrastructure-failure' && e.checks.includes('host-capability:settings.read:drift'));
  assert.throws(() => evaluateResponses(unauth,bootstrap,{status:500},'1.0.0',123), e => e.checks.join(',') === 'auth,bootstrap');
});

test('probe waits through non-ready responses without visiting arbitrary endpoints', async () => {
  const names = ['jobs.callerShape','jobs.eventsApi','settings.read','gateway.wireStream','permissionPresets.apply','permissionPresets.catalog','workspaceRegistry.stateWrite','gateway.eventsPeer'];
  const bootstrap = {status:200,body:{ok:true,auth:{enabled:true},plugin:{name:'dsh-mobile-remote',version:'1.0.0',pid:9},capabilities:{}}};
  const diagnostics = {status:200,body:{ok:true,plugin:{name:'dsh-mobile-remote',version:'1.0.0'},runtime:{authEnabled:true,lanBridge:{listening:false}},services:{webServer:true},checks:{hostCapabilities:Object.fromEntries(names.map(name => [name,'ok']))}}};
  const boot = {status:401,body:{error:'auth-required'}};
  const responses = [{status:503},{status:404},boot,boot,bootstrap,bootstrap,boot,boot,diagnostics,diagnostics];
  const seen = [], readinessDelays = []; let child = 'starting';
  const checks = await probeMobile({token:'secret',version:'1.0.0',pid:9,maxAttempts:4,childState:() => child,delay:async ms => { readinessDelays.push(ms); child = 'running'; },request:async (path,token) => { seen.push([path,token]); return responses.shift(); }});
  assert.deepEqual(readinessDelays,[500,500]);
  assert.deepEqual(checks.slice(0,3),['auth','bootstrap','diagnostics']);
  assert.ok(seen.every(([path]) => ['/m/api/bootstrap','/m/api/diagnostics'].includes(path)));
  assert.ok(seen.slice(0,3).every(([,token]) => token === null));
  const missing = structuredClone(diagnostics); missing.body.checks.hostCapabilities['settings.read'] = 'missing';
  assert.equal(seen.filter(([,credential]) => credential === 'canary-invalid').length,2);
  assert.deepEqual(seen.filter(([,credential]) => credential === 'canary-invalid').map(([path]) => path),['/m/api/bootstrap','/m/api/diagnostics']);
  assert.deepEqual(seen.slice(3),[['/m/api/bootstrap','canary-invalid'],['/m/api/bootstrap','secret'],['/m/api/bootstrap','secret'],['/m/api/diagnostics',null],['/m/api/diagnostics','canary-invalid'],['/m/api/diagnostics','secret'],['/m/api/diagnostics','secret']]);
  const exposed = [boot,boot,bootstrap,bootstrap,{status:200,body:{ok:true}}];
  await assert.rejects(probeMobile({token:'secret',version:'1.0.0',pid:9,maxAttempts:2,delay:async () => {},request:async () => exposed.shift()}),e => e.code === 'host-auth-response-inconclusive' && e.status === 'infrastructure-failure');
  let retryResponses = [boot,boot,bootstrap,bootstrap,boot,boot,missing,missing,diagnostics,diagnostics], delays = 0;
  const recovered = await probeMobile({token:'secret',version:'1.0.0',pid:9,maxAttempts:2,maxDiagnosticAttempts:2,delay:async () => { delays++; },request:async () => retryResponses.shift()});
  assert.ok(recovered.includes('host-capability:settings.read:ok'), 'recovered capability reported ok'); assert.equal(delays,1);
  retryResponses = [boot,boot,bootstrap,bootstrap,boot,boot,missing,missing,missing,missing]; delays = 0;
  await assert.rejects(probeMobile({token:'secret',version:'1.0.0',pid:9,maxAttempts:2,maxDiagnosticAttempts:2,delay:async () => { delays++; },request:async () => retryResponses.shift()}),e => e.code === 'host-capabilities-inconclusive' && e.status === 'infrastructure-failure');
  assert.equal(delays,1);
  let index = 0, observedBudget;
  const started = performance.now();
  await assert.rejects(probeMobile({token:'secret',version:'1.0.0',pid:9,diagnosticBudgetMs:25,delay:async () => {},request:async (_path,_token,budget) => {
    const current = index++;
    if ([0,1,4,5].includes(current)) return boot;
    if ([2,3].includes(current)) return bootstrap;
    observedBudget = budget; return new Promise(() => {});
  }}),e => e.code === 'response-inconclusive');
  assert.ok(observedBudget <= 25); assert.ok(performance.now() - started < 500);
  await assert.rejects(probeMobile({token:'secret',version:'1.0.0',pid:9,maxAttempts:2,delay:async () => {},request:async () => ({status:503})}), e => e.code === 'host-ready-timeout' && e.status === 'infrastructure-failure');
});

test('probe rejects exit during diagnostics even with valid responses', async () => {
  const names = ['jobs.callerShape','jobs.eventsApi','settings.read','gateway.wireStream','permissionPresets.apply','permissionPresets.catalog','workspaceRegistry.stateWrite','gateway.eventsPeer'];
  const denied = {status:401,body:{error:'auth-required'}};
  const bootstrap = {status:200,body:{ok:true,auth:{enabled:true},plugin:{name:'dsh-mobile-remote',version:'1.0.0',pid:9},capabilities:{}}};
  const diagnostics = {status:200,body:{ok:true,plugin:{name:'dsh-mobile-remote',version:'1.0.0'},runtime:{authEnabled:true,lanBridge:{listening:false}},services:{webServer:true},checks:{hostCapabilities:Object.fromEntries(names.map(name => [name,'ok']))}}};
  const responses = [denied,denied,bootstrap,bootstrap,denied,denied,diagnostics,diagnostics];
  let state = 'running';
  await assert.rejects(probeMobile({token:'secret',version:'1.0.0',pid:9,delay:async () => {},childState:() => state,request:async () => { const response = responses.shift(); if (response === diagnostics) state='exited'; return response; }}),e => e.code === 'host-process-exited' && e.status === 'infrastructure-failure');
  const pending = [denied,denied,bootstrap,bootstrap,denied,denied,diagnostics,diagnostics]; state = 'running';
  await assert.rejects(probeMobile({token:'secret',version:'1.0.0',pid:9,delay:async () => {},childState:() => state,request:async () => { const response = pending.shift(); if (response === diagnostics) state='starting'; return response; }}),e => e.code === 'host-process-state-inconclusive' && e.status === 'infrastructure-failure');
});

test('generated workers define every module-level constant they reference', () => {
  // Regression guard: workers are built by string-concatenating function bodies, so a
  // newly extracted constant is referenced but never defined, producing a runtime
  // ReferenceError that degrades to a generic failure code. Assert each worker that
  // references one of our shared constants also DEFINES it.
  const shared = ['HINT_CODES','MISSING_DEPENDENCY_SPECIFIERS','sessionGatedCapabilityNames','capabilityNames'];
  for (const [label, script] of [['install',makeInstallWorker('0.2.2-rc.1')],['runtime',makeRuntimeWorker()]]) {
    for (const name of shared) {
      if (!script.includes(name)) continue;
      const defined = new RegExp(`(?:const|let|var)\\s+${name}\\s*=`).test(script);
      assert.ok(defined, `${label} worker references ${name} but never defines it`);
    }
    const checked = spawnSync(process.execPath,['--check','--input-type=module'],{input:script,encoding:'utf8'});
    assert.equal(checked.status,0,`${label} worker syntax: ${checked.stderr}`);
  }
});

test('startup failures on stdout or stderr both yield a fixed hint code', () => {
  // The host CLI may report a startup failure on either stream; stdout used to be
  // discarded entirely, leaving only a catch-all code with no actionable signal.
  const mk = () => { const h = {}; return { readableEnded:false, destroyed:false,
    setEncoding(){}, on(e,f){ (h[e] ??= []).push(f); }, off(){}, destroy(){ this.destroyed = true; },
    emit(e,c){ (h[e] ?? []).forEach(f => f(c)); } }; };
  const stdout = mk(), stderr = mk();
  const collector = createStderrCollector(stderr, stdout);
  stdout.emit('data','banner\nError: listen EADDRINUSE: address already in use\n');
  assert.equal(collector.hint(),'host-process-exited-hint-port-in-use');
  collector.destroy();
  assert.equal(stdout.destroyed,true); assert.equal(stderr.destroyed,true);

  // The retained window is BOUNDED and keeps the newest bytes, so a failure at the
  // end of a long stream is still detected (a first-4KB buffer would miss it).
  const noisyOut = mk(), noisyErr = mk();
  const noisy = createStderrCollector(noisyErr, noisyOut);
  for (let i = 0; i < 200; i++) noisyOut.emit('data','x'.repeat(1000));
  noisyOut.emit('data','\nFATAL ERROR: Reached heap limit Allocation failed\n');
  assert.equal(noisy.hint(),'host-process-exited-hint-out-of-memory');
  noisy.destroy();
});

test('a missing well-known dependency is attributed to a specific fixed code', () => {
  // Generic "module-not-found" costs a whole hosted round-trip to disambiguate.
  // For a closed allowlist of packages this plugin actually imports, report which
  // one is missing. The raw specifier must never appear in the emitted code.
  const mk = spec => `Error [ERR_MODULE_NOT_FOUND]: Cannot find package '${spec}' imported from /a/b`;
  assert.equal(stderrExitHint(mk('@deepseek-ai/schemastery')),'host-process-exited-hint-missing-schemastery');
  assert.equal(stderrExitHint(mk('@deepseek-ai/dsh-llm')),'host-process-exited-hint-missing-dsh-llm');
  assert.equal(stderrExitHint(mk('@deepseek-ai/dsh-credentials')),'host-process-exited-hint-missing-dsh-credentials');
  assert.equal(stderrExitHint(mk('qrcode')),'host-process-exited-hint-missing-qrcode');
  // Unknown packages stay generic: the allowlist must not become an oracle for
  // arbitrary module names, and nothing derived from them may leak.
  assert.equal(stderrExitHint(mk('some-other-pkg')),'host-process-exited-hint-module-not-found');
  for (const [, code] of MISSING_DEPENDENCY_SPECIFIERS) {
    assert.match(code,/^host-process-exited-hint-missing-[a-z-]+$/);
    assert.ok(HINT_CODES.includes(code), code);
  }
});

test('every emitted hint code is a fixed constant and never carries raw text', () => {
  // Security invariant: widening capture must not widen what leaves the process.
  const samples = [
    'Error: listen EADDRINUSE',
    'FATAL ERROR: Reached heap limit Allocation failed',
    'npm ERR! code EBADENGINE Unsupported engine',
    'dsh: profile \"canary\" does not exist',
    'Error: EACCES /private/path/secret-token',
    'Error: EPERM /private/path/secret-token',
    'Error: EROFS /private/path',
    'Error: ENOSPC /private/path',
    'plain unrelated output /private/path secret-token',
  ];
  for (const sample of samples) {
    const hint = stderrExitHint(sample);
    if (hint !== null) {
      assert.match(hint,/^host-process-exited-hint-[a-z-]+$/);
      assert.doesNotMatch(hint,/secret|private|\//);
    }
  }
  // Newly recognised causes stay within the declared closed set.
  for (const code of ['host-process-exited-hint-port-in-use','host-process-exited-hint-out-of-memory','host-process-exited-hint-engine-mismatch','host-process-exited-hint-bad-invocation']) {
    assert.ok(HINT_CODES.includes(code), code);
  }
});

test('startup audit hint requires a complete authentic-shaped stderr line', async () => {
  const one = 'dsh: startup failed: 1 required plugin did not activate\n';
  const many = 'dsh: startup failed: 27 required plugins did not activate\r\n';
  const code = 'host-process-exited-hint-startup-audit';
  assert.equal(stderrExitHint(one),code);
  assert.equal(stderrExitHint(`secret-token /private/path\n${many}secret-token`),code);
  for (const count of [2,9,10,99,100,1000]) assert.equal(stderrExitHint(`dsh: startup failed: ${count} required plugins did not activate\n`),code);
  const exactBoundary = `${'x'.repeat(4096-one.length-1)}\n${one}`;
  assert.equal(exactBoundary.length,4096); assert.equal(stderrExitHint(exactBoundary),code);
  for (const value of [
    one.slice(0,-1), many.slice(0,-1), `prefix ${one}`,
    'dsh: startup failed: 0 required plugins did not activate\n',
    'dsh: startup failed: 01 required plugins did not activate\n',
    'dsh: startup failed: 1 required plugins did not activate\n',
    'dsh: startup failed: 2 required plugin did not activate\n',
    'dsh: startup failed: 2 required plugins did not activate extra\n',
    `\u001b[31m${one}`, `${'x'.repeat(4095)}\n${one}`,
    `${'x'.repeat(4096-one.length)}\n${one}`,
  ]) assert.equal(stderrExitHint(value),null);
  for (const [other,expected] of [['uv_os_get_passwd','host-process-exited-hint-user-lookup'],['EACCES','host-process-exited-hint-eacces'],['EROFS','host-process-exited-hint-erofs'],['ENOENT','host-process-exited-hint-enoent'],['ENOSPC','host-process-exited-hint-enospc'],['ERR_MODULE_NOT_FOUND','host-process-exited-hint-module-not-found'],['ERR_DLOPEN_FAILED','host-process-exited-hint-native-load']]) {
    assert.equal(stderrExitHint(`${one}${other}`),expected);
    assert.equal(stderrExitHint(`${other}\n${one}`),expected);
  }
  const stream = new PassThrough(), collector = createStderrCollector(stream);
  stream.write(one.slice(0,-1)); assert.equal(collector.hint(),null);
  stream.write('\n'); assert.equal(collector.hint(),code); collector.destroy();
  await assert.rejects(probeMobile({token:'secret-token',version:'1.0.0',pid:9,delay:async () => {},childState:() => 'exited',childExitHint:() => stderrExitHint(`secret-token /private/path\n${one}`),request:async () => ({status:0})}),e => e.code === code && e.status === 'infrastructure-failure' && !/secret-token|\/private\/path|\b1\b/.test(e.message));
});

test('stderr exit hints are fixed, bounded, and never return raw content', async () => {
  for (const [text,code] of [['secret-token /private/path EACCES','host-process-exited-hint-eacces'],['secret-token EROFS','host-process-exited-hint-erofs'],['secret-token ENOENT','host-process-exited-hint-enoent'],['secret-token ENOSPC','host-process-exited-hint-enospc'],['uv_os_get_passwd ENOENT secret-token','host-process-exited-hint-user-lookup']]) {
    const hint = stderrExitHint(text); assert.equal(hint,code);
    assert.doesNotMatch(hint,/secret-token|\/private\/path/);
  }
  assert.equal(stderrExitHint('x'.repeat(4096) + ' EACCES secret-token'),null);
  assert.equal(stderrExitHint('EACCES_FAKE'),null);
  assert.equal(stderrExitHint('secret-token /private/path ERR_MODULE_NOT_FOUND'),'host-process-exited-hint-module-not-found');
  assert.equal(stderrExitHint('MODULE_NOT_FOUND'),'host-process-exited-hint-module-not-found');
  assert.equal(stderrExitHint('secret-token ERR_DLOPEN_FAILED'),'host-process-exited-hint-native-load');
  assert.equal(stderrExitHint('FAKE_ERR_MODULE_NOT_FOUND_SUFFIX'),null);
  assert.equal(stderrExitHint('ERR_DLOPEN_FAILED_SUFFIX'),null);
  assert.equal(stderrExitHint('ERR_MODULE_NOT_FOUND EACCES'),'host-process-exited-hint-eacces');
  assert.equal(stderrExitHint('ERR_DLOPEN_FAILED ENOENT'),'host-process-exited-hint-enoent');
  assert.equal(stderrExitHint({toString:() => { throw Error('secret-token'); }}),null);
  await assert.rejects(probeMobile({token:'secret-token',version:'1.0.0',pid:9,delay:async () => {},childState:() => 'exited',childExitHint:() => stderrExitHint('secret-token /private/path EROFS'),request:async () => ({status:0})}),e => e.code === 'host-process-exited-hint-erofs' && e.status === 'infrastructure-failure' && !e.message.includes('secret-token'));
  await assert.rejects(probeMobile({token:'secret-token',version:'1.0.0',pid:9,delay:async () => {},childState:() => 'exited',childExitHint:() => 'secret-token /private/path',request:async () => ({status:0})}),e => e.code === 'host-process-exited' && !e.message.includes('secret-token'));
});

test('fast-exit without a readable /proc baseline keeps an already captured stderr hint', async () => {
  // A host can exit before the monitor's baseline stat; the process identity is
  // then unprovable, but a bounded stderr hint is still real evidence from this
  // child and must not be replaced by a state-inconclusive code.
  const child = new EventEmitter(); child.pid = 424242; child.exitCode = null; child.signalCode = null;
  const gone = () => { const error = Error('ENOENT'); error.code = 'ENOENT'; throw error; };
  const monitor = createLinuxChildMonitor(child,() => readLinuxProcessStat(424242,gone,'linux'));
  assert.equal(monitor(),'exited');
  const audit = 'dsh: startup failed: 3 required plugins did not activate\n';
  await assert.rejects(probeMobile({token:'secret-token',version:'1.0.0',pid:424242,delay:async () => {},childState:monitor,childExitHint:() => stderrExitHint(`secret-token /private/path\n${audit}`),request:async () => ({status:0})}),e => e.code === 'host-process-exited-hint-startup-audit' && e.status === 'infrastructure-failure' && !e.message.includes('secret-token'));
  // A genuinely unreadable /proc entry is unprovable and must still fail closed.
  const unreadableChild = new EventEmitter(); unreadableChild.pid = 424243; unreadableChild.exitCode = null; unreadableChild.signalCode = null;
  const unreadable = createLinuxChildMonitor(unreadableChild,() => ({state:'unknown',startTime:null}));
  assert.equal(unreadable(),'proc-unknown');
  await assert.rejects(probeMobile({token:'secret-token',version:'1.0.0',pid:424243,delay:async () => {},childState:unreadable,childExitHint:() => stderrExitHint('secret-token /private/path'),request:async () => ({status:0})}),e => e.code === 'host-process-state-inconclusive' && e.status === 'infrastructure-failure');
});

test('exit observer emits only coarse codes after a consistent exit event', () => {
  const make = () => { const child = new EventEmitter(); child.exitCode = null; child.signalCode = null; return child; };
  const child = make(), observer = createChildExitObserver(child);
  assert.equal(observer.status(),null);
  child.exitCode = 0; assert.equal(observer.status(),null); // no event yet
  child.emit('exit',0,null); assert.equal(observer.status(),'host-process-exited-zero');
  child.signalCode = 'SIGTERM'; assert.equal(observer.status(),null); // contradiction
  observer.destroy();
  const other = make(), nonzero = createChildExitObserver(other);
  other.exitCode = 17; other.emit('exit',17,null); assert.equal(nonzero.status(),'host-process-exited-nonzero'); nonzero.destroy();
  const signaled = make(), signalObserver = createChildExitObserver(signaled);
  signaled.signalCode='SIGTERM'; signaled.emit('exit',null,'SIGTERM'); assert.equal(signalObserver.status(),'host-process-exited-signal'); signalObserver.destroy();
  const malformed = make(), invalid = createChildExitObserver(malformed);
  malformed.exitCode=999; malformed.emit('exit',999,null); assert.equal(invalid.status(),null); invalid.destroy();
});

test('stderr drain and exit observation share one wait budget', async () => {
  const child = new EventEmitter(); child.exitCode=null; child.signalCode=null;
  const observer = createChildExitObserver(child); let drainStarted=false, waitStarted=false, release;
  const drain = async () => { drainStarted = true; if (waitStarted) release(); await new Promise(resolve => { release=resolve; if (waitStarted) resolve(); }); };
  const wait = async () => { waitStarted = true; if (drainStarted && release) release(); child.exitCode=5; child.emit('exit',5,null); };
  const code = await resolveExitedChildHint('host-process-exited',drain,() => null,100,{status:observer.status,wait});
  assert.equal(drainStarted,true); assert.equal(waitStarted,true); assert.equal(code,'host-process-exited-nonzero');
  assert.equal(await resolveExitedChildHint('host-process-exited',async () => {},() => 'host-process-exited-hint-eacces',20,observer),'host-process-exited-hint-eacces');
  observer.destroy();
  const pending = new EventEmitter(); pending.exitCode=null; pending.signalCode=null;
  const late = createChildExitObserver(pending);
  const beforeEvent = await resolveExitedChildHint('host-process-exited',async () => {},() => null,10,late);
  assert.equal(beforeEvent,'host-process-exited');
  assert.equal(pending.listenerCount('close'),0); assert.equal(pending.listenerCount('error'),0);
  pending.exitCode=7; pending.emit('exit',7,null); assert.equal(late.status(),'host-process-exited-nonzero');
  assert.equal(beforeEvent,'host-process-exited'); late.destroy();
});

test('stderr drain is bounded, sanitized, and preserves hint priority', async () => {
  let observed;
  const start = performance.now();
  const timeout = await resolveExitedChildHint('host-process-exited',ms => { observed = ms; return new Promise(() => {}); },() => 'secret-token /private/path',20);
  assert.equal(timeout,'host-process-exited'); assert.equal(observed,20); assert.ok(performance.now()-start < 500);
  let stderr = 'ENOENT';
  const priority = await resolveExitedChildHint('host-process-exited-hint-enoent',async () => { stderr += ' uv_os_get_passwd secret-token'; },() => stderrExitHint(stderr),50);
  assert.equal(priority,'host-process-exited-hint-user-lookup');
  assert.equal(await resolveExitedChildHint('host-process-exited',async () => { throw Error('secret-token'); },() => { throw Error('/private/path'); },10),'host-process-exited');
  let drained = false;
  await assert.rejects(probeMobile({token:'secret-token',version:'1.0.0',pid:9,delay:async () => {},childState:() => 'spawn-error',childStderrDrain:async () => { drained=true; },request:async () => ({status:0})}),e => e.code === 'host-process-spawn-failed');
  assert.equal(drained,false);
  let remaining;
  const resultStart = performance.now();
  await assert.rejects(probeMobile({token:'secret-token',version:'1.0.0',pid:9,delay:async () => {},childState:() => 'exited',childStderrDrain:ms => { remaining=ms; return new Promise(() => {}); },overallDeadline:performance.now()+20,request:async () => ({status:0})}),e => e.code === 'host-process-exited' && !e.message.includes('secret-token'));
  assert.ok(remaining >= 0 && remaining <= 20); assert.ok(performance.now()-resultStart < 500);
});

test('probe respects total budget reserved for stderr drain', async () => {
  let now = 0; const budgets = [];
  const rejected = {status:401,body:{error:'auth-required'}};
  await assert.rejects(probeMobile({token:'secret-token',version:'1.0.0',pid:9,clock:() => now,overallDeadline:300,stderrDrainBudgetMs:250,delay:async () => {},request:async (_path,_token,budget) => { budgets.push(budget); now += 30; return rejected; }}),e => e.status === 'infrastructure-failure');
  assert.deepEqual(budgets,[50,20]);
});

test('startup failure codes distinguish child state and hide raw errors', async () => {
  const base = {token:'secret-token',version:'1.0.0',pid:9,delay:async () => {},readinessBudgetMs:20,request:async () => ({status:503})};
  const assertCode = code => e => e.code === code && e.status === 'infrastructure-failure' && !JSON.stringify({code:e.code,detail:e.message}).includes('secret-token');
  await assert.rejects(probeMobile({...base,childState:() => 'spawn-error'}),assertCode('host-process-spawn-failed'));
  let unknownRequests = 0;
  await assert.rejects(probeMobile({...base,childState:() => 'proc-unknown',request:async () => { unknownRequests++; }}),assertCode('host-process-state-inconclusive'));
  assert.equal(unknownRequests,0);
  await assert.rejects(probeMobile({...base,childState:() => 'starting',maxAttempts:1}),assertCode('host-process-spawn-inconclusive'));
  let state = 'running';
  await assert.rejects(probeMobile({...base,childState:() => state,request:async () => { state = 'exited'; throw Error('secret-token /private/path'); }}),assertCode('host-process-exited'));
  await assert.rejects(probeMobile({...base,childState:() => 'running',request:async () => new Promise(() => {})}),assertCode('host-ready-timeout'));
  state = 'running'; let requests = 0;
  await assert.rejects(probeMobile({...base,childState:() => state,request:async () => { requests++; state = 'exited'; return {status:401,body:{error:'auth-required'}}; }}),assertCode('host-process-exited'));
  assert.equal(requests,1);
  let now = 0;
  await assert.rejects(probeMobile({...base,clock:() => now,childState:() => 'running',delay:async () => { now += 20; }}),assertCode('host-ready-timeout'));
  let attempt = 0;
  await assert.rejects(probeMobile({...base,childState:() => 'running',request:async () => ++attempt === 1 ? {status:401,body:{error:'auth-required'}} : {status:403,body:{detail:'secret-token /private/path'}}}),assertCode('host-auth-response-inconclusive'));
});

test('Linux proc monitor rejects PID reuse, invalid stat and missing proc', () => {
  const stat = (pid,state,start) => `${pid} (worker ) name) ${state} ${Array(18).fill('0').join(' ')} ${start} 0`;
  assert.deepEqual(readLinuxProcessStat(123,() => stat(123,'S','12345'),'linux'),{state:'running',startTime:'12345'});
  assert.equal(readLinuxProcessStat(123,() => stat(123,'Z','12345'),'linux').state,'exited');
  assert.equal(readLinuxProcessStat(123,() => 'secret-token /bad/path','linux').state,'unknown');
  assert.equal(readLinuxProcessStat(123,() => { throw Error('secret-token'); },'linux').state,'unknown');
  assert.equal(readLinuxProcessStat(123,() => stat(123,'D','12345'),'linux').state,'unknown');
  const child = new EventEmitter(); child.pid=123; child.exitCode=null; child.signalCode=null;
  let reads = 0;
  const monitor = createLinuxChildMonitor(child,() => ++reads === 1 ? {state:'running',startTime:'12345'} : {state:'running',startTime:'12346'});
  assert.equal(monitor(),'proc-unknown');
});

test('actual stderr collector bounds memory and detaches listeners', async () => {
  const stream = new PassThrough(), collector = createStderrCollector(stream);
  // The retained window is bounded but keeps the NEWEST bytes, so a failure that
  // arrives after a long preamble is still recognised (that is the point of the
  // window: startup failures are reported at the end of the stream).
  stream.write('x'.repeat(4096) + ' EACCES secret-token'); stream.end();
  await collector.drain(25);
  assert.equal(collector.hint(),'host-process-exited-hint-eacces');
  assert.equal(stream.listenerCount('end'),0); assert.equal(stream.listenerCount('close'),0);
  collector.destroy();
  assert.equal(stream.listenerCount('data'),0); assert.equal(stream.listenerCount('error'),0);
  const second = new PassThrough(), other = createStderrCollector(second);
  const pending = other.drain(25); queueMicrotask(() => second.emit('error',Error('secret-token /private/path')));
  await pending; assert.equal(other.hint(),null);
  assert.equal(second.listenerCount('end'),0); assert.equal(second.listenerCount('close'),0);
  other.destroy(); assert.equal(second.listenerCount('error'),0);
});

test('zombie stderr hint survives asynchronous pipe drain', async t => {
  if (process.platform !== 'linux') return t.skip('Linux /proc required');
  const child = spawn(process.execPath,['-e',`require('node:fs').writeSync(2,'secret-token /private/path EACCES'); process.exit(1)`],{stdio:['ignore','ignore','pipe']});
  const monitor = createLinuxChildMonitor(child);
  const collector = createStderrCollector(child.stderr);
  const closed = new Promise(resolve => child.once('close',resolve));
  const lock = new Int32Array(new SharedArrayBuffer(4)), deadline = Date.now() + 3000;
  while (Date.now() < deadline && readLinuxProcessStat(child.pid).state !== 'exited') Atomics.wait(lock,0,0,10);
  try {
    assert.equal(readLinuxProcessStat(child.pid).state,'exited');
    assert.equal(child.exitCode,null); assert.equal(collector.hint(),null);
    await assert.rejects(probeMobile({token:'secret-token',version:'1.0.0',pid:child.pid,delay:async () => {},childState:monitor,childExitHint:collector.hint,childStderrDrain:collector.drain,request:async () => ({status:0})}), e => e.code === 'host-process-exited-hint-eacces' && !e.message.includes('secret-token') && !e.message.includes('/private/path'));
  } finally { collector.destroy(); await closed; }
});

test('inherited stderr pipe cannot hold exit diagnostics open', async t => {
  if (process.platform !== 'linux') return t.skip('Linux /proc required');
  // The descendant naturally exits after one second, even if this test fails;
  // no detached process group, group signal, or daemon is involved.
  const code = `const {spawn}=require('node:child_process'); const g=spawn(process.execPath,['-e','setTimeout(()=>{},1000)'],{stdio:['ignore','ignore',2]}); g.unref(); require('node:fs').writeSync(1,String(g.pid)); require('node:fs').writeSync(2,'secret-token /private/path EROFS'); process.exit(1);`;
  const child = spawn(process.execPath,['-e',code],{stdio:['ignore','pipe','pipe'],timeout:1500});
  let grandchildText = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data',chunk => { if (grandchildText.length < 20) grandchildText += chunk.slice(0,20-grandchildText.length); });
  const monitor = createLinuxChildMonitor(child), collector = createStderrCollector(child.stderr);
  const closed = new Promise(resolve => child.once('close',resolve));
  const lock = new Int32Array(new SharedArrayBuffer(4)), deadline = Date.now()+3000;
  while (Date.now()<deadline && readLinuxProcessStat(child.pid).state !== 'exited') Atomics.wait(lock,0,0,10);
  try {
    assert.equal(readLinuxProcessStat(child.pid).state,'exited');
    const start = performance.now();
    await assert.rejects(probeMobile({token:'secret-token',version:'1.0.0',pid:child.pid,delay:async () => {},childState:monitor,childExitHint:collector.hint,childStderrDrain:collector.drain,stderrDrainBudgetMs:25,request:async () => ({status:0})}),e => e.code === 'host-process-exited-hint-erofs' && !e.message.includes('secret-token') && !e.message.includes('/private/path'));
    const shortElapsed = performance.now()-start;
    assert.ok(shortElapsed >= 15 && shortElapsed < 500,`25ms drain elapsed ${shortElapsed}`);
    assert.match(grandchildText,/^[1-9][0-9]*$/);
    const longDrain = performance.now();
    await collector.drain(250);
    const longElapsed = performance.now()-longDrain;
    assert.ok(longElapsed >= 200 && longElapsed < 600,`250ms drain elapsed ${longElapsed}`);
    assert.equal(child.stderr.readableEnded,false);
    assert.equal(child.stderr.destroyed,false);
  } finally {
    collector.destroy();
    let timer;
    try { await Promise.race([closed,new Promise((_,reject) => { timer=setTimeout(() => reject(Error('owned child close timeout')),1800); })]); }
    finally { clearTimeout(timer); }
    // Observe only the exact recorded descendant PID; never signal it or its
    // process group. A zombie is dead but may still await the system reaper.
    if (/^[1-9][0-9]*$/.test(grandchildText)) {
      const pid = Number(grandchildText), initial = readLinuxProcessStat(pid);
      const until = performance.now() + 2000;
      let ended = initial.state === 'exited';
      while (!ended && performance.now() < until) {
        const current = readLinuxProcessStat(pid);
        if (current.state === 'exited' || (initial.startTime && current.startTime && initial.startTime !== current.startTime)) ended = true;
        else if (current.startTime === null) {
          try { await lstat(`/proc/${pid}`); } catch (error) { if (error.code === 'ENOENT') ended = true; else throw error; }
        }
        if (!ended) await new Promise(resolve => setTimeout(resolve,25));
      }
      assert.equal(ended,true,'self-limited descendant did not exit in time');
    }
  }
});

test('real local child exits map to fixed coarse categories only', async t => {
  if (process.platform !== 'linux') return t.skip('Linux /proc required');
  for (const [code,expected] of [['process.exit(0)','host-process-exited-zero'],['process.exit(17)','host-process-exited-nonzero'],["process.kill(process.pid,'SIGTERM')",'host-process-exited-signal']]) {
    const child = spawn(process.execPath,['-e',code],{stdio:['ignore','ignore','pipe'],timeout:2000});
    const observer = createChildExitObserver(child), monitor = createLinuxChildMonitor(child), collector = createStderrCollector(child.stderr);
    const closed = new Promise(resolve => child.once('close',resolve));
    const lock = new Int32Array(new SharedArrayBuffer(4)), deadline = Date.now()+2000;
    while (Date.now()<deadline && readLinuxProcessStat(child.pid).state !== 'exited') Atomics.wait(lock,0,0,10);
    try {
      assert.equal(readLinuxProcessStat(child.pid).state,'exited');
      assert.equal(child.exitCode,null);
      await assert.rejects(probeMobile({token:'synthetic-secret',version:'1.0.0',pid:child.pid,delay:async () => {},childState:monitor,childExitHint:collector.hint,childStderrDrain:collector.drain,childExitObserver:observer,request:async () => ({status:0})}),error => error.code === expected && error.status === 'infrastructure-failure' && !/synthetic-secret|SIGTERM|\b17\b/.test(error.message));
    } finally {
      observer.destroy(); collector.destroy();
      let timer; try { await Promise.race([closed,new Promise((_,reject) => { timer=setTimeout(() => reject(Error('owned child close timeout')),2500); })]); } finally { clearTimeout(timer); }
    }
  }
});

test('Linux zombie is detected before Node exit callback runs', async t => {
  if (process.platform !== 'linux') return t.skip('Linux /proc required');
  const child = spawn(process.execPath,['-e','process.exit(0)'],{stdio:'ignore'});
  const monitor = createLinuxChildMonitor(child);
  const lock = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 3000; let state;
  while (Date.now() < deadline) {
    Atomics.wait(lock,0,0,10); // Deliberately block Node exit-event delivery.
    state = readLinuxProcessStat(child.pid);
    if (state.state === 'exited') break;
  }
  assert.equal(state.state,'exited');
  assert.equal(child.exitCode,null);
  assert.equal(monitor(),'exited');
  await once(child,'exit');
});

test('startup and transient responses never become compatibility failures', () => {
  for (const response of [{status:0,body:null},{status:503,body:{}},{status:404,body:{error:'not-found'}}]) {
    assert.throws(() => evaluateResponses(response,null,null,'1.0.0',1,{auth:response}), e => e.status === 'infrastructure-failure' && e.code === 'response-inconclusive');
  }
  const auth = {status:401,body:{error:'auth-required'}};
  const down = {status:503,body:{}};
  assert.throws(() => evaluateResponses(auth,down,null,'1.0.0',1,{bootstrap:down}), e => e.status === 'infrastructure-failure');
});

test('unpinned version is rejected before any operation', async () => {
  const result = await runCanary({hostVersion:'latest',pluginRoot:'/plugin',pluginSha:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}, {});
  assert.equal(result.errorCode, 'invalid-input');
  assert.equal(result.stage, 'validate');
});

test('CLI runs the real backend but stays fail-closed outside a hosted runner', async t => {
  const root = await mkdtemp(join(tmpdir(),'canary-test-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const file = new URL('../tools/host-canary/smoke.mjs', import.meta.url).pathname;
  const help = execFileSync(process.execPath,[file,'--help'],{encoding:'utf8'});
  assert.match(help,/--host-version VERSION/);
  // The backend is implemented now; help must no longer claim it is not.
  assert.doesNotMatch(help,/not implemented/);

  // Outside a hosted runner the CLI must refuse before touching Docker.
  const out = join(root,'result.json');
  const local = spawnSync(process.execPath,[file,'--host-version','1.2.3','--plugin-root','/missing','--out',out],{encoding:'utf8',env:{...process.env,GITHUB_ACTIONS:'',RUNNER_ENVIRONMENT:'',RELEASE_SHA:'a'.repeat(40)}});
  assert.equal(local.status,2);
  assert.equal(JSON.parse(await readFile(out,'utf8')).errorCode,'runner-not-ephemeral');

  // Claiming to be hosted is not enough either unless the runner identity is usable:
  // here /missing cannot be a valid git plugin root, so it fails closed harmlessly.
  const claimed = spawnSync(process.execPath,[file,'--host-version','1.2.3','--plugin-root','/missing','--out',join(root,'claimed.json')],{encoding:'utf8',env:{...process.env,GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',RELEASE_SHA:'a'.repeat(40)}});
  assert.equal(claimed.status,2);
  const claimedResult = JSON.parse(await readFile(join(root,'claimed.json'),'utf8'));
  assert.equal(claimedResult.status,'infrastructure-failure');
  assert.notEqual(claimedResult.status,'passed');

  const worker = spawnSync(process.execPath,[file,'--internal-worker','/nonexistent'],{encoding:'utf8'});
  assert.equal(worker.status, 1);
  assert.equal(JSON.parse(worker.stdout).errorCode,'runtime-sandbox-unavailable');
});
