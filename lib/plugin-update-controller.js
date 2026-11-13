// Admission owns the durable transaction and its lease; the worker consumes exactly the accepted release.
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { acquireLock, newOperationId, readTransaction, releaseLock, serverOperationPath, finishOwnedTerminal,
  transactionFile, updateLockPath, validOperationId, writeOwnedTransaction, convergeStaleTransaction, workRoot } from './plugin-update-transaction.js';
import { checkForUpdate, prepareNpmArtifacts, runSelfUpdate, isTerminalPhase, resolvePluginUpdateSource, UPDATE_SOURCE_KIND } from './plugin-self-update.js';
import { createOperationLog } from './plugin-update-log.js';
import { createUpdateCheckService } from './plugin-update-check.js';

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
function safeUpdateReason(reason) {
  const value = typeof reason === 'string' ? reason : '';
  return /^[a-z0-9][a-z0-9._-]{0,96}$/i.test(value) ? value : 'update-failed';
}

export function publicTransaction(tx, view = {}) {
  if (!tx) return null;
  const { opId, phase, targetVersion, targetContentSha256, targetAppVersion, rolledBack, attempts, result, startedAt, release } = tx;
  const publicResult = result ? {
    ok: !!result.ok,
    ...(result.reason ? { reason: safeUpdateReason(result.reason) } : {}),
    ...(result.at ? { at: result.at } : {}),
    ...(result.matched ? { matched: result.matched } : {}),
  } : null;
  return { opId, phase, targetVersion, targetContentSha256, targetAppVersion: targetAppVersion ?? null,
    rolledBack: !!rolledBack, attempts: attempts ?? 0, result: publicResult, startedAt,
    release: release ? clientReleaseView(release, view) : null };
}
export function createPluginUpdateController(options) {
  const { home = homedir(), configValue, profileDir, packageName = '', npmPackageView, capabilities, localVersion, localContentSha256,
    status, log = () => {}, fetchImpl = fetch, auth = {}, basePath = '/m', workerOptions = {},
    checkTimeoutMs = 12_000, checkSuccessTtlMs = 5 * 60 * 1000, checkFailureTtlMs = 30 * 1000,
    asyncCheckTtlMs = 10 * 60 * 1000,
    schedule = fn => setImmediate(fn), runSelfUpdate: runner = runSelfUpdate, prepareNpmArtifacts: prepareRunner = prepareNpmArtifacts,
    runHostUpdate: hostRunner, persist = writeOwnedTransaction } = options;
  // 只有调用方显式提供宿主更新执行器时才启用该通道（旧宿主/测试不提供即自动关闭）。
  const runHostUpdate = typeof hostRunner === 'function' ? hostRunner : null;
  const currentFile = transactionFile(home), lockPath = updateLockPath(home);
  const preparedUpdates = new Map();
  const preparedTtlMs = 30 * 60 * 1000;
  const safePreparedWorkRoot = resolve(workRoot(home));
  const removePreparedWorkDir = workDir => {
    if (!workDir || !existsSync(safePreparedWorkRoot)) return false;
    try {
      const rootReal = realpathSync(safePreparedWorkRoot);
      const targetReal = realpathSync(workDir);
      const rel = relative(rootReal, targetReal);
      if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
      rmSync(targetReal, { recursive: true, force: true });
      return true;
    } catch { return false; }
  };
  const cleanupPreparedUpdates = () => {
    const now = Date.now();
    for (const [key, entry] of preparedUpdates) {
      if (entry.expiresAt <= now) {
        clearTimeout(entry.expireTimer);
        removePreparedWorkDir(entry.workDir);
        preparedUpdates.delete(key);
      }
    }
    try {
      if (!existsSync(safePreparedWorkRoot)) return;
      const rootReal = realpathSync(safePreparedWorkRoot);
      const active = new Set([...preparedUpdates.values()].map(entry => resolve(entry.workDir)));
      const activeTransaction = readTransaction(currentFile);
      const activePreparedDir = activeTransaction && !isTerminalPhase(activeTransaction.phase) && activeTransaction.preparedId
        ? `prepare-${activeTransaction.preparedId}` : "";
      for (const item of readdirSync(rootReal, { withFileTypes: true })) {
        if (!item.isDirectory() || !item.name.startsWith('prepare-') || item.name === activePreparedDir) continue;
        const target = join(rootReal, item.name);
        if (active.has(resolve(target))) continue;
        if (now - statSync(target).mtimeMs > preparedTtlMs) removePreparedWorkDir(target);
      }
    } catch { /* cleanup is best-effort; never disrupt update checks */ }
  };
  cleanupPreparedUpdates();
  const checking = () => checkForUpdate({ configValue, packageName, npmCwd: profileDir, npmPackageView,
    localVersion: typeof localVersion === 'function' ? localVersion() : localVersion, localContentSha256,
    capabilities: capabilities(), fetchImpl, auth });
  // issue #96：检查快照 + 有界异步任务（只读、内存、不持久化）。
  const checkService = createUpdateCheckService({
    checkFn: checking,
    cacheKey: () => `${configValue}|${typeof localVersion === 'function' ? localVersion() : localVersion}|${localContentSha256 ?? ''}`,
    checkTimeoutMs,
    successTtlMs: checkSuccessTtlMs,
    failureTtlMs: checkFailureTtlMs,
    taskTtlMs: asyncCheckTtlMs,
  });
  /// 手机视图：**只用于 HTTP 出口**，绝不写回内部事务（F1）。
  /// 内部 worker 必须继续用受信定位；当前 NPM 来源不会把 registry URL 投影给客户端。
  const clientView = clientOrigin => ({
    clientOrigin, basePath, loopback: resolvePluginUpdateSource(configValue).loopback === true,
  });
  async function prepare(body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || ('opId' in body && !validOperationId(body.opId))) {
      return { status: 400, body: { error: 'invalid-operation-id' } };
    }
    const source = resolvePluginUpdateSource(configValue);
    if (source.kind === UPDATE_SOURCE_KIND.OFF) return { status: 503, body: { error: 'update-source-off' } };
    if (source.kind === UPDATE_SOURCE_KIND.INVALID) return { status: 400, body: { error: 'update-source-invalid' } };
    if (!profileDir) return { status: 409, body: { error: 'profile-not-found' } };
    if (!capabilities().canSelfUpdate) return { status: 409, body: { error: 'restart-unsupported' } };
    const opId = body.opId ?? newOperationId();
    cleanupPreparedUpdates();
    const current = preparedUpdates.get(opId);
    if (current && current.expiresAt > Date.now()) return { status: 200, body: {
      ok: true, action: 'prepared', opId, prepareId: current.prepareId, candidate: current.candidate,
    } };
    const old = readTransaction(currentFile);
    if (old && !isTerminalPhase(old.phase)) return { status: 409, body: { error: 'update-busy', transaction: publicTransaction(old) } };
    const checked = await checkService.checkForSubmit(); Object.assign(status, checked);
    if (checked.state !== 'update-available') return { status: 200, body: { ok: true, action: 'none', check: checked } };
    const candidate = checked.candidate;
    if (!candidate?.carrier?.legacyMetadataMissing) {
      return { status: 200, body: { ok: true, action: 'confirmation-required', opId, candidate, check: checked } };
    }
    const prepareId = newOperationId();
    const workDir = join(safePreparedWorkRoot, `prepare-${prepareId}`);
    mkdirSync(workDir, { recursive: true, mode: 0o700 });
    let artifacts;
    try {
      artifacts = await prepareRunner({ npmCandidate: candidate, packageName, profileDir, workDir });
      if (!artifacts?.ok || !artifacts.carrierAppVersion || !artifacts.pluginContentSha256) {
        removePreparedWorkDir(workDir);
        return { status: 502, body: { error: 'candidate-preparation-failed', reason: artifacts?.error ?? 'npm-preparation-incomplete' } };
      }
    } catch {
      removePreparedWorkDir(workDir);
      return { status: 502, body: { error: 'candidate-preparation-failed', reason: 'npm-preparation-failed' } };
    }
    const preparedCandidate = {
      ...candidate,
      plugin: { ...candidate.plugin, contentSha256: artifacts.pluginContentSha256 },
      carrier: { ...candidate.carrier, appVersion: artifacts.carrierAppVersion,
        pluginContentSha256: artifacts.pluginContentSha256, legacyMetadataMissing: false },
    };
    const preparedCheck = {
      ...checked,
      candidate: preparedCandidate,
      remote: { ...checked.remote, contentSha256: artifacts.pluginContentSha256,
        appVersion: artifacts.carrierAppVersion, legacyCarrierMetadata: false },
    };
    const entry = { prepareId, opId, candidate: preparedCandidate, artifacts, workDir, expiresAt: Date.now() + preparedTtlMs };
    entry.expireTimer = setTimeout(() => {
      const current = preparedUpdates.get(opId);
      if (current?.prepareId === prepareId) {
        removePreparedWorkDir(current.workDir);
        preparedUpdates.delete(opId);
      }
    }, preparedTtlMs);
    entry.expireTimer.unref?.();
    preparedUpdates.set(opId, entry);
    Object.assign(status, preparedCheck);
    return { status: 200, body: { ok: true, action: 'prepared', opId, prepareId, candidate: preparedCandidate, check: preparedCheck } };
  }
  async function submit(body = {}, { clientOrigin = '' } = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
      ('opId' in body && !validOperationId(body.opId))) return { status: 400, body: { error: 'invalid-operation-id' } };
    if ('targetVersion' in body && typeof body.targetVersion !== 'string') return { status: 400, body: { error: 'invalid-target-version' } };
    const source = resolvePluginUpdateSource(configValue);
    if (source.kind === UPDATE_SOURCE_KIND.OFF) return { status: 503, body: { error: 'update-source-off' } };
    if (source.kind === UPDATE_SOURCE_KIND.INVALID) return { status: 400, body: { error: 'update-source-invalid' } };
    if (!profileDir) return { status: 409, body: { error: 'profile-not-found' } };
    // `canSelfUpdate` 现在由**通道**决定（宿主管理器或重启通道只要有一条可用即为真），
    // 两条都不通才拒绝；原因码保留 `restart-unsupported` 以免旧 App 判断失效。
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
    let checked = await checkService.checkForSubmit(); Object.assign(status, checked);
    // issue #96 review P2：检查本身不可用/超时时如实返回 503 check-unavailable，
    // 不得被 targetVersion 比对误判成 candidate-changed，也不无意义重查。
    if (checked.state === 'unavailable') {
      return { status: 503, body: {
        error: 'check-unavailable',
        reason: checked.reason ?? 'update-check-unavailable',
        check: checked,
      } };
    }
    // 只有成功检查且 targetVersion 与候选确实不同，才强制重查一次；仍不同才 409。
    if (typeof body.targetVersion === 'string') {
      const snapshotTarget = () => checked.release?.plugin ?? checked.candidate?.plugin;
      if (!snapshotTarget() || snapshotTarget()?.version !== body.targetVersion) {
        checked = await checkService.check({ force: true });
        Object.assign(status, checked);
        if (checked.state === 'unavailable') {
          return { status: 503, body: {
            error: 'check-unavailable',
            reason: checked.reason ?? 'update-check-unavailable',
            check: checked,
          } };
        }
        if (!snapshotTarget() || snapshotTarget()?.version !== body.targetVersion) {
          return { status: 409, body: { error: 'candidate-changed', check: checked } };
        }
      }
    }
    // **内部 release 原样保留**（持久化与 worker 都用它）；只有响应体走手机视图。
    if (checked.state !== 'update-available') {
      return { status: 200, body: { ok: true, action: 'none', check: { ...checked, release: clientReleaseView(checked.release, view) } } };
    }
    const opId = body.opId ?? newOperationId();
    // ── 通道分派：宿主原生管理器可用时走它（进程内更新，不重启） ──────────────
    // 这条路径与下面的「重启通道」互斥：同一时刻只有一个事务、同一把锁。
    if (typeof runHostUpdate === 'function' && capabilities().updateChannel === 'host-manager') {
      const hostTarget = checked.release?.plugin ?? checked.candidate?.plugin;
      if (!hostTarget?.version) return { status: 503, body: { error: 'update-candidate-incomplete' } };
      if (typeof body.targetVersion === 'string' && body.targetVersion !== hostTarget.version) {
        return { status: 409, body: { error: 'candidate-changed', check: checked } };
      }
      const lock = acquireLock(lockPath, { opId, stateFile: currentFile });
      if (!lock.ok) return { status: 409, body: { error: lock.error, transaction: publicTransaction(readTransaction(currentFile), view) } };
      const lease = lock.lease, stateFile = serverOperationPath(home, lease.generation);
      const operationLog = createOperationLog({ home, generation: lease.generation,
        redactPaths: [home, profileDir, workerOptions.pluginRoot, workerOptions.installedRoot] });
      operationLog.setStage('host-manager', 'Host plugin manager update accepted');
      let tx;
      try {
        tx = persist(stateFile, { ...workerOptions, opId, phase: 'staging', startedAt: new Date().toISOString(),
          profileDir, release: checked.release ?? null, hostManager: true,
          manifestUrl: checked.release?.manifestUrl ?? '',
          targetVersion: hostTarget.version, targetContentSha256: hostTarget.contentSha256 ?? '',
          targetAppVersion: checked.release?.app?.version ?? null,
          currentFile, lockPath, lease, attempts: 0 }, { lockPath, lease, currentFile });
      } catch {
        releaseLock(lockPath, lease, { stateFile: currentFile });
        operationLog.setStage('failed', 'Could not persist host manager admission state.');
        operationLog.flush();
        log('host manager update admission state write failed');
        return { status: 500, body: { error: 'update-state-write-failed' } };
      }
      schedule(async () => {
        try {
          const run = await runHostUpdate({ opId, targetVersion: hostTarget.version,
            installedVersion: typeof localVersion === 'function' ? localVersion() : localVersion,
            onStep: step => { operationLog.setStage(step); workerOptions.onStep?.(step); },
            log: message => { operationLog.appendStatus(message, 'worker'); } });
          if (run.ok) {
            operationLog.setStage('finished', 'Host plugin manager applied the update without a restart.');
            finishOwnedTerminal(stateFile, { phase: 'settled', result: { ok: true, matched: 'host-manager' } },
              { lockPath, lease, currentFile });
            Object.assign(status, { state: 'up-to-date', reason: 'host-manager-applied', opId });
            checkService.invalidate();
          } else {
            const reason = safeUpdateReason(run.reason);
            operationLog.setStage('failed', `Host plugin manager update failed: ${reason}`);
            // `restart-required` 表示包装好了但要重启才生效：这不回滚，如实报告。
            finishOwnedTerminal(stateFile, { phase: run.reason === 'host-manager-restart-required' ? 'settled' : 'failed',
              rolledBack: false, result: { ok: false, reason } }, { lockPath, lease, currentFile });
            Object.assign(status, { state: run.reason === 'host-manager-restart-required' ? 'restarting' : 'update-failed', reason, opId });
          }
          operationLog.flush();
        } catch (e) {
          const reason = safeUpdateReason(e?.message);
          try { finishOwnedTerminal(stateFile, { phase: 'failed', result: { ok: false, reason } }, { lockPath, lease, currentFile }); }
          catch { /* lost lease: never overwrite a newer operation */ }
          operationLog.setStage('failed', `Host manager worker failed: ${reason}`);
          operationLog.flush();
          Object.assign(status, { state: 'update-failed', reason, opId });
          log('host manager update worker failed');
        }
      });
      return { status: 200, body: { ok: true, action: 'accepted', opId, channel: 'host-manager',
        transaction: publicTransaction(tx, view), check: { ...checked, release: clientReleaseView(checked.release, view) } } };
    }
    let effectiveCheck = checked;
    let npmCandidate = checked.candidate ?? null;
    let preparedNpmArtifacts = null;
    if (npmCandidate?.carrier?.legacyMetadataMissing) {
      cleanupPreparedUpdates();
      const prepared = preparedUpdates.get(opId);
      if (!prepared || prepared.expiresAt <= Date.now() || prepared.prepareId !== body.prepareId) {
        return { status: 200, body: { ok: true, action: 'prepare-required', opId, check: checked } };
      }
      if (prepared.candidate.plugin.version !== npmCandidate.plugin.version
        || prepared.candidate.carrier.version !== npmCandidate.carrier.version
        || prepared.candidate.plugin.integrity !== npmCandidate.plugin.integrity
        || prepared.candidate.carrier.integrity !== npmCandidate.carrier.integrity) {
        return { status: 409, body: { error: 'prepared-candidate-stale', check: checked } };
      }
      npmCandidate = prepared.candidate;
      preparedNpmArtifacts = prepared.artifacts;
      effectiveCheck = { ...checked, candidate: npmCandidate,
        remote: { ...checked.remote, contentSha256: npmCandidate.plugin.contentSha256,
          appVersion: npmCandidate.carrier.appVersion, legacyCarrierMetadata: false } };
      Object.assign(status, effectiveCheck);
    } else if (body.prepareId) {
      return { status: 409, body: { error: 'prepare-not-required', check: checked } };
    }
    const targetPlugin = checked.release?.plugin ?? npmCandidate?.plugin;
    if (!targetPlugin?.version) return { status: 503, body: { error: 'update-candidate-incomplete' } };
    if (typeof body.targetVersion === 'string' && body.targetVersion !== targetPlugin.version) {
      return { status: 409, body: { error: 'candidate-changed', check: effectiveCheck } };
    }
    const lock = acquireLock(lockPath, { opId, stateFile: currentFile });
    if (!lock.ok) return { status: 409, body: { error: lock.error, transaction: publicTransaction(readTransaction(currentFile)) } };
    const lease = lock.lease, stateFile = serverOperationPath(home, lease.generation);
    const operationLog = createOperationLog({ home, generation: lease.generation,
      redactPaths: [home, profileDir, workerOptions.pluginRoot, workerOptions.installedRoot] });
    operationLog.setStage('staging', 'NPM plugin update accepted');
    let tx;
    try {
      tx = persist(stateFile, { ...workerOptions, opId, phase: 'staging', startedAt: new Date().toISOString(),
        profileDir, release: checked.release ?? null, npmCandidate,
        manifestUrl: checked.release?.manifestUrl ?? '',
        targetVersion: targetPlugin.version, targetContentSha256: targetPlugin.contentSha256 ?? '',
        targetAppVersion: npmCandidate?.carrier?.appVersion ?? checked.release?.app?.version ?? null,
        preparedId: body.prepareId ?? null,
        currentFile, lockPath, lease, attempts: 0 }, { lockPath, lease, currentFile });
    } catch(e) {
      releaseLock(lockPath, lease, { stateFile: currentFile });
      operationLog.setStage('failed', 'Could not persist update admission state.');
      operationLog.flush();
      log('plugin update admission state write failed');
      return { status: 500, body: { error: 'update-state-write-failed' } };
    }
    // Consume the in-memory preflight only after the durable transaction accepts the same opId.
    if (preparedNpmArtifacts) {
      clearTimeout(preparedUpdates.get(opId)?.expireTimer);
      preparedUpdates.delete(opId);
    }
    // Only this lease schedules this worker. Same request retries return the saved operation above.
    schedule(async () => {
      try {
        const run = await runner({ ...workerOptions, home, profileDir, fetchImpl, auth, opId,
          release: tx.release ?? null, npmCandidate: tx.npmCandidate ?? null, preparedNpmArtifacts,
          plugin: tx.release?.plugin ?? tx.npmCandidate?.plugin, manifestUrl: tx.manifestUrl,
          onStep: step => { operationLog.setStage(step); workerOptions.onStep?.(step); },
          onOutput: (stream, text) => operationLog.appendChunk(stream, text),
          stateFile, currentFile, lockPath, lease, initialTransaction: tx,
          log: message => { operationLog.appendStatus(message, 'worker'); log('plugin update progress recorded'); } });
        operationLog.flush();
        if (run.ok) {
          operationLog.setStage('restart', 'Plugin install finished; waiting for host restart and health confirmation.');
          Object.assign(status, { state: 'restarting', reason: 'update-staged', opId });
          checkService.invalidate();
        } else {
          const reason = safeUpdateReason(run.error);
          // 失败原因必须进日志：详情页要能直接看到，而不是只有一句“看安装输出”。
          operationLog.setStage('failed', `Plugin update failed: ${reason}`);
          Object.assign(status, { state: run.transaction?.phase === 'rolling-back' ? 'rolling-back' : 'update-failed', reason, opId });
        }
      } catch(e) {
        // Never clear an install/recovery lease as a generic catch. The armed supervisor owns recovery.
        const latest = readTransaction(stateFile);
        const reason = safeUpdateReason(e.message);
        if (latest && latest.lease?.generation === lease.generation && latest.phase === 'staging') {
          try { finishOwnedTerminal(stateFile, { phase: 'failed', result: { ok: false, reason }, expectedPhases: ['staging'] }, { lockPath, lease, currentFile }); }
          catch { /* lost lease: do not overwrite a newer operation */ }
        }
        operationLog.setStage('failed', `Update worker failed: ${reason}`);
        operationLog.flush();
        Object.assign(status, { state: 'update-failed', reason, opId }); log('plugin update worker failed');
      } finally {
        if (preparedNpmArtifacts?.workDir) removePreparedWorkDir(preparedNpmArtifacts.workDir);
      }
    });
    return { status: 200, body: { ok: true, action: 'accepted', opId,
      transaction: publicTransaction(tx, view), check: { ...effectiveCheck, release: clientReleaseView(effectiveCheck.release, view) } } };
  }
  return {
    submit,
    check: checking,
    prepare,
    checkSync: () => checkService.checkSync(),
    checkForSubmit: () => checkService.checkForSubmit(),
    startAsyncCheck: (options) => checkService.startAsync(options),
    getAsyncCheck: (checkId) => checkService.getAsync(checkId),
    invalidateCheck: () => checkService.invalidate(),
  };
}
