import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as tx from '../lib/plugin-update-transaction.js';
const moduleUrl = new URL('../lib/plugin-update-transaction.js', import.meta.url).href;
function fixture() { return mkdtempSync(join(tmpdir(), 'lock-fencing-')); }
async function child(code) {
  const p = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore','pipe','pipe'] });
  let out = '', err = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
  const [status] = await once(p, 'close'); assert.equal(status, 0, err); return JSON.parse(out);
}

test('C3: two real Node processes contend; only one live generation is granted', async () => {
  const home = fixture(), lock = tx.updateLockPath(home);
  const code = id => `import {acquireLock} from ${JSON.stringify(moduleUrl)};
    const r=acquireLock(${JSON.stringify(lock)},{opId:${JSON.stringify(id)}});
    console.log(JSON.stringify(r)); if(r.ok) await new Promise(r=>setTimeout(r,150));`;
  const results = await Promise.all([child(code('process-A')), child(code('process-B'))]);
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.ok(results.find(r => r.ok).lease.generation);
});

test('C3: an unpublished legacy lock is not stolen as a dead owner', () => {
  const lock = tx.updateLockPath(fixture()); mkdirSync(lock, { recursive: true });
  const result = tx.acquireLock(lock, { opId: 'new-worker' });
  assert.equal(result.ok, false); assert.equal(result.error, 'lock-unpublished');
});

test('C3: old release/handover/state/convergence cannot delete or overwrite a new generation', () => {
  const home = fixture(), lock = tx.updateLockPath(home), stateFile = tx.transactionFile(home);
  const first = tx.acquireLock(lock, { opId: 'first', pid: 2147483646 }); assert.equal(first.ok, true);
  const second = tx.acquireLock(lock, { opId: 'second' }); assert.equal(second.ok, true);
  tx.writeOwnedTransaction(stateFile, { opId: 'second', phase: 'staging' }, { lockPath: lock, lease: second.lease });
  assert.equal(tx.releaseLock(lock, first.lease), false);
  assert.equal(tx.handOverLock(lock, { lease: first.lease, toPid: process.pid }), false);
  assert.throws(() => tx.writeOwnedTransaction(stateFile, { opId: 'first', phase: 'failed' }, { lockPath: lock, lease: first.lease }), /lease-lost/);
  tx.convergeStaleTransaction({ stateFile, lockPath: lock, expectedLease: first.lease, staleMs: 0 });
  assert.equal(tx.readLock(lock).opId, 'second'); assert.equal(tx.readTransaction(stateFile).opId, 'second');
  assert.equal(tx.releaseLock(lock, second.lease), true);
});
