// 发布配对工具链的**外部行为**测试（设计稿 §5.1/§5.2、§6.2 F17/F18、§10.1 R1/R9/R10）。
//
// 只通过 CLI 驱动 dsh-mobile-app/tools/build-app-carrier.mjs 与 verify-update-manifest.mjs，
// 断言退出码、`RESULT: PASS|FAIL`、关键 PASS/FAIL 行以及真实产物字节；不 import 工具内部函数。
//
// 覆盖：正常顺序成功；逆序（缺插件 tgz / 先有载体再重打 tgz）失败；范围别名被拒；
// 载体平台字段/入口/dsh.bundle/安装钩子被拒；两条版本不配对被拒；哈希不符被拒；
// 发布顺序前置（缺载体 tarball 拒绝发布主包）；无 aapt 时显式降级并标注“未实读”；
// npm 载体发布前预检（publish-carrier-check）：发布元数据（tag=app/access/private/files）、
// X.Y.Z ↔ X.Y.Z-app 版本配对、产物哈希与离线 `npm pack --dry-run` 的 PASS/FAIL 两条路径。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import {
	appendFile, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUILD = join(ROOT, "dsh-mobile-app", "tools", "build-app-carrier.mjs");
const VERIFY = join(ROOT, "dsh-mobile-app", "tools", "verify-update-manifest.mjs");
const GEN = join(ROOT, "dsh-mobile-app", "tools", "gen-manifest.js");
const PUBLISH_CHECK = join(ROOT, "dsh-mobile-app", "tools", "publish-carrier-check.mjs");

const PLUGIN_NAME = "@marktrue/dsh-mobile-remote";
const PLUGIN_VERSION = "3.2.0";
const APP_VERSION = "3.2.0+23";
const APK_FILE = "DSH-Remote-v3.2.0.apk";
const CARRIER_FILE = "marktrue-dsh-mobile-remote-3.2.0-app.tgz";
const CARRIER_VERSION = `${PLUGIN_VERSION}-app`;
const CARRIER_ALIAS = `${PLUGIN_NAME}-app`;

/** 2MB 假 APK（不可压缩随机字节，避免 tarball 被压成 0 字节而掩盖体积/哈希问题）。 */
const APK_BYTES = crypto.randomBytes(2 * 1024 * 1024);

const AAPT_STUB = [
	"#!/bin/sh",
	'if [ "$1" = "dump" ] && [ "$2" = "badging" ]; then',
	"  cat <<'EOF'",
	"package: name='com.marktrue.dsh_mobile_remote' versionCode='23' versionName='3.2.0' platformBuildVersionName='14'",
	"EOF",
	"  exit 0",
	"fi",
	'echo "fake aapt: unsupported args: $*" >&2',
	"exit 1",
	"",
].join("\n");

function pathJoin(parts) {
	return parts.filter(Boolean).join(process.platform === "win32" ? ";" : ":");
}

async function exists(file) {
	try {
		await stat(file);
		return true;
	} catch {
		return false;
	}
}

function runTar(args) {
	const r = spawnSync("tar", args, { encoding: "utf8" });
	assert.equal(r.status, 0, `tar 失败：${args.join(" ")}\n${r.stderr}`);
}

/** 用真实 `npm pack` 打插件 tgz（发布链同一条路径），返回 tgz 绝对路径。 */
async function packPlugin(pluginRoot, dist) {
	await mkdir(dist, { recursive: true });
	const r = spawnSync("npm", ["pack", "--pack-destination", dist, "--json"], { cwd: pluginRoot, encoding: "utf8" });
	assert.equal(r.status, 0, `npm pack 插件失败：${r.stderr}`);
	const start = r.stdout.indexOf("[");
	const end = r.stdout.lastIndexOf("]");
	const info = JSON.parse(r.stdout.slice(start, end + 1));
	assert.equal(info.length, 1, r.stdout);
	return join(dist, info[0].filename);
}

/**
 * 造一套“已构建好”的发布输入：插件源码（精确别名声明）+ 由它 npm pack 的 tgz + APK +
 * CHANGELOG + 仅实现 `dump badging` 的假 aapt（让“实读 APK 版本”分支可重复测试）。
 */
async function makeFixture() {
	const base = await mkdtemp(join(tmpdir(), "release-pairing-"));
	const pluginRoot = join(base, "plugin");
	const dist = join(base, "dist");
	const binDir = join(base, "fake-android-bin");
	const home = join(base, "home");
	await mkdir(join(pluginRoot, "lib"), { recursive: true });
	await mkdir(dist, { recursive: true });
	await mkdir(binDir, { recursive: true });
	await mkdir(home, { recursive: true });

	const pluginPkg = {
		name: PLUGIN_NAME,
		version: PLUGIN_VERSION,
		files: ["lib", "README.md", "LICENSE"],
		optionalDependencies: { [CARRIER_ALIAS]: `npm:${PLUGIN_NAME}@${CARRIER_VERSION}` },
		// 载体发布元数据继承来源（P3-A：license/repository 随载体发布）
		license: "MIT",
		repository: { type: "git", url: "git+https://example.com/fixture.git" },
	};
	await writeFile(join(pluginRoot, "package.json"), `${JSON.stringify(pluginPkg, null, 2)}\n`);
	await writeFile(join(pluginRoot, "lib", "index.js"), "export const plugin = '3.2.0';\n");
	await writeFile(join(pluginRoot, "README.md"), "# fixture plugin\n");
	await writeFile(join(pluginRoot, "LICENSE"), "MIT (fixture)\n");

	const apkPath = join(dist, APK_FILE);
	await writeFile(apkPath, APK_BYTES);
	const changelog = join(base, "CHANGELOG.md");
	await writeFile(changelog, "## v3.2.0（配对测试）\n\n- 一条发布说明。\n");

	const fakeAapt = join(binDir, "aapt");
	await writeFile(fakeAapt, AAPT_STUB);
	await chmod(fakeAapt, 0o755);

	const tgz = await packPlugin(pluginRoot, dist);
	return {
		base,
		pluginRoot,
		dist,
		binDir,
		home,
		apkPath,
		changelog,
		tgz,
		manifestPath: join(dist, "manifest.json"),
		recordPath: join(dist, "app-carrier.json"),
		carrierFile: join(dist, CARRIER_FILE),
		mainPkgPath: join(pluginRoot, "package.json"),
	};
}

/** 工具子进程环境：可选接入假 aapt；`aapt:false` 时去掉 Android 构建工具（保留 node/npm/tar）。 */
function toolEnv(fixture, { aapt = true } = {}) {
	const pathValue = aapt
		? pathJoin([fixture.binDir, process.env.PATH ?? ""])
		: pathJoin([dirname(process.execPath), "/usr/bin", "/bin"]);
	return { ...process.env, HOME: fixture.home, PATH: pathValue };
}

function buildCarrier(fixture, { appVersion = APP_VERSION, aapt = true, pluginTgz = fixture.tgz } = {}) {
	const args = [
		BUILD,
		"--apk", fixture.apkPath,
		"--plugin-tgz", pluginTgz,
		"--plugin-root", fixture.pluginRoot,
		"--changelog", fixture.changelog,
		"--out-dir", fixture.dist,
	];
	if (appVersion !== null) args.push("--app-version", appVersion);
	return spawnSync(process.execPath, args, { encoding: "utf8", env: toolEnv(fixture, { aapt }) });
}

function verifyPairing(fixture, extraArgs = [], { aapt = true } = {}) {
	return spawnSync(process.execPath, [
		VERIFY,
		fixture.dist,
		"--require-carrier",
		"--package-json", fixture.mainPkgPath,
		...extraArgs,
	], { encoding: "utf8", env: toolEnv(fixture, { aapt }) });
}

/** 发布前预检 CLI（离线 dry-run，不发布）。 */
function publishCheck(fixture, { aapt = true } = {}) {
	return spawnSync(process.execPath, [
		PUBLISH_CHECK,
		fixture.dist,
		"--package-json", fixture.mainPkgPath,
	], { encoding: "utf8", env: toolEnv(fixture, { aapt }) });
}

function stdoutOf(resultOrStdout) {
	return typeof resultOrStdout === "string" ? resultOrStdout : (resultOrStdout?.stdout ?? "");
}

function failLines(resultOrStdout) {
	return stdoutOf(resultOrStdout).split(/\r?\n/).filter((line) => line.startsWith("FAIL  "));
}

function passLines(resultOrStdout) {
	return stdoutOf(resultOrStdout).split(/\r?\n/).filter((line) => line.startsWith("PASS  "));
}

function assertExitFail(result, label = "") {
	assert.notEqual(result.status, 0, `${label}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`);
	assert.match(result.stdout, /RESULT: FAIL/, label);
}

function assertExitPass(result, label = "") {
	assert.equal(result.status, 0, `${label}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`);
	assert.match(result.stdout, /RESULT: PASS/, label);
}

function assertFailLine(resultOrStdout, fragment) {
	const matches = failLines(resultOrStdout);
	assert.ok(
		matches.some((line) => line.includes(fragment)),
		`期望出现含「${fragment}」的 FAIL 行，实际 FAIL 行：\n${matches.join("\n") || "<无>"}`,
	);
}

function assertReasonLine(resultOrStdout, code) {
	const matches = failLines(resultOrStdout);
	assert.ok(
		matches.some((line) => line.includes(`[reason:${code}]`)),
		`期望出现带 [reason:${code}] 的 FAIL 行，实际 FAIL 行：\n${matches.join("\n") || "<无>"}`,
	);
}

function assertPassLine(resultOrStdout, fragment) {
	const matches = passLines(resultOrStdout);
	assert.ok(
		matches.some((line) => line.includes(fragment)),
		`期望出现含「${fragment}」的 PASS 行，实际 PASS 行：\n${matches.join("\n") || "<无>"}`,
	);
}

/** 解包载体 tarball 到临时目录，返回其中 `package/` 目录。 */
async function extractCarrier(fixture, label = "carrier") {
	const dir = join(fixture.base, `extract-${label}-${crypto.randomUUID()}`);
	await mkdir(dir, { recursive: true });
	runTar(["-xzf", fixture.carrierFile, "-C", dir]);
	return { root: dir, packageDir: join(dir, "package") };
}

async function repackCarrier(extractRoot, carrierFile) {
	runTar(["-czf", carrierFile, "-C", extractRoot, "package"]);
}

/** 重新打包载体后同步构建记录里的 tarball 体积/哈希（模拟“构建器产出了另一个合法载体”）。 */
async function refreshCarrierRecord(fixture) {
	const record = JSON.parse(await readFile(fixture.recordPath, "utf8"));
	const buf = await readFile(fixture.carrierFile);
	record.size = buf.length;
	record.sha256 = crypto.createHash("sha256").update(buf).digest("hex");
	await writeFile(fixture.recordPath, `${JSON.stringify(record, null, 2)}\n`);
	return record;
}

// ── 1. 正常顺序：先插件 tgz、后载体；三件套 + 载体全一致，发布门禁 PASS ──────────────
test("正常顺序：先插件 tgz 后载体；清单/载体/APK/tgz 四者一致且发布门禁 PASS（aapt 实读版本）", async () => {
	const f = await makeFixture();
	try {
		const build = buildCarrier(f, { appVersion: null }); // 不传 --app-version，强制走 aapt 实读
		assertExitPass(build, "载体构建应成功");
		assertPassLine(build, "构建顺序");
		assertPassLine(build, "APK 内部版本实读成功");
		assert.match(build.stdout, /实读 versionName=3\.2\.0 versionCode=23/);
		assert.match(build.stdout, /未向任何 registry 发布/);

		const manifest = JSON.parse(await readFile(f.manifestPath, "utf8"));
		assert.equal(manifest.schema, 1);
		assert.equal(manifest.app.version, APP_VERSION, "app.version 必须来自 APK 实读");
		assert.equal(manifest.app.file, APK_FILE);
		assert.equal(manifest.app.sha256, crypto.createHash("sha256").update(APK_BYTES).digest("hex"));
		assert.equal(manifest.plugin.version, PLUGIN_VERSION);
		assert.equal(manifest.plugin.file, "marktrue-dsh-mobile-remote-3.2.0.tgz");
		assert.equal(manifest.plugin.sha256, crypto.createHash("sha256").update(await readFile(f.tgz)).digest("hex"));
		// 顶层兼容镜像与 app 段同源
		assert.equal(manifest.version, manifest.app.version);
		assert.equal(manifest.apk, manifest.app.file);
		assert.equal(manifest.sha256, manifest.app.sha256);

		// 载体 tarball：同包名、X.Y.Z-app、数据角色、内容恰为四件套
		assert.equal(await exists(f.carrierFile), true, "必须产出载体 tarball");
		const extracted = await extractCarrier(f);
		const carrierPkg = JSON.parse(await readFile(join(extracted.packageDir, "package.json"), "utf8"));
		assert.equal(carrierPkg.name, PLUGIN_NAME);
		assert.equal(carrierPkg.version, CARRIER_VERSION);
		assert.equal(carrierPkg.dsh.appCarrier, true);
		assert.deepEqual(
			[...carrierPkg.files].sort(),
			[APK_FILE, "LICENSE", "README.md", "manifest.json"].sort(),
		);
		for (const forbidden of ["os", "cpu", "libc", "bin", "main", "exports", "scripts"]) {
			assert.equal(carrierPkg[forbidden], undefined, `载体不得含 ${forbidden}`);
		}
		assert.deepEqual(
			JSON.parse(await readFile(join(extracted.packageDir, "manifest.json"), "utf8")),
			manifest,
			"载体内的清单必须就是发布清单本身",
		);
		assert.deepEqual(await readFile(join(extracted.packageDir, APK_FILE)), APK_BYTES);

		// npm 发布元数据（P3-A：载体发布到 npm，dist-tag 固定 app）
		assert.equal(carrierPkg.private, false, "private 必须显式 false 才能 npm publish");
		assert.deepEqual(carrierPkg.publishConfig, { access: "public", tag: "app" }, "dist-tag 固定 app，绝不用 latest");
		assert.equal(carrierPkg.license, "MIT", "license 继承主包");
		assert.equal(carrierPkg.repository?.url, "git+https://example.com/fixture.git", "repository 继承主包");
		assert.ok(String(carrierPkg.description ?? "").trim() !== "", "description 非空");
		assertPassLine(build, "publishConfig.tag 必须是 app");

		// 严格发布门禁
		const verify = verifyPairing(f);
		assertExitPass(verify);
		assertPassLine(verify, "精确 npm 别名");
		assertPassLine(verify, "两条版本严格配对");
		assertPassLine(verify, "发布顺序前置");
		assertPassLine(verify, "载体 tarball 体积/哈希与构建记录一致");
	} finally {
		await rm(f.base, { recursive: true, force: true });
	}
});

// ── 2. 逆序：没有插件 tgz 时不得生成载体 ───────────────────────────────────────────
test("逆序被拒：缺少已打好的插件 tgz 时构建器直接失败，且不产出清单/载体", async () => {
	const f = await makeFixture();
	try {
		// 2a) 完全不给 --plugin-tgz（等价于“先打载体”）
		const r = spawnSync(process.execPath, [
			BUILD,
			"--apk", f.apkPath,
			"--plugin-root", f.pluginRoot,
			"--changelog", f.changelog,
			"--out-dir", f.dist,
			"--app-version", APP_VERSION,
		], { encoding: "utf8", env: toolEnv(f) });
		assertExitFail(r, "缺 plugin-tgz 必须失败");
		assertFailLine(r.stdout, "构建顺序");
		assert.match(r.stdout, /--plugin-tgz/);
		assert.equal(await exists(f.manifestPath), false, "失败时不得留下清单");
		assert.equal(await exists(f.carrierFile), false, "失败时不得留下载体 tarball");

		// 2b) 给一个不存在的 tgz 路径（“还没打出来”）
		const r2 = buildCarrier(f, { pluginTgz: join(f.base, "not-packed-yet.tgz") });
		assertExitFail(r2, "tgz 不存在必须失败");
		assertFailLine(r2.stdout, "构建顺序");
		assert.equal(await exists(f.carrierFile), false);

		// 2c) tgz 打好后又改源码却没重 pack：内容标识对不上，拒绝用旧 tgz 生成清单
		const build = buildCarrier(f);
		assertExitPass(build, "基线应先成功");
		await writeFile(join(f.pluginRoot, "lib", "index.js"), "export const plugin = 'drifted';\n");
		const r3 = buildCarrier(f);
		assertExitFail(r3, "源码漂移必须失败");
		assertFailLine(r3.stdout, "内容标识等于当前源码");
	} finally {
		await rm(f.base, { recursive: true, force: true });
	}
});

// ── 3. 载体先于 tgz 的“证据漂移”：载体已生成后重打插件 tgz → 门禁失败 ──────────────
test("逆序被拒：载体已生成后重新打包插件 tgz → 清单哈希不再来自本地 tgz，发布门禁失败", async () => {
	const f = await makeFixture();
	try {
		assertExitPass(buildCarrier(f));
		// 同一文件名、不同字节：模拟“先打载体、后改主包并重打 tgz”
		await writeFile(join(f.pluginRoot, "lib", "index.js"), "export const plugin = 'repacked';\n");
		const repacked = await packPlugin(f.pluginRoot, join(f.base, "repacked-dist"));
		await writeFile(f.tgz, await readFile(repacked));

		const verify = verifyPairing(f);
		assertExitFail(verify, "tgz 被重打后门禁必须失败");
		assertFailLine(verify.stdout, "plugin.sha256 与实算一致");
		assertFailLine(verify.stdout, "plugin.sha256 来自本地实际插件 tgz");
	} finally {
		await rm(f.base, { recursive: true, force: true });
	}
});

// ── 4. 范围别名 / latest 被拒 ─────────────────────────────────────────────────────
test("范围别名被拒：^ / ~ / latest / 裸版本都不是精确 npm 别名（构建器与门禁都拦）", async () => {
	const f = await makeFixture();
	try {
		const pkgPath = f.mainPkgPath;
		const good = JSON.parse(await readFile(pkgPath, "utf8"));
		const badSpecs = [
			`npm:${PLUGIN_NAME}@^${PLUGIN_VERSION}`,
			`npm:${PLUGIN_NAME}@~${PLUGIN_VERSION}-app`,
			`npm:${PLUGIN_NAME}@^${PLUGIN_VERSION}-app`,
			`npm:${PLUGIN_NAME}@latest`,
			`${PLUGIN_VERSION}-app`,
			`*`,
		];
		for (const spec of badSpecs) {
			const pkg = structuredClone(good);
			pkg.optionalDependencies[CARRIER_ALIAS] = spec;
			await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
			const build = buildCarrier(f);
			assertExitFail(build, `构建器应拒绝范围/标签别名：${spec}`);
			assertFailLine(build.stdout, "精确 npm 别名");
		}

		// 恢复精确别名 → 构建成功；再把主包别名改成范围写法，发布门禁必须拒绝
		await writeFile(pkgPath, `${JSON.stringify(good, null, 2)}\n`);
		assertExitPass(buildCarrier(f));
		const ranged = structuredClone(good);
		ranged.optionalDependencies[CARRIER_ALIAS] = `npm:${PLUGIN_NAME}@^${PLUGIN_VERSION}`;
		await writeFile(pkgPath, `${JSON.stringify(ranged, null, 2)}\n`);
		const verify = verifyPairing(f);
		assertExitFail(verify, "门禁应拒绝范围别名");
		assertFailLine(verify.stdout, "精确 npm 别名");
	} finally {
		await rm(f.base, { recursive: true, force: true });
	}
});

// ── 5. 载体字段红线：平台字段 / 运行入口 / dsh.bundle / 安装钩子 / 平台 token ─────────
test("载体红线被拒：平台字段、运行入口、dsh.bundle、安装钩子、平台 token 一律 FAIL", async () => {
	const f = await makeFixture();
	try {
		assertExitPass(buildCarrier(f));
		const basePkg = JSON.parse(await readFile(join(f.dist, "manifest.json"), "utf8"));

		const variants = [
			{ label: "os", pkg: { os: ["linux"] }, fragment: "载体无平台字段" },
			{ label: "cpu", pkg: { cpu: ["x64"] }, fragment: "载体无平台字段" },
			{ label: "libc", pkg: { libc: ["musl"] }, fragment: "载体无平台字段" },
			{ label: "main", pkg: { main: "index.js" }, fragment: "载体无运行入口" },
			{ label: "bin", pkg: { bin: { carrier: "cli.js" } }, fragment: "载体无运行入口" },
			{ label: "exports", pkg: { exports: { ".": "./index.js" } }, fragment: "载体无运行入口" },
			{ label: "dsh.bundle", pkg: { dsh: { appCarrier: true, bundle: { patch: "./x.yml" } } }, fragment: "载体无 dsh.bundle" },
			{ label: "scripts", pkg: { scripts: { postinstall: "node evil.js" } }, fragment: "安装期执行钩子" },
			{ label: "platform-name", pkg: { name: "dsh-mobile-remote-linux-x64" }, fragment: "平台 token" },
		];
		for (const variant of variants) {
			const extracted = await extractCarrier(f, variant.label);
			try {
				const pkgFile = join(extracted.packageDir, "package.json");
				const pkg = JSON.parse(await readFile(pkgFile, "utf8"));
				await writeFile(pkgFile, `${JSON.stringify({ ...pkg, ...variant.pkg }, null, 2)}\n`);
				await repackCarrier(extracted.root, f.carrierFile);
				await refreshCarrierRecord(f);
				const verify = verifyPairing(f);
				assertExitFail(verify, `载体红线必须拒绝：${variant.label}\n${verify.stdout}`);
				assertFailLine(verify.stdout, variant.fragment);
			} finally {
				await rm(extracted.root, { recursive: true, force: true });
			}
		}

		// 清单本身必须仍然自洽（确保上面的失败来自红线而不是基础产物坏掉）
		assert.equal(basePkg.schema, 1);
	} finally {
		await rm(f.base, { recursive: true, force: true });
	}
});

// ── 6. 两条版本不配对被拒 ─────────────────────────────────────────────────────────
test("版本不配对被拒：app.version 与 plugin.version、载体 X.Y.Z-app 必须严格配对", async () => {
	const f = await makeFixture();
	try {
		assertExitPass(buildCarrier(f));
		const manifest = JSON.parse(await readFile(f.manifestPath, "utf8"));

		// 6a) 清单 app.version 语义版本与 plugin.version 不同
		const badApp = structuredClone(manifest);
		badApp.app.version = "3.3.0+23";
		await writeFile(f.manifestPath, `${JSON.stringify(badApp, null, 2)}\n`);
		const verifyApp = verifyPairing(f);
		assertExitFail(verifyApp, "app.version 不配对必须失败");
		assertFailLine(verifyApp.stdout, "app.version 语义版本与 plugin.version 严格配对");

		// 6b) 载体包版本不是 X.Y.Z-app
		await writeFile(f.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
		const extracted = await extractCarrier(f, "version");
		try {
			const pkgFile = join(extracted.packageDir, "package.json");
			const pkg = JSON.parse(await readFile(pkgFile, "utf8"));
			pkg.version = "3.3.0-app";
			await writeFile(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
			await repackCarrier(extracted.root, f.carrierFile);
			await refreshCarrierRecord(f);
			const verifyCarrier = verifyPairing(f);
			assertExitFail(verifyCarrier, "载体版本不配对必须失败");
			assertFailLine(verifyCarrier.stdout, "两条版本严格配对");
		} finally {
			await rm(extracted.root, { recursive: true, force: true });
		}
	} finally {
		await rm(f.base, { recursive: true, force: true });
	}
});

// ── 7. 哈希不符被拒 ───────────────────────────────────────────────────────────────
test("哈希不符被拒：dist APK、载体内 APK、插件 tgz、构建记录任一被改都失败", async () => {
	const f = await makeFixture();
	const originalApk = APK_BYTES;
	const originalTgz = await readFile(f.tgz);
	try {
		assertExitPass(buildCarrier(f));

		// 7a) dist 内 APK 被追加字节 → app.size / app.sha256 失败
		await appendFile(f.apkPath, Buffer.from([0]));
		const verifyApk = verifyPairing(f);
		assertExitFail(verifyApk, "APK 被篡改必须失败");
		assertFailLine(verifyApk.stdout, "app.size 与字节数一致");
		await writeFile(f.apkPath, originalApk);

		// 7b) 载体 tarball 内 APK 被追加字节 → 载体内容与清单 app.sha256 不一致
		const extracted = await extractCarrier(f, "hash");
		try {
			const carrierApk = join(extracted.packageDir, APK_FILE);
			await appendFile(carrierApk, Buffer.from([0]));
			await repackCarrier(extracted.root, f.carrierFile);
			await refreshCarrierRecord(f);
			const verifyCarrier = verifyPairing(f);
			assertExitFail(verifyCarrier, "载体内 APK 被篡改必须失败");
			assertFailLine(verifyCarrier.stdout, "载体 tarball 内 APK 哈希与清单 app.sha256 一致");
		} finally {
			await rm(extracted.root, { recursive: true, force: true });
		}
		assertExitPass(buildCarrier(f), "重建后应恢复 PASS");

		// 7c) 插件 tgz 被追加字节 → plugin.size/sha256 与载体清单里的哈希都失败
		await appendFile(f.tgz, Buffer.from([0]));
		const verifyTgz = verifyPairing(f);
		assertExitFail(verifyTgz, "插件 tgz 被篡改必须失败");
		assertFailLine(verifyTgz.stdout, "plugin.size 与字节数一致");

		// 7d) 构建记录的载体 tarball 哈希被改 → 体积/哈希核对失败
		await writeFile(f.tgz, originalTgz);
		assertExitPass(buildCarrier(f));
		const record = JSON.parse(await readFile(f.recordPath, "utf8"));
		record.sha256 = `0${record.sha256.slice(1)}`;
		await writeFile(f.recordPath, `${JSON.stringify(record, null, 2)}\n`);
		const verifyRecord = verifyPairing(f);
		assertExitFail(verifyRecord, "构建记录被篡改必须失败");
		assertFailLine(verifyRecord.stdout, "载体 tarball 体积/哈希与构建记录一致");
	} finally {
		await rm(f.base, { recursive: true, force: true });
	}
});

// ── 8. 发布顺序前置：缺载体 tarball 时发布门禁拒绝主插件产物 ─────────────────────────
test("发布顺序前置：只有主插件 tgz+清单、没有载体 tarball 时 --require-carrier 必须失败", async () => {
	const f = await makeFixture();
	try {
		// 模拟旧发布链：先有主插件 tgz 与清单（gen-manifest），载体尚未构建
		const gen = spawnSync(process.execPath, [
			GEN,
			"--apk", f.apkPath,
			"--version", APP_VERSION,
			"--plugin-tgz", f.tgz,
			"--plugin-root", f.pluginRoot,
			"--changelog", f.changelog,
			"--out", f.manifestPath,
		], { encoding: "utf8" });
		assert.equal(gen.status, 0, gen.stderr);
		assert.equal(await exists(f.carrierFile), false);

		const verify = verifyPairing(f);
		assertExitFail(verify, "缺载体时发布门禁必须失败（先发载体）");
		assertFailLine(verify.stdout, "发布顺序前置");
		assertFailLine(verify.stdout, "载体 tarball 必须先于主插件发布存在");
	} finally {
		await rm(f.base, { recursive: true, force: true });
	}
});

// ── 9. 无 aapt 降级：显式 --app-version + 文件名一致性，明确标注“未实读” ────────────
test("无 aapt 降级：显式 --app-version + 文件名一致性通过，并明确标注“未实读”", async () => {
	const f = await makeFixture();
	try {
		const build = buildCarrier(f, { aapt: false });
		assertExitPass(build, "无 aapt 时应允许显式 --app-version 降级");
		assertPassLine(build, "未实读");
		assert.match(build.stdout, /--app-version/);
		const manifest = JSON.parse(await readFile(f.manifestPath, "utf8"));
		assert.equal(manifest.app.version, APP_VERSION);
		assert.equal(manifest.plugin.version, PLUGIN_VERSION);

		const verify = verifyPairing(f, [], { aapt: false });
		assertExitPass(verify, "无 aapt 的校验器应降级但不能失败");
		assertPassLine(verify, "未实读");

		// 没有 --app-version 且没有 aapt → 拒绝猜测构建号
		const r = buildCarrier(f, { aapt: false, appVersion: null });
		assertExitFail(r, "缺 --app-version 时必须失败");
		assertFailLine(r.stdout, "未实读");
	} finally {
		await rm(f.base, { recursive: true, force: true });
	}
});

// ── 10. 主包 package.json 的别名与版本（仓库真实文件，不 bump 版本）────────────────────
test("主包 package.json：载体别名是当前版本的精确 npm 别名，且不进 bundled 依赖", async () => {
	const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
	const alias = `${pkg.name}-app`;
	const spec = pkg.optionalDependencies?.[alias];
	assert.equal(spec, `npm:${pkg.name}@${pkg.version}-app`, "别名必须是当前版本的精确 npm 别名");
	assert.doesNotMatch(spec, /[\^~><=*| ]/, "别名不得是范围");
	assert.doesNotMatch(spec, /latest/, "别名不得指向 latest");
	assert.ok(!(pkg.bundleDependencies ?? []).includes(alias), "载体不得进 bundled 依赖");
	assert.ok(!(pkg.bundledDependencies ?? []).includes(alias), "载体不得进 bundled 依赖");
	assert.equal(pkg.dependencies?.[alias], undefined, "载体别名不得出现在普通 dependencies");
});

// ── 11. 发布前预检 PASS：发布元数据/版本配对/产物哈希/离线 dry-run 全通过，且不写盘、不发布 ──
test("publish-carrier-check PASS：发布元数据/版本配对/产物哈希/离线 dry-run 全通过（不写盘、不发布）", async () => {
	const f = await makeFixture();
	try {
		assertExitPass(buildCarrier(f), "基线载体应先构建成功");
		const before = (await readdir(f.dist)).sort();

		const check = publishCheck(f);
		assertExitPass(check, "发布前预检应 PASS");
		assert.match(check.stdout, /REASONS: none/);
		assertPassLine(check, "publishConfig.tag 必须是 app");
		assertPassLine(check, "发布版本与主插件版本严格配对");
		assertPassLine(check, "npm pack --dry-run 成功（离线元数据检查，不发布、不落盘）");
		assertPassLine(check, "dry-run 打包内容包含 APK 本体");
		assertPassLine(check, "dry-run 打包内容恰为约定 5 个文件");
		assertPassLine(check, "载体 tarball 体积/哈希与构建记录一致");
		// 只打印发布方案（必须带 --tag app），绝不执行发布
		assert.match(check.stdout, /--tag app/);
		assert.match(check.stdout, /NOT executed by this check/);

		// 预检必须零写盘：dry-run 不产出 tarball，不新增/删除 dist 文件
		const after = (await readdir(f.dist)).sort();
		assert.deepEqual(after, before, "发布前预检不得写盘");
	} finally {
		await rm(f.base, { recursive: true, force: true });
	}
});

// ── 12. 发布前预检 FAIL：tag/private/access/版本不配对 → 稳定 reason ──────────────────
test("publish-carrier-check FAIL：非法发布元数据（tag/private/access/版本）带稳定 reason 被拒", async () => {
	const f = await makeFixture();
	try {
		assertExitPass(buildCarrier(f));
		const variants = [
			{ label: "tag-latest", reason: "carrier-publish-tag-not-app", mutate: (pkg) => { pkg.publishConfig.tag = "latest"; } },
			{ label: "tag-missing", reason: "carrier-publish-tag-not-app", mutate: (pkg) => { delete pkg.publishConfig.tag; } },
			{ label: "private-true", reason: "carrier-publish-private-not-false", mutate: (pkg) => { pkg.private = true; } },
			{ label: "access-restricted", reason: "carrier-publish-access-not-public", mutate: (pkg) => { pkg.publishConfig.access = "restricted"; } },
			{ label: "version-skew", reason: "carrier-version-pairing-mismatch", mutate: (pkg) => { pkg.version = "3.2.1-app"; } },
		];
		for (const variant of variants) {
			const extracted = await extractCarrier(f, `publish-${variant.label}`);
			try {
				const pkgFile = join(extracted.packageDir, "package.json");
				const pkg = JSON.parse(await readFile(pkgFile, "utf8"));
				variant.mutate(pkg);
				await writeFile(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
				await repackCarrier(extracted.root, f.carrierFile);
				await refreshCarrierRecord(f);

				const check = publishCheck(f);
				assertExitFail(check, `发布前预检应拒绝：${variant.label}`);
				assert.match(check.stdout, /REASONS: .+/);
				assertReasonLine(check, variant.reason);
			} finally {
				await rm(extracted.root, { recursive: true, force: true });
			}
		}
	} finally {
		await rm(f.base, { recursive: true, force: true });
	}
});

// ── 13. 发布前预检 FAIL：dist 产物不一致（APK / 构建记录）→ 稳定 reason ──────────────
test("publish-carrier-check FAIL：APK 或构建记录被篡改/缺失 → 稳定 reason 被拒", async () => {
	const f = await makeFixture();
	try {
		assertExitPass(buildCarrier(f));

		// 13a) dist 内 APK 被追加字节 → 清单与 APK 哈希不符
		await appendFile(f.apkPath, Buffer.from([0]));
		const apkCheck = publishCheck(f);
		assertExitFail(apkCheck, "APK 被篡改必须失败");
		assertReasonLine(apkCheck, "apk-sha256-mismatch");
		await writeFile(f.apkPath, APK_BYTES); // 恢复

		// 13b) 构建记录里的载体 tarball 体积被改 → 与载体 tarball 实算不符
		const record = JSON.parse(await readFile(f.recordPath, "utf8"));
		record.size += 1;
		await writeFile(f.recordPath, `${JSON.stringify(record, null, 2)}\n`);
		const recordCheck = publishCheck(f);
		assertExitFail(recordCheck, "构建记录被篡改必须失败");
		assertReasonLine(recordCheck, "carrier-record-carrier-mismatch");

		// 13c) 构建记录缺失 → 无法核对载体 tarball 体积/哈希
		await rm(f.recordPath);
		const missingCheck = publishCheck(f);
		assertExitFail(missingCheck, "缺构建记录必须失败");
		assertReasonLine(missingCheck, "carrier-record-missing");
	} finally {
		await rm(f.base, { recursive: true, force: true });
	}
});
