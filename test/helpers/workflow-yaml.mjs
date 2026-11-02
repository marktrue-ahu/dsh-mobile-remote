// 测试用**最小 YAML 子集解析器**（issue #43 复审 m10）。
//
// CI 只保证有 Node/npm（没有 yaml 依赖），因此这里实现一个足够解析本仓库 workflow 的
// 子集：块映射、块序列、行内标量、块标量（`|`）。遇到不支持的形态直接抛错（带行号），
// 让测试显式失败，而不是静默跳过。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function indentOf(line) {
	return line.length - line.trimStart().length;
}

function ignorable(line) {
	return /^\s*(?:#.*)?$/.test(line);
}

function stripQuotes(value) {
	const text = value.trim();
	if (text.length >= 2 && ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"')))) {
		return text.slice(1, -1);
	}
	return text;
}

/**
 * 解析 workflow YAML 子集。
 * @param {string} text
 * @returns {object}
 */
export function parseWorkflow(text) {
	const lines = text.split(/\r?\n/);
	let index = 0;
	const fail = (message, lineNumber = index + 1) => {
		throw new Error(`workflow-yaml: ${message} (line ${lineNumber})`);
	};
	const skipIgnorable = () => {
		while (index < lines.length && ignorable(lines[index])) index += 1;
	};

	const parseBlockScalar = (parentIndent, style) => {
		const collected = [];
		while (index < lines.length) {
			const line = lines[index];
			if (line.trim() === "") {
				collected.push("");
				index += 1;
				continue;
			}
			if (indentOf(line) <= parentIndent) break;
			collected.push(line);
			index += 1;
		}
		const nonEmpty = collected.filter((line) => line.trim() !== "");
		const contentIndent = nonEmpty.length === 0 ? parentIndent + 2 : Math.min(...nonEmpty.map((line) => indentOf(line)));
		const content = collected.map((line) => (line.trim() === "" ? "" : line.slice(contentIndent)));
		const joined = content.join("\n");
		if (style.startsWith(">")) return `${joined.replace(/\n/g, " ")}\n`;
		return joined === "" ? "" : `${joined}\n`;
	};

	const parseInlineValue = (raw) => {
		const value = raw.trim();
		if (value === "" ) return "";
		return stripQuotes(value);
	};

	const parseMap = (indent) => {
		const out = {};
		for (;;) {
			skipIgnorable();
			if (index >= lines.length) break;
			const line = lines[index];
			const currentIndent = indentOf(line);
			if (currentIndent < indent) break;
			if (currentIndent > indent) fail(`unexpected indentation (expected ${indent}, got ${currentIndent})`);
			if (/^\s*- /.test(line)) break;
			const match = /^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/.exec(line.trim());
			if (!match) fail(`unsupported mapping line: ${JSON.stringify(line)}`);
			const [, key, rawValue = ""] = match;
			index += 1;
			const value = rawValue.trim();
			if (value === "" ) {
				skipIgnorable();
				out[key] = index < lines.length && indentOf(lines[index]) > indent ? parseBlock(indent + 1) : null;
			} else if (/^[|>][+-]?$/.test(value)) {
				out[key] = parseBlockScalar(indent, value);
			} else {
				out[key] = parseInlineValue(rawValue);
			}
		}
		return out;
	};

	const parseSequence = (indent) => {
		const out = [];
		for (;;) {
			skipIgnorable();
			if (index >= lines.length) break;
			const line = lines[index];
			const currentIndent = indentOf(line);
			if (currentIndent < indent) break;
			if (currentIndent !== indent) fail(`unexpected sequence indentation`);
			if (!/^\s*- /.test(line)) break;
			const rest = line.trim().slice(2);
			index += 1;
			if (rest.trim() === "") {
				out.push(parseBlock(indent + 1));
				continue;
			}
			const match = /^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/.exec(rest);
			if (!match) {
				// 标量序列项（如 tags: 下的 `- 'v*'`）。
				out.push(stripQuotes(rest));
				continue;
			}
			const item = {};
			const [, key, rawValue = ""] = match;
			const value = rawValue.trim();
			if (value === "" ) {
				skipIgnorable();
				item[key] = index < lines.length && indentOf(lines[index]) > indent ? parseBlock(indent + 2) : null;
			} else if (/^[|>][+-]?$/.test(value)) {
				item[key] = parseBlockScalar(indent + 2, value);
			} else {
				item[key] = stripQuotes(rawValue);
			}
			// 继续同一序列项的其余 mapping key（`- name: x` 之后的 `uses:` / `with:` / `run:` ...）。
			skipIgnorable();
			if (index < lines.length && indentOf(lines[index]) > indent) {
				const extra = parseMap(indentOf(lines[index]));
				Object.assign(item, extra);
			}
			out.push(item);
		}
		return out;
	};

	const parseBlock = (minimumIndent) => {
		skipIgnorable();
		if (index >= lines.length) return null;
		const currentIndent = indentOf(lines[index]);
		if (currentIndent < minimumIndent) return null;
		if (/^\s*- /.test(lines[index])) return parseSequence(currentIndent);
		return parseMap(currentIndent);
	};

	const document = parseMap(0);
	skipIgnorable();
	if (index < lines.length) fail(`trailing content: ${JSON.stringify(lines[index])}`);
	return document;
}

export function parseWorkflowFile(file) {
	return parseWorkflow(fs.readFileSync(file, "utf8"));
}

/** 提取 job 的 steps（默认 publish job）。 */
export function workflowSteps(document, jobId = "publish") {
	const steps = document?.jobs?.[jobId]?.steps;
	if (!Array.isArray(steps)) throw new Error(`workflow job ${jobId} 缺少 steps`);
	return steps;
}

/** 每个 `run:` 块（带步骤名）。 */
export function runBlocks(document, jobId = "publish") {
	return workflowSteps(document, jobId)
		.filter((step) => typeof step.run === "string")
		.map((step) => ({ name: step.name ?? step.uses ?? "<unnamed>", run: step.run, step }));
}

/**
 * 收集一个 run 块里写入 $GITHUB_ENV 的键：
 *   - shell：`echo "KEY=..." >> "$GITHUB_ENV"` / `echo KEY=...`；
 *   - node：包含 `process.env.GITHUB_ENV` 的块里，模板/字符串中的 `KEY=` 形式。
 */
export function githubEnvKeysWritten(block) {
	const keys = new Set();
	for (const match of block.matchAll(/echo\s+(?:"|')?([A-Z][A-Z0-9_]+)=/g)) keys.add(match[1]);
	for (const match of block.matchAll(/\bprintf\s+(?:"|')([A-Z][A-Z0-9_]+)=/g)) keys.add(match[1]);
	const githubEnvIndex = block.indexOf("process.env.GITHUB_ENV");
	if (githubEnvIndex !== -1) {
		const tail = block.slice(githubEnvIndex);
		for (const match of tail.matchAll(/([A-Z][A-Z0-9_]{2,})=/g)) keys.add(match[1]);
	}
	return keys;
}

/** 同一 run 块里对刚写入的 GITHUB_ENV 键的引用（应恒为空；B1 回归）。 */
export function sameBlockEnvReferences(block) {
	const refs = [];
	for (const key of githubEnvKeysWritten(block)) {
		const pattern = new RegExp(`\\$\\{?${key}\\b`);
		if (pattern.test(block)) refs.push(key);
	}
	return refs;
}

/** 从 run 块提取 node -e / node --input-type=module -e 的内联脚本（返回 {mode, code}）。 */
export function nodeSnippets(block) {
	const snippets = [];
	const modulePattern = /\bnode\s+--input-type=module\s+-e\s+'([\s\S]*?)'(?=\s|$)/g;
	for (const match of block.matchAll(modulePattern)) snippets.push({ mode: "module", code: match[1] });
	const plainPattern = /\bnode\s+-e\s+'([\s\S]*?)'(?=\s|$)/g;
	for (const match of block.matchAll(plainPattern)) snippets.push({ mode: "cjs", code: match[1] });
	return snippets;
}

/** 语法检查：bash -n 每个 run 块。返回失败信息数组（空数组 = 全部通过）。 */
export function checkRunBlocksBashSyntax(blocks) {
	const failures = [];
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wf-bash-"));
	try {
		blocks.forEach((block, position) => {
			const file = path.join(dir, `block-${position}.sh`);
			fs.writeFileSync(file, `#!/usr/bin/env bash\n${block.run}\n`, "utf8");
			const result = spawnSync("bash", ["-n", file], { encoding: "utf8" });
			if (result.status !== 0) failures.push({ name: block.name, detail: result.stderr });
		});
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	return failures;
}

/** 语法检查：node --check 每个内联 node 脚本。返回失败信息数组。 */
export function checkNodeSnippetsSyntax(blocks) {
	const failures = [];
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wf-node-"));
	try {
		blocks.forEach((block, blockPosition) => {
			nodeSnippets(block.run).forEach((snippet, snippetPosition) => {
				const extension = snippet.mode === "module" ? "mjs" : "cjs";
				const file = path.join(dir, `block-${blockPosition}-snippet-${snippetPosition}.${extension}`);
				fs.writeFileSync(file, snippet.code, "utf8");
				const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
				if (result.status !== 0) failures.push({ name: block.name, detail: result.stderr });
			});
		});
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	return failures;
}
