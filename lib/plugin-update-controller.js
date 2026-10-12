// Admission owns the durable transaction and its lease; the worker consumes exactly the accepted release.
import { homedir } from 'node:os';
import { acquireLock, newOperationId, readTransaction, releaseLock, serverOperationPath, finishOwnedTerminal,
  transactionFile, updateLockPath, validOperationId, writeOwnedTransaction, convergeStaleTransaction } from './plugin-update-transaction.js';
import { checkForUpdate, runSelfUpdate, isTerminalPhase, resolveManifestSource, UPDATE_SOURCE_KIND } from './plugin-self-update.js';

/// 客户端可达视图：只改写属于**本机回环主机源**的 artifact 路由，外部发布源保持原样（F1）。
export function clientReleaseView(release, { clientOrigin = '', basePath = '/m', loopback = false } = {}) {
  if (!release || !clientOrigin || !loopback) return release;
  const mount = basePath === '/' || basePath === '' ? '/m' : String(basePath).replace(/\/$/, '');
  return {
    ...release,
    manifestUrl: `${clientOrigin}${mount}/api/update/manifest`,
    app: release.app ? { ...release.app, url: `${clientOrigin}${mount}/api/update/apk` } : release.app,
    plugin: { ...release.plugin, url: `${clientOrigin}${mount}/api/update/plugin` },
  };
}
export function publicTransaction(tx, view = {}) {
  if (!tx) return null;
  const { opId, phase, targetVersion, targetContentSha256, rolledBack, attempts, result, startedAt, release } = tx;
  return { opId, phase, targetVersion, targetContentSha256, rolledBack: !!rolledBack, attempts: attempts ?? 0, result: result ?? null, startedAt,
    release: release ? clientReleaseView(release, view) : null };
}
export function createPluginUpdateController(options) {
  const { home = homedir(), configValue, profileDir, capabilities, localVersion, localContentSha256,
    status, log = () => {}, fetchImpl = fetch, auth = {}, basePath = '/m', workerOptions = {},
    schedule = fn => setImmediate(fn), runSelfUpdate: runner = runSelfUpdate, persist = writeOwnedTransaction } = options;
  const currentFile = transactionFile(home), lockPath = updateLockPath(home);
  const checking = () => checkForUpdate({ configValue, localVersion: typeof localVersion === 'function' ? localVersion() : localVersion, localContentSha256,
    capabilities: capabilities(), fetchImpl, auth });
  /// 手机视图：**只用于 HTTP 出口**，绝不写回内部事务（F1）。
  /// 内部 worker 必须继续用回环 locator 读受保护产物；手机看到的是自己可达的路由。
  const clientView = clientOrigin => ({
    clientOrigin, basePath, loopback: resolveManifestSource(configValue).loopback === true,
  });
  async function submit(body = {}, { clientOrigin = '' } = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
      ('opId' in body && !validOperationId(body.opId))) return { status: 400, body: { error: 'invalid-operation-id' } };
    const source = resolveManifestSource(configValue);
    if (source.kind === UPDATE_SOURCE_KIND.OFF) return { status: 503, body: { error: 'update-source-off' } };
    if (source.kind === UPDATE_SOURCE_KIND.INVALID) return { status: 400, body: { error: 'update-source-invalid' } };
    if (!profileDir) return { status: 409, body: { error: 'profile-not-found' } };
    if (!capabilities().canSelfUpdate) return { status: 409, body: { error: 'restart-unsupported' } };
    const view = clientView(clientOrigin);
    const old = readTransaction(currentFile);
    if (old && body.opId === old.opId) return { status: 200, body: { ok: true, action: 'accepted', opId: old.opId,
      transaction: publicTransaction(old, view), check: { ...status, release: clientReleaseView(status.release, view) } } };
    if (old && !isTerminalPhase(old.phase)) {
      const convergence = convergeStaleTransaction({ stateFile: currentFile, lockPath });
      if (!['converged','terminal'].includes(convergence.action)) return { status: 409, body: {
        error: convergence.action === 'recovery-required' ? 'recovery-required' : 'update-busy', transaction: publicTransaction(old, view) } };
    }
    const checked = await checking(); Object.assign(status, checked);
    // **内部 release 原样保留**（持久化与 worker 都用它）；只有响应体走手机视图。
    if (checked.state !== 'update-available') {
      return { status: 200, body: { ok: true, action: 'none', check: { ...checked, release: clientReleaseView(checked.release, view) } } };
    }
    const opId = body.opId ?? newOperationId();
    const lock = acquireLock(lockPath, { opId, stateFile: currentFile });
    if (!lock.ok) return { status: 409, body: { error: lock.error, transaction: publicTransaction(readTransaction(currentFile)) } };
    const lease = lock.lease, stateFile = serverOperationPath(home, lease.generation);
    let tx;
    try {
      tx = persist(stateFile, { ...workerOptions, opId, phase: 'staging', startedAt: new Date().toISOString(),
        profileDir, release: checked.release, manifestUrl: checked.release.manifestUrl,
        targetVersion: checked.release.plugin.version, targetContentSha256: checked.release.plugin.contentSha256,
        currentFile, lockPath, lease, attempts: 0 }, { lockPath, lease, currentFile });
    } catch(e) {
      releaseLock(lockPath, lease, { stateFile: currentFile });
      log(`update admission persistence failed: ${e.message}`);
      return { status: 500, body: { error: 'update-state-write-failed' } };
    }
    // Only this lease schedules this worker. Same request retries return the saved operation above.
    schedule(async () => {
      try {
        const run = await runner({ ...workerOptions, home, profileDir, fetchImpl, auth, opId,
          release: tx.release, plugin: tx.release.plugin, manifestUrl: tx.manifestUrl,
          stateFile, currentFile, lockPath, lease, initialTransaction: tx, log });
        if (run.ok) Object.assign(status, { state: 'restarting', reason: 'update-staged', opId });
        else Object.assign(status, { state: run.transaction?.phase === 'rolling-back' ? 'rolling-back' : 'update-failed', reason: run.error, opId });
      } catch(e) {
        // Never clear an install/recovery lease as a generic catch. The armed supervisor owns recovery.
        const latest = readTransaction(stateFile);
        if (latest && latest.lease?.generation === lease.generation && latest.phase === 'staging') {
          try { finishOwnedTerminal(stateFile, { phase: 'failed', result: { ok: false, reason: e.message }, expectedPhases: ['staging'] }, { lockPath, lease, currentFile }); }
          catch { /* lost lease: do not overwrite a newer operation */ }
        }
        Object.assign(status, { state: 'update-failed', reason: e.message, opId }); log(`update worker failed: ${e.message}`);
      }
    });
    return { status: 200, body: { ok: true, action: 'accepted', opId,
      transaction: publicTransaction(tx, view), check: { ...checked, release: clientReleaseView(checked.release, view) } } };
  }
  return { submit, check: checking };
}
