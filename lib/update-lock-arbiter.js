// Runs only under an OS flock on a persistent inode. No lock-directory unlink/rename races.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

function read(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }
function atomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(value) + '\n', { mode: 0o600 }); renameSync(tmp, file); }
  finally { if (existsSync(tmp)) rmSync(tmp); }
}
function identity(pid) {
  try { const text = readFileSync(`/proc/${pid}/stat`, 'utf8'); return { pid, start: text.slice(text.lastIndexOf(')') + 2).split(' ')[19] }; }
  catch { return { pid, start: null }; }
}
function alive(person) {
  if (!person?.pid || !Number.isInteger(person.pid)) return false;
  try { process.kill(person.pid, 0); } catch(e) { return e.code === 'EPERM'; }
  return !person.start || identity(person.pid).start === person.start;
}
function owns(holder, lease) { return !!lease?.generation && holder?.generation === lease.generation && holder.opId === lease.opId; }
function fence(holder, lease) { if (!owns(holder, lease)) throw new Error('lease-lost'); }
function terminal(phase) { return ['settled', 'rolled-back', 'failed'].includes(phase); }

function execute(input) {
  const { lockPath, operation, lease, stateFile } = input;
  const holderFile = join(lockPath, 'holder.json');
  let holder = read(holderFile);
  const available = !holder || ![holder.worker, holder.supervisor].some(alive);
  if (operation === 'acquire') {
    if (holder && owns(holder, lease)) return { ok: true, lease, holder, reentrant: true };
    // Missing publication is not evidence of owner death. Legacy half-locks require manual repair.
    if (existsSync(lockPath) && !existsSync(holderFile)) return { ok: false, error: 'lock-unpublished' };
    if (!available) return { ok: false, error: 'update-busy', holder };
    if (input.stateFile) {
      const tx = read(input.stateFile);
      // 安装/待生效/回滚未完成时，**任何**新操作都不得开始——即使锁已被误释放（holder 为空）。
      if (tx && ['installing','restart-pending','rolling-back'].includes(tx.phase) &&
          (!lease || tx.lease?.generation !== lease.generation)) {
        return { ok: false, error: 'recovery-required', holder, transaction: tx };
      }
    }
    holder = { opId: input.opId, generation: randomUUID(), worker: identity(input.pid), pid: input.pid, at: input.now };
    mkdirSync(lockPath, { recursive: true }); atomic(holderFile, holder);
    return { ok: true, holder, lease: { opId: holder.opId, generation: holder.generation } };
  }
  if (operation === 'release') {
    if (!owns(holder, lease)) return { ok: false, error: 'lease-lost' };
    const tx = input.stateFile ? read(input.stateFile) : null;
    if (tx && tx.lease?.generation === lease.generation && ['installing','restart-pending','rolling-back'].includes(tx.phase)) {
      return { ok: false, error: 'recovery-required' };
    }
    atomic(holderFile, null); return { ok: true };
  }
  if (operation === 'handover') {
    fence(holder, lease);
    holder = { ...holder, supervisor: identity(input.toPid), pid: input.toPid };
    atomic(holderFile, holder); return { ok: true, holder };
  }
  if (operation === 'assert') { fence(holder, lease); return { ok: true, holder }; }
  if (operation === 'state-write') {
    fence(holder, lease);
    if (input.tx.opId !== lease.opId) throw new Error('operation-mismatch');
    const old = read(stateFile);
    if (old?.lease && old.lease.generation !== lease.generation && !terminal(old.phase)) throw new Error('transaction-generation-mismatch');
    // 阶段 CAS：旧 worker 不能把"已被别人推进的阶段"改回去（如 failed → installing）。
    if (old && old.opId === input.tx.opId) {
      if (input.expectedPhases && !input.expectedPhases.includes(old.phase)) throw new Error('phase-cas-failed');
      if (terminal(old.phase) && !terminal(input.tx.phase)) throw new Error('terminal-regression');
    }
    const next = { ...input.tx, lease, id: lease.generation, updatedAt: new Date().toISOString() };
    atomic(stateFile, next);
    if (input.currentFile && input.currentFile !== stateFile) atomic(input.currentFile, next);
    return { ok: true, transaction: next };
  }
  if (operation === 'switch-profile') {
    fence(holder, lease);
    const file = join(input.profileDir, 'package.json'), doc = read(file);
    const previous = doc?.dependencies?.['dsh-mobile-remote'];
    if (typeof previous !== 'string') throw new Error('profile-dependency-missing');
    doc.dependencies['dsh-mobile-remote'] = input.specifier; atomic(file, doc);
    return { ok: true, previous, next: input.specifier };
  }
  if (operation === 'restore-profile') {
    fence(holder, lease);
    const file = join(input.profileDir, 'package.json');
    const doc = input.snapshot?.packageJson ? JSON.parse(input.snapshot.packageJson) : read(file);
    if (!doc?.dependencies) throw new Error('profile-dependencies-missing');
    doc.dependencies['dsh-mobile-remote'] = `file:${input.snapshotDir}`; atomic(file, doc);
    const lockfile = join(input.profileDir, 'pnpm-lock.yaml');
    if (typeof input.snapshot?.pnpmLock === 'string') writeFileSync(lockfile, input.snapshot.pnpmLock, { mode: 0o600 });
    else if (input.snapshot?.pnpmLock === null && existsSync(lockfile)) rmSync(lockfile);
    return { ok: true };
  }
  if (operation === 'publish-snapshot-link') {
    fence(holder, lease);
    const modules = join(input.profileDir, 'node_modules'); mkdirSync(modules, { recursive: true });
    // Never traverse an unexpected node_modules symlink into another profile.
    if (realpathSync(modules) !== join(realpathSync(input.profileDir), 'node_modules')) throw new Error('profile-modules-outside-root');
    const target = join(modules, 'dsh-mobile-remote');
    const staged = `${target}.restore-${randomUUID()}`, previous = `${target}.previous-${randomUUID()}`;
    symlinkSync(realpathSync(input.snapshotDir), staged, 'dir');
    let moved = false;
    try {
      try { renameSync(target, previous); moved = true; } catch(e) { if (e.code !== 'ENOENT') throw e; }
      renameSync(staged, target);
    } catch(e) { if (moved && !existsSync(target)) renameSync(previous, target); throw e; }
    finally { if (existsSync(staged)) rmSync(staged); }
    // Retain the quarantined old link/tree; never delete active hardlinked module files in place.
    return { ok: true, installedRoot: target };
  }
  if (operation === 'finish-terminal') {
    fence(holder, lease);
    const tx = read(stateFile);
    if (!tx || tx.opId !== lease.opId || tx.lease?.generation !== lease.generation) throw new Error('operation-mismatch');
    if (input.expectedPhases && !input.expectedPhases.includes(tx.phase)) throw new Error('phase-cas-failed');
    if (!terminal(input.phase)) throw new Error('not-a-terminal-phase');
    const next = { ...tx, phase: input.phase, result: input.result, lease, id: lease.generation, updatedAt: new Date().toISOString() };
    atomic(stateFile, next);
    if (input.currentFile && input.currentFile !== stateFile) atomic(input.currentFile, next);
    // 发布终态与释放锁是一次仲裁：中间不存在"已终态但锁仍被旧代持有/已被释放"的空窗。
    atomic(holderFile, null);
    return { ok: true, transaction: next };
  }
  if (operation === 'converge') {
    const tx = read(stateFile);
    if (!tx) return { ok: true, action: 'none', transaction: null };
    if (terminal(tx.phase)) return { ok: true, action: 'terminal', transaction: tx };
    if (input.expectedLease && !owns(holder, input.expectedLease)) return { ok: true, action: 'superseded', transaction: tx };
    if (holder && [holder.worker, holder.supervisor].some(alive)) return { ok: true, action: 'active', transaction: tx };
    if (existsSync(lockPath) && !existsSync(holderFile)) return { ok: true, action: 'recent', transaction: tx };
    // Never relabel a possibly damaged install as an ordinary terminal failure.
    if (['installing','restart-pending','rolling-back'].includes(tx.phase)) return { ok: true, action: 'recovery-required', transaction: tx };
    if (input.now - Date.parse(tx.startedAt) < input.staleMs) return { ok: true, action: 'recent', transaction: tx };
    if (tx.lease && holder && !owns(holder, tx.lease)) return { ok: true, action: 'superseded', transaction: tx };
    const next = { ...tx, phase: 'failed', result: { ok: false, reason: 'holder-gone' } };
    atomic(stateFile, next); if (holder) atomic(holderFile, null);
    return { ok: true, action: 'converged', transaction: next };
  }
  throw new Error('unknown-arbitration-operation');
}
try { console.log(JSON.stringify(execute(JSON.parse(readFileSync(0, 'utf8'))))); }
catch(e) { console.log(JSON.stringify({ ok: false, error: e.message })); }
