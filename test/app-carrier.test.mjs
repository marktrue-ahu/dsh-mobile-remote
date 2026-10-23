// App 载体发现与身份校验的隔离测试（设计稿 §5.5、F15/F16）。
// 每个用例使用独立临时目录 + 隔离 dshHome；不读真实 ~/.dsh，不依赖已安装 profile。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	APP_CARRIER_MANIFEST_FILE, APP_CARRIER_STATUS, appCarrierAlias, appCarrierApkPath,
	appCarrierDependencySpec, appCarrierExclusion, appCarrierVersion, defaultPluginRoot,
	describeAppCarrier, discoverAppCarrier,
} from "../lib/app-carrier.js";
import { pluginContentDigest } from "../lib/plugin-content-digest.js";

const PLUGIN_NAME = "@marktrue/dsh-mobile-remote";
const PLUGIN_VERSION = "3.2.0";
const CARRIER_VERSION = `${PLUGIN_VERSION}-app`;
const ALIAS = appCarrierAlias(PLUGIN_NAME);
const APK_FILE = "DSH-Remote-v3.2.0.apk";
const APK_BYTES = Buffer.from("fake-apk-body-for-carrier-identity-".repeat(32));
const TGZ_BYTES = Buffer.from("fake-plugin-tgz-bytes");
const MANIFEST_REL = APP_CARRIER_MANIFEST_FILE;

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function put(file, content) {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
}

function temporary(t) {
	const base = mkdtempSync(join(tmpdir(), "app-carrier-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	return base;
}

/** 与 gen-manifest.js 产出一致的完整 schema 1 清单。 */
function buildManifest(pluginRoot, { apkBytes = APK_BYTES, apkFile = APK_FILE, appVersion, pluginVersion = PLUGIN_VERSION } = {}) {
	const app = {
		version: appVersion ?? `${PLUGIN_VERSION}+42`,
		file: apkFile,
		size: apkBytes.length,
		sha256: sha256(apkBytes),
	};
	const plugin = {
		version: pluginVersion,
		file: "dsh-mobile-remote-v3.2.0.tgz",
		size: TGZ_BYTES.length,
		sha256: sha256(TGZ_BYTES),
		contentSha256: pluginContentDigest(pluginRoot),
	};
	return {
		schema: 1,
		app,
		plugin,
		// 顶层兼容镜像（旧 App 读顶层字段）
		version: app.version,
		apk: app.file,
		size: app.size,
		sha256: app.sha256,
		notes: "test carrier",
	};
}

function syncMirrors(manifest) {
	manifest.version = manifest.app.version;
	manifest.apk = manifest.app.file;
	manifest.size = manifest.app.size;
	manifest.sha256 = manifest.app.sha256;
}

/**
 * 构造一个 pnpm sibling 布局的插件根 + 可选随包载体。
 * pluginRoot 的包名/版本可覆盖；载体默认位于独立 store 目录并 symlink 到插件 sibling。
 */
function fixture(t, {
	pluginName = PLUGIN_NAME,
	pluginVersion = PLUGIN_VERSION,
	declaration = "npm-alias",
	extraDependencies = {},
	withCarrier = true,
	carrierPackage = (pkg) => pkg,
	carrierManifest = (manifest) => manifest,
	apkBytes = APK_BYTES,
	apkFile = APK_FILE,
	writeApk = true,
	manifestMissing = false,
	manifestRaw = null,
	rawCarrierPackage = null,
} = {}) {
	const base = temporary(t);
	const pluginRoot = join(base, "source/node_modules/.pnpm/plugin@1/node_modules/dsh-mobile-remote");
	put(join(pluginRoot, "lib/index.js"), "export const pluginEntry = true;\n");
	const pkg = { name: pluginName, version: pluginVersion, type: "module", main: "lib/index.js", dependencies: { ...extraDependencies } };
	if (declaration === "npm-alias") pkg.optionalDependencies = { [ALIAS]: appCarrierDependencySpec(pluginName, pluginVersion) };
	else if (declaration === "range") pkg.optionalDependencies = { [ALIAS]: `^${pluginVersion}-app` };
	else if (declaration === "local") pkg.optionalDependencies = { [ALIAS]: "file:../carrier" };
	else if (declaration === "required-npm-alias") pkg.dependencies = { ...extraDependencies, [ALIAS]: appCarrierDependencySpec(pluginName, pluginVersion) };
	put(join(pluginRoot, "package.json"), JSON.stringify(pkg, null, 2));

	let carrierRoot = null;
	if (withCarrier) {
		carrierRoot = join(base, "carriers/store/node_modules", ALIAS);
		put(join(carrierRoot, "package.json"), rawCarrierPackage ?? JSON.stringify(carrierPackage({
			name: pluginName, version: appCarrierVersion(pluginVersion), dsh: { appCarrier: true },
		}), null, 2));
		if (!manifestMissing) {
			const manifest = manifestRaw ?? JSON.stringify(carrierManifest(buildManifest(pluginRoot, { apkBytes, apkFile })), null, 2);
			put(join(carrierRoot, MANIFEST_REL), manifest);
		}
		if (writeApk) put(join(carrierRoot, apkFile), apkBytes);
		linkCarrier(pluginRoot, carrierRoot);
	}
	return { base, pluginRoot, carrierRoot, dshHome: join(base, "dsh") };
}

function linkCarrier(scopeRoot, carrierRoot, alias = ALIAS) {
	const link = join(scopeRoot, "node_modules", alias);
	mkdirSync(dirname(link), { recursive: true });
	symlinkSync(carrierRoot, link, "dir");
}

function makeProfileCarrier(t, f, profileName, carrierRoot) {
	const profileDir = join(f.dshHome, "profiles", profileName);
	put(join(profileDir, "package.json"), JSON.stringify({ name: `dsh-profile-${profileName}`, private: true, dependencies: {} }, null, 2));
	linkCarrier(profileDir, carrierRoot);
	return profileDir;
}

function secondCarrier(t, f, { slot = "second", apkBytes = Buffer.from("second-carrier-different-apk") } = {}) {
	const root = join(f.base, "carriers", slot, "store/node_modules", ALIAS);
	put(join(root, "package.json"), JSON.stringify({ name: PLUGIN_NAME, version: CARRIER_VERSION, dsh: { appCarrier: true } }, null, 2));
	const manifest = buildManifest(f.pluginRoot, { apkBytes });
	put(join(root, MANIFEST_REL), JSON.stringify(manifest, null, 2));
	put(join(root, APK_FILE), apkBytes);
	return root;
}

test("导出身份推导：别名/版本/精确别名依赖；默认插件根是本工作树", () => {
	assert.equal(appCarrierAlias("@marktrue/dsh-mobile-remote"), "@marktrue/dsh-mobile-remote-app");
	assert.equal(appCarrierAlias("dsh-mobile-remote"), "dsh-mobile-remote-app");
	assert.equal(appCarrierVersion("3.2.0"), "3.2.0-app");
	assert.equal(appCarrierDependencySpec("@marktrue/dsh-mobile-remote", "3.2.0"), "npm:@marktrue/dsh-mobile-remote@3.2.0-app");
	assert.equal(defaultPluginRoot(), resolve(fileURLToPath(new URL("..", import.meta.url))));
	assert.throws(() => appCarrierAlias("../evil"), /invalid-plugin-name/);
	assert.equal(APP_CARRIER_MANIFEST_FILE, "manifest.json");
});

test("pnpm sibling 作用域找到并校验随包载体：身份、清单、APK 全部通过", (t) => {
	const f = fixture(t);
	const result = discoverAppCarrier({ pluginRoot: f.pluginRoot, dshHome: f.dshHome });
	assert.equal(result.ok, true, result.reason);
	assert.equal(result.status, APP_CARRIER_STATUS.FOUND);
	assert.equal(result.alias, ALIAS);
	assert.equal(result.plugin.name, PLUGIN_NAME);
	assert.equal(result.carrier.name, PLUGIN_NAME);
	assert.equal(result.carrier.version, CARRIER_VERSION);
	assert.equal(result.carrier.source, realpathSync(f.carrierRoot));
	assert.equal(result.discoveredVia, "plugin");
	assert.deepEqual(result.declaration, {
		declared: true, field: "optionalDependencies",
		spec: `npm:${PLUGIN_NAME}@${CARRIER_VERSION}`, kind: "npm-alias",
	});
	assert.equal(result.manifest.schema, 1);
	assert.equal(result.manifest.appVersion, `${PLUGIN_VERSION}+42`);
	assert.equal(result.manifest.pluginVersion, PLUGIN_VERSION);
	assert.equal(result.apk.file, APK_FILE);
	assert.equal(result.apk.size, APK_BYTES.length);
	assert.equal(result.apk.sha256, sha256(APK_BYTES));
	assert.equal(result.pluginContent.matches, true);
	assert.equal(appCarrierApkPath(result), join(realpathSync(f.carrierRoot), APK_FILE));
	// 对外诊断不得带出本机绝对路径。
	const diagnostic = describeAppCarrier(result);
	const serialized = JSON.stringify(diagnostic);
	assert.equal(serialized.includes(f.base), false);
	assert.equal(diagnostic.status, "found");
	assert.equal(diagnostic.declarationKind, "npm-alias");
	assert.equal(diagnostic.apk.sha256, sha256(APK_BYTES));
});

test("未安装载体 → missing（稳定 reason），不抛异常", (t) => {
	const f = fixture(t, { withCarrier: false });
	const result = discoverAppCarrier({ pluginRoot: f.pluginRoot, dshHome: f.dshHome });
	assert.equal(result.ok, false);
	assert.equal(result.status, APP_CARRIER_STATUS.MISSING);
	assert.equal(result.reason, "carrier-not-installed");
	assert.equal(result.alias, ALIAS);
	assert.equal(result.declaration.declared, true);
});

test("插件自身 package.json 缺失 → error/plugin-package-missing", (t) => {
	const base = temporary(t);
	const result = discoverAppCarrier({ pluginRoot: join(base, "nope"), dshHome: join(base, "dsh") });
	assert.equal(result.ok, false);
	assert.equal(result.status, APP_CARRIER_STATUS.ERROR);
	assert.equal(result.reason, "plugin-package-missing");
});

test("载体别名下是 broken symlink → error/carrier-broken-link（不被上层同名包兜底）", (t) => {
	const f = fixture(t, { withCarrier: false });
	const link = join(f.pluginRoot, "node_modules", ALIAS);
	mkdirSync(dirname(link), { recursive: true });
	symlinkSync(join(f.base, "missing-carrier"), link, "dir");
	const result = discoverAppCarrier({ pluginRoot: f.pluginRoot, dshHome: f.dshHome });
	assert.equal(result.status, APP_CARRIER_STATUS.ERROR);
	assert.equal(result.reason, "carrier-broken-link");
});

test("同一作用域多个不同候选 → ambiguous，不替调用方挑第一个", (t) => {
	const f = fixture(t);
	linkCarrier(join(f.base, "source"), secondCarrier(t, f));
	const result = discoverAppCarrier({ pluginRoot: f.pluginRoot, dshHome: f.dshHome });
	assert.equal(result.ok, false);
	assert.equal(result.status, APP_CARRIER_STATUS.AMBIGUOUS);
	assert.equal(result.reason, "carrier-multiple-candidates");
	assert.equal(result.candidates.length, 2);
	assert.equal(result.carrier, undefined);
});

test("不跨 profile 猜载体：未显式给出当前 profile 时即使别的 profile 有载体也不采用（§5.5）", (t) => {
	const f = fixture(t, { withCarrier: false });
	makeProfileCarrier(t, f, "web", secondCarrier(t, f));
	const result = discoverAppCarrier({ pluginRoot: f.pluginRoot, dshHome: f.dshHome });
	assert.equal(result.ok, false);
	assert.equal(result.status, APP_CARRIER_STATUS.MISSING);
	assert.equal(result.reason, "carrier-not-installed");
});

test("显式给出当前 profile 才回退，且只认该 profile（来源可诊断）", (t) => {
	const f = fixture(t, { withCarrier: false });
	const profileDir = makeProfileCarrier(t, f, "web", secondCarrier(t, f));
	const result = discoverAppCarrier({ pluginRoot: f.pluginRoot, dshHome: f.dshHome, profileDir });
	assert.equal(result.ok, true, result.reason);
	assert.equal(result.status, APP_CARRIER_STATUS.FOUND);
	assert.equal(result.discoveredVia, "profile:web");
	assert.equal(describeAppCarrier(result).locatedVia, "profile:web");
});

test("多 profile 各有一个载体：未指定时不采用（防串 profile），指定后只认指定那个、不构成 ambiguous", (t) => {
	const f = fixture(t, { withCarrier: false });
	makeProfileCarrier(t, f, "web", secondCarrier(t, f, { slot: "web", apkBytes: Buffer.from("web-profile-apk") }));
	const desktopDir = makeProfileCarrier(t, f, "desktop", secondCarrier(t, f, { slot: "desktop", apkBytes: Buffer.from("desktop-profile-apk") }));
	const withoutProfile = discoverAppCarrier({ pluginRoot: f.pluginRoot, dshHome: f.dshHome });
	assert.equal(withoutProfile.ok, false);
	assert.equal(withoutProfile.status, APP_CARRIER_STATUS.MISSING);
	const withDesktop = discoverAppCarrier({ pluginRoot: f.pluginRoot, dshHome: f.dshHome, profileDir: desktopDir });
	assert.equal(withDesktop.ok, true, withDesktop.reason);
	assert.equal(withDesktop.discoveredVia, "profile:desktop");
	assert.equal(withDesktop.apk.sha256, sha256(Buffer.from("desktop-profile-apk")));
});

test("声明缺失不影响发现（声明状态交给闭包排除判定）", (t) => {
	const f = fixture(t, { declaration: "none" });
	const result = discoverAppCarrier({ pluginRoot: f.pluginRoot, dshHome: f.dshHome });
	assert.equal(result.ok, true, result.reason);
	assert.equal(result.declaration.declared, false);
	assert.equal(result.declaration.kind, null);
});

const MISMATCH_CASES = [
	["真实包名不符", { carrierPackage: (pkg) => ({ ...pkg, name: "@other/dsh-mobile-remote" }) }, "carrier-package-name-mismatch"],
	["真实版本不符", { carrierPackage: (pkg) => ({ ...pkg, version: "3.1.0-app" }) }, "carrier-version-mismatch"],
	["缺少 dsh.appCarrier", { carrierPackage: (pkg) => ({ ...pkg, dsh: {} }) }, "carrier-role-marker-missing"],
	["dsh.appCarrier 非 true", { carrierPackage: (pkg) => ({ ...pkg, dsh: { appCarrier: "true" } }) }, "carrier-role-marker-missing"],
	["载体带 main", { carrierPackage: (pkg) => ({ ...pkg, main: "index.js" }) }, "carrier-runtime-role-forbidden"],
	["载体带 exports", { carrierPackage: (pkg) => ({ ...pkg, exports: { ".": "./index.js" } }) }, "carrier-runtime-role-forbidden"],
	["载体带 bin", { carrierPackage: (pkg) => ({ ...pkg, bin: { carrier: "cli.js" } }) }, "carrier-runtime-role-forbidden"],
	["载体带 os 平台字段", { carrierPackage: (pkg) => ({ ...pkg, os: ["linux"] }) }, "carrier-runtime-role-forbidden"],
	["载体带 dsh.bundle", { carrierPackage: (pkg) => ({ ...pkg, dsh: { appCarrier: true, bundle: {} } }) }, "carrier-runtime-role-forbidden"],
	["载体带安装钩子", { carrierPackage: (pkg) => ({ ...pkg, scripts: { postinstall: "node x.js" } }) }, "carrier-runtime-role-forbidden"],
	["清单文件缺失", { manifestMissing: true }, "carrier-manifest-missing"],
	["清单 JSON 非法", { manifestRaw: "{" }, "carrier-manifest-unreadable"],
	["清单 schema 非 1", { carrierManifest: (m) => ({ ...m, schema: 2 }) }, "carrier-manifest-schema"],
	["缺 app 段", { carrierManifest: (m) => ({ schema: 1, plugin: m.plugin }) }, "carrier-manifest-incomplete"],
	["缺 plugin 段", { carrierManifest: (m) => ({ schema: 1, app: m.app, version: m.version, apk: m.apk, size: m.size, sha256: m.sha256 }) }, "carrier-manifest-incomplete"],
	["app.version 非构建号", { carrierManifest: (m) => { m.app.version = "3.2.0"; syncMirrors(m); return m; } }, "carrier-manifest-incomplete"],
	["plugin.version 与插件不同", { carrierManifest: (m) => { m.plugin.version = "3.1.0"; return m; } }, "carrier-manifest-plugin-version-mismatch"],
	["app.version 语义版本与插件不同", { carrierManifest: (m) => { m.app.version = "3.1.0+7"; syncMirrors(m); return m; } }, "carrier-manifest-app-version-mismatch"],
	["顶层兼容镜像不一致", { carrierManifest: (m) => ({ ...m, sha256: "0".repeat(64) }) }, "carrier-manifest-mirror-mismatch"],
	["APK 文件名带路径穿越", { carrierManifest: (m) => { m.app.file = "../evil.apk"; syncMirrors(m); return m; } }, "carrier-apk-file-invalid"],
	["APK 文件名非 .apk", { carrierManifest: (m) => { m.app.file = "payload.bin"; syncMirrors(m); return m; } }, "carrier-apk-file-invalid"],
	["APK 文件缺失", { writeApk: false }, "carrier-apk-missing"],
	["APK 大小与清单不一致", { carrierManifest: (m) => { m.app.size += 3; syncMirrors(m); return m; } }, "carrier-apk-size-mismatch"],
	["APK 哈希与清单不一致", { carrierManifest: (m) => { m.app.sha256 = "a".repeat(64); syncMirrors(m); return m; } }, "carrier-apk-sha256-mismatch"],
	["清单插件内容标识格式非法", { carrierManifest: (m) => { m.plugin.contentSha256 = "not-a-hash"; return m; } }, "carrier-manifest-incomplete"],
];

for (const [label, options, expectedReason] of MISMATCH_CASES) {
	test(`身份不符不得当可用载体：${label} → mismatch/${expectedReason}`, (t) => {
		const f = fixture(t, options);
		const result = discoverAppCarrier({ pluginRoot: f.pluginRoot, dshHome: f.dshHome });
		assert.equal(result.ok, false);
		assert.equal(result.status, APP_CARRIER_STATUS.MISMATCH);
		assert.equal(result.reason, expectedReason);
		assert.equal(result.carrier, undefined, "不符的候选不得被当成可用载体");
		const diagnostic = describeAppCarrier(result);
		assert.equal(diagnostic.status, "mismatch");
		assert.equal(diagnostic.candidateCount, 0);
	});
}

test("清单声明为本地目录绑定时同样完整校验（测试通道 file: 布局）", (t) => {
	const f = fixture(t, { declaration: "local" });
	const result = discoverAppCarrier({ pluginRoot: f.pluginRoot, dshHome: f.dshHome });
	assert.equal(result.ok, true, result.reason);
	assert.equal(result.declaration.kind, "local");
});

// ── 运行时依赖闭包排除判定（appCarrierExclusion）──────────────────────────────

test("闭包排除：根包显式精确别名 + 身份校验通过才排除", (t) => {
	const f = fixture(t);
	const before = readFileSync(join(f.pluginRoot, "package.json"), "utf8");
	const exclusion = appCarrierExclusion({ root: f.pluginRoot });
	assert.equal(exclusion.exclude, true, exclusion.reason);
	assert.equal(exclusion.alias, ALIAS);
	assert.equal(exclusion.carrier.version, CARRIER_VERSION);
	assert.equal(exclusion.apk.sha256, sha256(APK_BYTES));
	// 排除只是建图判定：不得改根包元数据（内容标识不因排除而变）。
	assert.equal(readFileSync(join(f.pluginRoot, "package.json"), "utf8"), before);
});

test("闭包排除：未声明别名不排除（含普通依赖自报 appCarrier 的场景）", (t) => {
	const f = fixture(t, { declaration: "none", extraDependencies: { "sneaky-carrier": "1" } });
	// 普通依赖自报 dsh.appCarrier、甚至别名本身只在普通 dependencies 里——都不能豁免。
	put(join(f.pluginRoot, "node_modules/sneaky-carrier/package.json"), JSON.stringify({ name: "sneaky-carrier", version: "1.0.0", main: "index.js", dsh: { appCarrier: true } }));
	put(join(f.pluginRoot, "node_modules/sneaky-carrier/index.js"), "module.exports = true;\n");
	const exclusion = appCarrierExclusion({ root: f.pluginRoot });
	assert.equal(exclusion.exclude, false);
	assert.equal(exclusion.reason, "carrier-not-declared");
});

test("闭包排除：范围声明不算精确绑定", (t) => {
	const f = fixture(t, { declaration: "range" });
	const exclusion = appCarrierExclusion({ root: f.pluginRoot });
	assert.equal(exclusion.exclude, false);
	assert.notEqual(exclusion.hard, true);
	assert.equal(exclusion.reason, "carrier-declaration-not-exact");
});

test("闭包排除：required dependencies 里的精确 npm 别名同样可排除", (t) => {
	const f = fixture(t, { declaration: "required-npm-alias" });
	assert.equal(appCarrierExclusion({ root: f.pluginRoot }).exclude, true);
});

test("闭包排除：APK 字节被改写后不排除（伪造/损坏的载体不豁免）", (t) => {
	const f = fixture(t);
	const tampered = Buffer.from(APK_BYTES);
	tampered[0] ^= 0xff; // 保持大小相同，只改字节 → 必须由哈希判据拒绝
	writeFileSync(join(f.carrierRoot, APK_FILE), tampered);
	const exclusion = appCarrierExclusion({ root: f.pluginRoot });
	assert.equal(exclusion.exclude, false);
	assert.equal(exclusion.hard, true, "声明了且装了候选但校验失败 → 闭包必须 fail-closed");
	assert.equal(exclusion.reason, "carrier-apk-sha256-mismatch");
});

test("闭包排除：多个候选/载体缺失/包元数据异常都 fail-closed 为不排除", (t) => {
	const missing = fixture(t, { withCarrier: false });
	assert.deepEqual(
		(() => { const r = appCarrierExclusion({ root: missing.pluginRoot }); return [r.exclude, r.reason]; })(),
		[false, "carrier-not-installed"],
	);
	const multiple = fixture(t);
	linkCarrier(join(multiple.base, "source"), secondCarrier(t, multiple));
	assert.deepEqual(
		(() => { const r = appCarrierExclusion({ root: multiple.pluginRoot }); return [r.exclude, r.reason]; })(),
		[false, "carrier-multiple-candidates"],
	);
	const bad = fixture(t, { carrierPackage: (pkg) => ({ ...pkg, version: "3.1.0-app" }) });
	const badResult = appCarrierExclusion({ root: bad.pluginRoot });
	assert.deepEqual([badResult.exclude, badResult.hard, badResult.reason], [false, true, "carrier-version-mismatch"]);
	const noPackage = appCarrierExclusion({ root: join(missing.base, "not-a-package") });
	assert.equal(noPackage.exclude, false);
	assert.equal(noPackage.reason, "plugin-package-missing");
});
