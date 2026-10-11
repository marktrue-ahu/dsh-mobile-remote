#!/usr/bin/env node
// 插件自更新的**外部监督器**（ADR 0019；评审 #32 note 1286 的 R1，二次复核的 F1/F2/F3/F4）。
//
// 为什么必须独立：回滚绝不能依赖新版插件能否加载。本脚本由**旧版插件**启动，
// 启动前先把自身代码**冻结**到不可变目录（pnpm 可能清理原模块目录），并在 systemd 托管时
// 用 transient unit **逃逸出宿主 cgroup**（否则停宿主时监督器会被一起杀掉）。
//
// 工作方式：
//   1. `--arm`：写就绪回执 → 接管事务锁 → 等事务进入 `restart-pending`（或终态/超时）；
//   2. 进入后**先安排第一次重启**（旧宿主不会自己加载新代码），再等新实例健康；
//   3. 健康判据是**正在运行的内容标识**（`plugin.contentSha256`），不是磁盘字节；
//   4. 不健康 → 用**快照**恢复旧依赖并重装 → 再重启 → 确认旧内容回来；
//   5. 全程只在终态释放锁，并把结果原子落盘供手机查询。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
	TRANSACTION_PHASE,
	acquireLock,
	assertUpdateLease,
	restoreOwnedProfile,
	publishOwnedSnapshotLink,
	finishOwnedTerminal,
	claimOwnedRecovery,
	defaultIsPidAlive,
	writeOwnedTransaction,
	switchOwnedDependency,
	handOverLock,
	readTransaction,
	releaseLock,
	snapshotReady,
	updateLockPath,
	writeTransaction,
} from "./plugin-update-transaction.js";
import { pluginContentDigest } from "./plugin-content-digest.js";
import { verifyFrozenPackage } from "./runtime-dependency-snapshot.js";
import { restartPlan } from "./plugin-self-update.js";

/** 等待宿主的默认超时：足够冷启动（含语料预热），又不至于让用户无限等。 */
export const DEFAULT_WAIT_TIMEOUT_MS = 180_000;
export const DEFAULT_POLL_MS = 2_000;
/** 等事务进入 restart-pending 的上限（下载 + 安装可能很慢）。 */
export const DEFAULT_ARM_TIMEOUT_MS = 15 * 60 * 1000;

/** 解析命令行参数。 */
export function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const key = argv[i];
		if (!key.startsWith("--")) continue;
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) out[key.slice(2)] = "true";
		else {
			out[key.slice(2)] = next;
			i++;
		}
	}
	return out;
}

/** 轮询本机宿主，直到它报告出**期望的内容标识**（或期望版本）。 */
export async function waitForHost({
	port,
	basePath = "/m",
	token = "",
	expectContentSha256 = "",
	expectVersion = "",
	timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
	pollMs = DEFAULT_POLL_MS,
	fetchImpl = fetch,
	now = () => Date.now(),
	sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
	const deadline = now() + timeoutMs;
	const url = `http://127.0.0.1:${port}${basePath}/api/bootstrap`;
	let lastError = "no-response";
	while (now() < deadline) {
		try {
			const res = await fetchImpl(url, {
				headers: token ? { "x-mobile-token": token } : {},
				signal: AbortSignal.timeout(Math.max(1000, pollMs)),
			});
			if (res?.ok) {
				const body = await res.json();
				const plugin = body?.plugin ?? {};
				const contentOk = expectContentSha256 !== "" && plugin.contentSha256 === expectContentSha256;
				const versionOk = expectContentSha256 === "" && expectVersion !== "" && plugin.version === expectVersion;
				const anyOk = expectContentSha256 === "" && expectVersion === "" && Boolean(body?.ok);
				if (contentOk || versionOk || anyOk) {
					return { ok: true, plugin, matched: contentOk ? "content" : versionOk ? "version" : "any" };
				}
				lastError = `content-mismatch:${plugin.contentSha256 ?? "none"}`;
			} else {
				lastError = `http-${res?.status ?? "?"}`;
			}
		} catch (e) {
			lastError = String(e?.message ?? e);
		}
		await sleep(pollMs);
	}
	return { ok: false, error: `host-wait-timeout: ${lastError}` };
}

/** 找出**当前**占用该端口的进程（F3：回滚不能杀更新前的旧 PID）。 */
export function findPortOwnerPid(port, { run = spawnSync } = {}) {
	if (!Number.isFinite(port) || port <= 0) return null;
	try {
		const ss = run("ss", ["-ltnpH", `sport = :${port}`], { encoding: "utf8" });
		const m = /pid=(\d+)/.exec(ss?.stdout ?? "");
		if (m) return Number(m[1]);
	} catch {
		// 继续尝试 lsof
	}
	try {
		const lsof = run("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
		const first = (lsof?.stdout ?? "").trim().split("\n")[0];
		if (/^\d+$/.test(first)) return Number(first);
	} catch {
		// 没有可用工具
	}
	return null;
}

/** 生成"杀掉当前端口占用者"的 shell 片段（找不到就退回给定 pid）。 */
export function portKillSnippet(port, fallbackPid = null) {
	const lines = [
		`P=$(ss -ltnpH "sport = :${port}" 2>/dev/null | grep -oP 'pid=\\K[0-9]+' | head -1)`,
		`[ -z "$P" ] && P=$(lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null | head -1)`,
	];
	if (fallbackPid) lines.push(`[ -z "$P" ] && P=${fallbackPid}`);
	lines.push('[ -n "$P" ] && kill -TERM "$P" 2>/dev/null');
	return lines.join("; ");
}

/**
 * 默认重启器：**按当前实例**（端口占用者）终止，而不是事务里记的旧 PID；
 * 前台形态自行重新拉起。**返回结果不再被忽略**（F3）。
 */
export function defaultRestart({ restartForm, port, pid = null, profile = "web", dshCommand = "dsh", log = () => {} }) {
	const plan = restartPlan({ form: restartForm, pid: null, profile, dshCommand });
	if (plan.mode === "unsupported") return { ok: false, error: "restart-unsupported" };
	const kill = portKillSnippet(port, pid);
	const script = plan.mode === "respawn"
		? `sleep 1; ${kill}; sleep 2; nohup ${dshCommand} web --profile ${profile} >/dev/null 2>&1 &`
		: `sleep 1; ${kill}`;
	const r = spawnSync("bash", ["-lc", script], { encoding: "utf8" });
	if (r.error) return { ok: false, error: r.error.message };
	if (r.status !== 0) return { ok: false, error: `restart-script-exit-${r.status}: ${(r.stderr || "").trim()}` };
	log(`supervisor: 已安排重启（${plan.mode}，目标=当前端口占用者）`);
	return { ok: true, script };
}

/**
 * 默认恢复器（F4）：把依赖指回**快照**（而不是可能已变的原 clone/tag/source），
 * 再重装；并检查安装结果。
 */
export async function defaultRestore({ profileDir, snapshotDir: snapDir, expectedContentSha256, profileSnapshot, lockPath, lease }) {
  if (!snapDir || !snapshotReady(snapDir) || (expectedContentSha256 && pluginContentDigest(snapDir) !== expectedContentSha256)) {
    return { ok: false, error: "snapshot-unavailable" };
  }
  try {
    assertUpdateLease(lockPath, lease);
    // 一次受代际保护的仲裁里恢复 profile/lockfile（A 阻塞：不再有 assert→write 空窗）。
    const restored = restoreOwnedProfile({ profileDir, snapshotDir: snapDir, snapshot: profileSnapshot, lockPath, lease });
    if (!restored.ok) return { ok: false, error: restored.error };
    // 直接把**已验证自包含**的快照发布为安装目录：旧字节精确、离线可加载，
    // 不依赖 pnpm 把依赖内联进插件目录（真实 pnpm 会放到 sibling，containment 判据必错）。
    const published = publishOwnedSnapshotLink({ profileDir, snapshotDir: snapDir, lockPath, lease });
    if (!published.ok) return { ok: false, error: published.error };
    assertUpdateLease(lockPath, lease);
    const actualRoot = join(profileDir, "node_modules", "dsh-mobile-remote");
    if (pluginContentDigest(actualRoot) !== expectedContentSha256) return { ok: false, error: "restored-content-mismatch" };
    const verified = verifyFrozenPackage(actualRoot);
    if (!verified.ok) return { ok: false, error: `restored-snapshot-invalid: ${verified.error}` };
    return { ok: true, restoredTo: snapDir, digest: verified.digest };
  } catch(e) { return { ok: false, error: e.message }; }
}

/** 默认安装器（监督器是独立进程，阻塞没关系）。 */
export function defaultRunInstall(profileDir) {
	const r = spawnSync("pnpm", ["install"], { cwd: profileDir, encoding: "utf8" });
	if (r.error) return { ok: false, error: r.error.message };
	if (r.status !== 0) return { ok: false, error: (r.stderr || `exit ${r.status}`).trim() };
	return { ok: true };
}

/**
 * 推进一次已进入 `restart-pending` 的事务。
 * **顺序**：先安排第一次重启（F1），再等新实例健康；不健康才走回滚。
 */
export async function runTransaction({ stateFile, tx, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS, maxRollbacks = 1, waitForHost: waitImpl = waitForHost,
  restore = defaultRestore, restart = defaultRestart, runInstall = defaultRunInstall, log = () => {}, now = () => Date.now() } = {}) {
  const lockPath = tx.lockPath || join(dirname(stateFile), "plugin-update.lock.d");
  const lease = tx.lease;
  const phaseAt = () => tx.phase;
  const save = (patch, expectedPhases) => { tx = writeOwnedTransaction(stateFile, { ...tx, ...patch }, { lockPath, lease, currentFile: tx.currentFile, expectedPhases }); return tx; };
  // 终态与释放合一：不存在"已终态但锁还在/已被释放"的空窗（C3）。
  const finish = (phase, result, expectedPhases) => finishOwnedTerminal(stateFile, { phase, result, expectedPhases }, { lockPath, lease, currentFile: tx.currentFile });
  try {
    assertUpdateLease(lockPath, lease);
    let failure = tx.recoveryCause || tx.result?.reason;
    // 已经处于 rolling-back（安装失败/恢复重试）：**直接续做恢复**，不重复"先重启再等待"。
    if (tx.phase !== TRANSACTION_PHASE.ROLLING_BACK) {
      const entryPhase = phaseAt();
      const result = await restart({ ...tx, pid: tx.hostPid, log });
      assertUpdateLease(lockPath, lease);
      if (!result?.ok) failure = `restart-failed: ${result?.error ?? "unknown"}`;
      else {
        const healthy = await waitImpl({ ...tx, expectContentSha256: tx.targetContentSha256,
          expectVersion: tx.targetVersion, timeoutMs, pollMs });
        assertUpdateLease(lockPath, lease);
        if (healthy.ok) return finish(TRANSACTION_PHASE.SETTLED, { ok: true, matched: healthy.matched, at: new Date(now()).toISOString() }, [entryPhase]);
        failure = healthy.error;
      }
      if (!tx.previousSnapshotDir) return finish(TRANSACTION_PHASE.FAILED, { ok: false, reason: "rollback-target-missing", error: failure }, [entryPhase]);
      if ((tx.attempts ?? 0) >= maxRollbacks) return finish(TRANSACTION_PHASE.FAILED, { ok: false, reason: "rollback-exhausted", error: failure }, [entryPhase]);
      // 正常失败与"续做恢复"共用同一入口；CAS 用**进入时的真实阶段**，不再硬编码。
      save({ phase: TRANSACTION_PHASE.ROLLING_BACK, attempts: (tx.attempts ?? 0) + 1, rolledBack: true,
        result: { ok: false, reason: "rolling-back", error: failure } }, [entryPhase]);
    }
    assertUpdateLease(lockPath, lease);
    if (!tx.previousSnapshotDir) return finish(TRANSACTION_PHASE.FAILED, { ok: false, reason: "rollback-target-missing", error: failure }, ["rolling-back"]);
    if ((tx.attempts ?? 0) > maxRollbacks) return finish(TRANSACTION_PHASE.FAILED, { ok: false, reason: "rollback-exhausted", error: failure }, ["rolling-back"]);
    // 同代唯一 claim：两个监督器同时重试时，只有一方真的执行恢复与重启。
    const owner = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    const claimed = claimOwnedRecovery(stateFile, { owner }, { lockPath, lease, currentFile: tx.currentFile });
    if (!claimed.ok) return { ok: false, error: claimed.error, transaction: claimed.transaction };
    tx = claimed.transaction;
    const restored = await restore({ profileDir: tx.profileDir, snapshotDir: tx.previousSnapshotDir,
      expectedContentSha256: tx.previousContentSha256, profileSnapshot: tx.profileSnapshot, lockPath, lease, runInstall });
    assertUpdateLease(lockPath, lease);
    if (!restored?.ok) return finish(TRANSACTION_PHASE.FAILED, { ok: false, reason: "rollback-restore-failed", error: restored?.error }, ["rolling-back"]);
    const result = await restart({ ...tx, pid: null, log });
    assertUpdateLease(lockPath, lease);
    if (!result?.ok) return finish(TRANSACTION_PHASE.FAILED, { ok: false, reason: "rollback-restart-failed", error: result?.error }, ["rolling-back"]);
    const back = await waitImpl({ ...tx, expectContentSha256: tx.previousContentSha256,
      expectVersion: "", timeoutMs, pollMs });
    assertUpdateLease(lockPath, lease);
    return finish(back.ok ? TRANSACTION_PHASE.ROLLED_BACK : TRANSACTION_PHASE.FAILED,
      { ok: false, reason: back.ok ? "rolled-back" : "rollback-unconfirmed", error: back.ok ? failure : back.error }, ["rolling-back"]);
  } catch(e) {
    if (e.message === "lease-lost") return { ok: false, error: "lease-lost" };
    try { return finish(TRANSACTION_PHASE.FAILED, { ok: false, reason: "supervisor-error", error: e.message }, [tx.phase]); }
    catch { return { ok: false, error: e.message }; }
  }
}

export async function superviseUpdate(options = {}) {
  const tx = readTransaction(options.stateFile);
  if (!tx) return { ok: false, error: "no-transaction" };
  if (options.opId && (options.opId !== tx.opId || options.generation !== tx.lease?.generation)) return { ok: false, error: "operation-mismatch" };
  if (!["restart-pending", "rolling-back"].includes(tx.phase)) return { ok: false, error: `not-restart-pending:${tx.phase}` };
  return runTransaction({ ...options, tx });
}

export async function superviseArmed({ stateFile, readyFile, opId, generation,
  armTimeoutMs = DEFAULT_ARM_TIMEOUT_MS, pollMs = DEFAULT_POLL_MS,
  log = () => {}, sleep = ms => new Promise(r => setTimeout(r, ms)), now = () => Date.now(), ...rest } = {}) {
  const tx0 = readTransaction(stateFile);
  if (!tx0 || tx0.opId !== opId || tx0.lease?.generation !== generation) return { ok: false, error: "operation-mismatch" };
  const lockPath = tx0.lockPath, lease = tx0.lease;
  if (!handOverLock(lockPath, { lease, toPid: process.pid })) return { ok: false, error: "lease-lost" };
  let cgroup = "";
  try { cgroup = readFileSync("/proc/self/cgroup", "utf8").trim(); } catch { /* portable ready receipt */ }
  mkdirSync(dirname(readyFile), { recursive: true });
  writeFileSync(readyFile, JSON.stringify({ pid: process.pid, opId, generation, cgroup, at: new Date(now()).toISOString() }), { mode: 0o600 });
  const deadline = now() + armTimeoutMs;
  while (now() < deadline) {
    const tx = readTransaction(stateFile);
    if (!tx || tx.opId !== opId || tx.lease?.generation !== generation) return { ok: false, error: "operation-mismatch" };
    try { assertUpdateLease(lockPath, lease); } catch { return { ok: false, error: "lease-lost" }; }
    if (["restart-pending","rolling-back"].includes(tx.phase)) return runTransaction({ stateFile, tx, log, ...rest });
    if (["settled","rolled-back","failed"].includes(tx.phase)) return tx;
    if (!defaultIsPidAlive(tx.hostPid) && tx.phase === "installing") {
      const recovering = writeOwnedTransaction(stateFile, { ...tx, phase: "rolling-back", recoveryCause: "install-worker-gone", rolledBack: true }, { lockPath, lease, currentFile: tx.currentFile });
      return runTransaction({ stateFile, tx: recovering, log, ...rest });
    }
    await sleep(pollMs);
  }
  // Do not race a live installer. Keep its protected recovery metadata, rather than granting a new transaction.
  const current = readTransaction(stateFile);
  if (current.phase === "staging") {
    // 终态 + 释放同一次仲裁；不覆盖已推进到 installing 的事务（phase CAS）。
    try { finishOwnedTerminal(stateFile, { phase: "failed", result: { ok: false, reason: "arm-timeout" }, expectedPhases: ["staging"] }, { lockPath, lease, currentFile: current.currentFile }); }
    catch (e) { log(`supervisor: 保留受保护事务（${e.message}）`); }
  }
  return { ok: false, error: "arm-timeout" };
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const stateFile = args.state;
	if (!stateFile) {
		console.error("usage: node update-supervisor.js --state <transaction.json> [--arm --ready <file>] [--timeout 180]");
		process.exit(2);
	}
	const timeoutMs = Number(args.timeout ?? 0) > 0 ? Number(args.timeout) * 1000 : DEFAULT_WAIT_TIMEOUT_MS;
	const pollMs = Number(args.poll ?? 0) > 0 ? Number(args.poll) : DEFAULT_POLL_MS;
	const log = (m) => console.log(m);
	const finalState = args.arm
		? await superviseArmed({ stateFile, readyFile: args.ready, opId: args.op, generation: args.generation, timeoutMs, pollMs, log })
		: await superviseUpdate({ stateFile, opId: args.op, generation: args.generation, timeoutMs, pollMs, log });
	console.log(`supervisor: 结束于 ${finalState?.phase ?? "unknown"}`);
}

if (process.argv[1] && process.argv[1].endsWith("update-supervisor.js")) {
	main().catch((e) => {
		console.error(`supervisor: 异常 ${e?.stack ?? e}`);
		process.exit(1);
	});
}
