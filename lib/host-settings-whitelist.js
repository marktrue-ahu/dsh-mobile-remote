// issue #106：手机端「电脑端设置（只读）」的**固定白名单**。
//
// 安全契约（不可妥协）：
//   - 白名单只在宿主侧冻结；App **不保存副本、不拼路径、不接受运行时扩展**。
//   - 投影只走这里列出的 `namespace + field path`；**没列出的项一律不返回**，
//     响应里没有的项在 UI 上就是不可见（不补默认、不猜 schema、不显示原始 JSON）。
//   - 这里只放**无凭据、无文件系统路径、无会话正文**的配置字段。
//
// ## 冻结依据（2026-11-23，DSH 0.2.2-rc.5 `settings.describe()` 实测口径）
//
// 1. **只有 volatile 字段可达**：`dsh-settings` 的 `describe()` 先用 `volatileForm()`
//    过滤 schema，再用 `projectForm()` 投影值；非 volatile 字段既不进 `schema`，
//    也不进 `value`/`base`/`user`。因此白名单**只能**选 volatile 节点下的字段，
//    否则永远是"可见 0 项"（等于白列）。例：`agent-preset-registry.default` 与
//    `permission.presets.*` 都**不是** volatile，故不列；列 `selectedDefault` / `defaultPreset`。
// 2. **secret 只以槽位出现**：`role('secret')`（密文本身）与 `role('credential-ref')`
//    （凭据引用名，常内嵌账号 id）一律只作为 `kind:"secret"` 的「已设置/未设置」出现，
//    或干脆不列。`llm-pi-ai.providers.*.apiKeyEnv` 即属后者：引用名无展示价值，不列。
// 3. **一律不列**（宿主也不会替我们剥）：
//    - `headers` / `requestHeaders` / `accountRequestHeaders`（值可能是令牌）；
//    - `baseURL` / `proxyUrl` / `platformOrigin` / `inferenceOrigin`（可能内嵌 userinfo
//      或暴露主机拓扑）；
//    - `cwd` / `path` / `updateDir` / `documentPath` 等一切文件系统路径；
//    - 自由文本（`description`、prompt 类）与会话正文、工具参数/结果。
// 4. **不按第三方插件猜**：只列 DSH 内置插件自带 schema 中语义稳定的字段；插件自由
//    `object`/`dict`（形状会随版本漂移、无法逐字段断言脱敏）整段不列。
//
// ## 更新方式
// 改本文件后必跑 `node --test test/host-settings*.test.mjs`（含嵌套 secret / 默认值旁路 /
// 凭据 / 路径负例）。`HOST_SETTINGS_WHITELIST_VERSION` 只在**字段语义变化**时递增，
// 供诊断与后续契约迁移（App 不据此推断字段是否存在）。
//
// 路径里的 `*` 只表示「dict 的键 / 数组元素」，由宿主按实际值展开成具体键，
// 展开数量有上限（`lib/host-settings.js` 的 `MAX_WILDCARD_ITEMS`）；超限即 fail-closed。

/** 白名单契约版本（字段语义变化时递增）。 */
export const HOST_SETTINGS_WHITELIST_VERSION = 1;

/**
 * 视觉分组（只分组，不新增可展示 key）。顺序即 UI 顺序。
 *
 * 按 /tmp/3.3.1-ui-design.md §2.3 的四组收敛掉「连接与宿主」：主机名/DSH 版本/运行模式
 * **不是设置项**，由响应顶部的 `host` 段（及 App 本地连接档案名）承载，不进 `namespaces`，
 * 避免把"宿主事实"混进"设置字段"里造成来源/默认值语义不清。
 */
export const HOST_SETTINGS_GROUPS = Object.freeze([
	Object.freeze({ id: "model-routing", title: "模型与路由", titleEn: "Model & routing" }),
	Object.freeze({ id: "permissions", title: "权限与审批", titleEn: "Permissions & approval" }),
	Object.freeze({ id: "session-agent", title: "会话与代理", titleEn: "Sessions & agents" }),
]);

/**
 * 固定白名单。每条 = 一个 namespace 下的一个 field path（`path` 中的 `*` 为 dict 键）。
 * `title` / `titleEn` 是该行的固定标题（宿主算好，App 不再猜 schema 标题）。
 */
export const HOST_SETTINGS_WHITELIST = Object.freeze([
	// ── 模型与路由 ────────────────────────────────────────────────
	// agent-default-model：三者都 `.volatile()`，是纯标识串，不含密钥
	// （密钥在各自 llm-* 命名空间，已从白名单排除）。
	Object.freeze({
		ns: "agent-default-model",
		group: "model-routing",
		namespaceTitle: "默认模型",
		namespaceTitleEn: "Default model",
		path: Object.freeze(["provider"]),
		title: "默认提供商",
		titleEn: "Default provider",
	}),
	Object.freeze({
		ns: "agent-default-model",
		group: "model-routing",
		namespaceTitle: "默认模型",
		namespaceTitleEn: "Default model",
		path: Object.freeze(["model"]),
		title: "默认模型",
		titleEn: "Default model",
	}),
	Object.freeze({
		ns: "agent-default-model",
		group: "model-routing",
		namespaceTitle: "默认模型",
		namespaceTitleEn: "Default model",
		path: Object.freeze(["reasoningEffort"]),
		title: "推理强度",
		titleEn: "Reasoning effort",
	}),
	// llm-pi-ai：`providers` 整棵子树是 volatile dict，可按 route 展开。
	// 只取显示名与默认上下文窗口；`apiKeyEnv`（credential-ref）、`baseURL`、`headers`、
	// `models` / `modelOverrides`（含端点与自由形状）**都不列**。
	Object.freeze({
		ns: "llm-pi-ai",
		group: "model-routing",
		namespaceTitle: "提供商路由",
		namespaceTitleEn: "Provider routes",
		path: Object.freeze(["providers", "*", "displayName"]),
		title: "提供商名称",
		titleEn: "Provider name",
	}),
	Object.freeze({
		ns: "llm-pi-ai",
		group: "model-routing",
		namespaceTitle: "提供商路由",
		namespaceTitleEn: "Provider routes",
		path: Object.freeze(["providers", "*", "defaultContextWindow"]),
		title: "上下文窗口",
		titleEn: "Context window",
	}),
	// web-search-deepseek：联网搜索的模型与配额。`apiKey` 是 `role('secret')`，
	// 只作为 secret 槽位（已设置/未设置），永不带值/长度/前缀。
	// `baseURL` / `apiKeyEnv` / `apiVersion` 不列。
	Object.freeze({
		ns: "web-search-deepseek",
		group: "model-routing",
		namespaceTitle: "联网搜索",
		namespaceTitleEn: "Web search",
		path: Object.freeze(["model"]),
		title: "搜索模型",
		titleEn: "Search model",
	}),
	Object.freeze({
		ns: "web-search-deepseek",
		group: "model-routing",
		namespaceTitle: "联网搜索",
		namespaceTitleEn: "Web search",
		path: Object.freeze(["maxUses"]),
		title: "单次最多搜索次数",
		titleEn: "Max searches per request",
	}),
	Object.freeze({
		ns: "web-search-deepseek",
		group: "model-routing",
		namespaceTitle: "联网搜索",
		namespaceTitleEn: "Web search",
		path: Object.freeze(["maxTokens"]),
		title: "回复 token 上限",
		titleEn: "Max reply tokens",
	}),
	Object.freeze({
		ns: "web-search-deepseek",
		group: "model-routing",
		namespaceTitle: "联网搜索",
		namespaceTitleEn: "Web search",
		path: Object.freeze(["apiKey"]),
		title: "API 密钥",
		titleEn: "API key",
	}),

	// ── 权限与审批 ────────────────────────────────────────────────
	// permission：`defaultPreset` 是唯一的 volatile 字段。`presets` 表**不是** volatile，
	// describe() 里根本不存在，故不列（不制造"永远 0 项"的假字段）。
	Object.freeze({
		ns: "permission",
		group: "permissions",
		namespaceTitle: "权限预设",
		namespaceTitleEn: "Permission presets",
		path: Object.freeze(["defaultPreset"]),
		title: "默认权限预设",
		titleEn: "Default permission preset",
	}),

	// ── 会话与代理 ────────────────────────────────────────────────
	// agent-preset-registry：`default` 非 volatile（describe 不可见），只有
	// `selectedDefault` 可见；如实只列后者，标题也按"当前选中"而非"默认"，
	// 不让 UI 把运行态覆盖误标成默认值。
	Object.freeze({
		ns: "agent-preset-registry",
		group: "session-agent",
		namespaceTitle: "Agent 预设",
		namespaceTitleEn: "Agent presets",
		path: Object.freeze(["selectedDefault"]),
		title: "当前选中的预设",
		titleEn: "Selected preset",
	}),
	// subagent：子代理深度与并发上限，两个数字字段，无路径/正文。
	Object.freeze({
		ns: "subagent",
		group: "session-agent",
		namespaceTitle: "子代理",
		namespaceTitleEn: "Subagents",
		path: Object.freeze(["maxDepth"]),
		title: "最大层级",
		titleEn: "Max depth",
	}),
	Object.freeze({
		ns: "subagent",
		group: "session-agent",
		namespaceTitle: "子代理",
		namespaceTitleEn: "Subagents",
		path: Object.freeze(["maxActiveSubagents"]),
		title: "最大并发子代理",
		titleEn: "Max active subagents",
	}),
	// agent-loop：并发工具上限。`agents[]` 含 `cwd`（绝对路径）与 resumeSessionId，
	// **整段不列**，只列这一个数字。
	Object.freeze({
		ns: "agent-loop",
		group: "session-agent",
		namespaceTitle: "Agent 循环",
		namespaceTitleEn: "Agent loop",
		path: Object.freeze(["maxParallelToolCalls"]),
		title: "最大并行工具调用",
		titleEn: "Max parallel tool calls",
	}),
]);

/** 白名单是否为空（fail-closed 判据之一）。 */
export const hostSettingsWhitelistIsEmpty = () => HOST_SETTINGS_WHITELIST.length === 0;
