// 演练版本命名（issue #37：一次性假版本，跨次运行互不冲突、绝不消耗公共版本号）。
//
// ── 与 issue 原文的差异（实现约束，必须在评审中确认）────────────────────────────────
// issue 建议 `9.9.9-drill.<随机后缀>`；但运行时载体发现（lib/app-carrier.js）的版本契约要求
// 插件版本必须是**纯 X.Y.Z**（`PLUGIN_VERSION_PATTERN`），且载体清单 app 版本语义部分必须等于
// 插件版本。`9.9.9-drill.x` 是 semver 预发布版本，会把 A11/A13/A16/A17 的「载体发现」断言
// 直接判成版本不符——那不是演练要测的失败。因此演练版本改用**纯 X.Y.Z 的 9.9.x 预演线**：
//   插件 = `9.9.<随机补丁号>`（1–999999），载体 = `9.9.<补丁号>-app`。
// 它同样满足「假版本、跨次不冲突、不占正式版本、载体版本 = 插件版本 + -app」的目的；代价是
// 清单里的 app 版本语义部分也要投影（演练专用，见 projection.mjs）。
import crypto from "node:crypto";

/** 演练版本线：9.9.x（明显不是正式语义版本，且运行时版本契约允许纯 X.Y.Z）。 */
export const DRILL_VERSION_MAJOR = 9;
export const DRILL_VERSION_MINOR = 9;

const PLUGIN_PATTERN = /^9\.9\.\d{1,6}$/;
const CARRIER_PATTERN = /^9\.9\.\d{1,6}-app$/;

/** 随机补丁号（1–999999）。 */
export function randomPatch() {
	return 1 + (crypto.randomBytes(3).readUIntBE(0, 3) % 999999);
}

/** `9.9.<patch>`；patch 可选（默认随机）。 */
export function drillPluginVersion(patch = randomPatch()) {
	return `${DRILL_VERSION_MAJOR}.${DRILL_VERSION_MINOR}.${patch}`;
}

/** 载体演练版本：插件演练版本 + `-app`。 */
export function drillCarrierVersion(pluginVersion) {
	return `${pluginVersion}-app`;
}

export function isDrillPluginVersion(version) {
	return typeof version === "string" && PLUGIN_PATTERN.test(version);
}

export function isDrillCarrierVersion(version) {
	return typeof version === "string" && CARRIER_PATTERN.test(version);
}

/**
 * 生成一次演练使用的全部版本（插件 A/B、载体 A/B、只发插件场景的 C）。
 * A 与 B 必须是不同补丁号（第二对版本用于版本更新断言）。
 */
export function createDrillVersions() {
	const used = new Set();
	const nextVersion = () => {
		let version = drillPluginVersion();
		while (used.has(version)) version = drillPluginVersion();
		used.add(version);
		return version;
	};
	const pluginA = nextVersion();
	const pluginB = nextVersion();
	const pluginOnly = nextVersion();
	return {
		pluginA,
		carrierA: drillCarrierVersion(pluginA),
		pluginB,
		carrierB: drillCarrierVersion(pluginB),
		pluginOnly,
		carrierOnlyMissing: drillCarrierVersion(pluginOnly),
	};
}

/**
 * 校验版本命名空间（离线可断言）：两条配对规则、A/B/C 互不相同、均落在 9.9.x 预演线。
 * 返回 `{ok, problems}`，problems 是稳定英文短语（写进 detail，不当作 reason）。
 */
export function validateDrillVersions(versions) {
	const problems = [];
	if (!isDrillPluginVersion(versions?.pluginA)) problems.push("pluginA-not-drill-namespace");
	if (!isDrillCarrierVersion(versions?.carrierA)) problems.push("carrierA-not-drill-namespace");
	if (!isDrillPluginVersion(versions?.pluginB)) problems.push("pluginB-not-drill-namespace");
	if (!isDrillCarrierVersion(versions?.carrierB)) problems.push("carrierB-not-drill-namespace");
	if (!isDrillPluginVersion(versions?.pluginOnly)) problems.push("pluginOnly-not-drill-namespace");
	if (versions?.carrierA !== `${versions?.pluginA}-app`) problems.push("carrierA-not-paired");
	if (versions?.carrierB !== `${versions?.pluginB}-app`) problems.push("carrierB-not-paired");
	if (versions?.carrierOnlyMissing !== `${versions?.pluginOnly}-app`) problems.push("carrierOnly-not-paired");
	const patches = [versions?.pluginA, versions?.pluginB, versions?.pluginOnly].map((version) => String(version ?? ""));
	if (new Set(patches).size !== patches.length) problems.push("versions-not-unique");
	return { ok: problems.length === 0, problems };
}
