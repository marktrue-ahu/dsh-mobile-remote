// 插件自更新（CONTEXT「插件自更新」「更新接续」）的**执行引擎**。
//
// 本模块只做过程与判定，所有会碰真实系统的动作都通过参数注入（下载器、tar、包管理器、
// 重启器），因此可以在临时目录里把整条链跑通，而不触碰真实的宿主进程——「真实重启」
// 留在带证据的手工验收里（AGENT-RULES：真实服务测试不进自动门禁）。
//
// 为什么必须能回滚：这条链**必然包含一次宿主重启**（插件随进程加载，没有热重载），
// 而手机端可以独立触发它（ADR 0019），也就意味着**没有人守在电脑前**。因此流程写成
// 「先落位并记下待生效状态 → 重启 → 启动时自检 → 不符合预期就切回再重启一次（最多一次）」。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pluginContentDigest } from "./plugin-content-digest.js";

/** 待生效状态机所处的阶段。 */
export const UPDATE_PHASE = {
	/** 已下载正在校验；失败可安全放弃，无需重启。 */
	STAGING: "staging",
	/** 依赖已切换，等待重启生效；这是唯一需要启动时自检的阶段。 */
	RESTART_PENDING: "restart-pending",
	/** 已确认生效。 */
	SETTLED: "settled",
	/** 更新失败（含回滚用尽）。 */
	FAILED: "failed",
};

/** 自更新的全过程阶段名（用于进度回调与诊断）。 */
export const UPDATE_STEP = {
	DOWNLOAD: "download",
	VERIFY: "verify",
	EXTRACT: "extract",
	SWITCH: "switch",
	INSTALL: "install",
	RESTART: "restart",
};

export const MAX_ROLLBACK_ATTEMPTS = 1;

/** 待生效状态文件：放在插件自己的数据目录（与通知/队列同源，随宿主数据而非工作树）。 */
export function updateStateFile(home) {
	return join(home, ".dsh", "mobile-remote", "plugin-update-state.json");
}

export function readUpdateState(file) {
	try {
		const doc = JSON.parse(readFileSync(file, "utf8"));
		return doc && typeof doc === "object" ? doc : null;
	} catch {
		return null;
	}
}

export function writeUpdateState(file, state) {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	return state;
}

export function clearUpdateState(file) {
	try {
		rmSync(file, { force: true });
	} catch {
		// 清不掉不影响正确性：下次启动自检仍会按内容标识判定
	}
}

/**
 * 下载到文件并校验。**先落盘到临时名再改名**，避免半成品被当成成品。
 * `size`/`sha256` 任一不符即删除文件并失败——不做"先装上再说"。
 */
export async function downloadVerified({
	url,
	destPath,
	sha256,
	size = null,
	fetchImpl = fetch,
	onProgress,
} = {}) {
	if (!url) return { ok: false, error: "download-url-missing" };
	let response;
	try {
		response = await fetchImpl(url, { redirect: "follow" });
	} catch (e) {
		return { ok: false, error: `download-failed: ${e?.message ?? e}` };
	}
	if (!response?.ok) return { ok: false, error: `download-http-${response?.status ?? "?"}` };

	mkdirSync(dirname(destPath), { recursive: true });
	const tmpPath = `${destPath}.part`;
	let bytes = 0;
	try {
		const chunks = [];
		for await (const chunk of response.body ?? []) {
			chunks.push(Buffer.from(chunk));
			bytes += chunk.length;
			onProgress?.(bytes, size ?? response.headers?.get?.("content-length") ?? null);
		}
		const buf = Buffer.concat(chunks);
		bytes = buf.length;
		if (size !== null && bytes !== size) {
			return { ok: false, error: `download-size-mismatch: ${bytes} != ${size}` };
		}
		const digest = createHash("sha256").update(buf).digest("hex");
		if (sha256 && digest !== String(sha256).toLowerCase()) {
			return { ok: false, error: `download-sha256-mismatch: ${digest}` };
		}
		writeFileSync(tmpPath, buf);
		renameSync(tmpPath, destPath);
		return { ok: true, bytes, sha256: digest };
	} catch (e) {
		try {
			rmSync(tmpPath, { force: true });
		} catch {
			// 清理失败不掩盖原始错误
		}
		return { ok: false, error: `download-failed: ${e?.message ?? e}` };
	}
}

/**
 * 解包并复核**内容标识**：这是把「发布侧声明的内容」与「真正落到磁盘上的内容」钉在一起的一步。
 * 解包目录结构与发布脚本一致（tgz 顶层为 `package/`）。
 */
export function extractVerified({ tgzPath, workDir, contentSha256, runTar = defaultRunTar } = {}) {
	rmSync(workDir, { recursive: true, force: true });
	mkdirSync(workDir, { recursive: true });
	const r = runTar(tgzPath, workDir);
	if (!r?.ok) return { ok: false, error: `extract-failed: ${r?.error ?? "unknown"}` };
	const packageDir = join(workDir, "package");
	if (!existsSync(packageDir)) return { ok: false, error: "extract-missing-package-dir" };
	const digest = pluginContentDigest(packageDir);
	const expected = String(contentSha256 ?? "").toLowerCase();
	if (expected && digest !== expected) {
		return { ok: false, error: `content-sha256-mismatch: ${digest}`, digest, packageDir };
	}
	return { ok: true, digest, packageDir };
}

/** 默认解包器：系统 tar（Linux/macOS/Windows 10+ 均自带）。 */
export function defaultRunTar(tgzPath, destDir) {
	const r = spawnSync("tar", ["-xzf", tgzPath, "-C", destDir], { encoding: "utf8" });
	if (r.error) return { ok: false, error: r.error.message };
	if (r.status !== 0) return { ok: false, error: (r.stderr || `exit ${r.status}`).trim() };
	return { ok: true };
}

/**
 * 把解包好的版本目录记进 profile 的依赖声明——**这是让更新持久生效的关键**：
 * 只覆盖 node_modules 会被下一次 `pnpm install` 静默回滚（`file:` 依赖是 directory 类型、无 integrity）。
 */
export function switchDependencySpecifier({ profileDir, nextSpecifier, readJson = readJsonFile, writeJson = writeJsonFile } = {}) {
	const file = join(profileDir, "package.json");
	let doc;
	try {
		doc = readJson(file);
	} catch (e) {
		return { ok: false, error: `profile-package-unreadable: ${e?.message ?? e}` };
	}
	const deps = doc?.dependencies;
	if (!deps || typeof deps !== "object") return { ok: false, error: "profile-has-no-dependencies" };
	const previous = typeof deps["dsh-mobile-remote"] === "string" ? deps["dsh-mobile-remote"] : "";
	if (previous === "") return { ok: false, error: "profile-dependency-missing" };
	deps["dsh-mobile-remote"] = nextSpecifier;
	try {
		writeJson(file, doc);
	} catch (e) {
		return { ok: false, error: `profile-package-unwritable: ${e?.message ?? e}` };
	}
	return { ok: true, previous, next: nextSpecifier, file };
}

function readJsonFile(file) {
	return JSON.parse(readFileSync(file, "utf8"));
}

function writeJsonFile(file, doc) {
	writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

/** 运行包管理器安装（默认注入，可替换为假实现）。 */
export function defaultRunInstall(profileDir) {
	const r = spawnSync("pnpm", ["install"], { cwd: profileDir, encoding: "utf8" });
	if (r.error) return { ok: false, error: r.error.message };
	if (r.status !== 0) return { ok: false, error: (r.stderr || `exit ${r.status}`).trim() };
	return { ok: true };
}

/**
 * 启动时自检：待生效状态下，本地内容标识是否符合预期。
 * 不符合就切回上一次的依赖声明并再重启一次（**最多一次**，避免重启风暴）。
 */
export function decideRollback({ state, localContentSha256, maxAttempts = MAX_ROLLBACK_ATTEMPTS } = {}) {
	if (!state || state.phase !== UPDATE_PHASE.RESTART_PENDING) {
		return { action: "none", reason: "no-pending-update" };
	}
	const expected = String(state.expectedContentSha256 ?? "").toLowerCase();
	const local = String(localContentSha256 ?? "").toLowerCase();
	if (expected !== "" && local === expected) return { action: "clear", reason: "installed-as-expected" };
	const attempts = Number.isFinite(state.attempts) ? state.attempts : 0;
	if (attempts >= maxAttempts) return { action: "give-up", reason: "rollback-exhausted" };
	return { action: "rollback", reason: expected === "" ? "expected-digest-missing" : "installed-digest-mismatch" };
}

/**
 * 重启方案。**不做热重载**（不存在该通道），所以只有"宿主的监督者把它拉起来"或
 * "我们自己在旧进程退出后重新拉起"两种。Desktop 形态没有可移植的自重启能力 → 不自动。
 */
export function restartPlan({ form, pid = null, profile = "web", dshCommand = "dsh" } = {}) {
	switch (form) {
	case "web-systemd":
		return {
			mode: "supervised",
			steps: ["终止当前宿主进程", "由 systemd 的 Restart=always 用原参数拉起"],
			commands: pid ? [`kill -TERM ${pid}`] : ["systemctl --user restart dsh-web.service"],
		};
	case "web-foreground":
		return {
			mode: "respawn",
			steps: ["终止当前宿主进程", "由分离脚本重新拉起 dsh web"],
			commands: pid ? [`kill -TERM ${pid}`, `${dshCommand} web --profile ${profile}`] : [`${dshCommand} web --profile ${profile}`],
		};
	default:
		return {
			mode: "unsupported",
			steps: ["当前形态不支持自动重启（DSH Desktop / macOS 需要人工重启）"],
			commands: [],
		};
	}
}

/** 识别本机可自动重启的形态；识别不出就返回 unsupported（交给降级指引）。 */
export function detectRestartForm({ env = {}, platform = process.platform, hasSystemdUnit = () => false } = {}) {
	if (platform === "win32" || platform === "darwin") return "unsupported";
	if (hasSystemdUnit()) return "web-systemd";
	if (env.DSH_PROFILE || env.DSH_WEB_FOREGROUND === "1") return "web-foreground";
	return "unsupported";
}

/**
 * 执行一次自更新。
 *
 * 顺序即安全性：**先下载校验、再解包复核、最后才动 profile**——任何一步失败都可以直接放弃，
 * 此时还没有发生任何需要重启的变更。只有在 `switch` + `install` 成功之后才写
 * `restart-pending` 标记，随后交给重启器。
 */
export async function runSelfUpdate({
	manifestUrl,
	plugin,
	stateFile,
	workDir,
	profileDir,
	stageRoot,
	expectedVersion = "",
	fetchImpl = fetch,
	runTar = defaultRunTar,
	runInstall = defaultRunInstall,
	onStep = () => {},
	log = () => {},
} = {}) {
	const state = {
		phase: UPDATE_PHASE.STAGING,
		startedAt: new Date().toISOString(),
		manifestUrl,
		profileDir,
		expectedVersion: expectedVersion || plugin?.version || "",
		expectedContentSha256: String(plugin?.contentSha256 ?? "").toLowerCase(),
		attempts: 0,
	};
	writeUpdateState(stateFile, state);

	const tgzPath = join(workDir, `${plugin.file || "plugin.tgz"}`);

	onStep(UPDATE_STEP.DOWNLOAD);
	let r = await downloadVerified({ url: plugin.url, destPath: tgzPath, sha256: plugin.sha256, size: plugin.size, fetchImpl });
	if (!r.ok) {
		state.phase = UPDATE_PHASE.FAILED;
		state.error = r.error;
		writeUpdateState(stateFile, state);
		return { ok: false, step: UPDATE_STEP.DOWNLOAD, error: r.error };
	}
	state.tgzSha256 = r.sha256;
	state.tgzPath = tgzPath;

	onStep(UPDATE_STEP.VERIFY);
	onStep(UPDATE_STEP.EXTRACT);
	const staged = extractVerified({ tgzPath, workDir: join(workDir, "extract"), contentSha256: plugin.contentSha256, runTar });
	if (!staged.ok) {
		state.phase = UPDATE_PHASE.FAILED;
		state.error = staged.error;
		writeUpdateState(stateFile, state);
		return { ok: false, step: UPDATE_STEP.EXTRACT, error: staged.error };
	}
	state.contentSha256 = staged.digest;

	// 版本化落位：每个版本一个目录，回滚只需换回旧的依赖声明
	const stagedDir = join(stageRoot, state.expectedVersion || "unknown");
	rmSync(stagedDir, { recursive: true, force: true });
	mkdirSync(dirname(stagedDir), { recursive: true });
	renameSync(staged.packageDir, stagedDir);
	state.stagedDir = stagedDir;

	onStep(UPDATE_STEP.SWITCH);
	const nextSpecifier = `file:${stagedDir}`;
	const switched = switchDependencySpecifier({ profileDir, nextSpecifier });
	if (!switched.ok) {
		state.phase = UPDATE_PHASE.FAILED;
		state.error = switched.error;
		writeUpdateState(stateFile, state);
		return { ok: false, step: UPDATE_STEP.SWITCH, error: switched.error };
	}
	state.previousSpecifier = switched.previous;
	state.nextSpecifier = nextSpecifier;

	onStep(UPDATE_STEP.INSTALL);
	const installed = runInstall(profileDir);
	if (!installed?.ok) {
		// 安装失败：把依赖声明还原，保持"失败但可用"
		switchDependencySpecifier({ profileDir, nextSpecifier: switched.previous });
		state.phase = UPDATE_PHASE.FAILED;
		state.error = installed?.error ?? "install-failed";
		writeUpdateState(stateFile, state);
		return { ok: false, step: UPDATE_STEP.INSTALL, error: state.error };
	}

	state.phase = UPDATE_PHASE.RESTART_PENDING;
	state.installedAt = new Date().toISOString();
	writeUpdateState(stateFile, state);
	log(`mobile-remote: 插件已更新到 ${state.expectedVersion}，等待重启生效`);
	return { ok: true, step: UPDATE_STEP.RESTART, state };
}

/**
 * 启动自检：处于 restart-pending 时确认新版本是否真的生效，不符合就回滚。
 * 返回动作供调用方决定是否触发重启。
 */
export function settlePendingUpdate({ stateFile, installedRoot, runInstall = defaultRunInstall, maxAttempts = MAX_ROLLBACK_ATTEMPTS } = {}) {
	const state = readUpdateState(stateFile);
	const localDigest = existsSync(installedRoot) ? pluginContentDigest(installedRoot) : "";
	const decision = decideRollback({ state, localContentSha256: localDigest, maxAttempts });

	if (decision.action === "none") return { action: "none", reason: decision.reason, state };
	if (decision.action === "clear") {
		state.phase = UPDATE_PHASE.SETTLED;
		state.settledAt = new Date().toISOString();
		writeUpdateState(stateFile, state);
		return { action: "clear", reason: decision.reason, state };
	}
	if (decision.action === "give-up") {
		state.phase = UPDATE_PHASE.FAILED;
		state.error = "rollback-exhausted";
		writeUpdateState(stateFile, state);
		return { action: "give-up", reason: decision.reason, state };
	}

	// rollback：换回旧的依赖声明并重装，随后调用方需要再重启一次
	if (!state.previousSpecifier) {
		state.phase = UPDATE_PHASE.FAILED;
		state.error = "rollback-target-missing";
		writeUpdateState(stateFile, state);
		return { action: "give-up", reason: "rollback-target-missing", state };
	}
	const profileDir = state.profileDir ?? "";
	if (profileDir === "") {
		state.phase = UPDATE_PHASE.FAILED;
		state.error = "rollback-profile-unknown";
		writeUpdateState(stateFile, state);
		return { action: "give-up", reason: "rollback-profile-unknown", state };
	}
	const restored = switchDependencySpecifier({ profileDir, nextSpecifier: state.previousSpecifier });
	if (!restored.ok) {
		state.phase = UPDATE_PHASE.FAILED;
		state.error = restored.error;
		writeUpdateState(stateFile, state);
		return { action: "give-up", reason: restored.error, state };
	}
	runInstall(profileDir);
	state.attempts = (Number.isFinite(state.attempts) ? state.attempts : 0) + 1;
	state.rolledBackTo = state.previousSpecifier;
	state.phase = UPDATE_PHASE.RESTART_PENDING;
	state.expectedContentSha256 = ""; // 回滚后不再期望新版内容
	writeUpdateState(stateFile, state);
	return { action: "rollback", reason: decision.reason, state };
}
