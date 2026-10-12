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
import { freezePackage, frozenPackageReady } from "./runtime-dependency-snapshot.js";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

/** Converge only under the same OS arbitration as acquire/release/state writes. */
export function convergeStaleTransaction({ stateFile, lockPath, expectedLease, now = () => Date.now(), staleMs = 600_000 } = {}) {
  const result = arbitrate(lockPath, { operation: "converge", stateFile, expectedLease, now: now(), staleMs });
  if (!result.ok) return { action: "blocked", error: result.error, transaction: readTransaction(stateFile) };
  return result;
}

/**
 * 定位 profile 目录：从插件真实路径向上找**第一个声明了本插件依赖**的 package.json。
 *
 * 为什么不"往上数两层"：Node 解析包链接时会走 realpath，pnpm 标准布局下插件位于
 * `profile/node_modules/.pnpm/<entry>/node_modules/dsh-mobile-remote`，往上两层得到的是
 * `.pnpm/<entry>` 而不是 profile。这里改成**验证式查找**：找到的目录必须真的把
 * `dsh-mobile-remote` 写在 dependencies 里，否则继续往上，全都不匹配就返回空串。
 */
/** 旧键：早期安装用的包名（保持向后兼容）。 */
export const LEGACY_DEPENDENCY_KEY = "dsh-mobile-remote";

/**
 * 本插件在 profile 里可能出现的依赖键。
 * 包名一旦带 scope（npm 正式渠道），profile 的依赖键就变成 `@scope/name`——
 * 若还硬编码旧键，自更新会找不到 profile。因此键从**插件自己的 package.json** 推导。
 */
export function dependencyKeysFor(pluginRoot, { readJson = readJsonFile } = {}) {
	const keys = [];
	try {
		const name = readJson(join(pluginRoot, "package.json"))?.name;
		if (typeof name === "string" && name.trim() !== "") keys.push(name.trim());
	} catch {
		// 读不到自己的包名时只留旧键
	}
	if (!keys.includes(LEGACY_DEPENDENCY_KEY)) keys.push(LEGACY_DEPENDENCY_KEY);
	return keys;
}

/** 在 profile 的 dependencies 里找出实际使用的那个依赖键（找不到返回空串）。 */
export function dependencyKeyIn(doc, keys = [LEGACY_DEPENDENCY_KEY]) {
	for (const key of keys) {
		if (typeof doc?.dependencies?.[key] === "string") return key;
	}
	return "";
}

export function findProfileDir(startDir, { readJson = readJsonFile, maxDepth = 8, keys } = {}) {
	const dependencyKeys = keys ?? dependencyKeysFor(startDir, { readJson });
	let dir = resolve(startDir);
	for (let i = 0; i < maxDepth; i++) {
		try {
			const doc = readJson(join(dir, "package.json"));
			if (dependencyKeyIn(doc, dependencyKeys) !== "") return dir;
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
export function profileSpecifierOf(profileDir, { readJson = readJsonFile, keys = [LEGACY_DEPENDENCY_KEY] } = {}) {
	if (!profileDir) return "";
	try {
		const doc = readJson(join(profileDir, "package.json"));
		const key = dependencyKeyIn(doc, keys);
		return key === "" ? "" : doc.dependencies[key];
	} catch {
		return "";
	}
}

// C3: stable arbitration inode, kernel flock, and an unguessable generation fence.
// Metadata is never interpreted/removed by read->rename/rm outside this arbitration.
const arbiter = fileURLToPath(new URL("./update-lock-arbiter.js", import.meta.url));
function arbitrate(lockPath, request) {
  mkdirSync(dirname(lockPath), { recursive: true });
  const r = spawnSync("flock", ["--exclusive", "--wait", "5", `${lockPath}.arbitration`, process.execPath, arbiter], {
    input: JSON.stringify({ ...request, lockPath }), encoding: "utf8", timeout: 7000,
  });
  if (r.error || r.status !== 0) return { ok: false, error: "lock-arbitration-unavailable" };
  try { return JSON.parse(r.stdout); } catch { return { ok: false, error: "lock-arbitration-invalid" }; }
}
export function readLock(dir) {
  try { return JSON.parse(readFileSync(join(dir, "holder.json"), "utf8")); } catch { return null; }
}
export function defaultIsPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch(e) { return e.code === "EPERM"; }
}
export function lockHeld(dir) { return readLock(dir) !== null; }
export function acquireLock(dir, { opId, pid = process.pid, now = Date.now(), lease, stateFile } = {}) {
  if (!validOperationId(opId)) return { ok: false, error: "invalid-operation-id" };
  return arbitrate(dir, { operation: "acquire", opId, pid, now, lease, stateFile });
}
export function releaseLock(dir, lease, { stateFile } = {}) {
  // An opId alone is not ownership. Old workers need the exact generation too.
  if (!lease?.generation) return false;
  return arbitrate(dir, { operation: "release", lease, stateFile }).ok;
}
export function handOverLock(dir, { lease, toPid } = {}) {
  if (!lease?.generation) return false;
  return arbitrate(dir, { operation: "handover", lease, toPid }).ok;
}
export function assertUpdateLease(lockPath, lease) {
  const r = arbitrate(lockPath, { operation: "assert", lease });
  if (!r.ok) throw new Error(r.error);
  return r.holder;
}
export function writeOwnedTransaction(stateFile, tx, { lockPath, lease, currentFile, expectedPhases } = {}) {
  const r = arbitrate(lockPath, { operation: "state-write", lease, stateFile, tx, currentFile, expectedPhases });
  if (!r.ok) throw new Error(r.error);
  return r.transaction;
}
export function switchOwnedDependency({ profileDir, nextSpecifier, key, lockPath, lease } = {}) {
  return arbitrate(lockPath, { operation: "switch-profile", lease, profileDir, specifier: nextSpecifier, key });
}
export function claimOwnedRecovery(stateFile, { owner }, { lockPath, lease, currentFile } = {}) {
  return arbitrate(lockPath, { operation: 'claim-recovery', lease, stateFile, owner, currentFile });
}
export function finishOwnedTerminal(stateFile, { phase, result, expectedPhases }, { lockPath, lease, currentFile } = {}) {
  const r = arbitrate(lockPath, { operation: 'finish-terminal', lease, stateFile, phase, result, expectedPhases, currentFile });
  if (!r.ok) throw new Error(r.error);
  return r.transaction;
}
export function restoreOwnedProfile({ profileDir, snapshotDir, snapshot, key, lockPath, lease } = {}) {
  return arbitrate(lockPath, { operation: 'restore-profile', profileDir, snapshotDir, snapshot, key, lease });
}
export function publishOwnedSnapshotLink({ profileDir, snapshotDir, lockPath, lease } = {}) {
  return arbitrate(lockPath, { operation: 'publish-snapshot-link', profileDir, snapshotDir, lease });
}
export function validOperationId(opId) {
  return typeof opId === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(opId);
}
export function serverOperationPath(home, id) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error("invalid-filesystem-id");
  return join(home, ".dsh", "mobile-remote", "transactions", `${id}.json`);
}

/**
 * 把当前已安装的插件内容快照成**自包含、可加载**的不可变副本（F4）：
 *   - **解引用 symlink**：pnpm 布局下副本里的依赖是符号链接，若原样复制会指向树外的
 *     store；解引用后快照自己就是完整的依赖树；
 *   - **原子发布**：全部复制完成后才写 `.complete` 标记；中途失败留下的半成品不会被
 *     当成可用快照（`snapshotReady` 会拒绝）。
 */
export function snapshotInstalled({ installedRoot, destDir, copyFile } = {}) {
  if (!existsSync(installedRoot)) return { ok: false, error: "installed-root-missing" };
  return freezePackage({ sourceRoot: installedRoot, destination: destDir, copyFile });
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
				throw new Error("required-link-broken");
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
	return frozenPackageReady(dir);
}
