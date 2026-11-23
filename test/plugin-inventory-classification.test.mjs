// issue #153：插件三分类（内置 / 实验性 / 自定义）+ HIDDEN 过滤 + 分类表对账。
//
// 分类事实由宿主判定（App 只渲染）：这里覆盖谓词优先级、降级写死原因、
// 静态表命中、HIDDEN 标记、根级 classification 与 `source` 形状不变。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	EXPERIMENTAL_BUNDLES,
	EXPERIMENTAL_TABLE_VERSION,
	EXPERIMENTAL_TARGET_DSH,
	HIDDEN_BUNDLES,
	classifyPluginBundle,
	dshCoreVersion,
	experimentalTableMatches,
	isHiddenBundle,
} from "../lib/experimental-bundles.js";

let apply;
let testHome;
let restoreAnchor = null;

test.before(async () => {
	testHome = await mkdtemp(join(tmpdir(), "dsh-mobile-plugin-classify-"));
	process.env.HOME = testHome;
	({ apply } = await import("../lib/index.js"));
});
test.after(async () => {
	if (restoreAnchor !== null) await writeFile(restoreAnchor, '{"name":"@deepseek-ai/dsh-app-boot","version":"0.2.2","type":"module"}\n', "utf8").catch(() => {});
	await rm(testHome, { recursive: true, force: true });
});

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

/** `profileContext.installAnchor` 指向真实存在的 package.json：用它控制“当前 DSH 版本”。 */
async function harnessWithDshVersion(version) {
	const anchor = join(testHome, `anchor-${version.replace(/[^0-9A-Za-z.-]/g, "_")}`, "package.json");
	await rm(join(testHome, "anchor"), { recursive: true, force: true }).catch(() => {});
	const { mkdir } = await import("node:fs/promises");
	await mkdir(join(anchor, ".."), { recursive: true });
	await writeFile(anchor, `${JSON.stringify({ name: "@deepseek-ai/dsh-app-boot", version })}\n`, "utf8");
	restoreAnchor = anchor;
	return anchor;
}

function createHarness({ pluginManager, pluginInventory, profileContext } = {}) {
	const routes = [];
	const provided = new Map([["sessions", { get: () => undefined, list: () => [] }]]);
	if (pluginManager !== undefined) provided.set("pluginManager", pluginManager);
	if (pluginInventory !== undefined) provided.set("pluginInventory", pluginInventory);
	if (profileContext !== undefined) provided.set("profileContext", profileContext);
	const ctx = {
		webServer: { host: "127.0.0.1", port: 43150, register(spec) { routes.push(spec); return () => {}; } },
		logger: { warn() {}, info() {} },
		get(name) { return provided.get(name); },
		provide(name, value) { provided.set(name, value); },
		on() { return () => {}; },
		effect(callback) { const d = callback?.(); return typeof d === "function" ? d : () => {}; },
		inject() {},
	};
	const dispose = apply(ctx, CONFIG);
	return { route: routes.find((r) => r.path === "/m/api").handler, clean() { dispose?.(); } };
}

async function call(route, url = "/m/api/plugin-inventory", method = "GET") {
	const req = new FakeRequest(url, method);
	const res = new FakeResponse();
	const finished = new Promise((resolve) => res.once("finish", resolve));
	route(req, res);
	await finished;
	const raw = res.chunks.join("");
	let body;
	try { body = JSON.parse(raw); } catch { body = raw; }
	return { status: res.statusCode, body };
}

const bundle = (name, overrides = {}) => ({
	name, version: "1.0.0", enabled: true, official: false, availability: "profile",
	installed: true, optional: false, removable: true, rows: [], overrides: [], ...overrides,
});

// ── 纯函数：谓词与表 ─────────────────────────────────────────────

test("静态表：表版本/目标 DSH 已声明，实验性与隐藏名单非空且不重叠", () => {
	assert.match(EXPERIMENTAL_TABLE_VERSION, /^\d{4}\.\d{2}$/);
	assert.match(EXPERIMENTAL_TARGET_DSH, /^\d+\.\d+\.\d+$/);
	assert.ok(EXPERIMENTAL_BUNDLES.size > 0);
	assert.equal(HIDDEN_BUNDLES.size, 8, "HIDDEN 名单固定 8 项（用户已裁决）");
	// 隐藏项里有实验性包（terminal-bundle / tool-worktree）：两者语义不同，不互斥但要能同时成立。
	for (const name of HIDDEN_BUNDLES) assert.equal(typeof name, "string");
	assert.ok(isHiddenBundle("@deepseek-ai/dsh-base"));
	assert.equal(isHiddenBundle("@marktrue/dsh-mobile-remote"), false);
	assert.equal(isHiddenBundle(""), false);
	assert.equal(isHiddenBundle(undefined), false);
});

test("谓词优先级：experimental 先于 builtin；builtin 先于 custom", () => {
	// 实验性包即使随安装附带（availability=installation）也算实验性。
	assert.deepEqual(
		classifyPluginBundle({ name: "@deepseek-ai/dsh-experimental-tool-worktree", official: true, optional: true, availability: "installation" }),
		{ kind: "experimental", label: "实验性", reason: "" },
	);
	assert.deepEqual(
		classifyPluginBundle({ name: "@deepseek-ai/dsh-web-app", official: false, optional: false, availability: "installation" }),
		{ kind: "builtin", label: "内置", reason: "" },
	);
	assert.deepEqual(
		classifyPluginBundle({ name: "dsh-third-party", official: false, optional: false, availability: "profile" }),
		{ kind: "custom", label: "自定义", reason: "" },
	);
	// official optional 但未命中表 → custom（不按 optional 猜实验性）。
	assert.equal(
		classifyPluginBundle({ name: "@deepseek-ai/dsh-experimental-voice-input-bundle", official: true, optional: true, availability: "profile" }).kind,
		"experimental",
	);
	assert.equal(
		classifyPluginBundle({ name: "@deepseek-ai/dsh-subagent-codex", official: true, optional: true, availability: "profile" }).kind,
		"custom",
	);
});

test("降级写死：official/optional 缺失 → unclassified/host-facts-missing；独立条目 → independent-entry", () => {
	for (const missing of [{ official: null }, { optional: null }, { official: undefined }, { optional: undefined }]) {
		const category = classifyPluginBundle({ name: "@deepseek-ai/dsh-base", availability: "installation", ...missing });
		assert.equal(category.kind, "unclassified", JSON.stringify(missing));
		assert.equal(category.label, "已安装（未分类）");
		assert.equal(category.reason, "host-facts-missing");
	}
	// 独立条目优先于“事实缺失”：原因码必须可区分，不能被 host-facts-missing 掩盖。
	const independent = classifyPluginBundle({ name: "dsh-standalone", independent: true, availability: "profile" });
	assert.equal(independent.kind, "unclassified");
	assert.equal(independent.reason, "independent-entry");
	// 缺失 official 的实验性包名不能被“猜”成实验性。
	assert.equal(classifyPluginBundle({ name: "@deepseek-ai/dsh-experimental-forge-bundle", official: null, optional: false }).kind, "unclassified");
});

test("DSH core 版本比较：prerelease/build 忽略；非法/空 → 不匹配（fail-closed）", () => {
	assert.equal(dshCoreVersion("0.2.2-rc.5"), "0.2.2");
	assert.equal(dshCoreVersion("0.2.2+build.7"), "0.2.2");
	assert.equal(dshCoreVersion(" 0.2.2 "), "0.2.2");
	assert.equal(dshCoreVersion("0.2"), "");
	assert.equal(dshCoreVersion(""), "");
	assert.equal(dshCoreVersion(undefined), "");
	assert.equal(experimentalTableMatches("0.2.2-rc.5"), true);
	assert.equal(experimentalTableMatches("0.2.2"), true);
	assert.equal(experimentalTableMatches("0.3.0"), false);
	assert.equal(experimentalTableMatches(""), false);
});

// ── 端点投影 ───────────────────────────────────────────────────

test("清单行：六个新字段在顶层，且 source 形状不变（不得塞进 source）", async () => {
	const h = createHarness({
		pluginManager: {
			async listBundles() {
				return [
					bundle("@marktrue/dsh-mobile-remote", { version: "3.3.0", official: true, availability: "installation" }),
					bundle("@deepseek-ai/dsh-experimental-auto-review", { official: true, optional: true, availability: "profile" }),
					bundle("@deepseek-ai/dsh-base", { official: false, availability: "installation" }),
					bundle("dsh-third", { official: false, optional: false, availability: "profile", source: "github:foo/bar#0123456789012345678901234567890123456789" }),
				];
			},
		},
		pluginInventory: { async list() { return { entries: [] }; } },
	});
	try {
		const { status, body } = await call(h.route);
		assert.equal(status, 200);
		const byName = new Map(body.plugins.map((p) => [p.packageName, p]));
		for (const plugin of body.plugins) {
			for (const key of ["official", "optional", "availability", "installed", "category", "hidden"]) {
				assert.ok(key in plugin, `${plugin.packageName} 缺顶层字段 ${key}`);
			}
			// source 只保留既有形状：多一个键都会破坏 App 与 deepEqual 断言。
			assert.deepEqual(Object.keys(plugin.source).sort(), ["kind", "label"]);
			assert.deepEqual(Object.keys(plugin.category).sort(), ["kind", "label", "reason"]);
		}
		assert.equal(byName.get("@marktrue/dsh-mobile-remote").category.kind, "builtin");
		assert.equal(byName.get("@marktrue/dsh-mobile-remote").official, true);
		assert.equal(byName.get("@marktrue/dsh-mobile-remote").availability, "installation");
		assert.equal(byName.get("@deepseek-ai/dsh-experimental-auto-review").category.kind, "experimental");
		assert.equal(byName.get("@deepseek-ai/dsh-base").hidden, true);
		assert.equal(byName.get("dsh-third").hidden, false);
		assert.equal(byName.get("dsh-third").category.kind, "custom");
		// 既有 source 投影不变（Git 来源仍是 git）。
		assert.deepEqual(byName.get("dsh-third").source, { kind: "git", label: "Git" });
	} finally { h.clean(); }
});

test("旧宿主 bundle 行缺 official/optional → 全部 unclassified/host-facts-missing，不猜", async () => {
	const h = createHarness({
		pluginManager: {
			async listBundles() {
				return [
					{ name: "dsh-legacy-a", version: "1.0.0", enabled: true, installed: true, availability: "installation" },
					{ name: "dsh-legacy-b", version: "2.0.0", enabled: true, installed: true, availability: "profile" },
				];
			},
		},
		pluginInventory: { async list() { return { entries: [] }; } },
	});
	try {
		const { body } = await call(h.route);
		for (const plugin of body.plugins) {
			assert.equal(plugin.category.kind, "unclassified", plugin.packageName);
			assert.equal(plugin.category.reason, "host-facts-missing", plugin.packageName);
			assert.equal(plugin.official, null);
			assert.equal(plugin.optional, null);
		}
		// availability/installed 仍是宿主事实（旧宿主也可能给）。
		assert.equal(body.plugins.find((p) => p.name === "dsh-legacy-a").availability, "installation");
	} finally { h.clean(); }
});

test("独立配置条目：unclassified/independent-entry，不按包名猜实验性", async () => {
	const h = createHarness({
		pluginManager: { async listBundles() { return []; } },
		pluginInventory: {
			async list() {
				return { entries: [
					{ entryId: "entry-exp", moduleName: "@deepseek-ai/dsh-experimental-forge-bundle", enabled: true, fiberPhase: "active" },
					{ entryId: "entry-plain", moduleName: "dsh-plain", enabled: true, fiberPhase: "active" },
				] };
			},
		},
	});
	try {
		const { body } = await call(h.route);
		assert.equal(body.plugins.length, 2);
		for (const plugin of body.plugins) {
			assert.equal(plugin.independent, true);
			assert.equal(plugin.category.kind, "unclassified");
			assert.equal(plugin.category.reason, "independent-entry");
			assert.equal(plugin.official, null);
			assert.equal(plugin.installed, null);
			assert.equal(plugin.availability, null);
		}
	} finally { h.clean(); }
});

test("可安装行：带 category 与 hidden（Tab 内「可安装」段需要）", async () => {
	const h = createHarness({
		pluginManager: {
			async listBundles() {
				return [
					bundle("@deepseek-ai/dsh-experimental-ralph-bundle", {
						installed: false, availability: "missing", official: true, optional: true,
						installTarget: { spec: "@deepseek-ai/dsh-experimental-ralph-bundle@0.1.0", version: "0.1.0" },
					}),
					bundle("dsh-third-party", {
						installed: false, availability: "missing", official: false, optional: false,
						installTarget: { spec: "dsh-third-party@2.0.0", version: "2.0.0" },
					}),
				];
			},
		},
		pluginInventory: { async list() { return { entries: [] }; } },
	});
	try {
		const { body } = await call(h.route);
		assert.equal(body.installable.length, 2);
		const ralph = body.installable.find((row) => row.name === "@deepseek-ai/dsh-experimental-ralph-bundle");
		const third = body.installable.find((row) => row.name === "dsh-third-party");
		assert.equal(ralph.category.kind, "experimental");
		assert.equal(third.category.kind, "custom");
		assert.equal(ralph.hidden, false);
		assert.equal(third.hidden, false);
		assert.deepEqual(third.source, { kind: "registry", label: "配置渠道" });
	} finally { h.clean(); }
});

test("根级 classification：DSH 版本与表对齐 → matched:true；不对齐 → matched:false 但仍给分类", async () => {
	const aligned = await harnessWithDshVersion("0.2.2-rc.5");
	const h = createHarness({
		pluginManager: { async listBundles() { return [bundle("@deepseek-ai/dsh-experimental-auto-review", { official: true, optional: true })]; } },
		pluginInventory: { async list() { return { entries: [] }; } },
		profileContext: { name: "web", dir: join(testHome, "profiles", "web"), home: testHome, installAnchor: aligned },
	});
	try {
		const { body } = await call(h.route);
		assert.deepEqual(body.classification, {
			tableVersion: EXPERIMENTAL_TABLE_VERSION,
			targetDsh: EXPERIMENTAL_TARGET_DSH,
			dshVersion: "0.2.2-rc.5",
			matched: true,
			source: "static-table",
		});
	} finally { h.clean(); }

	// 表不覆盖当前版本：matched:false，但实验性分类照旧（用户已裁决：仍给分类 + 页面提示）。
	const other = await harnessWithDshVersion("0.4.0-rc.1");
	const h2 = createHarness({
		pluginManager: { async listBundles() { return [bundle("@deepseek-ai/dsh-experimental-auto-review", { official: true, optional: true })]; } },
		pluginInventory: { async list() { return { entries: [] }; } },
		profileContext: { name: "web", dir: join(testHome, "profiles", "web"), home: testHome, installAnchor: other },
	});
	try {
		const { body } = await call(h2.route);
		assert.equal(body.classification.matched, false);
		assert.equal(body.classification.dshVersion, "0.4.0-rc.1");
		assert.equal(body.plugins[0].category.kind, "experimental", "表不匹配不得改判分类");
	} finally { h2.clean(); }
});

test("根级 classification：无 profileContext / anchor 不可读 → dshVersion 空、matched:false（fail-closed）", async () => {
	const noContext = createHarness({
		pluginManager: { async listBundles() { return []; } },
		pluginInventory: { async list() { return { entries: [] }; } },
	});
	try {
		const { body } = await call(noContext.route);
		assert.equal(body.classification.dshVersion, "");
		assert.equal(body.classification.matched, false);
		assert.equal(body.classification.source, "static-table");
	} finally { noContext.clean(); }

	const badAnchor = createHarness({
		pluginManager: { async listBundles() { return []; } },
		pluginInventory: { async list() { return { entries: [] }; } },
		profileContext: { name: "web", dir: "/nonexistent/profiles/web", home: "/nonexistent", installAnchor: "/nonexistent/pkg/package.json" },
	});
	try {
		const { body } = await call(badAnchor.route);
		assert.equal(body.classification.dshVersion, "");
		assert.equal(body.classification.matched, false);
	} finally { badAnchor.clean(); }
});

test("HIDDEN 过滤不得让 complete 语义变假：隐藏行仍在清单里，只是带 hidden:true", async () => {
	const hiddenNames = [...HIDDEN_BUNDLES];
	const h = createHarness({
		pluginManager: {
			async listBundles() {
				return hiddenNames.map((name) => bundle(name, { official: false, availability: "installation" }));
			},
		},
		pluginInventory: { async list() { return { entries: [] }; } },
	});
	try {
		const { body } = await call(h.route);
		assert.equal(body.complete, true);
		assert.equal(body.supported, true);
		assert.equal(body.plugins.length, hiddenNames.length, "隐藏行不得从清单里消失");
		assert.equal(body.plugins.every((p) => p.hidden === true), true);
	} finally { h.clean(); }
});
