// 自更新**执行引擎**的契约。
//
// 这里在临时目录里把整条链跑通：下载 → 校验 → 解包复核内容标识 → 落位 → 改 profile 依赖
// → 安装 → 写待生效状态；以及启动自检的回滚判定。所有会碰真实系统的动作（安装器、重启器）
// 都是注入的，因此**不会触碰真实宿主**——真实重启留在带证据的手工验收里。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { pluginContentDigest } from "../lib/plugin-content-digest.js";
import {
	MAX_ROLLBACK_ATTEMPTS,
	UPDATE_PHASE,
	buildRestartScript,
	decideRollback,
	detectRestartForm,
	downloadVerified,
	extractVerified,
	readUpdateState,
	restartPlan,
	runRestart,
	runSelfUpdate,
	settlePendingUpdate,
	switchDependencySpecifier,
	updateStateFile,
} from "../lib/plugin-self-update.js";

const PLUGIN_FILES = { "package.json": '{"name":"dsh-mobile-remote","version":"3.3.0"}\n', "lib/index.js": "export const v = '3.3.0';\n" };

async function makeTgz(base, files = PLUGIN_FILES) {
	const stage = join(base, "stage");
	await mkdir(join(stage, "package", "lib"), { recursive: true });
	for (const [rel, content] of Object.entries(files)) {
		await writeFile(join(stage, "package", rel), content);
	}
	const tgz = join(base, "plugin.tgz");
	const r = spawnSync("tar", ["-czf", tgz, "-C", stage, "package"], { encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	return { tgz, contentSha256: pluginContentDigest(join(stage, "package")), packageDir: join(stage, "package") };
}

async function serve(body) {
	const server = createServer((req, res) => {
		res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(body.length) });
		res.end(body);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address();
	return {
		url: `http://127.0.0.1:${port}/plugin.tgz`,
		close: async () => {
			server.close();
			await once(server, "close");
		},
	};
}

async function makeProfile(base, specifier = "file:/old/plugin") {	const profileDir = join(base, "profile");
	await mkdir(profileDir, { recursive: true });
	await writeFile(join(profileDir, "package.json"), `${JSON.stringify({
		name: "web-profile",
		dependencies: { "dsh-mobile-remote": specifier, qrcode: "^1.5.4" },
	}, null, 2)}\n`);
	return profileDir;
}

/** 写待生效状态（状态文件目录可能尚不存在）。 */
async function writeState(stateFile, state) {
	await mkdir(dirname(stateFile), { recursive: true });
	await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

// ── 下载与校验 ────────────────────────────────────────────────

test("downloadVerified：下载成功后按 sha256 与 size 校验", async () => {
	const base = await mkdtemp(join(tmpdir(), "self-update-"));
	const body = Buffer.from("tarball-bytes");
	const srv = await serve(body);
	try {
		const dest = join(base, "out.tgz");
		const r = await downloadVerified({
			url: srv.url,
			destPath: dest,
			sha256: createHash("sha256").update(body).digest("hex"),
			size: body.length,
		});
		assert.equal(r.ok, true, r.error);
		assert.equal(r.bytes, body.length);
		assert.equal((await readFile(dest)).toString(), body.toString());
	} finally {
		await srv.close();
		await rm(base, { recursive: true, force: true });
	}
});

test("downloadVerified：sha256 不符 → 失败且不留下文件", async () => {
	const base = await mkdtemp(join(tmpdir(), "self-update-"));
	const srv = await serve(Buffer.from("tampered"));
	try {
		const dest = join(base, "out.tgz");
		const r = await downloadVerified({ url: srv.url, destPath: dest, sha256: "0".repeat(64) });
		assert.equal(r.ok, false);
		assert.match(r.error, /sha256-mismatch/);
		assert.equal(await readFile(dest).then(() => true).catch(() => false), false);
	} finally {
		await srv.close();
		await rm(base, { recursive: true, force: true });
	}
});

test("downloadVerified：size 不符 → 失败", async () => {
	const base = await mkdtemp(join(tmpdir(), "self-update-"));
	const srv = await serve(Buffer.from("12345"));
	try {
		const r = await downloadVerified({ url: srv.url, destPath: join(base, "o.tgz"), size: 99 });
		assert.equal(r.ok, false);
		assert.match(r.error, /size-mismatch/);
	} finally {
		await srv.close();
		await rm(base, { recursive: true, force: true });
	}
});

test("downloadVerified：HTTP 错误与网络不可达都返回明确失败", async () => {
	const base = await mkdtemp(join(tmpdir(), "self-update-"));
	try {
		const http404 = await downloadVerified({
			url: "https://example.invalid/x",
			destPath: join(base, "x"),
			fetchImpl: async () => ({ ok: false, status: 404 }),
		});
		assert.equal(http404.ok, false);
		assert.match(http404.error, /download-http-404/);

		const thrown = await downloadVerified({
			url: "https://example.invalid/x",
			destPath: join(base, "y"),
			fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
		});
		assert.equal(thrown.ok, false);
		assert.match(thrown.error, /ECONNREFUSED/);

		assert.equal((await downloadVerified({ url: "", destPath: join(base, "z") })).error, "download-url-missing");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

// ── 解包与内容标识复核 ────────────────────────────────────────

test("extractVerified：解包后内容标识与清单一致才通过", async () => {
	const base = await mkdtemp(join(tmpdir(), "self-update-"));
	try {
		const built = await makeTgz(base);
		const r = extractVerified({ tgzPath: built.tgz, workDir: join(base, "w"), contentSha256: built.contentSha256 });
		assert.equal(r.ok, true, r.error);
		assert.equal(r.digest, built.contentSha256);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("extractVerified：内容标识不符 → 失败（版本号相同、内容不同的检出点）", async () => {
	const base = await mkdtemp(join(tmpdir(), "self-update-"));
	try {
		const built = await makeTgz(base);
		const r = extractVerified({ tgzPath: built.tgz, workDir: join(base, "w"), contentSha256: "f".repeat(64) });
		assert.equal(r.ok, false);
		assert.match(r.error, /content-sha256-mismatch/);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("extractVerified：解包失败或缺少 package/ 目录 → 明确失败", async () => {
	const base = await mkdtemp(join(tmpdir(), "self-update-"));
	try {
		assert.match(
			extractVerified({ tgzPath: "/nope.tgz", workDir: join(base, "w1"), runTar: () => ({ ok: false, error: "boom" }) }).error,
			/extract-failed/,
		);
		assert.equal(
			extractVerified({ tgzPath: "/nope.tgz", workDir: join(base, "w2"), runTar: () => ({ ok: true }) }).error,
			"extract-missing-package-dir",
		);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

// ── profile 依赖切换 ──────────────────────────────────────────

test("switchDependencySpecifier：改写依赖并保留其它字段", async () => {
	const base = await mkdtemp(join(tmpdir(), "self-update-"));
	try {
		const profileDir = await makeProfile(base);
		const r = switchDependencySpecifier({ profileDir, nextSpecifier: "file:/new/plugin" });
		assert.equal(r.ok, true, r.error);
		assert.equal(r.previous, "file:/old/plugin");
		const doc = JSON.parse(await readFile(join(profileDir, "package.json"), "utf8"));
		assert.equal(doc.dependencies["dsh-mobile-remote"], "file:/new/plugin");
		assert.equal(doc.dependencies.qrcode, "^1.5.4");
		assert.equal(doc.name, "web-profile");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("switchDependencySpecifier：profile 不可读或没有该依赖 → 明确失败", async () => {
	const base = await mkdtemp(join(tmpdir(), "self-update-"));
	try {
		const empty = join(base, "empty");
		await mkdir(empty, { recursive: true });
		await writeFile(join(empty, "package.json"), '{"dependencies":{}}\n');
		assert.equal(switchDependencySpecifier({ profileDir: empty, nextSpecifier: "file:/x" }).error, "profile-dependency-missing");
		assert.match(switchDependencySpecifier({ profileDir: join(base, "nope"), nextSpecifier: "file:/x" }).error, /profile-package-unreadable/);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

// ── 回滚判定与重启方案 ────────────────────────────────────────

test("decideRollback：无待生效 → 不动；内容符合预期 → 收敛为已生效", () => {
	assert.equal(decideRollback({ state: null, localContentSha256: "x" }).action, "none");
	assert.equal(decideRollback({ state: { phase: UPDATE_PHASE.STAGING }, localContentSha256: "x" }).action, "none");
	const ok = decideRollback({ state: { phase: UPDATE_PHASE.RESTART_PENDING, expectedContentSha256: "ab" }, localContentSha256: "AB" });
	assert.equal(ok.action, "clear");
});

test("decideRollback：内容不符 → 回滚；已回滚过一次 → 放弃（不重启风暴）", () => {
	const state = { phase: UPDATE_PHASE.RESTART_PENDING, expectedContentSha256: "ab", attempts: 0 };
	assert.equal(decideRollback({ state, localContentSha256: "cd" }).action, "rollback");
	assert.equal(decideRollback({ state: { ...state, attempts: MAX_ROLLBACK_ATTEMPTS }, localContentSha256: "cd" }).action, "give-up");
});

test("restartPlan：可监督的形态、前台形态、以及不支持自动重启的形态", () => {
	const systemd = restartPlan({ form: "web-systemd", pid: 4242 });
	assert.equal(systemd.mode, "supervised");
	assert.match(systemd.commands[0], /kill -TERM 4242/);

	const foreground = restartPlan({ form: "web-foreground", pid: 4242, profile: "web" });
	assert.equal(foreground.mode, "respawn");
	assert.match(foreground.commands[1], /dsh web --profile web/);

	const desktop = restartPlan({ form: "unsupported" });
	assert.equal(desktop.mode, "unsupported");
	assert.deepEqual(desktop.commands, []);
});

test("detectRestartForm：Windows / macOS 不自动重启", () => {
	assert.equal(detectRestartForm({ platform: "win32" }), "unsupported");
	assert.equal(detectRestartForm({ platform: "darwin" }), "unsupported");
	assert.equal(detectRestartForm({ platform: "linux", hasSystemdUnit: () => true }), "web-systemd");
	assert.equal(detectRestartForm({ platform: "linux", env: { DSH_WEB_FOREGROUND: "1" } }), "web-foreground");
	assert.equal(detectRestartForm({ platform: "linux" }), "unsupported");
});

test("buildRestartScript：脚本必须先等待再终止，且从宿主进程树脱离执行", () => {
	const supervised = buildRestartScript({ plan: restartPlan({ form: "web-systemd", pid: 4242 }), pid: 4242, delayMs: 3000 });
	assert.match(supervised, /^sleep 3; kill -TERM 4242$/);

	const respawn = buildRestartScript({ plan: restartPlan({ form: "web-foreground", pid: 4242, profile: "web" }), pid: 4242, delayMs: 1000 });
	assert.match(respawn, /^sleep 1; kill -TERM 4242; sleep 2; nohup dsh web --profile web/);

	// 不支持自动重启的形态不产出脚本（调用方须转为降级指引）
	assert.equal(buildRestartScript({ plan: restartPlan({ form: "unsupported" }), pid: 1 }), "");
	// 监督形态但没有 pid 时不乱猜目标
	assert.equal(buildRestartScript({ plan: restartPlan({ form: "web-systemd" }), pid: null }), "");
});

test("runRestart：以分离进程执行脚本；不支持的形态拒绝且不 spawn", () => {
	const calls = [];
	const fakeSpawn = (cmd, args, opts) => {
		calls.push({ cmd, args, opts });
		return { pid: 999, unref() {} };
	};
	const ok = runRestart({ plan: restartPlan({ form: "web-systemd", pid: 42 }), pid: 42, spawnImpl: fakeSpawn });
	assert.equal(ok.ok, true);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].cmd, "bash");
	assert.equal(calls[0].opts.detached, true);
	assert.deepEqual(calls[0].opts.stdio, "ignore");
	assert.match(calls[0].args[1], /kill -TERM 42/);

	const rejected = runRestart({ plan: restartPlan({ form: "unsupported" }), pid: 42, spawnImpl: fakeSpawn });
	assert.equal(rejected.ok, false);
	assert.equal(rejected.error, "restart-unsupported");
	assert.equal(calls.length, 1);
});

// ── 端到端（临时目录，注入安装器，不碰真实宿主）────────────────

test("runSelfUpdate 成功路径：下载→复核→落位→改依赖→安装→写待生效状态", async () => {
	const base = await mkdtemp(join(tmpdir(), "self-update-"));
	try {
		const built = await makeTgz(base);
		const body = await readFile(built.tgz);
		const srv = await serve(body);
		const profileDir = await makeProfile(base);
		const stateFile = updateStateFile(base);
		const workDir = join(base, "work");
		const stageRoot = join(base, "staged");
		const steps = [];
		try {
			const r = await runSelfUpdate({
				manifestUrl: "https://example.com/update/manifest.json",
				plugin: {
					version: "3.3.0",
					file: "dsh-mobile-remote-v3.3.0.tgz",
					url: srv.url,
					size: body.length,
					sha256: createHash("sha256").update(body).digest("hex"),
					contentSha256: built.contentSha256,
				},
				stateFile,
				workDir,
				profileDir,
				stageRoot,
				runInstall: () => ({ ok: true }),
				onStep: (s) => steps.push(s),
			});
			assert.equal(r.ok, true, r.error);
			assert.equal(r.state.phase, UPDATE_PHASE.RESTART_PENDING);
			assert.equal(r.state.expectedContentSha256, built.contentSha256);
			assert.equal(r.state.profileDir, profileDir);
			assert.deepEqual(steps, ["download", "verify", "extract", "switch", "install"]);

			const doc = JSON.parse(await readFile(join(profileDir, "package.json"), "utf8"));
			assert.equal(doc.dependencies["dsh-mobile-remote"], `file:${join(stageRoot, "3.3.0")}`);
			// 落位目录的内容标识与清单一致
			assert.equal(pluginContentDigest(join(stageRoot, "3.3.0")), built.contentSha256);
			assert.equal(readUpdateState(stateFile).phase, UPDATE_PHASE.RESTART_PENDING);
		} finally {
			await srv.close();
		}
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("runSelfUpdate：下载校验失败 → FAILED 且 profile 完全未动", async () => {
	const base = await mkdtemp(join(tmpdir(), "self-update-"));
	try {
		const built = await makeTgz(base);
		const srv = await serve(await readFile(built.tgz));
		const profileDir = await makeProfile(base);
		try {
			const r = await runSelfUpdate({
				manifestUrl: "https://example.com/manifest.json",
				plugin: { version: "3.3.0", file: "x.tgz", url: srv.url, size: null, sha256: "0".repeat(64), contentSha256: built.contentSha256 },
				stateFile: updateStateFile(base),
				workDir: join(base, "work"),
				profileDir,
				stageRoot: join(base, "staged"),
				runInstall: () => ({ ok: true }),
			});
			assert.equal(r.ok, false);
			assert.match(r.error, /sha256-mismatch/);
			const doc = JSON.parse(await readFile(join(profileDir, "package.json"), "utf8"));
			assert.equal(doc.dependencies["dsh-mobile-remote"], "file:/old/plugin");
		} finally {
			await srv.close();
		}
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("runSelfUpdate：内容标识不符 → FAILED 且 profile 未动（拒绝安装内容不同的包）", async () => {
	const base = await mkdtemp(join(tmpdir(), "self-update-"));
	try {
		const built = await makeTgz(base);
		const body = await readFile(built.tgz);
		const srv = await serve(body);
		const profileDir = await makeProfile(base);
		try {
			const r = await runSelfUpdate({
				manifestUrl: "https://example.com/manifest.json",
				plugin: {
					version: "3.3.0",
					file: "x.tgz",
					url: srv.url,
					size: body.length,
					sha256: createHash("sha256").update(body).digest("hex"),
					contentSha256: "a".repeat(64),
				},
				stateFile: updateStateFile(base),
				workDir: join(base, "work"),
				profileDir,
				stageRoot: join(base, "staged"),
				runInstall: () => ({ ok: true }),
			});
			assert.equal(r.ok, false);
			assert.equal(r.step, "extract");
			const doc = JSON.parse(await readFile(join(profileDir, "package.json"), "utf8"));
			assert.equal(doc.dependencies["dsh-mobile-remote"], "file:/old/plugin");
		} finally {
			await srv.close();
		}
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("runSelfUpdate：安装失败 → 依赖声明还原（失败但可用）", async () => {
	const base = await mkdtemp(join(tmpdir(), "self-update-"));
	try {
		const built = await makeTgz(base);
		const body = await readFile(built.tgz);
		const srv = await serve(body);
		const profileDir = await makeProfile(base);
		try {
			const r = await runSelfUpdate({
				manifestUrl: "https://example.com/manifest.json",
				plugin: {
					version: "3.3.0",
					file: "x.tgz",
					url: srv.url,
					size: body.length,
					sha256: createHash("sha256").update(body).digest("hex"),
					contentSha256: built.contentSha256,
				},
				stateFile: updateStateFile(base),
				workDir: join(base, "work"),
				profileDir,
				stageRoot: join(base, "staged"),
				runInstall: () => ({ ok: false, error: "pnpm-exit-1" }),
			});
			assert.equal(r.ok, false);
			assert.equal(r.step, "install");
			const doc = JSON.parse(await readFile(join(profileDir, "package.json"), "utf8"));
			assert.equal(doc.dependencies["dsh-mobile-remote"], "file:/old/plugin");
		} finally {
			await srv.close();
		}
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

// ── 启动自检与回滚 ────────────────────────────────────────────

test("settlePendingUpdate：新版生效 → 记为已生效，不再重启", async () => {
	const base = await mkdtemp(join(tmpdir(), "self-update-"));
	try {
		const built = await makeTgz(base);
		const stateFile = updateStateFile(base);
		const installed = join(base, "installed");
		await mkdir(installed, { recursive: true });
		// 把解包后的内容当作"已安装副本"
		const r = extractVerified({ tgzPath: built.tgz, workDir: join(base, "w"), contentSha256: built.contentSha256 });
		assert.equal(r.ok, true);
		const { renameSync } = await import("node:fs");
		renameSync(r.packageDir, installed);

		await writeState(stateFile, {
			phase: UPDATE_PHASE.RESTART_PENDING, expectedContentSha256: built.contentSha256, attempts: 0,
		});
		const settled = settlePendingUpdate({ stateFile, installedRoot: installed, runInstall: () => ({ ok: true }) });
		assert.equal(settled.action, "clear");
		assert.equal(readUpdateState(stateFile).phase, UPDATE_PHASE.SETTLED);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("settlePendingUpdate：新版未生效 → 换回旧依赖并再装一次（回滚）", async () => {
	const base = await mkdtemp(join(tmpdir(), "self-update-"));
	try {
		const profileDir = await makeProfile(base, "file:/new/plugin");
		const installed = join(base, "installed");
		await mkdir(installed, { recursive: true });
		await writeFile(join(installed, "package.json"), '{"name":"dsh-mobile-remote","version":"3.3.0"}\n');
		const stateFile = updateStateFile(base);
		await writeState(stateFile, {
			phase: UPDATE_PHASE.RESTART_PENDING,
			expectedContentSha256: "b".repeat(64),
			previousSpecifier: "file:/old/plugin",
			profileDir,
			attempts: 0,
		});

		const installs = [];
		const r = settlePendingUpdate({ stateFile, installedRoot: installed, runInstall: (p) => { installs.push(p); return { ok: true }; } });
		assert.equal(r.action, "rollback");
		assert.equal(installs.length, 1);
		const doc = JSON.parse(await readFile(join(profileDir, "package.json"), "utf8"));
		assert.equal(doc.dependencies["dsh-mobile-remote"], "file:/old/plugin");
		const st = readUpdateState(stateFile);
		assert.equal(st.attempts, 1);
		assert.equal(st.phase, UPDATE_PHASE.RESTART_PENDING);
		assert.equal(st.expectedContentSha256, "");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("settlePendingUpdate：回滚次数用尽 → 放弃并如实记为失败", async () => {
	const base = await mkdtemp(join(tmpdir(), "self-update-"));
	try {
		const profileDir = await makeProfile(base, "file:/new/plugin");
		const installed = join(base, "installed");
		await mkdir(installed, { recursive: true });
		await writeFile(join(installed, "package.json"), '{"name":"dsh-mobile-remote","version":"3.3.0"}\n');
		const stateFile = updateStateFile(base);
		await writeState(stateFile, {
			phase: UPDATE_PHASE.RESTART_PENDING,
			expectedContentSha256: "b".repeat(64),
			previousSpecifier: "file:/old/plugin",
			profileDir,
			attempts: MAX_ROLLBACK_ATTEMPTS,
		});

		const r = settlePendingUpdate({ stateFile, installedRoot: installed, runInstall: () => ({ ok: true }) });
		assert.equal(r.action, "give-up");
		assert.equal(readUpdateState(stateFile).error, "rollback-exhausted");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});
