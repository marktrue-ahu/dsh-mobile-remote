#!/usr/bin/env node
// App 载体（`X.Y.Z-app`）的 **npm 发布前预检**（issue #36 P3-A）。本工具只做离线检查，
// **绝不发布**：不调用 `npm publish`，不访问 registry，不写任何产物（`npm pack --dry-run` 不落盘）。
//
// 背景：桌面版 pnpm 安装主插件时，靠主包 `optionalDependencies` 的精确别名
// `"@marktrue/dsh-mobile-remote-app": "npm:@marktrue/dsh-mobile-remote@X.Y.Z-app"` 把载体带进来。
// 载体是 semver prerelease（`X.Y.Z-app`），`^X.Y.Z` 不会匹配它，因此必须**显式发布并打 `app`
// dist-tag**；`latest` 永远属于主插件，载体用 latest 会被无版本 `npm i` 当成插件安装（错误绑定）。
//
// 预检内容：
//   1. 载体 package.json 的发布元数据：private=false、publishConfig.access=public、
//      publishConfig.tag=app（绝 latest）、files 含 APK 与 manifest.json、
//      version=`X.Y.Z-app` 且与主插件版本严格配对、license/description/repository 齐备；
//   2. 两条版本配对：主包 package.json `X.Y.Z` ↔ 清单 plugin.version ↔ 载体 `X.Y.Z-app`，
//      主包对载体的 optionalDependencies 别名必须是精确 `npm:<name>@X.Y.Z-app`；
//   3. 产物一致性：清单 app 段 ↔ APK 本体（size+sha256）、清单 ↔ 构建记录 app-carrier.json、
//      载体 tarball ↔ 构建记录（size+sha256）、载体内 APK/清单 ↔ dist 内产物；
//   4. `npm pack --dry-run --json --offline`（离线、不发布）实际打包内容必须包含
//      APK + manifest.json + package.json（且只有约定的 5 个文件）。
//
// 输出：逐条 `PASS/FAIL`；FAIL 行带稳定 reason code；结尾 `REASONS: <code,...>` 与
//       `RESULT: PASS|FAIL`；退出码非 0 即失败（fail-closed，无法执行 ≠ 通过）。
//
// 稳定 reason 词表（FAIL 行 `[reason:<code>]` 与 REASONS 行使用同一组）：
//   CLI：cli-unknown-argument
//   dist/主包：dist-missing、dist-manifest-missing、main-package-json-unparsable、
//              main-version-not-x-y-z、manifest-plugin-version-mismatch、
//              manifest-app-version-mismatch、main-carrier-alias-invalid
//   APK/清单：apk-missing、apk-size-mismatch、apk-sha256-mismatch
//   构建记录：carrier-record-missing、carrier-record-schema-mismatch、
//             carrier-record-identity-mismatch、carrier-record-file-mismatch、
//             carrier-record-carrier-mismatch、carrier-record-manifest-app-mismatch、
//             carrier-record-manifest-plugin-mismatch
//   载体 tarball：carrier-tarball-missing、carrier-tarball-list-failed、carrier-unpack-failed、
//                 carrier-package-json-missing、plugin-tgz-missing
//   载体包内容：carrier-name-mismatch、carrier-version-pairing-mismatch、carrier-files-mismatch、
//               carrier-entries-mismatch、carrier-manifest-mismatch、carrier-apk-missing、
//               carrier-apk-size-mismatch、carrier-apk-sha256-mismatch、
//               carrier-plugin-size-mismatch、carrier-plugin-sha256-mismatch …（复用共享红线）
//   发布元数据：carrier-publish-name-mismatch、carrier-publish-version-not-app-suffix、
//               carrier-publish-version-mismatch、carrier-publish-private-not-false、
//               carrier-publish-access-not-public、carrier-publish-tag-not-app、
//               carrier-publish-tag-latest、carrier-publish-files-missing-apk、
//               carrier-publish-files-missing-manifest、carrier-publish-license-missing/mismatch、
//               carrier-publish-description-missing、carrier-publish-repository-missing/mismatch
//   npm pack：npm-pack-dry-run-failed、npm-pack-output-unparsable、npm-pack-filename-mismatch、
//             npm-pack-files-missing-apk、npm-pack-files-missing-manifest、
//             npm-pack-files-missing-package-json、npm-pack-files-mismatch
//
// 用法：
//   node dsh-mobile-app/tools/publish-carrier-check.mjs [dist目录]
//        [--dist <目录>] [--package-json <主包package.json>] [--carrier <载体.tgz>]
//        [--record <app-carrier.json>]
//
// 示例（本地已构建的发布目录，只检查、不发布）：
//   node dsh-mobile-app/tools/publish-carrier-check.mjs dsh-mobile-app/dist/local-3.2.0+57
//   npm run release:carrier:check -- dsh-mobile-app/dist/local-3.2.0+57
//
// 通过后才允许人工执行（本工具绝不代执行）：
//   npm publish dsh-mobile-app/dist/local-3.2.0+57/marktrue-dsh-mobile-remote-3.2.0-app.tgz --tag app
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	carrierContentsChecks,
	carrierPackageChecks,
	carrierPublishMetadataChecks,
	carrierRecordChecks,
	carrierVersion,
	exactCarrierAliasChecks,
	isPluginVersion,
	packedFiles,
	parseVersion,
	pluginCoreVersion,
	pluginPublishTag,
	readJsonFile,
	sha256Buffer,
	sha256File,
	tarExtract,
	tarList,
} from "./lib/release-checks.mjs";

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TOOLS_DIR, "../..");

const VALUE_FLAGS = {
	"--dist": "dist",
	"--package-json": "packageJson",
	"--carrier": "carrier",
	"--record": "record",
};

function parseArgs(argv) {
	const args = { dist: "", packageJson: "", carrier: "", record: "", positional: [], unknown: [] };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (Object.hasOwn(VALUE_FLAGS, arg)) {
			const value = argv[++i];
			if (value === undefined || value.startsWith("--")) args.unknown.push(`${arg}（缺少取值）`);
			else args[VALUE_FLAGS[arg]] = value;
		} else if (arg.startsWith("--")) {
			args.unknown.push(arg);
		} else {
			args.positional.push(arg);
		}
	}
	return args;
}

let fail = 0;
const reasons = [];

/** 打印一条断言；FAIL 时记录稳定 reason（code）。 */
function check({ name, pass, detail = "", code = "" }) {
	if (!pass) {
		fail++;
		if (code !== "") reasons.push(code);
	}
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}${pass ? "" : code ? ` [reason:${code}]` : ""}${detail ? ` (${detail})` : ""}`);
}

function reportShared(items, fallbackCode) {
	for (const item of items) {
		check({ name: item.name, pass: item.pass, detail: item.detail ?? "", code: item.code ?? fallbackCode });
	}
}

function finish() {
	const uniqueReasons = [...new Set(reasons)];
	console.log(`\nREASONS: ${uniqueReasons.length === 0 ? "none" : uniqueReasons.join(",")}`);
	console.log(`\nRESULT: ${fail === 0 ? "PASS" : "FAIL"}`);
	process.exit(fail === 0 ? 0 : 1);
}

function npmCommand() {
	return process.platform === "win32" ? "npm.cmd" : "npm";
}

/** 离线 dry-run 打包：只读元数据，不写 tarball、不访问 registry（`--offline` 双保险）。 */
function npmPackDryRun(cwd) {
	return spawnSync(npmCommand(), ["pack", "--dry-run", "--json", "--offline", "--ignore-scripts"], {
		cwd,
		encoding: "utf8",
		timeout: 180_000,
		shell: process.platform === "win32",
		env: {
			...process.env,
			npm_config_offline: "true",
			npm_config_audit: "false",
			npm_config_fund: "false",
			npm_config_update_notifier: "false",
			npm_config_ignore_scripts: "true",
		},
	});
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

function packageTarballName(packageName, version) {
	return `${packageName.replace(/^@/, "").replace(/\//g, "-")}-${version}.tgz`;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	check({
		name: "命令行参数合法（不认识的参数不得静默忽略）",
		pass: args.unknown.length === 0,
		detail: args.unknown.join(" ") || "ok",
		code: "cli-unknown-argument",
	});
	if (args.unknown.length > 0) return finish();
	check({
		name: "位置参数至多一个（多余的参数不得被静默忽略）",
		pass: args.positional.length <= 1,
		detail: args.positional.slice(1).join(" ") || "ok",
		code: "cli-unexpected-argument",
	});
	if (args.positional.length > 1) return finish();

	const distDir = path.resolve(args.dist || args.positional[0] || path.join(REPO_ROOT, "dsh-mobile-app", "dist"));
	const mainPkgPath = args.packageJson
		? path.resolve(args.packageJson)
		: path.join(REPO_ROOT, "package.json");
	const recordPath = args.record ? path.resolve(args.record) : path.join(distDir, "app-carrier.json");

	check({
		name: "dist 目录存在",
		pass: fs.existsSync(distDir) && fs.statSync(distDir).isDirectory(),
		detail: distDir,
		code: "dist-missing",
	});
	const manifestRead = readJsonFile(path.join(distDir, "manifest.json"));
	check({
		name: "dist/manifest.json 可解析（发布清单是配对权威）",
		pass: manifestRead.ok,
		detail: manifestRead.ok ? "manifest.json" : String(manifestRead.error),
		code: "dist-manifest-missing",
	});
	const mainPkgRead = readJsonFile(mainPkgPath);
	check({
		name: `主包 package.json 可解析（${mainPkgPath}）`,
		pass: mainPkgRead.ok,
		detail: mainPkgRead.ok ? "" : String(mainPkgRead.error),
		code: "main-package-json-unparsable",
	});
	if (!manifestRead.ok || !mainPkgRead.ok) return finish();

	const manifest = manifestRead.value;
	const mainPkg = mainPkgRead.value;
	const app = manifest.app && typeof manifest.app === "object" ? manifest.app : {};
	const plugin = manifest.plugin && typeof manifest.plugin === "object" ? manifest.plugin : {};

	// ── 版本配对：主包 X.Y.Z ↔ 清单 plugin X.Y.Z ↔ 清单 app X.Y.Z+N ↔ 载体 X.Y.Z-app ──
	check({
		name: "主包版本为 X.Y.Z 或 X.Y.Z-prerelease（载体版本在此基础上追加 -app）",
		pass: isPluginVersion(mainPkg.version),
		detail: `version=${mainPkg.version ?? "<缺失>"}`,
		code: "main-version-not-x-y-z",
	});
	check({
		name: "清单 plugin.version 与主包版本严格配对",
		pass: plugin.version === mainPkg.version,
		detail: `plugin=${plugin.version ?? "<缺失>"} 主包=${mainPkg.version ?? "<缺失>"}`,
		code: "manifest-plugin-version-mismatch",
	});
	const appVersion = parseVersion(app.version);
	const mainCore = pluginCoreVersion(mainPkg.version);
	check({
		name: "清单 app.version 语义版本与主包版本配对（保留真实构建号 +N）",
		pass: appVersion !== null && appVersion.build !== null && mainCore !== "" && appVersion.version === mainCore,
		detail: `app=${app.version ?? "<缺失>"} 主包=${mainPkg.version ?? "<缺失>"}（核心=${mainCore || "<非法>"}）`,
		code: "manifest-app-version-mismatch",
	});
	reportShared(exactCarrierAliasChecks(mainPkg), "main-carrier-alias-invalid");

	const expectedCarrierVersion = isPluginVersion(mainPkg.version) ? carrierVersion(String(mainPkg.version)) : "";
	const expectedFiles = [app.file, "manifest.json", "README.md", "LICENSE"].filter((value) => typeof value === "string" && value !== "");

	// ── 清单 app 段 ↔ dist 内 APK 本体 ──
	const apkPath = typeof app.file === "string" && app.file !== "" ? path.join(distDir, app.file) : "";
	const apkExists = apkPath !== "" && fs.existsSync(apkPath);
	check({
		name: "dist 内 APK 本体存在（清单 app.file）",
		pass: apkExists,
		detail: app.file ?? "<缺失>",
		code: "apk-missing",
	});
	if (apkExists) {
		const apkBuf = fs.readFileSync(apkPath);
		check({
			name: "清单 app.size 与 APK 字节数一致",
			pass: app.size === apkBuf.length,
			detail: `清单=${app.size ?? "<缺失>"} 实际=${apkBuf.length}`,
			code: "apk-size-mismatch",
		});
		check({
			name: "清单 app.sha256 与 APK 实算一致",
			pass: app.sha256 === sha256Buffer(apkBuf),
			detail: `清单=${app.sha256 ?? "<缺失>"} 实际=${sha256Buffer(apkBuf)}`,
			code: "apk-sha256-mismatch",
		});
	}

	// ── 构建记录（载体 tarball 的体积/哈希只存在于构建记录；清单不能自指）──
	const recordRead = readJsonFile(recordPath);
	check({
		name: "构建记录 dist/app-carrier.json 可解析（核对载体 tarball 体积/哈希）",
		pass: recordRead.ok,
		detail: recordRead.ok ? "app-carrier.json" : String(recordRead.error),
		code: "carrier-record-missing",
	});

	// ── 定位载体 tarball：显式 --carrier > 构建记录 file > dist 内唯一 *-X.Y.Z-app.tgz ──
	let carrierFile = args.carrier ? path.resolve(args.carrier) : "";
	if (carrierFile === "" && recordRead.ok && typeof recordRead.value?.file === "string" && recordRead.value.file !== "") {
		carrierFile = path.resolve(distDir, recordRead.value.file);
	}
	let carrierCandidates = [];
	if (carrierFile === "") {
		try {
			carrierCandidates = fs.readdirSync(distDir)
				.filter((name) => /-\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?-app\.tgz$/.test(name))
				.sort();
		} catch {
			carrierCandidates = [];
		}
		if (carrierCandidates.length === 1) carrierFile = path.join(distDir, carrierCandidates[0]);
	}
	check({
		name: "载体 tarball 存在且唯一可定位（*-X.Y.Z-app.tgz）",
		pass: carrierFile !== "" && fs.existsSync(carrierFile),
		detail: carrierFile !== ""
			? path.basename(carrierFile)
			: (carrierCandidates.length > 1 ? `多个候选：${carrierCandidates.join(",")}` : "未找到"),
		code: "carrier-tarball-missing",
	});
	if (carrierFile === "" || !fs.existsSync(carrierFile)) return finish();

	if (recordRead.ok) {
		reportShared(carrierRecordChecks(recordRead.value, { carrierFile, manifest }), "carrier-record-invalid");
	}

	const pluginTgzFile = typeof plugin.file === "string" && plugin.file !== "" ? path.join(distDir, plugin.file) : "";
	const pluginTgzExists = pluginTgzFile !== "" && fs.existsSync(pluginTgzFile);
	check({
		name: "dist 内插件 tgz 存在（核对载体清单的哈希来源）",
		pass: pluginTgzExists,
		detail: plugin.file ?? "<缺失>",
		code: "plugin-tgz-missing",
	});

	// ── 解包载体 tarball，检查包内身份 / 发布元数据 / 内容一致性 ──
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "carrier-publish-check-"));
	try {
		const extract = tarExtract(carrierFile, tmp);
		check({
			name: "载体 tarball 可解包（需要系统 tar）",
			pass: extract.ok,
			detail: extract.ok ? "" : extract.error,
			code: "carrier-unpack-failed",
		});
		if (!extract.ok) return finish();

		const list = tarList(carrierFile);
		check({
			name: "载体 tarball 可列出条目",
			pass: list.ok,
			detail: list.ok ? `${list.entries.length} 项` : String(list.error),
			code: "carrier-tarball-list-failed",
		});
		const carrierDir = path.join(tmp, "package");
		const carrierPkgRead = readJsonFile(path.join(carrierDir, "package.json"));
		check({
			name: "载体内 package.json 可解析",
			pass: carrierPkgRead.ok,
			detail: carrierPkgRead.ok ? "package.json" : String(carrierPkgRead.error),
			code: "carrier-package-json-missing",
		});
		if (!carrierPkgRead.ok) return finish();
		const carrierPkg = carrierPkgRead.value;

		reportShared(carrierPackageChecks(carrierPkg, {
			expectedName: typeof mainPkg.name === "string" ? mainPkg.name : "",
			expectedVersion: expectedCarrierVersion,
			expectedFiles,
		}), "carrier-package-invalid");
		reportShared(carrierPublishMetadataChecks(carrierPkg, {
			mainPkg,
			expectedName: typeof mainPkg.name === "string" ? mainPkg.name : "",
			expectedVersion: expectedCarrierVersion,
			expectedFiles,
		}), "carrier-publish-metadata-invalid");
		if (list.ok) {
			reportShared(carrierContentsChecks({
				carrierDir,
				entries: packedFiles(list.entries),
				manifest,
				mainPkgName: typeof mainPkg.name === "string" ? mainPkg.name : "",
				pluginTgzFile: pluginTgzExists ? pluginTgzFile : "",
			}), "carrier-contents-invalid");
		}

		// ── `npm pack --dry-run --json --offline`：真正的打包视图（不写盘、不联网）──
		check({
			name: "发布方案：dist-tag 固定 app，发布命令必须带 --tag app（永不 latest）",
			pass: carrierPkg?.publishConfig?.tag === "app",
			detail: `publishConfig.tag=${carrierPkg?.publishConfig?.tag ?? "<缺失>"}`,
			code: "carrier-publish-tag-not-app",
		});
		const pack = npmPackDryRun(carrierDir);
		const packTail = String(pack.stderr || pack.stdout || "").trim().split(/\r?\n/).slice(-3).join(" | ");
		check({
			name: "npm pack --dry-run 成功（离线元数据检查，不发布、不落盘）",
			pass: pack.status === 0,
			detail: pack.status === 0 ? "exit 0" : packTail || `exit ${pack.status ?? pack.error?.message}`,
			code: "npm-pack-dry-run-failed",
		});
		const packInfo = pack.status === 0 ? parsePackJson(pack.stdout) : null;
		const info = Array.isArray(packInfo) ? packInfo[0] : null;
		check({
			name: "dry-run 输出可解析（JSON 元数据）",
			pass: info !== null && typeof info === "object",
			detail: info !== null ? "ok" : packTail || "无 JSON",
			code: "npm-pack-output-unparsable",
		});
		if (info !== null) {
			const expectedName = packageTarballName(String(carrierPkg.name ?? ""), expectedCarrierVersion);
			check({
				name: "dry-run 打包文件名符合 <name>-X.Y.Z-app.tgz（发布产物名）",
				pass: info.filename === expectedName,
				detail: `实际=${info.filename ?? "<缺失>"} 期望=${expectedName}`,
				code: "npm-pack-filename-mismatch",
			});
			const packedPaths = Array.isArray(info.files) ? info.files.map((file) => String(file?.path ?? "")) : [];
			check({
				name: "dry-run 打包内容包含 APK 本体",
				pass: typeof app.file === "string" && packedPaths.includes(app.file),
				detail: `files=${packedPaths.join(",") || "<空>"}`,
				code: "npm-pack-files-missing-apk",
			});
			check({
				name: "dry-run 打包内容包含 manifest.json",
				pass: packedPaths.includes("manifest.json"),
				detail: `files=${packedPaths.join(",") || "<空>"}`,
				code: "npm-pack-files-missing-manifest",
			});
			check({
				name: "dry-run 打包内容包含 package.json（npm 必带）",
				pass: packedPaths.includes("package.json"),
				detail: `files=${packedPaths.join(",") || "<空>"}`,
				code: "npm-pack-files-missing-package-json",
			});
			const expectedPacked = [...expectedFiles, "package.json"].sort();
			check({
				name: "dry-run 打包内容恰为约定 5 个文件（无插件代码/依赖混入）",
				pass: packedPaths.length === expectedPacked.length
					&& [...packedPaths].sort().every((value, index) => value === expectedPacked[index]),
				detail: `实际=${[...packedPaths].sort().join(",") || "<空>"} 期望=${expectedPacked.join(",")}`,
				code: "npm-pack-files-mismatch",
			});
		}

		// ── 发布计划（只打印；真正 publish 必须人工另行执行）──
		console.log("");
		const pluginTag = pluginPublishTag(mainPkg.version);
		console.log("Publish plan (NOT executed by this check):");
		console.log(`  package : ${carrierPkg.name ?? "<缺失>"}@${carrierPkg.version ?? "<缺失>"}`);
		console.log(`  tarball : ${carrierFile} (${fs.statSync(carrierFile).size} B, sha256 ${sha256File(carrierFile)})`);
		console.log(`  主插件 dist-tag: ${pluginTag || "<无法推导>"}${pluginTag === "latest" ? "" : "（预发布，显式 tag 不移动 latest）"}`);
		console.log(`  dist-tag: app (NEVER latest)`);
		console.log(`  command : npm publish ${carrierFile} --tag app`);
		console.log(`  主插件发布: npm publish ${pluginTgzFile || "<dist内插件 tgz>"} --tag ${pluginTag || "<tag>"}`);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
	return finish();
}

main();
