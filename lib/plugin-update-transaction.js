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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/** 更新锁文件。 */
export function updateLockFile(home) {
	return join(home, ".dsh", "mobile-remote", "plugin-update.lock");
}

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

/** 读锁（无锁返回 null）。 */
export function readLock(file) {
	try {
		const doc = JSON.parse(readFileSync(file, "utf8"));
		return doc && typeof doc === "object" ? doc : null;
	} catch {
		return null;
	}
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

/**
 * 获取更新锁。**在任何共享状态写入之前调用**。
 * - 已有存活持有者且 opId 不同 → `{ok:false, error:"update-busy", holder}`；
 * - 同一 opId 重入 → 幂等成功（重试不另开事务）；
 * - 持有者已死或锁过期 → 抢占。
 */
export function acquireLock(file, {
	opId,
	pid = process.pid,
	now = Date.now(),
	staleMs = DEFAULT_LOCK_STALE_MS,
	isPidAlive = defaultIsPidAlive,
} = {}) {
	const holder = readLock(file);
	if (holder && holder.opId && holder.opId !== opId) {
		const alive = isPidAlive(holder.pid);
		const fresh = Number.isFinite(holder.at) && now - holder.at < staleMs;
		if (alive && fresh) return { ok: false, error: "update-busy", holder };
	}
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify({ opId, pid, at: now }, null, 2)}\n`, "utf8");
	return { ok: true, opId };
}

/** 释放锁（只有持有者能释放）。 */
export function releaseLock(file, opId) {
	const holder = readLock(file);
	if (holder && holder.opId !== opId) return false;
	try {
		rmSync(file, { force: true });
	} catch {
		return false;
	}
	return true;
}

/**
 * 把当前已安装的插件内容**快照**到不可变目录，供回滚使用。
 * 用 `cp -a` 等价的逐文件复制（不移动原目录：运行中的插件不能被搬走）。
 */
export function snapshotInstalled({ installedRoot, destDir, copyDir = defaultCopyDir } = {}) {
	if (!existsSync(installedRoot)) return { ok: false, error: "installed-root-missing" };
	rmSync(destDir, { recursive: true, force: true });
	mkdirSync(dirname(destDir), { recursive: true });
	const r = copyDir(installedRoot, destDir);
	if (!r?.ok) return { ok: false, error: `snapshot-failed: ${r?.error ?? "unknown"}` };
	return { ok: true, dir: destDir };
}

/** 默认复制实现：优先 `cp -a`（保留结构），失败回退递归复制。 */
export function defaultCopyDir(src, dest) {
	try {
		mkdirSync(dest, { recursive: true });
		copyRecursive(src, dest);
		return { ok: true };
	} catch (e) {
		return { ok: false, error: String(e?.message ?? e) };
	}
}

function copyRecursive(src, dest) {
	for (const entry of readdirSync(src, { withFileTypes: true })) {
		const from = join(src, entry.name);
		const to = join(dest, entry.name);
		if (entry.isDirectory()) {
			mkdirSync(to, { recursive: true });
			copyRecursive(from, to);
		} else if (entry.isFile()) {
			writeFileSync(to, readFileSync(from));
		}
	}
}

/** 目录是否存在且非空（用于判断快照/产物是否可用）。 */
export function dirReady(dir) {
	try {
		return statSync(dir).isDirectory() && readdirSync(dir).length > 0;
	} catch {
		return false;
	}
}
