// 发版演练 CLI 的**离线**契约测试（issue #37 唯一 seam：命令行接口）。
//
// 只驱动 `tools/npm-drill.mjs` 的外部行为：退出码、`RESULT:`、逐条 PASS/FAIL、
// 稳定 reason、run.json 结构、证据目录与默认清理行为。全程不联网、不需要 Verdaccio。
// 完整五阶段真实 registry 演练在 `test/npm-drill-e2e.test.mjs`（NPM_DRILL=1 才跑）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import {
	appendFile, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { pluginContentDigest } from "../lib/plugin-content-digest.js";
import { buildIsolatedUserConfig, verifyRegistryScope, writeEmptyGlobalConfig } from "../tools/lib/npm-drill/registry.mjs";
import { isolatedEnv } from "../tools/lib/npm-drill/process.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "tools", "npm-drill.mjs");
const BUILDER = join(ROOT, "dsh-mobile-app", "tools", "build-app-carrier.mjs");
// 确定性工具链：保留真实 PATH（需要 npm/pnpm/verdaccio），但剔除 Android SDK 目录，
// 避免有 aapt 的开发机上把假 APK 当真实包实读。
const TOOL_PATH = (process.env.PATH ?? "").split(":")
	.filter((dir) => dir !== "" && !/android|build-tools|\bsdk\b/i.test(dir))
	.join(":") || "/usr/bin:/bin";

/** 让夹具构建与演练子进程使用确定性的工具链（不含 Android aapt，避免假 APK 被实读）。 */
function toolEnv(extra = {}) {
	return { ...process.env, PATH: TOOL_PATH, HOME: extra.HOME ?? process.env.HOME, ...extra };
}

async function exists(file) {
	try {
		await stat(file);
		return true;
	} catch {
		return false;
	}
}

/**
 * 造一个最小但**结构完整**的发布目录（APK + 插件 tgz + 完整清单 + 载体 + 构建记录），
 * 通过现成的 build-app-carrier.mjs 生成，保证与真实发布链同形。
 */
async function makeFixtureDist({ apkBytes }) {
	const base = await mkdtemp(join(tmpdir(), "npm-drill-test-"));
	const pluginRoot = join(base, "plugin");
	const dist = join(base, "dist");
	const home = join(base, "home");
	await mkdir(join(pluginRoot, "lib"), { recursive: true });
	await mkdir(dist, { recursive: true });
	await mkdir(home, { recursive: true });

	const repoPkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
	const appCoreVersion = /^(\d+\.\d+\.\d+)(?:-|$)/.exec(repoPkg.version)?.[1];
	assert.ok(appCoreVersion, `无法从插件版本解析 App core：${repoPkg.version}`);
	const alias = `${repoPkg.name}-app`;
	const pluginPkg = {
		name: repoPkg.name,
		version: repoPkg.version,
		files: ["lib"],
		optionalDependencies: { [alias]: `npm:${repoPkg.name}@${repoPkg.version}-app` },
		license: repoPkg.license ?? "MIT",
		repository: repoPkg.repository ?? undefined,
	};
	await writeFile(join(pluginRoot, "package.json"), `${JSON.stringify(pluginPkg, null, 2)}\n`);
	await writeFile(join(pluginRoot, "lib", "index.js"), "export const drillFixture = true;\n");
	await writeFile(join(pluginRoot, "LICENSE"), "MIT (fixture)\n");

	const pack = spawnSync("npm", ["pack", "--pack-destination", dist, "--json"], {
		cwd: pluginRoot,
		env: toolEnv({ HOME: home, npm_config_cache: join(home, ".npm-cache") }),
		encoding: "utf8",
	});
	assert.equal(pack.status, 0, `npm pack 失败：${pack.stderr}`);
	const start = pack.stdout.indexOf("[");
	const end = pack.stdout.lastIndexOf("]");
	const pluginTgz = join(dist, JSON.parse(pack.stdout.slice(start, end + 1))[0].filename);

	const apk = join(dist, `DSH-Remote-v${appCoreVersion}.apk`);
	await writeFile(apk, apkBytes);
	const changelog = join(base, "CHANGELOG.md");
	await writeFile(changelog, `## v${repoPkg.version}（演练测试夹具）\n\n- 一条发布说明。\n`);

	const build = spawnSync(process.execPath, [
		BUILDER,
		"--apk", apk,
		"--plugin-tgz", pluginTgz,
		"--plugin-root", pluginRoot,
		"--changelog", changelog,
		"--app-version", `${appCoreVersion}+57`,
		"--out-dir", dist,
	], { env: toolEnv({ HOME: home, npm_config_cache: join(home, ".npm-cache") }), encoding: "utf8" });
	assert.equal(build.status, 0, `载体夹具构建失败：\n${build.stdout}\n${build.stderr}`);

	return { base, dist, home };
}

/** 运行演练 CLI（隔离 HOME / 状态目录；默认无网络阶段）。 */
function runDrill({ args, stateDir, home, env = {} }) {
	return spawnSync(process.execPath, [CLI, ...args], {
		env: toolEnv({ HOME: home, DSH_DRILL_STATE_DIR: stateDir, ...env }),
		encoding: "utf8",
		timeout: 600_000,
	});
}

async function runDirs(stateDir) {
	try {
		return await readdir(stateDir);
	} catch {
		return [];
	}
}

async function findRunJson(stateDir) {
	const dirs = await runDirs(stateDir);
	const runs = [];
	for (const name of dirs) {
		const file = join(stateDir, name, "run.json");
		if (await exists(file)) runs.push({ dir: join(stateDir, name), file, record: JSON.parse(await readFile(file, "utf8")) });
	}
	return runs;
}

let fixture;
let brokenDist;
let scratch;

before(async () => {
	scratch = await mkdtemp(join(tmpdir(), "npm-drill-offline-"));
	fixture = await makeFixtureDist({ apkBytes: crypto.randomBytes(64 * 1024) });
	// 结构完整但 APK 字节被篡改的发布目录：预检必须以稳定 reason 失败。
	brokenDist = join(scratch, "broken-dist");
	await cp(fixture.dist, brokenDist, { recursive: true });
	const apkName = (await readdir(brokenDist)).find((name) => name.endsWith(".apk"));
	await appendFile(join(brokenDist, apkName), Buffer.from([0]));
});

after(async () => {
	await rm(fixture.base, { recursive: true, force: true });
	await rm(scratch, { recursive: true, force: true });
});

test("--help：打印 CLI 契约并以 0 退出，不产生运行目录", async () => {
	const stateDir = join(scratch, "state-help");
	const result = runDrill({ args: ["--help"], stateDir, home: fixture.home });
	assert.equal(result.status, 0, result.stdout + result.stderr);
	for (const fragment of ["--dist", "--phases", "--registry", "--plugin-tag", "--keep", "--build", "用法", "RESULT"]) {
		assert.ok(result.stdout.includes(fragment), `帮助缺少 ${fragment}`);
	}
	assert.deepEqual(await runDirs(stateDir), [], "帮助不应创建运行目录");
});

test("参数错误：未知参数以稳定 reason 失败（不静默忽略）", async () => {
	const stateDir = join(scratch, "state-unknown");
	const result = runDrill({ args: ["--bogus"], stateDir, home: fixture.home });
	assert.notEqual(result.status, 0);
	assert.match(result.stdout, /RESULT: FAIL/);
	assert.match(result.stdout, /\[reason:drill-cli-invalid-argument\]/);
});

test("参数错误：非法 --phases 以稳定 reason 失败", async () => {
	const stateDir = join(scratch, "state-phases");
	const result = runDrill({ args: ["--dist", fixture.dist, "--phases", "nope"], stateDir, home: fixture.home });
	assert.notEqual(result.status, 0);
	assert.match(result.stdout, /\[reason:drill-phases-invalid\]/);
	assert.match(result.stdout, /RESULT: FAIL/);
});

test("参数错误：非法 --plugin-tag 以稳定 reason 失败（缺值 / semver range / 版本号都不是 dist-tag）", async () => {
	const variants = [
		["--plugin-tag"],
		["--plugin-tag", "^1.2.3"],
		["--plugin-tag", "1.2.3"],
	];
	for (const [index, extra] of variants.entries()) {
		const stateDir = join(scratch, `state-bad-tag-${index}`);
		const result = runDrill({ args: ["--dist", fixture.dist, "--phases", "preflight", ...extra], stateDir, home: fixture.home });
		assert.notEqual(result.status, 0, `应拒绝 --plugin-tag=${extra.join(" ")}`);
		assert.match(result.stdout, /RESULT: FAIL/);
		assert.match(result.stdout, /\[reason:drill-cli-invalid-argument\]/);
		assert.deepEqual(await runDirs(stateDir), [], "参数错误不应留下运行目录");
	}
});

test("发布目录缺失：以稳定 reason 失败且不留下运行目录", async () => {
	const stateDir = join(scratch, "state-missing");
	const result = runDrill({ args: ["--dist", join(scratch, "does-not-exist"), "--phases", "preflight"], stateDir, home: fixture.home });
	assert.notEqual(result.status, 0);
	assert.match(result.stdout, /\[reason:drill-dist-missing\]/);
	assert.deepEqual(await runDirs(stateDir), [], "CLI 层失败不应留下运行目录");
});

test("--phases preflight PASS：离线预检通过，run.json 结构完整，成功后清理重型现场", async () => {
	const stateDir = join(scratch, "state-pass");
	const result = runDrill({ args: ["--dist", fixture.dist, "--phases", "preflight"], stateDir, home: fixture.home });
	assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
	assert.match(result.stdout, /RESULT: PASS/);
	assert.match(result.stdout, /REASONS: none/);
	assert.match(result.stdout, /PASS  P1 /);
	assert.match(result.stdout, /PASS  P2 /);
	assert.match(result.stdout, /EVIDENCE: /);

	const runs = await findRunJson(stateDir);
	assert.equal(runs.length, 1, "必须写且只写一份 run.json");
	const { dir, record } = runs[0];
	assert.equal(record.schema, "npm-drill/v1");
	assert.equal(record.status, "PASS");
	assert.match(record.drillVersion, /^9\.9\.\d{1,6}$/);
	assert.match(record.carrierVersion, /^9\.9\.\d{1,6}-app$/);
	assert.equal(record.dist, fixture.dist);
	assert.ok(Number.isFinite(record.durationMs) && record.durationMs >= 0);
	assert.match(record.startedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
	assert.match(record.finishedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
	assert.deepEqual(record.reasons, []);
	assert.equal(record.registry, null, "离线阶段不得初始化 registry");
	assert.equal(record.pluginTag, "latest", "默认主插件 dist-tag 必须是 latest（稳定路径）");
	assert.ok(record.environment?.node, "记录 Node 版本");
	const preflight = record.phases.find((phase) => phase.name === "preflight");
	assert.ok(preflight, "缺少 preflight 阶段记录");
	assert.equal(preflight.reported, true);
	assert.deepEqual(preflight.assertions.map((item) => item.id), ["P1", "P2"]);
	assert.ok(preflight.assertions.every((item) => item.pass === true));
	assert.ok(typeof preflight.durationMs === "number");
	assert.equal(record.evidence.dir, dir);
	assert.ok(await exists(join(dir, "logs", "preflight-source.log")), "保留预检日志作为证据");
	assert.equal(await exists(join(dir, "work")), false, "成功后默认清理工作目录");
	assert.equal(await exists(join(dir, "home")), false, "成功后默认清理隔离 HOME");
});

test("--plugin-tag alpha：离线预检 PASS 且 run.json 记录 alpha（不发布、无 registry）", async () => {
	const stateDir = join(scratch, "state-plugin-tag-alpha");
	const result = runDrill({
		args: ["--dist", fixture.dist, "--phases", "preflight", "--plugin-tag", "alpha"],
		stateDir,
		home: fixture.home,
	});
	assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
	assert.match(result.stdout, /RESULT: PASS/);
	const runs = await findRunJson(stateDir);
	assert.equal(runs.length, 1);
	assert.equal(runs[0].record.pluginTag, "alpha");
	assert.equal(runs[0].record.registry, null, "离线阶段不得初始化 registry");
});

test("--keep：保留演练现场（工作目录与日志）", async () => {
	const stateDir = join(scratch, "state-keep");
	const result = runDrill({ args: ["--dist", fixture.dist, "--phases", "preflight", "--keep"], stateDir, home: fixture.home });
	assert.equal(result.status, 0, result.stdout + result.stderr);
	const runs = await findRunJson(stateDir);
	assert.equal(runs.length, 1);
	assert.equal(runs[0].record.evidence.keep, true);
	assert.ok(await exists(join(runs[0].dir, "work")), "--keep 必须保留工作目录");
});

test("预检失败：以稳定 reason 失败，run.json 记录失败断言与原因", async () => {
	const stateDir = join(scratch, "state-preflight-fail");
	const result = runDrill({ args: ["--dist", brokenDist, "--phases", "preflight"], stateDir, home: fixture.home });
	assert.notEqual(result.status, 0);
	assert.match(result.stdout, /RESULT: FAIL/);
	assert.match(result.stdout, /\[reason:drill-dist-preflight-failed\]/);

	const runs = await findRunJson(stateDir);
	assert.equal(runs.length, 1);
	assert.equal(runs[0].record.status, "FAIL");
	assert.ok(runs[0].record.reasons.includes("drill-dist-preflight-failed"));
	const preflight = runs[0].record.phases.find((phase) => phase.name === "preflight");
	const p1 = preflight.assertions.find((item) => item.id === "P1");
	assert.equal(p1.pass, false);
	assert.equal(p1.reason, "drill-dist-preflight-failed");
	assert.ok(await exists(runs[0].dir), "失败时保留证据目录");
});

test("--registry 复用不可达地址：稳定 reason 失败，且前置 preflight 作为静默阶段先执行", async () => {
	const stateDir = join(scratch, "state-registry-dead");
	const result = runDrill({
		args: ["--dist", fixture.dist, "--phases", "publish", "--registry", "http://127.0.0.1:1"],
		stateDir,
		home: fixture.home,
	});
	assert.notEqual(result.status, 0);
	assert.match(result.stdout, /RESULT: FAIL/);
	assert.match(result.stdout, /\[reason:drill-registry-not-alive\]/);
	const runs = await findRunJson(stateDir);
	assert.equal(runs.length, 1);
	const { record } = runs[0];
	assert.equal(record.status, "FAIL");
	// publish 是唯一被选中的 registry 阶段；preflight 是静默前置（执行但不打印/不该标 reported）。
	const preflight = record.phases.find((phase) => phase.name === "preflight");
	assert.equal(preflight.reported, false);
	assert.ok(preflight.assertions.every((item) => item.pass === true));
	const setup = record.phases.find((phase) => phase.name === "setup");
	assert.equal(setup.reported, true);
	assert.equal(setup.assertions[0].reason, "drill-registry-not-alive");
});

test("R2 围栏：--registry 指向非本机/私网地址被拒绝（drill-registry-not-allowed），不发起任何发布", async () => {
	const stateDir = join(scratch, "state-registry-fence");
	const result = runDrill({
		args: ["--dist", fixture.dist, "--phases", "publish", "--registry", "https://registry.npmjs.org"],
		stateDir,
		home: fixture.home,
	});
	assert.notEqual(result.status, 0);
	assert.match(result.stdout, /RESULT: FAIL/);
	assert.match(result.stdout, /\[reason:drill-registry-not-allowed\]/);
	// 围栏在 ping/发布之前生效：不应出现任何 publish 尝试的断言
	const runs = await findRunJson(stateDir);
	assert.equal(runs.length, 1);
	assert.ok(runs[0].record.reasons.includes("drill-registry-not-allowed"));
});

// ── R2 负向回归：投影前必须钉住源产物不变量（评审复现场景） ───────────────────────────

function runTar(args) {
	const result = spawnSync("tar", args, { encoding: "utf8" });
	assert.equal(result.status, 0, `tar 失败：${args.join(" ")}\n${result.stderr}`);
}

async function sha256Of(file) {
	return crypto.createHash("sha256").update(await readFile(file)).digest("hex");
}

async function readJson(file) {
	return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
	await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * 从合法夹具派生"坏源产物"（严格按评审复现：保持 APK/tgz 字节哈希、内嵌/外部清单与构建
 * 记录相互一致，只让真实输入事实错误）：
 * - bad-digest：源清单 plugin.contentSha256 改全 0（真实插件摘要非零）；
 * - no-alias：源插件 tgz 内删除 optionalDependencies（重算 tgz 身份与内容标识并同步记录）。
 */
async function makeSourceDefect({ valid, kind, workRoot }) {
	const dist = join(workRoot, `defect-${kind}`);
	await cp(valid.dist, dist, { recursive: true });
	const manifestPath = join(dist, "manifest.json");
	const recordPath = join(dist, "app-carrier.json");
	const manifest = await readJson(manifestPath);
	const record = await readJson(recordPath);
	const pluginTgz = join(dist, manifest.plugin.file);
	const carrierTgz = join(dist, record.file);
	if (kind === "bad-digest") {
		manifest.plugin.contentSha256 = "0".repeat(64);
	} else if (kind === "no-alias") {
		const pluginExtract = join(workRoot, `plugin-extract-${kind}`);
		await mkdir(pluginExtract, { recursive: true });
		runTar(["-xzf", pluginTgz, "-C", pluginExtract]);
		const pkgPath = join(pluginExtract, "package", "package.json");
		const pkg = await readJson(pkgPath);
		delete pkg.optionalDependencies;
		await writeJson(pkgPath, pkg);
		runTar(["-czf", pluginTgz, "-C", pluginExtract, "package"]);
		manifest.plugin.size = (await stat(pluginTgz)).size;
		manifest.plugin.sha256 = await sha256Of(pluginTgz);
		manifest.plugin.contentSha256 = pluginContentDigest(join(pluginExtract, "package"));
	} else {
		throw new Error(`unknown defect kind: ${kind}`);
	}
	await writeJson(manifestPath, manifest);
	// 同步载体内的随包清单 + 构建记录，确保"除目标缺陷外其余一致"。
	const carrierExtract = join(workRoot, `carrier-extract-${kind}`);
	await mkdir(carrierExtract, { recursive: true });
	runTar(["-xzf", carrierTgz, "-C", carrierExtract]);
	await writeJson(join(carrierExtract, "package", "manifest.json"), manifest);
	runTar(["-czf", carrierTgz, "-C", carrierExtract, "package"]);
	record.manifest = manifest;
	record.size = (await stat(carrierTgz)).size;
	record.sha256 = await sha256Of(carrierTgz);
	await writeJson(recordPath, record);
	return dist;
}

test("R2 负向：源清单内容标识错误（真实插件摘要不符）→ 投影前拦截 drill-source-content-digest-mismatch", async () => {
	const workRoot = await mkdtemp(join(tmpdir(), "npm-drill-defect-digest-"));
	try {
		const dist = await makeSourceDefect({ valid: fixture, kind: "bad-digest", workRoot });
		const stateDir = join(workRoot, "state");
		const result = runDrill({ args: ["--dist", dist, "--phases", "preflight"], stateDir, home: fixture.home });
		assert.notEqual(result.status, 0, result.stdout);
		assert.match(result.stdout, /RESULT: FAIL/);
		assert.match(result.stdout, /\[reason:drill-source-content-digest-mismatch\]/);
		const runs = await findRunJson(stateDir);
		assert.equal(runs.length, 1);
		assert.equal(runs[0].record.status, "FAIL");
		assert.ok(runs[0].record.reasons.includes("drill-source-content-digest-mismatch"));
		assert.equal(runs[0].record.phases.some((phase) => phase.name === "setup"), false, "不得进入投影/registry 阶段");
	} finally {
		await rm(workRoot, { recursive: true, force: true });
	}
});

test("registry self-check ignores an ancestor project .npmrc", async () => {
	const scratch = await mkdtemp(join(tmpdir(), "npm-drill-ancestor-npmrc-"));
	try {
		const home = join(scratch, "home");
		await mkdir(home, { recursive: true });
		await writeFile(join(home, "package.json"), `${JSON.stringify({ name: "npm-drill-home-project", private: true }, null, 2)}\n`);
		await writeFile(join(home, ".npmrc"), [
			`prefix=${join(home, ".npm-global")}`,
			"registry=https://registry.npmmirror.com/",
			"@marktrue:registry=https://registry.npmmirror.com/",
			"",
		].join("\n"));
		const runDir = join(home, ".dsh", "mobile-remote", "drill", "registry-check");
		const registryUrl = "http://127.0.0.1:4879/";
		const pluginName = "@marktrue/dsh-mobile-remote";
		const built = buildIsolatedUserConfig({ runDir, label: "normal", registryUrl, pluginName });
		const globalconfig = writeEmptyGlobalConfig({ runDir, label: "normal" });
		const check = await verifyRegistryScope({
			registryUrl,
			userconfig: built.path,
			globalconfig,
			pluginName,
			env: isolatedEnv({ home: join(home, ".dsh") }),
		});
		assert.equal(check.ok, true, check.detail);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
});

test("R2 负向：源插件 tgz 缺 optionalDependencies（其余字节一致）→ 投影前拦截 drill-source-optional-alias-missing", async () => {
	const workRoot = await mkdtemp(join(tmpdir(), "npm-drill-defect-alias-"));
	try {
		const dist = await makeSourceDefect({ valid: fixture, kind: "no-alias", workRoot });
		const stateDir = join(workRoot, "state");
		const result = runDrill({ args: ["--dist", dist, "--phases", "preflight"], stateDir, home: fixture.home });
		assert.notEqual(result.status, 0, result.stdout);
		assert.match(result.stdout, /RESULT: FAIL/);
		assert.match(result.stdout, /\[reason:drill-source-optional-alias-missing\]/);
		const runs = await findRunJson(stateDir);
		assert.equal(runs.length, 1);
		assert.equal(runs[0].record.status, "FAIL");
		assert.ok(runs[0].record.reasons.includes("drill-source-optional-alias-missing"));
		assert.equal(runs[0].record.phases.some((phase) => phase.name === "setup"), false, "不得进入投影/registry 阶段");
	} finally {
		await rm(workRoot, { recursive: true, force: true });
	}
});
