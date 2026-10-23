#!/usr/bin/env node
// 校验发布清单与产物一致（发布工具链的契约门禁）。
//
// 清单是「是否需要更新」的唯一权威，因此它自己必须先与产物对齐。校验项：
//   1. JSON 可解析；2. schema = 1；
//   3. app 段：version 精确到 build（X.Y.Z+N）、file 存在、size 与字节数一致、sha256 与实算一致；
//   4. plugin 段：version（X.Y.Z）、file 存在、size、sha256；
//   5. plugin.contentSha256 与 **tgz 解包后** `package/` 的实算值一致
//      —— 这条把「发布侧算的内容标识」与「运行中的插件对自己已安装副本算的值」钉在一起；
//   6. 兼容镜像：顶层 version/apk/size/sha256 与 app 段一致（旧版 App 读的是顶层）；notes 非空；
//   7. plugin.url（若给出）是可解析的 http(s) 地址。
// 任何一项无法执行（例如缺少 tar 导致无法解包）都算 FAIL——跳过不等于通过。
//
// 本版新增（配对产物门禁；设计稿 §5.1 产物与随包清单、§5.2 构建与发布顺序、
// §6.2 F17/F18、§10.1 R9/R10）：
//   8. APK 身份：app.version 必须与 APK 文件名版本、插件版本严格配对；环境有 aapt/aapt2 时
//      **实读** versionName/versionCode（F17/R9，清单不许长期手填）；没有 Android 构建工具时
//      明确标注「未实读」并退化为文件名+清单一致性——绝不把缺工具当成一致；
//   9. 发布产物自证：插件 tgz 内 package.json 版本 = 清单 plugin.version、tgz 内不含
//      manifest.json（否则清单描述 tgz 哈希又被装进 tgz，形成自指循环）、主包不自标 appCarrier；
//  10. 配对段（`--require-carrier`、显式 `--package-json`，或 dist 内发现载体 tarball 时强制）：
//      · 主包 package.json 的载体依赖必须是**精确** `npm:<同包名>@X.Y.Z-app`（禁 range/^/~/latest）；
//      · 载体包字段红线：无 os/cpu/libc、无 bin/main/exports、无 dsh.bundle、无安装期脚本、
//        包名/版本无平台 token、`dsh.appCarrier === true`；
//      · 两条版本严格配对（主插件 X.Y.Z ↔ 载体 X.Y.Z-app）；
//      · 载体 tarball 内 APK 的 size/sha256 与清单 app 段一致；内嵌清单与 dist/manifest.json 一致；
//      · 载体清单的 plugin.size/sha256 必须来自本地实际插件 tgz（构建顺序：先 tgz 后载体）；
//      · 构建记录 app-carrier.json 核对载体 tarball 体积/哈希（清单无法描述包含自己的 tarball）；
//      · 发布顺序前置：载体 tarball 必须先于主插件发布存在（--require-carrier 时缺失即 FAIL）。
//
// 兼容：不带新参数时保持旧行为（单产物清单仍可直接校验）；发布门禁必须显式传
//      `--require-carrier --package-json <主包 package.json>`。
//
// 用法：
//   node tools/verify-update-manifest.mjs [dist目录] [--require-carrier]
//        [--package-json <主包package.json>] [--carrier <载体.tgz>] [--carrier-record <app-carrier.json>]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pluginContentDigest } from "../../lib/plugin-content-digest.js";
import { verifyRuntimeClosure } from "../../lib/runtime-dependency-snapshot.js";
import {
	apkInternalVersionChecks,
	apkManifestIdentityChecks,
	carrierContentsChecks,
	carrierRecordChecks,
	exactCarrierAliasChecks,
	packedFiles,
	readJsonFile,
	reportChecks,
	tarExtract,
	tarList,
} from "./lib/release-checks.mjs";

const VALUE_FLAGS = { "--package-json": "packageJson", "--carrier": "carrier", "--carrier-record": "carrierRecord" };

function parseCli(argv) {
	const cli = {
		dir: "",
		packageJson: "",
		carrier: "",
		carrierRecord: "",
		requireCarrier: false,
		positionals: [],
		unknown: [],
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--require-carrier") cli.requireCarrier = true;
		else if (Object.hasOwn(VALUE_FLAGS, arg)) {
			const value = argv[++i];
			if (value === undefined || value.startsWith("--")) cli.unknown.push(`${arg}（缺少取值）`);
			else cli[VALUE_FLAGS[arg]] = value;
		} else if (arg.startsWith("--")) cli.unknown.push(arg);
		else cli.positionals.push(arg);
	}
	cli.dir = cli.positionals[0] ?? "";
	return cli;
}

const cli = parseCli(process.argv.slice(2));
const dir = cli.dir
	? path.resolve(cli.dir)
	: path.resolve(fileURLToPath(new URL("../dist", import.meta.url)));
const manifestPath = path.join(dir, "manifest.json");

let fail = 0;
function check(name, pass, detail = "") {
	if (!pass) fail++;
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
}

// 不认识的参数不得静默忽略：否则 `--carrier` 拼错会被当成“没给”，门禁悄悄降级。
check("命令行参数合法（不认识的参数不得静默忽略）", cli.unknown.length === 0, cli.unknown.join(" ") || "ok");
if (fail > 0) {
	console.log("\nRESULT: FAIL");
	process.exit(1);
}

let m = null;
try {
	m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	check("manifest.json 可解析", true);
} catch (e) {
	check(`manifest.json 可解析（${manifestPath}）`, false, String(e));
	console.log("\nRESULT: FAIL");
	process.exit(1);
}

check("schema = 1", m.schema === 1, `schema=${m.schema}`);

// ── app 段 ──
const app = m.app && typeof m.app === "object" ? m.app : {};
check("app.version 精确到 build（X.Y.Z+N）", /^\d+\.\d+\.\d+\+\d+$/.test(app.version ?? ""), `app.version=${app.version}`);
const appFile = typeof app.file === "string" ? path.join(dir, app.file) : "";
check("app.file 存在", appFile !== "" && fs.existsSync(appFile), `app.file=${app.file}`);
if (appFile && fs.existsSync(appFile)) {
	const buf = fs.readFileSync(appFile);
	check("app.size 与字节数一致", app.size === buf.length, `manifest=${app.size} 实际=${buf.length}`);
	const hash = crypto.createHash("sha256").update(buf).digest("hex");
	check("app.sha256 与实算一致", app.sha256 === hash, `manifest=${app.sha256} 实际=${hash}`);
} else {
	check("app.size 与字节数一致", false, "APK 缺失");
	check("app.sha256 与实算一致", false, "APK 缺失");
}

// ── plugin 段 ──
const plugin = m.plugin && typeof m.plugin === "object" ? m.plugin : {};
check("plugin.version 为 X.Y.Z", /^\d+\.\d+\.\d+$/.test(plugin.version ?? ""), `plugin.version=${plugin.version}`);
const tgz = typeof plugin.file === "string" ? path.join(dir, plugin.file) : "";
let pluginTgzUsable = false;
let packedPluginPackage = null; // 已发布 tgz 内 package.json（配对段据此核对真实产物而非仅源码）
check("plugin.file 存在", tgz !== "" && fs.existsSync(tgz), `plugin.file=${plugin.file}`);
if (tgz && fs.existsSync(tgz)) {
	pluginTgzUsable = true;
	const buf = fs.readFileSync(tgz);
	check("plugin.size 与字节数一致", plugin.size === buf.length, `manifest=${plugin.size} 实际=${buf.length}`);
	const hash = crypto.createHash("sha256").update(buf).digest("hex");
	check("plugin.sha256 与实算一致", plugin.sha256 === hash, `manifest=${plugin.sha256} 实际=${hash}`);

	// contentSha256：解包后对 package/ 复算，与发布侧的算法必须逐字节一致
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verify-manifest-"));
	const untar = spawnSync("tar", ["-xzf", tgz, "-C", tmp], { encoding: "utf8" });
	if (untar.error || untar.status !== 0) {
		check(
			"plugin.contentSha256 与 tgz 解包实算一致",
			false,
			`无法解包（需要 tar）：${untar.error?.message ?? untar.stderr?.trim() ?? `exit ${untar.status}`}`,
		);
	} else {
		const pkgDir = path.join(tmp, "package");
		if (!fs.existsSync(pkgDir)) {
			check("plugin.contentSha256 与 tgz 解包实算一致", false, "tgz 内缺少 package/ 目录");
		} else {
			const digest = pluginContentDigest(pkgDir);
			check(
				"plugin.contentSha256 与 tgz 解包实算一致",
				plugin.contentSha256 === digest,
				`manifest=${plugin.contentSha256} 实际=${digest}`,
			);
			// F10/W2：验证所有直接/传递声明依赖与实际 CJS/ESM 加载图，而不只是 qrcode 入口。
			// 独立 Node 进程禁用全局搜索和 NODE_PATH/loader 污染；每个文件按 realpath 核闭包。
			// qrcode.toBuffer(PNG) smoke 同时覆盖 lazy renderer / pngjs。
			const runtime = verifyRuntimeClosure(pkgDir);
			check(
				"tgz 自包含运行时依赖（解包内可解析且可加载）",
				runtime.ok,
				runtime.ok ? `dependencies=${runtime.dependencies.join(",") || "无"}` : `问题：${runtime.error}`,
			);

			// ── 发布产物自证：tgz 内 package.json 必须就是清单描述的那一份插件包 ──
			const packedPkg = readJsonFile(path.join(pkgDir, "package.json"));
			check("tgz 内 package/package.json 可解析（发布产物身份）", packedPkg.ok,
				packedPkg.ok ? "" : String(packedPkg.error));
			if (packedPkg.ok) {
				packedPluginPackage = packedPkg.value;
				check("tgz 内插件版本与清单 plugin.version 一致", packedPkg.value.version === plugin.version,
					`tgz=${packedPkg.value.version} 清单=${plugin.version}`);
				check("tgz 内主包未声明 dsh.appCarrier（载体角色只属于载体包）",
					packedPkg.value.dsh?.appCarrier !== true);
				check("tgz 内不含 manifest.json（避免清单描述 tgz 哈希又被装进 tgz 的自指循环）",
					!fs.existsSync(path.join(pkgDir, "manifest.json")));
			}
		}
	}
	fs.rmSync(tmp, { recursive: true, force: true });
} else {
	check("plugin.size 与字节数一致", false, "tgz 缺失");
	check("plugin.sha256 与实算一致", false, "tgz 缺失");
	check("plugin.contentSha256 与 tgz 解包实算一致", false, "tgz 缺失");
	check("tgz 内 package/package.json 可解析（发布产物身份）", false, "tgz 缺失");
}

check(
	"plugin.url 若给出则为可解析的 https / 回环 http",
	(() => {
		if (plugin.url === undefined) return true;
		try {
			const u = new URL(String(plugin.url));
			if (u.hostname === "") return false;
			if (u.port !== "" && !/^\d+$/.test(u.port)) return false;
			if (u.protocol === "https:") return true;
			return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
		} catch {
			return false;
		}
	})(),
	`plugin.url=${plugin.url}`,
);

// ── 兼容镜像：顶层字段必须与 app 段同源 ──
check("镜像 version 与 app.version 一致", m.version === app.version, `top=${m.version} app=${app.version}`);
check("镜像 apk 与 app.file 一致", m.apk === app.file, `top=${m.apk} app=${app.file}`);
check("镜像 size 与 app.size 一致", m.size === app.size, `top=${m.size} app=${app.size}`);
check("镜像 sha256 与 app.sha256 一致", m.sha256 === app.sha256, `top=${m.sha256} app=${app.sha256}`);
check("notes 非空", typeof m.notes === "string" && m.notes.trim() !== "");

// ── APK 与清单配对（不需要 Android 工具；任何模式都断言）──
reportChecks(apkManifestIdentityChecks({ app, pluginVersion: plugin.version }), check);

// ── 载体配对段（设计稿 §5.1/§5.2；默认兼容单产物校验，发布门禁强制）─────────────
const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const mainPkgPath = cli.packageJson !== "" ? path.resolve(cli.packageJson) : path.join(repoRoot, "package.json");
const recordPath = cli.carrierRecord !== "" ? path.resolve(cli.carrierRecord) : path.join(dir, "app-carrier.json");
const recordRead = readJsonFile(recordPath);
const recordPresent = recordRead.ok;

let carrierFile = cli.carrier !== "" ? path.resolve(cli.carrier) : "";
let carrierCandidates = [];
if (carrierFile === "" && recordPresent && typeof recordRead.value?.file === "string" && recordRead.value.file !== "") {
	carrierFile = path.resolve(dir, recordRead.value.file);
}
if (carrierFile === "") {
	try {
		carrierCandidates = fs.readdirSync(dir).filter((name) => /-\d+\.\d+\.\d+-app\.tgz$/.test(name)).sort();
	} catch {
		carrierCandidates = [];
	}
	if (carrierCandidates.length === 1) carrierFile = path.join(dir, carrierCandidates[0]);
}

const pairingMode = cli.requireCarrier || cli.packageJson !== "" || carrierFile !== "" || carrierCandidates.length > 1;
if (pairingMode) {
	// 发布门禁才要求 F17/R9：APK 内部 versionName/versionCode 实读（缺 aapt 时显式标注未实读）。
	reportChecks(apkInternalVersionChecks({ dir, app }), check);
	// 主包 package.json：载体依赖必须精确（P0 实测：范围别名会把主插件装进别名目录）
	const mainPkgRead = readJsonFile(mainPkgPath);
	check(`主包 package.json 可解析（${mainPkgPath}）`, mainPkgRead.ok,
		mainPkgRead.ok ? "" : String(mainPkgRead.error));
	let mainPkgName = "";
	let mainPkg = null;
	if (mainPkgRead.ok) {
		mainPkg = mainPkgRead.value;
		mainPkgName = typeof mainPkg.name === "string" ? mainPkg.name : "";
		reportChecks(exactCarrierAliasChecks(mainPkg), check);
		check("主包版本与清单 plugin.version 一致", mainPkg.version === plugin.version,
			`主包=${mainPkg.version} 清单=${plugin.version}`);
	}
	// 真正被安装的是**已发布的插件 tgz**：其 package.json 也必须精确声明载体别名，
	// 不能只核对源码树（否则旧 tgz 里的范围别名会漏过门禁）。
	if (packedPluginPackage === null) {
		check("插件 tgz 内 package.json 可读（用于核对已发布产物的载体别名）", false, "tgz 缺失或 package.json 不可解析");
	} else {
		reportChecks(exactCarrierAliasChecks(packedPluginPackage), check);
		check("插件 tgz 内 package.json 与主包 package.json 同版本",
			mainPkg !== null && packedPluginPackage.version === mainPkg.version,
			`tgz=${packedPluginPackage.version ?? "<缺失>"} 主包=${mainPkg?.version ?? "<未知>"}`);
	}

	const carrierFound = carrierFile !== "" && fs.existsSync(carrierFile);
	if (cli.requireCarrier) {
		check(
			"发布顺序前置：载体 tarball 必须先于主插件发布存在（不得先发主包、后补载体）",
			carrierFound,
			carrierFound
				? path.basename(carrierFile)
				: (carrierCandidates.length > 1
					? `dist 内存在多个载体候选：${carrierCandidates.join(",")}`
					: "未找到 *-X.Y.Z-app.tgz（先运行 build-app-carrier.mjs）"),
		);
	}
	if (carrierCandidates.length > 1 && cli.carrier === "") {
		check("载体 tarball 唯一可定位（多候选且无构建记录时必须拒绝猜测）", false, carrierCandidates.join(","));
	}

	if (carrierFound) {
		const carrierStat = fs.statSync(carrierFile);
		check("载体 tarball 存在", true, `${path.basename(carrierFile)} (${carrierStat.size} B)`);
		if (recordPresent) {
			reportChecks(carrierRecordChecks(recordRead.value, { carrierFile, manifest: m }), check);
			check("构建记录的载体包名与主包一致", recordRead.value?.name === mainPkgName,
				`记录=${recordRead.value?.name ?? "<缺失>"} 主包=${mainPkgName || "<未知>"}`);
		} else if (cli.requireCarrier) {
			check("缺少载体构建记录 app-carrier.json（无法核对载体 tarball 体积/哈希）", false, recordPath);
		} else {
			console.log(`INFO  未找到载体构建记录（${recordPath}）；仅核对载体内容与发布清单`);
		}

		const failBeforeCarrierValidation = fail;
		const carrierTmp = fs.mkdtempSync(path.join(os.tmpdir(), "verify-carrier-"));
		try {
			const carrierUntar = tarExtract(carrierFile, carrierTmp);
			check("载体 tarball 可解包（需要系统 tar）", carrierUntar.ok,
				carrierUntar.ok ? "" : carrierUntar.error);
			if (carrierUntar.ok) {
				const carrierList = tarList(carrierFile);
				check("载体 tarball 可列出条目", carrierList.ok,
					carrierList.ok ? `${carrierList.entries.length} 项` : String(carrierList.error));
				if (carrierList.ok) {
					reportChecks(carrierContentsChecks({
						carrierDir: path.join(carrierTmp, "package"),
						entries: packedFiles(carrierList.entries),
						manifest: m,
						mainPkgName,
						pluginTgzFile: pluginTgzUsable ? tgz : "",
					}), check);
				}
			}
		} finally {
			fs.rmSync(carrierTmp, { recursive: true, force: true });
		}
		check(
			"发布顺序前置（载体先于主插件）：载体 tarball 已就绪并通过全部一致性校验",
			fail === failBeforeCarrierValidation,
			`本次载体检查失败 ${fail - failBeforeCarrierValidation} 项`,
		);
	}
}

console.log(`\nRESULT: ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
