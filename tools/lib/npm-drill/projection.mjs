// 演练产物投影：把**真实发布目录**（dist）投影成可发布到临时 registry 的演练产物。
//
// 为什么需要投影：npm 版本不可回收，演练必须用一次性演练版本（9.9.<随机补丁号>，纯 X.Y.Z；
// 载体为同名加 -app——运行时载体发现要求插件版本必须是纯 X.Y.Z），而发布目录里的
// 包版本是正式版本。投影只改「分发身份」（package.json version 与插件可选别名），保留其余全部
// 内容（APK、载体数据角色、发布元数据、README/LICENSE、lib 代码；清单 app.version 的语义部分
// 会投影成演练版本、保留构建号与 APK 字节身份，见 phases.mjs A12 与手册 §6.4），并重算
// 插件内容标识，使「安装后的内容标识 == 演练清单」这条断言仍有意义。
//
// 同时提供失败路径所需的受控夹具：篡改载体发布元数据 / 版本配对错误 —— 只写临时目录，
// 绝不修改真实发布目录。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pluginContentDigest } from "../../../lib/plugin-content-digest.js";
import { sha256Buffer, sha256File, tarExtract } from "../../../dsh-mobile-app/tools/lib/release-checks.mjs";
import {
	ensureDir, existsFile, linkOrCopyFile, readTextFile, runCommand, writeTextFile,
} from "./process.mjs";
import { REASONS } from "./reasons.mjs";

// publish-carrier-check 属于 **App 发布链**（dsh-mobile-app/tools）：演练只读调用它。
// 本模块位于仓库根 tools/lib/npm-drill/，故需跨到 dsh-mobile-app/tools。
const TOOLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../dsh-mobile-app/tools");

/** 读取并校验发布目录的配对产物（清单 / 构建记录 / APK / 插件 tgz / 载体 tgz）。 */
export function readDistAssets(distDir) {
	const problems = [];
	const readJson = (file, label) => {
		try {
			return JSON.parse(readTextFile(file));
		} catch (error) {
			problems.push(`${label}-unreadable: ${String(error?.message ?? error)}`);
			return null;
		}
	};
	if (!existsFile(path.join(distDir, "manifest.json"))) {
		return { ok: false, problems: ["manifest-missing"] };
	}
	const manifest = readJson(path.join(distDir, "manifest.json"), "manifest");
	const record = readJson(path.join(distDir, "app-carrier.json"), "app-carrier");
	if (manifest === null || record === null) return { ok: false, problems };
	const pluginTgz = typeof manifest?.plugin?.file === "string" ? path.join(distDir, manifest.plugin.file) : "";
	const apk = typeof manifest?.app?.file === "string" ? path.join(distDir, manifest.app.file) : "";
	const carrierTgz = typeof record?.file === "string" ? path.join(distDir, record.file) : "";
	if (!pluginTgz || !existsFile(pluginTgz)) problems.push(`plugin-tgz-missing: ${manifest?.plugin?.file ?? "<缺失>"}`);
	if (!apk || !existsFile(apk)) problems.push(`apk-missing: ${manifest?.app?.file ?? "<缺失>"}`);
	if (!carrierTgz || !existsFile(carrierTgz)) problems.push(`carrier-tgz-missing: ${record?.file ?? "<缺失>"}`);
	if (problems.length > 0) return { ok: false, problems };
	return { ok: true, problems: [], distDir, manifest, record, pluginTgz, apk, carrierTgz };
}

/**
 * R2：**投影之前**钉住源产物不变量。评审复现指出：直接用合成正确的主包元数据做预检，
 * 会把"源插件缺载体依赖 / 源清单内容标识错误"的坏产物修好后放行。这里改为从源插件 tgz
 * 解包读取真实 package.json，逐项核验后再允许投影：
 *   1. 源插件 tgz 字节与清单 plugin.size/sha256 一致；
 *   2. 包内 name 非空、version == 清单 plugin.version；
 *   3. optionalDependencies 含精确别名 `npm:<name>@<version>-app`；
 *   4. 用解包后的真实包内容实算内容标识 == 清单 plugin.contentSha256；
 *   5. 对**源 dist** 跑现有发布预检（--package-json 用真实包内 package.json，不合成）。
 * 返回 `{ok, reason, detail, packageDir, packageJson, name, version, contentSha256}`。
 */
export async function validateSourceArtifacts({ assets, workDir, env, logFile }) {
	if (!assets?.ok) {
		return { ok: false, reason: REASONS.DIST_UNREADABLE, detail: (assets?.problems ?? ["assets-unreadable"]).join("; ") };
	}
	const manifest = assets.manifest ?? {};
	const pluginSegment = manifest.plugin ?? {};
	const extractDir = path.join(workDir, "source-plugin");
	const extract = tarExtract(assets.pluginTgz, extractDir);
	if (!extract.ok) {
		return { ok: false, reason: REASONS.SOURCE_ARTIFACT_MISMATCH, detail: `插件 tgz 解包失败：${extract.error}` };
	}
	const root = path.join(extractDir, "package");
	let pkg;
	try {
		pkg = readPackageJson(root);
	} catch (error) {
		return { ok: false, reason: REASONS.SOURCE_PLUGIN_METADATA_MISMATCH, detail: `源插件 package.json 不可读：${String(error?.message ?? error)}` };
	}
	// 1) 源插件 tgz 字节身份 = 源清单 plugin 段
	const size = fs.statSync(assets.pluginTgz).size;
	const sha256 = sha256File(assets.pluginTgz);
	if (size !== pluginSegment.size || sha256 !== pluginSegment.sha256) {
		return {
			ok: false,
			reason: REASONS.SOURCE_ARTIFACT_MISMATCH,
			detail: `plugin tgz 实际 size=${size} sha256=${sha256}；清单 size=${pluginSegment.size ?? "<缺>"} sha256=${pluginSegment.sha256 ?? "<缺>"}`,
		};
	}
	// 2) 真实包内 name/version 与清单一致
	if (typeof pkg.name !== "string" || pkg.name === "" || pkg.version !== pluginSegment.version) {
		return {
			ok: false,
			reason: REASONS.SOURCE_PLUGIN_METADATA_MISMATCH,
			detail: `包内 name=${pkg.name ?? "<缺>"} version=${pkg.version ?? "<缺>"}；清单 plugin.version=${pluginSegment.version ?? "<缺>"}`,
		};
	}
	// 3) 精确可选载体别名（缺声明/范围声明/指向别的名字都不放行）
	const carrierAlias = `${pkg.name}-app`;
	const expectedAlias = `npm:${pkg.name}@${pkg.version}-app`;
	const actualAlias = pkg.optionalDependencies?.[carrierAlias];
	if (actualAlias !== expectedAlias) {
		return {
			ok: false,
			reason: REASONS.SOURCE_OPTIONAL_ALIAS_MISSING,
			detail: `${carrierAlias}=${actualAlias ?? "<未声明>"} 期望=${expectedAlias}`,
		};
	}
	// 4) 用真实包内容实算内容标识，与源清单比对（不是投影后重算的值）
	const contentSha256 = pluginContentDigest(root);
	if (contentSha256 !== pluginSegment.contentSha256) {
		return {
			ok: false,
			reason: REASONS.SOURCE_CONTENT_DIGEST_MISMATCH,
			detail: `实算 contentSha256=${contentSha256}；源清单=${pluginSegment.contentSha256 ?? "<缺>"}`,
		};
	}
	// 5) 对源 dist 跑现有发布预检：主包元数据取自**真实包内 package.json**（不是合成副本）
	const preflight = await runPublishCarrierCheck({
		distDir: assets.distDir,
		mainPkgPath: path.join(root, "package.json"),
		env,
		logFile,
	});
	if (!preflight.ok) {
		return {
			ok: false,
			reason: REASONS.DIST_PREFLIGHT_FAILED,
			detail: `reasons=${preflight.reasons.join(",") || "unknown"}`,
		};
	}
	return { ok: true, packageDir: root, packageJson: pkg, name: pkg.name, version: pkg.version, contentSha256 };
}

function parsePackJson(stdout) {
	const start = String(stdout ?? "").indexOf("[");
	const end = String(stdout ?? "").lastIndexOf("]");
	if (start === -1 || end === -1 || end <= start) return null;
	try {
		return JSON.parse(String(stdout).slice(start, end + 1));
	} catch {
		return null;
	}
}

async function npmPack({ dir, destination, env, logFile, label }) {
	const result = await runCommand({
		command: "npm",
		args: ["pack", "--pack-destination", destination, "--json", "--ignore-scripts"],
		cwd: dir,
		env,
		logFile,
		timeoutMs: 300_000,
		label,
	});
	if (!result.ok) {
		return { ok: false, error: (result.error ?? result.stderr ?? result.stdout ?? "npm-pack-failed").trim().slice(-800) };
	}
	const info = parsePackJson(result.stdout);
	const filename = info?.[0]?.filename;
	if (typeof filename !== "string" || !existsFile(path.join(destination, filename))) {
		return { ok: false, error: `npm-pack-output-unparsable: ${String(result.stdout).slice(0, 200)}` };
	}
	const tarball = path.join(destination, filename);
	const size = fs.statSync(tarball).size;
	return { ok: true, tarball, filename, size, sha256: sha256File(tarball) };
}

function readPackageJson(packageDir) {
	return JSON.parse(readTextFile(path.join(packageDir, "package.json")));
}

function writePackageJson(packageDir, pkg) {
	writeTextFile(path.join(packageDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
}

/**
 * 投影主插件：改 version 与载体可选别名（指向演练载体版本），重算内容标识，npm pack。
 * @returns {Promise<{ok:boolean,error?:string,packageDir?:string,packageJson?:object,tarball?:string,filename?:string,size?:number,sha256?:string,contentSha256?:string}>}
 */
export async function projectPlugin({ sourceTgz, workDir, name, version, carrierVersion, env, logFile, label }) {
	const packageDir = path.join(workDir, `plugin-${version}`);
	const extract = tarExtract(sourceTgz, packageDir);
	if (!extract.ok) return { ok: false, error: `extract-failed: ${extract.error}` };
	const root = path.join(packageDir, "package");
	let pkg;
	try {
		pkg = readPackageJson(root);
	} catch (error) {
		return { ok: false, error: `package-json-unreadable: ${String(error?.message ?? error)}` };
	}
	pkg.version = version;
	pkg.optionalDependencies = { ...(pkg.optionalDependencies ?? {}), [`${name}-app`]: `npm:${name}@${carrierVersion}` };
	writePackageJson(root, pkg);
	const packed = await npmPack({ dir: root, destination: workDir, env, logFile, label: label ?? `npm pack plugin ${version}` });
	if (!packed.ok) return packed;
	return {
		ok: true,
		packageDir: root,
		packageJson: pkg,
		pluginVersion: version,
		contentSha256: pluginContentDigest(root),
		...packed,
	};
}

/**
 * 投影 App 载体：改版本 + 重写随包清单的 `plugin` 段（指向本演练的插件投影），保留 app 段、
 * 顶层兼容镜像、发布元数据与数据角色标记，npm pack。
 */
export async function projectCarrier({ sourceTgz, workDir, version, manifest, pluginProject, env, logFile, label }) {
	const packageDir = path.join(workDir, `carrier-${version}`);
	const extract = tarExtract(sourceTgz, packageDir);
	if (!extract.ok) return { ok: false, error: `extract-failed: ${extract.error}` };
	const root = path.join(packageDir, "package");
	let pkg;
	try {
		pkg = readPackageJson(root);
	} catch (error) {
		return { ok: false, error: `package-json-unreadable: ${String(error?.message ?? error)}` };
	}
	pkg.version = version;
	writePackageJson(root, pkg);
	// 清单投影：运行时载体发现要求「插件版本是纯 X.Y.Z，且清单 app 版本语义部分 == 插件版本」。
	// 因此把 app.version 的语义部分投影成演练插件版本、保留原构建号 +N；APK 的 file/size/sha256
	// 不变（字节还是真实 APK），顶层兼容镜像同步成投影后的 app 段。
	const sourceAppVersion = String(manifest?.app?.version ?? "");
	const buildMatch = /^\d+\.\d+\.\d+\+(\d+)$/.exec(sourceAppVersion);
	if (!buildMatch) return { ok: false, error: `source-app-version-unparsable: ${sourceAppVersion}` };
	const projectedAppVersion = `${pluginProject.pluginVersion}+${buildMatch[1]}`;
	const nextManifest = structuredClone(manifest);
	nextManifest.app = { ...manifest.app, version: projectedAppVersion };
	nextManifest.plugin = {
		...manifest.plugin,
		version: pluginProject.pluginVersion,
		file: pluginProject.filename,
		size: pluginProject.size,
		sha256: pluginProject.sha256,
		contentSha256: pluginProject.contentSha256,
	};
	// 顶层兼容镜像必须与 app 段同源（旧版 App 读镜像）。
	nextManifest.version = nextManifest.app.version;
	nextManifest.apk = nextManifest.app.file;
	nextManifest.size = nextManifest.app.size;
	nextManifest.sha256 = nextManifest.app.sha256;
	writeTextFile(path.join(root, "manifest.json"), `${JSON.stringify(nextManifest, null, 2)}\n`);
	const packed = await npmPack({ dir: root, destination: workDir, env, logFile, label: label ?? `npm pack carrier ${version}` });
	if (!packed.ok) return packed;
	return { ok: true, packageDir: root, packageJson: pkg, manifest: nextManifest, ...packed };
}

/** 证据：解析预检输出里的稳定 reason（`REASONS:` 行与 FAIL 行的 `[reason:...]`）。 */
export function parsePreflightReasons(stdout) {
	const text = String(stdout ?? "");
	const fromLine = /^REASONS:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? "";
	const reasons = fromLine && fromLine !== "none" ? fromLine.split(",").map((entry) => entry.trim()).filter(Boolean) : [];
	if (reasons.length > 0) return reasons;
	const found = [];
	for (const match of text.matchAll(/\[reason:([a-z0-9-]+)\]/g)) found.push(match[1]);
	return [...new Set(found)];
}

/** 运行现成的发布前预检（离线；不发布）。 */
export async function runPublishCarrierCheck({ distDir, mainPkgPath, env, logFile }) {
	const result = await runCommand({
		command: process.execPath,
		args: [path.join(TOOLS_DIR, "publish-carrier-check.mjs"), distDir, "--package-json", mainPkgPath],
		env,
		logFile,
		timeoutMs: 300_000,
		label: `publish-carrier-check ${distDir}`,
	});
	return { ...result, reasons: parsePreflightReasons(result.stdout) };
}

async function repackPackageDir({ extractParent, tarball, env, logFile }) {
	const result = await runCommand({
		command: "tar",
		args: ["-czf", tarball, "-C", extractParent, "package"],
		env,
		logFile,
		timeoutMs: 120_000,
		label: `tar repack ${path.basename(tarball)}`,
	});
	return { ok: result.ok, error: result.ok ? null : (result.error ?? result.stderr ?? "tar-failed") };
}

function refreshRecordForTarball(recordPath, tarball) {
	const record = JSON.parse(readTextFile(recordPath));
	record.size = fs.statSync(tarball).size;
	record.sha256 = sha256File(tarball);
	writeTextFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
	return record;
}

/**
 * 造受控预检夹具（失败路径断言专用）：复制一份真实发布目录，只在副本上篡改。
 * @param {{assets: object, workDir: string, kind: "bad-metadata"|"bad-version-pairing", mainPackage: object, env: object, logFile: string}} input
 */
export async function makePreflightFixture({ assets, workDir, kind, mainPackage, env, logFile }) {
	const fixtureDir = path.join(workDir, `preflight-${kind}`);
	ensureDir(fixtureDir);
	const manifest = structuredClone(assets.manifest);
	const record = structuredClone(assets.record);
	// R2：夹具的主包元数据同样来自**真实源插件包内 package.json**（不是合成副本）。
	const mainPkgPath = path.join(fixtureDir, "package.json");
	writeTextFile(mainPkgPath, `${JSON.stringify(mainPackage ?? {}, null, 2)}\n`);
	writeTextFile(path.join(fixtureDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	writeTextFile(path.join(fixtureDir, "app-carrier.json"), `${JSON.stringify(record, null, 2)}\n`);
	linkOrCopyFile(assets.pluginTgz, path.join(fixtureDir, path.basename(assets.pluginTgz)));
	linkOrCopyFile(assets.apk, path.join(fixtureDir, path.basename(assets.apk)));
	const carrierCopy = path.join(fixtureDir, path.basename(assets.carrierTgz));
	if (kind === "bad-metadata") {
		// 在载体副本里把 publishConfig.tag 改成 latest（发布元数据不合规的典型形态），重新打包并刷新记录。
		const extractParent = path.join(workDir, "fixture-bad-metadata-extract");
		const extract = tarExtract(assets.carrierTgz, extractParent);
		if (!extract.ok) return { ok: false, error: `extract-failed: ${extract.error}` };
		const pkgPath = path.join(extractParent, "package", "package.json");
		const carrierPkg = JSON.parse(readTextFile(pkgPath));
		carrierPkg.publishConfig = { ...(carrierPkg.publishConfig ?? {}), tag: "latest" };
		writeTextFile(pkgPath, `${JSON.stringify(carrierPkg, null, 2)}\n`);
		const repacked = await repackPackageDir({ extractParent, tarball: carrierCopy, env, logFile });
		if (!repacked.ok) return { ok: false, error: repacked.error };
		refreshRecordForTarball(path.join(fixtureDir, "app-carrier.json"), carrierCopy);
	} else if (kind === "bad-version-pairing") {
		// 清单 plugin 版本与主包版本不再配对（版本配对错误的典型形态）。
		manifest.plugin.version = "9.9.999999";
		writeTextFile(path.join(fixtureDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
		linkOrCopyFile(assets.carrierTgz, carrierCopy);
	} else {
		return { ok: false, error: `unknown-fixture-kind: ${kind}` };
	}
	return { ok: true, dir: fixtureDir, mainPkgPath };
}

export { TOOLS_DIR };
