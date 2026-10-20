// App 载体发现与身份校验（设计稿 §5.5；事实 C9/C10，F15/F16）。
//
// 载体是什么：与主插件**同包名**的一个预发布版本（`X.Y.Z-app`），只承担数据角色
// （APK + 完整 schema 1 发布清单），由主插件 `package.json` 里的精确 npm 别名依赖
// 随包安装。主插件需要找到它、验证它，再交给托管区去落位；同时**不能**把它算进
// 运行时依赖闭包（否则每次自更新都会把 72MB 复制进产物目录与每个回滚快照）。
//
// 安全边界（缺一不可，任一不满足都不得当作可用载体）：
//   1. 只从**本插件自身的解析作用域**定位载体别名下的包；自身作用域没有时才按 DSH
//      profile 逐个精确回退，多个不同候选一律报 ambiguous，绝不"找到第一个就用"。
//   2. 不解析载体的裸包入口（数据包没有 main/exports）；只读 `package.json`、
//      发布清单与 APK 字节，避免借"入口加载"执行任意代码。
//   3. 身份：真实包名 === 本插件包名、版本 === `<本插件版本>-app`、
//      `dsh.appCarrier === true`、无运行角色字段、发布清单完整 schema 1（app+plugin
//      两段 + 顶层兼容镜像）、APK 文件名在清单允许范围内且大小/sha256 与清单一致。
//   4. 运行时闭包排除只接受「根包显式声明该载体别名 + 上述校验通过」；普通依赖自报
//      `dsh.appCarrier` 不构成豁免。任何异常/多义一律按"不排除"处理（fail-closed：
//      宁可让闭包包含字节，也不放宽身份判据）。
//   5. 本模块不写任何文件；冻结快照原样保留根包 `package.json`，不靠删改依赖声明
//      改变内容标识。
import { createHash } from "node:crypto";
import {
	closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { pluginContentDigest } from "./plugin-content-digest.js";

/** 载体别名 / 版本的固定后缀：`<包名>-app` 与 `<插件版本>-app`。 */
export const APP_CARRIER_SUFFIX = "-app";
/** 随载体到达的发布清单文件名（设计稿 §5.1）。 */
export const APP_CARRIER_MANIFEST_FILE = "manifest.json";
/** 发布清单 schema 版本（与 dsh-mobile-app/tools/gen-manifest.js 的 MANIFEST_SCHEMA 一致）。 */
export const APP_CARRIER_MANIFEST_SCHEMA = 1;

/** 发现结果状态：找到 / 未找到 / 多个候选 / 身份不符 / 加载失败。 */
export const APP_CARRIER_STATUS = Object.freeze({
	FOUND: "found",
	MISSING: "missing",
	AMBIGUOUS: "ambiguous",
	MISMATCH: "mismatch",
	ERROR: "error",
});

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const PLUGIN_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const APP_BUILD_VERSION_PATTERN = /^\d+\.\d+\.\d+\+\d+$/;
// 与运行时闭包 worker 同款依赖名判据：可选 scope，名字里不允许路径分隔符/空白。
const DEPENDENCY_NAME_PATTERN = /^(?:@[^/\s]+\/)?[^./\s][^/\s]*$/;
// 清单允许的 APK 文件名：只能是载体根下的一层普通文件名，且以 .apk 结尾。
const APK_FILE_PATTERN = /^[^/\\\x00]+\.apk$/i;
// 载体不得携带的运行角色 / 平台字段（设计稿 §5.1 红线）。
const FORBIDDEN_ROLE_FIELDS = ["bin", "main", "exports", "os", "cpu", "libc"];
const FORBIDDEN_ROLE_DSH_FIELDS = ["bundle", "client"];
const FORBIDDEN_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"];

const MODULE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** 本模块所在插件的根目录（生产环境即实际加载的插件副本）。 */
export function defaultPluginRoot() {
	return MODULE_ROOT;
}

/** 由插件包名推导载体别名：`@scope/name` → `@scope/name-app`。 */
export function appCarrierAlias(pluginName) {
	if (typeof pluginName !== "string" || !DEPENDENCY_NAME_PATTERN.test(pluginName)) {
		throw new Error("invalid-plugin-name");
	}
	return `${pluginName}${APP_CARRIER_SUFFIX}`;
}

/** 由插件版本推导载体版本：`X.Y.Z` → `X.Y.Z-app`。 */
export function appCarrierVersion(pluginVersion) {
	if (typeof pluginVersion !== "string" || pluginVersion === "") throw new Error("invalid-plugin-version");
	return `${pluginVersion}${APP_CARRIER_SUFFIX}`;
}

/** 主包 `package.json` 里应有的精确 npm 别名依赖声明（设计稿 §5.1）。 */
export function appCarrierDependencySpec(pluginName, pluginVersion) {
	return `npm:${pluginName}@${appCarrierVersion(pluginVersion)}`;
}

function contained(root, target) {
	const rel = relative(root, target);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function readJsonFile(file) {
	try {
		return { ok: true, value: JSON.parse(readFileSync(file, "utf8")) };
	} catch (error) {
		return { ok: false, code: error?.code === "ENOENT" ? "missing" : "unreadable", error };
	}
}

function readPackageIdentity(packageRoot) {
	const file = join(packageRoot, "package.json");
	const parsed = readJsonFile(file);
	if (!parsed.ok) return { ok: false, reason: parsed.code === "missing" ? "package-missing" : "package-unreadable" };
	const pkg = parsed.value;
	if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) return { ok: false, reason: "package-invalid" };
	return { ok: true, file, pkg };
}

/** 同步、分块计算文件 sha256：72MB 级 APK 也不在事件循环里一次性读入内存。 */
function sha256FileSync(file, chunkSize = 1024 * 1024) {
	const hash = createHash("sha256");
	const fd = openSync(file, "r");
	try {
		const buffer = Buffer.allocUnsafe(chunkSize);
		for (;;) {
			const read = readSync(fd, buffer, 0, chunkSize, null);
			if (read <= 0) break;
			hash.update(buffer.subarray(0, read));
		}
	} finally {
		closeSync(fd);
	}
	return hash.digest("hex");
}

function dshHomeFrom(options) {
	if (typeof options?.dshHome === "string" && options.dshHome.trim() !== "") return options.dshHome;
	const fromEnv = process.env.DSH_HOME;
	if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv;
	return join(homedir(), ".dsh");
}

/** 读取根包对载体别名的显式声明（只认 optionalDependencies / dependencies 的精确键）。 */
function declaredCarrierDependency(pkg, alias) {
	for (const field of ["optionalDependencies", "dependencies"]) {
		const table = pkg?.[field];
		if (table && typeof table === "object" && typeof table[alias] === "string") {
			return { declared: true, field, spec: table[alias] };
		}
	}
	return { declared: false, field: null, spec: null };
}

/**
 * 声明是否可当作"精确绑定"：`npm:<包名>@<版本>-app` 是正式发布形态；
 * `file:` / `link:` / `portal:` / `workspace:` 是本地测试通道的目录绑定（P0/A10）。
 * 其余（范围、latest、别的别名）一律不算精确绑定，不能据此排除闭包。
 */
function declarationKind(spec, pluginName, pluginVersion) {
	if (typeof spec !== "string") return "inexact";
	if (spec === appCarrierDependencySpec(pluginName, pluginVersion)) return "npm-alias";
	if (/^(?:file|link|portal|workspace):/.test(spec)) return "local";
	return "inexact";
}

/** 某作用域下 Node 会查找该依赖名的目录顺序（与运行时 worker 的 binding 一致）。 */
function dependencyLookupDirs(scopeRoot, name) {
	try {
		const require = createRequire(join(scopeRoot, "package.json"));
		return (require.resolve.paths(name) ?? []).filter((dir) => typeof dir === "string" && isAbsolute(dir));
	} catch {
		return [];
	}
}

/**
 * 在一个解析作用域里按精确别名找候选。
 * 复核 scope 容器（`@scope`）的 broken symlink：不能被上层同名目录兜底后假绿。
 * 返回 { candidates, errors }；candidates 按真实路径去重。
 */
function scanCarrierScope(scopeRoot, alias, via) {
	const candidates = [];
	const errors = [];
	for (const lookup of dependencyLookupDirs(scopeRoot, alias)) {
		const candidatePath = join(lookup, alias);
		if (alias.startsWith("@")) {
			const scopeDir = join(lookup, alias.split("/")[0]);
			let scopeStat;
			try {
				scopeStat = lstatSync(scopeDir);
			} catch (error) {
				if (error?.code !== "ENOENT") errors.push({ via, path: scopeDir, reason: "carrier-lookup-failed" });
			}
			if (scopeStat?.isSymbolicLink()) {
				try {
					realpathSync(scopeDir);
				} catch {
					errors.push({ via, path: scopeDir, reason: "carrier-broken-link" });
					continue;
				}
			}
		}
		try {
			lstatSync(candidatePath);
		} catch (error) {
			if (error?.code === "ENOENT") continue;
			errors.push({ via, path: candidatePath, reason: "carrier-lookup-failed" });
			continue;
		}
		let source;
		try {
			source = realpathSync(candidatePath);
		} catch {
			errors.push({ via, path: candidatePath, reason: "carrier-broken-link" });
			continue;
		}
		let stat;
		try {
			stat = statSync(source);
		} catch {
			errors.push({ via, path: candidatePath, reason: "carrier-broken-link" });
			continue;
		}
		if (!stat.isDirectory()) {
			errors.push({ via, path: candidatePath, reason: "carrier-not-directory" });
			continue;
		}
		if (!candidates.some((entry) => entry.source === source)) {
			candidates.push({ via, source, path: candidatePath });
		}
	}
	return { candidates, errors };
}

/** DSH profile 目录：固定三个常见名字 + 实际存在的目录，逐个判断、不取第一个。 */
function profileDirectories(dshHome) {
	const profilesRoot = join(dshHome, "profiles");
	const names = new Set(["web", "desktop", "cli"]);
	try {
		for (const entry of readdirSync(profilesRoot, { withFileTypes: true })) {
			if (entry.isDirectory() && !entry.name.startsWith(".")) names.add(entry.name);
		}
	} catch {
		// 没有 profiles 目录（隔离测试/新机器）：只按固定名字尝试。
	}
	return [...names].sort().map((name) => ({ name, dir: join(profilesRoot, name) }));
}

/** 从入口文件向上找到 package.json 名称为 expectedName 的包根。 */
function packageRootOfEntry(entry, expectedName) {
	let dir = dirname(entry);
	for (let depth = 0; depth < 8; depth++) {
		const identity = readPackageIdentity(dir);
		if (identity.ok && identity.pkg.name === expectedName) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/** 从 profile 里定位"本插件"自己的安装根（用于插件根被快照/链接到别处时的回退）。 */
function installedPluginRootInProfile(profileDir, pluginName) {
	try {
		const require = createRequire(join(profileDir, "package.json"));
		return packageRootOfEntry(require.resolve(pluginName), pluginName);
	} catch {
		return null;
	}
}

/**
 * 收集候选：先看本插件自身作用域；自身作用域完全找不到时才逐 profile 回退。
 * 回退会评估**所有** profile，返回全部不同候选交给上层判多义，绝不"找到第一个就用"。
 */
function collectCarrierCandidates(pluginRoot, pluginName, alias, options) {
	const own = scanCarrierScope(pluginRoot, alias, "plugin");
	// 自身作用域已有候选或存在损坏链接：按自身作用域的结论处理，不去别的 profile 猜。
	if (own.candidates.length > 0 || own.errors.length > 0) return own;
	const candidates = [];
	const errors = [];
	for (const profile of profileDirectories(dshHomeFrom(options))) {
		const via = `profile:${profile.name}`;
		// (a) 被提升/平铺到 profile 直接 node_modules 的布局。
		try {
			const stat = lstatSync(join(profile.dir, "node_modules"));
			if (stat.isDirectory() || stat.isSymbolicLink()) {
				const hoistedPath = join(profile.dir, "node_modules", alias);
				let source;
				try {
					source = realpathSync(hoistedPath);
					if (statSync(source).isDirectory() && !candidates.some((entry) => entry.source === source)) {
						candidates.push({ via, source, path: hoistedPath });
					}
				} catch {
					// 该 profile 没有平铺载体：继续。
				}
			}
		} catch {
			// profile 未安装 node_modules：继续。
		}
		// (b) 从该 profile 解析出"本插件"的安装根，再按插件自身作用域找载体。
		const installedRoot = installedPluginRootInProfile(profile.dir, pluginName);
		if (!installedRoot) continue;
		const scanned = scanCarrierScope(installedRoot, alias, via);
		errors.push(...scanned.errors);
		for (const candidate of scanned.candidates) {
			if (!candidates.some((entry) => entry.source === candidate.source)) candidates.push(candidate);
		}
	}
	return { candidates, errors };
}

/** 清单 app 段 / plugin 段的字段判据；返回稳定 reason 或 null。 */
function manifestProblem(manifest, plugin) {
	if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return "carrier-manifest-invalid";
	if (manifest.schema !== APP_CARRIER_MANIFEST_SCHEMA) return "carrier-manifest-schema";
	const app = manifest.app;
	const pluginSegment = manifest.plugin;
	if (!app || typeof app !== "object" || Array.isArray(app)) return "carrier-manifest-incomplete";
	if (!pluginSegment || typeof pluginSegment !== "object" || Array.isArray(pluginSegment)) return "carrier-manifest-incomplete";
	// app 段：真实构建版本、APK 文件名、字节数与哈希。
	if (typeof app.version !== "string" || !APP_BUILD_VERSION_PATTERN.test(app.version)) return "carrier-manifest-incomplete";
	if (typeof app.file !== "string" || !APK_FILE_PATTERN.test(app.file)) return "carrier-apk-file-invalid";
	if (!Number.isSafeInteger(app.size) || app.size < 0) return "carrier-manifest-incomplete";
	if (typeof app.sha256 !== "string" || !HASH_PATTERN.test(app.sha256)) return "carrier-manifest-incomplete";
	// plugin 段：发布 tgz 身份 + 插件内容标识（内容标识是配对选择依据，不是本模块的硬门禁）。
	if (typeof pluginSegment.version !== "string" || !PLUGIN_VERSION_PATTERN.test(pluginSegment.version)) return "carrier-manifest-incomplete";
	if (typeof pluginSegment.file !== "string" || pluginSegment.file === "" || pluginSegment.file === "." || pluginSegment.file === ".."
		|| /[\\/]/.test(pluginSegment.file)) return "carrier-manifest-incomplete";
	if (!Number.isSafeInteger(pluginSegment.size) || pluginSegment.size < 0) return "carrier-manifest-incomplete";
	if (typeof pluginSegment.sha256 !== "string" || !HASH_PATTERN.test(pluginSegment.sha256)) return "carrier-manifest-incomplete";
	if (typeof pluginSegment.contentSha256 !== "string" || !HASH_PATTERN.test(pluginSegment.contentSha256)) return "carrier-manifest-incomplete";
	// 顶层兼容镜像必须与 app 段同源（旧 App 读镜像，完整 schema 1 的一部分）。
	if (manifest.version !== app.version || manifest.apk !== app.file
		|| manifest.size !== app.size || manifest.sha256 !== app.sha256) return "carrier-manifest-mirror-mismatch";
	// 版本配对：清单描述的必须是与当前插件同一语义版本，且 app 版本精确到构建号。
	if (pluginSegment.version !== plugin.version) return "carrier-manifest-plugin-version-mismatch";
	if (app.version.split("+")[0] !== plugin.version) return "carrier-manifest-app-version-mismatch";
	return null;
}

/** 校验 APK 位于允许位置，且大小/哈希与清单一致。 */
function validateCarrierApk(carrierRoot, app) {
	const apkPath = join(carrierRoot, app.file);
	let stat;
	try {
		stat = statSync(apkPath);
	} catch (error) {
		return { ok: false, reason: error?.code === "ENOENT" ? "carrier-apk-missing" : "carrier-apk-unreadable" };
	}
	if (!stat.isFile()) return { ok: false, reason: "carrier-apk-not-file" };
	let real;
	try {
		real = realpathSync(apkPath);
	} catch {
		return { ok: false, reason: "carrier-apk-unreadable" };
	}
	if (!contained(carrierRoot, real)) return { ok: false, reason: "carrier-apk-outside-carrier" };
	if (stat.size !== app.size) return { ok: false, reason: "carrier-apk-size-mismatch", actual: stat.size };
	let sha256;
	try {
		sha256 = sha256FileSync(real);
	} catch {
		return { ok: false, reason: "carrier-apk-unreadable" };
	}
	if (sha256 !== app.sha256) return { ok: false, reason: "carrier-apk-sha256-mismatch", actual: sha256 };
	return { ok: true, path: real, file: app.file, size: stat.size, sha256 };
}

/**
 * 单个候选的完整身份校验。通过返回可用载体描述；否则返回稳定 reason。
 * 注意：这里只看"这个包是不是本插件的载体"，插件内容标识匹配属于当前发布选择（§5.3）。
 */
function validateCarrierCandidate(candidate, plugin) {
	const identity = readPackageIdentity(candidate.source);
	if (!identity.ok) return { ok: false, reason: `carrier-${identity.reason}` };
	const pkg = identity.pkg;
	if (pkg.name !== plugin.name) return { ok: false, reason: "carrier-package-name-mismatch" };
	if (pkg.version !== appCarrierVersion(plugin.version)) return { ok: false, reason: "carrier-version-mismatch" };
	if (pkg.dsh?.appCarrier !== true) return { ok: false, reason: "carrier-role-marker-missing" };
	// 载体只是数据：不得带运行入口、平台限定字段、bundle 角色或安装期钩子。
	if (FORBIDDEN_ROLE_FIELDS.some((field) => pkg[field] !== undefined)) return { ok: false, reason: "carrier-runtime-role-forbidden" };
	if (FORBIDDEN_ROLE_DSH_FIELDS.some((field) => pkg.dsh?.[field] !== undefined)) return { ok: false, reason: "carrier-runtime-role-forbidden" };
	if (pkg.scripts && typeof pkg.scripts === "object" && FORBIDDEN_SCRIPTS.some((field) => typeof pkg.scripts[field] === "string")) {
		return { ok: false, reason: "carrier-runtime-role-forbidden" };
	}
	const manifestPath = join(candidate.source, APP_CARRIER_MANIFEST_FILE);
	const manifestFile = readJsonFile(manifestPath);
	if (!manifestFile.ok) return { ok: false, reason: manifestFile.code === "missing" ? "carrier-manifest-missing" : "carrier-manifest-unreadable" };
	const problem = manifestProblem(manifestFile.value, plugin);
	if (problem) return { ok: false, reason: problem };
	const apk = validateCarrierApk(candidate.source, manifestFile.value.app);
	if (!apk.ok) return { ok: false, reason: apk.reason };
	let contentSha256 = null;
	try {
		contentSha256 = pluginContentDigest(plugin.root);
	} catch {
		contentSha256 = null;
	}
	const manifest = manifestFile.value;
	return {
		ok: true,
		carrier: {
			source: candidate.source,
			packageJson: identity.file,
			name: pkg.name,
			version: pkg.version,
			appCarrier: true,
		},
		manifest: {
			path: manifestPath,
			schema: manifest.schema,
			appVersion: manifest.app.version,
			pluginVersion: manifest.plugin.version,
			pluginFile: manifest.plugin.file,
			pluginTgzSha256: manifest.plugin.sha256,
			contentSha256: manifest.plugin.contentSha256,
		},
		apk,
		pluginContent: contentSha256 === null ? null : {
			actual: contentSha256,
			manifest: manifest.plugin.contentSha256,
			matches: contentSha256 === manifest.plugin.contentSha256,
		},
		discoveredVia: candidate.via,
	};
}

function baseResult(status, reason, plugin, alias) {
	return {
		ok: status === APP_CARRIER_STATUS.FOUND,
		status,
		reason,
		alias,
		plugin: plugin ? { root: plugin.root, name: plugin.name, version: plugin.version } : null,
	};
}

function pluginIdentityFor(pluginRoot) {
	const resolvedRoot = (() => {
		try {
			return realpathSync(pluginRoot);
		} catch {
			return pluginRoot;
		}
	})();
	const identity = readPackageIdentity(resolvedRoot);
	if (!identity.ok) return { ok: false, reason: identity.reason === "package-missing" ? "plugin-package-missing" : "plugin-package-unreadable" };
	const name = identity.pkg.name;
	const version = identity.pkg.version;
	if (typeof name !== "string" || !DEPENDENCY_NAME_PATTERN.test(name)) return { ok: false, reason: "plugin-package-name-invalid" };
	if (typeof version !== "string" || version === "") return { ok: false, reason: "plugin-version-invalid" };
	return { ok: true, root: resolvedRoot, name, version, pkg: identity.pkg };
}

/**
 * 发现并校验随包安装的 App 载体。
 *
 * @param {object} [options]
 * @param {string} [options.pluginRoot] 本插件根目录（默认本模块所在插件根）。
 * @param {string} [options.dshHome]  DSH 主目录（默认 `DSH_HOME` 或 `~/.dsh`）；隔离测试用。
 * @returns {object} 结构化结果：`{ ok, status, reason, alias, plugin, declaration,
 *   discoveredVia?, carrier?, manifest?, apk?, pluginContent?, candidates? }`。
 *   `status` 为 found/missing/ambiguous/mismatch/error，`!ok` 时 `reason` 是稳定原因码。
 *   绝对路径只在插件内部使用；对外展示请用 `describeAppCarrier()` 脱敏。
 */
export function discoverAppCarrier(options = {}) {
	const pluginRoot = typeof options.pluginRoot === "string" && options.pluginRoot !== "" ? options.pluginRoot : defaultPluginRoot();
	const plugin = pluginIdentityFor(pluginRoot);
	if (!plugin.ok) {
		return { ok: false, status: APP_CARRIER_STATUS.ERROR, reason: plugin.reason, alias: null, plugin: null };
	}
	const alias = appCarrierAlias(plugin.name);
	const declaration = declaredCarrierDependency(plugin.pkg, alias);
	const result = baseResult(APP_CARRIER_STATUS.MISSING, "carrier-not-installed", plugin, alias);
	result.declaration = {
		declared: declaration.declared,
		field: declaration.field,
		spec: declaration.spec,
		kind: declaration.declared ? declarationKind(declaration.spec, plugin.name, plugin.version) : null,
	};
	const collected = collectCarrierCandidates(plugin.root, plugin.name, alias, options);
	if (collected.errors.length > 0 && collected.candidates.length === 0) {
		const error = collected.errors[0];
		return {
			...result,
			status: APP_CARRIER_STATUS.ERROR,
			reason: error.reason,
			discoveredVia: error.via,
		};
	}
	if (collected.candidates.length === 0) return result;
	if (collected.candidates.length > 1) {
		return {
			...result,
			status: APP_CARRIER_STATUS.AMBIGUOUS,
			reason: "carrier-multiple-candidates",
			// 只暴露来源与真实目录，供上层诊断；绝不替调用方挑一个。
			candidates: collected.candidates.map((candidate) => ({ via: candidate.via, source: candidate.source })),
		};
	}
	const candidate = collected.candidates[0];
	const validated = validateCarrierCandidate(candidate, plugin);
	if (!validated.ok) {
		return {
			...result,
			status: APP_CARRIER_STATUS.MISMATCH,
			reason: validated.reason,
			discoveredVia: candidate.via,
		};
	}
	return {
		...result,
		...validated,
		ok: true,
		status: APP_CARRIER_STATUS.FOUND,
		reason: "ok",
	};
}

/**
 * 运行时依赖闭包排除判定（设计稿 §5.5）。同步、fail-closed。
 *
 * 只有同时满足以下条件才返回 `exclude: true`：
 *   1. 根包 `package.json` 在 `optionalDependencies`/`dependencies` 里**显式声明**了载体别名；
 *      声明是精确绑定（精确 npm 别名，或本地测试通道的目录绑定）；
 *   2. 从根包自身作用域能唯一解析到该别名；
 *   3. 该候选通过 `validateCarrierCandidate` 的全部身份校验。
 * 普通依赖自报 `dsh.appCarrier`、范围声明、多候选、校验失败都返回 `exclude: false`。
 *
 * @param {{ root: string }} [input] `root` 为待建图/待冻结/待校验的包根目录。
 * @returns {{ exclude: boolean, reason: string, hard?: boolean, alias?: string, source?: string }}
 *   `hard: true` 表示根包**确实**声明了载体且作用域里也确实存在候选，但候选身份校验失败
 *   或多义。闭包调用方应据此 fail-closed（不能把无入口的数据包当运行依赖去解析）。
 */
export function appCarrierExclusion(input = {}) {
	const root = input?.root;
	let alias = null;
	try {
		const plugin = pluginIdentityFor(root);
		if (!plugin.ok) return { exclude: false, reason: plugin.reason };
		alias = appCarrierAlias(plugin.name);
		const declaration = declaredCarrierDependency(plugin.pkg, alias);
		if (!declaration.declared) return { exclude: false, reason: "carrier-not-declared", alias };
		if (declarationKind(declaration.spec, plugin.name, plugin.version) === "inexact") {
			return { exclude: false, reason: "carrier-declaration-not-exact", alias };
		}
		const scanned = scanCarrierScope(plugin.root, alias, "plugin");
		if (scanned.candidates.length === 0) {
			return { exclude: false, reason: scanned.errors[0]?.reason ?? "carrier-not-installed", alias };
		}
		if (scanned.candidates.length > 1) return { exclude: false, hard: true, reason: "carrier-multiple-candidates", alias };
		const validated = validateCarrierCandidate(scanned.candidates[0], plugin);
		if (!validated.ok) return { exclude: false, hard: true, reason: validated.reason, alias };
		return {
			exclude: true,
			reason: "ok",
			alias,
			source: validated.carrier.source,
			carrier: validated.carrier,
			apk: validated.apk,
		};
	} catch (error) {
		// 任何意外都按"不排除"处理：宁可多复制字节，也不让伪造/损坏的包绕过校验。
		return { exclude: false, reason: "carrier-check-failed", alias, detail: String(error?.message ?? error) };
	}
}

/**
 * 对外诊断视图（设计稿 §5.10：不含凭据与本机绝对路径）。
 * 上层展示发现路径、别名、版本、校验结论与稳定 reason 时只用这个结果。
 */
export function describeAppCarrier(result) {
	if (!result || typeof result !== "object") return { status: "error", reason: "carrier-check-failed" };
	return {
		status: result.status ?? "error",
		reason: result.reason ?? "carrier-check-failed",
		alias: result.alias ?? null,
		declared: result.declaration?.declared === true,
		declarationKind: result.declaration?.kind ?? null,
		locatedVia: result.discoveredVia ?? null,
		plugin: result.plugin ? { name: result.plugin.name, version: result.plugin.version } : null,
		carrier: result.carrier ? { name: result.carrier.name, version: result.carrier.version } : null,
		manifest: result.manifest ? {
			schema: result.manifest.schema,
			appVersion: result.manifest.appVersion,
			pluginVersion: result.manifest.pluginVersion,
		} : null,
		apk: result.apk ? { file: result.apk.file, size: result.apk.size, sha256: result.apk.sha256 } : null,
		candidateCount: Array.isArray(result.candidates) ? result.candidates.length : (result.carrier ? 1 : 0),
	};
}

// 供上层接线时拼装 APK 绝对路径（仅在插件内部使用，不直接展示）。
export function appCarrierApkPath(result) {
	const source = result?.carrier?.source;
	const file = result?.apk?.file;
	return typeof source === "string" && typeof file === "string" ? join(source, file) : null;
}
