#!/usr/bin/env node
// 生成**发布清单**（CONTEXT「发布清单」，schema 1）：同时描述同一次发布的两端产物——
// 插件包（tgz）与 App 安装包（APK）——以及各自的完整性标识。
//
// 为什么是清单而不是版本号：插件存在「同一个版本号、不同内容」的真实形态（上游 v3.2.0 与
// 本仓库 develop 的插件版本号都是 3.2.0）。所以清单里同时给出：
//   - `sha256`       产物的字节哈希（tgz 与 GitHub Release asset 自带的 digest 一致）
//   - `contentSha256` 插件**内容**标识（`package.json` + `lib/**` 的规范化哈希，运行中的
//                     插件能从已安装副本自行复算，见 lib/plugin-content-digest.js）
// 决定「要不要下载新版本」只看内容标识；版本号只用于生成对齐提示文案。
//
// package-release.sh 与 package-release.ps1 共用本生成器，保证双端产出等价：
// JSON.stringify 保证合法（notes 含引号/反斜杠自动转义）、UTF-8 无 BOM、
// notes 取 CHANGELOG 最新条目全文、哈希一律小写 hex、size 一律字节数。
//
// 用法：node gen-manifest.js --apk <DSH-Remote-vX.Y.Z.apk> --version <X.Y.Z+BUILD> \
//         --plugin-tgz <dsh-mobile-remote-vX.Y.Z.tgz> --changelog <CHANGELOG.md> \
//         --out <manifest.json> [--plugin-root <插件根目录>] [--plugin-url <下载地址>]
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { pluginContentDigest } from "../../lib/plugin-content-digest.js";

/** 清单 schema 版本；结构变化时递增。 */
const MANIFEST_SCHEMA = 1;

function arg(name) {
	const i = process.argv.indexOf(`--${name}`);
	if (i === -1 || i + 1 >= process.argv.length) return "";
	return process.argv[i + 1];
}

const apk = arg("apk");
const version = arg("version");
const changelog = arg("changelog");
const out = arg("out");
const pluginTgz = arg("plugin-tgz");
const pluginUrl = arg("plugin-url");
const pluginRoot = arg("plugin-root")
	|| path.resolve(fileURLToPath(import.meta.url), "../..", "..");

if (!apk || !version || !out || !pluginTgz) {
	console.error(
		"Usage: node gen-manifest.js --apk <file> --version <X.Y.Z+BUILD> --plugin-tgz <file> "
		+ "--changelog <file> --out <file> [--plugin-root <dir>] [--plugin-url <url>]",
	);
	process.exit(1);
}
if (!fs.existsSync(apk)) {
	console.error(`APK not found: ${apk}`);
	process.exit(1);
}
if (!fs.existsSync(pluginTgz)) {
	console.error(`Plugin tarball not found: ${pluginTgz}`);
	process.exit(1);
}

// CHANGELOG 最新条目全文：从第一个 `## ` 标题到下一个 `## `（或 EOF），去尾部空行。
// 无 CHANGELOG / 无条目时缺省 notes（manifest 契约中 notes 可选）。
let notes = "";
try {
	const text = fs.readFileSync(changelog, "utf8");
	const lines = text.split(/\r?\n/);
	const start = lines.findIndex((l) => l.startsWith("## "));
	if (start !== -1) {
		let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
		if (end === -1) end = lines.length;
		while (end > start && lines[end - 1].trim() === "") end--;
		notes = lines.slice(start, end).join("\n").trim();
	}
} catch {
	console.error(`CHANGELOG not found or unreadable: ${changelog}`);
	process.exit(1);
}
if (!notes) {
	console.error("CHANGELOG has no release entry (expected a ## heading)");
	process.exit(1);
}

// 插件版本取自插件自身的 package.json（App 版本来自 pubspec 的 X.Y.Z+N，两者语义版本相同）
let pluginVersion = "";
try {
	pluginVersion = JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"), "utf8")).version ?? "";
} catch (e) {
	console.error(`Cannot read plugin version from ${path.join(pluginRoot, "package.json")}: ${e}`);
	process.exit(1);
}
if (!/^\d+\.\d+\.\d+$/.test(pluginVersion)) {
	console.error(`Plugin version must be X.Y.Z, got: ${pluginVersion}`);
	process.exit(1);
}

const apkBuf = fs.readFileSync(apk);
const tgzBuf = fs.readFileSync(pluginTgz);
const app = {
	version,
	file: path.basename(apk),
	size: apkBuf.length,
	sha256: crypto.createHash("sha256").update(apkBuf).digest("hex"),
};
const plugin = {
	version: pluginVersion,
	file: path.basename(pluginTgz),
	size: tgzBuf.length,
	sha256: crypto.createHash("sha256").update(tgzBuf).digest("hex"),
	contentSha256: pluginContentDigest(pluginRoot),
	...(pluginUrl ? { url: pluginUrl } : {}),
};

const manifest = {
	schema: MANIFEST_SCHEMA,
	app,
	plugin,
	// ── 兼容镜像（过渡用）──────────────────────────────────────────────
	// App 侧既有主机源解析器读的是顶层 `version`/`apk`/`size`/`sha256`/`notes`。
	// 这里保留一份**与 app 段同源**的镜像，使尚未升级到嵌套 schema 的 App 也能继续更新；
	// verify-update-manifest.mjs 会断言两者一致。待旧版 App 退役后可移除。
	version: app.version,
	apk: app.file,
	size: app.size,
	sha256: app.sha256,
	...(notes ? { notes } : {}),
};

// UTF-8 无 BOM（Windows PowerShell 5.x 的 Set-Content -Encoding UTF8 会带 BOM，Node JSON.parse 抛错）
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log(`Manifest: ${out}`);
console.log(fs.readFileSync(out, "utf8"));
