#!/usr/bin/env node
// 全局单调 build 号**分配**（issue #43 / 设计稿 §5.1、§8）。
//
// 只读工具：拉取 origin+github 的 tags 与 release-meta，读取历史 tag 的 pubspec build、
// npm 已发布 carrier 的 appVersion、legacyCarriers 的已核验 appBuild，输出：
//
//   nextBuild = max(release-meta.watermark, 历史 tag build, 发布前沿) + 1
//
// fail-closed（稳定 reason）：双远端缺失/不一致、release-meta 非法、未关闭发布意图、
// 同名 tag SHA 不一致、历史 tag 缺 pubspec build、npm 元数据不可用、
// carrier 缺 appVersion 且未登记 legacyCarriers、已登记 integrity 不符。
//
// 用法：
//   node tools/next-build.mjs [--json] [--root DIR] [--package NAME] [--registry URL]
//                             [--adapters MODULE] [--remotes origin,github]
//
// 测试通过 `--adapters` 注入假适配器，全程离线；默认适配器只做 git fetch/read 与 npm view（只读）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	loadAdapters,
	readHistoricalTagBuilds,
	readPublishedCarriers,
	readReleaseMetaFromRemotes,
} from "./lib/release-adapters.mjs";
import {
	assertNoOpenReleaseIntents,
	computePublishedFrontier,
	frontierInputFromCarriers,
	parseBuildPolicy,
	parseReleaseTag,
	reason,
} from "./lib/release-policy.mjs";

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(TOOLS_DIR, "..");

const USAGE = `用法: node tools/next-build.mjs [--json] [--root DIR] [--package NAME] [--registry URL]
       [--adapters MODULE] [--remotes origin,github]

分配全局下一个发布 build（只读，不写 npm、不建 tag）。
  --json             机器可读输出（stdout 单个 JSON）
  --root DIR         仓库根（默认脚本所在仓库）
  --package NAME     主包名（默认读 <root>/package.json 的 name）
  --registry URL     只读 npm 查询使用的 registry（默认 npm 配置）
  --adapters MODULE  注入测试适配器模块（离线）
  --remotes a,b      必须一致的双远端（默认 origin,github；仅测试/特殊镜像场景使用）`;

function parseArgs(argv) {
	const options = {
		json: false,
		root: REPO_ROOT,
		packageName: null,
		registry: process.env.DSH_RELEASE_REGISTRY ?? null,
		adaptersPath: null,
		remotes: ["origin", "github"],
		help: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--json": options.json = true; break;
			case "--root": options.root = path.resolve(argv[++index]); break;
			case "--package": options.packageName = argv[++index]; break;
			case "--registry": options.registry = argv[++index]; break;
			case "--adapters": options.adaptersPath = argv[++index]; break;
			case "--remotes": options.remotes = String(argv[++index] ?? "").split(",").filter(Boolean); break;
			case "--help": case "-h": options.help = true; break;
			default: throw new Error(`未知参数: ${arg}`);
		}
	}
	if (!Array.isArray(options.remotes) || options.remotes.length < 1) throw new Error("--remotes 至少需要一个 remote");
	return options;
}

function readPackageName(root) {
	const pkgPath = path.join(root, "package.json");
	const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
	if (typeof parsed.name !== "string" || parsed.name === "") throw new Error(`package.json 缺少 name: ${pkgPath}`);
	return parsed.name;
}

function consistencyReasons(sources, remotes) {
	const reasons = [];
	const present = [];
	for (const remote of remotes) {
		const source = sources[remote];
		if (!source || typeof source.sha !== "string" || source.sha === "" || typeof source.content !== "string") {
			reasons.push(reason("release-meta-missing", `${remote}/release-meta 不可用`));
			continue;
		}
		present.push(source);
	}
	if (reasons.length === 0 && present.length > 1) {
		const [first, ...rest] = present;
		for (const other of rest) {
			if (first.sha !== other.sha) {
				reasons.push(reason("release-meta-diverged", `reference SHA: ${first.name}=${first.sha} ${other.name}=${other.sha}`));
			}
			if (first.content !== other.content) {
				reasons.push(reason("release-meta-diverged", `${first.name} 与 ${other.name} 的 build-policy.json 内容不一致`));
			}
		}
	}
	return reasons;
}

function compareRemoteTags({ git, remotes, relevantTags }) {
	const tagMaps = new Map();
	const reasons = [];
	for (const remote of remotes) {
		let tags;
		try {
			tags = git.listRemoteTags(remote);
		} catch (error) {
			reasons.push(reason(error?.releaseReason ?? "tag-metadata-unavailable", `${remote}: ${String(error?.message ?? error)}`));
			continue;
		}
		tagMaps.set(remote, new Map(tags.map((entry) => [entry.name, entry.sha])));
	}
	if (reasons.length === 0 && remotes.length > 1) {
		// 只比较**本 fork 的发布 tag**（本地 tag 的 package.json 已确认）；上游/镜像 tag
		// 可能只存在于一个远端，不应让全局 build 分配误判为双远端不一致。
		const names = new Set(relevantTags);
		for (const name of names) {
			const shas = remotes.map((remote) => tagMaps.get(remote).get(name) ?? null);
			const known = shas.filter((sha) => sha !== null);
			if (known.length !== shas.length) {
				reasons.push(reason("tag-sha-diverged", `${name} 只在部分远端存在: ${remotes.map((remote, index) => `${remote}=${shas[index] ?? "<missing>"}`).join(" ")}`));
				continue;
			}
			const unique = new Set(known);
			if (unique.size > 1) {
				reasons.push(reason("tag-sha-diverged", `${name} SHA 不一致: ${remotes.map((remote, index) => `${remote}=${shas[index]}`).join(" ")}`));
			}
		}
	}
	return { ok: reasons.length === 0, reasons };
}

/**
 * 分配核心（供 CLI 与测试直接调用）。
 * @param {{
 *   adapters: {git:object, npm:object},
 *   packageName: string,
 *   remotes?: string[],
 *   repoRoot?: string,
 * }} input
 */
export function allocateNextBuild({ adapters, packageName, remotes = ["origin", "github"], repoRoot = REPO_ROOT }) {
	const { git, npm } = adapters;
	const reasons = [];
	const fail = (extra = []) => ({ ok: false, nextBuild: null, reasons: [...reasons, ...extra] });

	// 1) 双远端 fetch（设计稿 §8：`git fetch --multiple --tags origin github`）。
	try {
		git.fetch({ remotes, repoRoot });
	} catch (error) {
		reasons.push(reason(error?.releaseReason ?? "git-fetch-failed", String(error?.message ?? error)));
		return fail();
	}

	// 2) release-meta：两个远端都必须存在、SHA 与内容完全一致（分支内副本不是权威）。
	let meta;
	try {
		meta = readReleaseMetaFromRemotes({ git, remotes });
	} catch (error) {
		return fail([reason(error?.releaseReason ?? "git-metadata-unavailable", String(error?.message ?? error))]);
	}
	if (meta.reasons.length > 0) return fail(meta.reasons);
	const sourceReasons = consistencyReasons(meta.sources, remotes);
	if (sourceReasons.length > 0) return fail(sourceReasons);
	const parsedPolicy = parseBuildPolicy(meta.sources[remotes[0]].content);
	if (!parsedPolicy.ok) return fail(parsedPolicy.reasons);
	const policy = parsedPolicy.policy;

	// 3) 存在未关闭发布意图时不得开始新分配（unknown 一律阻断）。
	const intentBlock = assertNoOpenReleaseIntents(policy);
	if (!intentBlock.ok) return fail(intentBlock.reasons);

	// 4) 历史 tag 的 build（只用于避免复用；重复值也参与 max）。
	let localTags;
	try {
		localTags = git.listTags();
	} catch (error) {
		return fail([reason(error?.releaseReason ?? "tag-metadata-unavailable", String(error?.message ?? error))]);
	}
	const releaseTags = localTags.filter((entry) => parseReleaseTag(entry.name) !== null);
	let historical;
	try {
		historical = readHistoricalTagBuilds({ git, tags: releaseTags, packageName });
	} catch (error) {
		return fail([reason(error?.releaseReason ?? "git-metadata-unavailable", String(error?.message ?? error))]);
	}
	if (!historical.ok) return fail(historical.reasons);

	// 5) 本 fork 的发布 tag 必须在双远端存在且 SHA 一致 → 否则 fail-closed。
	const relevantTags = historical.perTag.map((entry) => entry.tag);
	const tagConsistency = compareRemoteTags({ git, remotes, relevantTags });
	if (!tagConsistency.ok) return fail(tagConsistency.reasons);

	// 6) 已发布 carrier 的 appVersion / legacy appBuild → 发布前沿。
	const published = readPublishedCarriers({ npm, packageName });
	if (!published.ok) return fail(published.reasons);
	const frontierInput = frontierInputFromCarriers(published.carriers);
	const frontier = computePublishedFrontier({
		...frontierInput,
		legacyCarriers: policy.legacyCarriers,
	});
	if (!frontier.ok) return fail(frontier.reasons);

	// 7) next = max(...) + 1。
	const candidates = [
		{ source: "watermark", build: policy.watermark },
		{ source: "historical-tags", build: historical.maxBuild },
		{ source: "published-frontier", build: frontier.frontier },
	];
	const maxEntry = candidates.reduce((max, entry) => (entry.build > max.build ? entry : max), { source: "none", build: 0 });
	const nextBuild = maxEntry.build + 1;
	return {
		ok: true,
		nextBuild,
		build: nextBuild,
		watermark: policy.watermark,
		tagMaxBuild: historical.maxBuild,
		frontier: frontier.frontier,
		maxSource: maxEntry.source,
		maxBuild: maxEntry.build,
		remotes,
		releaseMeta: {
			remotes: remotes.map((remote) => ({ remote, sha: meta.sources[remote].sha })),
			legacyTags: policy.legacyTags.length,
			legacyCarriers: policy.legacyCarriers.length,
		},
		tags: historical.perTag,
		entries: frontier.entries,
		publishedCarrierCount: published.carriers.length,
		reasons: [],
	};
}

function printHuman(result, remotes) {
	console.log("Release build allocation (global monotonic build)");
	console.log(`  release-meta : ${remotes.join(" + ")} 一致${result.ok ? ` (${result.releaseMeta.remotes.map((entry) => `${entry.remote}=${entry.sha}`).join(" ")})` : ""}`);
	if (!result.ok) {
		for (const item of result.reasons) console.log(`FAIL ${item.code} (${item.detail})`);
		console.log(`REASONS: ${result.reasons.map((item) => item.code).join(",")}`);
		console.log("RESULT: FAIL");
		return;
	}
	console.log(`  watermark    : ${result.watermark}`);
	console.log(`  historical   : max build ${result.tagMaxBuild} (${result.tags.length} tags)`);
	console.log(`  frontier     : ${result.frontier} (${result.publishedCarrierCount} published carriers, ${result.releaseMeta.legacyCarriers} legacy entries)`);
	console.log(`  max source   : ${result.maxSource} -> ${result.maxBuild}`);
	console.log(`  next build   : ${result.nextBuild}`);
	console.log("RESULT: PASS");
}

async function main(argv) {
	let options;
	try {
		options = parseArgs(argv);
	} catch (error) {
		console.error(`FAIL next-build-cli-invalid: ${String(error?.message ?? error)}`);
		console.error(USAGE);
		return 2;
	}
	if (options.help) {
		console.log(USAGE);
		return 0;
	}
	let result;
	try {
		const packageName = options.packageName ?? readPackageName(options.root);
		const adapters = await loadAdapters({
			adaptersPath: options.adaptersPath,
			repoRoot: options.root,
			packageName,
			registry: options.registry,
		});
		result = allocateNextBuild({ adapters, packageName, remotes: options.remotes, repoRoot: options.root });
		options.packageName = packageName;
	} catch (error) {
		result = { ok: false, nextBuild: null, reasons: [reason("next-build-failed", String(error?.message ?? error))] };
	}
	if (options.json) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else {
		printHuman(result, options.remotes);
	}
	return result.ok ? 0 : 1;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invoked) {
	main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
		console.error(`FAIL next-build-crashed: ${String(error?.stack ?? error)}`);
		process.exit(1);
	});
}
