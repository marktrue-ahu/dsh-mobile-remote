import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireLock, releaseLock, restoreOwnedProfile, switchOwnedDependency, updateLockPath, transactionFile, serverOperationPath, writeOwnedTransaction, finishOwnedTerminal, readTransaction, readLock } from '../lib/plugin-update-transaction.js';
import { freezeSupervisor, supervisorRoot, waitForSupervisorReady } from '../lib/plugin-self-update.js';
import { superviseUpdate } from '../lib/update-supervisor.js';
const root=new URL('..',import.meta.url).pathname;

test('C3: real frozen supervisor ready is generation-bound; old supervisor cannot follow new operation',async()=>{
  const home=mkdtempSync(join(tmpdir(),'armed-supervisor-')),lockPath=updateLockPath(home), currentFile=transactionFile(home);
  const grant=acquireLock(lockPath,{opId:'armed-first'}), lease=grant.lease;
  const stateFile=serverOperationPath(home,lease.generation),readyFile=join(supervisorRoot(home,lease.generation),'ready.json');
  writeOwnedTransaction(stateFile,{opId:lease.opId,lease,phase:'staging',startedAt:new Date().toISOString(),hostPid:process.pid,lockPath,currentFile},{lockPath,lease,currentFile});
  const frozen=freezeSupervisor({home,id:lease.generation,pluginRoot:root});assert.equal(frozen.ok,true,frozen.error);
  const child=spawn(process.execPath,[frozen.entry,'--arm','--state',stateFile,'--ready',readyFile,'--op',lease.opId,'--generation',lease.generation,'--poll','5'],{stdio:['ignore','pipe','pipe']});
  let err='';child.stderr.on('data',d=>err+=d);child.stdout.resume();
  const done=once(child,'close');
  try {
    const ready=await waitForSupervisorReady({readyFile,opId:lease.opId,generation:lease.generation,timeoutMs:3000,pollMs:10});
    assert.equal(ready.ok,true,err);assert.equal(readLock(lockPath).supervisor.pid,child.pid);
    // 终态与释放是一次仲裁（生产同路径）：直接写 failed 会留下活锁，属测试夹具错误。
    finishOwnedTerminal(stateFile,{phase:'failed',result:{ok:false,reason:'fixture-no-destructive-changes'},expectedPhases:['staging']},{lockPath,lease,currentFile});
    const [status]=await done;assert.equal(status,0,err);
    const newer=acquireLock(lockPath,{opId:'armed-second',stateFile:currentFile});assert.equal(newer.ok,true,newer.error);
    writeOwnedTransaction(currentFile,{opId:'armed-second',phase:'restart-pending'},{lockPath,lease:newer.lease});
    let restarted=0;
    const old=await superviseUpdate({stateFile:currentFile,opId:lease.opId,generation:lease.generation,restart:()=>{restarted++;return {ok:true};}});
    assert.equal(old.error,'operation-mismatch');assert.equal(restarted,0);assert.equal(readLock(lockPath).opId,'armed-second');
    releaseLock(lockPath,newer.lease);
  } finally { if(child.exitCode===null){child.kill('SIGTERM');await done;} }
});

test('C2: engine filesystem IDs never accept the client request ID',()=>{
  const home=mkdtempSync(join(tmpdir(),'safe-fs-id-'));const sentinel=join(home,'profiles','web','keep');mkdirSync(join(home,'profiles','web'),{recursive:true});writeFileSync(sentinel,'unchanged');
  for(const input of ['../../profiles/web','/tmp/external','', 'request-safe-but-not-server-UUID']) assert.throws(()=>supervisorRoot(home,input),/invalid-filesystem-id/);
  assert.equal(readFileSync(sentinel,'utf8'),'unchanged');
});

test('C3-A: superseded supervisor cannot restore profile or state over a newer operation', async () => {
  const home=mkdtempSync(join(tmpdir(),'fence-restore-')),lockPath=updateLockPath(home),currentFile=transactionFile(home);
  const profile=join(home,'profile');mkdirSync(profile,{recursive:true});
  writeFileSync(join(profile,'package.json'),JSON.stringify({dependencies:{'dsh-mobile-remote':'file:/new-B'},marker:'B'}));
  const first=acquireLock(lockPath,{opId:'op-A',stateFile:currentFile,pid:2147483646});
  const stateA=serverOperationPath(home,first.lease.generation);
  writeOwnedTransaction(stateA,{opId:'op-A',lease:first.lease,phase:'staging',lockPath,currentFile},{lockPath,lease:first.lease,currentFile});
  // A 的代被 B 取代（A 死亡后 B 接管）
  const second=acquireLock(lockPath,{opId:'op-B',stateFile:currentFile});
  assert.equal(second.ok,true,second.error);
  // 旧代恢复/改依赖/发布终态：全部必须被拒，且不得改动 B 的 profile。
  const staleRestore=restoreOwnedProfile({profileDir:profile,snapshotDir:join(home,'snap'),snapshot:{packageJson:JSON.stringify({dependencies:{'dsh-mobile-remote':'file:/old-A'}})},lockPath,lease:first.lease});
  assert.equal(staleRestore.ok,false); assert.equal(staleRestore.error,'lease-lost');
  assert.equal(switchOwnedDependency({profileDir:profile,nextSpecifier:'file:/old-A',lockPath,lease:first.lease}).ok,false);
  assert.throws(()=>finishOwnedTerminal(stateA,{phase:'failed',result:{},expectedPhases:['staging']},{lockPath,lease:first.lease,currentFile}),/lease-lost/);
  assert.equal(JSON.parse(readFileSync(join(profile,'package.json'),'utf8')).marker,'B');
  assert.equal(readLock(lockPath).opId,'op-B');
  releaseLock(lockPath,second.lease,{stateFile:currentFile});
});

test('C3-B: unfinished recovery blocks new admission even after the lock was released', () => {
  const home=mkdtempSync(join(tmpdir(),'fence-recovery-')),lockPath=updateLockPath(home),currentFile=transactionFile(home);
  const grant=acquireLock(lockPath,{opId:'op-install',stateFile:currentFile,pid:2147483646});
  writeOwnedTransaction(currentFile,{opId:'op-install',lease:grant.lease,phase:'installing',startedAt:new Date().toISOString(),lockPath,currentFile},{lockPath,lease:grant.lease,currentFile});
  // 误释放（旧代码路径）也不得让新操作开始：恢复未完成 = fail-closed
  const released = releaseLock(lockPath,grant.lease,{stateFile:currentFile});
  assert.equal(released,false,'恢复未完成不得释放');
  const next=acquireLock(lockPath,{opId:'op-new',stateFile:currentFile});
  assert.equal(next.ok,false); assert.equal(next.error,'recovery-required');
  finishOwnedTerminal(currentFile,{phase:'failed',result:{ok:false,reason:'fixture-recovery-done'},expectedPhases:['installing']},{lockPath,lease:grant.lease,currentFile});
  const after=acquireLock(lockPath,{opId:'op-new',stateFile:currentFile});
  assert.equal(after.ok,true,after.error); releaseLock(lockPath,after.lease,{stateFile:currentFile});
});
