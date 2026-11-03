#!/usr/bin/env node
// 插件内容标识（CONTEXT「内容标识」）：对插件自身的 `package.json` + `lib/**` 做规范化哈希。
//
// 为什么要它：manifest 的 `sha256` 是 **tgz 压缩包的字节哈希**，运行中的插件无法从已解开的
// 目录里复算；而「同一个版本号、不同内容」是真实存在的形态（上游 v3.2.0 与本仓库 develop
// 的插件版本号都是 3.2.0）。所以另给一个**内容哈希**，让发布侧（打包前）、产物侧
// （tgz 解包）与运行侧（已安装副本）三处都能算出同一个值。
//
// 规范（改动即需升 CONTENT_DIGEST_VERSION，否则同一算法下新旧值不可比）：
//   1. 参与文件：顶层 `package.json` + 递归 `lib/**`；
//      排除 `node_modules` 与以 `.` 开头的条目；
//   2. 路径一律用 `/` 分隔、按字节序升序排列，保证与文件系统枚举顺序无关；
//   3. 每个文件先把 CRLF 归一为 LF 再哈希（Windows 检出与 Linux 打包必须得到同一个值），
//      按字节（latin1 往返）处理，避免 UTF-8 解码改变内容；
//   4. 文本形式为 `plugin-content-digest/v1\n` + 每行 `<相对路径> <文件哈希>\n`，
//      再取整段的 sha256 作为内容标识。
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** 内容标识算法的版本；算法本身变化时必须递增。 */
export const CONTENT_DIGEST_VERSION = 1;
/** 参与哈希的顶层文件。 */
const TOP_FILES = ["package.json"];
/** 参与哈希的目录（递归）。 */
const TOP_DIRS = ["lib"];

/** CRLF → LF 的字节级归一（不经 UTF-8 解码，二进制内容也能安全往返）。 */
export function normalizeLineEndings(buf) {
	return Buffer.from(buf.toString("binary").replace(/\r\n/g, "\n"), "binary");
}

/** 收集参与哈希的相对路径，按字节序升序。 */
function collectRelPaths(root) {
	const found = [];
	for (const f of TOP_FILES) {
		try {
			if (statSync(join(root, f)).isFile()) found.push(f);
		} catch {
			// 缺失即不参与（发布侧会在别处报"必需文件缺失"）
		}
	}
	const walk = (rel) => {
		let entries;
		try {
			entries = readdirSync(join(root, rel), { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.name === "node_modules" || e.name.startsWith(".")) continue;
			const child = `${rel}/${e.name}`;
			if (e.isDirectory()) walk(child);
			else if (e.isFile()) found.push(child);
		}
	};
	for (const d of TOP_DIRS) walk(d);
	return found.sort();
}

/**
 * 计算插件内容标识。
 * @param {string} root 插件根目录（含 `package.json` 与 `lib/`）
 * @returns {string} 64 位小写 hex
 */
export function pluginContentDigest(root) {
	const h = createHash("sha256");
	h.update(`plugin-content-digest/v${CONTENT_DIGEST_VERSION}\n`);
	for (const rel of collectRelPaths(root)) {
		const bytes = normalizeLineEndings(readFileSync(join(root, rel)));
		const fileHash = createHash("sha256").update(bytes).digest("hex");
		h.update(`${rel} ${fileHash}\n`);
	}
	return h.digest("hex");
}

/** 参与哈希的相对路径清单（诊断与测试用；与 pluginContentDigest 的输入完全一致）。 */
export function pluginContentFiles(root) {
	return collectRelPaths(root);
}
