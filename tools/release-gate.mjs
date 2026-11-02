#!/usr/bin/env node
// CI 发布门禁 helper（issue #43）：把 workflow 中**可测试的发布政策判定**集中到 CLI，
// 让 publish-npm.yml 只做编排（checkout / 构建 / npm publish / release-meta 提交）。
//
// 子命令：
//   prepare          tag 身份 + 发布状态判定 + build 前沿校验 + app/latest 决策，
//                    输出 GITHUB_ENV（--github-env）与机器可读 JSON（--json）。
//   record-intent   提交 registry **之前**写入 release 意图（submitted）。
//   mark-intent     unknown / published / failed 状态更新（人工恢复也用它）。
//   verify-tags     发布后 dist-tag 校验（不回退、通道/最新指针符合决策）。
//   verify-readonly 全发布旧 tag 重跑的只读幂等校验（不要求当前 channel 等于旧版本）。
//
// 本工具只做判定与文件写入；npm publish / git push 由 workflow 执行（本工具零 npm 写入）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAdapters, parsePubspecVersion, readPublishedCarriers } from "./lib/release-adapters.mjs";
import { exactCarrierAliasChecks, pluginPublishTag } from "../dsh-mobile-app/tools/lib/release-checks.mjs";
import {
	PUBLISH_STATES,
	OPEN_INTENT_STATUSES,
	appDistTagDecision,
	assertNewBuild,
	applyReleaseIntent,
	channelDistTagDecision,
	compareSemver,
	assertNoOpenReleaseIntents,
	assertPublishStateSupported,
	classifyPublishState,
	computePublishedFrontier,
	frontierInputFromCarriers,
	latestDistTagDecision,
	markReleaseIntent,
	parseAppVersion,
	parseBuildPolicy,
	parseCarrierVersion,
	parseReleaseTag,
	reason,
	serializeBuildPolicy,
	validateReleaseIntent,
	verifyDistTagsAfterPublish,
} from "./lib/release-policy.mjs";

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(TOOLS_DIR, "..");

const USAGE = `用法:
  node tools/release-gate.mjs prepare --tag vX.Y.Z[-pre] --policy FILE [--root DIR]
        [--registry URL] [--adapters MODULE] [--github-env FILE] [--json]
  node tools/release-gate.mjs record-intent --policy FILE --tag vX.Y.Z[-pre] [--build N]
        [--integrity sha512-...] [--resume] [--root DIR] [--out FILE] [--json]
  node tools/release-gate.mjs mark-intent --policy FILE --tag vX.Y.Z[-pre]
        --status unknown|published|failed [--note TEXT] [--integrity sha512-...] [--out FILE] [--json]
  node tools/release-gate.mjs verify-tags --root DIR [--registry URL] [--adapters MODULE] [--json]
        --plugin-version V --carrier-version V-app --plugin-tag TAG --state STATE
        [--app-decision move|keep] [--app-before V] [--latest-before V] [--latest-decision move|keep]
        [--channel-decision move|keep|staging] [--channel-before V]
  node tools/release-gate.mjs verify-package --root DIR [--dist DIR] --plugin-version V
        --carrier-version V-app --build N [--json]
  node tools/release-gate.mjs verify-readonly --policy FILE --tag v... --plugin-version V
        --carrier-version V-app [--root DIR] [--registry URL] [--adapters MODULE] [--json]`;

function parseArgs(argv) {
	const options = {
		command: argv[0] ?? "",
		tag: null,
		policy: null,
		root: REPO_ROOT,
		registry: process.env.DSH_RELEASE_REGISTRY ?? null,
		adaptersPath: null,
		githubEnv: null,
		dist: null,
		json: false,
		build: null,
		integrity: null,
		out: null,
		status: null,
		note: "",
		pluginVersion: null,
		carrierVersion: null,
		pluginTag: null,
		state: null,
		appDecision: null,
		appBefore: null,
		latestBefore: null,
		latestDecision: null,
		channelDecision: null,
		channelBefore: null,
		resume: false,
	};
	const take = (index) => argv[index];
	for (let index = 1; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--tag": options.tag = take(++index); break;
			case "--policy": options.policy = path.resolve(take(++index)); break;
			case "--root": options.root = path.resolve(take(++index)); break;
			case "--registry": options.registry = take(++index); break;
			case "--adapters": options.adaptersPath = take(++index); break;
			case "--github-env": options.githubEnv = path.resolve(take(++index)); break;
			case "--dist": options.dist = path.resolve(take(++index)); break;
			case "--json": options.json = true; break;
			case "--build": options.build = Number.parseInt(take(++index), 10); break;
			case "--integrity": options.integrity = take(++index); break;
			case "--out": options.out = path.resolve(take(++index)); break;
			case "--status": options.status = take(++index); break;
			case "--note": options.note = take(++index); break;
			case "--plugin-version": options.pluginVersion = take(++index); break;
			case "--carrier-version": options.carrierVersion = take(++index); break;
			case "--plugin-tag": options.pluginTag = take(++index); break;
			case "--state": options.state = take(++index); break;
			case "--app-decision": options.appDecision = take(++index); break;
			case "--app-before": options.appBefore = take(++index); break;
			case "--latest-before": options.latestBefore = take(++index); break;
			case "--latest-decision": options.latestDecision = take(++index); break;
			case "--channel-decision": options.channelDecision = take(++index); break;
			case "--channel-before": options.channelBefore = take(++index); break;
			case "--resume": options.resume = true; break;
			case "--help": case "-h": options.help = true; break;
			default: throw new Error(`未知参数: ${arg}`);
		}
	}
	return options;
}

function readJson(file) {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

function failResult(reasons, extra = {}) {
	return { ok: false, reasons, ...extra };
}

function appendGitHubEnv(file, variables) {
	if (!file) return;
	const lines = [];
	for (const [key, value] of Object.entries(variables)) {
		if (value === null || value === undefined) continue;
		const text = String(value);
		if (text.includes("\n")) throw new Error(`GITHUB_ENV 值不得包含换行: ${key}`);
		lines.push(`${key}=${text}`);
	}
	fs.appendFileSync(file, `${lines.join("\n")}\n`, "utf8");
}

function loadPolicyFile(file) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (error) {
		return failResult([reason("release-meta-missing", `${file}: ${String(error?.message ?? error)}`)]);
	}
	const parsed = parseBuildPolicy(text);
	if (!parsed.ok) return failResult(parsed.reasons);
	return { ok: true, policy: parsed.policy, text };
}

function readLocalIdentity(root) {
	const reasons = [];
	let packageJson;
	try {
		packageJson = readJson(path.join(root, "package.json"));
	} catch (error) {
		reasons.push(reason("package-json-invalid", String(error?.message ?? error)));
		return { ok: false, reasons };
	}
	let pubspecText;
	try {
		pubspecText = fs.readFileSync(path.join(root, "dsh-mobile-app", "pubspec.yaml"), "utf8");
	} catch (error) {
		reasons.push(reason("pubspec-missing", String(error?.message ?? error)));
		return { ok: false, reasons };
	}
	const pubspec = parsePubspecVersion(pubspecText);
	if (pubspec === null) reasons.push(reason("pubspec-version-invalid", "需要 X.Y.Z+N"));
	const aliasChecks = exactCarrierAliasChecks(packageJson);
	for (const check of aliasChecks.filter((item) => !item.pass)) {
		reasons.push(reason("exact-carrier-alias-check-failed", `${check.name}: ${check.detail}`));
	}
	return {
		ok: reasons.length === 0,
		reasons,
		packageJson,
		pubspec,
		pluginVersion: typeof packageJson.version === "string" ? packageJson.version : "",
	};
}

/** prepare：CI 发布前判定（不发布、不写 release-meta）。 */
export async function gatePrepare({ adapters, root = REPO_ROOT, tag, policy, packageName = null } = {}) {
	const reasons = [];
	const identity = readLocalIdentity(root);
	if (!identity.ok) return failResult(identity.reasons);
	const name = packageName ?? identity.packageJson.name;
	const parsedTag = parseReleaseTag(tag);
	if (parsedTag === null) return failResult([reason("tag-version-invalid", String(tag))]);
	if (parsedTag.kind === "prerelease-other") return failResult([reason("tag-kind-unsupported", `${tag} 只支持 alpha/rc/stable`)]);
	if (identity.pluginVersion !== parsedTag.pluginVersion) {
		reasons.push(reason("tag-version-mismatch", `tag=${parsedTag.pluginVersion} package.json=${identity.pluginVersion}`));
	}
	if (identity.pubspec === null) reasons.push(reason("pubspec-version-invalid", "pubspec.yaml 需要 X.Y.Z+N"));
	else if (identity.pubspec.core !== parsedTag.core) {
		reasons.push(reason("app-core-mismatch", `pubspec core=${identity.pubspec.core} tag core=${parsedTag.core}`));
	}
	if (reasons.length > 0) return failResult(reasons);

	const pluginVersion = parsedTag.pluginVersion;
	const build = identity.pubspec.build;
	const carrierVersion = `${pluginVersion}-app`;
	const pluginTag = pluginPublishTag(pluginVersion);
	if (!pluginTag) return failResult([reason("plugin-dist-tag-invalid", pluginVersion)]);

	const policyResult = loadPolicyFile(policy);
	if (!policyResult.ok) return failResult(policyResult.reasons);
	const buildPolicy = policyResult.policy;
	// legacy 白名单只约束新发布；已发布历史 tag 的重跑仍走只读幂等（由 assertNewBuild 判定）。
	const legacyTag = buildPolicy.legacyTags.includes(tag);

	// 已发布状态判定必须**先于** build/动态通道校验（旧 tag 重跑幂等）。
	let versions;
	try {
		versions = adapters.npm.listVersions(name);
	} catch (error) {
		return failResult([reason("npm-metadata-unavailable", String(error?.message ?? error))]);
	}
	const pluginVisible = versions.includes(pluginVersion);
	const carrierVisible = versions.includes(carrierVersion);
	const state = classifyPublishState(pluginVisible, carrierVisible);
	const stateSupport = assertPublishStateSupported(state);
	if (!stateSupport.ok) return failResult(stateSupport.reasons);

	// unknown/未关闭意图阻断的是**后续发布与通道移动**；已完全发布的旧 tag 只读重跑不受影响。
	// 但重跑必须**报告**残留的未关闭意图（m7）：发布已完成而意图没关闭时，需人工按
	// docs/10-release.md §10.3 用 registry integrity 标记 published 并推送 release-meta。
	let leftoverIntent = null;
	if (state === PUBLISH_STATES.FULLY_PUBLISHED) {
		leftoverIntent = [...(buildPolicy.intents ?? [])].reverse().find((intent) => intent.tag === tag && OPEN_INTENT_STATUSES.includes(intent.status)) ?? null;
	} else {
		const intents = assertNoOpenReleaseIntents(buildPolicy, { tag });
		if (!intents.ok) return failResult(intents.reasons);
	}

	const published = readPublishedCarriers({ npm: adapters.npm, packageName: name });
	if (!published.ok) return failResult(published.reasons);
	const frontierInput = frontierInputFromCarriers(published.carriers);

	let frontier = 0;
	let partialOwnCarrierBuild = null;
	if (state === PUBLISH_STATES.PARTIAL_CARRIER) {
		let ownMetadata = null;
		try {
			ownMetadata = adapters.npm.viewVersion(name, carrierVersion);
		} catch (error) {
			return failResult([reason("npm-metadata-unavailable", String(error?.message ?? error))]);
		}
		const ownAppVersion = ownMetadata?.appVersion;
		const ownParsed = typeof ownAppVersion === "string" ? parseAppVersion(ownAppVersion) : null;
		if (ownParsed === null || ownParsed.build === null) {
			return failResult([reason("carrier-app-version-missing", `${carrierVersion}: ${JSON.stringify(ownAppVersion)}`)]);
		}
		partialOwnCarrierBuild = ownParsed.build;
		const excluded = {
			...frontierInput,
			newCarrierAppVersions: frontierInput.newCarrierAppVersions.filter((entry) => entry.version !== carrierVersion),
		};
		const excludedFrontier = computePublishedFrontier({ ...excluded, legacyCarriers: buildPolicy.legacyCarriers });
		if (!excludedFrontier.ok) return failResult(excludedFrontier.reasons);
		frontier = excludedFrontier.frontier;
	} else {
		const computed = computePublishedFrontier({ ...frontierInput, legacyCarriers: buildPolicy.legacyCarriers });
		if (!computed.ok) return failResult(computed.reasons);
		frontier = computed.frontier;
	}

	const buildCheck = assertNewBuild({
		build,
		watermark: buildPolicy.watermark,
		frontier,
		fullyPublished: state === PUBLISH_STATES.FULLY_PUBLISHED,
		partialOwnCarrierBuild,
		legacyTag,
	});
	if (!buildCheck.ok) return failResult(buildCheck.reasons);

	// app / latest 指针：先比较后移动。
	let distTags;
	try {
		distTags = adapters.npm.distTags(name);
	} catch (error) {
		return failResult([reason("npm-metadata-unavailable", String(error?.message ?? error))]);
	}
	const appCurrent = distTags?.app ?? null;
	const latestBefore = distTags?.latest ?? null;
	const channelCurrent = distTags?.[pluginTag] ?? null;
	const appDecision = appDistTagDecision(appCurrent, carrierVersion);
	if (appDecision.action === "manual") {
		return failResult([reason("app-pointer-manual-recovery", `${appDecision.reason}: app=${JSON.stringify(appCurrent)}`)]);
	}
	const latestDecision = latestDistTagDecision(pluginVersion, latestBefore);
	if (latestDecision.action === "manual") {
		return failResult([reason("latest-invalid", `${latestDecision.reason}: latest=${JSON.stringify(latestBefore)}`)]);
	}
	// alpha/rc 的 channel 反回退（设计稿 §5.2.7）：候选不比当前 channel 新时不得移动 channel，
	// 插件用 staging tag 发布。stable 的 latest 由 latestDecision 处理。
	let channelDecision;
	if (parsedTag.kind === "stable") {
		channelDecision = { action: latestDecision.action === "move" ? "move" : "keep", reason: `stable-${latestDecision.action}` };
	} else if (state === PUBLISH_STATES.FULLY_PUBLISHED) {
		channelDecision = { action: "keep", reason: "fully-published-readonly" };
	} else {
		channelDecision = channelDistTagDecision(pluginVersion, channelCurrent);
		if (channelDecision.action === "manual") {
			return failResult([reason("channel-invalid", `${channelDecision.reason}: ${pluginTag}=${JSON.stringify(channelCurrent)}`)]);
		}
	}

	return {
		ok: true,
		reasons: [],
		tag,
		tagKind: parsedTag.kind,
		pluginVersion,
		pluginTag,
		core: parsedTag.core,
		build,
		carrierVersion,
		state,
		pluginVisible,
		carrierVisible,
		watermark: buildPolicy.watermark,
		frontier,
		partialOwnCarrierBuild,
		appCurrent,
		appDecision: appDecision.action,
		appDecisionReason: appDecision.reason,
		latestBefore,
		latestDecision: latestDecision.action,
		latestDecisionReason: latestDecision.reason,
		channelCurrent,
		channelDecision: channelDecision.action,
		channelDecisionReason: channelDecision.reason,
		leftoverIntent,
		policy,
	};
}

function gatePrepareEnv(result) {
	// 稳定版 latest 不回退、或 alpha/rc channel 不比候选新时，不能直接 `npm publish --tag <channel>`
	// （那会无条件移动 channel），改用临时 staging tag 发布，再由显式 dist-tag 步骤按决策前进。
	const stableKeep = result.tagKind === "stable" && result.latestDecision === "keep";
	const channelStaging = result.tagKind !== "stable" && result.channelDecision === "staging";
	const stagingTag = stableKeep ? "release-staging" : `${result.pluginTag}-staging`;
	return {
		TAG: result.tag,
		TAG_KIND: result.tagKind,
		PLUGIN_VERSION: result.pluginVersion,
		PLUGIN_TAG: result.pluginTag,
		PLUGIN_PUBLISH_TAG: stableKeep || channelStaging ? stagingTag : result.pluginTag,
		PLUGIN_STAGING_TAG: stagingTag,
		CARRIER_PUBLISH_TAG: result.appDecision === "move" ? "app" : "app-staging",
		APP_STAGING_TAG: "app-staging",
		CHANNEL_DECISION: result.channelDecision,
		CHANNEL_DECISION_REASON: result.channelDecisionReason,
		LEFTOVER_INTENT_STATUS: result.leftoverIntent?.status ?? null,
		LEFTOVER_INTENT_TAG: result.leftoverIntent?.tag ?? null,
		APP_VERSION: `${result.core}+${result.build}`,
		BUILD: result.build,
		CARRIER_VERSION: result.carrierVersion,
		STATE: result.state,
		PLUGIN_ALREADY_PUBLISHED: result.pluginVisible ? "1" : "0",
		CARRIER_ALREADY_PUBLISHED: result.carrierVisible ? "1" : "0",
		WATERMARK: result.watermark,
		FRONTIER: result.frontier,
		APP_CURRENT: result.appCurrent,
		APP_DECISION: result.appDecision,
		APP_DECISION_REASON: result.appDecisionReason,
		LATEST_BEFORE: result.latestBefore,
		LATEST_DECISION: result.latestDecision,
		LATEST_DECISION_REASON: result.latestDecisionReason,
		CHANNEL_CURRENT: result.channelCurrent,
	};
}

async function cmdPrepare(options) {
	// 先做轻量本地身份校验，避免无谓的网络调用；gatePrepare 内部会再次完整校验。
	const identity = readLocalIdentity(options.root);
	const packageName = identity.ok ? identity.packageJson.name : null;
	const adapters = await loadAdapters({
		adaptersPath: options.adaptersPath,
		repoRoot: options.root,
		packageName,
		registry: options.registry,
	});
	const result = await gatePrepare({
		adapters,
		root: options.root,
		tag: options.tag,
		policy: options.policy,
		packageName,
	});
	if (result.ok) appendGitHubEnv(options.githubEnv, gatePrepareEnv(result));
	return result;
}

function cmdRecordIntent(options) {
	const policyResult = loadPolicyFile(options.policy);
	if (!policyResult.ok) return policyResult;
	const parsedTag = parseReleaseTag(options.tag);
	if (parsedTag === null) return failResult([reason("tag-version-invalid", String(options.tag))]);
	let build = options.build;
	if (!Number.isSafeInteger(build) || build <= 0) {
		const pubspec = parsePubspecVersion(fs.readFileSync(path.join(options.root, "dsh-mobile-app", "pubspec.yaml"), "utf8"));
		build = pubspec?.build ?? null;
	}
	if (!Number.isSafeInteger(build) || build <= 0) return failResult([reason("build-invalid", String(build))]);
	const intent = {
		tag: options.tag,
		pluginVersion: parsedTag.pluginVersion,
		carrierVersion: `${parsedTag.pluginVersion}-app`,
		build,
		integrity: options.integrity ?? undefined,
		status: "submitted",
	};
	const validation = validateReleaseIntent(intent);
	if (!validation.ok) return failResult(validation.reasons);
	if (options.resume) {
		// 重跑/部分恢复：同一 tag 的未关闭意图视为续跑同一会话。重建产物字节可能不同
		// （APK 构建/打包非逐字节稳定），不能因此把续跑误判为“冲突”。
		const existing = [...(policyResult.policy.intents ?? [])].reverse().find((entry) => entry.tag === intent.tag
			&& ["submitted", "unknown"].includes(entry.status)
			&& entry.pluginVersion === intent.pluginVersion
			&& entry.carrierVersion === intent.carrierVersion
			&& entry.build === intent.build);
		if (existing) return { ok: true, reasons: [], changed: false, resumed: true, intent: existing, out: null };
	}
	const result = applyReleaseIntent(policyResult.policy, intent);
	if (!result.ok) return failResult(result.reasons);
	if (result.changed) {
		fs.writeFileSync(options.out ?? options.policy, serializeBuildPolicy(result.policy), "utf8");
	}
	return {
		ok: true,
		reasons: [],
		changed: result.changed,
		intent: result.intent,
		out: result.changed ? (options.out ?? options.policy) : null,
	};
}

function cmdMarkIntent(options) {
	const policyResult = loadPolicyFile(options.policy);
	if (!policyResult.ok) return policyResult;
	const result = markReleaseIntent(policyResult.policy, {
		tag: options.tag,
		status: options.status,
		note: options.note,
		integrity: options.integrity ?? null,
	});
	if (!result.ok) return failResult(result.reasons);
	if (result.changed) fs.writeFileSync(options.out ?? options.policy, serializeBuildPolicy(result.policy), "utf8");
	return { ok: true, reasons: [], changed: result.changed, status: options.status, out: result.changed ? (options.out ?? options.policy) : null };
}

async function cmdVerifyTags(options) {
	const adapters = await loadAdapters({
		adaptersPath: options.adaptersPath,
		repoRoot: options.root,
		packageName: null,
		registry: options.registry,
	});
	let distTags;
	try {
		distTags = adapters.npm.distTags(readJson(path.join(options.root, "package.json")).name);
	} catch (error) {
		return failResult([reason("npm-metadata-unavailable", String(error?.message ?? error))]);
	}
	const result = verifyDistTagsAfterPublish({
		state: options.state,
		pluginTag: options.pluginTag,
		pluginVersion: options.pluginVersion,
		channelCurrent: distTags?.[options.pluginTag] ?? null,
		channelDecision: options.channelDecision ?? "move",
		channelBefore: options.channelBefore,
		candidateCarrierVersion: options.carrierVersion,
		appDecision: options.appDecision,
		appBefore: options.appBefore,
		appCurrent: distTags?.app ?? null,
		latestDecision: options.latestDecision,
		latestBefore: options.latestBefore,
		latestNow: distTags?.latest ?? null,
	});
	return { ...result, distTags };
}

async function cmdVerifyReadonly(options) {
	const policyResult = loadPolicyFile(options.policy);
	if (!policyResult.ok) return failResult(policyResult.reasons);
	const policy = policyResult.policy;
	const parsedTag = parseReleaseTag(options.tag);
	if (parsedTag === null) return failResult([reason("tag-version-invalid", String(options.tag))]);
	const pluginVersion = options.pluginVersion ?? parsedTag.pluginVersion;
	const carrierVersion = options.carrierVersion ?? `${pluginVersion}-app`;
	const packageName = readJson(path.join(options.root, "package.json")).name;
	const adapters = await loadAdapters({
		adaptersPath: options.adaptersPath,
		repoRoot: options.root,
		packageName,
		registry: options.registry,
	});
	let versions;
	try {
		versions = adapters.npm.listVersions(packageName);
	} catch (error) {
		return failResult([reason("npm-metadata-unavailable", String(error?.message ?? error))]);
	}
	const reasons = [];
	if (!versions.includes(pluginVersion)) reasons.push(reason("plugin-version-missing", `${packageName}@${pluginVersion}`));
	if (!versions.includes(carrierVersion)) reasons.push(reason("carrier-version-missing", `${packageName}@${carrierVersion}`));
	let carrierMetadata = null;
	try {
		carrierMetadata = adapters.npm.viewVersion(packageName, carrierVersion);
	} catch (error) {
		reasons.push(reason("npm-metadata-unavailable", String(error?.message ?? error)));
	}
	const publishedIntent = [...(policy.intents ?? [])]
		.reverse()
		.find((intent) => intent.tag === options.tag && intent.status === "published");
	if (publishedIntent?.integrity && carrierMetadata) {
		const observed = carrierMetadata?.dist?.integrity;
		if (typeof observed === "string" && observed !== publishedIntent.integrity) {
			reasons.push(reason("carrier-integrity-mismatch", `${carrierVersion}: registry=${observed} intent=${publishedIntent.integrity}`));
		}
	}
	const distTags = await (async () => {
		try {
			return adapters.npm.distTags(packageName);
		} catch (error) {
			reasons.push(reason("npm-metadata-unavailable", String(error?.message ?? error)));
			return {};
		}
	})();
	const appCurrent = distTags?.app ?? null;
	const candidatePlugin = parseCarrierVersion(carrierVersion)?.pluginVersion ?? null;
	if (candidatePlugin !== null) {
		const appParsed = parseCarrierVersion(appCurrent ?? "");
		if (appParsed === null) {
			reasons.push(reason("app-pointer-not-carrier", `app=${JSON.stringify(appCurrent)}`));
		} else if (compareSemver(appParsed.pluginVersion, candidatePlugin) < 0) {
			reasons.push(reason("app-pointer-rolled-back", `app=${appCurrent} 早于 ${candidatePlugin}`));
		}
	}
	return { ok: reasons.length === 0, reasons, distTags, pluginVisible: true, carrierVisible: versions.includes(carrierVersion) };
}

/**
 * m8：发布产物必须与 tag 的 build 完全一致（在写发布意图/发布之前断言）。
 * 断言 manifest.app.version = <core>+<BUILD>、manifest.plugin.version = 插件版本、
 * carrier 记录版本 = <plugin>-app、carrier 内嵌清单与 dist 清单的 app/plugin 版本一致。
 */
async function cmdVerifyPackage(options) {
	const root = options.root ?? REPO_ROOT;
	const distDir = options.dist ?? path.join(root, "dsh-mobile-app", "dist");
	const reasons = [];
	const readJson = (file) => {
		try {
			return JSON.parse(fs.readFileSync(file, "utf8"));
		} catch (error) {
			reasons.push(reason("package-manifest-missing", `${file}: ${String(error?.message ?? error)}`));
			return null;
		}
	};
	const manifest = readJson(path.join(distDir, "manifest.json"));
	const carrier = readJson(path.join(distDir, "app-carrier.json"));
	if (manifest === null || carrier === null) return { ok: false, reasons };

	const pluginVersion = options.pluginVersion ?? null;
	const carrierVersion = options.carrierVersion ?? (pluginVersion ? `${pluginVersion}-app` : null);
	const build = Number.isSafeInteger(options.build) ? options.build : null;
	if (pluginVersion === null || carrierVersion === null || build === null) {
		reasons.push(reason("verify-package-argument-missing", "需要 --plugin-version/--carrier-version/--build"));
		return { ok: false, reasons };
	}
	const expectedAppVersion = `${pluginVersion.split("-")[0]}+${build}`;
	const manifestAppVersion = manifest?.app?.version;
	if (manifestAppVersion !== expectedAppVersion) {
		reasons.push(reason("build-manifest-mismatch", `manifest.app.version=${JSON.stringify(manifestAppVersion)} 期望=${expectedAppVersion}`));
	}
	const manifestPluginVersion = manifest?.plugin?.version;
	if (manifestPluginVersion !== pluginVersion) {
		reasons.push(reason("plugin-version-mismatch", `manifest.plugin.version=${JSON.stringify(manifestPluginVersion)} 期望=${pluginVersion}`));
	}
	const carrierRecordVersion = carrier?.version;
	if (carrierRecordVersion !== carrierVersion) {
		reasons.push(reason("carrier-version-mismatch", `app-carrier.version=${JSON.stringify(carrierRecordVersion)} 期望=${carrierVersion}`));
	}
	const embeddedAppVersion = carrier?.manifest?.app?.version;
	if (embeddedAppVersion !== manifestAppVersion) {
		reasons.push(reason("build-manifest-mismatch", `carrier.manifest.app.version=${JSON.stringify(embeddedAppVersion)} != manifest.app.version=${JSON.stringify(manifestAppVersion)}`));
	}
	const embeddedPluginVersion = carrier?.manifest?.plugin?.version;
	if (embeddedPluginVersion !== manifestPluginVersion) {
		reasons.push(reason("plugin-version-mismatch", `carrier.manifest.plugin.version=${JSON.stringify(embeddedPluginVersion)} != manifest.plugin.version=${JSON.stringify(manifestPluginVersion)}`));
	}
	return {
		ok: reasons.length === 0,
		reasons,
		dist: distDir,
		pluginVersion,
		carrierVersion,
		build,
		appVersion: expectedAppVersion,
	};
}

function printHuman(command, result) {
	if (!result.ok) {
		for (const item of result.reasons ?? []) console.log(`FAIL ${item.code} (${item.detail})`);
		console.log(`REASONS: ${(result.reasons ?? []).map((item) => item.code).join(",")}`);
		console.log("RESULT: FAIL");
		return;
	}
	if (command === "prepare") {
		console.log(`tag=${result.tag} kind=${result.tagKind} plugin=${result.pluginVersion} app=${result.core}+${result.build}`);
		console.log(`state=${result.state} watermark=${result.watermark} frontier=${result.frontier}`);
		console.log(`app=${result.appCurrent ?? "<unset>"} -> ${result.appDecision} (${result.appDecisionReason})`);
		console.log(`latest=${result.latestBefore ?? "<unset>"} -> ${result.latestDecision} (${result.latestDecisionReason})`);
		console.log(`channel=${result.channelCurrent ?? "<unset>"} -> ${result.channelDecision} (${result.channelDecisionReason})`);
		if (result.leftoverIntent) {
			console.log(`WARNING leftover-intent: ${result.leftoverIntent.tag} status=${result.leftoverIntent.status}；发布已完成但意图未关闭，需按 docs/10-release.md §10.3 人工恢复。`);
		}
	} else if (command === "verify-package") {
		console.log(`packaged artifacts OK: ${result.pluginVersion} / ${result.carrierVersion} / App ${result.appVersion}`);
	} else if (command === "verify-tags") {
		console.log(`dist-tags=${JSON.stringify(result.distTags ?? {})}`);
	} else if (command === "verify-readonly") {
		console.log(`read-only verification ok; dist-tags=${JSON.stringify(result.distTags ?? {})}`);
	} else {
		console.log(`${command}: changed=${result.changed ?? false}`);
	}
	console.log("RESULT: PASS");
}

async function main(argv) {
	let options;
	try {
		options = parseArgs(argv);
	} catch (error) {
		console.error(`FAIL release-gate-cli-invalid: ${String(error?.message ?? error)}`);
		console.error(USAGE);
		return 2;
	}
	if (options.help || options.command === "" || options.command === "--help") { console.log(USAGE); return 0; }

	let result;
	try {
		switch (options.command) {
			case "prepare": result = await cmdPrepare(options); break;
			case "record-intent": result = await cmdRecordIntent(options); break;
			case "mark-intent": result = cmdMarkIntent(options); break;
			case "verify-tags": result = await cmdVerifyTags(options); break;
			case "verify-readonly": result = await cmdVerifyReadonly(options); break;
			case "verify-package": result = await cmdVerifyPackage(options); break;
			default: throw new Error(`未知子命令: ${options.command}`);
		}
	} catch (error) {
		result = failResult([reason("release-gate-crashed", String(error?.stack ?? error))]);
	}
	if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	else printHuman(options.command, result);
	return result.ok ? 0 : 1;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invoked) {
	main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
		console.error(`FAIL release-gate-crashed: ${String(error?.stack ?? error)}`);
		process.exit(1);
	});
}
