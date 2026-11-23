// issue #106：手机端「电脑端设置（只读）」的**宿主侧投影与二次脱敏**。
//
// 为什么不能只信宿主：`settings.describe({redactSecrets:true})` 会剥掉
// `role('secret')` 字段，但本插件仍要自己做一遍，理由有三：
//   1. 我们是**另一条 wire**（`/m/api/host-settings`），脱敏逻辑不能只存在于上游一处；
//   2. 白名单之外的字段（`baseURL`、`headers`、`cwd`…）宿主不会剥，投影时必须
//      **整段不取**；只取白名单叶子能从根上避免"顺手带出去"；
//   3. `value`/`base`/`user` 三层都可能旁路泄露（默认值层最容易被忘），必须逐层处理。
//
// 本模块是**纯函数**（不碰 ctx、不写日志、不读文件、不回显原文），由 `lib/index.js`
// 注入 `settings` 服务与既有严格读取器，便于用假设置做负例测试。
//
// 失败即关（fail-closed），且**整段而不是半段**：
//   - 读不到 / describe 形状漂移 / schema 解析失败 / 脱敏异常 → 该命名空间不返回任何字段；
//   - 任何白名单字段的**值**或**键名**过不了擦除器（绝对路径、URL、形似凭据、过长、
//     非标量）→ 整个命名空间 fail-closed，绝不"先给一半"；
//   - secret 只给 `{path, set}`，永不带值/长度/前缀。
import {
	HOST_SETTINGS_GROUPS,
	HOST_SETTINGS_WHITELIST,
	HOST_SETTINGS_WHITELIST_VERSION,
	hostSettingsWhitelistIsEmpty,
} from "./host-settings-whitelist.js";

/** 单个命名空间最多产出的字段数（防御异常 schema / 巨大 dict 展开）。 */
const MAX_FIELDS_PER_NAMESPACE = 200;
/** 一个 dict/数组通配展开的项数上限（超过即形状异常，fail-closed）。 */
const MAX_WILDCARD_ITEMS = 50;
/** 展示值的最大字符数；超过即 fail-closed（长文本多半是正文/提示词，不属于设置项）。 */
const MAX_VALUE_TEXT = 512;
/** schema/值递归深度上限（懒加载 schema 可能成环）。 */
const MAX_DEPTH = 24;

/**
 * 键名黑名单（**精确名**比较，不做子串匹配）。
 *
 * 用子串会把 `maxTokens` / `contextWindow` 这类正常字段误伤；用精确名既挡住凭据类键，
 * 又不会把额度/窗口字段当成 secret。schema 声明的 secret 另走 `role` 通路，两条取并集。
 */
const DENY_KEY_NAMES = new Set([
	"key",
	"apikey",
	"secret",
	"token",
	"accesstoken",
	"refreshtoken",
	"sessiontoken",
	"bearertoken",
	"password",
	"passwd",
	"passphrase",
	"authorization",
	"cookie",
	"cookies",
	"credential",
	"credentials",
	"privatekey",
	"apikeyenv",
	"headers",
]);

/** 形似凭据的值前缀（命中即 fail-closed，不回显原文）。 */
const CREDENTIAL_VALUE_PREFIXES = [
	"sk-",
	"sk_",
	"ghp_",
	"gho_",
	"ghs_",
	"github_pat_",
	"xoxb-",
	"xoxp-",
	"akia",
	"asia",
	"bearer ",
	"basic ",
	"-----begin ",
];

/** 只允许出现在 dict 键/数组下标里的安全字符（挡住把路径/URL/凭据塞进键名）。 */
const SAFE_KEY_SEGMENT = /^[A-Za-z0-9._:@+-]{1,128}$/;

/** 判断是否普通对象（可递归）。 */
const isPlainRecord = (value) =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** JSON 形状深比较（值都是 JSON 形状，够用且不引入依赖）。 */
const sameJson = (a, b) => {
	if (a === b) return true;
	if (typeof a !== typeof b) return false;
	if (a === null || b === null) return false;
	if (typeof a !== "object") return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a)) {
		return a.length === b.length && a.every((item, index) => sameJson(item, b[index]));
	}
	const ak = Object.keys(a);
	const bk = Object.keys(b);
	if (ak.length !== bk.length) return false;
	return ak.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]));
};

// ── schema 解析（schemastery toJSON 信封：{uid, refs}） ────────────────────────

/**
 * 解析序列化 schema 信封。
 *
 * 兼容信封 `{uid, refs}` 与节点内以 uid 数字自引用的形式（schemastery `toJSON()` 的实测形状）。
 * 任何不认识的形状返回 `undefined` —— 调用方据此让该命名空间 fail-closed。
 */
const parseSchemaEnvelope = (schema) => {
	if (!isPlainRecord(schema)) return undefined;
	const refs = schema.refs;
	if (!isPlainRecord(refs)) return undefined;
	if (typeof schema.uid !== "number") return undefined;
	const resolveNode = (node) => {
		if (typeof node === "number") return isPlainRecord(refs[node]) ? refs[node] : undefined;
		return isPlainRecord(node) ? node : undefined;
	};
	const root = resolveNode(schema.uid);
	if (!root) return undefined;
	return { root, resolveNode };
};

/**
 * 遍历 schema，收集 secret 路径模式与 schema 默认值。
 *
 * secret 判定：`meta.role === "secret"`（密文本身）或 `"credential-ref"`（凭据引用名，
 * 常内嵌账号 id，保守起见同待遇）。命中 secret 的节点**不再下钻**（整棵子树即 secret）。
 *
 * 路径里的 `*` 表示 dict 键或数组下标（schema 不知道具体键）。
 * 注意宿主 `describe()` 的 schema 已过 `plainSchema()`：secret 节点的 `meta.default`
 * 被删掉，其余节点保留（且其 default 已被 `redactSecrets` 处理过）。
 */
const scanSchema = (parsed) => {
	const secretPatterns = [];
	const defaults = new Map(); // JSON.stringify(pattern) → default
	const seen = new Set();
	const walk = (node, pattern, depth) => {
		if (!node || depth > MAX_DEPTH) return;
		const uid = typeof node.uid === "number" ? node.uid : undefined;
		const guard = `${pattern.join("\u0000")}|${uid ?? "inline"}`;
		if (seen.has(guard)) return;
		seen.add(guard);
		const role = node?.meta?.role;
		if (role === "secret" || role === "credential-ref") {
			secretPatterns.push([...pattern]);
			return;
		}
		if (Object.hasOwn(node?.meta ?? {}, "default")) {
			defaults.set(JSON.stringify(pattern), node.meta.default);
		}
		const dict = isPlainRecord(node?.dict) ? node.dict : undefined;
		if (dict) {
			for (const [key, child] of Object.entries(dict)) {
				walk(parsed.resolveNode(child), [...pattern, key], depth + 1);
			}
		}
		if (node?.inner !== undefined) {
			walk(parsed.resolveNode(node.inner), [...pattern, "*"], depth + 1);
		}
		if (Array.isArray(node?.list)) {
			// union/intersect：所有分支都算（保守并集），仍按当前路径记录。
			for (const child of node.list) walk(parsed.resolveNode(child), pattern, depth + 1);
		}
	};
	walk(parsed.root, [], 0);
	return { secretPatterns, defaults };
};

// ── 污点判定 / 结构剥离 ──────────────────────────────────────────────────────

/** 路径前缀匹配（pattern 里的 `*` 匹配任意单段）。 */
const patternIsPrefix = (pattern, path) => {
	if (pattern.length > path.length) return false;
	return pattern.every((segment, index) => segment === "*" || segment === path[index]);
};

/** 键名黑名单判定（大小写与分隔符不敏感）。 */
const keyNameDenied = (segment) => {
	const collapsed = String(segment).toLowerCase().replace(/[_\-\s.]/g, "");
	return DENY_KEY_NAMES.has(collapsed);
};

/**
 * 一条具体路径是否**位于 secret 子树内**（祖先规则）。
 *
 * 只做"祖先"方向：P 是 path 的前缀 ⇒ 整个子树移除。反方向（path 是 P 的前缀）**不在这里**
 * 处理——它是"这个字段内含 secret"，属于**投影取舍**（见 `overlapsSecret`），而不是剥离规则。
 * 两者混用会把 `providers` 这样的大对象整棵删掉，反而让白名单里同级的正常字段凭空消失。
 */
const pathInsideSecret = (path, secretPatterns) => {
	if (path.some(keyNameDenied)) return true;
	return secretPatterns.some((pattern) => patternIsPrefix(pattern, path));
};

/**
 * 结构化剥离：从值里删掉所有 secret 污染路径（保留其余结构与数组形状）。
 *
 * 这不是展示通路（白名单叶子单独投影），而是"即便将来白名单加字段也不会顺手带出
 * secret"的第二道保险，也是 `value`/`base`/`user` 三层都要过一遍的原因。
 */
const stripSecretSubtrees = (value, secretPatterns, path = [], depth = 0) => {
	if (depth > MAX_DEPTH) return undefined;
	if (Array.isArray(value)) {
		return value.map((item, index) =>
			pathInsideSecret([...path, String(index)], secretPatterns)
				? null
				: stripSecretSubtrees(item, secretPatterns, [...path, String(index)], depth + 1) ?? null,
		);
	}
	if (isPlainRecord(value)) {
		const out = {};
		for (const [key, item] of Object.entries(value)) {
			const next = [...path, key];
			if (pathInsideSecret(next, secretPatterns)) continue;
			const stripped = stripSecretSubtrees(item, secretPatterns, next, depth + 1);
			if (stripped === undefined) continue;
			out[key] = stripped;
		}
		return out;
	}
	return value;
};

// ── 值擦除（绝对路径 / URL / 凭据 / 连接串） ──────────────────────────────────

/** 擦除失败原因码（稳定代号，**不含原文**；进入响应也不泄露原值）。 */
export const SCRUB_REASON = Object.freeze({
	PATH: "value-with-absolute-path",
	URL: "value-with-url",
	CREDENTIAL: "value-with-credential",
	CONNECTION_STRING: "value-with-connection-string",
	KEY: "value-with-unsafe-key",
	LENGTH: "value-too-long",
	SHAPE: "value-not-scalar",
});

/**
 * 判断一个标量值能不能安全展示。
 *
 * 命中即 fail-closed：**不带原文、也不做部分打码**——部分打码仍可能泄露前缀，
 * 而设计稿要求"宁可不显示，也不透出未擦除值"。
 *
 * @returns `{ok:true, text, kind, ...}` 或 `{ok:false, reason}`
 */
export const scrubScalar = (value) => {
	if (typeof value === "boolean") {
		return { ok: true, text: value ? "true" : "false", kind: "boolean", boolValue: value };
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return { ok: false, reason: SCRUB_REASON.SHAPE };
		return { ok: true, text: String(value), kind: "number", numberValue: value };
	}
	if (typeof value !== "string") return { ok: false, reason: SCRUB_REASON.SHAPE };
	const text = value.trim();
	if (text.length > MAX_VALUE_TEXT) return { ok: false, reason: SCRUB_REASON.LENGTH };
	if (text === "") return { ok: true, text: "", kind: "string" };
	const lower = text.toLowerCase();
	// 1) URL：白名单里不应出现任何端点；一旦出现就整项不显示（userinfo / 主机 / 端口 /
	//    路径都可能是凭据或拓扑）。`scheme://` 形态一律拦。
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return { ok: false, reason: SCRUB_REASON.URL };
	// 2) 连接串形态：`k=v;k=v;…` 至少两对（如 `Server=…;Password=…`）。
	if (/^(?:[A-Za-z][\w.-]*=[^;]*;){2,}/.test(text)) {
		return { ok: false, reason: SCRUB_REASON.CONNECTION_STRING };
	}
	// 3) 绝对路径：POSIX / Home / Windows 盘符 / UNC。
	if (
		text.startsWith("/") ||
		text.startsWith("~/") ||
		text === "~" ||
		/^[A-Za-z]:[\\/]/.test(text) ||
		text.startsWith("\\\\")
	) {
		return { ok: false, reason: SCRUB_REASON.PATH };
	}
	// 4) 形似凭据：已知前缀，或"无分隔符长令牌"（base64/hex/超长单串）。
	//    刻意**不**把 `a-b_c.d` 式标识串（模型名、路由名、预设名）当凭据。
	if (CREDENTIAL_VALUE_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
		return { ok: false, reason: SCRUB_REASON.CREDENTIAL };
	}
	if (
		/^[A-Za-z0-9+/]{32,}={0,2}$/.test(text) ||
		/^[0-9a-fA-F]{32,}$/.test(text) ||
		/^[A-Za-z0-9_-]{40,}$/.test(text)
	) {
		return { ok: false, reason: SCRUB_REASON.CREDENTIAL };
	}
	return { ok: true, text, kind: "string" };
};

/** dict 键 / 数组下标同样要过擦除器：用户可能把预设名写成路径或令牌。 */
const scrubKeySegment = (segment) => {
	const text = String(segment);
	if (!SAFE_KEY_SEGMENT.test(text)) return { ok: false, reason: SCRUB_REASON.KEY };
	if (keyNameDenied(text)) return { ok: false, reason: SCRUB_REASON.KEY };
	const scrubbed = scrubScalar(text);
	if (!scrubbed.ok) return { ok: false, reason: SCRUB_REASON.KEY };
	return { ok: true, text };
};

// ── 分层取值 ────────────────────────────────────────────────────────────────

/**
 * 按白名单路径取值，`*` 展开为具体键。
 *
 * @returns `{ok:true, entries:[{path, value}]}` 或 `{ok:false, reason}`
 */
const collectPathEntries = (value, pattern, path = [], depth = 0) => {
	if (depth > MAX_DEPTH) return { ok: false, reason: "path-too-deep" };
	if (pattern.length === 0) return { ok: true, entries: [{ path, value }] };
	const [head, ...rest] = pattern;
	if (head === "*") {
		if (Array.isArray(value)) {
			if (value.length > MAX_WILDCARD_ITEMS) return { ok: false, reason: "wildcard-overflow" };
			const entries = [];
			for (let index = 0; index < value.length; index += 1) {
				const keyCheck = scrubKeySegment(String(index));
				if (!keyCheck.ok) return { ok: false, reason: keyCheck.reason };
				const next = collectPathEntries(value[index], rest, [...path, String(index)], depth + 1);
				if (!next.ok) return next;
				entries.push(...next.entries);
			}
			return { ok: true, entries };
		}
		if (isPlainRecord(value)) {
			const keys = Object.keys(value);
			if (keys.length > MAX_WILDCARD_ITEMS) return { ok: false, reason: "wildcard-overflow" };
			const entries = [];
			for (const key of keys) {
				const keyCheck = scrubKeySegment(key);
				if (!keyCheck.ok) return { ok: false, reason: keyCheck.reason };
				const next = collectPathEntries(value[key], rest, [...path, key], depth + 1);
				if (!next.ok) return next;
				entries.push(...next.entries);
			}
			return { ok: true, entries };
		}
		return { ok: true, entries: [] };
	}
	if (Array.isArray(value)) {
		// schema 说这里是对象键，实际是数组：形状漂移，不猜。
		return { ok: false, reason: "shape-mismatch" };
	}
	if (!isPlainRecord(value)) return { ok: true, entries: [] };
	if (!Object.hasOwn(value, head)) return { ok: true, entries: [] };
	const keyCheck = scrubKeySegment(head);
	if (!keyCheck.ok) return { ok: false, reason: keyCheck.reason };
	return collectPathEntries(value[head], rest, [...path, head], depth + 1);
};

/** 该具体路径是否出现在 user 覆盖层（决定"用户覆盖"来源标签）。 */
const userLayerHasPath = (user, path) => {
	if (!isPlainRecord(user)) return false;
	let current = user;
	for (const segment of path) {
		if (Array.isArray(current)) {
			const index = Number(segment);
			if (!Number.isInteger(index) || index < 0 || index >= current.length) return false;
			current = current[index];
			continue;
		}
		if (!isPlainRecord(current) || !Object.hasOwn(current, segment)) return false;
		current = current[segment];
	}
	return true;
};

/** 按具体路径取 schema 默认值（回落到带 `*` 的 pattern）。 */
const defaultForPath = (defaults, path) => {
	if (defaults.size === 0) return { known: false };
	const exact = defaults.get(JSON.stringify(path));
	if (exact !== undefined) return { known: true, value: exact };
	for (const [key, value] of defaults) {
		let pattern;
		try {
			pattern = JSON.parse(key);
		} catch {
			continue;
		}
		if (
			Array.isArray(pattern) &&
			pattern.length === path.length &&
			pattern.every((segment, index) => segment === "*" || segment === path[index])
		) {
			return { known: true, value };
		}
	}
	return { known: false };
};

/**
 * 取某一层（value/base）在给定路径上的标量，并**当场擦除**。
 *
 * @returns `{ok:true, text, absent:boolean}` 或 `{ok:false, reason}`
 */
const scrubLayerValue = (layer, path) => {
	const collected = collectPathEntries(layer, path);
	if (!collected.ok) return { ok: false, reason: collected.reason ?? "path-expand-failed" };
	if (collected.entries.length === 0) return { ok: true, absent: true };
	const raw = collected.entries[0].value;
	const scrubbed = scrubScalar(raw);
	if (!scrubbed.ok) return { ok: false, reason: scrubbed.reason };
	// `raw` 只用于**来源判定**（与 schema 默认值原样比较），不进入响应。
	return { ok: true, absent: false, text: scrubbed.text, raw };
};

// ── 来源判定（只给语义标签，不给原始路径） ────────────────────────────────────

/**
 * 来源：
 *   - `user`    用户覆盖（user 层含该路径）；
 *   - `base`    组合默认（base 层有值且与 schema 默认不同）；
 *   - `default` schema 默认；
 *   - `unknown` base/user 层**缺失**（不是"空"）→ 不猜。
 *
 * "层存在但值为空"与"层根本不存在"必须分开：`describe()` 在 0.2.x 上总是给出
 * `base`/`user` 键（值可能是 undefined，表示该层没有内容），旧宿主才会缺键。
 */
const sourceOfPath = ({ path, baseRaw, hasBaseLayer, hasUserLayer, user, schemaDefault }) => {
	if (!hasBaseLayer || !hasUserLayer) return "unknown";
	if (userLayerHasPath(user, path)) return "user";
	// 与 schema 默认**原样**比较：擦除后是展示字符串，拿它比数字/布尔会永远"不同"。
	if (baseRaw !== undefined && (!schemaDefault.known || !sameJson(baseRaw, schemaDefault.value))) return "base";
	return "default";
};

// ── 单个命名空间投影 ────────────────────────────────────────────────────────

const namespaceError = (entries, reason) => ({
	ns: entries[0].ns,
	title: entries[0].namespaceTitle,
	titleEn: entries[0].namespaceTitleEn,
	groupId: entries[0].group,
	revision: null,
	complete: false,
	reason,
	fields: [],
});

/**
 * 把一个命名空间投影成白名单字段列表。
 *
 * @param {object|undefined} row `describe({redactSecrets:true})` 的一行
 * @param {ReadonlyArray<object>} entries 该命名空间的白名单条目
 * @param {{ok:boolean, reason?:string, value?:unknown}} strictRead 严格读取器结果
 */
const projectNamespace = (row, entries, strictRead) => {
	const fail = (reason) => namespaceError(entries, reason);
	if (!strictRead.ok) return fail(strictRead.reason ?? "settings-unreadable");
	if (!isPlainRecord(row)) return fail("settings-descriptor-invalid");

	const parsed = parseSchemaEnvelope(row.schema);
	if (!parsed) return fail("schema-unparsable");
	let secretPatterns;
	let defaults;
	try {
		const scanned = scanSchema(parsed);
		secretPatterns = scanned.secretPatterns;
		defaults = scanned.defaults;
	} catch {
		return fail("schema-unparsable");
	}

	// "层存在"以**键存在**为准（值可能是 undefined），与"旧宿主缺键"区分开。
	const hasBaseLayer = Object.hasOwn(row, "base");
	const hasUserLayer = Object.hasOwn(row, "user");

	let value;
	let base;
	let user;
	try {
		value = stripSecretSubtrees(row.value, secretPatterns);
		base = hasBaseLayer ? stripSecretSubtrees(row.base, secretPatterns) : undefined;
		user = hasUserLayer ? stripSecretSubtrees(row.user, secretPatterns) : undefined;
	} catch {
		return fail("redaction-failed");
	}
	if (!isPlainRecord(value)) return fail("settings-value-invalid");

	// describe 已剥过 secret，但仍按 schema 收集槽位的 set 状态，供"已设置/未设置"。
	const secretStates = new Map();
	for (const item of Array.isArray(row.secrets) ? row.secrets : []) {
		if (!isPlainRecord(item) || !Array.isArray(item.path)) continue;
		secretStates.set(JSON.stringify(item.path.map(String)), item.set === true);
	}

	const fields = [];
	for (const entry of entries) {
		const pattern = entry.path;
		const exactSecret = secretPatterns.some((secret) => {
			if (secret.length !== pattern.length) return false;
			return secret.every((segment, index) => segment === "*" || segment === pattern[index]);
		});
		// 祖先/后代关系一律不投影：祖先会把 secret 子树当普通值展开，后代则拿不到
		// 正确槽位。两者都 fail-closed，不猜。
		const overlapsSecret = secretPatterns.some(
			(secret) => patternIsPrefix(secret, pattern) || patternIsPrefix(pattern, secret),
		);
		if (exactSecret) {
			const set = secretStates.get(JSON.stringify(pattern.map(String)));
			if (set === undefined) return fail("secret-slot-missing");
			fields.push({
				ns: entry.ns,
				groupId: entry.group,
				title: entry.title,
				titleEn: entry.titleEn,
				keyPath: pattern.join("."),
				kind: "secret",
				secretSet: set,
				source: "unknown",
				defaultText: null,
				baseText: null,
				layers: { user: null, base: null, schema: false },
			});
			continue;
		}
		if (overlapsSecret) return fail("field-overlaps-secret");

		const collected = collectPathEntries(value, pattern);
		if (!collected.ok) return fail(collected.reason ?? "path-expand-failed");
		for (const found of collected.entries) {
			if (fields.length >= MAX_FIELDS_PER_NAMESPACE) return fail("too-many-fields");
			const scrubbed = scrubScalar(found.value);
			if (!scrubbed.ok) return fail(scrubbed.reason);
			const baseLayer = hasBaseLayer ? scrubLayerValue(base, found.path) : { ok: true, absent: true };
			if (!baseLayer.ok) return fail(baseLayer.reason);
			const schemaDefault = defaultForPath(defaults, found.path);
			let defaultText = null;
			if (schemaDefault.known && schemaDefault.value !== undefined) {
				const scrubbedDefault = scrubScalar(schemaDefault.value);
				// 默认值层同样过擦除器 —— 这一条专治"从默认值旁路泄露"。
				if (!scrubbedDefault.ok) return fail(scrubbedDefault.reason);
				defaultText = scrubbedDefault.text;
			}
			const baseText = baseLayer.absent ? null : baseLayer.text;
			const source = sourceOfPath({
				path: found.path,
				baseRaw: baseLayer.raw,
				hasBaseLayer,
				hasUserLayer,
				user,
				schemaDefault,
			});
			fields.push({
				ns: entry.ns,
				groupId: entry.group,
				title: entry.title,
				titleEn: entry.titleEn,
				keyPath: found.path.join("."),
				kind: "value",
				valueText: scrubbed.text,
				valueKind: scrubbed.kind,
				...(scrubbed.kind === "boolean" ? { boolValue: scrubbed.boolValue === true } : {}),
				...(scrubbed.kind === "number" ? { numberValue: scrubbed.numberValue } : {}),
				defaultText,
				baseText,
				hasDefault: defaultText !== null,
				source,
				layers: {
					user: hasUserLayer ? userLayerHasPath(user, found.path) : null,
					base: hasBaseLayer ? baseText !== null : null,
					schema: schemaDefault.known && schemaDefault.value !== undefined,
				},
			});
		}
	}

	return {
		ns: entries[0].ns,
		title: entries[0].namespaceTitle,
		titleEn: entries[0].namespaceTitleEn,
		groupId: entries[0].group,
		revision: typeof row.revision === "number" ? row.revision : null,
		complete: true,
		reason: "",
		fields,
	};
};

// ── 端点级投影 ──────────────────────────────────────────────────────────────

/** 把白名单按 namespace 分组，保持首次出现顺序。 */
const groupWhitelistByNamespace = () => {
	const order = [];
	const byNs = new Map();
	for (const entry of HOST_SETTINGS_WHITELIST) {
		if (!byNs.has(entry.ns)) {
			byNs.set(entry.ns, []);
			order.push(entry.ns);
		}
		byNs.get(entry.ns).push(entry);
	}
	return order.map((ns) => byNs.get(ns));
};

/**
 * 构造 `/m/api/host-settings` 的响应体（**只读、只含白名单项**）。
 *
 * 降级形状（全部 HTTP 200，App 据此区分"不支持/部分可见"，不是网络失败）：
 *   - 没有 settings 服务 / 没有 describe / describe 抛错或形状漂移：`supported:false` + `reason`；
 *   - 白名单为空：`supported:false` + `reason:"whitelist-empty"`；
 *   - 单个命名空间失败：该命名空间 `complete:false` + `reason`，`fields` 为空数组；
 *   - 任一命名空间失败：`complete:false`（页面级提示"部分设置不可用"）。
 *   - 命名空间在本宿主上不存在：整段省略（白名单项不可见，不算错误）。
 *
 * @param {object} input
 * @param {object|undefined} input.settings 宿主 settings 服务（`ctx.get("settings")`）
 * @param {(settings: object, ns: string) => {ok: boolean, value?: unknown, reason?: string}} input.readSection
 *   既有严格读取器 `readSettingsSectionStrict`（由调用方注入，避免循环依赖）
 * @param {() => string} [input.hostVersion] DSH 版本（取不到就是空串，不猜）
 * @param {() => string} [input.pluginVersion] 本插件版本
 * @param {() => string} [input.now] 时间戳（测试可注入）
 */
export const buildHostSettingsView = ({
	settings,
	readSection,
	hostVersion,
	pluginVersion,
	now,
} = {}) => {
	const generatedAt = typeof now === "function" ? now() : new Date().toISOString();
	const shell = {
		ok: true,
		supported: true,
		complete: true,
		reason: "",
		writable: false,
		whitelistVersion: HOST_SETTINGS_WHITELIST_VERSION,
		generatedAt,
		// 主机事实（不是设置项）：只给版本串，不给地址、路径、主机名。
		host: {
			dshVersion: typeof hostVersion === "function" ? String(hostVersion() ?? "") : "",
			pluginVersion: typeof pluginVersion === "function" ? String(pluginVersion() ?? "") : "",
		},
		groups: HOST_SETTINGS_GROUPS.map((group) => ({ ...group })),
		namespaces: [],
	};
	if (hostSettingsWhitelistIsEmpty()) {
		return { ...shell, supported: false, complete: false, reason: "whitelist-empty" };
	}
	if (!settings) {
		return { ...shell, supported: false, complete: false, reason: "settings-service-missing" };
	}
	// 0.1.x 只有 `get(ns)`：拿不到 base/user/secrets/schema，无法保证三层脱敏 →
	// 整页降级，不退回"只给 value"的半吊子实现。
	if (typeof settings.describe !== "function") {
		return { ...shell, supported: false, complete: false, reason: "settings-describe-unavailable" };
	}
	if (typeof readSection !== "function") {
		return { ...shell, supported: false, complete: false, reason: "settings-reader-missing" };
	}
	let rows;
	try {
		rows = settings.describe({ redactSecrets: true });
	} catch {
		return { ...shell, supported: false, complete: false, reason: "settings-describe-threw" };
	}
	if (!Array.isArray(rows)) {
		return { ...shell, supported: false, complete: false, reason: "settings-describe-shape-invalid" };
	}
	const rowByNs = new Map();
	for (const row of rows) {
		if (isPlainRecord(row) && typeof row.ns === "string") rowByNs.set(row.ns, row);
	}

	const namespaces = [];
	const failures = [];
	for (const entries of groupWhitelistByNamespace()) {
		const ns = entries[0].ns;
		let strictRead;
		try {
			strictRead = readSection(settings, ns);
		} catch {
			strictRead = { ok: false, reason: "settings-reader-threw" };
		}
		if (!isPlainRecord(strictRead) || typeof strictRead.ok !== "boolean") {
			strictRead = { ok: false, reason: "settings-reader-shape-invalid" };
		}
		if (strictRead.ok && strictRead.value === undefined) {
			// 该命名空间在本宿主上不存在 → 白名单项不可见（不是错误，也不是"关闭"）。
			continue;
		}
		const projected = projectNamespace(rowByNs.get(ns), entries, strictRead);
		if (!projected.complete) failures.push(projected.reason);
		namespaces.push(projected);
	}
	const complete = failures.length === 0;
	return {
		...shell,
		complete,
		// 只回传**稳定原因码**，不回显任何原始值或路径。
		reason: complete ? "" : failures[0],
		namespaces,
	};
};
