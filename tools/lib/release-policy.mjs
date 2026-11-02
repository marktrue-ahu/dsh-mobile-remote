#!/usr/bin/env node
// 发布政策（issue #43 / ADR 0025 / docs/design/alpha-release-global-build.md rev.3）的**纯判定**实现。
//
// 本模块零网络、零文件、零 git：只接收已经取到的数据（build-policy 文本、npm 元数据、
// 本地版本号），返回 `{ok, reasons[], ...}` 或稳定的决策对象。调用方负责：
//   - tools/next-build.mjs          分配端（只读 git/npm 适配器）
//   - tools/prepare-release.mjs     原子 bump
//   - tools/release-meta-bootstrap.mjs  迁移种子
//   - tools/release-gate.mjs        CI 预检 / 发布意图 / 指针校验
//
// 一切 fail-closed：缺数据、非法数据、双源不一致都返回 `ok:false` 和稳定 reason code，
// 绝不「从 0 开始」「跳过未知记录」或把超时当作确定未发布。
//
// 关键语义（设计稿 rev.3）：
//   - 发布前沿 = max(已发布新 carrier 的 appVersion build, legacyCarriers 的 appBuild)；
//     工作区 pubspec、未发布 tag、设备记录都不构成前沿。
//   - legacy carrier（迁移前缺顶层 appVersion）只能凭 release-meta 的已核验映射参与前沿；
//     未登记且缺 appVersion → fail-closed；已登记但 integrity 不符 → fail-closed。
//   - CI 的 build 校验在「已发布状态判定」之后：全发布重跑只读成功；部分恢复排除自身
//     carrier 后校验；新发布要求 > 发布前沿。**不使用全量 tag 最大值**。
//   - app 指针比较**剥离 -app 后的配对插件版本**（SemVer），先比较后移动、不得回退。
//   - latest 只有 stable 可以前进；prerelease 前后必须保持不变。
//   - 未确认发布（submitted/unknown intent）阻断后续分配与发布；unknown 必须人工恢复。

import crypto from "node:crypto";

export const RELEASE_META_BRANCH = "release-meta";
export const RELEASE_META_PATH = "build-policy.json";
export const BUILD_POLICY_SCHEMA = 1;
/** 迁移水位种子值（设计稿 §12：develop 迁移时 build 32）。 */
export const MIGRATION_WATERMARK = 32;

/** 发布意图状态。submitted/unknown 为未关闭；published/failed 为已确认。 */
export const INTENT_STATUSES = Object.freeze(["submitted", "unknown", "published", "failed"]);
export const OPEN_INTENT_STATUSES = Object.freeze(["submitted", "unknown"]);

/** 已发布状态（`classifyPublishState`）。 */
export const PUBLISH_STATES = Object.freeze({
	FULLY_PUBLISHED: "fully-published",
	PARTIAL_CARRIER: "partial-carrier",
	PARTIAL_PLUGIN: "partial-plugin",
	FRESH: "fresh",
});

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const APP_VERSION_RE = /^(\d+\.\d+\.\d+)\+(\d+)$/;
const RELEASE_TAG_RE = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/;
// npm 的 dist.integrity：sha512-<88 字符 base64>（64 字节 → 88 字符，固定以 == 结尾）。
const INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]{86}==$/;

// ── 基础解析 / reason 工具 ───────────────────────────────────────────────────────────

/** 稳定 reason：`{code, detail}`。detail 只用于人读，判定只看 code。 */
export function reason(code, detail = "") {
	return { code, detail: String(detail) };
}

function failure(code, detail = "") {
	return { ok: false, reasons: [reason(code, detail)] };
}

export function isPositiveInteger(value) {
	return Number.isSafeInteger(value) && value > 0;
}

export function isNonNegativeInteger(value) {
	return Number.isSafeInteger(value) && value >= 0;
}

/**
 * 解析 SemVer（允许 prerelease，不接受 `+build`；prerelease 的 `.app` 后缀视为非法插件版本）。
 * @returns {{major:bigint, minor:bigint, patch:bigint, prerelease:string[]}|null}
 */
export function parseSemver(value) {
	const match = SEMVER_RE.exec(String(value ?? ""));
	if (!match) return null;
	// SemVer：核心数字与预发布中的数字标识都不得有前导零（`03`/`alpha.01` 非法）。
	const numericCore = [match[1], match[2], match[3]];
	if (numericCore.some((part) => !/^(0|[1-9]\d*)$/.test(part))) return null;
	const prerelease = match[4] ? match[4].split(".") : [];
	if (prerelease.some((part) => part === "")) return null;
	if (prerelease.some((part) => /^\d+$/.test(part) && !/^(0|[1-9]\d*)$/.test(part))) return null;
	return { major: BigInt(match[1]), minor: BigInt(match[2]), patch: BigInt(match[3]), prerelease };
}

/** 插件版本（`X.Y.Z[-pre]`）；prerelease 不得以 `.app` 结尾（与载体后缀歧义）。 */
export function isPluginVersion(value) {
	const parsed = parseSemver(value);
	if (parsed === null) return false;
	return !parsed.prerelease.some((part, index, list) => part === "app" && index === list.length - 1);
}

/**
 * SemVer 比较（-1/0/1）。任一侧非法抛错；调用方应先校验。
 */
export function compareSemver(left, right) {
	const a = parseSemver(left);
	const b = parseSemver(right);
	if (a === null || b === null) throw new Error(`invalid SemVer: ${left} / ${right}`);
	for (const key of ["major", "minor", "patch"]) {
		if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
	}
	if (a.prerelease.length === 0 || b.prerelease.length === 0) {
		if (a.prerelease.length === b.prerelease.length) return 0;
		return a.prerelease.length > 0 ? -1 : 1;
	}
	for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
		const x = a.prerelease[index];
		const y = b.prerelease[index];
		if (x === undefined || y === undefined) {
			if (x === y) return 0;
			return x === undefined ? -1 : 1;
		}
		if (x === y) continue;
		const xNumeric = /^\d+$/.test(x);
		const yNumeric = /^\d+$/.test(y);
		if (xNumeric && yNumeric) return BigInt(x) < BigInt(y) ? -1 : 1;
		if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
		return x < y ? -1 : 1;
	}
	return 0;
}

/** 解析 App 版本 `X.Y.Z` / `X.Y.Z+N`；build 缺失时返回 null build（App 发布必须带 +N）。 */
export function parseAppVersion(value) {
	const match = APP_VERSION_RE.exec(String(value ?? ""));
	if (match) return { version: match[1], build: Number.parseInt(match[2], 10) };
	const plain = /^(\d+\.\d+\.\d+)$/.exec(String(value ?? ""));
	return plain ? { version: plain[1], build: null } : null;
}

/** 从 carrier 版本剥离**唯一的**末尾 `-app`，得到配对插件版本；非法返回 null。 */
export function pluginVersionFromCarrier(carrierVersion) {
	const text = String(carrierVersion ?? "");
	if (!text.endsWith("-app")) return null;
	const plugin = text.slice(0, -4);
	return isPluginVersion(plugin) ? plugin : null;
}

/** 解析 carrier 版本 `X.Y.Z[-pre]-app`。 */
export function parseCarrierVersion(carrierVersion) {
	const plugin = pluginVersionFromCarrier(carrierVersion);
	return plugin === null ? null : { carrierVersion: String(carrierVersion), pluginVersion: plugin, core: plugin.split("-")[0] };
}

/**
 * 解析发布 tag `vX.Y.Z[-alpha.N|-rc.N|-<pre>]`。
 * kind：stable / alpha / rc / prerelease-other（本期只支持 alpha/rc/stable）。
 */
export function parseReleaseTag(tag) {
	const match = RELEASE_TAG_RE.exec(String(tag ?? ""));
	if (!match) return null;
	const pluginVersion = match[1];
	if (!isPluginVersion(pluginVersion)) return null;
	const parsed = parseSemver(pluginVersion);
	const prerelease = parsed.prerelease.join(".");
	let kind = "stable";
	if (prerelease !== "") {
		const channel = prerelease.split(".")[0];
		kind = channel === "alpha" || channel === "rc" ? channel : "prerelease-other";
	}
	return { tag: String(tag), pluginVersion, core: pluginVersion.split("-")[0], kind, prerelease: prerelease || null };
}

/** tag / 插件版本的发布通道；非法或不支持返回 null。 */
export function releaseChannel(pluginVersionOrTag) {
	const text = String(pluginVersionOrTag ?? "");
	const parsed = text.startsWith("v") ? parseReleaseTag(text) : parseReleaseTag(`v${text}`);
	if (parsed === null || parsed.kind === "prerelease-other") return null;
	return parsed.kind;
}

/** 计算 buffer 的 npm integrity（`sha512-<base64>`）；用于 bootstrap/verify 的离线校验。 */
export function integrityFromBuffer(buffer) {
	return `sha512-${crypto.createHash("sha512").update(buffer).digest("base64")}`;
}

// ── build-policy.json（release-meta 权威记录）────────────────────────────────────────

/** 解析 build-policy.json 文本并校验 schema；fail-closed。 */
export function parseBuildPolicy(text) {
	let value;
	try {
		value = JSON.parse(String(text ?? ""));
	} catch (error) {
		return { ok: false, policy: null, reasons: [reason("build-policy-json-invalid", error?.message ?? String(error))] };
	}
	const validation = validateBuildPolicy(value);
	return validation.ok
		? { ok: true, policy: validation.policy, reasons: [] }
		: { ok: false, policy: null, reasons: validation.reasons };
}

/**
 * 校验 build-policy 结构（schema 1）：
 *   { schema: 1, watermark: int>0, legacyTags: vX.Y.Z[-pre][], legacyCarriers: [{version, integrity, appBuild}], intents?: [] }
 * 未知字段保留（向前兼容）；缺省 legacyTags/legacyCarriers/intents 视为空数组。
 */
export function validateBuildPolicy(value) {
	const reasons = [];
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return { ok: false, reasons: [reason("build-policy-schema-invalid", "build-policy 必须是对象")] };
	}
	if (value.schema !== BUILD_POLICY_SCHEMA) {
		reasons.push(reason("build-policy-schema-unsupported", `schema=${JSON.stringify(value.schema)} 期望=${BUILD_POLICY_SCHEMA}`));
	}
	if (!isPositiveInteger(value.watermark)) {
		reasons.push(reason("build-policy-watermark-invalid", `watermark=${JSON.stringify(value.watermark)}`));
	}
	const legacyTags = value.legacyTags ?? [];
	if (!Array.isArray(legacyTags)) {
		reasons.push(reason("build-policy-legacy-tags-invalid", "legacyTags 必须是数组"));
	} else {
		const seen = new Set();
		for (const tag of legacyTags) {
			const parsed = parseReleaseTag(tag);
			if (parsed === null) {
				reasons.push(reason("build-policy-legacy-tags-invalid", `非法 tag: ${JSON.stringify(tag)}`));
				continue;
			}
			if (seen.has(parsed.tag)) {
				reasons.push(reason("build-policy-legacy-tags-invalid", `重复 tag: ${parsed.tag}`));
			}
			seen.add(parsed.tag);
		}
	}
	const legacyCarriers = value.legacyCarriers ?? [];
	const carrierVersions = new Set();
	if (!Array.isArray(legacyCarriers)) {
		reasons.push(reason("build-policy-legacy-carriers-invalid", "legacyCarriers 必须是数组"));
	} else {
		for (const entry of legacyCarriers) {
			if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
				reasons.push(reason("build-policy-legacy-carriers-invalid", "legacyCarriers 条目必须是对象"));
				continue;
			}
			const parsed = parseCarrierVersion(entry.version);
			if (parsed === null) {
				reasons.push(reason("build-policy-legacy-carriers-invalid", `非法 carrier 版本: ${JSON.stringify(entry.version)}`));
			} else if (carrierVersions.has(parsed.carrierVersion)) {
				reasons.push(reason("build-policy-legacy-carriers-invalid", `重复 carrier: ${parsed.carrierVersion}`));
			} else {
				carrierVersions.add(parsed.carrierVersion);
			}
			if (typeof entry.integrity !== "string" || !INTEGRITY_RE.test(entry.integrity)) {
				reasons.push(reason("build-policy-legacy-carriers-invalid", `carrier ${entry.version ?? "?"} 的 integrity 非法: ${JSON.stringify(entry.integrity)}`));
			}
			if (!isPositiveInteger(entry.appBuild)) {
				reasons.push(reason("build-policy-legacy-carriers-invalid", `carrier ${entry.version ?? "?"} 的 appBuild 非法: ${JSON.stringify(entry.appBuild)}`));
			}
		}
	}
	const intents = value.intents ?? [];
	if (!Array.isArray(intents)) {
		reasons.push(reason("build-policy-intents-invalid", "intents 必须是数组"));
	} else {
		const openTags = new Set();
		for (const intent of intents) {
			const validation = validateReleaseIntent(intent);
			if (!validation.ok) {
				reasons.push(...validation.reasons);
				continue;
			}
			if (OPEN_INTENT_STATUSES.includes(intent.status)) {
				if (openTags.has(intent.tag)) {
					reasons.push(reason("build-policy-intents-invalid", `同一 tag 存在多个未关闭意图: ${intent.tag}`));
				}
				openTags.add(intent.tag);
			}
		}
	}
	return {
		ok: reasons.length === 0,
		policy: {
			...value,
			legacyTags: Array.isArray(legacyTags) ? [...legacyTags] : [],
			legacyCarriers: Array.isArray(legacyCarriers) ? legacyCarriers.map((entry) => ({ ...entry })) : [],
			intents: Array.isArray(intents) ? intents.map((entry) => ({ ...entry })) : [],
		},
		reasons,
	};
}

/** 稳定序列化（用于写 release-meta）：2 空格缩进 + 末尾换行。 */
export function serializeBuildPolicy(policy) {
	return `${JSON.stringify(policy, null, 2)}\n`;
}

/**
 * 双远端 release-meta 一致性：必须两个数据源都有、SHA 相同、内容逐字节相同。
 * @param {{origin?: {sha?:string|null, content?:string|null, ref?:string}, github?: {sha?:string|null, content?:string|null, ref?:string}, requireBoth?: boolean}} sources
 */
export function assertReleaseMetaSources({ origin = {}, github = {}, requireBoth = true } = {}) {
	const reasons = [];
	const sources = requireBoth ? [["origin", origin], ["github", github]] : [["origin", origin]];
	const observed = [];
	for (const [name, source] of sources) {
		if (typeof source.sha !== "string" || source.sha === "" || typeof source.content !== "string") {
			reasons.push(reason("release-meta-missing", `${name}/release-meta 不可用（ref=${source.ref ?? name}）`));
			continue;
		}
		observed.push({ name, sha: source.sha, content: source.content });
	}
	if (observed.length === sources.length && observed.length === 2) {
		const [first, second] = observed;
		if (first.sha !== second.sha) {
			reasons.push(reason("release-meta-diverged", `reference SHA 不一致: ${first.name}=${first.sha} ${second.name}=${second.sha}`));
		}
		if (first.content !== second.content) {
			reasons.push(reason("release-meta-diverged", `${first.name}/${RELEASE_META_PATH} 与 ${second.name}/${RELEASE_META_PATH} 内容不一致`));
		}
	}
	return { ok: reasons.length === 0, reasons, sources: observed };
}

/**
 * 校验 release-meta 来源并解析 policy（组合 helper；CI/local 共用）。
 * @param {{origin?: object, github?: object, requireBoth?: boolean}} sources
 * @returns {{ok:boolean, policy:object|null, sources:object[], reasons:object[]}}
 */
export function loadBuildPolicyFromSources(sources) {
	const consistency = assertReleaseMetaSources(sources);
	if (!consistency.ok) return { ok: false, policy: null, sources: consistency.sources, reasons: consistency.reasons };
	const parsed = parseBuildPolicy(consistency.sources[0].content);
	return { ok: parsed.ok, policy: parsed.policy, sources: consistency.sources, reasons: parsed.reasons };
}

/** 水位只允许抬高；`reasons` 非空即拒绝写 release-meta。 */
export function assertWatermarkNotRegressed(previousWatermark, nextWatermark) {
	const reasons = [];
	if (!isPositiveInteger(previousWatermark)) reasons.push(reason("build-policy-watermark-invalid", `旧 watermark=${JSON.stringify(previousWatermark)}`));
	if (!isPositiveInteger(nextWatermark)) reasons.push(reason("build-policy-watermark-invalid", `新 watermark=${JSON.stringify(nextWatermark)}`));
	if (reasons.length === 0 && nextWatermark < previousWatermark) {
		reasons.push(reason("build-policy-watermark-regressed", `${previousWatermark} -> ${nextWatermark}`));
	}
	return { ok: reasons.length === 0, reasons };
}

// ── 发布前沿（只由已发布 carrier 事实决定）─────────────────────────────────────────

/**
 * 计算发布前沿：`max(已发布新 carrier 的 appVersion build, legacyCarriers 的 appBuild)`。
 *
 * @param {{
 *   newCarrierAppVersions?: Array<{version?:string, appVersion?:string|null, integrity?:string}|string>,
 *   legacyCarriers?: Array<{version:string, integrity:string, appBuild:number}>,
 *   registryIntegrity?: Record<string,string>,
 *   observedAppVersions?: Record<string,string>,
 * }} input
 * @returns {{ok:boolean, frontier:number, entries:Array<{version:string|null, build:number, source:string}>, reasons:object[]}}
 *
 * - 新 carrier 缺顶层 appVersion / appVersion 非法 → fail-closed（未登记 legacy 不得静默跳过）。
 * - 已登记 legacy carrier：integrity 与 registry 不符 → fail-closed；若 registry 同时可见顶层
 *   appVersion 且与登记的 appBuild 不一致 → fail-closed（防记录漂移）。
 */
export function computePublishedFrontier({
	newCarrierAppVersions = [],
	legacyCarriers = [],
	registryIntegrity = {},
	observedAppVersions = {},
} = {}) {
	const reasons = [];
	const entries = [];
	const legacyByVersion = new Map();
	for (const entry of Array.isArray(legacyCarriers) ? legacyCarriers : []) {
		const parsed = parseCarrierVersion(entry?.version);
		if (parsed === null) {
			reasons.push(reason("build-policy-legacy-carriers-invalid", `非法 legacy carrier: ${JSON.stringify(entry?.version)}`));
			continue;
		}
		if (!isPositiveInteger(entry.appBuild)) {
			reasons.push(reason("legacy-carrier-app-build-invalid", `${parsed.carrierVersion}: ${JSON.stringify(entry.appBuild)}`));
			continue;
		}
		legacyByVersion.set(parsed.carrierVersion, { ...entry, carrierVersion: parsed.carrierVersion });
	}
	const legacySeen = new Set();
	for (const raw of Array.isArray(newCarrierAppVersions) ? newCarrierAppVersions : []) {
		const entry = typeof raw === "string" ? { appVersion: raw } : { ...raw };
		const carrierParsed = parseCarrierVersion(entry.version);
		if (entry.version !== undefined && carrierParsed === null) {
			reasons.push(reason("carrier-version-invalid", JSON.stringify(entry.version)));
			continue;
		}
		const carrierVersion = carrierParsed?.carrierVersion ?? null;
		if (carrierVersion !== null && legacyByVersion.has(carrierVersion)) {
			// 已登记 legacy：以政策记录为准（appBuild），并核对可观测 integrity / appVersion。
			legacySeen.add(carrierVersion);
			const legacy = legacyByVersion.get(carrierVersion);
			const observedIntegrity = entry.integrity ?? registryIntegrity[carrierVersion];
			if (observedIntegrity !== undefined && observedIntegrity !== legacy.integrity) {
				reasons.push(reason("legacy-carrier-integrity-mismatch", `${carrierVersion}: registry=${observedIntegrity} policy=${legacy.integrity}`));
			}
			const observedAppVersion = entry.appVersion ?? observedAppVersions[carrierVersion];
			if (observedAppVersion !== undefined && observedAppVersion !== null && observedAppVersion !== "") {
				const parsedApp = parseAppVersion(observedAppVersion);
				if (parsedApp?.build !== null && parsedApp.build !== legacy.appBuild) {
					reasons.push(reason("legacy-carrier-build-mismatch", `${carrierVersion}: registry=${observedAppVersion} policy build=${legacy.appBuild}`));
				}
			}
			entries.push({ version: carrierVersion, build: legacy.appBuild, source: "legacy-carrier" });
			continue;
		}
		const appVersion = entry.appVersion;
		if (appVersion === undefined || appVersion === null || appVersion === "") {
			reasons.push(reason(
				"carrier-app-version-missing",
				`${carrierVersion ?? "<unknown>"} 缺顶层 appVersion 且未登记 legacyCarriers`,
			));
			continue;
		}
		const parsedApp = parseAppVersion(appVersion);
		if (parsedApp === null || parsedApp.build === null) {
			reasons.push(reason("carrier-app-version-invalid", `${carrierVersion ?? "<unknown>"}: ${JSON.stringify(appVersion)}`));
			continue;
		}
		const observedIntegrity = entry.integrity ?? (carrierVersion ? registryIntegrity[carrierVersion] : undefined);
		const expectedIntegrity = entry.expectedIntegrity;
		if (typeof expectedIntegrity === "string" && typeof observedIntegrity === "string" && expectedIntegrity !== observedIntegrity) {
			reasons.push(reason("carrier-integrity-mismatch", `${carrierVersion}: expected=${expectedIntegrity} registry=${observedIntegrity}`));
			continue;
		}
		entries.push({ version: carrierVersion, build: parsedApp.build, source: "carrier" });
	}
	for (const [carrierVersion, legacy] of legacyByVersion) {
		if (!legacySeen.has(carrierVersion)) {
			// 政策登记了但 npm 已不可见的 legacy carrier：不能当证据，也不能静默忽略。
			reasons.push(reason("legacy-carrier-unverified", `${carrierVersion} 已登记但 npm 未返回该版本`));
		}
	}
	const frontier = entries.reduce((max, entry) => (entry.build > max ? entry.build : max), 0);
	return { ok: reasons.length === 0, frontier, entries, reasons };
}

/**
 * 从「全部已发布 carrier 元数据」构造 computePublishedFrontier 入参。
 * @param {Array<{version:string, appVersion?:string|null, integrity?:string}>} carriers
 */
export function frontierInputFromCarriers(carriers) {
	const newCarrierAppVersions = [];
	const registryIntegrity = {};
	const observedAppVersions = {};
	for (const carrier of Array.isArray(carriers) ? carriers : []) {
		// 非法 carrier 版本不静默跳过：保留原始 version，由 computePublishedFrontier fail-closed。
		const parsed = parseCarrierVersion(carrier?.version);
		const version = parsed?.carrierVersion ?? carrier?.version;
		newCarrierAppVersions.push({
			version,
			appVersion: carrier.appVersion ?? null,
			integrity: carrier.integrity,
		});
		if (typeof version === "string") {
			if (typeof carrier.integrity === "string") registryIntegrity[version] = carrier.integrity;
			if (typeof carrier.appVersion === "string") observedAppVersions[version] = carrier.appVersion;
		}
	}
	return { newCarrierAppVersions, registryIntegrity, observedAppVersions };
}

// ── build 单调校验（CI，已发布状态判定之后）────────────────────────────────────────

/**
 * CI build 校验（设计稿 §5.2.5）：
 *   - 全发布重跑（fullyPublished）→ 跳过 build 校验，只读成功；
 *   - 部分恢复（partialOwnCarrierBuild 非 null）→ 调用方传入**排除自身 carrier 后**的 frontier，
 *     并要求自身 carrier 的 appVersion build 等于本次 build；
 *   - 新发布 → `build > watermark` 且 `build > 发布前沿`；legacy tag 不得作为新发布。
 *
 * 注意：不使用「所有 tag 的最大 build」，tag 集合在排队发布期间会变化。
 */
export function assertNewBuild({
	build,
	watermark,
	frontier = 0,
	fullyPublished = false,
	partialOwnCarrierBuild = null,
	legacyTag = false,
} = {}) {
	const reasons = [];
	if (!isPositiveInteger(watermark)) reasons.push(reason("watermark-invalid", JSON.stringify(watermark)));
	if (!isNonNegativeInteger(frontier)) reasons.push(reason("frontier-invalid", JSON.stringify(frontier)));
	if (!isPositiveInteger(build)) reasons.push(reason("build-invalid", JSON.stringify(build)));
	// 已发布 tag 的重跑是只读幂等：legacy 白名单只约束**新发布**，不阻断历史 tag 的重跑。
	if (fullyPublished) return { ok: reasons.length === 0, skipped: true, frontierUsed: null, partial: false, reasons };
	if (legacyTag) reasons.push(reason("tag-in-legacy-whitelist", "新 tag 不得落入 legacyTags 白名单"));
	if (reasons.length > 0) return { ok: false, skipped: false, frontierUsed: null, partial: false, reasons };

	const partial = partialOwnCarrierBuild !== null && partialOwnCarrierBuild !== undefined;
	if (partial) {
		if (!isPositiveInteger(partialOwnCarrierBuild)) {
			reasons.push(reason("build-invalid", `partialOwnCarrierBuild=${JSON.stringify(partialOwnCarrierBuild)}`));
		} else if (partialOwnCarrierBuild !== build) {
			reasons.push(reason("carrier-build-mismatch", `carrier appVersion build=${partialOwnCarrierBuild} 本次 build=${build}`));
		}
	}
	if (build <= watermark) {
		reasons.push(reason("build-not-above-watermark", `build=${build} <= watermark=${watermark}`));
	}
	if (build <= frontier) {
		reasons.push(reason("build-not-above-published-frontier", `build=${build} <= frontier=${frontier}`));
	}
	return { ok: reasons.length === 0, skipped: false, frontierUsed: frontier, partial, reasons };
}

// ── 已发布状态判定（必须在动态通道/回滚保护之前）────────────────────────────────────

/**
 * @param {boolean} pluginVisible 插件版本在 npm 可见
 * @param {boolean} carrierVisible 精确配对 carrier 在 npm 可见
 * @returns {"fully-published"|"partial-carrier"|"partial-plugin"|"fresh"}
 *
 * - 两者都可见：旧 tag 重跑必须**只读成功**（不要求当前 channel 仍指向它）。
 * - 只有 carrier 可见：部分恢复，排除自身 carrier 后校验 build。
 * - 只有插件可见：异常（插件先于载体可见），fail-closed 要求人工处理。
 */
export function classifyPublishState(pluginVisible, carrierVisible) {
	if (pluginVisible && carrierVisible) return PUBLISH_STATES.FULLY_PUBLISHED;
	if (carrierVisible) return PUBLISH_STATES.PARTIAL_CARRIER;
	if (pluginVisible) return PUBLISH_STATES.PARTIAL_PLUGIN;
	return PUBLISH_STATES.FRESH;
}

/** 已发布状态是否可继续本次发布会话（partial-plugin 一律 fail-closed）。 */
export function assertPublishStateSupported(state) {
	if (state === PUBLISH_STATES.PARTIAL_PLUGIN) {
		return {
			ok: false,
			reasons: [reason("publish-state-inconsistent", "插件已可见但配对 carrier 不可见：不得自动修复，需人工处理")],
		};
	}
	return { ok: true, reasons: [] };
}

// ── app / latest 指针（先比较后移动）────────────────────────────────────────────────

/**
 * app dist-tag 决策：比较 **剥离 `-app` 后的配对插件版本**，不得比较裸 carrier 字符串。
 * @param {string|null|undefined} currentCarrierVersion 当前 dist-tags.app 的值
 * @param {string} candidateCarrierVersion 本次待发布 carrier
 * @returns {{action:"move"|"keep"|"manual", reason:string, currentPluginVersion:string|null, candidatePluginVersion:string|null}}
 */
export function appDistTagDecision(currentCarrierVersion, candidateCarrierVersion) {
	const candidate = parseCarrierVersion(candidateCarrierVersion);
	if (candidate === null) {
		return { action: "manual", reason: "candidate-carrier-invalid", currentPluginVersion: null, candidatePluginVersion: null };
	}
	const currentText = currentCarrierVersion === null || currentCarrierVersion === undefined ? "" : String(currentCarrierVersion);
	if (currentText === "") {
		return { action: "move", reason: "app-unset", currentPluginVersion: null, candidatePluginVersion: candidate.pluginVersion };
	}
	const current = parseCarrierVersion(currentText);
	if (current === null) {
		return { action: "manual", reason: "app-pointer-not-carrier", currentPluginVersion: null, candidatePluginVersion: candidate.pluginVersion };
	}
	const order = compareSemver(candidate.pluginVersion, current.pluginVersion);
	if (order > 0) {
		return { action: "move", reason: "candidate-newer", currentPluginVersion: current.pluginVersion, candidatePluginVersion: candidate.pluginVersion };
	}
	return {
		action: "keep",
		reason: order === 0 ? "candidate-equals-current" : "current-newer",
		currentPluginVersion: current.pluginVersion,
		candidatePluginVersion: candidate.pluginVersion,
	};
}

/**
 * latest dist-tag 决策：只有 stable 可以前进；prerelease 永不移动 latest。
 * @param {string} candidatePluginVersion 本次插件版本
 * @param {string|null|undefined} currentLatestVersion 当前 dist-tags.latest
 */
export function latestDistTagDecision(candidatePluginVersion, currentLatestVersion) {
	if (!isPluginVersion(candidatePluginVersion)) {
		return { action: "manual", reason: "candidate-plugin-version-invalid", candidateChannel: null, currentVersion: null };
	}
	const parsed = parseSemver(candidatePluginVersion);
	const candidateChannel = parsed.prerelease.length === 0
		? "stable"
		: (parsed.prerelease[0] === "alpha" || parsed.prerelease[0] === "rc" ? parsed.prerelease[0] : "prerelease-other");
	if (candidateChannel !== "stable") {
		return { action: "keep", reason: "prerelease-never-moves-latest", candidateChannel, currentVersion: currentLatestVersion ?? null };
	}
	const currentText = currentLatestVersion === null || currentLatestVersion === undefined ? "" : String(currentLatestVersion);
	if (currentText === "") return { action: "move", reason: "latest-unset", candidateChannel, currentVersion: null };
	if (!isPluginVersion(currentText)) {
		return { action: "manual", reason: "latest-invalid", candidateChannel, currentVersion: currentText };
	}
	const order = compareSemver(candidatePluginVersion, currentText);
	if (order > 0) return { action: "move", reason: "stable-newer", candidateChannel, currentVersion: currentText };
	return { action: "keep", reason: order === 0 ? "latest-equals-candidate" : "latest-newer", candidateChannel, currentVersion: currentText };
}

/**
 * alpha/rc 插件 channel dist-tag 决策（设计稿 §5.2.7 的反回退要求）：
 * 候选插件版本必须与当前 channel 版本比较；只有候选**大于**当前才允许移动 channel。
 *   - 等于当前：keep（通道已在候选版本，发布/重跑无需回退）；
 *   - 小于当前：staging（用临时 staging tag 发布插件，**不移动** channel，防止回退）。
 * stable 的 latest 由 `latestDistTagDecision` 处理（只允许 stable 前进）。
 * @param {string} candidatePluginVersion
 * @param {string|null|undefined} currentChannelVersion
 */
export function channelDistTagDecision(candidatePluginVersion, currentChannelVersion) {
	if (!isPluginVersion(candidatePluginVersion)) {
		return { action: "manual", reason: "candidate-plugin-version-invalid", candidateVersion: null, currentVersion: currentChannelVersion ?? null };
	}
	const currentText = currentChannelVersion === null || currentChannelVersion === undefined ? "" : String(currentChannelVersion);
	if (currentText === "") {
		return { action: "move", reason: "channel-unset", candidateVersion: candidatePluginVersion, currentVersion: null };
	}
	if (!isPluginVersion(currentText)) {
		return { action: "manual", reason: "channel-invalid", candidateVersion: candidatePluginVersion, currentVersion: currentText };
	}
	const order = compareSemver(candidatePluginVersion, currentText);
	if (order > 0) return { action: "move", reason: "candidate-newer", candidateVersion: candidatePluginVersion, currentVersion: currentText };
	if (order === 0) return { action: "keep", reason: "candidate-equals-current", candidateVersion: candidatePluginVersion, currentVersion: currentText };
	return { action: "staging", reason: "channel-newer", candidateVersion: candidatePluginVersion, currentVersion: currentText };
}

/**
 * 发布后 dist-tag 校验。对 fully-published 的旧 tag 重跑**不要求**当前 channel 仍等于该版本，
 * 只要求指针未回退/未被本任务重新指回旧版。
 *
 * @param {{
 *   state?:string, pluginTag?:string, pluginVersion?:string, channelCurrent?:string|null,
 *   candidateCarrierVersion?:string, appDecision?:string, appBefore?:string|null, appCurrent?:string|null,
 *   latestDecision?:string, latestBefore?:string|null, latestNow?:string|null,
 * }} input
 */
export function verifyDistTagsAfterPublish(input = {}) {
	const {
		state = PUBLISH_STATES.FRESH,
		pluginTag,
		pluginVersion,
		channelCurrent = null,
		channelDecision = "move",
		channelBefore = null,
		candidateCarrierVersion,
		appDecision = "move",
		appBefore = null,
		appCurrent = null,
		latestDecision = "keep",
		latestBefore = null,
		latestNow = null,
	} = input;
	const reasons = [];
	const fullyPublished = state === PUBLISH_STATES.FULLY_PUBLISHED;
	const candidatePlugin = parseCarrierVersion(candidateCarrierVersion)?.pluginVersion ?? null;

	if (!fullyPublished && pluginTag && pluginTag !== "latest") {
		if (channelDecision === "staging") {
			// 候选版本不比当前 channel 新：插件以 staging tag 发布，alpha/rc channel 必须保持不变。
			const before = channelBefore === null || channelBefore === undefined ? "" : String(channelBefore);
			if ((channelCurrent === null || channelCurrent === undefined ? "" : String(channelCurrent)) !== before) {
				reasons.push(reason("channel-not-preserved", `${pluginTag}=${channelCurrent ?? "<unset>"} 应保持=${before || "<unset>"}`));
			}
		} else if (channelCurrent !== pluginVersion) {
			reasons.push(reason("channel-tag-mismatch", `${pluginTag}=${channelCurrent ?? "<unset>"} 期望=${pluginVersion}`));
		}
	}

	if (candidatePlugin !== null) {
		const app = appCurrent === null || appCurrent === undefined ? "" : String(appCurrent);
		const appParsed = parseCarrierVersion(app);
		if (appDecision === "move") {
			if (app !== candidateCarrierVersion) {
				reasons.push(reason("app-pointer-not-moved", `app=${app || "<unset>"} 期望=${candidateCarrierVersion}`));
			}
		} else if (fullyPublished) {
			if (appParsed === null) {
				reasons.push(reason("app-pointer-not-carrier", `app=${app || "<unset>"}`));
			} else if (compareSemver(appParsed.pluginVersion, candidatePlugin) < 0) {
				reasons.push(reason("app-pointer-rolled-back", `app=${app} 早于 ${candidatePlugin}`));
			}
		} else if (app !== (appBefore ?? "")) {
			reasons.push(reason("app-pointer-not-moved", `app=${app || "<unset>"} 应保持=${appBefore ?? "<unset>"}`));
		} else if (appParsed === null) {
			reasons.push(reason("app-pointer-not-carrier", `app=${app || "<unset>"}`));
		} else if (compareSemver(appParsed.pluginVersion, candidatePlugin) < 0) {
			reasons.push(reason("app-pointer-rolled-back", `app=${app} 早于 ${candidatePlugin}`));
		}
	}

	// 全发布旧 tag 重跑是**只读**的：不改任何 dist-tag，也不要求 latest 与旧 tag 有关系。
	// （设计稿 §11.2：旧 alpha.1 在 alpha.2 已发布后重跑不得要求当前 channel 等于 alpha.1。）
	if (!fullyPublished) {
		const latest = latestNow === null || latestNow === undefined ? "" : String(latestNow);
		if (latestDecision === "move") {
			if (latest !== pluginVersion) {
				reasons.push(reason("latest-not-advanced", `latest=${latest || "<unset>"} 期望=${pluginVersion}`));
			}
		} else {
			const before = latestBefore === null || latestBefore === undefined ? "" : String(latestBefore);
			if (latest !== before) {
				reasons.push(reason("latest-prerelease-moved", `latest=${latest || "<unset>"} 应保持=${before || "<unset>"}`));
			}
		}
	}
	return { ok: reasons.length === 0, reasons };
}

// ── 发布意图（submitted / unknown / published / failed）────────────────────────────

/** 校验单条发布意图。 */
export function validateReleaseIntent(intent) {
	const reasons = [];
	if (intent === null || typeof intent !== "object" || Array.isArray(intent)) {
		return { ok: false, reasons: [reason("release-intent-invalid", "intent 必须是对象")] };
	}
	const parsedTag = parseReleaseTag(intent.tag);
	if (parsedTag === null) reasons.push(reason("release-intent-invalid", `非法 tag: ${JSON.stringify(intent.tag)}`));
	if (!isPluginVersion(intent.pluginVersion)) reasons.push(reason("release-intent-invalid", `非法 pluginVersion: ${JSON.stringify(intent.pluginVersion)}`));
	if (parseCarrierVersion(intent.carrierVersion) === null) reasons.push(reason("release-intent-invalid", `非法 carrierVersion: ${JSON.stringify(intent.carrierVersion)}`));
	if (!isPositiveInteger(intent.build)) reasons.push(reason("release-intent-invalid", `非法 build: ${JSON.stringify(intent.build)}`));
	if (intent.integrity !== undefined && (typeof intent.integrity !== "string" || !INTEGRITY_RE.test(intent.integrity))) {
		reasons.push(reason("release-intent-invalid", `非法 integrity: ${JSON.stringify(intent.integrity)}`));
	}
	if (!INTENT_STATUSES.includes(intent.status)) reasons.push(reason("release-intent-status-invalid", JSON.stringify(intent.status)));
	return { ok: reasons.length === 0, reasons };
}

/** 未关闭意图（submitted/unknown）。 */
export function openReleaseIntents(policy) {
	return (Array.isArray(policy?.intents) ? policy.intents : []).filter((intent) => OPEN_INTENT_STATUSES.includes(intent.status));
}

/**
 * 阻断后续分配/发布规则（设计稿 §5.4/§5.5）：
 *   - 任何 unknown 意图（无论哪个 tag）都阻断，必须人工恢复；
 *   - 其它 tag 的 submitted 意图阻断新发布会话；
 *   - 当前 tag 自己的 submitted 意图允许续跑同一次会话（不是“后续发布”）。
 * @param {object|null} policy
 * @param {{tag?:string}} [options]
 */
export function assertNoOpenReleaseIntents(policy, { tag = null } = {}) {
	const reasons = [];
	for (const intent of openReleaseIntents(policy)) {
		if (intent.status === "unknown") {
			reasons.push(reason("release-intent-unknown", `${intent.tag}（${intent.pluginVersion}/${intent.carrierVersion}）等待人工确认`));
			continue;
		}
		if (tag === null || intent.tag !== tag) {
			reasons.push(reason("release-intent-open", `${intent.tag}（${intent.status}）未关闭，不得开始新的分配/发布`));
		}
	}
	return { ok: reasons.length === 0, reasons };
}

/** 无法确认发布结果时的稳定 reason（CI 在 unknown 状态下输出）。 */
export function unknownPublishReason(intent, detail = "") {
	return reason("release-visibility-unknown", `${intent?.tag ?? "<tag>"} 提交后可见性未确认${detail ? `：${detail}` : ""}`);
}

/**
 * 记录发布意图（提交 registry **之前**）。同 tag 已有未关闭意图时：
 *   - 内容一致 → 幂等返回原策略；
 *   - 内容不同 → fail-closed（不得覆盖）。
 * 同 tag 的最近意图已 published 时拒绝重复发布会话（版本已发布）。
 * @returns {{ok:boolean, policy:object|null, reasons:object[], changed:boolean, intent?:object}}
 */
export function applyReleaseIntent(policy, input) {
	const validation = validateBuildPolicy(policy);
	if (!validation.ok) return { ok: false, policy: null, reasons: validation.reasons, changed: false };
	const candidate = {
		tag: input?.tag,
		pluginVersion: input?.pluginVersion,
		carrierVersion: input?.carrierVersion,
		build: input?.build,
		integrity: input?.integrity,
		status: input?.status ?? "submitted",
		createdAt: input?.createdAt ?? new Date().toISOString(),
	};
	if (candidate.integrity === undefined) delete candidate.integrity;
	const intentValidation = validateReleaseIntent(candidate);
	if (!intentValidation.ok) return { ok: false, policy: null, reasons: intentValidation.reasons, changed: false };
	const intents = Array.isArray(policy.intents) ? policy.intents : [];
	const existing = [...intents].reverse().find((intent) => intent.tag === candidate.tag);
	if (existing && OPEN_INTENT_STATUSES.includes(existing.status)) {
		const same = existing.pluginVersion === candidate.pluginVersion
			&& existing.carrierVersion === candidate.carrierVersion
			&& existing.build === candidate.build
			&& (existing.integrity ?? null) === (candidate.integrity ?? null);
		if (same) return { ok: true, policy, reasons: [], changed: false, intent: existing };
		return {
			ok: false,
			policy: null,
			reasons: [reason("release-intent-conflict", `${candidate.tag} 已有未关闭意图（${existing.pluginVersion} build ${existing.build}）`)],
			changed: false,
		};
	}
	if (existing && existing.status === "published") {
		return {
			ok: false,
			policy: null,
			reasons: [reason("release-intent-conflict", `${candidate.tag} 已标记 published，禁止重复发布会话`)],
			changed: false,
		};
	}
	const nextPolicy = { ...policy, intents: [...intents, candidate] };
	return { ok: true, policy: nextPolicy, reasons: [], changed: true, intent: candidate };
}

/**
 * 更新发布意图状态（unknown/published/failed）。必须已有该 tag 的发布意图；
 * 不允许凭空创建缺少 tag/plugin/carrier/build 的非法意图（fail-closed）。
 * @returns {{ok:boolean, policy:object|null, reasons:object[], changed:boolean}}
 */
export function markReleaseIntent(policy, { tag, status, note = "", integrity = null, updatedAt = new Date().toISOString() } = {}) {
	const validation = validateBuildPolicy(policy);
	if (!validation.ok) return { ok: false, policy: null, reasons: validation.reasons, changed: false };
	if (!["unknown", "published", "failed"].includes(status)) {
		return { ok: false, policy: null, reasons: [reason("release-intent-status-invalid", String(status))], changed: false };
	}
	if (integrity !== null && integrity !== undefined && (typeof integrity !== "string" || !INTEGRITY_RE.test(integrity))) {
		return { ok: false, policy: null, reasons: [reason("release-intent-invalid", `非法 integrity: ${JSON.stringify(integrity)}`)], changed: false };
	}
	const intents = (Array.isArray(policy.intents) ? policy.intents : []).map((intent) => ({ ...intent }));
	let index = -1;
	for (let cursor = intents.length - 1; cursor >= 0; cursor -= 1) {
		if (intents[cursor].tag === tag) { index = cursor; break; }
	}
	if (index === -1) {
		// 不允许凭空创建非法意图（缺 tag/plugin/carrier/build）；人工补记必须先有完整记录。
		return { ok: false, policy: null, reasons: [reason("release-intent-missing", String(tag))], changed: false };
	}
	const current = intents[index];
	if (current.status === status) {
		return { ok: true, policy, reasons: [], changed: false };
	}
	if (current.status === "published" || current.status === "failed") {
		return {
			ok: false,
			policy: null,
			reasons: [reason("release-intent-conflict", `${tag} 已处于终态 ${current.status}`)],
			changed: false,
		};
	}
	intents[index] = {
		...current,
		status,
		note: note || current.note,
		updatedAt,
		...(integrity !== null && integrity !== undefined ? { integrity } : {}),
	};
	const nextPolicy = { ...policy, intents };
	return { ok: true, policy: nextPolicy, reasons: [], changed: true };
}

/** 是否有任何未关闭意图（CI 发布前置门禁用）。 */
export function hasOpenReleaseIntents(policy) {
	return openReleaseIntents(policy).length > 0;
}
