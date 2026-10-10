#!/usr/bin/env node
// 插件自更新的**外部监督器**（ADR 0019；评审 #32 note 1286 的 R1）。
//
// 为什么必须独立：原来的回滚检查写在新版插件自己的 `apply()` 里——新版语法错误、缺依赖、
// 或模块初始化失败时根本走不到那里，宿主重启后**永久失联**且无人回滚。
//
// 本脚本由**旧版插件**以分离进程启动（旧代码当前正在正常运行，因此可信），因此：
//   - 不依赖新版插件能否加载；
//   - 宿主被杀/重启都不影响它；
//   - 它自己负责"等待健康 → 确认内容标识 → 失败则换回快照并再重启一次 → 落最终状态"。
//
// 用法（由插件调用，一般不手敲）：
//   node update-supervisor.js --state <transaction.json> [--timeout 180] [--poll 2000]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
	TRANSACTION_PHASE,
	readTransaction,
	releaseLock,
	updateLockFile,
	writeTransaction,
} from "./plugin-update-transaction.js";
import { restartPlan, buildRestartScript } from "./plugin-self-update.js";

/** 等待宿主的默认超时：足够冷启动（含语料预热），又不至于让用户无限等。 */
export const DEFAULT_WAIT_TIMEOUT_MS = 180_000;
export const DEFAULT_POLL_MS = 2_000;

/** 解析命令行参数。 */
export function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const key = argv[i];
		if (!key.startsWith("--")) continue;
		out[key.slice(2)] = argv[i + 1]?.startsWith("--") ? "true" : argv[++i] ?? "";
	}
	return out;
}

/**
 * 轮询本机宿主，直到它报告出**期望的内容标识**（或期望版本）。
 * 判定依据是"插件自己算出的、当前正在运行的代码"的内容标识——它证明的是
 * "新实例已经健康地在服务"，而不只是"磁盘上的字节对"。
 */
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

/** 恢复依赖声明并重装（回滚的一半；另一半是再次重启）。 */
export function defaultRestore({ profileDir, previousSpecifier, runInstall }) {
	let doc;
	try {
		doc = JSON.parse(readFileSync(`${profileDir}/package.json`, "utf8"));
	} catch (e) {
		return { ok: false, error: `profile-unreadable: ${e?.message ?? e}` };
	}
	if (!doc?.dependencies) return { ok: false, error: "profile-has-no-dependencies" };
	doc.dependencies["dsh-mobile-remote"] = previousSpecifier;
	try {
		writeFileSync(`${profileDir}/package.json`, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
	} catch (e) {
		return { ok: false, error: `profile-unwritable: ${e?.message ?? e}` };
	}
	const installed = runInstall(profileDir);
	if (!installed?.ok) return { ok: false, error: `restore-install-failed: ${installed?.error ?? "unknown"}` };
	return { ok: true };
}

/** 默认安装器（监督器是独立进程，阻塞没关系）。 */
export function defaultRunInstall(profileDir) {
	const r = spawnSync("pnpm", ["install"], { cwd: profileDir, encoding: "utf8" });
	if (r.error) return { ok: false, error: r.error.message };
	if (r.status !== 0) return { ok: false, error: (r.stderr || `exit ${r.status}`).trim() };
	return { ok: true };
}

/** 默认重启器：分离进程执行重启脚本（与插件侧同一实现）。 */
export function defaultRestart({ restartForm, pid, profile, dshCommand, log = () => {} }) {
	const plan = restartPlan({ form: restartForm, pid, profile, dshCommand });
	const script = buildRestartScript({ plan, pid, delayMs: 1500 });
	if (script === "") return { ok: false, error: "restart-unsupported" };
	const r = spawnSync("bash", ["-lc", `setsid ${script} >/dev/null 2>&1 &`], { encoding: "utf8", detached: true });
	if (r.error) return { ok: false, error: r.error.message };
	log(`supervisor: 已安排重启：${script}`);
	return { ok: true };
}

/**
 * 监督一次更新事务。全部副作用可注入，便于在没有真实宿主的测试里驱动。
 *
 * 返回值即最终事务状态。
 */
export async function superviseUpdate({
	stateFile,
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
	const tx = readTransaction(stateFile);
	if (!tx) return { ok: false, error: "no-transaction" };
	if (tx.phase !== TRANSACTION_PHASE.RESTART_PENDING) {
		return { ok: false, error: `not-restart-pending:${tx.phase}` };
	}
	// 事务与锁同目录：终态时一并释放，后续更新才不会被"上一次刚结束"挡住
	const lockFile = join(dirname(stateFile), "plugin-update.lock");
	const finish = (base, phase, result) => {
		const next = writeTransaction(stateFile, { ...base, phase, result });
		releaseLock(lockFile, base.opId);
		return next;
	};

	const target = {
		contentSha256: String(tx.targetContentSha256 ?? "").toLowerCase(),
		version: tx.targetVersion ?? "",
	};
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

	log(`supervisor: 新版本未生效（${healthy.error}）→ 回滚`);
	if (!tx.previousSpecifier || !tx.profileDir) {
		return finish(tx, TRANSACTION_PHASE.FAILED, { ok: false, reason: "rollback-target-missing", error: healthy.error });
	}
	const attempts = Number.isFinite(tx.attempts) ? tx.attempts : 0;
	if (attempts >= maxRollbacks) {
		return finish(tx, TRANSACTION_PHASE.FAILED, { ok: false, reason: "rollback-exhausted", error: healthy.error });
	}

	const restored = restore({ profileDir: tx.profileDir, previousSpecifier: tx.previousSpecifier, runInstall });
	if (!restored.ok) {
		return finish(tx, TRANSACTION_PHASE.FAILED, { ok: false, reason: "rollback-restore-failed", error: restored.error });
	}
	const rolled = writeTransaction(stateFile, {
		...tx,
		phase: TRANSACTION_PHASE.RESTART_PENDING,
		attempts: attempts + 1,
		rolledBack: true,
		targetContentSha256: tx.previousContentSha256 ?? "",
		result: { ok: false, reason: "rolled-back-restarting", error: healthy.error },
	});
	restart({
		restartForm: tx.restartForm,
		pid: process.pid === tx.hostPid ? null : tx.hostPid,
		profile: tx.profile,
		dshCommand: tx.dshCommand,
		log,
	});

	// 回滚后也要确认旧版本真的回来了（否则"回滚成功"是空话）
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
		rolled,
		back.ok ? TRANSACTION_PHASE.ROLLED_BACK : TRANSACTION_PHASE.FAILED,
		back.ok
			? { ok: false, reason: "rolled-back", error: healthy.error }
			: { ok: false, reason: "rollback-unconfirmed", error: back.error },
	);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const stateFile = args.state;
	if (!stateFile) {
		console.error("usage: node update-supervisor.js --state <transaction.json> [--timeout 180]");
		process.exit(2);
	}
	const timeoutMs = Number(args.timeout ?? 0) > 0 ? Number(args.timeout) * 1000 : DEFAULT_WAIT_TIMEOUT_MS;
	const finalState = await superviseUpdate({
		stateFile,
		timeoutMs,
		pollMs: Number(args.poll ?? 0) > 0 ? Number(args.poll) : DEFAULT_POLL_MS,
		log: (m) => console.log(m),
	});
	console.log(`supervisor: 结束于 ${finalState?.phase ?? "unknown"}`);
}

// 仅在被当作脚本直接执行时跑 main（被 import 时不跑）
if (process.argv[1] && process.argv[1].endsWith("update-supervisor.js")) {
	main().catch((e) => {
		console.error(`supervisor: 异常 ${e?.stack ?? e}`);
		process.exit(1);
	});
}
