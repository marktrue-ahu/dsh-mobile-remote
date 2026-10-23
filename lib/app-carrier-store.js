// App 载体托管区（设计稿 §5.4「目录、所有权与发布协议」、§5.8「保留、事务引用与回收」、
// §5.3/§10.1 的 R2/R3/R5）。
//
// 这个 module 是**唯一**被允许写 `<effectiveUpdateDir>/.app-carrier/` 的地方：自动导入、
// 发布记录、profile 当前指针、事务租约、暂存区与 GC 都走同一把提交锁与同一个提交协议，
// 避免并发导入/发布/GC 留下"可服务的半成品"。
//
// 契约要点（对外行为，不是实现细节）：
//   1. **所有权与布局版本**：托管区根带 `owner.json`（module/kind/layout）。目录已存在但
//      没有合法标记、或布局版本未知时一律"不接管"并返回诊断（`ownership-missing` /
//      `layout-version-unknown`），绝不递归清理；人工区（updateDir 下其它文件）永不读写。
//   2. **提交协议**：暂存（staging，不参与服务）→ 校验 size/sha256 → 发布不可变对象
//      （objects/<kind>/<sha256>/…，按对象哈希寻址）→ 原子发布 release 记录 → 最后原子
//      更新本 profile 指针。任一步失败/中断都不产生可服务的半成品：没有 release 记录就
//      无法寻址，指针永远最后写。
//   3. **不可变 inode**：已发布对象绝不原地覆盖；暂存文件经同文件系统 rename 发布。载体源
//      只用硬链接（源永不移动/改写），不支持/跨文件系统时回退复制；人工导入一律复制成独立
//      inode，避免人工区文件被后续覆盖时污染托管对象。
//   4. **profile 隔离**：`profiles/<profileKey>/current.json` 按 profile 分开；无法确定
//      profile 身份时返回明确不可用，绝不"找第一个"。
//   5. **releaseId/v1**：对规范序列化的两段产物身份字段（两端版本、文件名、大小、字节哈希、
//      插件内容标识；不含 URL/备注/临时地址）求 sha256。序列化顺序与归一化规则是 P0 契约：
//      只增字段，改变顺序/归一化必须升版本前缀（`RELEASE_ID_FIELD_ORDER` 与测试向量钉住）。
//   6. **保留与 GC**：当前发布不因时间过期；被替代后按 profile 与真实选用周期保留 24h
//      （重复调用/重启不重置）；有效租约与已打开句柄保护的对象不删；GC 汇总所有 profile
//      当前引用、保留截止与有效租约取并集；GC 前核对 profile 存活性（profile 目录与
//      package.json 仍存在），遗弃指针先写墓碑再释放引用；只删本 module 的托管对象。
//   7. **状态语义**：所有面向调用方的函数返回稳定状态
//      （ready / staged / not-ready / expired / mismatch / unusable / invalid / busy + reason），
//      不抛裸异常。纯函数（releaseId 计算）对非法身份抛错，由 releaseIdentityFromManifest
//      转成稳定状态。
//   8. **锁顺序**：上层按"既有更新租约 → 托管区提交锁"的固定顺序使用；本 module 自持一把
//      提交锁（`withCarrierCommitLock`），GC 只取这一把锁；持锁期间不做网络/子进程等待
//      （回调必须是同步函数），忙时立即返回 busy 而不是阻塞等待。
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync,
	openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmdirSync,
	rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

// ── 常量 ─────────────────────────────────────────────────────────────────────

/** 托管区目录名（位于配置的 updateDir 之下，见设计稿 §5.4）。 */
export const APP_CARRIER_DIR = ".app-carrier";
/** 所有权标记里的 module 名。 */
export const APP_CARRIER_MODULE = "dsh-mobile-remote";
/** 所有权标记里的 kind，避免与将来别的托管区混用。 */
export const APP_CARRIER_KIND = "app-carrier";
/** 布局版本；目录结构/字段语义变化时递增。未知版本 → 不接管。 */
export const APP_CARRIER_LAYOUT_VERSION = 1;
/** 所有权标记文件名（托管区根下）。 */
export const CARRIER_OWNER_FILE = "owner.json";
/** releaseId 的版本化前缀；改变序列化顺序或归一化规则必须递增。 */
export const RELEASE_ID_PREFIX = "releaseId/v1";
/**
 * releaseId 参与字段及其**固定序列化顺序**（只增字段，不得重排/改变归一化）。
 * 不含 URL、备注、临时地址等非身份字段。
 */
export const RELEASE_ID_FIELD_ORDER = Object.freeze([
	"app.version",
	"app.file",
	"app.size",
	"app.sha256",
	"plugin.version",
	"plugin.file",
	"plugin.size",
	"plugin.sha256",
	"plugin.contentSha256",
]);
/** 默认保留窗口：24 小时（设计稿 A5/§5.8）。 */
export const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
/** 暂存区残留的默认回收年龄：1 小时（未提交产物本来就不参与服务）。 */
export const DEFAULT_STAGING_TTL_MS = 60 * 60 * 1000;
/** 租约心跳默认有效期：10 分钟（与既有更新事务的恢复窗口同量级）。 */
export const DEFAULT_LEASE_TTL_MS = 10 * 60 * 1000;
/** 提交锁在"持有者缺失但锁目录还在"时的判定年龄。 */
export const DEFAULT_COMMIT_LOCK_STALE_MS = 2 * 60 * 1000;

/** 终态租约阶段：终态释放事务引用，但不能缩短已承诺的保留窗口。 */
export const TERMINAL_LEASE_PHASES = Object.freeze(["settled", "rolled-back", "failed", "expired", "cancelled"]);

/** 对外稳定状态。 */
export const CARRIER_STATUS = Object.freeze({
	READY: "ready",
	STAGED: "staged",
	NOT_READY: "not-ready",
	EXPIRED: "expired",
	MISMATCH: "mismatch",
	UNUSABLE: "unusable",
	INVALID: "invalid",
	BUSY: "busy",
});

/** 对象种类 → 托管区文件名。 */
const OBJECT_NAMES = Object.freeze({ apk: "app.apk", plugin: "plugin.tgz" });
const OBJECT_KINDS = Object.freeze(["apk", "plugin"]);
/** 暂存目录里允许出现的条目（GC 只清理完全属于本 module 的暂存目录）。 */
const STAGING_ENTRY_PATTERN = /^(?:app\.apk|plugin\.tgz|staged\.json|staged\.json\.[A-Za-z0-9-]+\.tmp)$/;
/** release 临时目录（原子发布 release 记录用）。 */
const RELEASE_TMP_PREFIX = ".tmp-";
/** 硬链接不可用时的回退错误码（跨文件系统 / 不支持 / 权限受限）。 */
const LINK_FALLBACK_CODES = new Set(["EXDEV", "EPERM", "EACCES", "EMLINK", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"]);
/** 本进程内持有中的提交锁：root → { token, depth }（支持同一锁的重入）。 */
const heldCommitLocks = new Map();
/** 本进程内已打开对象句柄的引用计数：`<kind>:<sha256>` → count（GC 用）。 */
const openObjectPins = new Map();

const HEX64 = /^[a-f0-9]{64}$/;
const PROFILE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const STAGING_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;
const LEASE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

// ── 通用小工具 ───────────────────────────────────────────────────────────────

function ready(extra = {}) {
	return { ok: true, status: CARRIER_STATUS.READY, ...extra };
}

function failed(status, reason, extra = {}) {
	return { ok: false, status, reason, ...extra };
}

function nowIso(ms) {
	return new Date(ms).toISOString();
}

function readJson(file) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

/** 尽力同步落盘（平台不支持/权限不允许时忽略——正确性不依赖它，崩溃恢复才有差异）。 */
function fsyncDir(dir) {
	try {
		const fd = openSync(dir, "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	} catch {
		// 某些文件系统不允许对目录 fsync：忽略
	}
}

/** 原子写 JSON：同目录 tmp + rename，持锁调用者保证目标不被并发改写。 */
function atomicWriteJson(file, value) {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${randomUUID()}.tmp`;
	try {
		const fd = openSync(tmp, "w", 0o600);
		try {
			writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, file);
		fsyncDir(dirname(file));
	} finally {
		if (existsSync(tmp)) rmSync(tmp, { force: true });
	}
}

/** 分块算 sha256，避免把 72MB APK 整个读进内存。 */
function hashFileSync(file) {
	const hash = createHash("sha256");
	const fd = openSync(file, "r");
	try {
		const buffer = Buffer.allocUnsafe(1024 * 1024);
		for (;;) {
			const read = readSync(fd, buffer, 0, buffer.length, null);
			if (read <= 0) break;
			hash.update(buffer.subarray(0, read));
		}
	} finally {
		closeSync(fd);
	}
	return hash.digest("hex");
}

function pidAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}

function listDir(dir) {
	try {
		return readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

function listSubdirs(dir) {
	return listDir(dir).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

function listFiles(dir) {
	return listDir(dir).filter((entry) => entry.isFile()).map((entry) => entry.name);
}

// ── 布局 ─────────────────────────────────────────────────────────────────────

/**
 * 托管区布局路径。`updateDir` 非法（空/非字符串）时返回 null——调用方据此报
 * `update-dir-missing`，不把当前工作目录当成更新目录。
 */
export function carrierPaths(updateDir) {
	if (typeof updateDir !== "string" || updateDir.trim() === "") return null;
	const base = resolve(updateDir);
	const root = join(base, APP_CARRIER_DIR);
	return {
		updateDir: base,
		root,
		ownerFile: join(root, CARRIER_OWNER_FILE),
		objects: join(root, "objects"),
		apkObjects: join(root, "objects", "apk"),
		pluginObjects: join(root, "objects", "plugin"),
		releases: join(root, "releases"),
		profiles: join(root, "profiles"),
		leases: join(root, "leases"),
		staging: join(root, "staging"),
		retentionFile: join(root, "retention.json"),
		commitLock: join(root, "commit.lock"),
	};
}

/** 托管区根目录；`updateDir` 非法时返回 null。 */
export function carrierRoot(updateDir) {
	return carrierPaths(updateDir)?.root ?? null;
}

function objectPath(paths, kind, sha256) {
	return join(kind === "apk" ? paths.apkObjects : paths.pluginObjects, sha256, OBJECT_NAMES[kind]);
}

function releaseDir(paths, releaseId) {
	return join(paths.releases, releaseId);
}

function profileDir(paths, profileKey) {
	return join(paths.profiles, profileKey);
}

function pointerPath(paths, profileKey) {
	return join(profileDir(paths, profileKey), "current.json");
}

function leasePath(paths, leaseId) {
	return join(paths.leases, `${leaseId}.json`);
}

function stagingDir(paths, stagingId) {
	return join(paths.staging, stagingId);
}

/** 读所有权标记；返回 { ok, ownership } 或 { ok:false, reason }。 */
function inspectOwnership(paths) {
	if (!existsSync(paths.root)) {
		return failed(CARRIER_STATUS.NOT_READY, "carrier-not-initialized", { root: paths.root });
	}
	let stat;
	try {
		stat = statSync(paths.root);
	} catch {
		return failed(CARRIER_STATUS.UNUSABLE, "carrier-root-unreadable", { root: paths.root });
	}
	if (!stat.isDirectory()) {
		return failed(CARRIER_STATUS.UNUSABLE, "carrier-root-not-directory", { root: paths.root });
	}
	const ownership = readJson(paths.ownerFile);
	if (!ownership || typeof ownership !== "object") {
		return failed(CARRIER_STATUS.UNUSABLE, "ownership-missing", { root: paths.root });
	}
	if (ownership.module !== APP_CARRIER_MODULE || ownership.kind !== APP_CARRIER_KIND) {
		return failed(CARRIER_STATUS.UNUSABLE, "ownership-foreign", { root: paths.root, ownership });
	}
	if (ownership.layout !== APP_CARRIER_LAYOUT_VERSION) {
		return failed(CARRIER_STATUS.UNUSABLE, "layout-version-unknown", { root: paths.root, layout: ownership.layout ?? null });
	}
	return { ok: true, ownership, root: paths.root };
}

/**
 * 确保托管区存在（幂等）。已有目录但所有权缺失/版本未知时**不接管**，原样返回诊断；
 * 绝不递归清理或覆盖。`create:false` 只检查不创建。
 */
export function ensureCarrierStore({ updateDir, now = Date.now(), create = true } = {}) {
	try {
		const paths = carrierPaths(updateDir);
		if (!paths) return failed(CARRIER_STATUS.UNUSABLE, "update-dir-missing");
		const inspected = inspectOwnership(paths);
		if (inspected.ok) return { ...ready({ root: paths.root, ownership: inspected.ownership }), created: false };
		if (inspected.reason !== "carrier-not-initialized" || !create) return inspected;
		try {
			mkdirSync(paths.root, { recursive: true });
		} catch (error) {
			return failed(CARRIER_STATUS.UNUSABLE, "store-not-writable", { detail: error.code ?? String(error) });
		}
		const ownership = {
			module: APP_CARRIER_MODULE,
			kind: APP_CARRIER_KIND,
			schema: 1,
			layout: APP_CARRIER_LAYOUT_VERSION,
			createdAt: nowIso(now),
			updatedAt: nowIso(now),
		};
		try {
			// `wx`：绝不覆盖别人已经落下的所有权标记（并发初始化时以先写者为准）。
			let fd;
			try {
				fd = openSync(paths.ownerFile, "wx", 0o600);
			} catch (error) {
				if (error?.code !== "EEXIST") throw error;
				const raced = inspectOwnership(paths);
				if (!raced.ok) return raced;
				return { ...ready({ root: paths.root, ownership: raced.ownership }), created: false };
			}
			try {
				writeFileSync(fd, `${JSON.stringify(ownership, null, 2)}\n`, "utf8");
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			fsyncDir(paths.root);
			for (const dir of [paths.objects, paths.apkObjects, paths.pluginObjects, paths.releases, paths.profiles, paths.leases, paths.staging]) {
				mkdirSync(dir, { recursive: true });
			}
		} catch (error) {
			return failed(CARRIER_STATUS.UNUSABLE, "store-not-writable", { detail: error.code ?? String(error) });
		}
		return { ...ready({ root: paths.root, ownership }), created: true };
	} catch (error) {
		return failed(CARRIER_STATUS.UNUSABLE, "internal-error", { detail: String(error?.message ?? error) });
	}
}

/** 只读检查托管区所有权与布局版本（诊断用，不创建任何东西）。 */
export function readCarrierOwnership({ updateDir } = {}) {
	try {
		const paths = carrierPaths(updateDir);
		if (!paths) return failed(CARRIER_STATUS.UNUSABLE, "update-dir-missing");
		const inspected = inspectOwnership(paths);
		return inspected.ok ? { ...ready({ root: paths.root, ownership: inspected.ownership }) } : inspected;
	} catch (error) {
		return failed(CARRIER_STATUS.UNUSABLE, "internal-error", { detail: String(error?.message ?? error) });
	}
}

// ── releaseId/v1 ─────────────────────────────────────────────────────────────

function identityError(field, code) {
	const error = new Error(`${field}:${code}`);
	error.field = field;
	error.identityCode = code;
	return error;
}

function normalizeVersion(value, field) {
	if (typeof value !== "string") throw identityError(field, "not-a-string");
	const text = value.trim();
	// 换行/控制字符会破坏规范序列化的可判定性；版本号本身不应包含它们。
	if (text === "" || /[\r\n\u0000-\u001f]/.test(text)) throw identityError(field, "invalid");
	return text;
}

function normalizeFileName(value, field) {
	if (typeof value !== "string") throw identityError(field, "not-a-string");
	const text = value.trim();
	if (text === "" || text === "." || text === ".." || /[/\\]/.test(text) || /[\r\n\u0000-\u001f]/.test(text)) {
		throw identityError(field, "invalid");
	}
	return text;
}

function normalizeSize(value, field) {
	// 严格只接受非负安全整数：接受数字字符串会让 "42" 与 42 有两种序列化，破坏规范形式。
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw identityError(field, "invalid");
	return value;
}

function normalizeSha256(value, field) {
	if (typeof value !== "string") throw identityError(field, "not-a-string");
	const text = value.trim().toLowerCase();
	if (!HEX64.test(text)) throw identityError(field, "invalid");
	return text;
}

/**
 * 归一化两段产物身份字段（只保留 releaseId 参与字段，剔除 URL/备注等）。
 * 非法身份抛错（带 field/code），由 `releaseIdentityFromManifest` 转成稳定状态。
 */
export function normalizeReleaseIdentity(identity) {
	if (!identity || typeof identity !== "object") throw identityError("identity", "not-an-object");
	const app = identity.app;
	const plugin = identity.plugin;
	if (!app || typeof app !== "object") throw identityError("app", "missing");
	if (!plugin || typeof plugin !== "object") throw identityError("plugin", "missing");
	return {
		app: {
			version: normalizeVersion(app.version, "app.version"),
			file: normalizeFileName(app.file, "app.file"),
			size: normalizeSize(app.size, "app.size"),
			sha256: normalizeSha256(app.sha256, "app.sha256"),
		},
		plugin: {
			version: normalizeVersion(plugin.version, "plugin.version"),
			file: normalizeFileName(plugin.file, "plugin.file"),
			size: normalizeSize(plugin.size, "plugin.size"),
			sha256: normalizeSha256(plugin.sha256, "plugin.sha256"),
			contentSha256: normalizeSha256(plugin.contentSha256, "plugin.contentSha256"),
		},
	};
}

/**
 * releaseId 的**规范序列化**（P0 契约）：前缀行 + 固定字段顺序的紧凑 JSON。
 * 任何顺序/归一化变化都会改变同一身份的 releaseId，因此必须提升 `RELEASE_ID_PREFIX`。
 */
export function releaseIdCanonical(identity) {
	const normalized = normalizeReleaseIdentity(identity);
	const body = {
		app: {
			version: normalized.app.version,
			file: normalized.app.file,
			size: normalized.app.size,
			sha256: normalized.app.sha256,
		},
		plugin: {
			version: normalized.plugin.version,
			file: normalized.plugin.file,
			size: normalized.plugin.size,
			sha256: normalized.plugin.sha256,
			contentSha256: normalized.plugin.contentSha256,
		},
	};
	return `${RELEASE_ID_PREFIX}\n${JSON.stringify(body)}`;
}

/** 计算 releaseId：sha256(规范序列化)。非法身份抛错（纯函数）。 */
export function computeReleaseId(identity) {
	return createHash("sha256").update(releaseIdCanonical(identity), "utf8").digest("hex");
}

/**
 * 从完整发布清单（schema 1，含 app/plugin 两段）求 releaseId；非法清单返回稳定状态。
 * 清单中的 URL、备注、临时地址不参与身份。
 */
export function releaseIdentityFromManifest(manifest) {
	try {
		if (!manifest || typeof manifest !== "object") return failed(CARRIER_STATUS.MISMATCH, "manifest-invalid");
		if (manifest.schema !== 1) {
			return failed(CARRIER_STATUS.MISMATCH, "manifest-schema-unknown", { schema: manifest.schema ?? null });
		}
		const identity = normalizeReleaseIdentity({ app: manifest.app, plugin: manifest.plugin });
		return { ok: true, identity, releaseId: computeReleaseId(identity) };
	} catch (error) {
		return failed(CARRIER_STATUS.MISMATCH, "manifest-identity-invalid", {
			field: error?.field ?? null,
			code: error?.identityCode ?? "invalid",
		});
	}
}

// ── 文件/对象校验 ─────────────────────────────────────────────────────────────

/** 按身份段校验文件 size + sha256；`hash:false` 只校验大小。 */
function verifyFile(file, expected, { hash = true } = {}) {
	let stat;
	try {
		stat = statSync(file);
	} catch (error) {
		return failed(CARRIER_STATUS.NOT_READY, "file-missing", { detail: error.code ?? String(error) });
	}
	if (!stat.isFile()) return failed(CARRIER_STATUS.MISMATCH, "not-a-regular-file");
	if (stat.size !== expected.size) {
		return failed(CARRIER_STATUS.MISMATCH, "size-mismatch", { expectedSize: expected.size, actualSize: stat.size });
	}
	if (hash) {
		let actual;
		try {
			actual = hashFileSync(file);
		} catch (error) {
			return failed(CARRIER_STATUS.NOT_READY, "file-unreadable", { detail: error.code ?? String(error) });
		}
		if (actual !== expected.sha256) {
			return failed(CARRIER_STATUS.MISMATCH, "hash-mismatch", { expected: expected.sha256, actual });
		}
	}
	return { ok: true, size: stat.size };
}

function pinKey(kind, sha256) {
	return `${kind}:${sha256}`;
}

function registerPin(kind, sha256) {
	const key = pinKey(kind, sha256);
	openObjectPins.set(key, (openObjectPins.get(key) ?? 0) + 1);
}

function releasePin(kind, sha256) {
	const key = pinKey(kind, sha256);
	const count = openObjectPins.get(key) ?? 0;
	if (count <= 1) openObjectPins.delete(key);
	else openObjectPins.set(key, count - 1);
}

// ── 暂存 ─────────────────────────────────────────────────────────────────────

/**
 * 把一个源文件放进暂存区：carrier 源优先硬链接（源永不移动/改写），
 * 不支持/跨文件系统/权限受限时回退复制；manual 源一律复制成独立 inode。
 */
function placeStagedFile({ source, dest, carrier, linkFile = linkSync, copyFile = copyFileSync }) {
	let real;
	try {
		real = realpathSync(source);
	} catch {
		return failed(CARRIER_STATUS.NOT_READY, "source-missing");
	}
	let stat;
	try {
		stat = statSync(real);
	} catch {
		return failed(CARRIER_STATUS.NOT_READY, "source-missing");
	}
	if (!stat.isFile()) return failed(CARRIER_STATUS.MISMATCH, "source-not-a-regular-file");
	let mode = "copy";
	if (carrier) {
		try {
			linkFile(real, dest);
			return { ok: true, mode: "link" };
		} catch (error) {
			if (!LINK_FALLBACK_CODES.has(error?.code)) {
				return failed(CARRIER_STATUS.UNUSABLE, "link-failed", { detail: error?.code ?? String(error) });
			}
			// 跨文件系统 / 不支持 / 权限受限 → 回退复制（绝不移动载体原件）
		}
	}
	let copyResult;
	try {
		copyResult = copyFile(real, dest);
	} catch (error) {
		return failed(CARRIER_STATUS.UNUSABLE, "copy-failed", { detail: error?.code ?? String(error) });
	}
	if (copyResult && copyResult.ok === false) {
		return failed(CARRIER_STATUS.UNUSABLE, "copy-failed", { detail: copyResult.error ?? "copy-rejected" });
	}
	mode = "copy";
	// 复制出来的托管对象是独立 inode，可以安全置只读；硬链接绝不能 chmod（会改到载体原件）。
	try {
		chmodSync(dest, 0o444);
	} catch {
		// 置只读失败不改变正确性：对象仍按不可变约定使用
	}
	return { ok: true, mode };
}

/** 尽最大努力删掉暂存目录（只删本 module 认识的条目，未知文件留下）。 */
function cleanupStagingDir(dir) {
	for (const name of [OBJECT_NAMES.apk, OBJECT_NAMES.plugin, "staged.json"]) {
		try {
			rmSync(join(dir, name), { force: true });
		} catch {
			// 忽略
		}
	}
	for (const name of listFiles(dir).filter((entry) => /\.tmp$/.test(entry))) {
		try {
			rmSync(join(dir, name), { force: true });
		} catch {
			// 忽略
		}
	}
	try {
		rmdirSync(dir);
	} catch {
		// 非空（含未知文件）就留着，交给人工/诊断
	}
}

/** 暂存目录是否只包含本 module 认识的条目（GC 删除前的校验）。 */
function stagingDirIsOurs(dir) {
	for (const name of listDir(dir).map((entry) => entry.name)) {
		if (!STAGING_ENTRY_PATTERN.test(name)) return false;
	}
	return true;
}

/**
 * 校验清单并把两段产物放入暂存区（**不发布**，因此不可能被服务）。
 *
 * @param {object} input
 * @param {string} input.updateDir 生效更新目录
 * @param {object} input.manifest 完整发布清单（schema 1）
 * @param {string} input.appPath  已核验 APK 源路径
 * @param {string} [input.pluginPath] 本地插件 tgz 源路径（可选；没有时该对象不导入）
 * @param {"carrier"|"manual"} [input.source="manual"] carrier 可硬链接；manual 必复制
 * @param {number} [input.now] 时间注入（测试用）
 * @param {Function} [input.linkFile] 硬链接实现注入（测试模拟 EXDEV）
 * @param {Function} [input.copyFile] 复制实现注入
 */
export function stageRelease({
	updateDir,
	manifest,
	appPath,
	pluginPath = "",
	source = "manual",
	now = Date.now(),
	linkFile,
	copyFile,
} = {}) {
	try {
		if (source !== "carrier" && source !== "manual") return failed(CARRIER_STATUS.INVALID, "source-kind-invalid");
		const identityResult = releaseIdentityFromManifest(manifest);
		if (!identityResult.ok) return identityResult;
		const { identity, releaseId } = identityResult;
		if (typeof appPath !== "string" || appPath.trim() === "") return failed(CARRIER_STATUS.MISMATCH, "app-path-missing");
		if (pluginPath !== "" && typeof pluginPath !== "string") return failed(CARRIER_STATUS.INVALID, "plugin-path-invalid");
		const store = ensureCarrierStore({ updateDir, now, create: true });
		if (!store.ok) return store;
		const paths = carrierPaths(updateDir);
		// 先按清单校验源（大小检查在前，避免大文件无谓哈希）。
		const appSource = verifyFile(appPath, identity.app);
		if (!appSource.ok) return { ...appSource, reason: `app-${appSource.reason}`, stage: "app" };
		let pluginSource = null;
		if (pluginPath) {
			pluginSource = verifyFile(pluginPath, identity.plugin);
			if (!pluginSource.ok) return { ...pluginSource, reason: `plugin-${pluginSource.reason}`, stage: "plugin" };
		}
		const stagingId = randomUUID();
		const dir = stagingDir(paths, stagingId);
		mkdirSync(dir, { recursive: true });
		try {
			const placedApp = placeStagedFile({
				source: appPath,
				dest: join(dir, OBJECT_NAMES.apk),
				carrier: source === "carrier",
				linkFile,
				copyFile,
			});
			if (!placedApp.ok) {
				cleanupStagingDir(dir);
				return { ...placedApp, stage: "app" };
			}
			// 从暂存位置复算：反制"校验后源被改写"（人工区文件可能变化）。
			const appStaged = verifyFile(join(dir, OBJECT_NAMES.apk), identity.app);
			if (!appStaged.ok) {
				cleanupStagingDir(dir);
				return { ...appStaged, reason: "staged-app-integrity-mismatch", stage: "app" };
			}
			let placedPlugin = null;
			let pluginStaged = null;
			if (pluginSource) {
				placedPlugin = placeStagedFile({
					source: pluginPath,
					dest: join(dir, OBJECT_NAMES.plugin),
					carrier: source === "carrier",
					linkFile,
					copyFile,
				});
				if (!placedPlugin.ok) {
					cleanupStagingDir(dir);
					return { ...placedPlugin, stage: "plugin" };
				}
				pluginStaged = verifyFile(join(dir, OBJECT_NAMES.plugin), identity.plugin);
				if (!pluginStaged.ok) {
					cleanupStagingDir(dir);
					return { ...pluginStaged, reason: "staged-plugin-integrity-mismatch", stage: "plugin" };
				}
			}
			const staged = {
				schema: 1,
				stagingId,
				createdAt: nowIso(now),
				createdAtMs: now,
				releaseId,
				identity,
				source,
				manifest,
				app: { sha256: identity.app.sha256, size: identity.app.size, mode: placedApp.mode },
				plugin: pluginStaged
					? { sha256: identity.plugin.sha256, size: identity.plugin.size, mode: placedPlugin.mode }
					: null,
			};
			// staged.json 最后写：它存在才算"暂存完整"；进程中断只留不可服务的残片。
			atomicWriteJson(join(dir, "staged.json"), staged);
			return {
				ok: true,
				status: CARRIER_STATUS.STAGED,
				stagingId,
				releaseId,
				identity,
				source,
				app: staged.app,
				plugin: staged.plugin,
				stagingDir: dir,
			};
		} catch (error) {
			cleanupStagingDir(dir);
			return failed(CARRIER_STATUS.UNUSABLE, "staging-failed", { detail: String(error?.message ?? error) });
		}
	} catch (error) {
		return failed(CARRIER_STATUS.UNUSABLE, "internal-error", { detail: String(error?.message ?? error) });
	}
}

/** 读一个已完成暂存的元数据（诊断/测试用；不发布）。 */
export function readStagedRelease({ updateDir, stagingId } = {}) {
	try {
		const paths = carrierPaths(updateDir);
		if (!paths) return failed(CARRIER_STATUS.UNUSABLE, "update-dir-missing");
		if (typeof stagingId !== "string" || !STAGING_ID.test(stagingId)) {
			return failed(CARRIER_STATUS.INVALID, "staging-id-invalid");
		}
		const staged = readJson(join(stagingDir(paths, stagingId), "staged.json"));
		if (!staged || staged.stagingId !== stagingId || !HEX64.test(staged.releaseId ?? "")) {
			return failed(CARRIER_STATUS.NOT_READY, "staging-unknown");
		}
		return ready({ staging: staged });
	} catch (error) {
		return failed(CARRIER_STATUS.UNUSABLE, "internal-error", { detail: String(error?.message ?? error) });
	}
}

/** 丢弃一个暂存（幂等；只动 staging/ 下的目录）。 */
export function discardStagedRelease({ updateDir, stagingId, now = Date.now(), lockToken = "" } = {}) {
	try {
		const paths = carrierPaths(updateDir);
		if (!paths) return failed(CARRIER_STATUS.UNUSABLE, "update-dir-missing");
		if (typeof stagingId !== "string" || !STAGING_ID.test(stagingId)) {
			return failed(CARRIER_STATUS.INVALID, "staging-id-invalid");
		}
		return runLocked({ updateDir, now, lockToken }, (locked) => {
			const dir = stagingDir(locked, stagingId);
			if (!existsSync(dir)) return ready({ discarded: false });
			if (!stagingDirIsOurs(dir)) return failed(CARRIER_STATUS.UNUSABLE, "staging-foreign-entries", { stagingId });
			cleanupStagingDir(dir);
			return ready({ discarded: true });
		});
	} catch (error) {
		return failed(CARRIER_STATUS.UNUSABLE, "internal-error", { detail: String(error?.message ?? error) });
	}
}

// ── 提交锁 ───────────────────────────────────────────────────────────────────

/**
 * 取提交锁：`<root>/commit.lock`（mkdir 原子独占）。忙时立即返回 busy，不阻塞等待；
 * 持有者进程已死（或锁目录无 owner 且超过 staleMs）时回收一次。
 * 持锁期间只做同步文件系统操作——绝不等待网络、子进程或宿主重启。
 */
function acquireCommitLock(paths, { now, staleMs }) {
	const lockDir = paths.commitLock;
	const token = randomUUID();
	const write = () => {
		mkdirSync(lockDir);
		atomicWriteJson(join(lockDir, "owner.json"), {
			schema: 1,
			token,
			pid: process.pid,
			startedAt: nowIso(now),
			startedAtMs: now,
		});
		return { ok: true, token };
	};
	try {
		return write();
	} catch (error) {
		if (error?.code !== "EEXIST") {
			return failed(CARRIER_STATUS.UNUSABLE, "commit-lock-unavailable", { detail: error?.code ?? String(error) });
		}
	}
	const owner = readJson(join(lockDir, "owner.json"));
	let reclaimable;
	if (owner && Number.isInteger(owner.pid)) {
		reclaimable = !pidAlive(owner.pid);
	} else {
		let age = Infinity;
		try {
			age = now - lstatSync(lockDir).mtimeMs;
		} catch {
			age = Infinity;
		}
		reclaimable = age >= staleMs;
	}
	if (!reclaimable) {
		return failed(CARRIER_STATUS.BUSY, "commit-lock-busy", {
			holder: owner ? { pid: owner.pid ?? null, startedAt: owner.startedAt ?? null } : null,
		});
	}
	try {
		rmSync(lockDir, { recursive: true, force: true });
	} catch {
		// 回收失败则下面重试会再报 busy
	}
	try {
		return write();
	} catch (error) {
		return failed(CARRIER_STATUS.BUSY, "commit-lock-busy", { detail: error?.code ?? String(error) });
	}
}

function releaseCommitLock(paths, token) {
	const owner = readJson(join(paths.commitLock, "owner.json"));
	if (!owner || owner.token !== token) return false; // 已被回收/接管：不要删别人的锁
	try {
		rmSync(join(paths.commitLock, "owner.json"), { force: true });
		rmdirSync(paths.commitLock);
		return true;
	} catch {
		return false;
	}
}

/**
 * 在托管区提交锁内执行同步回调（供上层按"更新租约 → 提交锁"的固定顺序包住一组写操作）。
 * - 回调必须同步；返回 Promise 会被拒绝（否则锁会在异步期间被误释放）。
 * - 忙时返回 `{ ok:false, status:"busy", reason:"commit-lock-busy" }`，不排队等待。
 * - 传 `lockToken` 表示重入（用于已持锁时调用 publish/lease 等接口）。
 */
export function withCarrierCommitLock(
	{ updateDir, now = Date.now(), staleMs = DEFAULT_COMMIT_LOCK_STALE_MS, lockToken = "" } = {},
	callback,
) {
	if (typeof callback !== "function") return failed(CARRIER_STATUS.INVALID, "commit-lock-callback-missing");
	try {
		const paths = carrierPaths(updateDir);
		if (!paths) return failed(CARRIER_STATUS.UNUSABLE, "update-dir-missing");
		const ensured = ensureCarrierStore({ updateDir, now, create: true });
		if (!ensured.ok) return ensured;
		const held = heldCommitLocks.get(paths.root);
		if (lockToken) {
			if (!held || held.token !== lockToken) return failed(CARRIER_STATUS.BUSY, "commit-lock-token-invalid");
			held.depth += 1;
			try {
				return callback(lockToken);
			} finally {
				held.depth -= 1;
			}
		}
		const acquired = acquireCommitLock(paths, { now, staleMs });
		if (!acquired.ok) return acquired;
		heldCommitLocks.set(paths.root, { token: acquired.token, depth: 1 });
		let result;
		try {
			result = callback(acquired.token);
			if (result && typeof result.then === "function") {
				result.catch?.(() => {}); // 误用异步回调：不让它的拒绝变成未处理异常
				throw new Error("commit-lock-callback-must-be-synchronous");
			}
			return result;
		} finally {
			heldCommitLocks.delete(paths.root);
			releaseCommitLock(paths, acquired.token);
		}
	} catch (error) {
		return failed(CARRIER_STATUS.UNUSABLE, "commit-lock-failed", { detail: String(error?.message ?? error) });
	}
}

/** 提交锁诊断：当前持有者或 null（不创建任何东西）。 */
export function readCommitLock({ updateDir } = {}) {
	try {
		const paths = carrierPaths(updateDir);
		if (!paths) return failed(CARRIER_STATUS.UNUSABLE, "update-dir-missing");
		const inspected = inspectOwnership(paths);
		if (!inspected.ok) return inspected;
		const owner = readJson(join(paths.commitLock, "owner.json"));
		return { ok: true, locked: !!owner, holder: owner ?? null };
	} catch (error) {
		return failed(CARRIER_STATUS.UNUSABLE, "internal-error", { detail: String(error?.message ?? error) });
	}
}

/** 内部：在提交锁内运行（可重入）。回调接收已校验/已创建的布局 paths。 */
function runLocked({ updateDir, now = Date.now(), lockToken = "", staleMs = DEFAULT_COMMIT_LOCK_STALE_MS, create = true }, callback) {
	const paths = carrierPaths(updateDir);
	if (!paths) return failed(CARRIER_STATUS.UNUSABLE, "update-dir-missing");
	const ensured = create ? ensureCarrierStore({ updateDir, now, create: true }) : inspectOwnership(paths);
	if (!ensured.ok) return ensured;
	const held = heldCommitLocks.get(paths.root);
	if (lockToken) {
		if (!held || held.token !== lockToken) return failed(CARRIER_STATUS.BUSY, "commit-lock-token-invalid");
		held.depth += 1;
		try {
			return callback(paths);
		} finally {
			held.depth -= 1;
		}
	}
	const acquired = acquireCommitLock(paths, { now, staleMs });
	if (!acquired.ok) return acquired;
	heldCommitLocks.set(paths.root, { token: acquired.token, depth: 1 });
	try {
		return callback(paths);
	} finally {
		heldCommitLocks.delete(paths.root);
		releaseCommitLock(paths, acquired.token);
	}
}

// ── profile 指针 ─────────────────────────────────────────────────────────────

function validProfileKey(profileKey) {
	if (typeof profileKey !== "string" || profileKey.trim() === "") {
		return failed(CARRIER_STATUS.UNUSABLE, "profile-unknown");
	}
	if (!PROFILE_KEY.test(profileKey)) return failed(CARRIER_STATUS.UNUSABLE, "profile-key-invalid");
	return { ok: true, profileKey };
}

function readPointer(paths, profileKey) {
	const pointer = readJson(pointerPath(paths, profileKey));
	if (!pointer || pointer.schema !== 1 || typeof pointer.current?.releaseId !== "string") return null;
	return pointer;
}

/** 读某个 profile 的当前/被替代指针（诊断与测试用）。 */
export function readProfilePointer({ updateDir, profileKey } = {}) {
	try {
		const paths = carrierPaths(updateDir);
		if (!paths) return failed(CARRIER_STATUS.UNUSABLE, "update-dir-missing");
		const inspected = inspectOwnership(paths);
		if (!inspected.ok) return inspected;
		const key = validProfileKey(profileKey);
		if (!key.ok) return key;
		const pointer = readPointer(paths, key.profileKey);
		if (!pointer) return failed(CARRIER_STATUS.NOT_READY, "no-current-release", { profileKey: key.profileKey });
		return ready({ profileKey: key.profileKey, pointer });
	} catch (error) {
		return failed(CARRIER_STATUS.UNUSABLE, "internal-error", { detail: String(error?.message ?? error) });
	}
}

/**
 * 提交本 profile 的当前指针（锁内调用）。规则：
 *   - 与当前相同 → 幂等，不重写（重复调用不重置保留时钟）；
 *   - 换掉旧 current → 旧 release 进入本 profile 的 superseded，窗口从**真实替代时刻**起算；
 *   - 重新选回某个 superseded → 移出 superseded（下次再被替代是新周期，重新起算）。
 */
function commitProfilePointer(paths, profileKey, { releaseId, identity, profileDir: profileDirValue, now, retentionMs }) {
	const previous = readPointer(paths, profileKey);
	if (previous && previous.current?.releaseId === releaseId) {
		return { ok: true, changed: false, pointer: previous };
	}
	const superseded = Array.isArray(previous?.superseded)
		? previous.superseded.filter((entry) => entry && entry.releaseId !== releaseId)
		: [];
	const inheritedProfileDir = typeof previous?.profileDir === "string" ? previous.profileDir : null;
	if (previous?.current?.releaseId && previous.current.releaseId !== releaseId) {
		superseded.push({
			releaseId: previous.current.releaseId,
			supersededAt: nowIso(now),
			retainUntil: nowIso(now + retentionMs),
			identity: previous.current.identity ?? null,
		});
	}
	const pointer = {
		schema: 1,
		profileKey,
		profileDir: typeof profileDirValue === "string" && profileDirValue !== "" ? profileDirValue : inheritedProfileDir,
		current: { releaseId, selectedAt: nowIso(now), identity },
		superseded,
		updatedAt: nowIso(now),
	};
	atomicWriteJson(pointerPath(paths, profileKey), pointer);
	return { ok: true, changed: true, pointer };
}

// ── 对象与 release 记录发布 ───────────────────────────────────────────────────

/** 发布暂存文件为不可变对象：目标已存在则只允许"同哈希复用"，绝不原地覆盖。 */
function publishObject({ paths, kind, expected, stagedFile }) {
	const target = objectPath(paths, kind, expected.sha256);
	if (existsSync(target)) {
		const existing = verifyFile(target, expected);
		if (!existing.ok) {
			return failed(CARRIER_STATUS.MISMATCH, "object-integrity-mismatch", {
				kind,
				sha256: expected.sha256,
				actualHash: existing.actual ?? null,
			});
		}
		return { ok: true, kind, path: target, reused: true, sha256: expected.sha256 };
	}
	try {
		mkdirSync(dirname(target), { recursive: true });
	} catch (error) {
		return failed(CARRIER_STATUS.UNUSABLE, "object-publish-failed", { kind, detail: error?.code ?? String(error) });
	}
	try {
		// 同一托管区内的 rename 是原子的：要么没有对象，要么是完整对象。
		renameSync(stagedFile, target);
		fsyncDir(dirname(target));
	} catch (error) {
		return failed(CARRIER_STATUS.UNUSABLE, "object-publish-failed", { kind, detail: error?.code ?? String(error) });
	}
	const published = verifyFile(target, expected, { hash: false });
	if (!published.ok) {
		return failed(CARRIER_STATUS.MISMATCH, "object-integrity-mismatch", { kind, sha256: expected.sha256 });
	}
	return { ok: true, kind, path: target, reused: false, sha256: expected.sha256 };
}

/** 原子发布 release 记录（整目录 rename）；同一身份已存在时复用，不覆盖。 */
function publishReleaseRecord({ paths, releaseId, identity, manifest, objects, now }) {
	const dir = releaseDir(paths, releaseId);
	const existing = readJson(join(dir, "release.json"));
	if (existing) {
		const sameIdentity = JSON.stringify(existing.identity ?? null) === JSON.stringify(identity);
		if (existing.releaseId !== releaseId || !sameIdentity) {
			return failed(CARRIER_STATUS.MISMATCH, "release-record-conflict", { releaseId });
		}
		return { ok: true, reused: true, record: existing, dir };
	}
	if (existsSync(dir)) {
		// 只可能是旧墓碑（或崩溃残片）；含未知条目时绝不删除。
		const foreign = listDir(dir).map((entry) => entry.name).filter((name) => name !== "tombstone.json");
		if (foreign.length > 0) return failed(CARRIER_STATUS.MISMATCH, "release-dir-conflict", { releaseId, entries: foreign });
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch (error) {
			return failed(CARRIER_STATUS.UNUSABLE, "release-record-publish-failed", { releaseId, detail: error?.code ?? String(error) });
		}
	}
	const record = {
		schema: 1,
		releaseId,
		identity,
		objects,
		publishedAt: nowIso(now),
		manifest,
	};
	const tmp = join(paths.releases, `${RELEASE_TMP_PREFIX}${randomUUID()}`);
	try {
		mkdirSync(tmp, { recursive: true });
		atomicWriteJson(join(tmp, "release.json"), record);
		writeFileSync(join(tmp, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
		renameSync(tmp, dir);
		fsyncDir(paths.releases);
	} catch (error) {
		rmSync(tmp, { recursive: true, force: true });
		return failed(CARRIER_STATUS.UNUSABLE, "release-record-publish-failed", { releaseId, detail: error?.code ?? String(error) });
	}
	return { ok: true, reused: false, record, dir };
}

// ── 事务租约 ─────────────────────────────────────────────────────────────────

const TERMINAL_PHASE_SET = new Set(TERMINAL_LEASE_PHASES);

function readLease(paths, leaseId) {
	const lease = readJson(leasePath(paths, leaseId));
	if (!lease || lease.schema !== 1 || lease.leaseId !== leaseId) return null;
	return lease;
}

function validateKnownReleases(paths, releaseIds) {
	for (const releaseId of releaseIds) {
		if (!HEX64.test(releaseId ?? "")) return failed(CARRIER_STATUS.INVALID, "release-id-invalid", { releaseId });
		const record = readJson(join(releaseDir(paths, releaseId), "release.json"));
		if (record) continue;
		if (existsSync(join(releaseDir(paths, releaseId), "tombstone.json"))) {
			return failed(CARRIER_STATUS.EXPIRED, "release-expired", { releaseId });
		}
		return failed(CARRIER_STATUS.NOT_READY, "release-unknown", { releaseId });
	}
	return { ok: true };
}

function normalizeReleaseIdList(releaseIds) {
	if (!Array.isArray(releaseIds) || releaseIds.length === 0) return failed(CARRIER_STATUS.INVALID, "release-ids-invalid");
	const unique = [...new Set(releaseIds)];
	if (unique.length > 64) return failed(CARRIER_STATUS.INVALID, "release-ids-too-many");
	return { ok: true, releaseIds: unique };
}

function normalizeGeneration(generation) {
	if (typeof generation !== "string" || generation.trim() === "" || generation.length > 128) {
		return failed(CARRIER_STATUS.INVALID, "lease-generation-missing");
	}
	return { ok: true, generation: generation.trim() };
}

/** 提交指针/引用前校验上层更新租约（固定顺序：更新租约 → 提交锁，本函数在锁内调用）。 */
function validateUpdateLease(paths, lease) {
	if (!lease || typeof lease !== "object") return failed(CARRIER_STATUS.INVALID, "lease-invalid");
	const generation = normalizeGeneration(lease.generation);
	if (!generation.ok) return generation;
	if (lease.phase && TERMINAL_PHASE_SET.has(lease.phase)) {
		return failed(CARRIER_STATUS.UNUSABLE, "lease-terminal", { phase: lease.phase });
	}
	if (lease.leaseId !== undefined) {
		if (typeof lease.leaseId !== "string" || !LEASE_ID.test(lease.leaseId)) {
			return failed(CARRIER_STATUS.INVALID, "lease-id-invalid");
		}
		const stored = readLease(paths, lease.leaseId);
		if (!stored) return failed(CARRIER_STATUS.UNUSABLE, "carrier-lease-lost", { leaseId: lease.leaseId });
		if (stored.generation !== generation.generation) {
			return failed(CARRIER_STATUS.UNUSABLE, "carrier-lease-lost", { leaseId: lease.leaseId });
		}
		if (TERMINAL_PHASE_SET.has(stored.phase)) {
			return failed(CARRIER_STATUS.UNUSABLE, "carrier-lease-terminal", { leaseId: lease.leaseId, phase: stored.phase });
		}
	}
	return { ok: true, lease: { generation: generation.generation, phase: lease.phase ?? null, leaseId: lease.leaseId ?? null } };
}

/**
 * 声明一条与事务代际绑定的持久引用（受理更新前调用）：引用期间 GC 不回收目标。
 * 返回的 lease 供上层记录进事务状态；终态时调用 `releaseReleaseLease` 释放引用。
 */
export function claimReleaseLease({
	updateDir,
	profileKey,
	releaseIds,
	generation,
	opId = "",
	phase = "claimed",
	leaseId = randomUUID(),
	now = Date.now(),
	ttlMs = DEFAULT_LEASE_TTL_MS,
	lockToken = "",
} = {}) {
	try {
		const key = validProfileKey(profileKey);
		if (!key.ok) return key;
		const gen = normalizeGeneration(generation);
		if (!gen.ok) return gen;
		const ids = normalizeReleaseIdList(releaseIds);
		if (!ids.ok) return ids;
		if (typeof leaseId !== "string" || !LEASE_ID.test(leaseId)) return failed(CARRIER_STATUS.INVALID, "lease-id-invalid");
		if (typeof phase !== "string" || phase === "" || TERMINAL_PHASE_SET.has(phase)) {
			return failed(CARRIER_STATUS.INVALID, "lease-phase-invalid");
		}
		return runLocked({ updateDir, now, lockToken }, (paths) => {
			const known = validateKnownReleases(paths, ids.releaseIds);
			if (!known.ok) return known;
			const existing = readLease(paths, leaseId);
			if (existing && existing.generation !== gen.generation) {
				return failed(CARRIER_STATUS.UNUSABLE, "carrier-lease-lost", { leaseId });
			}
			const lease = {
				schema: 1,
				leaseId,
				profileKey: key.profileKey,
				opId: typeof opId === "string" ? opId : "",
				generation: gen.generation,
				phase,
				releaseIds: ids.releaseIds,
				claimedAt: existing?.claimedAt ?? nowIso(now),
				heartbeatAt: nowIso(now),
				ttlMs: Number.isSafeInteger(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_LEASE_TTL_MS,
				updatedAt: nowIso(now),
			};
			atomicWriteJson(leasePath(paths, leaseId), lease);
			return ready({ lease });
		});
	} catch (error) {
		return failed(CARRIER_STATUS.UNUSABLE, "internal-error", { detail: String(error?.message ?? error) });
	}
}

/** 更新租约心跳/阶段/引用集合；代际不匹配或已终态时拒绝（陈旧写者不能提交引用）。 */
export function updateReleaseLease({ updateDir, leaseId, generation, phase, releaseIds, now = Date.now(), lockToken = "" } = {}) {
	try {
		if (typeof leaseId !== "string" || !LEASE_ID.test(leaseId)) return failed(CARRIER_STATUS.INVALID, "lease-id-invalid");
		const gen = normalizeGeneration(generation);
		if (!gen.ok) return gen;
		if (typeof phase !== "string" || phase === "" || TERMINAL_PHASE_SET.has(phase)) {
			return failed(CARRIER_STATUS.INVALID, "lease-phase-invalid");
		}
		return runLocked({ updateDir, now, lockToken }, (paths) => {
			const stored = readLease(paths, leaseId);
			if (!stored) return failed(CARRIER_STATUS.NOT_READY, "lease-unknown", { leaseId });
			if (stored.generation !== gen.generation) return failed(CARRIER_STATUS.UNUSABLE, "carrier-lease-lost", { leaseId });
			if (TERMINAL_PHASE_SET.has(stored.phase)) {
				return failed(CARRIER_STATUS.UNUSABLE, "carrier-lease-terminal", { leaseId, phase: stored.phase });
			}
			let nextReleaseIds = stored.releaseIds;
			if (releaseIds !== undefined) {
				const ids = normalizeReleaseIdList(releaseIds);
				if (!ids.ok) return ids;
				const known = validateKnownReleases(paths, ids.releaseIds);
				if (!known.ok) return known;
				nextReleaseIds = ids.releaseIds;
			}
			const lease = { ...stored, phase, releaseIds: nextReleaseIds, heartbeatAt: nowIso(now), updatedAt: nowIso(now) };
			atomicWriteJson(leasePath(paths, leaseId), lease);
			return ready({ lease });
		});
	} catch (error) {
		return failed(CARRIER_STATUS.UNUSABLE, "internal-error", { detail: String(error?.message ?? error) });
	}
}

/**
 * 终态释放事务引用（终态阶段必须显式给出）。释放引用会为"从未成为当前发布"的候选
 * 记录一个从此刻起算的保留窗口；**重复调用不重置/不缩短**已承诺的窗口。
 */
export function releaseReleaseLease({
	updateDir,
	leaseId,
	generation,
	phase = "settled",
	now = Date.now(),
	retentionMs = DEFAULT_RETENTION_MS,
	lockToken = "",
} = {}) {
	try {
		if (typeof leaseId !== "string" || !LEASE_ID.test(leaseId)) return failed(CARRIER_STATUS.INVALID, "lease-id-invalid");
		const gen = normalizeGeneration(generation);
		if (!gen.ok) return gen;
		if (typeof phase !== "string" || !TERMINAL_PHASE_SET.has(phase)) {
			return failed(CARRIER_STATUS.INVALID, "lease-phase-invalid");
		}
		return runLocked({ updateDir, now, lockToken }, (paths) => {
			const stored = readLease(paths, leaseId);
			if (!stored) return failed(CARRIER_STATUS.NOT_READY, "lease-unknown", { leaseId });
			if (stored.generation !== gen.generation) return failed(CARRIER_STATUS.UNUSABLE, "carrier-lease-lost", { leaseId });
			if (TERMINAL_PHASE_SET.has(stored.phase)) {
				// 重复调用：不延长、不缩短已经承诺的窗口。
				return ready({ lease: stored, changed: false, retention: [] });
			}
			const lease = { ...stored, phase, terminalAt: nowIso(now), updatedAt: nowIso(now) };
			const ledger = readRetention(paths);
			const promised = promisedWindowIds(paths);
			const retention = [];
			for (const releaseId of stored.releaseIds ?? []) {
				if (promised.has(releaseId)) continue; // 已有承诺窗口（当前/被替代）：不重算、不缩短
				if (extendCandidateRetention(ledger, releaseId, now + retentionMs, { now, reason: `lease-${phase}`, profileKey: stored.profileKey })) {
					retention.push({ releaseId, retainUntil: nowIso(now + retentionMs) });
				}
			}
			// 先落保留窗口、再标记终态：中途崩溃也不会让候选失去承诺的窗口。
			writeRetention(paths, ledger);
			atomicWriteJson(leasePath(paths, leaseId), lease);
			return ready({ lease, changed: true, retention });
		});
	} catch (error) {
		return failed(CARRIER_STATUS.UNUSABLE, "internal-error", { detail: String(error?.message ?? error) });
	}
}

/** 读租约（诊断/测试用）。 */
export function readReleaseLease({ updateDir, leaseId } = {}) {
	try {
		const paths = carrierPaths(updateDir);
		if (!paths) return failed(CARRIER_STATUS.UNUSABLE, "update-dir-missing");
		const inspected = inspectOwnership(paths);
		if (!inspected.ok) return inspected;
		if (typeof leaseId !== "string" || !LEASE_ID.test(leaseId)) return failed(CARRIER_STATUS.INVALID, "lease-id-invalid");
		const lease = readLease(paths, leaseId);
		if (!lease) return failed(CARRIER_STATUS.NOT_READY, "lease-unknown", { leaseId });
		return ready({ lease });
	} catch (error) {
		return failed(CARRIER_STATUS.UNUSABLE, "internal-error", { detail: String(error?.message ?? error) });
	}
}

// ── 发布（提交协议） ─────────────────────────────────────────────────────────

/**
 * 把已校验的暂存提交为一次发布：发布不可变对象 → 发布 release 记录 → 最后原子更新
 * 本 profile 的 current 指针。全程在一把提交锁内；任一步失败都不产生可服务半成品。
 *
 * @param {object} input
 * @param {string} input.updateDir
 * @param {string} input.stagingId 由 `stageRelease` 返回
 * @param {string} input.profileKey 已验证的当前 profile 身份（缺失/非法 → 不猜，返回不可用）
 * @param {string} [input.profileDir] profile 目录（GC 存活性核对用；建议传绝对路径）
 * @param {object} [input.lease] 上层更新租约 { generation, phase, leaseId? }；
 *   终态/代际不符的写者不能提交指针（固定顺序"更新租约 → 提交锁"）
 * @param {string} [input.lockToken] 已持锁时传入（重入）
 * @param {boolean} [input.requireLease] 为 true 时必须有 lease
 * @param {boolean} [input.select=true] 为 false 时只发布 release 记录（更新目标候选），
 *   不切换 current；候选由租约保护，健康确认后再用 `selectRelease` 切换。
 * @param {number} [input.retentionMs] 被替代后的保留窗口（默认 24h）
 */
export function publishStagedRelease({
	updateDir,
	stagingId,
	profileKey,
	profileDir: profileDirValue = "",
	lease,
	lockToken = "",
	requireLease = false,
	select = true,
	now = Date.now(),
	retentionMs = DEFAULT_RETENTION_MS,
} = {}) {
	try {
		const paths = carrierPaths(updateDir);
		if (!paths) return failed(CARRIER_STATUS.UNUSABLE, "update-dir-missing");
		const key = validProfileKey(profileKey);
		if (!key.ok) return key;
		if (typeof stagingId !== "string" || !STAGING_ID.test(stagingId)) return failed(CARRIER_STATUS.INVALID, "staging-id-invalid");
		if (profileDirValue !== "" && (typeof profileDirValue !== "string" || !isAbsolute(profileDirValue))) {
			return failed(CARRIER_STATUS.INVALID, "profile-dir-invalid");
		}
		if (lease === undefined || lease === null) {
			if (requireLease) return failed(CARRIER_STATUS.UNUSABLE, "lease-required");
		}
		return runLocked({ updateDir, now, lockToken }, (locked) => {
			if (lease !== undefined && lease !== null) {
				const leaseCheck = validateUpdateLease(locked, lease);
				if (!leaseCheck.ok) return leaseCheck;
			}
			const dir = stagingDir(locked, stagingId);
			const staged = readJson(join(dir, "staged.json"));
			if (!staged || staged.stagingId !== stagingId || !HEX64.test(staged.releaseId ?? "")) {
				return failed(CARRIER_STATUS.NOT_READY, "staging-unknown", { stagingId });
			}
			const identity = staged.identity;
			// 提交前再核暂存完整性（暂存可能被外部破坏；不合格就绝不进入发布）。
			const appCheck = verifyFile(join(dir, OBJECT_NAMES.apk), identity.app);
			if (!appCheck.ok) {
				return failed(CARRIER_STATUS.MISMATCH, "staging-integrity-mismatch", { stage: "app", detail: appCheck.reason });
			}
			let pluginCheck = null;
			if (staged.plugin) {
				pluginCheck = verifyFile(join(dir, OBJECT_NAMES.plugin), identity.plugin);
				if (!pluginCheck.ok) {
					return failed(CARRIER_STATUS.MISMATCH, "staging-integrity-mismatch", { stage: "plugin", detail: pluginCheck.reason });
				}
			}
			const appObject = publishObject({ paths: locked, kind: "apk", expected: identity.app, stagedFile: join(dir, OBJECT_NAMES.apk) });
			if (!appObject.ok) return appObject;
			let pluginObject = null;
			if (staged.plugin) {
				pluginObject = publishObject({ paths: locked, kind: "plugin", expected: identity.plugin, stagedFile: join(dir, OBJECT_NAMES.plugin) });
				if (!pluginObject.ok) return pluginObject;
			}
			const objects = {
				apk: { sha256: identity.app.sha256, size: identity.app.size, file: OBJECT_NAMES.apk, present: true },
				plugin: pluginObject
					? { sha256: identity.plugin.sha256, size: identity.plugin.size, file: OBJECT_NAMES.plugin, present: true }
					: { sha256: identity.plugin.sha256, size: identity.plugin.size, file: OBJECT_NAMES.plugin, present: false },
			};
			const record = publishReleaseRecord({
				paths: locked,
				releaseId: staged.releaseId,
				identity,
				manifest: staged.manifest,
				objects,
				now,
			});
			if (!record.ok) return record;
			let pointer = { ok: true, changed: false, pointer: readPointer(locked, key.profileKey) };
			if (select) {
				pointer = commitProfilePointer(locked, key.profileKey, {
					releaseId: staged.releaseId,
					identity,
					profileDir: profileDirValue,
					now,
					retentionMs,
				});
				if (!pointer.ok) return pointer;
			}
			cleanupStagingDir(dir);
			return ready({
				releaseId: staged.releaseId,
				identity,
				profileKey: key.profileKey,
				selected: select,
				changed: pointer.changed,
				pointer: pointer.pointer,
				objects,
				reuse: { releaseRecord: record.reused, appObject: appObject.reused, pluginObject: pluginObject?.reused ?? null },
			});
		});
	} catch (error) {
		return failed(CARRIER_STATUS.UNUSABLE, "internal-error", { detail: String(error?.message ?? error) });
	}
}

/** 一步完成"暂存 → 校验 → 提交"（失败时清理暂存，不留可服务半成品）。 */
export function publishRelease(input = {}) {
	const staged = stageRelease(input);
	if (!staged.ok) return staged;
	const published = publishStagedRelease({ ...input, stagingId: staged.stagingId });
	if (!published.ok) {
		discardStagedRelease({ updateDir: input.updateDir, stagingId: staged.stagingId, now: input.now });
		return published;
	}
	return { ...published, staging: { stagingId: staged.stagingId, source: staged.source, app: staged.app, plugin: staged.plugin } };
}

/**
 * 把一个已发布的 release 选为某 profile 的当前发布（健康确认后 / 回滚重选时用）。
 * 必须验证 release 记录与 APK 对象都在（当前入口不能指向缺失对象），指针最后原子更新。
 */
export function selectRelease({
	updateDir,
	profileKey,
	releaseId,
	profileDir: profileDirValue = "",
	lease,
	lockToken = "",
	requireLease = false,
	now = Date.now(),
	retentionMs = DEFAULT_RETENTION_MS,
} = {}) {
	try {
		const paths = carrierPaths(updateDir);
		if (!paths) return failed(CARRIER_STATUS.UNUSABLE, "update-dir-missing");
		const key = validProfileKey(profileKey);
		if (!key.ok) return key;
		if (typeof releaseId !== "string" || !HEX64.test(releaseId)) return failed(CARRIER_STATUS.INVALID, "release-id-invalid");
		if (profileDirValue !== "" && (typeof profileDirValue !== "string" || !isAbsolute(profileDirValue))) {
			return failed(CARRIER_STATUS.INVALID, "profile-dir-invalid");
		}
		if ((lease === undefined || lease === null) && requireLease) return failed(CARRIER_STATUS.UNUSABLE, "lease-required");
		return runLocked({ updateDir, now, lockToken }, (locked) => {
			if (lease !== undefined && lease !== null) {
				const leaseCheck = validateUpdateLease(locked, lease);
				if (!leaseCheck.ok) return leaseCheck;
			}
			const record = readJson(join(releaseDir(locked, releaseId), "release.json"));
			if (!record) {
				if (existsSync(join(releaseDir(locked, releaseId), "tombstone.json"))) {
					return failed(CARRIER_STATUS.EXPIRED, "release-expired", { releaseId });
				}
				return failed(CARRIER_STATUS.NOT_READY, "release-unknown", { releaseId });
			}
			const objectCheck = verifyFile(objectPath(locked, "apk", record.identity.app.sha256), record.identity.app, { hash: false });
			if (!objectCheck.ok) {
				return failed(CARRIER_STATUS.NOT_READY, "app-object-missing", { releaseId, detail: objectCheck.reason });
			}
			const pointer = commitProfilePointer(locked, key.profileKey, {
				releaseId,
				identity: record.identity,
				profileDir: profileDirValue,
				now,
				retentionMs,
			});
			if (!pointer.ok) return pointer;
			return ready({
				releaseId,
				identity: record.identity,
				profileKey: key.profileKey,
				changed: pointer.changed,
				pointer: pointer.pointer,
			});
		});
	} catch (error) {
		return failed(CARRIER_STATUS.UNUSABLE, "internal-error", { detail: String(error?.message ?? error) });
	}
}

// ── 读取与打开（服务面） ─────────────────────────────────────────────────────

/** 解析一个已知 release 记录（不校验对象字节）。 */
export function resolveRelease({ updateDir, releaseId } = {}) {
	try {
		const paths = carrierPaths(updateDir);
		if (!paths) return failed(CARRIER_STATUS.UNUSABLE, "update-dir-missing");
		const inspected = inspectOwnership(paths);
		if (!inspected.ok) return inspected;
		if (typeof releaseId !== "string" || !HEX64.test(releaseId)) return failed(CARRIER_STATUS.INVALID, "release-id-invalid");
		const record = readJson(join(releaseDir(paths, releaseId), "release.json"));
		if (record) {
			return ready({ releaseId, identity: record.identity, manifest: record.manifest, objects: record.objects, record });
		}
		if (existsSync(join(releaseDir(paths, releaseId), "tombstone.json"))) {
			return failed(CARRIER_STATUS.EXPIRED, "release-expired", { releaseId });
		}
		return failed(CARRIER_STATUS.NOT_READY, "release-unknown", { releaseId });
	} catch (error) {
		return failed(CARRIER_STATUS.UNUSABLE, "internal-error", { detail: String(error?.message ?? error) });
	}
}

/**
 * 解析 release 内的不可变对象：
 *   - 记录不存在 → not-ready（未知）或 expired（墓碑，对应 410）；
 *   - 记录存在但对象缺失 → not-ready（对应 503，不是 404）；
 *   - 请求的对象哈希与记录不符 → mismatch（固定目标只代表原字节）；
 *   - `verify:true` 时复算字节哈希（受控复核，不在每个请求上做）。
 */
export function resolveReleaseObject({ updateDir, releaseId, sha256, kind = "apk", verify = false } = {}) {
	try {
		if (!OBJECT_KINDS.includes(kind)) return failed(CARRIER_STATUS.INVALID, "object-kind-invalid");
		const resolved = resolveRelease({ updateDir, releaseId });
		if (!resolved.ok) return resolved;
		const expected = resolved.identity?.[kind === "apk" ? "app" : "plugin"];
		if (!expected || !HEX64.test(expected.sha256 ?? "")) {
			return failed(CARRIER_STATUS.MISMATCH, "release-identity-invalid", { releaseId });
		}
		if (sha256 !== undefined && sha256 !== null) {
			if (typeof sha256 !== "string" || !HEX64.test(sha256.trim().toLowerCase())) {
				return failed(CARRIER_STATUS.INVALID, "object-sha256-invalid");
			}
			if (sha256.trim().toLowerCase() !== expected.sha256) {
				return failed(CARRIER_STATUS.MISMATCH, "object-identity-mismatch", { releaseId, kind });
			}
		}
		const file = objectPath(carrierPaths(updateDir), kind, expected.sha256);
		if (!existsSync(file)) {
			return failed(CARRIER_STATUS.NOT_READY, kind === "plugin" ? "plugin-object-not-imported" : "object-missing", {
				releaseId,
				kind,
				sha256: expected.sha256,
			});
		}
		const checked = verifyFile(file, expected, { hash: verify });
		if (!checked.ok) {
			if (checked.reason === "size-mismatch") {
				return failed(CARRIER_STATUS.MISMATCH, "object-size-mismatch", { releaseId, kind, expectedSize: expected.size, actualSize: checked.actualSize });
			}
			if (checked.reason === "hash-mismatch") {
				return failed(CARRIER_STATUS.MISMATCH, "object-hash-mismatch", { releaseId, kind, expected: expected.sha256, actual: checked.actual });
			}
			return { ...checked, releaseId, kind };
		}
		return ready({
			releaseId,
			kind,
			path: file,
			size: expected.size,
			sha256: expected.sha256,
			identity: resolved.identity,
			manifest: resolved.manifest,
			manifestPath: join(releaseDir(carrierPaths(updateDir), releaseId), "manifest.json"),
			record: resolved.record,
		});
	} catch (error) {
		return failed(CARRIER_STATUS.UNUSABLE, "internal-error", { detail: String(error?.message ?? error) });
	}
}

/**
 * 打开一个固定目标对象。返回的句柄在 `close()` 前保护该对象不被 GC 删除；
 * 句柄本身可用于流式读取（调用方用 `path`/`size` 建流，不在这里同步读整文件）。
 */
export function openReleaseObject({ updateDir, releaseId, sha256, kind = "apk", verify = false } = {}) {
	try {
		const resolved = resolveReleaseObject({ updateDir, releaseId, sha256, kind, verify });
		if (!resolved.ok) return resolved;
		registerPin(kind, resolved.sha256);
		let closed = false;
		const handle = {
			releaseId: resolved.releaseId,
			kind: resolved.kind,
			path: resolved.path,
			size: resolved.size,
			sha256: resolved.sha256,
			identity: resolved.identity,
			manifest: resolved.manifest,
			manifestPath: resolved.manifestPath,
			close() {
				if (closed) return;
				closed = true;
				releasePin(kind, resolved.sha256);
			},
		};
		return ready({ handle });
	} catch (error) {
		return failed(CARRIER_STATUS.UNUSABLE, "internal-error", { detail: String(error?.message ?? error) });
	}
}

/** 本 profile 的当前发布（用于无参数首装入口）：指针 → release 记录 → APK 对象。 */
export function readCurrentRelease({ updateDir, profileKey, verify = false } = {}) {
	try {
		const paths = carrierPaths(updateDir);
		if (!paths) return failed(CARRIER_STATUS.UNUSABLE, "update-dir-missing");
		const inspected = inspectOwnership(paths);
		if (!inspected.ok) return inspected;
		const key = validProfileKey(profileKey);
		if (!key.ok) return key;
		const pointer = readPointer(paths, key.profileKey);
		if (!pointer) return failed(CARRIER_STATUS.NOT_READY, "no-current-release", { profileKey: key.profileKey });
		const releaseId = pointer.current.releaseId;
		const resolved = resolveRelease({ updateDir, releaseId });
		if (!resolved.ok) {
			if (resolved.status === CARRIER_STATUS.NOT_READY) {
				return failed(CARRIER_STATUS.NOT_READY, "current-release-missing", { profileKey: key.profileKey, releaseId });
			}
			if (resolved.status === CARRIER_STATUS.EXPIRED) {
				return failed(CARRIER_STATUS.EXPIRED, "current-release-expired", { profileKey: key.profileKey, releaseId });
			}
			return resolved;
		}
		const app = resolveReleaseObject({ updateDir, releaseId, sha256: resolved.identity.app.sha256, kind: "apk", verify });
		if (!app.ok) {
			if (app.status === CARRIER_STATUS.NOT_READY) {
				return failed(CARRIER_STATUS.NOT_READY, "app-object-missing", { profileKey: key.profileKey, releaseId });
			}
			return app;
		}
		const plugin = resolveReleaseObject({ updateDir, releaseId, sha256: resolved.identity.plugin.sha256, kind: "plugin", verify: false });
		return ready({
			profileKey: key.profileKey,
			releaseId,
			identity: resolved.identity,
			manifest: resolved.manifest,
			app: { path: app.path, size: app.size, sha256: app.sha256 },
			plugin: plugin.ok
				? { path: plugin.path, size: plugin.size, sha256: plugin.sha256 }
				: { available: false, reason: plugin.reason ?? "plugin-object-not-imported" },
			pointer,
		});
	} catch (error) {
		return failed(CARRIER_STATUS.UNUSABLE, "internal-error", { detail: String(error?.message ?? error) });
	}
}

/** 打开本 profile 当前发布的 APK（首装入口；句柄保护对象不被 GC 删除）。 */
export function openCurrentApp({ updateDir, profileKey, verify = false } = {}) {
	const current = readCurrentRelease({ updateDir, profileKey, verify });
	if (!current.ok) return current;
	const opened = openReleaseObject({ updateDir, releaseId: current.releaseId, sha256: current.identity.app.sha256, kind: "apk" });
	if (!opened.ok) return opened;
	return { ...opened, profileKey: current.profileKey, pointer: current.pointer, manifest: current.manifest };
}

// ── 保留账本 ─────────────────────────────────────────────────────────────────

function readRetention(paths) {
	const doc = readJson(paths.retentionFile);
	if (!doc || doc.schema !== 1 || typeof doc.entries !== "object" || !doc.entries) {
		return { schema: 1, entries: {} };
	}
	return { schema: 1, entries: { ...doc.entries } };
}

function writeRetention(paths, ledger) {
	const entries = ledger.entries ?? {};
	if (Object.keys(entries).length === 0) {
		rmSync(paths.retentionFile, { force: true });
		return;
	}
	atomicWriteJson(paths.retentionFile, { schema: 1, entries });
}

/** 给"从未成为当前发布"的候选追加保留窗口；已有窗口时不缩短、不重置。 */
function extendCandidateRetention(ledger, releaseId, until, { now, reason, profileKey }) {
	const existing = ledger.entries[releaseId];
	const existingUntil = existing ? Date.parse(existing.retainUntil ?? "") : Number.NaN;
	if (Number.isFinite(existingUntil) && existingUntil >= until) return false;
	ledger.entries[releaseId] = {
		releaseId,
		retainUntil: nowIso(until),
		updatedAt: nowIso(now),
		reason,
		profileKey: profileKey ?? null,
	};
	return true;
}

/** 当前指针／被替代窗口覆盖的 release 集合（用于判定"已有承诺窗口"）。 */
function promisedWindowIds(paths) {
	const ids = new Set();
	for (const key of listSubdirs(paths.profiles)) {
		if (!PROFILE_KEY.test(key)) continue;
		const pointer = readPointer(paths, key);
		if (!pointer) continue;
		// 已确认遗弃（profile 目录/package.json 不在）的指针不算承诺：GC 会先写墓碑再释放引用。
		if (typeof pointer.profileDir === "string" && pointer.profileDir !== "" && !profileDirAlive(pointer.profileDir)) continue;
		if (pointer.current?.releaseId) ids.add(pointer.current.releaseId);
		for (const entry of Array.isArray(pointer.superseded) ? pointer.superseded : []) {
			const until = Date.parse(entry?.retainUntil ?? "");
			if (entry?.releaseId && Number.isFinite(until)) ids.add(entry.releaseId);
		}
	}
	return ids;
}

// ── GC ───────────────────────────────────────────────────────────────────────

function profileDirAlive(dir) {
	if (typeof dir !== "string" || dir === "") return false;
	try {
		return statSync(join(dir, "package.json")).isFile();
	} catch {
		return false;
	}
}

function profileAliveFor(pointer, key, resolver) {
	if (typeof resolver === "function") return resolver(key, pointer) !== false;
	if (typeof pointer?.profileDir === "string" && pointer.profileDir !== "") return profileDirAlive(pointer.profileDir);
	// 没有记录 profile 目录时无法判定"遗弃"：保守视为存活，不接管、不回收引用。
	return true;
}

function releaseRecordValid(record, releaseId) {
	if (!record || typeof record !== "object") return false;
	if (record.releaseId !== releaseId) return false;
	try {
		const identity = normalizeReleaseIdentity(record.identity);
		return JSON.stringify(identity) === JSON.stringify(record.identity);
	} catch {
		return false;
	}
}

/**
 * 回收托管区：只删本 module 的托管对象，人工区/未知文件永不触碰。
 *
 * 顺序（与设计稿 §5.8 一致）：
 *   1. 核对每个 profile 存活性；遗弃指针**先写墓碑**再释放引用；
 *   2. 汇总所有存活 profile 的当前引用 + 真实保留截止（取并集）；
 *   3. 收敛死/超时租约（先确认不再是有效引用），为候选记录保留窗口；
 *   4. 有效租约 + 保留账本 + 已打开句柄取保护并集；
 *   5. 过期 release：先写墓碑再删记录/对象；共享对象仍被任何存活引用使用时保留；
 *   6. 未提交暂存按年龄回收（只回收完全属于本 module 的暂存目录）。
 *
 * @param {object} input
 * @param {string} input.updateDir
 * @param {number} [input.now]
 * @param {number} [input.retentionMs] 保留窗口（默认 24h）
 * @param {number} [input.stagingTtlMs] 暂存残留回收年龄（默认 1h）
 * @param {number} [input.leaseTtlMs] 租约心跳有效期（默认 10min）
 * @param {Function} [input.isProfileAlive] (profileKey, pointer) => boolean；默认按 pointer.profileDir 核对
 * @param {string} [input.lockToken] 已持锁时传入
 */
export function collectGarbage({
	updateDir,
	now = Date.now(),
	retentionMs = DEFAULT_RETENTION_MS,
	stagingTtlMs = DEFAULT_STAGING_TTL_MS,
	leaseTtlMs = DEFAULT_LEASE_TTL_MS,
	isProfileAlive,
	lockToken = "",
} = {}) {
	try {
		return runLocked({ updateDir, now, lockToken, create: false }, (paths) => {
			const report = {
				now: nowIso(now),
				profiles: { live: [], tombstoned: [], livenessUnknown: [] },
				releases: { protected: [], expired: [], droppedSuperseded: [], skipped: [] },
				leases: { protected: [], converged: [], pruned: [] },
				objects: { removed: [], protected: [] },
				staging: { removed: [], skipped: [] },
				retention: { protected: [], dropped: [] },
			};
			const currentIds = new Set();
			const promisedIds = new Set();
			// 1) profile 存活性 + 指针引用
			for (const key of listSubdirs(paths.profiles)) {
				if (!PROFILE_KEY.test(key)) continue;
				const pointer = readPointer(paths, key);
				if (!pointer) continue;
				const alive = profileAliveFor(pointer, key, isProfileAlive);
				if (alive instanceof Promise) {
					// 回调必须是同步判定：GC 持锁期间不做异步/网络等待。
					return failed(CARRIER_STATUS.UNUSABLE, "profile-liveness-unsupported", { profileKey: key });
				}
				if (!alive) {
					// 先写墓碑，再释放引用（删除 current.json）。
					const tombstoneFile = join(profileDir(paths, key), "tombstone.json");
					if (!existsSync(tombstoneFile)) {
						atomicWriteJson(tombstoneFile, {
							schema: 1,
							profileKey: key,
							profileDir: pointer.profileDir ?? null,
							tombstonedAt: nowIso(now),
							reason: "profile-gone",
							current: pointer.current ?? null,
							superseded: Array.isArray(pointer.superseded) ? pointer.superseded : [],
						});
					}
					rmSync(pointerPath(paths, key), { force: true });
					report.profiles.tombstoned.push(key);
					continue;
				}
				report.profiles.live.push(key);
				if (pointer.current?.releaseId) currentIds.add(pointer.current.releaseId);
				const keptSuperseded = [];
				for (const entry of Array.isArray(pointer.superseded) ? pointer.superseded : []) {
					const until = Date.parse(entry?.retainUntil ?? "");
					if (entry?.releaseId && Number.isFinite(until) && until > now) {
						keptSuperseded.push(entry);
						promisedIds.add(entry.releaseId);
					} else if (entry?.releaseId) {
						report.releases.droppedSuperseded.push({ profileKey: key, releaseId: entry.releaseId });
					}
				}
				if (keptSuperseded.length !== (Array.isArray(pointer.superseded) ? pointer.superseded.length : 0)) {
					atomicWriteJson(pointerPath(paths, key), {
						...pointer,
						superseded: keptSuperseded,
						updatedAt: nowIso(now),
					});
				}
				if (typeof pointer.profileDir !== "string" || pointer.profileDir === "") {
					report.profiles.livenessUnknown.push(key);
				}
			}
			// 2) 保留账本
			const ledger = readRetention(paths);
			let ledgerChanged = false;
			for (const [releaseId, entry] of Object.entries(ledger.entries)) {
				const until = Date.parse(entry?.retainUntil ?? "");
				if (Number.isFinite(until) && until > now) {
					promisedIds.add(releaseId);
					report.retention.protected.push(releaseId);
				} else {
					delete ledger.entries[releaseId];
					ledgerChanged = true;
					report.retention.dropped.push(releaseId);
				}
			}
			// 3) 租约：有效引用保护；死持有者/超时先收敛再计保留
			const leaseIds = new Set();
			const pendingConverged = [];
			for (const file of listFiles(paths.leases)) {
				if (!file.endsWith(".json")) continue;
				const leaseId = file.slice(0, -".json".length);
				if (!LEASE_ID.test(leaseId)) continue;
				const lease = readLease(paths, leaseId);
				if (!lease) continue;
				if (TERMINAL_PHASE_SET.has(lease.phase)) {
					const terminalAt = Date.parse(lease.terminalAt ?? lease.updatedAt ?? "");
					if (!Number.isFinite(terminalAt) || now - terminalAt > retentionMs) {
						rmSync(leasePath(paths, leaseId), { force: true });
						report.leases.pruned.push(leaseId);
					}
					continue;
				}
				const heartbeat = Date.parse(lease.heartbeatAt ?? lease.claimedAt ?? "");
				const ttl = Number.isSafeInteger(lease.ttlMs) && lease.ttlMs > 0 ? lease.ttlMs : leaseTtlMs;
				const active = Number.isFinite(heartbeat) && now - heartbeat <= ttl;
				if (active) {
					for (const releaseId of lease.releaseIds ?? []) {
						if (HEX64.test(releaseId ?? "")) leaseIds.add(releaseId);
					}
					report.leases.protected.push(leaseId);
					continue;
				}
				// 死持有者/超时：确认不再有效后收敛，并为候选记录保留窗口（基于收敛时刻，不重置已有承诺）。
				const converged = {
					...lease,
					phase: "expired",
					terminalAt: nowIso(now),
					updatedAt: nowIso(now),
				};
				pendingConverged.push({ leaseId, lease: converged });
				report.leases.converged.push(leaseId);
				for (const releaseId of lease.releaseIds ?? []) {
					if (!HEX64.test(releaseId ?? "")) continue;
					if (currentIds.has(releaseId) || promisedIds.has(releaseId)) continue;
					if (extendCandidateRetention(ledger, releaseId, now + retentionMs, { now, reason: "lease-expired", profileKey: lease.profileKey })) {
						ledgerChanged = true;
						promisedIds.add(releaseId);
						report.retention.protected.push(releaseId);
					}
				}
			}
			// 先落保留账本、再把租约标成终态：崩溃时宁可多保护一轮，也不提前释放候选。
			if (ledgerChanged) writeRetention(paths, ledger);
			for (const { leaseId, lease: converged } of pendingConverged) {
				atomicWriteJson(leasePath(paths, leaseId), converged);
			}
			const protectedIds = new Set([...currentIds, ...promisedIds, ...leaseIds]);
			// 4) release 记录：过期先写墓碑，再删记录；共享对象仍被存活记录使用时保留。
			const survivingRecords = new Map();
			for (const name of listSubdirs(paths.releases)) {
				if (name.startsWith(RELEASE_TMP_PREFIX)) {
					const dir = join(paths.releases, name);
					let age = Infinity;
					try {
						age = now - lstatSync(dir).mtimeMs;
					} catch {
						age = Infinity;
					}
					const entries = listDir(dir).map((entry) => entry.name);
					const ours = entries.every((entry) => entry === "release.json" || entry === "manifest.json" || /\.tmp$/.test(entry));
					if (age >= stagingTtlMs && ours) {
						rmSync(dir, { recursive: true, force: true });
						report.staging.removed.push(`releases/${name}`);
					} else if (!ours) {
						report.staging.skipped.push(`releases/${name}`);
					}
					continue;
				}
				if (!HEX64.test(name)) continue; // 未知目录不碰
				const dir = join(paths.releases, name);
				const record = readJson(join(dir, "release.json"));
				if (!record) continue; // 墓碑/未知残片：不删未知文件
				if (!releaseRecordValid(record, name)) {
					report.releases.skipped.push(name);
					continue;
				}
				if (protectedIds.has(name)) {
					survivingRecords.set(name, record);
					continue;
				}
				const tombstoneFile = join(dir, "tombstone.json");
				if (!existsSync(tombstoneFile)) {
					atomicWriteJson(tombstoneFile, {
						schema: 1,
						releaseId: name,
						identity: record.identity,
						expiredAt: nowIso(now),
						reason: promisedIds.has(name) ? "retention-tombstone" : "retention-expired",
					});
				}
				rmSync(join(dir, "release.json"), { force: true });
				rmSync(join(dir, "manifest.json"), { force: true });
				report.releases.expired.push(name);
			}
			// 5) 对象：只删"不再被任何存活 release 记录引用、也未被打开句柄保护"的托管对象
			const protectedObjects = new Set(openObjectPins.keys());
			for (const record of survivingRecords.values()) {
				protectedObjects.add(pinKey("apk", record.identity.app.sha256));
				protectedObjects.add(pinKey("plugin", record.identity.plugin.sha256));
			}
			for (const kind of OBJECT_KINDS) {
				const base = kind === "apk" ? paths.apkObjects : paths.pluginObjects;
				for (const sha256 of listSubdirs(base)) {
					if (!HEX64.test(sha256)) continue; // 未知目录不碰
					const dir = join(base, sha256);
					const file = join(dir, OBJECT_NAMES[kind]);
					if (!existsSync(file)) continue;
					const key = pinKey(kind, sha256);
					if (protectedObjects.has(key)) {
						report.objects.protected.push(key);
						continue;
					}
					rmSync(file, { force: true });
					report.objects.removed.push(key);
					try {
						rmdirSync(dir); // 只删空目录；含未知文件则保留
					} catch {
						// 非空：未知文件不碰
					}
				}
			}
			// 6) 未提交暂存：按年龄回收（只回收完全属于本 module 的目录）
			for (const name of listSubdirs(paths.staging)) {
				if (!STAGING_ID.test(name)) continue; // 未知目录不碰
				const dir = join(paths.staging, name);
				const staged = readJson(join(dir, "staged.json"));
				let createdAt = staged && Number.isFinite(staged.createdAtMs) ? staged.createdAtMs : Number.NaN;
				if (!Number.isFinite(createdAt)) {
					try {
						createdAt = lstatSync(dir).mtimeMs;
					} catch {
						continue;
					}
				}
				if (now - createdAt < stagingTtlMs) continue;
				if (!stagingDirIsOurs(dir)) {
					report.staging.skipped.push(name);
					continue;
				}
				rmSync(dir, { recursive: true, force: true });
				report.staging.removed.push(name);
			}
			report.releases.protected = [...survivingRecords.keys()];
			return ready(report);
		});
	} catch (error) {
		return failed(CARRIER_STATUS.UNUSABLE, "internal-error", { detail: String(error?.message ?? error) });
	}
}
