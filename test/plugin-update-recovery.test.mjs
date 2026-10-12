import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runSelfUpdate } from '../lib/plugin-self-update.js';
import { superviseUpdate } from '../lib/update-supervisor.js';
import { readLock, readTransaction, updateLockPath, snapshotDir, snapshotRoot, writeOwnedTransaction, releaseLock } from '../lib/plugin-update-transaction.js';
import { pluginContentDigest } from '../lib/plugin-content-digest.js';
const old = "export const content='OLD';\n", bad = "throw new Error('broken-partial-install');\n";
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'update-recovery-')), profileDir = join(home, 'profile');
  const installedRoot = join(profileDir, 'node_modules','dsh-mobile-remote');
  mkdirSync(join(installedRoot,'lib'), { recursive: true });
  writeFileSync(join(installedRoot,'package.json'), JSON.stringify({ name: 'dsh-mobile-remote',version:'3.2.0' }));
  writeFileSync(join(installedRoot,'lib','index.js'), old);
  writeFileSync(join(profileDir,'package.json'), JSON.stringify({ dependencies:{'dsh-mobile-remote':'file:/changing-source'}, custom:'unchanged' }));
  writeFileSync(join(profileDir,'pnpm-lock.yaml'),'original-lock\n');
  const digest = pluginContentDigest(installedRoot), bytes = Buffer.from('verified-fixture-tgz');
  const options = { home,profileDir,installedRoot,pluginRoot:installedRoot,restartForm:'web-foreground',
    plugin:{version:'3.2.0',file:'p.tgz',url:'https://release.test/p.tgz',sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length},
    fetchImpl:async()=>new Response(bytes),
    runTar:async(_,dest)=>{ mkdirSync(join(dest,'package','lib'),{recursive:true}); writeFileSync(join(dest,'package','package.json'),JSON.stringify({ name:'dsh-mobile-remote',version:'3.2.0' })); writeFileSync(join(dest,'package','lib','index.js'),"export const content='NEW';\n"); return {ok:true}; },
    freezeImpl:()=>({ok:true,entry:'/fixture'}),spawnArmedImpl:()=>({ok:true,mode:'fixture'}),awaitReadyImpl:async()=>({ok:true,ready:{pid:process.pid}}),
  };
  return { ...options,digest,options };
}

test('C5: partial failure and timeout keep recovery lease; real old bytes are restored from frozen snapshot', async () => {
  for (const error of ['partial-install-failed','timeout-after-1s']) {
    const f = fixture();
    const failed = await runSelfUpdate({ ...f.options, runInstall:async()=>{writeFileSync(join(f.installedRoot,'lib','index.js'),bad); return {ok:false,error};} });
    assert.equal(failed.transaction.phase,'rolling-back'); assert.equal(readLock(updateLockPath(f.home)).opId,failed.transaction.opId);
    assert.equal(readFileSync(join(f.installedRoot,'lib','index.js'),'utf8'),bad);
    let restarts=0;
    const finished = await superviseUpdate({ stateFile:join(f.home,'.dsh','mobile-remote','transactions',`${failed.transaction.id}.json`),
      restart:()=>{restarts++; return {ok:true};},
      runInstall:async(profile)=>{const doc=JSON.parse(readFileSync(join(profile,'package.json'),'utf8')); const source=doc.dependencies['dsh-mobile-remote'].slice(5); rmSync(f.installedRoot,{recursive:true,force:true}); cpSync(source,f.installedRoot,{recursive:true,dereference:true}); return {ok:true};},
      waitForHost:async()=>({ok:pluginContentDigest(f.installedRoot)===f.digest,matched:'content'}),
    });
    assert.equal(finished.phase,'rolled-back',JSON.stringify(finished.result));
    assert.equal(readFileSync(join(f.installedRoot,'lib','index.js'),'utf8'),old);
    assert.equal(restarts,1,'failed installation must restore BEFORE its only restart');
    assert.equal(readLock(updateLockPath(f.home)),null); assert.equal(finished.targetContentSha256,failed.transaction.targetContentSha256);
    assert.equal(JSON.parse(readFileSync(join(f.profileDir,'package.json'),'utf8')).custom,'unchanged');
  }
});

test('C5: failed restore is reported as FAILED, never as rollback success', async()=>{
  const f=fixture();
  const failed=await runSelfUpdate({...f.options,runInstall:async()=>{writeFileSync(join(f.installedRoot,'lib','index.js'),bad);return {ok:false,error:'partial'};}});
  let restarted=false;
  const result=await superviseUpdate({stateFile:join(f.home,'.dsh','mobile-remote','transactions',`${failed.transaction.id}.json`),
    restore:async()=>({ok:false,error:'restored-snapshot-invalid: broken'}),
    waitForHost:async()=>({ok:false,error:'no-host'}),
    restart:()=>{restarted=true;return {ok:true};}});
  assert.equal(result.phase,'failed'); assert.equal(result.result.reason,'rollback-restore-failed');
  assert.equal(restarted,false,'恢复失败不得再重启');
});

test('C4: nonempty half/corrupt snapshots must reject BEFORE profile switch',async()=>{
  for(const marker of [null,'{broken','{"at":"legacy-only"}']) {
    const f=fixture(),snap=snapshotDir(snapshotRoot(f.home),f.digest);
    mkdirSync(snap,{recursive:true});writeFileSync(join(snap,'partial'),'incomplete');if(marker)writeFileSync(join(snap,'.complete'),marker);
    let installs=0;const r=await runSelfUpdate({...f.options,runInstall:async()=>{installs++;return {ok:true};}});
    assert.equal(r.ok,false);assert.equal(r.error,'snapshot-incomplete-or-corrupt');assert.equal(installs,0);
    assert.equal(JSON.parse(readFileSync(join(f.profileDir,'package.json'),'utf8')).dependencies['dsh-mobile-remote'],'file:/changing-source');
    assert.equal(existsSync(join(snap,'partial')),true,'never delete an existing rollback directory to hide corruption');
  }
});
