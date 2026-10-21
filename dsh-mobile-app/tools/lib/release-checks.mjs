#!/usr/bin/env node
// 发布配对检查的**共享实现**：构建器 build-app-carrier.mjs 与校验器 verify-update-manifest.mjs
// 必须用同一套判定，否则「构建器放过的载体被校验器拒绝」（或相反）会让发布门禁失去意义。
//
// 设计依据（~/.local/state/dsh-mobile-remote-workflow/reports/app-carrier-design.md）：
//   §1.3  正式版：插件 X.Y.Z，载体 X.Y.Z-app；同一包名两版本，精确别名相连。
//   §5.1  载体内容 = APK + 完整 schema 1 清单 + 说明/许可；`dsh.appCarrier: true`。
//   §5.2  构建顺序：先打好插件 tgz → 由 tgz 与 APK 生成清单 → 再打包载体（无自指循环）。
//   §6.2  F17：清单 app.version 从 APK 实读（aapt dump badging 的 versionName/versionCode）；
//         F18：同一版本不得对应两份内容（构建器还要求 tgz 内容标识等于当前源码）。
//   §10.1 R9：F17 要求实读，不允许长期手填；R1：测试插件不发 registry（本模块零网络、零发布）。
//
// 本模块只做纯判定/取证：不写发布产物、不发网络、不调用 npm publish。所有断言以
// `{name, pass, detail}` 返回，由调用方统一打印 `PASS/FAIL  <name> (detail)`；
// 「无法执行」不等于「通过」——调用方遇到缺输入必须显式 FAIL。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

/** 载体版本后缀（设计稿 §1.3：X.Y.Z ↔ X.Y.Z-app）。 */
export const CARRIER_VERSION_SUFFIX = "-app";

/** APK 发布产物命名约定（§5.1 三资产逐字节一致，文件名即身份的一部分）。 */
export const APK_FILENAME_RE = /^DSH-Remote-v(\d+\.\d+\.\d+)\.apk$/;

/** 载体包禁止出现的字段：任何运行入口/平台选择/安装期执行钩子都让数据包变成可执行包。 */
export const CARRIER_FORBIDDEN_FIELDS = ["os", "cpu", "libc", "bin", "main", "exports", "scripts"];

/**
 * 平台 token（包名/版本维度）。设计稿 Q17：载体无平台字段、平台 token 别名。
 * 用分隔符围栏，避免把普通单词（如 "remote" 中的 "mote"）误判；只用于包名与版本。
 */
const PLATFORM_TOKEN_RE =
	/(?:^|[-_./])(?:android|linux|darwin|win32|windows|macos|freebsd|openbsd|arm|arm64|aarch64|x64|x86|x86_64|ia32|amd64|ppc64|s390x|riscv64|musl|glibc)(?=$|[-_./])/i;

/** 清单里参与载体/主包身份比对的字段（顺序即 releaseId 语义字段，§5.3）。 */
export const MANIFEST_APP_FIELDS = ["version", "file", "size", "sha256"];
export const MANIFEST_PLUGIN_FIELDS = ["version", "file", "size", "sha256", "contentSha256"];

export function sha256Buffer(buf) {
	return crypto.createHash("sha256").update(buf).digest("hex");
}

export function sha256File(file) {
	return sha256Buffer(fs.readFileSync(file));
}

/** 解析 `X.Y.Z` / `X.Y.Z+N`；不合法返回 null。 */
export function parseVersion(version) {
	const m = /^(\d+\.\d+\.\d+)(?:\+(\d+))?$/.exec(String(version ?? ""));
	return m ? { version: m[1], build: m[2] ?? null } : null;
}

/** 从发布产物文件名取语义版本；不符合约定返回 null。 */
export function apkVersionFromFilename(file) {
	const m = APK_FILENAME_RE.exec(String(file ?? ""));
	return m ? m[1] : null;
}

/** 载体版本：`X.Y.Z` → `X.Y.Z-app`。 */
export function carrierVersion(pluginVersion) {
	return `${pluginVersion}${CARRIER_VERSION_SUFFIX}`;
}

/** 载体别名键：`@scope/name` → `@scope/name-app`。 */
export function carrierAlias(pluginName) {
	return `${pluginName}${CARRIER_VERSION_SUFFIX}`;
}

/** 主包里载体依赖的**精确** npm 别名写法（键是别名，值是同包名主包的 -app 版本）。 */
export function carrierDependencySpec(pluginName, pluginVersion) {
	return `npm:${pluginName}@${carrierVersion(pluginVersion)}`;
}

export function containsPlatformToken(text) {
	return PLATFORM_TOKEN_RE.test(String(text ?? ""));
}

export function readJsonFile(file) {
	try {
		return { ok: true, value: JSON.parse(fs.readFileSync(file, "utf8")) };
	} catch (error) {
		return { ok: false, error: String(error?.message ?? error) };
	}
}

export function objectPick(obj, fields) {
	const out = {};
	for (const field of fields) if (obj && Object.hasOwn(obj, field)) out[field] = obj[field];
	return out;
}

function sortObject(obj) {
	const out = {};
	for (const key of Object.keys(obj).sort()) out[key] = obj[key];
	return out;
}

export function arraysEqual(a, b) {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** 解包 `.tgz` 到目录（系统 tar；Windows 10+ 亦自带）。失败返回 `{ok:false,error}`，绝不静默通过。 */
export function tarExtract(tgzFile, destDir) {
	try {
		fs.mkdirSync(destDir, { recursive: true });
	} catch (error) {
		return { ok: false, error: String(error?.message ?? error) };
	}
	const r = spawnSync("tar", ["-xzf", tgzFile, "-C", destDir], { encoding: "utf8" });
	if (r.error || r.status !== 0) {
		return {
			ok: false,
			error: `无法解包（需要 tar）：${r.error?.message ?? r.stderr?.trim() ?? `exit ${r.status}`}`,
		};
	}
	return { ok: true };
}

/** 列出 `.tgz` 条目（原样，含 `package/` 前缀与目录项）。 */
export function tarList(tgzFile) {
	const r = spawnSync("tar", ["-tzf", tgzFile], { encoding: "utf8" });
	if (r.error || r.status !== 0) {
		return { ok: false, error: r.error?.message ?? r.stderr?.trim() ?? `exit ${r.status}` };
	}
	return { ok: true, entries: r.stdout.split(/\r?\n/).filter((line) => line !== "") };
}

/** 去掉 `package/` 前缀与目录项，得到包内相对文件清单（排序）。 */
export function packedFiles(entries) {
	return entries
		.map((entry) => entry.replace(/^\.\//, ""))
		.filter((entry) => entry.startsWith("package/") && !entry.endsWith("/"))
		.map((entry) => entry.slice("package/".length))
		.sort();
}

function isExecutableFile(file) {
	try {
		return fs.statSync(file).isFile() && (fs.accessSync(file, fs.constants.X_OK), true);
	} catch {
		return false;
	}
}

/** 探测 aapt/aapt2：PATH 优先，其次 Android SDK build-tools（真实发布机通常走后者）。 */
export function findApkTools() {
	const names = process.platform === "win32"
		? ["aapt.exe", "aapt2.exe", "aapt", "aapt2"]
		: ["aapt", "aapt2"];
	const candidates = [];
	for (const dir of String(process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		for (const name of names) candidates.push(path.join(dir, name));
	}
	for (const envName of ["ANDROID_HOME", "ANDROID_SDK_ROOT"]) {
		const sdk = process.env[envName];
		if (!sdk) continue;
		const buildTools = path.join(sdk, "build-tools");
		let versions;
		try {
			versions = fs.readdirSync(buildTools, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name)
				.sort()
				.reverse();
		} catch {
			continue;
		}
		for (const version of versions) {
			for (const name of names) candidates.push(path.join(buildTools, version, name));
		}
	}
	const found = [];
	for (const candidate of candidates) {
		if (!isExecutableFile(candidate)) continue;
		if (!found.includes(candidate)) found.push(candidate);
	}
	return found;
}

function parseBadging(stdout) {
	const packageName = /package: name=['"]([^'"]*)['"]/.exec(stdout)?.[1];
	const versionCode = /versionCode=['"](\d+)['"]/.exec(stdout)?.[1];
	const versionName = /versionName=['"]([^'"]*)['"]/.exec(stdout)?.[1];
	if (!versionName || !versionCode) return null;
	return { packageName: packageName ?? "", versionName, versionCode };
}

/**
 * 从 APK **实读** `versionName`/`versionCode`（F17/R9）。
 * - `{ok:true, versionName, versionCode, packageName, source}`：成功实读；
 * - `{ok:false, reason:"aapt-not-found"}`：环境没有 aapt/aapt2（允许显式降级，调用方必须标注“未实读”）；
 * - `{ok:false, reason:"aapt-failed", detail}`：有工具但执行/解析失败——这是环境错误，必须 FAIL。
 */
export function readApkBadging(apkFile) {
	const tools = findApkTools();
	if (tools.length === 0) return { ok: false, reason: "aapt-not-found" };
	const failures = [];
	for (const tool of tools) {
		const r = spawnSync(tool, ["dump", "badging", apkFile], { encoding: "utf8" });
		if (r.error || r.status !== 0) {
			failures.push(`${path.basename(tool)}: ${r.error?.message ?? `exit ${r.status}`}`);
			continue;
		}
		const parsed = parseBadging(r.stdout ?? "");
		if (!parsed) {
			failures.push(`${path.basename(tool)}: 输出无法解析`);
			continue;
		}
		return { ok: true, source: path.basename(tool), ...parsed };
	}
	return { ok: false, reason: "aapt-failed", detail: failures.join("; ") };
}

// ── 主包 package.json：载体依赖必须是精确 npm 别名（设计稿 §5.1 / P0 实测 C3）──────────

/**
 * P0 实测：范围别名 `npm:...@^3.2.0` 会把**主插件**装进别名目录（错误绑定）；
 * `^X.Y.Z-app` 同时命中 `X.Y.Z` 与 `X.Y.Z-app`（歧义）；`latest` 会随时间漂移。
 * 因此生产主包只允许逐字符等于 `npm:<同包名>@<version>-app`。
 */
export function exactCarrierAliasChecks(pkg) {
	const checks = [];
	const name = typeof pkg?.name === "string" ? pkg.name : "";
	const version = typeof pkg?.version === "string" ? pkg.version : "";
	const alias = name ? carrierAlias(name) : "";
	const expected = name && /^\d+\.\d+\.\d+$/.test(version) ? carrierDependencySpec(name, version) : "";
	const optional = pkg?.optionalDependencies && typeof pkg.optionalDependencies === "object"
		? pkg.optionalDependencies
		: {};
	const declared = alias !== "" && Object.hasOwn(optional, alias);
	const spec = declared ? String(optional[alias]) : "";

	checks.push({
		name: "主包 package.json 在 optionalDependencies 声明载体别名",
		pass: declared,
		detail: declared ? alias : `缺少 ${alias || "<别名>"}（只允许 optionalDependencies）`,
	});
	checks.push({
		name: "载体依赖是精确 npm 别名（禁 range/^/~）",
		pass: declared && expected !== "" && spec === expected,
		detail: `spec=${spec || "<未声明>"} 期望=${expected || "<无法推导>"}`,
	});
	const target = /^npm:(@[^@/\s]+\/[^@/\s]+|[^@/\s]+)@(.+)$/.exec(spec);
	checks.push({
		name: "载体别名目标版本是 X.Y.Z-app（不是 latest/tag/range）",
		pass: target !== null && /^\d+\.\d+\.\d+-app$/.test(target[2]),
		detail: `target=${target?.[2] ?? "<无法解析>"}`,
	});
	checks.push({
		name: "载体别名目标包名与主包同包名",
		pass: target !== null && target[1] === name,
		detail: `target=${target?.[1] ?? "<无法解析>"} 主包=${name || "<未知>"}`,
	});
	checks.push({
		name: "载体别名不含范围/标签写法（无 ^ ~ > < = * | 空格 / latest）",
		pass: declared && !/[\^~><=*| ]/.test(spec) && !/\blatest\b/i.test(spec),
		detail: `spec=${spec || "<未声明>"}`,
	});
	const bundled = [
		...(Array.isArray(pkg?.bundleDependencies) ? pkg.bundleDependencies : []),
		...(Array.isArray(pkg?.bundledDependencies) ? pkg.bundledDependencies : []),
	];
	checks.push({
		name: "载体不进 bundled 依赖（数据依赖不随插件冻结/复制）",
		pass: alias !== "" && !bundled.includes(alias),
		detail: alias || "<未知>",
	});
	const dependencies = pkg?.dependencies && typeof pkg.dependencies === "object" ? pkg.dependencies : {};
	checks.push({
		name: "载体别名不同时出现在普通 dependencies",
		pass: !(alias !== "" && Object.hasOwn(dependencies, alias)),
		detail: alias || "<未知>",
	});
	return checks;
}

// ── 载体包 package.json：数据角色红线 + 两条版本严格配对（设计稿 §5.1 / Q17）────────────

export function carrierPackageChecks(pkg, { expectedName, expectedVersion, expectedFiles = [] } = {}) {
	const checks = [];
	checks.push({
		name: "载体包名与主插件一致（同包名，仅版本 -app 区分）",
		code: "carrier-name-mismatch",
		pass: typeof expectedName === "string" && expectedName !== "" && pkg?.name === expectedName,
		detail: `carrier=${pkg?.name ?? "<缺失>"} 主包=${expectedName || "<未知>"}`,
	});
	checks.push({
		name: "载体包名不含平台 token",
		code: "carrier-name-platform-token",
		pass: typeof pkg?.name === "string" && pkg.name !== "" && !containsPlatformToken(pkg.name),
		detail: `name=${pkg?.name ?? "<缺失>"}`,
	});
	checks.push({
		name: "两条版本严格配对（主插件 X.Y.Z ↔ 载体 X.Y.Z-app）",
		code: "carrier-version-pairing-mismatch",
		pass: typeof expectedVersion === "string" && pkg?.version === expectedVersion,
		detail: `carrier=${pkg?.version ?? "<缺失>"} 期望=${expectedVersion || "<未知>"}`,
	});
	checks.push({
		name: "载体版本不含平台 token",
		code: "carrier-version-platform-token",
		pass: typeof pkg?.version === "string" && pkg.version !== "" && !containsPlatformToken(pkg.version),
		detail: `version=${pkg?.version ?? "<缺失>"}`,
	});
	checks.push({
		name: "载体声明数据角色 dsh.appCarrier === true",
		code: "carrier-role-marker-missing",
		pass: pkg?.dsh?.appCarrier === true,
		detail: `dsh=${JSON.stringify(pkg?.dsh ?? null)}`,
	});
	checks.push({
		name: "载体无 dsh.bundle（不承担插件 bundle 角色）",
		code: "carrier-bundle-forbidden",
		pass: !(pkg?.dsh && typeof pkg.dsh === "object" && Object.hasOwn(pkg.dsh, "bundle")),
		detail: `dsh=${JSON.stringify(pkg?.dsh ?? null)}`,
	});
	checks.push({
		name: "载体无平台字段（os/cpu/libc）",
		code: "carrier-platform-field-forbidden",
		pass: !CARRIER_FORBIDDEN_FIELDS.slice(0, 3).some((field) => Object.hasOwn(pkg ?? {}, field)),
		detail: CARRIER_FORBIDDEN_FIELDS.slice(0, 3)
			.filter((field) => Object.hasOwn(pkg ?? {}, field))
			.map((field) => `${field}=${JSON.stringify(pkg[field])}`)
			.join(" ") || "无",
	});
	checks.push({
		name: "载体无运行入口（bin/main/exports）",
		code: "carrier-entry-field-forbidden",
		pass: !["bin", "main", "exports"].some((field) => Object.hasOwn(pkg ?? {}, field)),
		detail: ["bin", "main", "exports"].filter((field) => Object.hasOwn(pkg ?? {}, field)).join(",") || "无",
	});
	const scripts = pkg?.scripts && typeof pkg.scripts === "object" ? Object.keys(pkg.scripts) : [];
	checks.push({
		name: "载体无安装期执行钩子（scripts 必须为空）",
		code: "carrier-scripts-forbidden",
		pass: scripts.length === 0,
		detail: scripts.length === 0 ? "无" : `scripts=${scripts.join(",")}`,
	});
	const extraDsh = pkg?.dsh && typeof pkg.dsh === "object"
		? Object.keys(pkg.dsh).filter((key) => key !== "appCarrier")
		: [];
	checks.push({
		name: "载体 dsh 字段仅含 appCarrier 标记",
		code: "carrier-dsh-extra-field",
		pass: extraDsh.length === 0,
		detail: extraDsh.length === 0 ? "ok" : `多余字段=${extraDsh.join(",")}`,
	});
	const files = Array.isArray(pkg?.files) ? [...pkg.files].sort() : [];
	const wanted = [...expectedFiles].sort();
	checks.push({
		name: "载体 files 精确为 APK + manifest.json + README.md + LICENSE",
		code: "carrier-files-mismatch",
		pass: wanted.length > 0 && arraysEqual(files, wanted),
		detail: `files=${files.join(",") || "<缺失>"} 期望=${wanted.join(",") || "<未知>"}`,
	});
	checks.push({
		name: "载体不得把自身或主插件打进包（无 node_modules/lib 内容）",
		code: "carrier-dependencies-forbidden",
		pass: !Object.hasOwn(pkg ?? {}, "dependencies") || Object.keys(pkg.dependencies ?? {}).length === 0,
		detail: pkg?.dependencies ? `dependencies=${Object.keys(pkg.dependencies).join(",")}` : "无",
	});
	return checks;
}

// ── 载体 npm 发布元数据（P3-A：载体发布到 npm，dist-tag 固定 app、绝不 latest）───────────
//
// 只用于「发布前预检」与「构建器自检」，不改变运行期数据角色判定（carrierPackageChecks）。
// 依据 issue #36 P3-A：载体 X.Y.Z-app 是 semver prerelease，`^X.Y.Z` 不会匹配它，
// 因此必须显式发布并打 `app` dist-tag；主包用精确别名 optionalDependencies 引入。
// npm 拒绝发布 `private: true` 的包；scoped 包公开发布需要 publishConfig.access=public。

function repositoryUrl(pkg) {
	const repo = pkg?.repository;
	if (typeof repo === "string") return repo;
	if (repo && typeof repo === "object" && typeof repo.url === "string") return repo.url;
	return "";
}

/**
 * 载体 package.json 的 npm 发布元数据断言（stable reason code 供发布预检输出）。
 * @param {object} pkg 载体 package.json
 * @param {{mainPkg?: object|null, expectedName?: string, expectedVersion?: string, expectedFiles?: string[]}} [options]
 */
export function carrierPublishMetadataChecks(pkg, {
	mainPkg = null,
	expectedName = "",
	expectedVersion = "",
	expectedFiles = [],
} = {}) {
	const checks = [];
	const name = typeof pkg?.name === "string" ? pkg.name : "";
	const version = typeof pkg?.version === "string" ? pkg.version : "";
	const publishConfig = pkg?.publishConfig && typeof pkg.publishConfig === "object" ? pkg.publishConfig : {};
	const files = Array.isArray(pkg?.files) ? pkg.files.map(String) : [];
	const apkFile = expectedFiles.find((file) => /\.apk$/i.test(String(file))) ?? "";
	const license = typeof pkg?.license === "string" ? pkg.license : "";
	const description = typeof pkg?.description === "string" ? pkg.description : "";
	const repoUrl = repositoryUrl(pkg);

	checks.push({
		code: "carrier-publish-name-mismatch",
		name: "发布包名与主包一致（同包名 + -app 版本区分）",
		pass: expectedName === "" ? name !== "" : name === expectedName,
		detail: `carrier=${name || "<缺失>"} 期望=${expectedName || "<未知>"}`,
	});
	checks.push({
		code: "carrier-publish-version-not-app-suffix",
		name: "发布版本是 semver 预发布 X.Y.Z-app（npm 范围依赖不会误匹配）",
		pass: /^\d+\.\d+\.\d+-app$/.test(version),
		detail: `version=${version || "<缺失>"}`,
	});
	checks.push({
		code: "carrier-publish-version-mismatch",
		name: "发布版本与主插件版本严格配对（主插件 X.Y.Z ↔ 载体 X.Y.Z-app）",
		pass: expectedVersion !== "" && version === expectedVersion,
		detail: `carrier=${version || "<缺失>"} 期望=${expectedVersion || "<未知>"}`,
	});
	checks.push({
		code: "carrier-publish-private-not-false",
		name: "private 必须显式为 false（npm 拒绝发布 private 包）",
		pass: pkg?.private === false,
		detail: `private=${JSON.stringify(pkg?.private ?? "<缺失>")}`,
	});
	checks.push({
		code: "carrier-publish-access-not-public",
		name: "publishConfig.access 必须是 public（scoped 包公开发布）",
		pass: publishConfig.access === "public",
		detail: `access=${publishConfig.access ?? "<缺失>"}`,
	});
	checks.push({
		code: "carrier-publish-tag-not-app",
		name: "publishConfig.tag 必须是 app（dist-tag 固定 app，绝不用 latest）",
		pass: publishConfig.tag === "app",
		detail: `tag=${publishConfig.tag ?? "<缺失>"}`,
	});
	checks.push({
		code: "carrier-publish-tag-latest",
		name: "publishConfig.tag 不得是 latest（载体不能成为默认安装版本）",
		pass: publishConfig.tag !== "latest",
		detail: `tag=${publishConfig.tag ?? "<缺失>"}`,
	});
	checks.push({
		code: "carrier-publish-files-missing-apk",
		name: "files 必须包含 APK 本体",
		pass: apkFile !== "" && files.includes(apkFile),
		detail: `files=${files.join(",") || "<缺失>"} apk=${apkFile || "<未知>"}`,
	});
	checks.push({
		code: "carrier-publish-files-missing-manifest",
		name: "files 必须包含 manifest.json（随包完整发布清单）",
		pass: files.includes("manifest.json"),
		detail: `files=${files.join(",") || "<缺失>"}`,
	});
	checks.push({
		code: "carrier-publish-license-missing",
		name: "license 非空（随包许可）",
		pass: license.trim() !== "",
		detail: `license=${license || "<缺失>"}`,
	});
	if (mainPkg && typeof mainPkg.license === "string" && mainPkg.license !== "") {
		checks.push({
			code: "carrier-publish-license-mismatch",
			name: "license 继承主包（同一许可证）",
			pass: license === mainPkg.license,
			detail: `carrier=${license || "<缺失>"} 主包=${mainPkg.license}`,
		});
	}
	checks.push({
		code: "carrier-publish-description-missing",
		name: "description 非空（npm 页面可读说明）",
		pass: description.trim() !== "",
		detail: `description=${description ? description.slice(0, 40) : "<缺失>"}`,
	});
	checks.push({
		code: "carrier-publish-repository-missing",
		name: "repository 非空（来源可追溯）",
		pass: repoUrl !== "",
		detail: `repository=${repoUrl || "<缺失>"}`,
	});
	if (mainPkg && repositoryUrl(mainPkg) !== "") {
		checks.push({
			code: "carrier-publish-repository-mismatch",
			name: "repository 继承主包",
			pass: repoUrl === repositoryUrl(mainPkg),
			detail: `carrier=${repoUrl || "<缺失>"} 主包=${repositoryUrl(mainPkg)}`,
		});
	}
	return checks;
}

// ── APK 身份：清单 app 段 与 APK 本体/文件名/内部版本一致（F17/R9）──────────────────────

/**
 * 清单 app 段与插件版本/文件名的配对（**不需要** Android 工具，任何模式都可断言）。
 * @param {{app:object, pluginVersion:string}} input
 */
export function apkManifestIdentityChecks({ app, pluginVersion }) {
	const checks = [];
	const appVersion = parseVersion(app?.version);
	const fileVersion = apkVersionFromFilename(app?.file);
	checks.push({
		name: "app.file 命名符合发布产物 DSH-Remote-vX.Y.Z.apk",
		pass: fileVersion !== null,
		detail: `app.file=${app?.file ?? "<缺失>"}`,
	});
	checks.push({
		name: "app.version 为 X.Y.Z+N（保留真实构建号，不抹成纯语义版本）",
		pass: appVersion !== null && appVersion.build !== null,
		detail: `app.version=${app?.version ?? "<缺失>"}`,
	});
	checks.push({
		name: "app.version 语义版本与 plugin.version 严格配对",
		pass: appVersion !== null && appVersion.version === pluginVersion,
		detail: `app=${appVersion?.version ?? "<无法解析>"} plugin=${pluginVersion ?? "<缺失>"}`,
	});
	checks.push({
		name: "app.version 与 APK 文件名版本一致",
		pass: appVersion !== null && fileVersion !== null && appVersion.version === fileVersion,
		detail: `app=${appVersion?.version ?? "<无法解析>"} 文件名=${fileVersion ?? "<不符合约定>"}`,
	});
	return checks;
}

/**
 * APK **内部** versionName/versionCode 实读（F17/R9）。只在发布门禁（配对模式）与构建器里跑：
 * 旧版单产物夹具用的是假 APK 字节，若在兼容模式无条件实读，装了 Android 构建工具的机器上
 * 会把历史契约测试误杀——所以「实读优先、缺工具退化」的断言属于发布路径，而不是通用解析。
 * @param {{dir:string, app:object}} input `dir` 是 APK 所在目录。
 */
export function apkInternalVersionChecks({ dir, app }) {
	const checks = [];
	const appVersion = parseVersion(app?.version);
	const apkFile = typeof app?.file === "string" && app.file !== "" && dir ? path.join(dir, app.file) : "";
	const read = apkFile !== "" && fs.existsSync(apkFile)
		? readApkBadging(apkFile)
		: { ok: false, reason: "apk-missing" };
	if (read.ok) {
		checks.push({
			name: "app.version 与 APK 内部值一致（aapt 实读 versionName/versionCode）",
			pass: read.versionName === appVersion?.version && read.versionCode === appVersion?.build,
			detail: `实读 versionName=${read.versionName} versionCode=${read.versionCode}（${read.source}）`,
		});
	} else if (read.reason === "aapt-not-found") {
		// fail-closed 允许的**唯一**降级：环境没有 Android 构建工具时明确标注“未实读”，
		// 但仍要求文件名+清单一致（上面四条已覆盖），不得把缺工具当成一致。
		checks.push({
			name: "APK 内部版本未实读（环境无 aapt/aapt2）：退化为文件名+清单一致性",
			pass: true,
			detail: "未实读（安装 Android build-tools 后可实读 versionName/versionCode）",
		});
	} else if (read.reason === "apk-missing") {
		checks.push({
			name: "APK 内部版本实读",
			pass: false,
			detail: "APK 缺失，无法实读",
		});
	} else {
		checks.push({
			name: "APK 内部版本实读（有 aapt/aapt2 却执行/解析失败必须 FAIL）",
			pass: false,
			detail: read.detail ?? "unknown",
		});
	}
	return checks;
}

/** 清单 app 段的全量身份检查（配对模式/构建器用）：配对 + APK 内部版本实读或显式降级。 */
export function apkIdentityChecks({ dir, app, pluginVersion }) {
	return [...apkManifestIdentityChecks({ app, pluginVersion }), ...apkInternalVersionChecks({ dir, app })];
}

// ── 载体 tarball 内容：文件清单 + 内嵌清单 + 内嵌 APK + 与本地插件 tgz 的身份 ────────────

/**
 * 校验解包后的载体目录（`package/` 内容）与已解包文件清单、发布清单、本地插件 tgz 的一致性。
 * @param {{
 *   carrierDir: string,       解包后的 carrier 根（含 package.json）
 *   entries: string[],        packedFiles() 的结果（包内相对文件，排序）
 *   manifest: object,         dist 内发布清单（schema 1）
 *   mainPkgName: string,      主包真实包名（来自主包 package.json）
 *   pluginTgzFile: string,    本地实际插件 tgz 路径（用于核对清单里的 tgz 哈希来源）
 * }} input
 */
export function carrierContentsChecks({ carrierDir, entries, manifest, mainPkgName, pluginTgzFile }) {
	const checks = [];
	const app = manifest?.app ?? {};
	const plugin = manifest?.plugin ?? {};
	const apkName = typeof app.file === "string" ? app.file : "";
	const expectedEntries = ["LICENSE", "README.md", "package.json", "manifest.json", apkName].filter(Boolean).sort();
	checks.push({
		name: "载体 tarball 仅含 APK + 清单 + README + LICENSE（无插件代码/依赖）",
		code: "carrier-entries-mismatch",
		pass: expectedEntries.length === 5 && arraysEqual([...entries].sort(), expectedEntries),
		detail: `entries=${entries.join(",") || "<空>"}`,
	});

	const carrierPkgFile = path.join(carrierDir, "package.json");
	const carrierPkg = readJsonFile(carrierPkgFile);
	checks.push({
		name: "载体包 package.json 可解析",
		code: "carrier-package-json-missing",
		pass: carrierPkg.ok,
		detail: carrierPkg.ok ? carrierPkgFile : String(carrierPkg.error),
	});
	if (carrierPkg.ok) {
		checks.push(...carrierPackageChecks(carrierPkg.value, {
			expectedName: mainPkgName,
			expectedVersion: expectedCarrierVersion(plugin.version),
			expectedFiles: [apkName, "manifest.json", "README.md", "LICENSE"].filter(Boolean),
		}));
	}

	const embeddedManifest = readJsonFile(path.join(carrierDir, "manifest.json"));
	checks.push({
		name: "载体 tarball 内发布清单可解析",
		code: "carrier-manifest-missing",
		pass: embeddedManifest.ok,
		detail: embeddedManifest.ok ? "manifest.json" : String(embeddedManifest.error),
	});
	if (embeddedManifest.ok) {
		checks.push({
			name: "载体 tarball 内清单与 dist/manifest.json 逐字段一致",
			code: "carrier-manifest-mismatch",
			pass: JSON.stringify(sortObject(embeddedManifest.value)) === JSON.stringify(sortObject(manifest)),
			detail: "随包清单必须就是发布清单本身，不能重新拼装",
		});
	}

	const embeddedApk = apkName === "" ? "" : path.join(carrierDir, apkName);
	if (embeddedApk !== "" && fs.existsSync(embeddedApk)) {
		const buf = fs.readFileSync(embeddedApk);
		checks.push({
			name: "载体 tarball 内 APK 大小与清单 app.size 一致",
			code: "carrier-apk-size-mismatch",
			pass: app.size === buf.length,
			detail: `清单=${app.size ?? "<缺失>"} 实际=${buf.length}`,
		});
		checks.push({
			name: "载体 tarball 内 APK 哈希与清单 app.sha256 一致",
			code: "carrier-apk-sha256-mismatch",
			pass: app.sha256 === sha256Buffer(buf),
			detail: `清单=${app.sha256 ?? "<缺失>"} 实际=${sha256Buffer(buf)}`,
		});
	} else {
		checks.push({ code: "carrier-apk-missing", name: "载体 tarball 内 APK 存在", pass: false, detail: `缺少 ${apkName || "<apk 名>"}` });
		checks.push({ code: "carrier-apk-size-mismatch", name: "载体 tarball 内 APK 大小与清单 app.size 一致", pass: false, detail: "APK 缺失" });
		checks.push({ code: "carrier-apk-sha256-mismatch", name: "载体 tarball 内 APK 哈希与清单 app.sha256 一致", pass: false, detail: "APK 缺失" });
	}

	// 清单里插件段的哈希必须来自**本地实际 tgz**（构建顺序：先 tgz 后载体；无自指循环）。
	if (pluginTgzFile && fs.existsSync(pluginTgzFile)) {
		const tgzBuf = fs.readFileSync(pluginTgzFile);
		checks.push({
			name: "载体清单的 plugin.size 来自本地实际插件 tgz",
			code: "carrier-plugin-size-mismatch",
			pass: plugin.size === tgzBuf.length,
			detail: `清单=${plugin.size ?? "<缺失>"} 实际=${tgzBuf.length}`,
		});
		checks.push({
			name: "载体清单的 plugin.sha256 来自本地实际插件 tgz",
			code: "carrier-plugin-sha256-mismatch",
			pass: plugin.sha256 === sha256Buffer(tgzBuf),
			detail: `清单=${plugin.sha256 ?? "<缺失>"} 实际=${sha256Buffer(tgzBuf)}`,
		});
	} else {
		checks.push({ name: "载体清单的 plugin.sha256 来自本地实际插件 tgz", pass: false, detail: "缺少本地插件 tgz" });
	}
	return checks;
}

function expectedCarrierVersion(pluginVersion) {
	return typeof pluginVersion === "string" && pluginVersion !== "" ? carrierVersion(pluginVersion) : "";
}

/** 构建记录（app-carrier.json）与清单/载体 tarball 的体积哈希一致性（§5.2 发布记录 / R10）。 */
export function carrierRecordChecks(record, { carrierFile, manifest }) {
	const checks = [];
	checks.push({ code: "carrier-record-missing", name: "载体构建记录 app-carrier.json 可解析", pass: record !== null && typeof record === "object", detail: "schema 1" });
	if (record === null || typeof record !== "object") return checks;
	checks.push({ code: "carrier-record-schema-mismatch", name: "载体构建记录 schema = 1", pass: record.schema === 1, detail: `schema=${record.schema}` });
	checks.push({
		name: "载体构建记录 name/version 与载体包一致（X.Y.Z-app）",
		code: "carrier-record-identity-mismatch",
		pass: typeof record.name === "string" && record.name !== ""
			&& record.version === carrierVersion(manifest?.plugin?.version ?? ""),
		detail: `name=${record.name ?? "<缺失>"} version=${record.version ?? "<缺失>"}`,
	});
	checks.push({
		name: "载体构建记录 file 与载体 tarball 文件名一致",
		code: "carrier-record-file-mismatch",
		pass: typeof record.file === "string" && record.file === path.basename(carrierFile),
		detail: `记录=${record.file ?? "<缺失>"} 实际=${path.basename(carrierFile)}`,
	});
	let stat = null;
	try {
		stat = fs.statSync(carrierFile);
	} catch {
		stat = null;
	}
	const actualSha = stat ? sha256File(carrierFile) : "";
	checks.push({
		name: "载体 tarball 体积/哈希与构建记录一致（清单无法自指，故用构建记录）",
		code: "carrier-record-carrier-mismatch",
		pass: stat !== null && record.size === stat.size && record.sha256 === actualSha,
		detail: `记录 size=${record.size ?? "<缺失>"} sha256=${record.sha256 ?? "<缺失>"}；实际 size=${stat?.size ?? "<缺失>"} sha256=${actualSha || "<缺失>"}`,
	});
	const recorded = record.manifest && typeof record.manifest === "object" ? record.manifest : {};
	checks.push({
		name: "构建记录 app 段身份与发布清单一致",
		code: "carrier-record-manifest-app-mismatch",
		pass: JSON.stringify(objectPick(recorded.app ?? {}, MANIFEST_APP_FIELDS))
			=== JSON.stringify(objectPick(manifest?.app ?? {}, MANIFEST_APP_FIELDS)),
		detail: "version/file/size/sha256",
	});
	checks.push({
		name: "构建记录 plugin 段身份与发布清单一致",
		code: "carrier-record-manifest-plugin-mismatch",
		pass: JSON.stringify(objectPick(recorded.plugin ?? {}, MANIFEST_PLUGIN_FIELDS))
			=== JSON.stringify(objectPick(manifest?.plugin ?? {}, MANIFEST_PLUGIN_FIELDS)),
		detail: "version/file/size/sha256/contentSha256",
	});
	return checks;
}

/** 把 `{name, pass, detail}` 列表交给调用方的打印函数。 */
export function reportChecks(checks, print) {
	for (const item of checks) print(item.name, item.pass, item.detail ?? "");
}
