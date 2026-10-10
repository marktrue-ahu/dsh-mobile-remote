// 插件自更新的**事务**（ADR 0019「插件自更新」）。
//
// 评审（GitLab #32 note 1286）指出的根因是：原来的实现把"回滚"放在**新版插件自己的
// apply() 里**，而新版插件一旦起不来就永远走不到那里；落位目录又只按版本号命名，
// 同版本不同内容的更新会先删掉自己的回滚目标；profile 目录还是从模块路径"往上数两层"
// 猜出来的，在 pnpm 的 virtual store 布局下必错。
//
// 本模块把这些前提一次性做对：
//   1. **不可变产物目录**：按内容标识命名，绝不覆盖既有目录（回滚目标因此永远还在）；
//   2. **单事务 + 锁**：同一 profile 同时只允许一个更新事务，重复请求幂等返回同一 opId；
//   3. **profile 目录靠"验证"而不是靠层级推断**：向上找第一个声明了本插件依赖的
//      package.json；找不到就返回空，调用方转降级指引，绝不动文件。
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

/** 事务阶段。`RESTART_PENDING` 是唯一需要外部监督器介入的阶段。 */
export const TRANSACTION_PHASE = {
	/** 正在下载/解包/落位：还没动 profile，失败可安全放弃。 */
	STAGING: "staging",
	/** 依赖已切换、正在安装。 */
	INSTALLING: "installing",
	/** 已提交，等待宿主重启生效——**监督器接管**。 */
	RESTART_PENDING: "restart-pending",
	/** 正在回滚（**中间态**：App 不得据此判成功，F7）。 */
	ROLLING_BACK: "rolling-back",
	/** 新版本已确认健康并生效。 */
	SETTLED: "settled",
	/** 已回滚到上一版并确认可用。 */
	ROLLED_BACK: "rolled-back",
	/** 失败（含回滚失败）。 */
	FAILED: "failed",
};

/** 锁的默认失效时间：超过它视为持有者已死（宿主崩溃/被杀）。 */
export const DEFAULT_LOCK_STALE_MS = 10 * 60 * 1000;

export function newOperationId() {
	return randomUUID();
}

/** 事务状态文件（放在插件数据目录，与通知/队列同源）。 */
export function transactionFile(home) {
	return join(home, ".dsh", "mobile-remote", "plugin-update-transaction.json");
}

/** 更新锁**目录**（mkdir 原子独占；见 acquireLock）。 */
export function updateLockPath(home) {
	return join(home, ".dsh", "mobile-remote", "plugin-update.lock.d");
}

/** 兼容旧名（它指向的是一个目录，不再是文件）。 */
export const updateLockFile = updateLockPath;

/** 下载/解包的工作目录（事务独占）。 */
export function workRoot(home) {
	return join(home, ".dsh", "mobile-remote", "update-work");
}

/** 不可变产物目录根。 */
export function artifactRoot(home) {
	return join(home, ".dsh", "mobile-remote", "plugin-artifacts");
}

/** 不可变快照根（回滚目标）。 */
export function snapshotRoot(home) {
	return join(home, ".dsh", "mobile-remote", "plugin-snapshots");
}

/** 按**内容标识**命名的不可变产物目录；同版本不同内容因此天然分属不同目录。 */
export function artifactDir(root, contentSha256) {
	return join(root, String(contentSha256 || "unknown").toLowerCase());
}

/** 按**内容标识**命名的不可变快照目录（更新前的旧内容）。 */
export function snapshotDir(root, contentSha256) {
	return join(root, String(contentSha256 || "unknown").toLowerCase());
}

export function readTransaction(file) {
	try {
		const doc = JSON.parse(readFileSync(file, "utf8"));
		return doc && typeof doc === "object" ? doc : null;
	} catch {
		return null;
	}
}

export function writeTransaction(file, tx) {
	mkdirSync(dirname(file), { recursive: true });
	const next = { ...tx, updatedAt: new Date().toISOString() };
	writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	return next;
}

export function clearTransaction(file) {
	try {
		rmSync(file, { force: true });
	} catch {
		// 清不掉不影响正确性：下次事务会覆盖它
	}
}

/**
 * 收敛"孤儿事务"（F6）：宿主在 staging / installing / restart-pending 期间死亡后，
 * 留下的非终态事务会让后续更新**永久 busy**。
 *
 * 判定只看一件事：**锁的持有者是否还活着**。持有者存活就不动（长安装不该被抢）；
 * 已死且超过 staleMs（或没有 startedAt）才落 FAILED 并释放锁。
 */
export function convergeStaleTransaction({
	stateFile,
	lockPath,
	isPidAlive = defaultIsPidAlive,
	now = () => Date.now(),
	staleMs = 10 * 60 * 1000,
} = {}) {
	const tx = readTransaction(stateFile);
	if (!tx) return { action: "none", transaction: null };
	if (tx.phase === TRANSACTION_PHASE.SETTLED || tx.phase === TRANSACTION_PHASE.ROLLED_BACK || tx.phase === TRANSACTION_PHASE.FAILED) {
		return { action: "terminal", transaction: tx };
	}
	const holder = readLock(lockPath);
	if (holder && isPidAlive(holder.pid)) return { action: "active", transaction: tx };
	const started = Date.parse(tx.startedAt ?? "");
	const stale = !Number.isFinite(started) || now() - started > staleMs;
	if (!stale) return { action: "recent", transaction: tx };
	const next = writeTransaction(stateFile, {
		...tx,
		phase: TRANSACTION_PHASE.FAILED,
		result: { ok: false, reason: "holder-gone" },
	});
	releaseLock(lockPath, tx.opId);
	return { action: "converged", transaction: next };
}

/**
 * 定位 profile 目录：从插件真实路径向上找**第一个声明了本插件依赖**的 package.json。
 *
 * 为什么不"往上数两层"：Node 解析包链接时会走 realpath，pnpm 标准布局下插件位于
 * `profile/node_modules/.pnpm/<entry>/node_modules/dsh-mobile-remote`，往上两层得到的是
 * `.pnpm/<entry>` 而不是 profile。这里改成**验证式查找**：找到的目录必须真的把
 * `dsh-mobile-remote` 写在 dependencies 里，否则继续往上，全都不匹配就返回空串。
 */
export function findProfileDir(startDir, { readJson = readJsonFile, maxDepth = 8 } = {}) {
	let dir = resolve(startDir);
	for (let i = 0; i < maxDepth; i++) {
		try {
			const doc = readJson(join(dir, "package.json"));
			if (doc && typeof doc === "object" && doc.dependencies && doc.dependencies["dsh-mobile-remote"]) {
				return dir;
			}
		} catch {
			// 该层没有 package.json 或不可读：继续向上
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return "";
}

function readJsonFile(file) {
	return JSON.parse(readFileSync(file, "utf8"));
}

/** 读 profile 里本插件的依赖声明；找不到返回空串（调用方据此转降级指引）。 */
export function profileSpecifierOf(profileDir, { readJson = readJsonFile } = {}) {
	if (!profileDir) return "";
	try {
		const doc = readJson(join(profileDir, "package.json"));
		const spec = doc?.dependencies?.["dsh-mobile-remote"];
		return typeof spec === "string" ? spec : "";
	} catch {
		return "";
	}
}

/**
 * 读锁（无锁返回 null）。锁是一个**目录**：`mkdir` 在 POSIX 上是原子的，
 * 因此不会出现"read→write 竞态导致两个调用都以为拿到了锁"（评审 F6）。
 */
export function readLock(dir) {
	try {
		const doc = JSON.parse(readFileSync(join(dir, "holder.json"), "utf8"));
		return doc && typeof doc === "object" ? doc : null;
	} catch {
		return null;
	}
}

function writeHolder(dir, holder) {
	writeFileSync(join(dir, "holder.json"), `${JSON.stringify(holder, null, 2)}\n`, "utf8");
}

/** 进程是否还活着（用于判断锁是否失效）。 */
export function defaultIsPidAlive(pid) {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** 锁当前是否被持有。 */
export function lockHeld(dir) {
	return existsSync(dir);
}

/**
 * 获取更新锁。**在任何共享状态写入之前调用**。
 *
 * - `mkdir` 原子独占；已存在则看持有者；
 * - 同一 opId → 幂等成功（同一 worker 重入，不会另起一个）；
 * - 持有者**仍存活** → busy（**不再**单凭固定 TTL 抢占：长安装不该被并发覆盖，F6）；
 * - 持有者已死 / 持有者信息损坏 → 用 `rename` 原子抢占（两个抢占者只有一个能成功）。
 */
export function acquireLock(dir, {
	opId,
	pid = process.pid,
	now = Date.now(),
	isPidAlive = defaultIsPidAlive,
} = {}) {
	try {
		// 先建父目录（非原子部分），再用**不带 recursive 的 mkdir** 原子独占锁目录
		mkdirSync(dirname(dir), { recursive: true });
		mkdirSync(dir);
		writeHolder(dir, { opId, pid, at: now });
		return { ok: true, opId };
	} catch (e) {
		if (e?.code !== "EEXIST") return { ok: false, error: `lock-error:${e?.code ?? e?.message}` };
	}
	const holder = readLock(dir);
	if (holder && holder.opId === opId) return { ok: true, opId, reentrant: true };
	if (holder && isPidAlive(holder.pid)) return { ok: false, error: "update-busy", holder };
	// 持有者已死（或持有者信息不可读）：原子抢占
	const graveyard = `${dir}.stale-${opId}-${now}`;
	let stolen = false;
	try {
		renameSync(dir, graveyard);
		stolen = true;
	} catch {
		// 别人先抢到了
	}
	if (stolen) {
		try {
			rmSync(graveyard, { recursive: true, force: true });
		} catch {
			// 清理失败不影响正确性
		}
	}
	try {
		mkdirSync(dirname(dir), { recursive: true });
		mkdirSync(dir);
		writeHolder(dir, { opId, pid, at: now });
		return { ok: true, opId, stolen };
	} catch {
		return { ok: false, error: "update-busy" };
	}
}

/** 释放锁（只有持有者能释放）。 */
export function releaseLock(dir, opId) {
	const holder = readLock(dir);
	if (holder && holder.opId !== opId) return false;
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		return false;
	}
	return true;
}

/** 更新锁的持有者换成监督器自己（接管事务，F2）。 */
export function handOverLock(dir, { fromOpId, toPid, now = Date.now() }) {
	const holder = readLock(dir);
	if (!holder || (fromOpId && holder.opId !== fromOpId)) return false;
	writeHolder(dir, { ...holder, pid: toPid, handedOverAt: now });
	return true;
}

/**
 * 把当前已安装的插件内容快照成**自包含、可加载**的不可变副本（F4）：
 *   - **解引用 symlink**：pnpm 布局下副本里的依赖是符号链接，若原样复制会指向树外的
 *     store；解引用后快照自己就是完整的依赖树；
 *   - **原子发布**：全部复制完成后才写 `.complete` 标记；中途失败留下的半成品不会被
 *     当成可用快照（`snapshotReady` 会拒绝）。
 */
export function snapshotInstalled({ installedRoot, destDir, copyDir = defaultCopyDir } = {}) {
	if (!existsSync(installedRoot)) return { ok: false, error: "installed-root-missing" };
	const staging = `${destDir}.partial`;
	rmSync(staging, { recursive: true, force: true });
	rmSync(destDir, { recursive: true, force: true });
	mkdirSync(dirname(destDir), { recursive: true });
	const r = copyDir(installedRoot, staging);
	if (!r?.ok) {
		rmSync(staging, { recursive: true, force: true });
		return { ok: false, error: `snapshot-failed: ${r?.error ?? "unknown"}` };
	}
	writeFileSync(join(staging, COMPLETE_MARKER), `${JSON.stringify({ at: new Date().toISOString() })}\n`, "utf8");
	// 原子发布：先删目标再改名（同分区 rename 是原子的）
	try {
		rmSync(destDir, { recursive: true, force: true });
		renameSync(staging, destDir);
	} catch (e) {
		rmSync(staging, { recursive: true, force: true });
		return { ok: false, error: `snapshot-publish-failed: ${e?.message ?? e}` };
	}
	return { ok: true, dir: destDir };
}

/** 默认复制实现：**解引用符号链接**，得到自包含树。 */
export function defaultCopyDir(src, dest) {
	try {
		mkdirSync(dest, { recursive: true });
		copyRecursive(src, dest, new Set());
		return { ok: true };
	} catch (e) {
		return { ok: false, error: String(e?.message ?? e) };
	}
}

function copyRecursive(src, dest, seen) {
	// 防环：symlink 解引用后可能回到祖先
	const key = `${src}->${dest}`;
	if (seen.has(key)) return;
	seen.add(key);
	for (const entry of readdirSync(src, { withFileTypes: true })) {
		const from = join(src, entry.name);
		const to = join(dest, entry.name);
		if (entry.isSymbolicLink()) {
			// 解引用：把链接目标的内容复制过来（目标缺失则跳过，不制造悬空链接）
			let real;
			try {
				real = realpathSync(from);
			} catch {
				continue;
			}
			const st = statSync(real);
			if (st.isDirectory()) {
				mkdirSync(to, { recursive: true });
				copyRecursive(real, to, seen);
			} else if (st.isFile()) {
				writeFileSync(to, readFileSync(real));
			}
			continue;
		}
		if (entry.isDirectory()) {
			mkdirSync(to, { recursive: true });
			copyRecursive(from, to, seen);
		} else if (entry.isFile()) {
			writeFileSync(to, readFileSync(from));
		}
	}
}

/** 快照完成标记（原子发布的凭据）。 */
export const COMPLETE_MARKER = ".complete";

/** 目录是否存在且非空（用于判断产物是否可用）。 */
export function dirReady(dir) {
	try {
		return statSync(dir).isDirectory() && readdirSync(dir).length > 0;
	} catch {
		return false;
	}
}

/** 快照是否**完整可用**：非空且带完成标记（半复制不会被当成回滚目标）。 */
export function snapshotReady(dir) {
	return dirReady(dir) && existsSync(join(dir, COMPLETE_MARKER));
}
