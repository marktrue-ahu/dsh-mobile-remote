#!/usr/bin/env node
// 从**已打好的插件 tgz** + APK 生成完整 schema 1 配对清单，再打出 App 载体 tarball（X.Y.Z-app）。
//
// ── 构建顺序（设计稿 §5.2，不可交换）──────────────────────────────────────────────
//   APK 构建 → **先 npm pack 出插件 tgz** → 本工具由该 tgz + APK 生成清单 → 组装载体 → npm pack。
//   本工具只接受**本地实际 tgz**：清单里插件段的 size/sha256 由字节现算，且断言 tgz 的内容标识
//   等于当前插件源码目录。「载体先于插件 tgz」「先打包清单再补 tgz」「tgz 打好后又改源码」
//   都会被拒绝——否则会出现「清单包含自身 tgz 哈希」的循环依赖，或发布一份清单与字节不对应的包。
//
// ── 载体形态（设计稿 §5.1 / Q17）─────────────────────────────────────────────────
//   同包名，version = `<插件版本>-app`；内容 = APK + 完整清单 + README + LICENSE；
//   `dsh.appCarrier: true`；无 os/cpu/libc、无 bin/main/exports、无 dsh.bundle、无安装期脚本。
//
// ── 硬约束 ─────────────────────────────────────────────────────────────────────
//   本工具**不发布任何东西**：只调用 `npm pack`（本地打包、零网络），绝不调用 npm publish；
//   不发 registry、不改版本号、不写 CHANGELOG。所有判定 fail-closed：任一条 FAIL 即非零退出。
//
// 用法：
//   node dsh-mobile-app/tools/build-app-carrier.mjs \
//     --apk dsh-mobile-app/dist/DSH-Remote-v3.2.0.apk \
//     --plugin-tgz dsh-mobile-app/dist/dsh-mobile-remote-v3.2.0.tgz \
//     --plugin-root . \
//     --changelog CHANGELOG.md \
//     --out-dir dsh-mobile-app/dist \
//     [--app-version 3.2.0+23] [--plugin-url <url>] [--readme <file>] [--license <file>]
//
// `--app-version`：环境有 aapt/aapt2 时从 APK 实读（F17/R9）并与其交叉核对；没有 Android
// 构建工具时必须显式提供（来自 pubspec.yaml 的 X.Y.Z+N），否则拒绝——不猜构建号。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pluginContentDigest } from "../../lib/plugin-content-digest.js";
import {
	MANIFEST_APP_FIELDS,
	MANIFEST_PLUGIN_FIELDS,
	apkIdentityChecks,
	apkVersionFromFilename,
	carrierContentsChecks,
	carrierDependencySpec,
	carrierPackageChecks,
	carrierRecordChecks,
	carrierVersion,
	exactCarrierAliasChecks,
	objectPick,
	packedFiles,
	parseVersion,
	readApkBadging,
	readJsonFile,
	reportChecks,
	sha256Buffer,
	sha256File,
	tarExtract,
	tarList,
} from "./lib/release-checks.mjs";

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TOOLS_DIR, "../..");
const GEN_MANIFEST = path.join(TOOLS_DIR, "gen-manifest.js");
const VERIFY_MANIFEST = path.join(TOOLS_DIR, "verify-update-manifest.mjs");

let fail = 0;
function check(name, pass, detail = "") {
	if (!pass) fail++;
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
}
function info(message) {
	console.log(`INFO  ${message}`);
}
function finish() {
	console.log(`\nRESULT: ${fail === 0 ? "PASS" : "FAIL"}`);
	process.exit(fail === 0 ? 0 : 1);
}

const FLAG_MAP = {
	"--apk": "apk",
	"--plugin-tgz": "pluginTgz",
	"--plugin-root": "pluginRoot",
	"--changelog": "changelog",
	"--out-dir": "outDir",
	"--app-version": "appVersion",
	"--plugin-url": "pluginUrl",
	"--readme": "readme",
	"--license": "license",
};

function parseArgs(argv) {
	const args = {};
	const unknown = [];
	for (let i = 0; i < argv.length; i++) {
		const key = FLAG_MAP[argv[i]];
		if (!key) {
			unknown.push(argv[i]);
			continue;
		}
		if (i + 1 >= argv.length) {
			unknown.push(`${argv[i]}（缺少取值）`);
			continue;
		}
		args[key] = argv[i + 1];
		i++;
	}
	return { args, unknown };
}

function npmCommand() {
	return process.platform === "win32" ? "npm.cmd" : "npm";
}

function runNpmPack(cwd, destination) {
	return spawnSync(npmCommand(), ["pack", "--pack-destination", destination, "--json", "--ignore-scripts"], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, npm_config_ignore_scripts: "true" },
		shell: process.platform === "win32",
	});
}

function parsePackJson(stdout) {
	const start = stdout.indexOf("[");
	const end = stdout.lastIndexOf("]");
	if (start === -1 || end === -1 || end <= start) return null;
	try {
		return JSON.parse(stdout.slice(start, end + 1));
	} catch {
		return null;
	}
}

function packageTarballName(packageName, version) {
	return `${packageName.replace(/^@/, "").replace(/\//g, "-")}-${version}.tgz`;
}

function defaultCarrierReadme({ name, pluginVersion, apkName }) {
	return [
		`# DSH Mobile Remote App 载体（${name}@${carrierVersion(pluginVersion)}）`,
		"",
		"本包是 DSH Mobile Remote 的 **App 载体**，只承担数据分发角色：",
		"",
		`- \`${apkName}\`：与插件 ${pluginVersion} 配对的 Android 安装包；`,
		"- `manifest.json`：schema 1 发布清单，描述同一次发布的两端产物身份与哈希。",
		"",
		"本包**没有**可执行入口（无 main/exports/bin），不包含插件代码或安装脚本，",
		`也不是 DSH 插件/bundle。它由 \`${name}@${pluginVersion}\` 的精确别名依赖随插件一起安装。`,
		"",
	].join("\n");
}

function main() {
	const { args, unknown } = parseArgs(process.argv.slice(2));
	check("命令行参数合法（不认识的参数不得静默忽略）", unknown.length === 0, unknown.join(" "));

	const pluginRoot = args.pluginRoot ? path.resolve(args.pluginRoot) : REPO_ROOT;
	const apkFile = args.apk ? path.resolve(args.apk) : "";
	const tgzFile = args.pluginTgz ? path.resolve(args.pluginTgz) : "";
	const changelogFile = args.changelog ? path.resolve(args.changelog) : path.join(pluginRoot, "CHANGELOG.md");
	const outDir = args.outDir ? path.resolve(args.outDir) : path.join(pluginRoot, "dsh-mobile-app", "dist");

	// ── 1. 输入与构建顺序 ────────────────────────────────────────────────────────
	// 载体必须由**已经打好的插件 tgz** 驱动；没有 tgz 时只能手写清单/哈希，正是循环依赖的来源。
	const tgzReady = tgzFile !== "" && fs.existsSync(tgzFile) && fs.statSync(tgzFile).isFile()
		&& fs.statSync(tgzFile).size > 0;
	check(
		"构建顺序：插件 tgz 必须已由 npm pack 打好（拒绝“载体先于插件 tgz”）",
		tgzReady,
		tgzReady ? path.basename(tgzFile) : (tgzFile === "" ? "缺少 --plugin-tgz" : `不是可读文件：${tgzFile}`),
	);
	const apkReady = apkFile !== "" && fs.existsSync(apkFile) && fs.statSync(apkFile).isFile()
		&& fs.statSync(apkFile).size > 0;
	check("输入 APK 存在且非空", apkReady, apkReady ? `${path.basename(apkFile)} (${fs.statSync(apkFile).size} B)` : (apkFile || "缺少 --apk"));
	check("输入 CHANGELOG 存在（清单 notes 取最新发布条目）", fs.existsSync(changelogFile), changelogFile);
	const rootPkgFile = path.join(pluginRoot, "package.json");
	const rootPkgRead = readJsonFile(rootPkgFile);
	check("插件根 package.json 可解析", rootPkgRead.ok, rootPkgRead.ok ? pluginRoot : String(rootPkgRead.error));
	if (fail > 0) return finish();

	const rootPkg = rootPkgRead.value;
	const pluginName = typeof rootPkg.name === "string" ? rootPkg.name : "";
	const pluginVersion = typeof rootPkg.version === "string" ? rootPkg.version : "";
	check("插件包名合法", /^(?:@[^/\s]+\/)?[^./\s][^/\s]*$/.test(pluginName), `name=${pluginName || "<缺失>"}`);
	check("插件版本为 X.Y.Z（正式版插件不带 +N/-app）", /^\d+\.\d+\.\d+$/.test(pluginVersion), `version=${pluginVersion || "<缺失>"}`);
	// 主包必须精确声明载体别名（package.json 是发布产物的一部分，构建时即门禁）。
	reportChecks(exactCarrierAliasChecks(rootPkg), check);
	info(`精确载体别名为：${carrierDependencySpec(pluginName, pluginVersion)}`);
	if (fail > 0) return finish();

	// ── 2. 插件 tgz 身份：必须就是当前源码的最终产物 ─────────────────────────────
	const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-carrier-build-"));
	try {
		const pluginExtract = path.join(workDir, "plugin");
		const extracted = tarExtract(tgzFile, pluginExtract);
		check("插件 tgz 可解包（需要系统 tar）", extracted.ok, extracted.ok ? path.basename(tgzFile) : extracted.error);
		if (!extracted.ok) return finish();

		const packedPkgFile = path.join(pluginExtract, "package", "package.json");
		const packedPkgRead = readJsonFile(packedPkgFile);
		check("插件 tgz 内 package/package.json 可解析（npm pack 布局）", packedPkgRead.ok, packedPkgRead.ok ? "" : String(packedPkgRead.error));
		if (!packedPkgRead.ok) return finish();
		const packedPkg = packedPkgRead.value;
		check("插件 tgz 与源码同包名、同版本", packedPkg.name === pluginName && packedPkg.version === pluginVersion,
			`tgz=${packedPkg.name}@${packedPkg.version} 源码=${pluginName}@${pluginVersion}`);

		const tgzDigest = pluginContentDigest(path.join(pluginExtract, "package"));
		const sourceDigest = pluginContentDigest(pluginRoot);
		check(
			"插件 tgz 内容标识等于当前源码（tgz 必须是最终产物；打好后再改主包/重 pack 直接拒绝）",
			tgzDigest === sourceDigest,
			`tgz=${tgzDigest.slice(0, 12)}… 源码=${sourceDigest.slice(0, 12)}…`,
		);
		check(
			"插件 tgz 内不含 manifest.json（清单描述 tgz 哈希，不能再被装进 tgz 形成自指循环）",
			!fs.existsSync(path.join(pluginExtract, "package", "manifest.json")),
		);
		check("插件 tgz 未声明 dsh.appCarrier（载体角色只属于载体包）", packedPkg.dsh?.appCarrier !== true);
		reportChecks(exactCarrierAliasChecks(packedPkg), check);
		if (fail > 0) return finish();

		// ── 3. app.version：从 APK 实读（F17/R9），无 aapt 时退化为显式值 + 文件名一致性 ──
		const apkBaseName = path.basename(apkFile);
		const filenameVersion = apkVersionFromFilename(apkBaseName);
		check("APK 文件名符合发布产物约定 DSH-Remote-vX.Y.Z.apk", filenameVersion !== null, `--apk=${apkBaseName}`);
		check("APK 文件名版本与插件版本配对", filenameVersion === pluginVersion, `文件名=${filenameVersion ?? "<不符合约定>"} 插件=${pluginVersion}`);

		const badging = readApkBadging(apkFile);
		let appVersion = "";
		if (badging.ok) {
			check(
				"APK 内部版本实读成功（aapt dump badging 的 versionName/versionCode）",
				true,
				`versionName=${badging.versionName} versionCode=${badging.versionCode}（${badging.source}）`,
			);
			check("APK versionName 与插件版本严格配对", badging.versionName === pluginVersion,
				`versionName=${badging.versionName} 插件=${pluginVersion}`);
			check("APK versionCode 为正整数（真实递增构建号保留）", /^[1-9]\d*$/.test(badging.versionCode),
				`versionCode=${badging.versionCode}`);
			appVersion = `${badging.versionName}+${badging.versionCode}`;
			if (args.appVersion) {
				check("--app-version 与 APK 实读值一致（禁止手填漂移）", args.appVersion === appVersion,
					`参数=${args.appVersion} 实读=${appVersion}`);
			}
		} else if (badging.reason === "aapt-not-found") {
			const provided = args.appVersion ?? "";
			check(
				"APK 内部版本未实读（环境无 aapt/aapt2）：必须显式 --app-version，退化为文件名+清单一致性",
				provided.trim() !== "",
				provided ? `未实读；使用 --app-version=${provided}` : "未实读；缺 --app-version，拒绝猜测构建号",
			);
			if (provided.trim() === "") return finish();
			appVersion = provided.trim();
		} else {
			check("APK 内部版本实读（有 aapt/aapt2 却执行/解析失败必须 FAIL）", false, badging.detail ?? "unknown");
			return finish();
		}

		const parsedApp = parseVersion(appVersion);
		check("app.version 形如 X.Y.Z+N（保留真实构建号）", parsedApp !== null && parsedApp.build !== null, `app.version=${appVersion}`);
		check("app.version 语义版本与插件版本严格配对", parsedApp?.version === pluginVersion,
			`app=${parsedApp?.version ?? "<无法解析>"} 插件=${pluginVersion}`);
		check("app.version 与 APK 文件名版本一致", parsedApp?.version === filenameVersion,
			`app=${parsedApp?.version ?? "<无法解析>"} 文件名=${filenameVersion ?? "<不符合约定>"}`);
		if (fail > 0) return finish();

		// ── 4. 生成完整 schema 1 配对清单（复用共享生成器，双端清单等价）──────────────
		fs.mkdirSync(outDir, { recursive: true });
		const manifestFile = path.join(outDir, "manifest.json");
		const genArgs = [
			GEN_MANIFEST,
			"--apk", apkFile,
			"--version", appVersion,
			"--plugin-tgz", tgzFile,
			"--plugin-root", pluginRoot,
			"--changelog", changelogFile,
			"--out", manifestFile,
		];
		if (args.pluginUrl) genArgs.push("--plugin-url", args.pluginUrl);
		const gen = spawnSync(process.execPath, genArgs, { encoding: "utf8" });
		check("完整 schema 1 配对清单已生成（app/plugin 两段 + 顶层兼容镜像）", gen.status === 0 && fs.existsSync(manifestFile),
			gen.status === 0 ? manifestFile : String(gen.stderr || gen.stdout).trim());
		if (fail > 0) return finish();

		const manifestRead = readJsonFile(manifestFile);
		check("发布清单可解析", manifestRead.ok, manifestRead.ok ? "" : String(manifestRead.error));
		if (!manifestRead.ok) return finish();
		const manifest = manifestRead.value;
		const apkBuf = fs.readFileSync(apkFile);
		const tgzBuf = fs.readFileSync(tgzFile);
		check("清单 schema = 1", manifest.schema === 1, `schema=${manifest.schema}`);
		check("清单 app 段描述 APK 本体（size/sha256 由字节现算）",
			manifest.app?.file === apkBaseName && manifest.app?.size === apkBuf.length
				&& manifest.app?.sha256 === sha256Buffer(apkBuf),
			`app.file=${manifest.app?.file} size=${manifest.app?.size} sha256=${String(manifest.app?.sha256).slice(0, 12)}…`);
		check("清单 plugin 段描述本地实际 tgz（size/sha256 由字节现算，非手填）",
			manifest.plugin?.file === path.basename(tgzFile) && manifest.plugin?.size === tgzBuf.length
				&& manifest.plugin?.sha256 === sha256Buffer(tgzBuf),
			`plugin.file=${manifest.plugin?.file} size=${manifest.plugin?.size} sha256=${String(manifest.plugin?.sha256).slice(0, 12)}…`);
		check("清单 plugin.contentSha256 为 64 位小写 hex", /^[0-9a-f]{64}$/.test(String(manifest.plugin?.contentSha256)),
			`contentSha256=${String(manifest.plugin?.contentSha256).slice(0, 12)}…`);
		check("清单两条版本配对（plugin X.Y.Z / app X.Y.Z+N）",
			manifest.plugin?.version === pluginVersion && manifest.app?.version === appVersion,
			`plugin=${manifest.plugin?.version} app=${manifest.app?.version}`);
		reportChecks(apkIdentityChecks({ dir: path.dirname(apkFile), app: manifest.app, pluginVersion }), check);
		if (fail > 0) return finish();

		// ── 5. 组装载体包（同包名 / X.Y.Z-app / 数据角色）────────────────────────────
		const appCarrierVersion = carrierVersion(pluginVersion);
		const carrierStage = fs.mkdtempSync(path.join(outDir, ".app-carrier-stage-"));
		let carrierFile = "";
		let recordFile = "";
		try {
			const files = [apkBaseName, "manifest.json", "README.md", "LICENSE"];
			const carrierPkg = {
				name: pluginName,
				version: appCarrierVersion,
				description: `DSH Mobile Remote App 载体（与 ${pluginName}@${pluginVersion} 配对）：随插件分发 APK 与发布清单，仅作数据分发，无运行入口。`,
				files,
				dsh: { appCarrier: true },
				license: typeof rootPkg.license === "string" && rootPkg.license !== "" ? rootPkg.license : "MIT",
				publishConfig: { access: "public" },
			};
			fs.writeFileSync(path.join(carrierStage, "package.json"), `${JSON.stringify(carrierPkg, null, 2)}\n`);
			fs.copyFileSync(apkFile, path.join(carrierStage, apkBaseName));
			fs.copyFileSync(manifestFile, path.join(carrierStage, "manifest.json"));
			if (args.readme) {
				const readmeFile = path.resolve(args.readme);
				check("--readme 指定的说明文件存在", fs.existsSync(readmeFile), readmeFile);
				if (fs.existsSync(readmeFile)) fs.copyFileSync(readmeFile, path.join(carrierStage, "README.md"));
			} else {
				fs.writeFileSync(path.join(carrierStage, "README.md"),
					defaultCarrierReadme({ name: pluginName, pluginVersion, apkName: apkBaseName }));
			}
			const licenseFile = args.license ? path.resolve(args.license) : path.join(pluginRoot, "LICENSE");
			check("载体许可证文件存在（LICENSE）", fs.existsSync(licenseFile), licenseFile);
			if (fs.existsSync(licenseFile)) fs.copyFileSync(licenseFile, path.join(carrierStage, "LICENSE"));
			reportChecks(carrierPackageChecks(carrierPkg, {
				expectedName: pluginName,
				expectedVersion: appCarrierVersion,
				expectedFiles: files,
			}), check);
			if (fail > 0) return finish();

			// ── 6. npm pack 出载体 tarball（本地打包，零网络、零发布）────────────────────
			const pack = runNpmPack(carrierStage, outDir);
			check("载体 npm pack 成功（本地打包，绝不发布 registry）", pack.status === 0,
				pack.status === 0 ? `exit 0` : String(pack.stderr || pack.stdout).trim());
			if (fail > 0) return finish();
			const packInfo = parsePackJson(pack.stdout ?? "");
			const expectedName = packageTarballName(pluginName, appCarrierVersion);
			carrierFile = path.join(outDir, (packInfo?.[0]?.filename) || expectedName);
			check("载体 tarball 文件名符合 <name>-X.Y.Z-app.tgz 约定",
				path.basename(carrierFile) === expectedName && fs.existsSync(carrierFile),
				`实际=${path.basename(carrierFile)} 期望=${expectedName}`);

			// ── 7. 复验载体 tarball 内容（与发布清单、APK、本地插件 tgz 逐项对齐）───────
			const carrierExtract = path.join(workDir, "carrier");
			const carrierUntar = tarExtract(carrierFile, carrierExtract);
			check("载体 tarball 可解包（需要系统 tar）", carrierUntar.ok, carrierUntar.ok ? "" : carrierUntar.error);
			if (!carrierUntar.ok) return finish();
			const list = tarList(carrierFile);
			check("载体 tarball 可列出条目", list.ok, list.ok ? `${list.entries.length} 项` : String(list.error));
			if (!list.ok) return finish();
			reportChecks(carrierContentsChecks({
				carrierDir: path.join(carrierExtract, "package"),
				entries: packedFiles(list.entries),
				manifest,
				mainPkgName: pluginName,
				pluginTgzFile: tgzFile,
			}), check);
			if (fail > 0) return finish();

			// ── 8. 构建记录（发布记录 / 校验器据此核对载体 tarball 体积与哈希）───────────
			const carrierStat = fs.statSync(carrierFile);
			const record = {
				schema: 1,
				name: pluginName,
				version: appCarrierVersion,
				file: path.basename(carrierFile),
				size: carrierStat.size,
				sha256: sha256File(carrierFile),
				manifest: {
					app: objectPick(manifest.app, MANIFEST_APP_FIELDS),
					plugin: objectPick(manifest.plugin, MANIFEST_PLUGIN_FIELDS),
				},
			};
			recordFile = path.join(outDir, "app-carrier.json");
			fs.writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`);
			reportChecks(carrierRecordChecks(record, { carrierFile, manifest }), check);

			// ── 9. 最终门禁：用发布校验器（严格配对模式）复核整个 dist ──────────────────
			info("最终门禁：verify-update-manifest.mjs --require-carrier --package-json <主包 package.json>");
			const verify = spawnSync(process.execPath, [
				VERIFY_MANIFEST,
				outDir,
				"--require-carrier",
				"--package-json", rootPkgFile,
			], { encoding: "utf8" });
			process.stdout.write(verify.stdout ?? "");
			if (verify.stderr) process.stderr.write(verify.stderr);
			check("最终门禁：配对清单/插件 tgz/APK/载体 tarball 全一致（含发布顺序前置）", verify.status === 0,
				`exit ${verify.status}`);

			console.log("");
			console.log("Artifacts:");
			console.log(`  manifest : ${manifestFile}`);
			console.log(`  carrier  : ${carrierFile} (${carrierStat.size} B, sha256 ${record.sha256})`);
			console.log(`  record   : ${recordFile}`);
			console.log(`  版本配对 : ${pluginName}@${pluginVersion} ↔ @${appCarrierVersion}`);
			info("未向任何 registry 发布（仅 npm pack 本地打包）；发布顺序由发布流程保证：先载体后主包");
		} finally {
			fs.rmSync(carrierStage, { recursive: true, force: true });
		}
	} finally {
		fs.rmSync(workDir, { recursive: true, force: true });
	}
	finish();
}

main();
