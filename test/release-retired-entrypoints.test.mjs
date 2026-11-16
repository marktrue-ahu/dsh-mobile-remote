// 已退役的本机发布入口：fail-closed 回归（issue #113，维护者决策见 GitLab note 2783/2784）。
//
// 退役范围（只退役脚本侧，不删运行时人工区读取/API）：
//   - `UPDATE_DIR`：人工更新目录复制（自动更新走 npm，人工目录复制不再产生）；
//   - `MANIFEST_VERSION` / `ALLOW_TEST_MANIFEST_VERSION`：假版本清单测试路径。
//
// 契约：调用方仍传入这些变量时，`package-release.sh` 必须在**写任何产物/共享目录之前**
// 返回明确非零错误并说明已退役；静默忽略会让操作者误以为旧行为仍然生效。
//
// 断言有效性：修复前的脚本对 `UPDATE_DIR` 不打印退役说明（会继续执行到 APK 检查），
// 因此下面的错误码 + 退役说明 + 未创建目标目录断言在旧实现上会失败；不是恒真断言。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RELEASE_SH = join(ROOT, "dsh-mobile-app", "tools", "package-release.sh");
const DIST_DIR = join(ROOT, "dsh-mobile-app", "dist");
const RETIRED_MARK = /已退役（issue #113）/;
const RETIRED_VARS = ["UPDATE_DIR", "MANIFEST_VERSION", "ALLOW_TEST_MANIFEST_VERSION", "PLUGIN_URL"];

const scratch = mkdtempSync(join(tmpdir(), "release-retired-"));
after(() => {
	rmSync(scratch, { recursive: true, force: true });
});

function cleanEnv() {
	const env = { ...process.env };
	for (const key of RETIRED_VARS) delete env[key];
	return env;
}

function runRelease({ args = [], env = {}, cwd = scratch } = {}) {
	return spawnSync("bash", [RELEASE_SH, ...args], {
		cwd,
		env: { ...cleanEnv(), ...env },
		encoding: "utf8",
		timeout: 120_000,
	});
}

/** 断言：退役变量必须在写盘前 fail-closed，且没有留下目标目录/复制痕迹。 */
function assertFailClosed(result, varName, targetDir) {
	assert.notEqual(result.status, 0, `传入 ${varName} 必须非零退出：\n${result.stdout}\n${result.stderr}`);
	assert.match(result.stderr, RETIRED_MARK, `传入 ${varName} 必须给出退役说明：\n${result.stderr}`);
	assert.match(result.stderr, new RegExp(varName), `退役说明必须点名 ${varName}：\n${result.stderr}`);
	assert.equal(existsSync(targetDir), false, `退役变量不得创建目标目录：${targetDir}`);
	assert.doesNotMatch(`${result.stdout}${result.stderr}`, /Copied to updateDir/);
}

test("UPDATE_DIR 单独设置：不创建更新目录即 fail-closed", () => {
	const target = join(scratch, "update-dir-alone");
	const distBefore = existsSync(DIST_DIR);
	const result = runRelease({ env: { UPDATE_DIR: target } });

	assertFailClosed(result, "UPDATE_DIR", target);
	assert.match(result.stderr, /人工更新目录复制不再/);
	assert.equal(existsSync(DIST_DIR), distBefore, "退役变量不得创建/改动 dsh-mobile-app/dist");
});

test("MANIFEST_VERSION 单独设置：假版本清单路径 fail-closed", () => {
	const distBefore = existsSync(DIST_DIR);
	const result = runRelease({ env: { MANIFEST_VERSION: "9.9.9+99" } });

	assert.notEqual(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
	assert.match(result.stderr, RETIRED_MARK, `必须说明假版本路径已退役：\n${result.stderr}`);
	assert.match(result.stderr, /MANIFEST_VERSION/);
	assert.doesNotMatch(result.stderr, /is test-only; set ALLOW_TEST_MANIFEST_VERSION=1 explicitly/);
	assert.equal(existsSync(DIST_DIR), distBefore, "假版本路径不得创建/改动 dsh-mobile-app/dist");
});

test("MANIFEST_VERSION 与 ALLOW_TEST_MANIFEST_VERSION 同时设置：不产出假清单", () => {
	const cwd = join(scratch, "cwd-manifest-version");
	mkdirSync(cwd);
	const distBefore = existsSync(DIST_DIR);
	const result = runRelease({
		cwd,
		env: { MANIFEST_VERSION: "9.9.9+99", ALLOW_TEST_MANIFEST_VERSION: "1" },
	});

	assert.notEqual(result.status, 0, `旧「合法」组合不得再被接受：\n${result.stdout}\n${result.stderr}`);
	assert.match(result.stderr, RETIRED_MARK, `必须说明假版本路径已退役：\n${result.stderr}`);
	assert.match(result.stderr, /MANIFEST_VERSION/);
	assert.match(result.stderr, /ALLOW_TEST_MANIFEST_VERSION/);
	assert.doesNotMatch(`${result.stdout}${result.stderr}`, /WARN: MANIFEST_VERSION=/);
	assert.doesNotMatch(`${result.stdout}${result.stderr}`, /test manifest verification failed/);
	assert.deepEqual(readdirSync(cwd), [], "退化命令不得在调用目录写入任何文件");
	assert.equal(existsSync(DIST_DIR), distBefore, "假版本路径不得创建/改动 dsh-mobile-app/dist");
});

test("ALLOW_TEST_MANIFEST_VERSION 单独设置：fail-closed", () => {
	const result = runRelease({ env: { ALLOW_TEST_MANIFEST_VERSION: "1" } });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, RETIRED_MARK);
	assert.match(result.stderr, /ALLOW_TEST_MANIFEST_VERSION/);
	assert.doesNotMatch(result.stderr, /ALLOW_TEST_MANIFEST_VERSION=1 requires MANIFEST_VERSION/);
});

test("三个退役变量同时传入：仍 fail-closed 且不写任何目录", () => {
	const target = join(scratch, "update-dir-combo");
	const cwd = join(scratch, "cwd-combo");
	mkdirSync(cwd);
	const result = runRelease({
		cwd,
		env: {
			UPDATE_DIR: target,
			MANIFEST_VERSION: "9.9.9+99",
			ALLOW_TEST_MANIFEST_VERSION: "1",
		},
	});

	assertFailClosed(result, "UPDATE_DIR", target);
	assert.deepEqual(readdirSync(cwd), [], "组合退役变量不得在调用目录写入任何文件");
});

test("守卫位于任何产物写入之前，且退役分支没有残留（源码结构断言）", () => {
	const source = readFileSync(RELEASE_SH, "utf8");
	const updateGuard = source.search(/UPDATE_DIR 已退役（issue #113）/);
	const manifestGuard = source.search(/MANIFEST_VERSION \/ ALLOW_TEST_MANIFEST_VERSION 已退役/);
	const firstWrite = source.search(/mkdir -p "\$dist"/);

	assert.ok(updateGuard >= 0, "缺少 UPDATE_DIR 退役守卫");
	assert.ok(manifestGuard >= 0, "缺少 MANIFEST_VERSION/ALLOW_TEST_MANIFEST_VERSION 退役守卫");
	assert.ok(firstWrite >= 0, "找不到首个产物写入点（mkdir -p \"$dist\"）");
	assert.ok(updateGuard < firstWrite, "退役守卫必须在首个产物写入之前");
	assert.ok(manifestGuard < firstWrite, "退役守卫必须在首个产物写入之前");

	// 已删除的实现不得被重新引入：人工目录复制、假版本分支、手工 npm publish 提示。
	assert.doesNotMatch(source, /mkdir -p "\$UPDATE_DIR"/);
	assert.doesNotMatch(source, /Copied to updateDir/);
	assert.doesNotMatch(source, /Test manifest version must keep/);
	assert.doesNotMatch(source, /ALLOW_TEST_MANIFEST_VERSION.*!=.*"1"/);
	assert.doesNotMatch(source, /npm publish "/, "不得重新引入手工 npm publish 命令行提示");
});

test("--check-only 不受守卫影响：仍执行离线发布前预检", () => {
	const emptyDist = join(scratch, "check-only-dist");
	mkdirSync(emptyDist);
	const result = runRelease({ args: ["--check-only", emptyDist] });

	assert.doesNotMatch(result.stderr, RETIRED_MARK, `--check-only 不应触发退役守卫：\n${result.stderr}`);
	assert.match(result.stderr, /Publish preflight only \(no build, no npm publish\)/);
	assert.notEqual(result.status, 0, "空 dist 的预检必须失败");
	assert.match(result.stdout, /RESULT: FAIL/);
	assert.match(result.stdout, /dist-manifest-missing/);
});

test("--drill-only 不受守卫影响：仍进入演练 CLI（空 dist 失败即阻断）", () => {
	// 隔离演练状态目录，绝不能写共享运行态 ~/.dsh/mobile-remote/drill。
	const emptyDist = join(scratch, "drill-only-dist");
	mkdirSync(emptyDist);
	const home = join(scratch, "drill-home");
	mkdirSync(home);
	const stateDir = join(scratch, "drill-state");
	const result = runRelease({
		args: ["--drill-only", emptyDist],
		env: {
			HOME: home,
			DSH_HOME: join(home, ".dsh"),
			DSH_DRILL_STATE_DIR: stateDir,
		},
	});

	assert.doesNotMatch(result.stderr, RETIRED_MARK, `--drill-only 不应触发退役守卫：\n${result.stderr}`);
	assert.match(result.stderr, /Release drill only \(no build, no npm publish\)/);
	assert.notEqual(result.status, 0, "空 dist 的演练必须失败");
	assert.match(result.stdout, /RESULT: FAIL/);
	assert.equal(existsSync(stateDir), true, "演练证据应落在隔离状态目录");
});
