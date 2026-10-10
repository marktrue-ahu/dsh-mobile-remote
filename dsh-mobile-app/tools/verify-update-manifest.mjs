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
// 用法：node tools/verify-update-manifest.mjs [dist目录]（默认 dsh-mobile-app/dist）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { pluginContentDigest } from "../../lib/plugin-content-digest.js";

const dir = process.argv[2]
	? path.resolve(process.argv[2])
	: path.resolve(fileURLToPath(new URL("../dist", import.meta.url)));
const manifestPath = path.join(dir, "manifest.json");

let fail = 0;
function check(name, pass, detail = "") {
	if (!pass) fail++;
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
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
check("plugin.file 存在", tgz !== "" && fs.existsSync(tgz), `plugin.file=${plugin.file}`);
if (tgz && fs.existsSync(tgz)) {
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
			// R13 / F10：tgz 必须**自包含运行时依赖**——离线 / vendored 安装解包后要能直接 require。
			// 只核哈希会放过"哈希正确但装不起来"的包；只 require.resolve 又会放过
			// "解析到解包目录之外（上层 node_modules / 全局包兜底）"与"解析得到但加载即抛"。
			try {
				const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
				const deps = Object.keys(pkg.dependencies ?? {});
				const req = createRequire(path.join(pkgDir, "package.json"));
				const pkgReal = fs.realpathSync(pkgDir) + path.sep;
				const problems = [];
				for (const dep of deps) {
					let resolved;
					try {
						resolved = req.resolve(dep);
					} catch (e) {
						problems.push(`${dep}:无法解析(${e.code ?? e.message})`);
						continue;
					}
					const real = fs.realpathSync(resolved);
					if (!real.startsWith(pkgReal)) {
						problems.push(`${dep}:解析到解包目录之外(${real})`);
						continue;
					}
					try {
						req(dep);
					} catch (e) {
						problems.push(`${dep}:加载失败(${e.message})`);
					}
				}
				check(
					"tgz 自包含运行时依赖（解包内可解析且可加载）",
					problems.length === 0,
					problems.length === 0 ? `dependencies=${deps.join(",") || "无"}` : `问题：${problems.join("；")}`,
				);
			} catch (e) {
				check("tgz 自包含运行时依赖（解包内可解析且可加载）", false, `读取 package.json 失败：${e.message}`);
			}
		}
	}
	fs.rmSync(tmp, { recursive: true, force: true });
} else {
	check("plugin.size 与字节数一致", false, "tgz 缺失");
	check("plugin.sha256 与实算一致", false, "tgz 缺失");
	check("plugin.contentSha256 与 tgz 解包实算一致", false, "tgz 缺失");
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

console.log(`\nRESULT: ${fail === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 ? 0 : 1);
