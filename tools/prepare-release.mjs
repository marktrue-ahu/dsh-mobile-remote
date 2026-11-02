#!/usr/bin/env node
// 原子 bump 工具（issue #43 / 设计稿 §8 步骤 3）。
//
// 一次写入四处并做发布前校验，任一步失败**不留下半更新**：
//   1) 根 package.json：version = X.Y.Z[-pre]，精确 carrier alias = npm:<name>@<version>-app；
//   2) dsh-mobile-app/pubspec.yaml：version = <core>+<build>；
//   3) CHANGELOG.md：插入本次发布骨架条目；
//   4) 校验（exactCarrierAliasChecks / pubspec 解析 / build 递增 / npm 版本未占用）。
//
// 不负责 tag / push / 发布。--build 省略时调用 next-build 分配（需要双远端 release-meta 可用）。
//
// 用法：
//   node tools/prepare-release.mjs --version 3.2.4-alpha.2 [--build 33] [--json]
//        [--root DIR] [--adapters MODULE] [--registry URL]
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { loadAdapters, parsePubspecVersion } from "./lib/release-adapters.mjs";
import {
	isPluginVersion,
	isPositiveInteger,
	parseSemver,
	reason,
} from "./lib/release-policy.mjs";
import { allocateNextBuild } from "./next-build.mjs";

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(TOOLS_DIR, "..");

const USAGE = `用法: node tools/prepare-release.mjs --version X.Y.Z[-pre] [--build N] [--json]
       [--root DIR] [--adapters MODULE] [--registry URL]

原子更新 package.json（version + 精确 carrier alias）、pubspec.yaml、CHANGELOG 骨架；
--build 省略时由 tools/next-build.mjs 分配。不建 tag、不推送、不发布。`;

function parseArgs(argv) {
	const options = {
		version: null,
		build: null,
		json: false,
		root: REPO_ROOT,
		registry: process.env.DSH_RELEASE_REGISTRY ?? null,
		adaptersPath: null,
		help: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--version": options.version = argv[++index]; break;
			case "--build": {
				const raw = argv[++index];
				options.build = /^\d+$/.test(String(raw)) ? Number.parseInt(String(raw), 10) : Number.NaN;
				break;
			}
			case "--json": options.json = true; break;
			case "--root": options.root = path.resolve(argv[++index]); break;
			case "--adapters": options.adaptersPath = argv[++index]; break;
			case "--registry": options.registry = argv[++index]; break;
			case "--help": case "-h": options.help = true; break;
			default: throw new Error(`未知参数: ${arg}`);
		}
	}
	return options;
}

function readText(file) {
	return fs.readFileSync(file, "utf8");
}

function failResult(reasons, extra = {}) {
	return { ok: false, reasons, ...extra };
}

/** 替换 pubspec 的 version 行（必须恰好存在一行）。 */
function bumpPubspec(text, { core, build }) {
	const lines = text.split(/\r?\n/);
	let found = -1;
	for (let index = 0; index < lines.length; index += 1) {
		if (/^version:[ \t]*/.test(lines[index])) {
			if (found !== -1) return { ok: false, reason: reason("pubspec-version-ambiguous", "pubspec.yaml 存在多行 version:") };
			found = index;
		}
	}
	if (found === -1) return { ok: false, reason: reason("pubspec-version-missing", "pubspec.yaml 缺少 version:") };
	lines[found] = `version: ${core}+${build}`;
	return { ok: true, text: lines.join("\n"), previous: text.split(/\r?\n/)[found] };
}

/** 在 CHANGELOG 标题后插入骨架条目；已存在同版本条目返回冲突。 */
function insertChangelogEntry(text, { version, core, build }) {
	if (new RegExp(`^## v${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\(|（|\\s|$)`, "m").test(text)) {
		return { ok: false, reason: reason("changelog-entry-exists", `CHANGELOG.md 已有 v${version} 条目`) };
	}
	const entry = [
		`## v${version}（build ${build}，issues …）— 摘要`,
		"",
		`> 插件 \`${version}\` / App \`${core}+${build}\` / 载体 \`${version}-app\`。`,
		"",
		"### 变更",
		"",
		"- TODO：填写本次发布内容（清单 notes 取本条目全文）。",
		"",
		"",
	].join("\n");
	const heading = /^# Changelog[ \t]*$/m.exec(text);
	if (heading === null) {
		return { ok: true, text: `# Changelog\n\n${entry}${text}` };
	}
	const insertAt = heading.index + heading[0].length;
	const before = text.slice(0, insertAt);
	const after = text.slice(insertAt).replace(/^\r?\n+/, "\n");
	return { ok: true, text: `${before}\n\n${entry}${after}` };
}

/** 原子写多个文件：先把全部内容写到临时文件，再逐个 rename；任一步失败回滚已改文件。 */
export function writeFilesAtomically(writes, { tempTag = `${process.pid}-${Date.now()}` } = {}) {
	const applied = [];
	const temps = [];
	try {
		for (const write of writes) {
			const temp = `${write.file}.tmp-${tempTag}`;
			fs.writeFileSync(temp, write.content, "utf8");
			temps.push(temp);
		}
		for (let index = 0; index < writes.length; index += 1) {
			const write = writes[index];
			const backup = write.previous;
			fs.renameSync(temps[index], write.file);
			applied.push({ file: write.file, backup });
		}
		for (const temp of temps) {
			try { fs.rmSync(temp, { force: true }); } catch { /* 已 rename 的不存在 */ }
		}
		return { ok: true };
	} catch (error) {
		for (const item of applied.reverse()) {
			try { fs.writeFileSync(item.file, item.backup, "utf8"); } catch { /* 尽力回滚 */ }
		}
		for (const temp of temps) {
			try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
		}
		return { ok: false, error: String(error?.message ?? error) };
	}
}

/**
 * 核心实现（供测试直接调用；CLI 只是包装）。
 * @param {{
 *   root?: string, version: string, build?: number|null,
 *   adapters?: object|null, registry?: string|null,
 * }} input
 */
export async function prepareRelease({ root = REPO_ROOT, version, build = null, adapters = null, registry = null } = {}) {
	const reasons = [];
	if (!isPluginVersion(version)) {
		return failResult([reason("prepare-version-invalid", String(version))]);
	}
	const parsedVersion = parseSemver(version);
	const core = `${parsedVersion.major}.${parsedVersion.minor}.${parsedVersion.patch}`;

	const packageFile = path.join(root, "package.json");
	const pubspecFile = path.join(root, "dsh-mobile-app", "pubspec.yaml");
	const changelogFile = path.join(root, "CHANGELOG.md");
	for (const file of [packageFile, pubspecFile, changelogFile]) {
		if (!fs.existsSync(file)) reasons.push(reason("prepare-file-missing", file));
	}
	if (reasons.length > 0) return failResult(reasons);

	let packageJson;
	try {
		packageJson = JSON.parse(readText(packageFile));
	} catch (error) {
		return failResult([reason("package-json-invalid", String(error?.message ?? error))]);
	}
	const packageName = typeof packageJson.name === "string" ? packageJson.name : "";
	if (packageName === "") return failResult([reason("package-name-missing", packageFile)]);
	const pubspecText = readText(pubspecFile);
	const currentPubspec = parsePubspecVersion(pubspecText);
	if (currentPubspec === null) return failResult([reason("pubspec-version-invalid", "需要 X.Y.Z+N")]);

	let resolvedBuild = build;
	if (resolvedBuild === null || resolvedBuild === undefined) {
		if (adapters === null) {
			try {
				adapters = await loadAdapters({ adaptersPath: null, repoRoot: root, packageName, registry });
			} catch (error) {
				return failResult([reason("adapters-unavailable", String(error?.message ?? error))]);
			}
		}
		const allocation = allocateNextBuild({ adapters, packageName, repoRoot: root });
		if (!allocation.ok) return failResult(allocation.reasons.map((item) => ({ ...item, phase: "next-build" })));
		resolvedBuild = allocation.nextBuild;
	}
	if (!isPositiveInteger(resolvedBuild)) {
		return failResult([reason("prepare-build-invalid", String(resolvedBuild))]);
	}
	if (resolvedBuild <= currentPubspec.build) {
		reasons.push(reason("build-not-increased", `build=${resolvedBuild} 必须大于当前 pubspec build=${currentPubspec.build}`));
	}

	// package.json：version + 精确 carrier alias。
	const nextPackage = JSON.parse(JSON.stringify(packageJson));
	nextPackage.version = version;
	const alias = `${packageName}-app`;
	const expectedAlias = `npm:${packageName}@${version}-app`;
	nextPackage.optionalDependencies = { ...(nextPackage.optionalDependencies ?? {}), [alias]: expectedAlias };
	const packageText = `${JSON.stringify(nextPackage, null, 2)}\n`;

	// exactCarrierAliasChecks 是发布链的共享判定（根 tools/ 引用 dsh-mobile-app/tools/lib）。
	const releaseChecksUrl = pathToFileURL(path.join(root, "dsh-mobile-app", "tools", "lib", "release-checks.mjs")).href;
	let aliasChecks;
	try {
		const releaseChecks = await import(releaseChecksUrl);
		aliasChecks = releaseChecks.exactCarrierAliasChecks(nextPackage);
	} catch (error) {
		return failResult([reason("exact-carrier-alias-check-failed", String(error?.message ?? error))]);
	}
	const failedAliasChecks = aliasChecks.filter((check) => !check.pass);
	if (failedAliasChecks.length > 0) {
		return failResult(failedAliasChecks.map((check) => reason("exact-carrier-alias-check-failed", `${check.name}: ${check.detail}`)));
	}

	// pubspec.yaml。
	const pubspec = bumpPubspec(pubspecText, { core, build: resolvedBuild });
	if (!pubspec.ok) return failResult([pubspec.reason]);
	const nextPubspec = parsePubspecVersion(pubspec.text);
	if (nextPubspec === null || nextPubspec.core !== core || nextPubspec.build !== resolvedBuild) {
		return failResult([reason("pubspec-bump-failed", "写入后无法解析出期望的 core+build")]);
	}

	// CHANGELOG.md。
	const changelog = insertChangelogEntry(readText(changelogFile), { version, core, build: resolvedBuild });
	if (!changelog.ok) return failResult([changelog.reason]);

	// npm：目标版本（插件与载体）不得已被占用。
	if (adapters === null) {
		try {
			adapters = await loadAdapters({ adaptersPath: null, repoRoot: root, packageName, registry });
		} catch (error) {
			return failResult([reason("adapters-unavailable", String(error?.message ?? error))]);
		}
	}
	for (const candidateVersion of [version, `${version}-app`]) {
		let existing;
		try {
			existing = adapters.npm.viewVersion(packageName, candidateVersion);
		} catch (error) {
			return failResult([reason("npm-metadata-unavailable", String(error?.message ?? error))]);
		}
		if (existing !== null && existing !== undefined) {
			reasons.push(reason("npm-version-already-published", `${packageName}@${candidateVersion} 已存在`));
		}
	}
	if (reasons.length > 0) return failResult(reasons);

	const writes = [
		{ file: packageFile, previous: readText(packageFile), content: packageText },
		{ file: pubspecFile, previous: pubspecText, content: pubspec.text },
		{ file: changelogFile, previous: readText(changelogFile), content: changelog.text },
	];
	const changed = writes.filter((write) => write.previous !== write.content);
	if (changed.length === 0) {
		return {
			ok: true,
			changed: false,
			version,
			build: resolvedBuild,
			core,
			root,
			files: writes.map((write) => path.relative(root, write.file)),
			reasons: [],
		};
	}
	const applied = writeFilesAtomically(changed);
	if (!applied.ok) {
		return failResult([reason("prepare-write-failed", applied.error)]);
	}
	return {
		ok: true,
		changed: true,
		version,
		build: resolvedBuild,
		core,
		root,
		files: changed.map((write) => path.relative(root, write.file)),
		reasons: [],
	};
}

function printHuman(result) {
	if (!result.ok) {
		for (const item of result.reasons) console.log(`FAIL ${item.code} (${item.detail})`);
		console.log(`REASONS: ${result.reasons.map((item) => item.code).join(",")}`);
		console.log("RESULT: FAIL");
		return;
	}
	console.log(`Prepared release: plugin ${result.version} / App ${result.core}+${result.build}`);
	console.log(`  changed : ${result.changed ? result.files.join(", ") : "none (already up to date)"}`);
	console.log("  next    : fill CHANGELOG, run gates, then tag/push with explicit authorization");
	console.log("RESULT: PASS");
}

async function main(argv) {
	let options;
	try {
		options = parseArgs(argv);
	} catch (error) {
		console.error(`FAIL prepare-release-cli-invalid: ${String(error?.message ?? error)}`);
		console.error(USAGE);
		return 2;
	}
	if (options.help) { console.log(USAGE); return 0; }
	if (!options.version) {
		console.error("FAIL prepare-release-cli-invalid: 必须指定 --version");
		console.error(USAGE);
		return 2;
	}
	let result;
	try {
		result = await prepareRelease({
			root: options.root,
			version: options.version,
			build: options.build,
			registry: options.registry,
			adapters: options.adaptersPath === null
				? null
				: await loadAdapters({ adaptersPath: options.adaptersPath, repoRoot: options.root, packageName: null, registry: options.registry }),
		});
	} catch (error) {
		result = failResult([reason("prepare-release-crashed", String(error?.stack ?? error))]);
	}
	if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	else printHuman(result);
	return result.ok ? 0 : 1;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invoked) {
	main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
		console.error(`FAIL prepare-release-crashed: ${String(error?.stack ?? error)}`);
		process.exit(1);
	});
}
