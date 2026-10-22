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
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import { readFileSync, statSync } from "node:fs";
import {
	chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "tools", "npm-drill.mjs");
const BUILDER = join(ROOT, "dsh-mobile-app", "tools", "build-app-carrier.mjs");
const RELEASE_SH = join(ROOT, "dsh-mobile-app", "tools", "package-release.sh");
const PLUGIN_NAME = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).name;
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

function runCli({ args, stateDir, home, timeout = 600_000, env = {} }) {
	return spawnSync(process.execPath, [CLI, ...args], {
		env: toolEnv({ HOME: home, DSH_DRILL_STATE_DIR: stateDir, ...env }),
		encoding: "utf8",
		timeout,
	});
}

/**
 * 异步运行演练 CLI：R1 场景需要在同一个测试进程里跑 HTTP 接收端，spawnSync 会阻塞事件循环，
 * 导致接收端无法响应子进程请求（应使用异步 spawn）。
 */
function runCliAsync({ args, stateDir, home, env = {}, timeout = 600_000 }) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [CLI, ...args], {
			env: toolEnv({ HOME: home, DSH_DRILL_STATE_DIR: stateDir, ...env }),
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
		child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
		const timer = setTimeout(() => {
			try { child.kill("SIGKILL"); } catch { /* 忽略 */ }
			reject(new Error(`npm-drill 超时：${timeout}ms`));
		}, timeout);
		child.on("error", (error) => { clearTimeout(timer); reject(error); });
		child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
	});
}

/** 在 PATH 中查找真实可执行文件（用于 shim 转发）。 */
function findExecutable(name) {
	for (const dir of (process.env.PATH ?? "").split(":")) {
		if (dir === "") continue;
		const candidate = join(dir, name);
		try {
			if (statSync(candidate).isFile()) return candidate;
		} catch {
			// 继续
		}
	}
	return null;
}

const REAL_NPM = findExecutable("npm");
const REAL_PNPM = findExecutable("pnpm");

/** 写一个可执行的 PATH shim（故障注入用；只包装真实命令，不改生产代码）。 */
async function writeShim(dir, name, source) {
	await mkdir(dir, { recursive: true });
	const file = join(dir, name);
	await writeFile(file, source);
	await chmod(file, 0o755);
	return file;
}

/** 解析 run.json 里某条断言的记录。 */
function assertionOf(record, id) {
	return record.phases.flatMap((phase) => phase.assertions).find((item) => item.id === id) ?? null;
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
	// R1/R2 负向保证：正向运行时必须同时覆盖"源产物不变量"与"实际生效 registry 路由"。
	const setup = record.phases.find((phase) => phase.name === "setup");
	assert.ok(setup, "缺少 setup 阶段");
	const s2 = setup.assertions.find((item) => item.id === "S2");
	assert.ok(s2 && s2.pass === true, `S2 registry 路由自检应 PASS：${JSON.stringify(s2)}`);
	const p1 = assertionOf(record, "P1");
	assert.match(String(p1?.detail ?? ""), /内容标识/, "P1 应报告源产物内容标识校验");

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

// ── 复评负向回归（R1/R4/R5/R8/R9）：评审复现场景必须有对应 FAIL + reason ───────────────
//
// 需要真实 registry/安装的注入式回归用 PATH shim 实现（只包装真实 npm/pnpm，不改生产代码）；
// R1 用两个仅监听 127.0.0.1 的接收端截获实际 PUT，不访问任何公共源。

const PNPM_SHIM = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const real = process.env.DRILL_REAL_PNPM;
const args = process.argv.slice(2);
const result = cp.spawnSync(real, args, { stdio: "inherit", env: process.env });
const mode = process.env.DRILL_PNPM_TAMPER || "";
const counterFile = process.env.DRILL_PNPM_COUNTER;
const logFile = process.env.DRILL_INJECTION_LOG;
function note(message) { if (logFile) fs.appendFileSync(logFile, message + "\\n"); }
function bump() {
  const n = (fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, "utf8")) : 0) + 1;
  fs.writeFileSync(counterFile, String(n));
  return n;
}
if (result.status === 0 && args[0] === "add") {
  const count = bump();
  const name = process.env.DRILL_PLUGIN_NAME;
  const alias = name + "-app";
  const cwd = process.cwd();
  const pluginDir = path.join(cwd, "node_modules", ...name.split("/"));
  const carrierDir = path.join(cwd, "node_modules", ...alias.split("/"));
  if (mode === "carrier-manifest" && count === 1) {
    const manifestFile = path.join(carrierDir, "manifest.json");
    const data = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    data.plugin.contentSha256 = "0".repeat(64);
    fs.writeFileSync(manifestFile, JSON.stringify(data, null, 2) + "\\n");
    note("injected: installed carrier manifest plugin.contentSha256 zeroed (R4)");
  }
  if (mode === "layout-alias" && count === 1) {
    for (const file of [path.join(cwd, "pnpm-lock.yaml"), path.join(cwd, "node_modules", ".modules.yaml")]) {
      let text = fs.readFileSync(file, "utf8");
      text = text.split(alias).join(name + "-wrong-alias");
      text += "\\n# unrelated mention: " + alias + " <- " + name + "@carrier" + "\\n";
      fs.writeFileSync(file, text);
    }
    note("injected: lockfile/.modules alias keys renamed; correct alias only in comment (R8)");
  }
  if (mode === "plugin-only-decl" && count === 3) {
    const pkgFile = path.join(pluginDir, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
    delete pkg.optionalDependencies;
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\\n");
    note("injected: pluginOnly installed package optionalDependencies erased (R9)");
  }
}
process.exit(result.status === 0 ? 0 : (result.status ?? 1));
`;

const NPM_SHIM = `#!/usr/bin/env node
const fs = require("node:fs");
const cp = require("node:child_process");
const real = process.env.DRILL_REAL_NPM;
const args = process.argv.slice(2);
const stateFile = process.env.DRILL_NPM_REGISTRY_STATE;
const logFile = process.env.DRILL_INJECTION_LOG;
function note(message) { if (logFile) fs.appendFileSync(logFile, message + "\\n"); }
if (args[0] === "publish") {
  const tarball = args[1] || "";
  const registryIndex = args.indexOf("--registry");
  const registry = registryIndex >= 0 ? args[registryIndex + 1] : "";
  const isCarrier = /-app\\.tgz$/.test(tarball);
  if (isCarrier && registry) {
    const first = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8").trim() : "";
    if (first === "") {
      fs.writeFileSync(stateFile, registry);
    } else if (first !== registry) {
      // 模拟"低上限发布因认证失败而根本没复现 E413"，且错误输出里带 413 字样（评审反例）。
      console.error("npm error code ENEEDAUTH");
      console.error("npm error need auth simulated for " + registry + " (hint path: " + (process.env.DRILL_STATE_HINT || "") + ")");
      note("injected: low-limit carrier publish forced ENEEDAUTH instead of real E413 (R5)");
      process.exit(1);
    }
  }
}
const result = cp.spawnSync(real, args, { stdio: "inherit", env: process.env });
process.exit(result.status === 0 ? 0 : (result.status ?? 1));
`;

test("R1 负向：用户 npmrc 把 @scope:registry 指向 B 时，指定 A 的演练不得向 B 发任何 PUT", { skip: SKIP }, async () => {
	const small = await makeFixtureDist({ apkBytes: crypto.randomBytes(64 * 1024) });
	const receivers = [];
	const listen = (label) => new Promise((resolve, reject) => {
		const events = [];
		const server = http.createServer((req, res) => {
			let size = 0;
			req.on("data", (chunk) => { size += chunk.length; });
			req.on("end", () => {
				events.push({ method: req.method, url: req.url, size });
				res.setHeader("content-type", "application/json");
				if (req.url === "/-/ping") { res.end("{}"); return; }
				if (req.method === "PUT") { res.statusCode = 201; res.end(JSON.stringify({ ok: true })); return; }
				res.statusCode = 200;
				res.end(JSON.stringify({ name: PLUGIN_NAME, versions: {}, "dist-tags": {} }));
			});
		});
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => resolve({ label, server, url: `http://127.0.0.1:${server.address().port}`, events }));
	});
	const intended = await listen("requested-registry");
	const scoped = await listen("scope-override-registry");
	receivers.push(intended, scoped);
	try {
		const userHome = join(scratch, "r1-user-home");
		await mkdir(userHome, { recursive: true });
		await writeFile(join(userHome, ".npmrc"), [
			`registry=${scoped.url}/`,
			`@marktrue:registry=${scoped.url}/`,
			`//127.0.0.1:${new URL(intended.url).port}/:_authToken=review-token`,
			`//127.0.0.1:${new URL(scoped.url).port}/:_authToken=review-token`,
			"",
		].join("\n"));
		const stateDir = join(scratch, "state-r1");
		const result = await runCliAsync({ args: ["--dist", small.dist, "--phases", "publish", "--registry", intended.url], stateDir, home: userHome });
		const putsToScoped = scoped.events.filter((event) => event.method === "PUT");
		const putsToIntended = intended.events.filter((event) => event.method === "PUT");
		assert.equal(putsToScoped.length, 0, `B(scope 覆盖源) 收到了发布请求：${JSON.stringify(scoped.events)}`);
		assert.ok(putsToIntended.length >= 1, `A(受检地址) 未收到发布请求：${JSON.stringify(intended.events)}`);
		assert.doesNotMatch(result.stdout, /drill-registry-scope-mismatch/, "专用配置自检不应失败");
		// 专用配置只迁移受检地址的凭据，不应把另一 registry 的 token 带进来。
		const { record } = await readRunRecord(stateDir);
		const configInfo = record.registry?.normalConfigInfo;
		assert.equal(configInfo?.host, `127.0.0.1:${new URL(intended.url).port}`);
		assert.equal(configInfo?.scope, "@marktrue");
		assert.deepEqual(configInfo?.migrated, [`//127.0.0.1:${new URL(intended.url).port}/:_authToken`]);
	} finally {
		for (const receiver of receivers) await new Promise((resolve) => receiver.server.close(resolve));
		await rm(small.base, { recursive: true, force: true });
	}
});

test("R4 负向：安装后篡改随包清单 plugin.contentSha256 → A13 必须 FAIL（drill-plugin-digest-mismatch）", { skip: SKIP || SKIP_VERDACCIO }, async () => {
	const shimDir = join(scratch, "shim-r4");
	await writeShim(shimDir, "pnpm", PNPM_SHIM);
	const stateDir = join(scratch, "state-r4");
	const result = runCli({
		args: ["--dist", fixture.dist, "--phases", "all"],
		stateDir,
		home: fixture.home,
		env: {
			PATH: `${shimDir}:${TOOL_PATH}`,
			DRILL_REAL_PNPM: REAL_PNPM,
			DRILL_PNPM_TAMPER: "carrier-manifest",
			DRILL_PNPM_COUNTER: join(scratch, "r4-counter"),
			DRILL_INJECTION_LOG: join(scratch, "r4-injections.log"),
			DRILL_PLUGIN_NAME: PLUGIN_NAME,
		},
	});
	assert.notEqual(result.status, 0, result.stdout);
	assert.match(result.stdout, /RESULT: FAIL/);
	const { record } = await readRunRecord(stateDir);
	const a13 = assertionOf(record, "A13");
	assert.ok(a13, "缺少 A13 记录");
	assert.equal(a13.pass, false);
	assert.equal(a13.reason, "drill-plugin-digest-mismatch");
	assert.match(result.stdout, /FAIL  A13 /);
});

test("R8 负向：lockfile/.modules 错误映射（正确名只在注释）→ A9/A10 必须 FAIL", { skip: SKIP || SKIP_VERDACCIO }, async () => {
	const shimDir = join(scratch, "shim-r8");
	await writeShim(shimDir, "pnpm", PNPM_SHIM);
	const stateDir = join(scratch, "state-r8");
	const result = runCli({
		args: ["--dist", fixture.dist, "--phases", "publish,install"],
		stateDir,
		home: fixture.home,
		env: {
			PATH: `${shimDir}:${TOOL_PATH}`,
			DRILL_REAL_PNPM: REAL_PNPM,
			DRILL_PNPM_TAMPER: "layout-alias",
			DRILL_PNPM_COUNTER: join(scratch, "r8-counter"),
			DRILL_INJECTION_LOG: join(scratch, "r8-injections.log"),
			DRILL_PLUGIN_NAME: PLUGIN_NAME,
		},
	});
	assert.notEqual(result.status, 0, result.stdout);
	const { record } = await readRunRecord(stateDir);
	const a9 = assertionOf(record, "A9");
	const a10 = assertionOf(record, "A10");
	assert.equal(a9?.pass, false);
	assert.equal(a9?.reason, "drill-lockfile-alias-missing");
	assert.equal(a10?.pass, false);
	assert.equal(a10?.reason, "drill-hoisted-mapping-missing");
	assert.match(result.stdout, /FAIL  A9 /);
	assert.match(result.stdout, /FAIL  A10 /);
});

test("R9 负向：安装后的 pluginOnly 未声明 optional 载体 → A17 必须 FAIL（drill-plugin-only-metadata-mismatch）", { skip: SKIP || SKIP_VERDACCIO }, async () => {
	const shimDir = join(scratch, "shim-r9");
	await writeShim(shimDir, "pnpm", PNPM_SHIM);
	const stateDir = join(scratch, "state-r9");
	const result = runCli({
		args: ["--dist", fixture.dist, "--phases", "all"],
		stateDir,
		home: fixture.home,
		env: {
			PATH: `${shimDir}:${TOOL_PATH}`,
			DRILL_REAL_PNPM: REAL_PNPM,
			DRILL_PNPM_TAMPER: "plugin-only-decl",
			DRILL_PNPM_COUNTER: join(scratch, "r9-counter"),
			DRILL_INJECTION_LOG: join(scratch, "r9-injections.log"),
			DRILL_PLUGIN_NAME: PLUGIN_NAME,
		},
	});
	assert.notEqual(result.status, 0, result.stdout);
	const { record } = await readRunRecord(stateDir);
	const a17 = assertionOf(record, "A17");
	assert.equal(a17?.pass, false);
	assert.equal(a17?.reason, "drill-plugin-only-metadata-mismatch");
	assert.match(result.stdout, /FAIL  A17 /);
});

test("R5 负向：低上限发布返回 ENEEDAUTH（错误路径含 413 字样）→ A20 不得 PASS", { skip: SKIP || SKIP_VERDACCIO }, async () => {
	const shimDir = join(scratch, "shim-r5");
	await writeShim(shimDir, "npm", NPM_SHIM);
	// 状态目录刻意包含 413：旧实现会因裸数字匹配把它误判成 E413。
	const stateDir = join(scratch, "state-r5-413");
	const result = runCli({
		args: ["--dist", fixture.dist, "--phases", "all"],
		stateDir,
		home: fixture.home,
		env: {
			PATH: `${shimDir}:${TOOL_PATH}`,
			DRILL_REAL_NPM: REAL_NPM,
			DRILL_NPM_REGISTRY_STATE: join(scratch, "r5-registry-state"),
			DRILL_INJECTION_LOG: join(scratch, "r5-injections.log"),
			DRILL_STATE_HINT: stateDir,
		},
	});
	assert.notEqual(result.status, 0, result.stdout);
	const { record } = await readRunRecord(stateDir);
	const a20 = assertionOf(record, "A20");
	assert.equal(a20?.pass, false);
	assert.equal(a20?.reason, "drill-e413-not-reproduced");
	assert.match(result.stdout, /FAIL  A20 /);
});
