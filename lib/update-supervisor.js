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
	handOverLock,
	readTransaction,
	releaseLock,
	snapshotReady,
	updateLockPath,
	writeTransaction,
} from "./plugin-update-transaction.js";
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
export function defaultRestore({ profileDir, snapshotDir: snapDir, runInstall }) {
	if (!snapDir || !snapshotReady(snapDir)) {
		return { ok: false, error: "snapshot-unavailable" };
	}
	let doc;
	try {
		doc = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8"));
	} catch (e) {
		return { ok: false, error: `profile-unreadable: ${e?.message ?? e}` };
	}
	if (!doc?.dependencies) return { ok: false, error: "profile-has-no-dependencies" };
	doc.dependencies["dsh-mobile-remote"] = `file:${snapDir}`;
	try {
		writeFileSync(join(profileDir, "package.json"), `${JSON.stringify(doc, null, 2)}\n`, "utf8");
	} catch (e) {
		return { ok: false, error: `profile-unwritable: ${e?.message ?? e}` };
	}
	const installed = runInstall(profileDir);
	if (!installed?.ok) return { ok: false, error: `restore-install-failed: ${installed?.error ?? "unknown"}` };
	return { ok: true, restoredTo: snapDir };
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
export async function runTransaction({
	stateFile,
	tx,
	timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
	pollMs = DEFAULT_POLL_MS,
	maxRollbacks = 1,
	waitForHost: waitImpl = waitForHost,
	restore = defaultRestore,
	restart = defaultRestart,
	runInstall = defaultRunInstall,
	log = () => {},
	now = () => Date.now(),
} = {}) {
	const lockFile = updateLockPath(dirname(dirname(dirname(stateFile))));
	const finish = (base, phase, result) => {
		const next = writeTransaction(stateFile, { ...base, phase, result });
		releaseLock(lockFile, base.opId);
		return next;
	};
	const target = {
		contentSha256: String(tx.targetContentSha256 ?? "").toLowerCase(),
		version: tx.targetVersion ?? "",
	};

	// F1：**先重启**——旧宿主不会自行加载新代码；等待之前必须已经安排过重启
	const restartResult = restart({
		restartForm: tx.restartForm,
		port: tx.port,
		pid: tx.hostPid,
		profile: tx.profile,
		dshCommand: tx.dshCommand,
		log,
	});
	if (!restartResult?.ok) {
		return finish(tx, TRANSACTION_PHASE.FAILED, { ok: false, reason: "restart-failed", error: restartResult?.error });
	}

	log(`supervisor: 等待宿主重启并确认目标内容（${target.contentSha256 || target.version || "任意"}）`);
	const healthy = await waitImpl({
		port: tx.port,
		basePath: tx.basePath,
		token: tx.token,
		expectContentSha256: target.contentSha256,
		expectVersion: target.version,
		timeoutMs,
		pollMs,
	});
	if (healthy.ok) {
		return finish(tx, TRANSACTION_PHASE.SETTLED, { ok: true, matched: healthy.matched, at: new Date(now()).toISOString() });
	}

	// ── 回滚 ──
	log(`supervisor: 新版本未生效（${healthy.error}）→ 回滚`);
	const attempts = Number.isFinite(tx.attempts) ? tx.attempts : 0;
	if (!tx.previousSnapshotDir || !tx.profileDir) {
		return finish(tx, TRANSACTION_PHASE.FAILED, { ok: false, reason: "rollback-target-missing", error: healthy.error });
	}
	if (attempts >= maxRollbacks) {
		return finish(tx, TRANSACTION_PHASE.FAILED, { ok: false, reason: "rollback-exhausted", error: healthy.error });
	}

	// F7：回滚中间态用**独立阶段**表达，且**不改** targetContentSha256（原始升级目标不可变）
	const rolling = writeTransaction(stateFile, {
		...tx,
		phase: TRANSACTION_PHASE.ROLLING_BACK,
		attempts: attempts + 1,
		rolledBack: true,
		result: { ok: false, reason: "rolling-back", error: healthy.error },
	});
	const restored = restore({ profileDir: tx.profileDir, snapshotDir: tx.previousSnapshotDir, runInstall });
	if (!restored.ok) {
		return finish(rolling, TRANSACTION_PHASE.FAILED, { ok: false, reason: "rollback-restore-failed", error: restored.error });
	}
	const rolledRestart = restart({
		restartForm: tx.restartForm,
		port: tx.port,
		pid: null,
		profile: tx.profile,
		dshCommand: tx.dshCommand,
		log,
	});
	if (!rolledRestart?.ok) {
		return finish(rolling, TRANSACTION_PHASE.FAILED, { ok: false, reason: "rollback-restart-failed", error: rolledRestart?.error });
	}
	const back = await waitImpl({
		port: tx.port,
		basePath: tx.basePath,
		token: tx.token,
		expectContentSha256: String(tx.previousContentSha256 ?? "").toLowerCase(),
		expectVersion: "",
		timeoutMs,
		pollMs,
	});
	return finish(
		rolling,
		back.ok ? TRANSACTION_PHASE.ROLLED_BACK : TRANSACTION_PHASE.FAILED,
		back.ok
			? { ok: false, reason: "rolled-back", error: healthy.error }
			: { ok: false, reason: "rollback-unconfirmed", error: back.error },
	);
}

/** 监督一次更新事务（直接模式：事务已在 restart-pending 时使用；测试也走这里）。 */
export async function superviseUpdate(options = {}) {
	const { stateFile } = options;
	const tx = readTransaction(stateFile);
	if (!tx) return { ok: false, error: "no-transaction" };
	if (tx.phase === TRANSACTION_PHASE.ROLLING_BACK || tx.phase === TRANSACTION_PHASE.RESTART_PENDING) {
		return runTransaction({ ...options, tx });
	}
	return { ok: false, error: `not-restart-pending:${tx.phase}` };
}

/**
 * `--arm` 模式：先就绪（写回执 + 接管锁），再等事务进入 restart-pending，然后推进。
 * 插件在**做任何破坏性改动之前**等这个回执，逃逸/就绪失败即 fail-closed（F2）。
 */
export async function superviseArmed({
	stateFile,
	readyFile,
	armTimeoutMs = DEFAULT_ARM_TIMEOUT_MS,
	pollMs = DEFAULT_POLL_MS,
	log = () => {},
	sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
	now = () => Date.now(),
	...rest
} = {}) {
	const lockFile = updateLockPath(dirname(dirname(dirname(stateFile))));
	// 1) 就绪回执（含 pid 与 cgroup，便于排查"到底跑在哪"）
	let cgroup = "";
	try {
		cgroup = readFileSync("/proc/self/cgroup", "utf8").trim().split("\n")[0] ?? "";
	} catch {
		// 非 Linux 或不可读
	}
	mkdirSync(dirname(readyFile), { recursive: true });
	writeFileSync(readyFile, `${JSON.stringify({ pid: process.pid, cgroup, at: new Date(now()).toISOString() })}\n`, "utf8");
	log(`supervisor: 已就绪 pid=${process.pid} cgroup=${cgroup || "-"}`);

	// 2) 接管事务锁（"监督器还活着"的探测从此指向监督器，而不是旧宿主，F2）
	const tx0 = readTransaction(stateFile);
	if (tx0?.opId) {
		acquireLock(lockFile, { opId: tx0.opId, pid: process.pid, now: now() });
		handOverLock(lockFile, { fromOpId: tx0.opId, toPid: process.pid, now: now() });
	}

	// 3) 等事务进入 restart-pending（或已终态）
	const deadline = now() + armTimeoutMs;
	while (now() < deadline) {
		const tx = readTransaction(stateFile);
		if (!tx) return { ok: false, error: "transaction-vanished" };
		if (tx.phase === TRANSACTION_PHASE.RESTART_PENDING || tx.phase === TRANSACTION_PHASE.ROLLING_BACK) {
			return runTransaction({ stateFile, tx, log, ...rest });
		}
		if (tx.phase === TRANSACTION_PHASE.SETTLED || tx.phase === TRANSACTION_PHASE.ROLLED_BACK || tx.phase === TRANSACTION_PHASE.FAILED) {
			log(`supervisor: 事务已终态（${tx.phase}），退出`);
			releaseLock(lockFile, tx.opId);
			return tx;
		}
		await sleep(pollMs);
	}
	log("supervisor: 等事务进入待生效阶段超时");
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
		? await superviseArmed({ stateFile, readyFile: args.ready, timeoutMs, pollMs, log })
		: await superviseUpdate({ stateFile, timeoutMs, pollMs, log });
	console.log(`supervisor: 结束于 ${finalState?.phase ?? "unknown"}`);
}

if (process.argv[1] && process.argv[1].endsWith("update-supervisor.js")) {
	main().catch((e) => {
		console.error(`supervisor: 异常 ${e?.stack ?? e}`);
		process.exit(1);
	});
}
