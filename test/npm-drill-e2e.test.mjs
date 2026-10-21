// 发版演练的 **opt-in 端到端**测试（issue #37）：完整五阶段 + 20 条断言，真实本地 registry。
//
// 默认跳过（`NPM_DRILL=1` 才跑），避免网络/外部依赖导致默认套件 flaky：
//   npm i -g verdaccio@6.10.6        # 一次性
//   NPM_DRILL=1 node --test test/npm-drill-e2e.test.mjs
//
// 夹具：用真实发布链工具（npm pack + build-app-carrier）在临时目录造 12MB APK 的发布目录；
// 12MB 是为了让载体发布请求体 > 10mb，从而在失败阶段复现 E413。全程只连 127.0.0.1 的临时
// Verdaccio，不发布任何公共包。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import {
	cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "dsh-mobile-app", "tools", "npm-drill.mjs");
const BUILDER = join(ROOT, "dsh-mobile-app", "tools", "build-app-carrier.mjs");
const RELEASE_SH = join(ROOT, "dsh-mobile-app", "tools", "package-release.sh");
// 确定性工具链：保留真实 PATH（需要 npm/pnpm/verdaccio），但剔除 Android SDK 目录，
// 避免有 aapt 的开发机上把假 APK 当真实包实读。
const TOOL_PATH = (process.env.PATH ?? "").split(":")
	.filter((dir) => dir !== "" && !/android|build-tools|\bsdk\b/i.test(dir))
	.join(":") || "/usr/bin:/bin";

const ENABLED = process.env.NPM_DRILL === "1";
const SKIP = ENABLED ? false : "设置 NPM_DRILL=1 才运行真实 registry 端到端演练（见文件头说明）";

const verdaccio = ENABLED ? spawnSync("verdaccio", ["--version"], { encoding: "utf8", env: { ...process.env } }) : null;
const VERDACCIO_OK = Boolean(verdaccio && verdaccio.status === 0);
const SKIP_VERDACCIO = VERDACCIO_OK ? false : "未安装全局 Verdaccio：npm i -g verdaccio@6.10.6";

function toolEnv(extra = {}) {
	return { ...process.env, PATH: TOOL_PATH, HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "", ...extra };
}

async function exists(file) {
	try {
		await stat(file);
		return true;
	} catch {
		return false;
	}
}

async function makeFixtureDist({ apkBytes }) {
	const base = await mkdtemp(join(tmpdir(), "npm-drill-e2e-"));
	const pluginRoot = join(base, "plugin");
	const dist = join(base, "dist");
	const home = join(base, "home");
	await mkdir(join(pluginRoot, "lib"), { recursive: true });
	await mkdir(dist, { recursive: true });
	await mkdir(home, { recursive: true });

	const repoPkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
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

	const env = toolEnv({ HOME: home, npm_config_cache: join(home, ".npm-cache") });
	const pack = spawnSync("npm", ["pack", "--pack-destination", dist, "--json"], { cwd: pluginRoot, env, encoding: "utf8" });
	assert.equal(pack.status, 0, `npm pack 失败：${pack.stderr}`);
	const start = pack.stdout.indexOf("[");
	const end = pack.stdout.lastIndexOf("]");
	const pluginTgz = join(dist, JSON.parse(pack.stdout.slice(start, end + 1))[0].filename);

	const apk = join(dist, `DSH-Remote-v${repoPkg.version}.apk`);
	await writeFile(apk, apkBytes);
	const changelog = join(base, "CHANGELOG.md");
	await writeFile(changelog, `## v${repoPkg.version}（演练 E2E 夹具）\n\n- 一条发布说明。\n`);

	const build = spawnSync(process.execPath, [
		BUILDER,
		"--apk", apk,
		"--plugin-tgz", pluginTgz,
		"--plugin-root", pluginRoot,
		"--changelog", changelog,
		"--app-version", `${repoPkg.version}+57`,
		"--out-dir", dist,
	], { env, encoding: "utf8" });
	assert.equal(build.status, 0, `载体夹具构建失败：\n${build.stdout}\n${build.stderr}`);
	return { base, dist, home };
}

let fixture;
let scratch;

before(async () => {
	if (!ENABLED) return;
	scratch = await mkdtemp(join(tmpdir(), "npm-drill-e2e-scratch-"));
	// 12MB 随机 APK：载体 tarball ≈12.6MB → npm publish 请求体 ≈16.8MB > 10mb（E413 可复现）。
	fixture = await makeFixtureDist({ apkBytes: crypto.randomBytes(12 * 1024 * 1024) });
});

after(async () => {
	if (!ENABLED) return;
	if (fixture) await rm(fixture.base, { recursive: true, force: true });
	if (scratch) await rm(scratch, { recursive: true, force: true });
});

function runCli({ args, stateDir, home, timeout = 600_000 }) {
	return spawnSync(process.execPath, [CLI, ...args], {
		env: toolEnv({ HOME: home, DSH_DRILL_STATE_DIR: stateDir }),
		encoding: "utf8",
		timeout,
	});
}

async function readRunRecord(stateDir) {
	const dirs = await readdir(stateDir);
	const runs = dirs.filter((name) => /^\d{8}T\d{6}Z-/.test(name)).sort();
	assert.equal(runs.length, 1, `期望恰好一个运行目录：${runs.join(",") || "<无>"}`);
	const dir = join(stateDir, runs[0]);
	const record = JSON.parse(await readFile(join(dir, "run.json"), "utf8"));
	return { dir, record };
}

const EXPECTED_ASSERTIONS = Array.from({ length: 20 }, (_, index) => `A${index + 1}`);

test("完整演练：五阶段 + 20 条断言全部 PASS（本地 registry，不触碰公共 npm）", { skip: SKIP || SKIP_VERDACCIO }, async () => {
	const stateDir = join(scratch, "state-full");
	const startedAt = Date.now();
	const result = runCli({ args: ["--dist", fixture.dist, "--phases", "all"], stateDir, home: fixture.home });
	const elapsedMs = Date.now() - startedAt;
	assert.equal(result.status, 0, `演练失败：\n${result.stdout}\n${result.stderr}`);
	assert.match(result.stdout, /RESULT: PASS/);
	assert.match(result.stdout, /REASONS: none/);
	assert.match(result.stdout, /EVIDENCE: /);

	const { dir, record } = await readRunRecord(stateDir);
	assert.equal(record.schema, "npm-drill/v1");
	assert.equal(record.status, "PASS");
	assert.match(record.drillVersion, /^9\.9\.\d{1,6}$/);
	assert.match(record.carrierVersion, /^9\.9\.\d{1,6}-app$/);
	assert.deepEqual(record.reasons, []);
	assert.ok(record.durationMs < 600_000, "演练必须在 10 分钟内完成");

	// registry 只能是本机临时实例（绝不公共源）。
	assert.equal(record.registry?.mode, "spawned");
	assert.match(String(record.registry?.normalUrl), /^http:\/\/127\.0\.0\.1:\d+$/);
	assert.match(String(record.registry?.lowLimitUrl), /^http:\/\/127\.0\.0\.1:\d+$/);
	assert.equal(record.registry?.maxBodySize, "200mb");
	assert.equal(record.registry?.lowLimitMaxBody, "10mb");

	// 阶段与 20 条断言：每条恰好出现一次且全部 PASS。
	const phaseNames = record.phases.map((phase) => phase.name);
	for (const expected of ["preflight", "setup", "publish", "install", "discover", "update", "failure"]) {
		assert.ok(phaseNames.includes(expected), `缺少阶段 ${expected}（实际：${phaseNames.join(",")}）`);
	}
	const assertions = record.phases.flatMap((phase) => phase.assertions).filter((item) => /^A\d+$/.test(item.id));
	assert.deepEqual([...new Set(assertions.map((item) => item.id))].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))), EXPECTED_ASSERTIONS);
	assert.equal(assertions.length, 20);
	for (const item of assertions) {
		assert.equal(item.pass, true, `${item.id} 应 PASS：reason=${item.reason} detail=${item.detail}`);
		assert.ok(typeof item.durationMs === "number");
	}
	const phaseOk = (name) => record.phases.find((phase) => phase.name === name)?.ok;
	for (const name of ["publish", "install", "discover", "update", "failure"]) {
		assert.equal(phaseOk(name), true, `阶段 ${name} 应 PASS`);
	}

	// 证据与清理：默认成功后保 run.json + 日志，清理工作目录/隔离 HOME/registry 存储。
	assert.ok(await exists(join(dir, "run.json")));
	assert.ok(await exists(join(dir, "logs")));
	assert.equal(await exists(join(dir, "work")), false, "成功后默认清理工作目录");
	assert.equal(await exists(join(dir, "registry")), false, "成功后默认清理 registry 存储");
	assert.equal(await exists(join(dir, "home")), false, "成功后默认清理隔离 HOME");
	console.log(`[npm-drill e2e] RESULT=PASS 断言=20 耗时=${(elapsedMs / 1000).toFixed(1)}s 记录=${dir}`);
});

test("--phases 子集：未选中的前置阶段静默执行，只报告选中阶段", { skip: SKIP || SKIP_VERDACCIO }, async () => {
	const stateDir = join(scratch, "state-subset");
	const result = runCli({ args: ["--dist", fixture.dist, "--phases", "publish,install"], stateDir, home: fixture.home });
	assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
	assert.match(result.stdout, /RESULT: PASS/);

	const { record } = await readRunRecord(stateDir);
	const phases = new Map(record.phases.map((phase) => [phase.name, phase]));
	// 前置 preflight 静默执行（不打印但仍记录），publish/install 正常报告。
	assert.equal(phases.get("preflight")?.reported, false);
	assert.equal(phases.get("preflight")?.ok, true);
	assert.equal(phases.get("publish")?.reported, true);
	assert.equal(phases.get("install")?.reported, true);
	for (const skipped of ["discover", "update", "failure"]) {
		assert.equal(phases.has(skipped), false, `未选中的阶段 ${skipped} 不应执行`);
	}
	assert.equal(record.status, "PASS");
});

test("发布脚本 --drill-only：不构建、只演练，透传演练结果与退出码", { skip: SKIP || SKIP_VERDACCIO }, async () => {
	const stateDir = join(scratch, "state-wrapper");
	const result = spawnSync("bash", [RELEASE_SH, "--drill-only", fixture.dist], {
		env: toolEnv({ HOME: fixture.home, DSH_DRILL_STATE_DIR: stateDir }),
		encoding: "utf8",
		timeout: 600_000,
	});
	assert.equal(result.status, 0, `--drill-only 失败：\n${result.stdout}\n${result.stderr}`);
	assert.match(result.stdout, /RESULT: PASS/);
	assert.match(result.stdout, /Publish preflight only|发版演练|npm-drill/);
	const { record } = await readRunRecord(stateDir);
	assert.equal(record.status, "PASS");
	assert.equal(record.phases.filter((phase) => /^A\d+$/.test(phase.assertions[0]?.id ?? "")).length, 5);
});

test("发布脚本 --drill-only 的演练失败会以非零码阻断", { skip: SKIP || SKIP_VERDACCIO }, async () => {
	// 结构完整但 APK 被篡改的发布目录 → 预检失败 → 演练失败 → 脚本必须非零退出（阻断发布）。
	const brokenDist = join(scratch, "broken-dist");
	await cp(fixture.dist, brokenDist, { recursive: true });
	const apkName = (await readdir(brokenDist)).find((name) => name.endsWith(".apk"));
	const { appendFile } = await import("node:fs/promises");
	await appendFile(join(brokenDist, apkName), Buffer.from([0]));
	const stateDir = join(scratch, "state-wrapper-fail");
	const result = spawnSync("bash", [RELEASE_SH, "--drill-only", brokenDist], {
		env: toolEnv({ HOME: fixture.home, DSH_DRILL_STATE_DIR: stateDir }),
		encoding: "utf8",
		timeout: 600_000,
	});
	assert.notEqual(result.status, 0, `演练失败必须阻断发布：\n${result.stdout}`);
	assert.match(result.stdout, /RESULT: FAIL/);
	assert.match(result.stdout, /drill-dist-preflight-failed/);
});
