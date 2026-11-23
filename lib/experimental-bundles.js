// issue #153：插件三分类（内置 / 实验性 / 自定义）的**静态权威表**。
//
// 为什么这张表在插件宿主侧、而不是 App 里：
//   - DSH 的“实验性”不是 `BundleInfo` 字段，而是 `@deepseek-ai/dsh-official-bundles`
//     按 DSH 版本发布的静态名单（EXPERIMENTAL_BUNDLES）；App 拿不到 DSH 版本事实，
//     只有宿主能读到当前运行版本；
//   - 分类谓词与表必须同侧，否则全仓会出现两份互相漂移的分类实现。
//
// 明确禁止：
//   - 运行时 `import("@deepseek-ai/dsh-official-bundles")` 当权威——不同宿主版本的导出
//     形状不保证稳定，且“宿主自己判自己”无法暴露表漂移；
//   - 按包名前缀（`experimental-`）、`optional` 或名称猜实验性。
// 表版本必须随 DSH 升级评审更新；漂移由根级 `classification.matched` 暴露，不静默改判。
//
// 表内容取自 `@deepseek-ai/dsh-official-bundles@0.2.2-rc.5` 的 EXPERIMENTAL_BUNDLES /
// HIDDEN_BUNDLES（2026-11 实测），保持不变，不做增删。

/** 表版本：随 DSH 版本评审更新；App 与发版说明引用此值。 */
export const EXPERIMENTAL_TABLE_VERSION = "2026.11";

/** 该表对齐的 DSH core 版本（去掉 prerelease/build 后比较）。 */
export const EXPERIMENTAL_TARGET_DSH = "0.2.2";

/** 命中即归「实验性」的官方 bundle 名单（与 DSH 0.2.2 的 EXPERIMENTAL_BUNDLES 一致）。 */
export const EXPERIMENTAL_BUNDLES = Object.freeze(new Set([
	"@deepseek-ai/dsh-personalized-recommendations",
	"@deepseek-ai/dsh-cua-bundle",
	"@deepseek-ai/dsh-experimental-voice-input-bundle",
	"@deepseek-ai/dsh-experimental-auto-review",
	"@deepseek-ai/dsh-experimental-inspector-profile",
	"@deepseek-ai/dsh-experimental-forge-bundle",
	"@deepseek-ai/dsh-experimental-tool-worktree",
	"@deepseek-ai/dsh-experimental-cot-translation-bundle",
	"@deepseek-ai/dsh-experimental-session-search",
	"@deepseek-ai/dsh-experimental-session-titles-bundle",
	"@deepseek-ai/dsh-experimental-badge-skill-bundle",
	"@deepseek-ai/dsh-experimental-ralph-bundle",
	"@deepseek-ai/dsh-experimental-plugin-market-bundle",
	"@deepseek-ai/dsh-experimental-liveshare",
	"@deepseek-ai/dsh-deepseek-chat-import",
]));

/**
 * 没有插件页的 bundle（内置模板、常驻终端、独立 worktree 工具）：
 * 手机端主列表默认不展示，提供「显示隐藏项」开关。
 */
export const HIDDEN_BUNDLES = Object.freeze(new Set([
	"@deepseek-ai/dsh-base",
	"@deepseek-ai/dsh-web-app",
	"@deepseek-ai/dsh-headless",
	"@deepseek-ai/dsh-sdk-app",
	"@deepseek-ai/dsh-acp-app",
	"@deepseek-ai/dsh-sdk-minimal",
	"@deepseek-ai/dsh-experimental-terminal-bundle",
	"@deepseek-ai/dsh-experimental-tool-worktree",
]));

/** 分类 kind → 中文 label（English 由 App 本地化，label 只作兜底）。 */
const CATEGORY_LABELS = Object.freeze({
	experimental: "实验性",
	builtin: "内置",
	custom: "自定义",
	unclassified: "已安装（未分类）",
});

const CATEGORY = (kind, reason = "") => ({ kind, label: CATEGORY_LABELS[kind], reason });

/** 宿主是否把某个包名标为隐藏（无插件页的 bundle）。 */
export function isHiddenBundle(name) {
	return typeof name === "string" && HIDDEN_BUNDLES.has(name);
}

/**
 * 去掉 prerelease/build 后的 `major.minor.patch`；非字符串/非法 → ""。
 * DSH 运行版本形如 `0.2.2-rc.5`，表目标是 `0.2.2`：同一 core 即视为匹配。
 */
export function dshCoreVersion(version) {
	if (typeof version !== "string") return "";
	const core = version.trim().split(/[-+]/, 1)[0];
	return /^\d+\.\d+\.\d+$/.test(core) ? core : "";
}

/** 当前 DSH 版本是否与静态表对齐（版本未知 → false，fail-closed）。 */
export function experimentalTableMatches(dshVersion) {
	const core = dshCoreVersion(dshVersion);
	return core !== "" && core === EXPERIMENTAL_TARGET_DSH;
}

/**
 * 分类谓词（用户已裁决 = 方案 B）。
 *
 * 优先级：**事实缺失/独立条目先降级**（写死，不猜），再 experimental → builtin → custom。
 * - `official`/`optional` 任一为 null（旧宿主没给这两个字段）→ unclassified/host-facts-missing；
 * - `independent:true`（配置条目，不是 bundle）→ unclassified/independent-entry；
 * - 命中 EXPERIMENTAL_BUNDLES → experimental（实验性包即使随安装附带也算实验性）；
 * - `availability === "installation"` → builtin；
 * - 其余已安装 profile bundle → custom。
 *
 * @param {{ name?: unknown, official?: unknown, optional?: unknown, availability?: unknown, installed?: unknown, independent?: unknown }} bundle
 * @returns {{ kind: "experimental"|"builtin"|"custom"|"unclassified", label: string, reason: string }}
 */
export function classifyPluginBundle(bundle) {
	if (bundle?.independent === true) return CATEGORY("unclassified", "independent-entry");
	if (typeof bundle?.official !== "boolean" || typeof bundle?.optional !== "boolean") {
		return CATEGORY("unclassified", "host-facts-missing");
	}
	const name = typeof bundle?.name === "string" ? bundle.name : "";
	if (EXPERIMENTAL_BUNDLES.has(name)) return CATEGORY("experimental");
	if (bundle?.availability === "installation") return CATEGORY("builtin");
	return CATEGORY("custom");
}

/** `availability` 只接受契约里的四个值，其余（含缺失）→ null。 */
export function normalizeAvailability(value) {
	return value === "installation" || value === "profile" || value === "missing" ? value : null;
}

/** `installed` 只接受布尔事实，缺失 → null。 */
export function normalizeInstalled(value) {
	return typeof value === "boolean" ? value : null;
}
