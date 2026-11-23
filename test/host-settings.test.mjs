// issue #106：DSH 设置只读查看器的宿主侧契约（白名单 + 三层脱敏）。
//
// 覆盖（安全契约逐条对应）：
//   1. 白名单外字段不返回（含 llm-pi-ai.baseURL / apiKeyEnv / headers、agent-loop.agents[].cwd）；
//   2. 嵌套 secret 全链剔除：任意祖先/后代、数组/映射内，value/base/user **三层**都脱敏；
//   3. "默认值旁路"负例：secret 只出现在 schema 默认值 / base 层时也不得回显；
//   4. 凭据与路径擦除：绝对路径、URL（含 userinfo）、token、连接串一律 fail-closed；
//   5. supported:false 降级（无 settings / 无 describe / describe 抛错或形状漂移 / 白名单空）；
//   6. 只读：非 GET/HEAD → 405（端点级）；响应恒 writable:false。
//
// 夹具形状取自 DSH 0.2.2-rc.5 的实测 `settings.describe({redactSecrets:true})`：
//   schema 是 schemastery `toJSON()` 信封 `{uid, refs}`，`refs` 内用 uid 数字互引用；
//   只有 volatile 字段会出现在信封里（`describe()` 先过 `volatileForm()`）。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let apply;
let buildHostSettingsView;
let testHome;

test.before(async () => {
	testHome = await mkdtemp(join(tmpdir(), "dsh-mobile-host-settings-"));
	process.env.HOME = testHome;
	({ apply } = await import("../lib/index.js"));
	({ buildHostSettingsView } = await import("../lib/host-settings.js"));
});
test.after(async () => { await rm(testHome, { recursive: true, force: true }); });

// ── schema 信封构造器（照抄 schemastery toJSON 的真实形状） ──────────────────
// buildEnvelope(rootUid, refsObject) → { uid, refs }
const envelope = (refs, rootUid) => ({ uid: rootUid, refs });

/**
 * 一个「模型与路由」命名空间夹具：
 *   providers.<route>.displayName / apiKey（secret）/ baseURL / apiKeyEnv（credential-ref）
 *   providers.<route>.headers（dict<string>）
 *   fallback（schema 默认值里藏 secret 的旁路负例）
 */
const modelSchema = () => envelope({
	// .displayName
	1: { type: "string", meta: {} },
	// .apiKey（secret）
	2: { type: "string", meta: { role: "secret" } },
	// .baseURL
	3: { type: "string", meta: {} },
	// .apiKeyEnv（credential-ref：引用名，同样按 secret 对待）
	4: { type: "string", meta: { role: "credential-ref" } },
	// .headers（键名黑名单 dict）
	5: { type: "string", meta: {} },
	6: { type: "dict", meta: {}, inner: 5 },
	// 每个 route profile
	7: {
		type: "object",
		meta: {},
		dict: { displayName: 1, apiKey: 2, baseURL: 3, apiKeyEnv: 4, headers: 6 },
	},
	// providers（volatile dict）
	8: { type: "dict", meta: {}, inner: 7 },
	// 顶层对象
	9: { type: "object", meta: {}, dict: { providers: 8 } },
}, 9);

/** 单命名空间夹具：settings.describe({redactSecrets:true}) 的一行。 */
const row = ({
	ns = "llm-pi-ai",
	schema = modelSchema(),
	value = {},
	base = {},
	user = {},
	secrets = [],
	revision = 3,
	omitLayers = false,
} = {}) => {
	const out = { ns, schema, revision, applies: "live", value, secrets };
	if (!omitLayers) {
		out.base = base;
		out.user = user;
	}
	return out;
};

/** 假 settings 服务：describe 返回给定行。 */
const fakeSettings = (rows, { onDescribe } = {}) => ({
	describe(options) {
		onDescribe?.(options);
		return rows;
	},
});

/** 严格读取器替身：说"读到了"，值与行里的 value 一致（生产用既有 readSettingsSectionStrict）。
 *
 * 注意：**生产读取器会让 describe() 再被调一次**（它自己不带参数地读一遍做存在性判断）；
 * 夹具通过闭包拿 rows，不重复触发 onDescribe，避免把"读取器那次"误当成"投影那次"。
 */
const readSectionOk = (_settings, ns, rows) => {
	const source = rows ?? _settings.describe();
	const found = source.find((r) => r.ns === ns);
	return found ? { ok: true, value: found.value } : { ok: true, value: undefined };
};
const readSectionThrows = () => { throw new Error("boom"); };
const readSectionUnreadable = () => ({ ok: false, reason: "settings-describe-threw" });

const view = (rows, overrides = {}) => buildHostSettingsView({
	settings: fakeSettings(rows, overrides.fakeOptions),
	// 夹具固定用闭包里的 rows，避免读取器自己那次 describe() 影响 onDescribe 计数。
	readSection: overrides.readSection ?? ((_settings, ns) => readSectionOk(_settings, ns, rows)),
	hostVersion: () => "0.2.2-rc.5",
	pluginVersion: () => "3.3.1-alpha.2",
	now: () => "2026-11-23T00:00:00.000Z",
});

const findNs = (body, ns) => body.namespaces.find((n) => n.ns === ns);
const fieldOf = (body, ns, keyPath) => findNs(body, ns)?.fields.find((f) => f.keyPath === keyPath);

// ── 1. 白名单外不返回 ───────────────────────────────────────────────────────

test("白名单外字段不返回：llm-pi-ai 的 baseURL / apiKeyEnv / headers 一律不出现", () => {
	const body = view([row({
		value: {
			providers: {
				"opencode-go": {
					displayName: "Opencode-HomePC",
					apiKey: "sk-live-SECRET-abcdef123456",
					baseURL: "https://user:pw@gateway.internal:8443/v1",
					apiKeyEnv: "DSH_OPENCODE_GO_ACCOUNT_28EEB7E8",
					headers: { authorization: "Bearer tok_abcdef" },
				},
			},
		},
	})]);
	assert.equal(body.ok, true);
	assert.equal(body.supported, true);
	assert.equal(body.writable, false, "只读端点恒 writable:false");
	const ns = findNs(body, "llm-pi-ai");
	assert.ok(ns, "白名单内的命名空间应出现");
	assert.equal(ns.complete, true, `命名空间应完整：${ns.reason}`);
	const keys = ns.fields.map((f) => f.keyPath).sort();
	assert.deepEqual(keys, ["providers.opencode-go.defaultContextWindow", "providers.opencode-go.displayName"].filter((k) => keys.includes(k)));
	// 白名单项只有 displayName / defaultContextWindow；后者在 value 里不存在，故只剩 displayName。
	assert.deepEqual(keys, ["providers.opencode-go.displayName"]);
	assert.equal(fieldOf(body, "llm-pi-ai", "providers.opencode-go.displayName").valueText, "Opencode-HomePC");
	// 原始响应里不得出现任何被排除的值
	const raw = JSON.stringify(body);
	for (const forbidden of [
		"sk-live-SECRET",
		"gateway.internal",
		"user:pw",
		"DSH_OPENCODE_GO_ACCOUNT",
		"Bearer tok_abcdef",
		"apiKeyEnv",
		"baseURL",
		"headers",
	]) {
		assert.equal(raw.includes(forbidden), false, `响应不得包含 ${forbidden}`);
	}
});

test("白名单外命名空间整段不返回（agent-default-model 之外的自由配置不出现）", () => {
	const body = view([
		row({
			ns: "llm-openai-codex",
			schema: envelope({ 1: { type: "object", meta: {}, dict: {} } }, 1),
			value: { proxyUrl: "http://192.168.50.33:1088", models: ["gpt-6-astra"] },
		}),
	]);
	assert.equal(findNs(body, "llm-openai-codex"), undefined, "不在白名单的命名空间不得出现");
	assert.equal(body.namespaces.length, 0, "没有可投影的命名空间时不伪造");
	assert.equal(body.supported, true);
	assert.equal(body.complete, true);
});

// ── 2. 嵌套 secret 全链剔除（含数组/映射，三层） ─────────────────────────────

test("嵌套 secret：数组内对象字段也是 secret 时，整个命名空间不得泄漏该值", () => {
	// providers.models[] 里带 secret：白名单没有列它，但祖先/后代判定必须能识别。
	const schema = envelope({
		1: { type: "string", meta: {} },
		2: { type: "string", meta: { role: "secret" } },
		3: { type: "object", meta: {}, dict: { id: 1, token: 2 } },
		4: { type: "array", meta: {}, inner: 3 },
		5: { type: "object", meta: {}, dict: { models: 4 } },
	}, 5);
	const body = view([row({
		ns: "llm-pi-ai",
		schema,
		value: { models: [{ id: "gpt-6", token: "sk-array-secret-999999" }] },
		base: { models: [{ id: "gpt-6", token: "sk-base-secret-888888" }] },
		user: { models: [{ id: "gpt-6", token: "sk-user-secret-777777" }] },
		secrets: [{ path: ["models", "0", "token"], set: true }],
	})]);
	const raw = JSON.stringify(body);
	for (const forbidden of ["sk-array-secret", "sk-base-secret", "sk-user-secret"]) {
		assert.equal(raw.includes(forbidden), false, `数组内 secret 不得出现：${forbidden}`);
	}
});

test("secret 字段只显示 set 状态，永不带值/长度/前缀", () => {
	const body = view([row({
		ns: "web-search-deepseek",
		schema: envelope({
			1: { type: "string", meta: { role: "secret" } },
			2: { type: "string", meta: {} },
			3: { type: "number", meta: { step: 1 } },
			4: { type: "object", meta: {}, dict: { apiKey: 1, model: 2, maxUses: 3 } },
		}, 4),
		value: { model: "deepseek-v4-flash", maxUses: 5 },
		secrets: [{ path: ["apiKey"], set: true }],
	})]);
	const secret = fieldOf(body, "web-search-deepseek", "apiKey");
	assert.ok(secret, "secret 槽位应作为一行的形式出现");
	assert.equal(secret.kind, "secret");
	assert.equal(secret.secretSet, true);
	assert.equal(secret.valueText, undefined, "secret 不得有 valueText");
	assert.equal(secret.defaultText, null, "secret 不得有默认值");
	assert.equal(fieldOf(body, "web-search-deepseek", "model").valueText, "deepseek-v4-flash");
	assert.equal(fieldOf(body, "web-search-deepseek", "maxUses").valueText, "5");
	const raw = JSON.stringify(secret);
	assert.equal(/secret-set|已设置/.test(raw), false, "响应只给布尔 set 状态，不给展示文案");
});

test("secret 未设置：set:false 如实给出（不得渲染成「关闭」以外的值）", () => {
	const body = view([row({
		ns: "web-search-deepseek",
		schema: envelope({
			1: { type: "string", meta: { role: "secret" } },
			2: { type: "object", meta: {}, dict: { apiKey: 1 } },
		}, 2),
		value: {},
		secrets: [{ path: ["apiKey"], set: false }],
	})]);
	assert.equal(fieldOf(body, "web-search-deepseek", "apiKey").secretSet, false);
});

test("secret 槽位缺失（宿主形状漂移）→ 整个命名空间 fail-closed，不把「不知道」当「未设置」", () => {
	const body = view([row({
		ns: "web-search-deepseek",
		schema: envelope({
			1: { type: "string", meta: { role: "secret" } },
			2: { type: "object", meta: {}, dict: { apiKey: 1 } },
		}, 2),
		value: {},
		secrets: [], // 槽位丢了
	})]);
	const ns = findNs(body, "web-search-deepseek");
	assert.equal(ns.complete, false);
	assert.equal(ns.reason, "secret-slot-missing");
	assert.deepEqual(ns.fields, [], "fail-closed 时不返回任何字段（不给半份）");
	assert.equal(body.complete, false);
});

// ── 3. 「默认值旁路」负例 ───────────────────────────────────────────────────

test("默认值旁路：secret 只出现在 schema 默认值时也不得回显", () => {
	// schema 里 non-secret 字段的默认值本身是路径/URL —— 必须在 defaultText 前就被擦除。
	const schema = envelope({
		1: { type: "string", meta: { default: "/home/mark/.ssh/id_ed25519" } },
		2: { type: "string", meta: { default: "https://admin:hunter2@nas.local/api" } },
		3: { type: "object", meta: {}, dict: { a: 1, b: 2 } },
	}, 3);
	const body = view([row({
		ns: "web-search-deepseek",
		schema: {
			...schema,
			refs: { ...schema.refs, 3: { type: "object", meta: {}, dict: { model: 1, base: 2 } } },
		},
		value: { model: "deepseek-v4-flash", base: "deepseek" },
	})]);
	const ns = findNs(body, "web-search-deepseek");
	assert.equal(ns.complete, false, "默认值含路径/凭据时必须整段 fail-closed");
	assert.equal(ns.reason, "value-with-absolute-path");
	assert.deepEqual(ns.fields, []);
	const raw = JSON.stringify(body);
	for (const forbidden of ["id_ed25519", "hunter2", "nas.local", "/home/mark"]) {
		assert.equal(raw.includes(forbidden), false, `默认值旁路不得回显：${forbidden}`);
	}
});

test("base 层旁路：secret 只在 base（组合默认）层有值时也不得回显", () => {
	const body = view([row({
		ns: "web-search-deepseek",
		schema: envelope({
			1: { type: "string", meta: {} },
			2: { type: "string", meta: { role: "secret" } },
			3: { type: "object", meta: {}, dict: { model: 1, apiKey: 2 } },
		}, 3),
		value: { model: "deepseek-v4-flash" },
		base: { model: "deepseek-v4-flash", apiKey: "sk-base-layer-leak-111111" },
		user: {},
		secrets: [{ path: ["apiKey"], set: true }],
	})]);
	const raw = JSON.stringify(body);
	assert.equal(raw.includes("sk-base-layer-leak"), false, "base 层 secret 不得回显");
	assert.equal(fieldOf(body, "web-search-deepseek", "apiKey").kind, "secret");
});

test("user 层旁路：user 覆盖里的 secret 同样被剥掉，来源仍判为用户覆盖", () => {
	const body = view([row({
		ns: "web-search-deepseek",
		schema: envelope({
			1: { type: "string", meta: {} },
			2: { type: "string", meta: { role: "secret" } },
			3: { type: "object", meta: {}, dict: { model: 1, apiKey: 2 } },
		}, 3),
		value: { model: "deepseek-v4-pro" },
		base: { model: "deepseek-v4-flash" },
		user: { model: "deepseek-v4-pro", apiKey: "sk-user-layer-leak-222222" },
		secrets: [{ path: ["apiKey"], set: true }],
	})]);
	assert.equal(JSON.stringify(body).includes("sk-user-layer-leak"), false);
	const model = fieldOf(body, "web-search-deepseek", "model");
	assert.equal(model.source, "user", "user 层含该路径 → 用户覆盖");
	assert.equal(model.valueText, "deepseek-v4-pro");
});

test("白名单字段与 secret 互为祖先/后代 → 命名空间 fail-closed（不展开 secret 子树）", () => {
	// 白名单若把整棵 providers 当字段，会连带 apiKey；这里直接验证祖先/后代判定。
	const schema = envelope({
		1: { type: "string", meta: { role: "secret" } },
		2: { type: "object", meta: {}, dict: { apiKey: 1 } },
		3: { type: "dict", meta: {}, inner: 2 },
		4: { type: "object", meta: {}, dict: { providers: 3 } },
	}, 4);
	const body = view([row({
		ns: "llm-pi-ai",
		schema,
		value: { providers: { r: { apiKey: "sk-never-show-333333" } } },
		secrets: [{ path: ["providers", "r", "apiKey"], set: true }],
	})]);
	assert.equal(JSON.stringify(body).includes("sk-never-show"), false);
	// displayName/defaultContextWindow 在 value 里不存在 → 无字段；命名空间仍 complete。
	const ns = findNs(body, "llm-pi-ai");
	assert.equal(ns.complete, true);
	assert.deepEqual(ns.fields, []);
});

// ── 4. 路径 / 凭据擦除（负例逐个打） ────────────────────────────────────────

const scalarNamespace = (path, title = "值") => ({
	schema: envelope({ 1: { type: "string", meta: {} }, 2: { type: "object", meta: {}, dict: { v: 1 } } }, 2),
	entry: { path: [path], title },
});

test("绝对路径 / URL / 连接串 / 凭据值 → 该命名空间 fail-closed 且不回显原文", () => {
	const cases = [
		["/home/mark/.dsh/auth-token", "value-with-absolute-path"],
		["~/projects/secret.txt", "value-with-absolute-path"],
		["C:\\\\Users\\\\mark\\\\AppData\\\\token", "value-with-absolute-path"],
		["\\\\fileserver\\share\\conf", "value-with-absolute-path"],
		["http://10.0.0.5:8080/admin", "value-with-url"],
		["https://user:pass@host/v1", "value-with-url"],
		["Server=db;User=sa;Password=hunter2", "value-with-connection-string"],
		["sk-proj-abcdefghijklmnopqrstuvwxyz", "value-with-credential"],
		["ghp_abcdefghijklmnopqrstuvwxyz012345", "value-with-credential"],
		["Bearer abcdefghijklmnop", "value-with-credential"],
		["deadbeefdeadbeefdeadbeefdeadbeef", "value-with-credential"],
	];
	for (const [text, reason] of cases) {
		// 用 web-search-deepseek 的 model 槽位承载任意值：只关心擦除结果。
		const body = view([row({
			ns: "web-search-deepseek",
			schema: envelope({
				1: { type: "string", meta: {} },
				2: { type: "object", meta: {}, dict: { model: 1 } },
			}, 2),
			value: { model: text },
		})]);
		const ns = findNs(body, "web-search-deepseek");
		assert.equal(ns.complete, false, `应 fail-closed：${text}`);
		assert.equal(ns.reason, reason, `原因码不符：${text}`);
		assert.deepEqual(ns.fields, [], `fail-closed 时不返回字段：${text}`);
		const raw = JSON.stringify(body);
		assert.equal(raw.includes(text), false, `响应不得回显原文：${text}`);
	}
});

test("正常标识串 / 数字 / 布尔不受擦除器误伤", () => {
	const body = view([
		row({
			ns: "agent-default-model",
			schema: envelope({
				1: { type: "string", meta: {} },
				2: { type: "string", meta: {} },
				3: { type: "string", meta: {} },
				4: { type: "object", meta: {}, dict: { provider: 1, model: 2, reasoningEffort: 3 } },
			}, 4),
			value: { provider: "opencode-go", model: "deepseek-v4.1-flash", reasoningEffort: "max" },
		}),
		row({
			ns: "subagent",
			schema: envelope({
				1: { type: "number", meta: { step: 1, default: 1 } },
				2: { type: "number", meta: { step: 1, default: 8 } },
				3: { type: "object", meta: {}, dict: { maxDepth: 1, maxActiveSubagents: 2 } },
			}, 3),
			value: { maxDepth: 2, maxActiveSubagents: 8 },
		}),
	]);
	const model = findNs(body, "agent-default-model");
	assert.equal(model.complete, true);
	assert.equal(fieldOf(body, "agent-default-model", "model").valueText, "deepseek-v4.1-flash");
	assert.equal(fieldOf(body, "agent-default-model", "provider").valueText, "opencode-go");
	const sub = findNs(body, "subagent");
	assert.equal(sub.complete, true);
	assert.equal(fieldOf(body, "subagent", "maxDepth").valueText, "2");
	assert.equal(fieldOf(body, "subagent", "maxDepth").valueKind, "number");
	assert.equal(fieldOf(body, "subagent", "maxActiveSubagents").valueText, "8");
});

test("dict 键被写成路径/凭据时 fail-closed（键名同样过擦除器）", () => {
	const body = view([row({
		ns: "llm-pi-ai",
		schema: envelope({
			1: { type: "string", meta: {} },
			2: { type: "object", meta: {}, dict: { displayName: 1 } },
			3: { type: "dict", meta: {}, inner: 2 },
			4: { type: "object", meta: {}, dict: { providers: 3 } },
		}, 4),
		value: { providers: { "/etc/passwd": { displayName: "x" } } },
	})]);
	const ns = findNs(body, "llm-pi-ai");
	assert.equal(ns.complete, false);
	assert.equal(ns.reason, "value-with-unsafe-key");
	assert.equal(JSON.stringify(body).includes("/etc/passwd"), false);
});

// ── 5. 来源判定 ────────────────────────────────────────────────────────────

test("来源四态：用户覆盖 / 组合默认 / 默认值 / 未知（旧宿主缺 base+user 层）", () => {
	const schema = envelope({
		1: { type: "string", meta: { default: "flash" } },
		2: { type: "object", meta: {}, dict: { model: 1 } },
	}, 2);
	const userOverride = view([row({
		ns: "web-search-deepseek", schema,
		value: { model: "pro" }, base: { model: "flash" }, user: { model: "pro" },
	})]);
	assert.equal(fieldOf(userOverride, "web-search-deepseek", "model").source, "user");

	const composed = view([row({
		ns: "web-search-deepseek", schema,
		value: { model: "batch" }, base: { model: "batch" }, user: {},
	})]);
	assert.equal(fieldOf(composed, "web-search-deepseek", "model").source, "base");

	const fromDefault = view([row({
		ns: "web-search-deepseek", schema,
		value: { model: "flash" }, base: { model: "flash" }, user: {},
	})]);
	assert.equal(fieldOf(fromDefault, "web-search-deepseek", "model").source, "default");

	const oldHost = view([row({
		ns: "web-search-deepseek", schema, value: { model: "flash" }, omitLayers: true,
	})]);
	assert.equal(fieldOf(oldHost, "web-search-deepseek", "model").source, "unknown", "缺层时不得猜来源");
});

test("来源判定不被展示字符串污染：数字/布尔型 base 与 schema 默认相等时判 default（回归）", () => {
	// 回归：曾用"擦除后的字符串"与 schema 默认原值比较，`"5" !== 5` 使
	// 「与默认值相同」被误判成「组合默认」。用户会在手机上看到虚假的默认差异。
	// 用白名单里真实存在的字段承载断言：subagent.maxDepth / maxActiveSubagents。
	// 两者 base 都与 schema 默认一致 → 都应判 default。
	const body = view([row({
		ns: "subagent",
		schema: envelope({
			1: { type: "number", meta: { step: 1, default: 5 } },
			2: { type: "number", meta: { step: 1, default: 8 } },
			3: { type: "object", meta: {}, dict: { maxDepth: 1, maxActiveSubagents: 2 } },
		}, 3),
		value: { maxDepth: 5, maxActiveSubagents: 8 },
		base: { maxDepth: 5, maxActiveSubagents: 8 },
		user: {},
	})]);
	assert.equal(fieldOf(body, "subagent", "maxDepth").source, "default",
		"数值 5 与 schema 默认 5 相等，应为默认值而非组合默认");
	assert.equal(fieldOf(body, "subagent", "maxActiveSubagents").source, "default",
		"数值 8 与 schema 默认 8 相等，应为默认值");
});

test("默认值展示：base 与 schema 默认都过擦除器；默认值只在已知时给出", () => {
	const body = view([row({
		ns: "subagent",
		schema: envelope({
			1: { type: "number", meta: { step: 1, default: 1 } },
			2: { type: "number", meta: { step: 1 } },
			3: { type: "object", meta: {}, dict: { maxDepth: 1, maxActiveSubagents: 2 } },
		}, 3),
		value: { maxDepth: 2, maxActiveSubagents: 8 },
		base: { maxDepth: 2, maxActiveSubagents: 8 },
		user: {},
	})]);
	const maxDepth = fieldOf(body, "subagent", "maxDepth");
	assert.equal(maxDepth.defaultText, "1", "schema 默认值应给出");
	assert.equal(maxDepth.hasDefault, true);
	const active = fieldOf(body, "subagent", "maxActiveSubagents");
	assert.equal(active.defaultText, null, "schema 无默认值时不得编造");
	assert.equal(active.hasDefault, false);
});

// ── 6. 降级形状（supported:false 等） ───────────────────────────────────────

test("无 settings 服务 → supported:false + settings-service-missing", () => {
	const body = buildHostSettingsView({ settings: undefined, readSection: readSectionOk });
	assert.equal(body.ok, true, "仍返回 200 形状，不当网络失败");
	assert.equal(body.supported, false);
	assert.equal(body.complete, false);
	assert.equal(body.reason, "settings-service-missing");
	assert.equal(body.writable, false);
	assert.deepEqual(body.namespaces, []);
});

test("旧宿主只有 get(ns)（0.1.x）→ supported:false + settings-describe-unavailable", () => {
	const body = buildHostSettingsView({
		settings: { get: () => ({}) },
		readSection: readSectionOk,
	});
	assert.equal(body.supported, false);
	assert.equal(body.reason, "settings-describe-unavailable");
});

test("describe 抛错 / 返回非数组 / 严格读取器抛错 → 各自稳定 reason", () => {
	const throwing = buildHostSettingsView({
		settings: { describe() { throw new Error("host blew up with /secret/path"); } },
		readSection: readSectionOk,
	});
	assert.equal(throwing.supported, false);
	assert.equal(throwing.reason, "settings-describe-threw");
	assert.equal(JSON.stringify(throwing).includes("/secret/path"), false);

	const notArray = buildHostSettingsView({
		settings: { describe: () => ({ namespaces: [] }) },
		readSection: readSectionOk,
	});
	assert.equal(notArray.supported, false);
	assert.equal(notArray.reason, "settings-describe-shape-invalid");
});

test("严格读取器判为读不到 → 该命名空间 fail-closed，其它命名空间不受连坐", () => {
	const body = view([
		row({
			ns: "web-search-deepseek",
			schema: envelope({ 1: { type: "string", meta: {} }, 2: { type: "object", meta: {}, dict: { model: 1 } } }, 2),
			value: { model: "deepseek-v4-flash" },
		}),
	], { readSection: (settings, ns) => (ns === "web-search-deepseek" ? { ok: false, reason: "settings-describe-threw" } : readSectionOk(settings, ns)) });
	const broken = findNs(body, "web-search-deepseek");
	assert.equal(broken.complete, false);
	assert.equal(broken.reason, "settings-describe-threw");
	assert.deepEqual(broken.fields, []);
	assert.equal(body.complete, false, "任一命名空间失败则 complete:false");
});

test("命名空间在本宿主不存在 → 整段省略（不是错误，也不是「关闭」）", () => {
	const body = view([]);
	assert.equal(body.supported, true);
	assert.equal(body.complete, true);
	assert.deepEqual(body.namespaces, [], "不存在的命名空间不返回空壳");
});

test("schema 不可解析 → fail-closed（不猜 schema）", () => {
	const body = view([row({ ns: "web-search-deepseek", schema: { uid: "nope" }, value: {} })]);
	const ns = findNs(body, "web-search-deepseek");
	assert.equal(ns.complete, false);
	assert.equal(ns.reason, "schema-unparsable");
});

test("describe 必须以 redactSecrets:true 调用（不依赖宿主默认值）", () => {
	// 严格读取器自身会**不带参数**再调一次 describe()（拿未脱敏的 value 做存在性判断）；
	// 这里只断言"我们自己那次投影读取"带了 redactSecrets:true。
	const calls = [];
	view([row({ ns: "web-search-deepseek", schema: envelope({ 1: { type: "string", meta: {} }, 2: { type: "object", meta: {}, dict: { model: 1 } } }, 2), value: { model: "x" } })], {
		fakeOptions: { onDescribe: (options) => { calls.push(options); } },
	});
	assert.ok(calls.length >= 1);
	assert.equal(calls[0]?.redactSecrets, true, "首次投影读取必须显式要求脱敏");
});

// ── 7. 端点级：只读（非 GET/HEAD → 405）与形状 ─────────────────────────────

const CONFIG = {
	path: "/m", authToken: "1234567890123456", cookieName: "dsh_mobile_token", trustedHosts: [],
	sessionTtlMs: 60_000, rechargeUrl: "https://example.test/top-up", maxConnections: 4,
	warmUpOnStart: false, pushUrls: [], pushCooldownMs: 1, doneGraceMs: 1, pushContent: "minimal",
	rateLimit: {}, lanBridge: { enabled: false, port: 3080, host: "127.0.0.1" }, approvalMode: "mobile",
};

class FakeResponse extends EventEmitter {
	constructor() { super(); this.headersSent = false; this.chunks = []; }
	writeHead(statusCode, headers) { this.statusCode = statusCode; this.headers = headers; this.headersSent = true; }
	write(chunk) { this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)); return true; }
	end(chunk = "") { if (chunk !== "") this.chunks.push(String(chunk)); this.writableEnded = true; this.emit("finish"); }
	destroy() { this.destroyed = true; this.emit("close"); }
}
class FakeRequest extends EventEmitter {
	constructor(url, method = "GET") {
		super(); this.url = url; this.method = method;
		this.headers = { host: "127.0.0.1", "x-mobile-token": CONFIG.authToken };
		this.socket = { remoteAddress: "127.0.0.1" }; this.complete = true; this.readable = true; this.destroyed = false;
	}
	on() { return this; } pause() {}
}

/** 端点级夹具：settings 服务挂给定行。 */
function createHarness(rows) {
	const routes = [];
	const settings = fakeSettings(rows);
	const provided = new Map([["settings", settings]]);
	const ctx = {
		webServer: { host: "127.0.0.1", port: 43130, register(spec) { routes.push(spec); return () => {}; } },
		logger: { warn() {}, info() {}, debug() {} },
		get(name) { return provided.get(name); },
		provide(name, value) { provided.set(name, value); },
		on() { return () => {}; },
		effect(callback) { const d = callback?.(); return typeof d === "function" ? d : () => {}; },
		inject() {},
	};
	const dispose = apply(ctx, CONFIG, {});
	return { route: routes.find((r) => r.path === "/m/api").handler, clean() { dispose?.(); }, settings };
}

async function call(route, url = "/m/api/host-settings", method = "GET") {
	const req = new FakeRequest(url, method);
	const res = new FakeResponse();
	const finished = new Promise((resolve) => res.once("finish", resolve));
	route(req, res);
	await finished;
	const raw = res.chunks.join("");
	let body;
	try { body = JSON.parse(raw); } catch { body = raw; }
	return { status: res.statusCode, body, raw };
}

test("端点：GET 返回白名单投影 + writable:false + 版本段", async () => {
	const h = createHarness([row({
		ns: "agent-default-model",
		schema: envelope({
			1: { type: "string", meta: {} },
			2: { type: "string", meta: {} },
			3: { type: "string", meta: {} },
			4: { type: "object", meta: {}, dict: { provider: 1, model: 2, reasoningEffort: 3 } },
		}, 4),
		value: { provider: "workbuddy", model: "deepseek-v4.1-flash", reasoningEffort: "max" },
		base: { provider: "workbuddy", model: "deepseek-v4.1-flash" },
		user: {},
	})]);
	const { status, body } = await call(h.route);
	h.clean();
	assert.equal(status, 200);
	assert.equal(body.ok, true);
	assert.equal(body.supported, true);
	assert.equal(body.writable, false);
	assert.equal(body.whitelistVersion, 1);
	assert.equal(typeof body.generatedAt, "string");
	assert.ok(Array.isArray(body.groups) && body.groups.length > 0);
	const ns = body.namespaces.find((n) => n.ns === "agent-default-model");
	assert.ok(ns, "端点应返回默认模型命名空间");
	assert.equal(ns.fields.find((f) => f.keyPath === "model").valueText, "deepseek-v4.1-flash");
});

test("端点只读：POST/PUT/DELETE/PATCH 一律 405 method-not-allowed", async () => {
	const h = createHarness([]);
	for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
		const { status, body } = await call(h.route, "/m/api/host-settings", method);
		assert.equal(status, 405, `${method} 必须 405`);
		assert.equal(body.error, "method-not-allowed");
	}
	h.clean();
});

test("端点：HEAD 返回 200 且无 body", async () => {
	const h = createHarness([]);
	const { status, raw } = await call(h.route, "/m/api/host-settings", "HEAD");
	h.clean();
	assert.equal(status, 200);
	assert.equal(raw, "");
});

test("端点：没有 settings 服务 → 200 + supported:false（旧宿主明确降级）", async () => {
	const routes = [];
	const ctx = {
		webServer: { host: "127.0.0.1", port: 43130, register(spec) { routes.push(spec); return () => {}; } },
		logger: { warn() {}, info() {}, debug() {} },
		get() { return undefined; },
		provide() {},
		on() { return () => {}; },
		effect(callback) { const d = callback?.(); return typeof d === "function" ? d : () => {}; },
		inject() {},
	};
	const dispose = apply(ctx, CONFIG, {});
	const route = routes.find((r) => r.path === "/m/api").handler;
	const { status, body } = await call(route);
	dispose?.();
	assert.equal(status, 200, "旧宿主不是 404/500");
	assert.equal(body.supported, false);
	assert.equal(body.reason, "settings-service-missing");
	assert.equal(body.writable, false);
});

test("端点：真正的 settings.describe{redactSecrets} 实测形状（volatileForm 过滤后）可投影", async () => {
	// 这一条用 schemastery 真造 schema，验证我们对 toJSON 信封的解析与真实形状一致。
	const z = (await import("@deepseek-ai/schemastery")).default;
	const schema = z.object({
		provider: z.string().required().volatile(),
		model: z.string().required().volatile(),
		reasoningEffort: z.string().volatile(),
		apiKey: z.string().role("secret").volatile(),
	});
	const serialized = schema.toJSON();
	const h = createHarness([row({
		ns: "agent-default-model",
		schema: serialized,
		value: { provider: "workbuddy", model: "deepseek-v4.1-flash", reasoningEffort: "max" },
		base: { provider: "workbuddy", model: "deepseek-v4.1-flash" },
		user: {},
		secrets: [{ path: ["apiKey"], set: false }],
	})]);
	const { status, body } = await call(h.route);
	h.clean();
	assert.equal(status, 200);
	const ns = body.namespaces.find((n) => n.ns === "agent-default-model");
	assert.equal(ns.complete, true, `真实 schema 应可投影：${ns.reason}`);
	assert.equal(ns.fields.find((f) => f.keyPath === "model").valueText, "deepseek-v4.1-flash");
});

test("端点：不写日志、不回显原始行（值里带路径时 fail-closed 且无原文）", async () => {
	const h = createHarness([row({
		ns: "agent-default-model",
		schema: envelope({
			1: { type: "string", meta: {} },
			2: { type: "object", meta: {}, dict: { provider: 1 } },
		}, 2),
		value: { provider: "/home/mark/.dsh/mobile-remote/auth-token" },
	})]);
	const { status, body, raw } = await call(h.route);
	h.clean();
	assert.equal(status, 200);
	assert.equal(body.complete, false);
	assert.equal(raw.includes("auth-token"), false, "绝对路径不得进入响应");
	assert.equal(raw.includes("/home/mark"), false);
});
