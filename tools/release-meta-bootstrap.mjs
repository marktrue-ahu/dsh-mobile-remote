#!/usr/bin/env node
// `release-meta` 迁移种子工具（issue #43 / 设计稿 §12）。
//
// 生成/校验受保护发布政策记录 `release-meta:build-policy.json`：
//   { schema: 1, watermark: 32, legacyTags: [...8 个历史 tag], legacyCarriers: [...8 个已发布 carrier] }
//
// - 历史 tag 从 git 读取；已发布 carrier 从 npm **只读**查询。
// - 迁移前 3 个缺顶层 `appVersion` 的旧 carrier：下载 tarball、按 `dist.integrity` 校验 sha512、
//   解包读取内嵌 manifest.json 的 app.version（必要时 aapt 实读 APK versionCode），
//   登记精确 `{version, integrity, appBuild}`；已发布包一个字节都不改。
// - `--write-ref` 用 git plumbing 创建本地 `release-meta` 分支（不切换工作树、不推送）；
//   推送需要显式授权，工具只打印命令。
// - `--check` 校验现有政策记录与观测数据一致（watermark 只升不降、legacy 无遗漏/无漂移）。
//
// 不发布任何 npm 包；`npm view` / `npm pack` 都是只读。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readApkBadging, tarExtract } from "../dsh-mobile-app/tools/lib/release-checks.mjs";
import {
	fileIntegrity,
	loadAdapters,
	parsePubspecVersion,
	readEmbeddedCarrierBuild,
	readHistoricalTagBuilds,
} from "./lib/release-adapters.mjs";
import {
	MIGRATION_WATERMARK,
	RELEASE_META_BRANCH,
	RELEASE_META_PATH,
	assertWatermarkNotRegressed,
	compareSemver,
	parseCarrierVersion,
	parseReleaseTag,
	reason,
	serializeBuildPolicy,
	validateBuildPolicy,
} from "./lib/release-policy.mjs";

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(TOOLS_DIR, "..");

const USAGE = `用法: node tools/release-meta-bootstrap.mjs [--json] [--root DIR]
       [--watermark N] [--out FILE] [--write-ref [--branch release-meta] [--base REF]]
       [--check --policy FILE] [--from-ref REF] [--evidence FILE]
       [--adapters MODULE] [--registry URL] [--keep] [--force]

默认把生成的 build-policy.json 写到 stdout（可重定向为文件）。
  --watermark N     迁移水位（默认 max(${MIGRATION_WATERMARK}, 当前 develop pubspec build)）
  --out FILE        把种子写到文件
  --write-ref       创建本地 release-meta 分支（git plumbing，不切换工作树、不推送）；
                    分支已存在时默认拒绝（避免覆盖已有政策记录），--force 才覆盖
  --check           校验 --policy（或 --from-ref:release-meta:build-policy.json）与观测数据一致
  --evidence FILE   把 legacy carrier 核验证据（下载的 tarball integrity / 读取方式）写到文件
  --keep            保留临时下载/解包目录（排障用）`;

function parseArgs(argv) {
	const options = {
		json: false,
		root: REPO_ROOT,
		watermark: null,
		out: null,
		writeRef: false,
		branch: RELEASE_META_BRANCH,
		base: "HEAD",
		check: false,
		policy: null,
		fromRef: null,
		evidence: null,
		registry: process.env.DSH_RELEASE_REGISTRY ?? null,
		adaptersPath: null,
		keep: false,
		force: false,
		help: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--json": options.json = true; break;
			case "--root": options.root = path.resolve(argv[++index]); break;
			case "--watermark": options.watermark = Number.parseInt(argv[++index], 10); break;
			case "--out": options.out = path.resolve(argv[++index]); break;
			case "--write-ref": options.writeRef = true; break;
			case "--branch": options.branch = argv[++index]; break;
			case "--base": options.base = argv[++index]; break;
			case "--check": options.check = true; break;
			case "--policy": options.policy = path.resolve(argv[++index]); break;
			case "--from-ref": options.fromRef = argv[++index]; break;
			case "--evidence": options.evidence = path.resolve(argv[++index]); break;
			case "--adapters": options.adaptersPath = argv[++index]; break;
			case "--registry": options.registry = argv[++index]; break;
			case "--keep": options.keep = true; break;
			case "--force": options.force = true; break;
			case "--help": case "-h": options.help = true; break;
			default: throw new Error(`未知参数: ${arg}`);
		}
	}
	return options;
}

function readJson(file) {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

function compareCarrierEntries(left, right) {
	const a = parseCarrierVersion(left.version)?.pluginVersion ?? "0.0.0";
	const b = parseCarrierVersion(right.version)?.pluginVersion ?? "0.0.0";
	const order = compareSemver(a, b);
	if (order !== 0) return order;
	return String(left.version).localeCompare(String(right.version));
}

function readApkBuild(apkFile) {
	const parsed = readApkBadging(apkFile);
	if (!parsed.ok) return null;
	const versionCode = Number.parseInt(parsed.versionCode, 10);
	return Number.isSafeInteger(versionCode) && versionCode > 0 ? versionCode : null;
}

function extractTarball(tgzFile, destDir) {
	const extracted = tarExtract(tgzFile, destDir);
	if (!extracted.ok) throw new Error(`解包失败: ${extracted.error}`);
	return path.join(destDir, "package");
}

function isThisPackageTag({ git, tag, packageName }) {
	if (packageName === null || packageName === undefined) return true;
	try {
		const text = git.show(tag, "package.json");
		if (text === null) return false;
		return JSON.parse(text).name === packageName;
	} catch {
		return false;
	}
}

function selectHistoricalTags({ git, packageName = null }) {
	let tags;
	try {
		tags = git.listTags();
	} catch (error) {
		return { ok: false, reasons: [reason("tag-metadata-unavailable", String(error?.message ?? error))] };
	}
	const releaseTags = tags
		.filter((entry) => parseReleaseTag(entry.name) !== null)
		.filter((entry) => isThisPackageTag({ git, tag: entry.name, packageName }))
		.map((entry) => entry.name)
		.sort((left, right) => {
			const a = parseReleaseTag(left);
			const b = parseReleaseTag(right);
			return compareSemver(a.pluginVersion, b.pluginVersion) || left.localeCompare(right);
		});
	return { ok: true, tags: releaseTags, reasons: [] };
}

/**
 * 从观测数据构造迁移种子（供 CLI 与测试直接调用）。
 * @param {{ adapters: object, packageName: string, currentBuild: number|null, watermark?: number|null,
 *           workDir?: string, keepTarballs?: boolean }} input
 */
export async function buildReleaseMetaSeed({
	adapters,
	packageName,
	currentBuild = null,
	watermark = null,
	workDir = null,
	keepTarballs = false,
} = {}) {
	const { git, npm } = adapters;
	const reasons = [];

	const historicalTags = selectHistoricalTags({ git, packageName });
	if (!historicalTags.ok) return { ok: false, reasons: historicalTags.reasons, policy: null, evidence: null };
	const historical = readHistoricalTagBuilds({ git, tags: historicalTags.tags, packageName });
	if (!historical.ok) return { ok: false, reasons: historical.reasons, policy: null, evidence: null };

	let versions;
	try {
		versions = npm.listVersions(packageName);
	} catch (error) {
		return { ok: false, reasons: [reason("npm-metadata-unavailable", String(error?.message ?? error))], policy: null, evidence: null };
	}
	const carrierVersions = versions
		.map(String)
		.filter((version) => version.endsWith("-app") && parseCarrierVersion(version) !== null)
		.sort((left, right) => compareCarrierEntries({ version: left }, { version: right }));

	const legacyCarriers = [];
	const evidence = { generatedAt: new Date().toISOString(), carriers: [] };
	const tempRoot = workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "dsh-release-meta-"));
	const tempDir = workDir ?? (keepTarballs ? tempRoot : null);
	const cleanup = () => {
		if (workDir === null && !keepTarballs) fs.rmSync(tempRoot, { recursive: true, force: true });
	};
	for (const version of carrierVersions) {
		let metadata;
		try {
			metadata = npm.viewVersion(packageName, version);
		} catch (error) {
			reasons.push(reason("npm-metadata-unavailable", `${version}: ${String(error?.message ?? error)}`));
			continue;
		}
		if (metadata === null) {
			reasons.push(reason("carrier-metadata-missing", `${packageName}@${version} 在 versions 中出现但不可读`));
			continue;
		}
		const integrity = metadata?.dist?.integrity;
		if (typeof integrity !== "string" || integrity === "") {
			reasons.push(reason("carrier-integrity-missing", `${version} 缺 dist.integrity`));
			continue;
		}
		const carrierEvidence = { version, integrity, appVersion: metadata?.appVersion ?? null, method: null };
		const topLevelBuild = typeof metadata?.appVersion === "string"
			? (() => {
				const match = /^\d+\.\d+\.\d+\+(\d+)$/.exec(metadata.appVersion);
				return match ? Number.parseInt(match[1], 10) : null;
			})()
			: null;
		let appBuild = topLevelBuild;
		if (appBuild !== null) {
			carrierEvidence.method = "appVersion";
		} else {
			// 迁移前旧 carrier：只能下载 tarball、按 integrity 核验后读取内嵌 manifest/APK build。
			let downloaded;
			try {
				downloaded = npm.downloadTarball(packageName, version, path.join(tempRoot, "tarballs"));
			} catch (error) {
				reasons.push(reason("bootstrap-tarball-download-failed", `${version}: ${String(error?.message ?? error)}`));
				continue;
			}
			const actualIntegrity = fileIntegrity(downloaded.file);
			if (actualIntegrity !== integrity) {
				reasons.push(reason("legacy-carrier-integrity-mismatch", `${version}: registry=${integrity} tarball=${actualIntegrity}`));
				continue;
			}
			let carrierDir;
			try {
				carrierDir = extractTarball(downloaded.file, path.join(tempRoot, "carriers", version));
			} catch (error) {
				reasons.push(reason("bootstrap-tarball-extract-failed", `${version}: ${String(error?.message ?? error)}`));
				continue;
			}
			const embedded = readEmbeddedCarrierBuild({ carrierDir, readApkBuild });
			if (!embedded.ok) {
				reasons.push(...embedded.reasons);
				continue;
			}
			appBuild = embedded.build;
			carrierEvidence.method = embedded.evidence.method;
			carrierEvidence.appVersion = embedded.evidence.appVersion ?? carrierEvidence.appVersion;
		}
		if (!Number.isSafeInteger(appBuild) || appBuild <= 0) {
			reasons.push(reason("legacy-carrier-build-unreadable", `${version}: 无法确定 App build`));
			continue;
		}
		legacyCarriers.push({ version, integrity, appBuild });
		evidence.carriers.push({ ...carrierEvidence, appBuild });
	}
	if (reasons.length > 0) {
		cleanup();
		return { ok: false, reasons, policy: null, evidence, tempDir };
	}

	const watermarkCandidates = [
		MIGRATION_WATERMARK,
		currentBuild ?? 0,
		watermark ?? 0,
	];
	const resolvedWatermark = Math.max(...watermarkCandidates);
	if (!Number.isSafeInteger(resolvedWatermark) || resolvedWatermark <= 0) {
		cleanup();
		return { ok: false, reasons: [reason("build-policy-watermark-invalid", String(resolvedWatermark))], policy: null, evidence, tempDir };
	}
	const policy = {
		schema: 1,
		watermark: resolvedWatermark,
		legacyTags: historicalTags.tags,
		legacyCarriers: legacyCarriers.sort(compareCarrierEntries),
		updatedAt: new Date().toISOString().slice(0, 10),
		intents: [],
	};
	const validation = validateBuildPolicy(policy);
	cleanup();
	if (!validation.ok) return { ok: false, reasons: validation.reasons, policy: null, evidence, tempDir };
	return {
		ok: true,
		policy,
		evidence,
		watermark: resolvedWatermark,
		tagMaxBuild: historical.maxBuild,
		frontierBuild: legacyCarriers.reduce((max, entry) => (entry.appBuild > max ? entry.appBuild : max), 0),
		legacyTags: historicalTags.tags.length,
		legacyCarriers: legacyCarriers.length,
		tempDir,
		reasons: [],
	};
}

/**
 * m9：覆盖写 release-meta（--write-ref --force）前的单调性检查：
 * 新 policy 不得降低现有 watermark，也不得丢弃已登记的 legacy tag/carrier 记录。
 * @returns {{ok:boolean, reasons:object[]}}
 */
export function assertPolicyMonotonicAgainstExisting(existing, next) {
	const reasons = [];
	const validated = validateBuildPolicy(existing);
	if (!validated.ok) return { ok: false, reasons: validated.reasons };
	const watermark = assertWatermarkNotRegressed(existing.watermark, next.watermark);
	if (!watermark.ok) reasons.push(...watermark.reasons);
	const nextTags = new Set(next.legacyTags);
	for (const tag of existing.legacyTags) {
		if (!nextTags.has(tag)) reasons.push(reason("legacy-tag-missing", `覆盖写会丢弃已登记 legacy tag: ${tag}`));
	}
	const nextCarriers = new Set(next.legacyCarriers.map((entry) => entry.version));
	for (const entry of existing.legacyCarriers) {
		if (!nextCarriers.has(entry.version)) {
			reasons.push(reason("legacy-carrier-unverified", `覆盖写会丢弃已登记 legacy carrier: ${entry.version}`));
		}
	}
	return { ok: reasons.length === 0, reasons };
}

/**
 * 校验现有政策记录与观测数据一致（迁移完整性 / 水位只升不降 / legacy 记录无漂移）。
 * @param {{ policy: object, seed: object }} input seed 为 buildReleaseMetaSeed 结果
 */
export function checkPolicyAgainstSeed({ policy, seed }) {
	const reasons = [];
	const validation = validateBuildPolicy(policy);
	if (!validation.ok) return { ok: false, reasons: validation.reasons };
	// m5：policy 是现有权威记录，seed 是当前观测（水位 = max(32, develop build, --watermark)）。
	// watermark 允许高于观测值（迁移前人工上调过），只拒绝**低于观测值**（会把水位往回写）。
	const watermark = assertWatermarkNotRegressed(seed.policy.watermark, policy.watermark);
	if (!watermark.ok) reasons.push(...watermark.reasons);

	const seedTags = new Set(seed.policy.legacyTags);
	for (const tag of policy.legacyTags) {
		if (!seedTags.has(tag)) reasons.push(reason("legacy-tag-missing", `${tag} 已在政策记录中但历史 tag 已不存在`));
	}
	for (const tag of seed.policy.legacyTags) {
		if (!policy.legacyTags.includes(tag)) reasons.push(reason("legacy-tag-unregistered", `${tag} 未登记进 legacyTags`));
	}
	const seedCarriers = new Map(seed.policy.legacyCarriers.map((entry) => [entry.version, entry]));
	const policyCarriers = new Map(policy.legacyCarriers.map((entry) => [entry.version, entry]));
	for (const [version, entry] of policyCarriers) {
		const observed = seedCarriers.get(version);
		if (!observed) {
			reasons.push(reason("legacy-carrier-unverified", `${version} 已登记但 npm 未返回该版本`));
			continue;
		}
		if (observed.integrity !== entry.integrity) {
			reasons.push(reason("legacy-carrier-integrity-mismatch", `${version}: policy=${entry.integrity} observed=${observed.integrity}`));
		}
		if (observed.appBuild !== entry.appBuild) {
			reasons.push(reason("legacy-carrier-build-mismatch", `${version}: policy=${entry.appBuild} observed=${observed.appBuild}`));
		}
	}
	for (const [version] of seedCarriers) {
		if (!policyCarriers.has(version)) reasons.push(reason("legacy-carrier-unregistered", `${version} 未登记进 legacyCarriers`));
	}
	return { ok: reasons.length === 0, reasons };
}

function readPolicyForCheck(options, { git }) {
	if (options.policy !== null) {
		try {
			return { ok: true, policy: readJson(options.policy), source: options.policy };
		} catch (error) {
			return { ok: false, reasons: [reason("build-policy-json-invalid", String(error?.message ?? error))] };
		}
	}
	if (options.fromRef !== null) {
		const ref = options.fromRef.includes(":") ? options.fromRef : `${options.fromRef}:${RELEASE_META_PATH}`;
		const text = git.show(ref.split(":")[0], ref.split(":").slice(1).join(":"));
		if (text === null) return { ok: false, reasons: [reason("release-meta-missing", ref)] };
		try {
			return { ok: true, policy: JSON.parse(text), source: ref };
		} catch (error) {
			return { ok: false, reasons: [reason("build-policy-json-invalid", String(error?.message ?? error))] };
		}
	}
	return { ok: false, reasons: [reason("bootstrap-check-argument-missing", "需要 --policy FILE 或 --from-ref REF")] };
}

function printPushInstructions(branch) {
	console.error("");
	console.error("本地 release-meta 分支已创建（未推送）。经授权后推送双远端：");
	console.error(`  git push origin ${branch}`);
	console.error(`  git push github ${branch}`);
	console.error("推送前确认两端内容一致；release-meta 必须是受保护分支。");
}

async function main(argv) {
	let options;
	try {
		options = parseArgs(argv);
	} catch (error) {
		console.error(`FAIL bootstrap-cli-invalid: ${String(error?.message ?? error)}`);
		console.error(USAGE);
		return 2;
	}
	if (options.help) { console.log(USAGE); return 0; }

	let result;
	try {
		const packageJson = readJson(path.join(options.root, "package.json"));
		const packageName = packageJson.name;
		const currentPubspec = parsePubspecVersion(fs.readFileSync(path.join(options.root, "dsh-mobile-app", "pubspec.yaml"), "utf8"));
		const adapters = await loadAdapters({
			adaptersPath: options.adaptersPath,
			repoRoot: options.root,
			packageName,
			registry: options.registry,
		});
		const seed = await buildReleaseMetaSeed({
			adapters,
			packageName,
			currentBuild: currentPubspec?.build ?? null,
			watermark: options.watermark,
			keepTarballs: options.keep,
		});
		if (!seed.ok) {
			result = { ok: false, reasons: seed.reasons, evidence: seed.evidence, tempDir: seed.tempDir };
		} else if (options.check) {
			const existing = readPolicyForCheck(options, adapters);
			if (!existing.ok) {
				result = { ok: false, reasons: existing.reasons };
			} else {
				const check = checkPolicyAgainstSeed({ policy: existing.policy, seed });
				result = {
					ok: check.ok,
					reasons: check.reasons,
					source: existing.source,
					policy: seed.policy,
					watermark: seed.watermark,
					legacyTags: seed.legacyTags,
					legacyCarriers: seed.legacyCarriers,
					evidence: seed.evidence,
				};
			}
		} else {
			result = {
				ok: true,
				reasons: [],
				policy: seed.policy,
				watermark: seed.watermark,
				tagMaxBuild: seed.tagMaxBuild,
				frontierBuild: seed.frontierBuild,
				legacyTags: seed.legacyTags,
				legacyCarriers: seed.legacyCarriers,
				evidence: seed.evidence,
				tempDir: seed.tempDir,
			};
			if (options.evidence !== null) fs.writeFileSync(options.evidence, `${JSON.stringify(seed.evidence, null, 2)}\n`, "utf8");
			if (options.writeRef) {
				const localRef = `refs/heads/${options.branch}`;
				const remoteRef = `refs/remotes/origin/${options.branch}`;
				const localSha = adapters.git.revParse(localRef);
				const remoteSha = adapters.git.revParse(remoteRef);
				if (localSha !== null && !options.force) {
					result = {
						ok: false,
						reasons: [reason("release-meta-branch-exists", `${options.branch} 已存在（${localSha}）；确认要覆盖政策记录时使用 --force`)],
						policy: seed.policy,
						watermark: seed.watermark,
						legacyTags: seed.legacyTags,
						legacyCarriers: seed.legacyCarriers,
						evidence: seed.evidence,
						tempDir: seed.tempDir,
					};
					throw Object.assign(new Error("release-meta-branch-exists"), { handled: true });
				}
				// m9：即使 --force，也不得降低水位或丢弃已登记 legacy 记录（读本地/远端现有政策）。
				const existingRefs = [localRef, remoteRef].filter((ref) => (ref === localRef ? localSha : remoteSha) !== null);
				const monotonicReasons = [];
				for (const ref of existingRefs) {
					const existingText = adapters.git.show(ref, RELEASE_META_PATH);
					if (existingText === null) {
						monotonicReasons.push(reason("release-meta-missing", `${ref}:${RELEASE_META_PATH} 不可读`));
						continue;
					}
					let existingPolicy;
					try {
						existingPolicy = JSON.parse(existingText);
					} catch (error) {
						monotonicReasons.push(reason("build-policy-json-invalid", `${ref}: ${String(error?.message ?? error)}`));
						continue;
					}
					monotonicReasons.push(...assertPolicyMonotonicAgainstExisting(existingPolicy, seed.policy).reasons);
				}
				if (monotonicReasons.length > 0) {
					result = {
						ok: false,
						reasons: monotonicReasons,
						policy: seed.policy,
						watermark: seed.watermark,
						legacyTags: seed.legacyTags,
						legacyCarriers: seed.legacyCarriers,
						evidence: seed.evidence,
						tempDir: seed.tempDir,
					};
					throw Object.assign(new Error("release-meta-policy-regressed"), { handled: true });
				}
				const written = adapters.git.createBranchWithFile({
					branch: options.branch,
					base: options.base,
					path: RELEASE_META_PATH,
					content: serializeBuildPolicy(seed.policy),
					message: `chore(release-meta): seed build policy (watermark ${seed.watermark})`,
				});
				result.branch = { ...written, path: RELEASE_META_PATH };
				if (!options.json) printPushInstructions(options.branch);
			} else if (options.out !== null) {
				fs.writeFileSync(options.out, serializeBuildPolicy(seed.policy), "utf8");
			}
		}
	} catch (error) {
		if (error?.handled) {
			// 已在 try 内构造好 result（如 release-meta-branch-exists）。
			if (!result) result = { ok: false, reasons: [reason("bootstrap-crashed", String(error?.message ?? error))] };
		} else {
			result = { ok: false, reasons: [reason(error?.releaseReason ?? "bootstrap-crashed", String(error?.stack ?? error))] };
		}
	}

	if (options.json) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else if (result.ok && result.policy && options.out === null && !options.writeRef) {
		process.stdout.write(serializeBuildPolicy(result.policy));
		if (!options.check) {
			console.error(`watermark=${result.watermark} legacyTags=${result.legacyTags} legacyCarriers=${result.legacyCarriers} (seed JSON above)`);
		}
	} else if (!result.ok) {
		for (const item of result.reasons) console.log(`FAIL ${item.code} (${item.detail})`);
		console.log(`REASONS: ${result.reasons.map((item) => item.code).join(",")}`);
		console.log("RESULT: FAIL");
	} else {
		console.log(`release-meta policy OK: watermark=${result.watermark} legacyTags=${result.legacyTags} legacyCarriers=${result.legacyCarriers}`);
		if (result.tempDir) console.log(`retained temp dir (--keep): ${result.tempDir}`);
		if (result.branch) console.log(`branch ${result.branch.branch} <- commit ${result.branch.commit}`);
		console.log("RESULT: PASS");
	}
	return result.ok ? 0 : 1;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invoked) {
	main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
		console.error(`FAIL bootstrap-crashed: ${String(error?.stack ?? error)}`);
		process.exit(1);
	});
}
