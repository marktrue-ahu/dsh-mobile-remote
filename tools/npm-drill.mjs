#!/usr/bin/env node
// 发版演练 CLI（issue #37）：用**临时本地 registry**完整预演「发布 → 全新安装 → 载体发现 →
// 版本更新 → 失败路径」，不接触公共 npm、不消耗任何公共版本号；演练通过才进入正式发布。
//
// 唯一测试 seam 就是本 CLI：退出码 + 逐条 PASS/FAIL + 结尾 `RESULT:` + 稳定 `drill-` reason，
// 以及结构化运行记录 `<状态目录>/drill/<UTC>-<演练版本>/run.json` 与证据日志。
//
// 输出：
//   PASS/FAIL  <断言ID> <标题> [reason:<code>] (detail)
//   RESULT: PASS|FAIL
//   REASONS: none|<code,...>
//   DURATION: <秒>
//   EVIDENCE: <运行记录目录>
//
// 阶段（--phases，逗号分隔；默认 all）：
//   preflight  离线：校验源产物不变量（真实插件 tgz/精确别名/内容标识）并对源 dist 跑发布前预检
//   publish    发布：插件/载体发布、可查询、dist-tags、重复发布被拒        （A1–A4）
//   install    全新安装：隔离 HOME + 新 profile、别名目录、lockfile/hoisted（A5–A10）
//   discover   真实布局发现：载体发现、清单 App 版本、插件内容标识          （A11–A13）
//   update     版本更新：发布第二对版本、原安装更新、旧载体被替换           （A14–A16）
//   failure    失败路径：只发插件降级、预检稳定 reason、E413                （A17–A20）
//
// 稳定 reason（统一 `drill-` 前缀；完整词表见 lib/npm-drill/reasons.mjs）：
//   CLI/输入：drill-cli-invalid-argument、drill-phases-invalid、drill-dist-missing、
//             drill-dist-unreadable、drill-dist-preflight-failed、drill-build-failed、
//             drill-version-namespace-invalid
//   registry：drill-registry-not-installed、drill-registry-start-failed、drill-registry-not-alive、
//             drill-registry-not-allowed、drill-registry-low-limit-not-ready、
//             drill-registry-scope-mismatch（实际生效路由（含 scoped registry）≠ 受检地址）
//   源产物：  drill-source-plugin-metadata-mismatch、drill-source-optional-alias-missing、
//             drill-source-content-digest-mismatch、drill-source-artifact-mismatch
//             drill-registry-low-limit-not-ready
//   发布：    drill-projection-failed、drill-publish-failed、drill-carrier-publish-failed、
//             drill-publish-version-missing、drill-dist-tag-mismatch、drill-republish-not-rejected、
//             drill-second-pair-publish-failed
//   安装：    drill-install-failed、drill-plugin-not-installed、drill-carrier-alias-missing、
//             drill-carrier-identity-mismatch、drill-apk-bytes-mismatch、
//             drill-lockfile-alias-missing、drill-hoisted-mapping-missing
//   发现/身份：drill-carrier-not-found、drill-carrier-discovery-source-mismatch、
//             drill-carrier-manifest-app-mismatch、drill-plugin-digest-mismatch
//   更新：    drill-update-failed、drill-carrier-not-replaced
//   失败路径：drill-optional-missing-degraded-mismatch、drill-plugin-only-metadata-mismatch、
//             drill-missing-carrier-unexpectedly-present、drill-preflight-unexpected-pass、
//             drill-preflight-reason-mismatch、drill-e413-not-reproduced
//   发现/安装补充：drill-installed-carrier-manifest-mismatch
//             drill-preflight-reason-mismatch、drill-e413-not-reproduced
//   兜底：    drill-setup-failed、drill-assertion-failed
//
// 硬约束：本工具不发布任何公共包（临时 registry 只绑 127.0.0.1；--registry 默认只允许
// 本机/私网地址，远端需 DRILL_ALLOW_REMOTE_REGISTRY=1 显式放行）；
// 不自动安装 Verdaccio（只检查并提示 `npm i -g verdaccio@6.10.6`）；不修改本机 profile。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	ensureDir, commandVersion, existsDir, existsFile, isolatedEnv, readTextFile, removeDir, runCommand, writeTextFile,
} from "./lib/npm-drill/process.mjs";
import {
	LOW_LIMIT_MAX_BODY, NORMAL_MAX_BODY, buildIsolatedUserConfig, detectVerdaccio,
	ensureRegistryUser, startVerdaccio, stopVerdaccio, verifyRegistryScope, waitForRegistry,
	writeEmptyGlobalConfig,
} from "./lib/npm-drill/registry.mjs";
import { readDistAssets } from "./lib/npm-drill/projection.mjs";
import {
	beginPhase, createRunRecord, endPhase, finalizeRecord, printCliFailure, printPhaseHeader,
	printRunSummary, recordAssertion, utcStamp,
} from "./lib/npm-drill/report.mjs";
import { REASONS } from "./lib/npm-drill/reasons.mjs";
import { REGISTRY_PHASES, prepareProjection, PHASES } from "./lib/npm-drill/phases.mjs";
import { createDrillVersions, validateDrillVersions } from "./lib/npm-drill/versions.mjs";

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
// 演练属于**插件发布**（tools/ 侧）：从仓库根 tools/npm-drill.mjs 运行，仓库根在上层。
const REPO_ROOT = path.resolve(TOOLS_DIR, "..");
const ALL_PHASES = ["preflight", ...REGISTRY_PHASES];

const HELP_TEXT = `npm-drill — 发版演练（本地 registry，全程不接触公共 npm）

用法:
  node tools/npm-drill.mjs [选项]

选项:
  --dist <目录>       发布产物目录（含 manifest.json / APK / 插件 tgz / carrier tgz / app-carrier.json）
                      默认 dsh-mobile-app/dist
  --phases <列表>     逗号分隔：preflight,publish,install,discover,update,failure
                      "all" = preflight + 五个 registry 阶段；默认 all
                      preflight 是离线阶段（不需要 registry）；其余阶段需要 Verdaccio
  --registry <url>    复用已有 registry（跳过启动正常实例；低上限失败实例仍本机启动）
                      只从用户 npmrc 迁移**该地址**凭据；路由由专用配置固定（见下）
  --keep              保留演练现场（工作目录 / registry 存储 / 全部日志）
  --build             演练前先运行发布构建（dsh-mobile-app/tools/package-release.sh）
  -h, --help          打印本帮助并退出 0

安全围栏（复用 registry 时）:
  演练不继承调用方的 NPM_CONFIG_USERCONFIG/registry 路由：每个受检 registry 都会生成专用
  npm 配置（registry=<受检地址> + @<scope>:registry=<受检地址>，只迁移目标 host 凭据），
  并在发布/安装前用 npm config get 自检；实际生效值≠受检地址即 fail-closed
  （reason: drill-registry-scope-mismatch）。

环境变量:
  DSH_DRILL_STATE_DIR  覆盖状态目录（默认 <DSH_HOME|~/.dsh>/mobile-remote/drill）
  NPM_DRILL=1          仅测试套件使用：开启真实 registry 的端到端演练

输出与退出码:
  逐条 PASS/FAIL（失败带 [reason:drill-*]）、RESULT: PASS|FAIL、REASONS、DURATION、EVIDENCE。
  退出码 0 = 全部断言 PASS；非 0 = 有断言/环境/参数错误（fail-closed）。

运行记录:
  <状态目录>/drill/<UTC>-<演练版本>/run.json（阶段/断言/结果/reason/耗时）+ logs/ 证据日志。
  失败时自动保留现场；成功默认清理临时现场，--keep 可保留。

示例:
  node tools/npm-drill.mjs --dist dsh-mobile-app/dist
  node tools/npm-drill.mjs --dist dsh-mobile-app/dist --phases preflight
  node tools/npm-drill.mjs --dist dsh-mobile-app/dist --phases publish,install --keep
`;

class DrillSetupError extends Error {
	constructor(reason, detail) {
		super(detail ?? reason);
		this.name = "DrillSetupError";
		this.reason = reason;
		this.detail = detail ?? "";
	}
}

class AbortRun extends Error {
	constructor() {
		super("drill-aborted");
		this.name = "AbortRun";
	}
}

function parseArgs(argv) {
	const args = { dist: "", phases: "all", registry: "", keep: false, build: false, help: false, unknown: [] };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "-h" || arg === "--help") {
			args.help = true;
		} else if (arg === "--keep") {
			args.keep = true;
		} else if (arg === "--build") {
			args.build = true;
		} else if (["--dist", "--phases", "--registry"].includes(arg)) {
			const value = argv[++i];
			if (value === undefined || value.startsWith("--")) {
				args.unknown.push(`${arg}（缺少取值）`);
				continue;
			}
			args[arg.slice(2)] = value;
		} else {
			args.unknown.push(arg);
		}
	}
	return args;
}

function resolveSelectedPhases(raw) {
	const requested = String(raw ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
	if (requested.length === 0) return { ok: false, requested: ["<空>"] };
	let expanded;
	if (requested.includes("all")) expanded = [...ALL_PHASES];
	else expanded = requested;
	const unknown = expanded.filter((name) => !ALL_PHASES.includes(name));
	if (unknown.length > 0) return { ok: false, requested: unknown };
	const selected = ALL_PHASES.filter((name) => expanded.includes(name));
	return { ok: true, selected, needsRegistry: selected.some((name) => REGISTRY_PHASES.includes(name)) };
}

function resolveStateBase() {
	const explicit = typeof process.env.DSH_DRILL_STATE_DIR === "string" ? process.env.DSH_DRILL_STATE_DIR.trim() : "";
	if (explicit !== "") return path.resolve(explicit);
	const dshHome = typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.trim() !== ""
		? process.env.DSH_HOME.trim()
		: path.join(os.homedir(), ".dsh");
	return path.join(path.resolve(dshHome), "mobile-remote", "drill");
}

async function runEnvToolVersions(ctx) {
	const env = isolatedEnv({ home: ctx.home });
	const [npm, pnpm] = await Promise.all([
		commandVersion({ command: "npm", env, logFile: null }),
		commandVersion({ command: "pnpm", env, logFile: null }),
	]);
	return {
		node: process.version,
		npm: npm.ok ? npm.version : null,
		pnpm: pnpm.ok ? pnpm.version : null,
		platform: process.platform,
		arch: process.arch,
	};
}

function logsOf(ctx) {
	return ctx.logsDir;
}

/** 在临时 registry 上注册一次性用户并生成**专用** npm 配置（R1：固定 registry + scope）。 */
async function provisionRegistryCredentials(ctx, { url, label, logFile }) {
	const username = "drill";
	const password = crypto.randomBytes(18).toString("base64url");
	const user = await ensureRegistryUser({
		url,
		username,
		password,
		email: "drill@drill.invalid",
		logFile,
	});
	if (!user.ok) return { ok: false, detail: user.detail };
	const built = buildIsolatedUserConfig({
		runDir: ctx.runDir,
		label,
		registryUrl: url,
		pluginName: ctx.mainPackage.name,
		env: process.env,
		authToken: user.token,
	});
	return { ok: true, token: user.token, userconfig: built.path, built };
}

/**
 * R1：生成并**自检**一个受检 registry 的专用 npm 配置。
 * 覆盖模式的关键攻击是用户 npmrc 的 `@scope:registry` 覆盖了 `--registry`，因此这里固定
 * registry/scope 并只迁移目标 host 凭据；随后用 `npm config get` 验证实际生效值。
 */
async function prepareRegistryConfig(ctx, { url, label, logFile, sourceUserConfigPath = "", authToken = "" }) {
	const built = buildIsolatedUserConfig({
		runDir: ctx.runDir,
		label,
		registryUrl: url,
		pluginName: ctx.mainPackage.name,
		sourceUserConfigPath,
		env: process.env,
		authToken,
	});
	const globalconfig = writeEmptyGlobalConfig({ runDir: ctx.runDir, label });
	const check = await verifyRegistryScope({
		registryUrl: url,
		userconfig: built.path,
		globalconfig,
		pluginName: ctx.mainPackage.name,
		env: isolatedEnv({ home: ctx.home }),
		logFile,
	});
	if (!check.ok) {
		throw new DrillSetupError(
			REASONS.REGISTRY_SCOPE_MISMATCH,
			`专用 npm 配置未把 registry 与 ${built.scope || "@scope"}:registry 钉在受检地址：${check.detail}`,
		);
	}
	return { userconfig: built.path, globalconfig, built, check };
}

/** 读取调用方的用户 npmrc 路径（只用于**迁移目标 host 凭据**；不会被继承为路由）。 */
function resolveUserNpmrcPath() {
	const explicit = process.env.NPM_CONFIG_USERCONFIG || process.env.npm_config_userconfig
		|| process.env.NPM_DRILL_REGISTRY_USERCONFIG;
	if (typeof explicit === "string" && explicit.trim() !== "") return explicit.trim();
	const candidate = path.join(os.homedir(), ".npmrc");
	return existsFile(candidate) ? candidate : "";
}

/** 本机/私网地址判定：--registry 默认只允许这些地址，防止误把演练版本发到公共 npm（版本不可回收）。 */
function localRegistryHost(hostname) {
	const host = String(hostname ?? "").toLowerCase();
	if (host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]" || host === "0.0.0.0") return true;
	if (/^10\./.test(host) || /^192\.168\./.test(host)) return true;
	if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
	if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
	return false;
}

/** 起正常演练 registry 或验证复用地址；失败抛 DrillSetupError。 */
async function prepareNormalRegistry(ctx, options) {
	const env = isolatedEnv({ home: ctx.home });
	if (options.registry !== "") {
		const url = options.registry.replace(/\/+$/, "");
		// R2：默认只允许本机/私网地址。误指公共 npm 会把 9.9.x 演练版本真的发上去（不可回收），
		// 这正是本工具要避免的后果；确需受信内源时用 DRILL_ALLOW_REMOTE_REGISTRY=1 显式放行。
		let parsedUrl;
		try {
			parsedUrl = new URL(url);
		} catch {
			throw new DrillSetupError(REASONS.CLI_INVALID_ARGUMENT, `--registry 不是合法 URL：${url}`);
		}
		const remoteAllowed = process.env.DRILL_ALLOW_REMOTE_REGISTRY === "1";
		if (!localRegistryHost(parsedUrl.hostname) && !remoteAllowed) {
			throw new DrillSetupError(
				REASONS.REGISTRY_NOT_ALLOWED,
				`--registry 拒绝非本机/私网地址（${parsedUrl.hostname}）：演练会向该地址发布演练版本（不可回收）。确为受信内源时设置 DRILL_ALLOW_REMOTE_REGISTRY=1 后重试`,
			);
		}
		ctx.registry.remoteAllowed = !localRegistryHost(parsedUrl.hostname);
		try {
			const response = await fetch(new URL("/-/ping", url), { signal: AbortSignal.timeout(8_000) });
			void response.arrayBuffer().catch(() => {});
		} catch (error) {
			throw new DrillSetupError(REASONS.REGISTRY_NOT_ALIVE, `--registry ${url} 不可达：${String(error?.message ?? error).slice(0, 200)}`);
		}
		// R1：**不复用**调用方 NPM_CONFIG_USERCONFIG；只从中迁移该地址凭据，路由由专用配置固定。
		const fence = await prepareRegistryConfig(ctx, {
			url,
			label: "normal",
			logFile: path.join(logsOf(ctx), "npm-config-selfcheck.log"),
			sourceUserConfigPath: resolveUserNpmrcPath(),
		});
		ctx.registry.mode = "reused";
		ctx.registry.normalUrl = url;
		ctx.registry.normalUserConfig = fence.userconfig;
		ctx.registry.normalGlobalConfig = fence.globalconfig;
		ctx.registry.normalScopeCheck = fence.check;
		ctx.registry.normalConfigInfo = fence.built;
		return;
	}
	const verdaccio = await detectVerdaccio({ env, logFile: path.join(ctx.logsDir, "verdaccio-detect.log") });
	ctx.registry.verdaccio = verdaccio;
	if (!verdaccio.ok) {
		throw new DrillSetupError(
			REASONS.REGISTRY_NOT_INSTALLED,
			`未找到全局 Verdaccio（演练需要）。安装一次：${verdaccio.hint}${verdaccio.detail ? `；${verdaccio.detail}` : ""}`,
		);
	}
	const handle = await startVerdaccio({
		runDir: ctx.runDir,
		name: "normal",
		env,
		logFile: path.join(ctx.logsDir, "verdaccio-normal.log"),
		maxBodySize: NORMAL_MAX_BODY,
	});
	ctx.registry.normalHandle = handle;
	const ready = await waitForRegistry(handle.url);
	if (!ready.ok) {
		throw new DrillSetupError(
			REASONS.REGISTRY_START_FAILED,
			`Verdaccio 未就绪（${handle.url}）：${ready.detail}${handle.spawnError ? `；${handle.spawnError}` : ""}`,
		);
	}
	const credentials = await provisionRegistryCredentials(ctx, { url: handle.url, label: "normal", logFile: path.join(logsOf(ctx), "verdaccio-normal.log") });
	if (!credentials.ok) {
		throw new DrillSetupError(REASONS.REGISTRY_START_FAILED, `创建演练发布凭据失败：${credentials.detail}`);
	}
	const fence = await prepareRegistryConfig(ctx, {
		url: handle.url,
		label: "normal",
		logFile: path.join(logsOf(ctx), "npm-config-selfcheck.log"),
		authToken: credentials.token,
	});
	ctx.registry.mode = "spawned";
	ctx.registry.normalUrl = handle.url;
	ctx.registry.normalUserConfig = fence.userconfig;
	ctx.registry.normalGlobalConfig = fence.globalconfig;
	ctx.registry.normalScopeCheck = fence.check;
	ctx.registry.normalConfigInfo = fence.built;
}

/** 失败路径的低上限实例（10mb）：懒启动，复现 E413。 */
async function ensureLowLimitRegistry(ctx) {
	if (ctx.registry.lowLimitUrl) return { ok: true, url: ctx.registry.lowLimitUrl };
	// R1：复用模式下 prepareNormalRegistry 不再检测 Verdaccio，但低上限实例仍要求本机可启动，
	// 因此这里懒检测一次（失败不抛，按未安装处理）。
	if (!ctx.registry.verdaccio?.ok) {
		try {
			const detectEnv = isolatedEnv({ home: ctx.home });
			ctx.registry.verdaccio = await detectVerdaccio({
				env: detectEnv,
				logFile: path.join(ctx.logsDir, "verdaccio-detect-low-limit.log"),
			});
		} catch {
			// 检测失败按未安装处理
		}
	}
	if (!ctx.registry.verdaccio?.ok) {
		return { ok: false, detail: "需要全局 Verdaccio 启动低上限（10mb）实例" };
	}
	const env = isolatedEnv({ home: ctx.home });
	const handle = await startVerdaccio({
		runDir: ctx.runDir,
		name: "low-limit",
		env,
		logFile: path.join(ctx.logsDir, "verdaccio-low-limit.log"),
		maxBodySize: LOW_LIMIT_MAX_BODY,
	});
	ctx.registry.lowLimitHandle = handle;
	const ready = await waitForRegistry(handle.url);
	if (!ready.ok) return { ok: false, detail: `${REASONS.REGISTRY_LOW_LIMIT_NOT_READY}: ${ready.detail}` };
	const username = "drill";
	const password = crypto.randomBytes(18).toString("base64url");
	const user = await ensureRegistryUser({
		url: handle.url,
		username,
		password,
		email: "drill@drill.invalid",
		logFile: path.join(ctx.logsDir, "verdaccio-low-limit.log"),
	});
	if (!user.ok) return { ok: false, detail: `${REASONS.REGISTRY_LOW_LIMIT_NOT_READY}: 凭据创建失败 ${user.detail}` };
	let fence;
	try {
		fence = await prepareRegistryConfig(ctx, {
			url: handle.url,
			label: "low-limit",
			logFile: path.join(ctx.logsDir, "npm-config-selfcheck-low-limit.log"),
			authToken: user.token,
		});
	} catch (error) {
		return { ok: false, detail: `${REASONS.REGISTRY_SCOPE_MISMATCH}: ${error?.detail ?? error?.message ?? error}` };
	}
	ctx.registry.lowLimitUrl = handle.url;
	ctx.registry.lowLimitUserConfig = fence.userconfig;
	ctx.registry.lowLimitGlobalConfig = fence.globalconfig;
	ctx.registry.lowLimitScopeCheck = fence.check;
	return { ok: true, url: handle.url };
}

async function stopAllRegistries(ctx) {
	const stopped = [];
	for (const handle of [ctx.registry.lowLimitHandle, ctx.registry.normalHandle]) {
		if (!handle) continue;
		stopped.push(await stopVerdaccio(handle));
	}
	return stopped;
}

function setupFailureAssertion(error) {
	return {
		id: "S0",
		title: "演练前置与环境准备",
		pass: false,
		reason: error instanceof DrillSetupError ? error.reason : REASONS.SETUP_FAILED,
		detail: String(error?.detail ?? error?.message ?? error).slice(0, 500),
		durationMs: 0,
	};
}

function printBanner(ctx, options, selected) {
	console.log("npm-drill — 发版演练（issue #37；本地 registry，不接触公共 npm）");
	console.log(`  dist     : ${ctx.dist}`);
	console.log(`  versions : pluginA=${ctx.versions.pluginA} carrierA=${ctx.versions.carrierA}`);
	console.log(`             pluginB=${ctx.versions.pluginB} carrierB=${ctx.versions.carrierB}`);
	console.log(`             pluginOnly=${ctx.versions.pluginOnly}（载体不发布）`);
	console.log(`  phases   : ${selected.join(",")}${options.registry ? `（复用 registry ${options.registry}）` : ""}`);
	console.log(`  state    : ${ctx.runDir}`);
	{
		const mode = ctx.registry.mode === "reused" ? `复用 ${ctx.registry.normalUrl}` : "临时实例（绑定 127.0.0.1）";
		const remoteWarn = ctx.registry.remoteAllowed ? "；⚠ 远端 registry 已放行（DRILL_ALLOW_REMOTE_REGISTRY=1）" : "";
		console.log(`  registry : ${mode}${remoteWarn}`);
		console.log(`  路由围栏 : registry 与 @scope:registry 均固定到受检地址（专用 npm 配置，不继承用户路由）`);
		console.log(`  提示     : 只发布演练版本（9.9.x / 9.9.x-app），不发布公共包；退出码非 0 即失败`);
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		process.stdout.write(HELP_TEXT);
		return 0;
	}
	if (options.unknown.length > 0) {
		printCliFailure({ title: "命令行参数合法（不认识的参数不得静默忽略）", reason: REASONS.CLI_INVALID_ARGUMENT, detail: options.unknown.join(" ") });
		return 1;
	}
	const phaseSelection = resolveSelectedPhases(options.phases);
	if (!phaseSelection.ok) {
		printCliFailure({
			title: "阶段选择合法（preflight,publish,install,discover,update,failure 或 all）",
			reason: REASONS.PHASES_INVALID,
			detail: phaseSelection.requested.join(","),
		});
		return 1;
	}
	const selected = phaseSelection.selected;

	// 版本与运行目录（任何失败都要能落到证据目录）。
	const versions = createDrillVersions();
	const runDir = path.join(resolveStateBase(), `${utcStamp()}-${versions.pluginA}`);
	const logsDir = ensureDir(path.join(runDir, "logs"));
	const workDir = ensureDir(path.join(runDir, "work"));
	const home = ensureDir(path.join(runDir, "home"));
	const dist = options.dist !== "" ? path.resolve(options.dist) : path.join(REPO_ROOT, "dsh-mobile-app", "dist");
	const ctx = {
		options,
		versions,
		dist,
		runDir,
		logsDir,
		workDir,
		home,
		dshHome: path.join(home, ".dsh"),
		registry: {
			mode: null,
			normalUrl: null,
			normalHandle: null,
			normalUserConfig: "",
			normalGlobalConfig: "",
			normalScopeCheck: null,
			normalConfigInfo: null,
			lowLimitUrl: null,
			lowLimitHandle: null,
			lowLimitUserConfig: "",
			lowLimitGlobalConfig: "",
			lowLimitScopeCheck: null,
			verdaccio: null,
			maxBodySize: NORMAL_MAX_BODY,
			lowLimitMaxBody: LOW_LIMIT_MAX_BODY,
		},
		assets: null,
		mainPackage: null,
		source: null,
		safeUserConfig: "",
		safeGlobalConfig: "",
		projection: null,
		ensureLowLimitRegistry: () => ensureLowLimitRegistry(ctx),
	};

	// --build：先跑发布构建（可能创建/刷新 dist）。日志在证据目录里。
	if (options.build) {
		const build = await runCommand({
			command: "bash",
			// package-release.sh 属于 App 发布链（dsh-mobile-app/tools），本工具只调用不搬运。
			args: [path.join(REPO_ROOT, "dsh-mobile-app", "tools", "package-release.sh")],
			cwd: REPO_ROOT,
			env: { ...process.env },
			logFile: path.join(logsDir, "build.log"),
			timeoutMs: 3_600_000,
			label: "package-release.sh",
		});
		if (!build.ok) {
			removeDir(runDir);
			printCliFailure({ title: "演练前发布构建成功（--build）", reason: REASONS.BUILD_FAILED, detail: `exit=${build.status}` });
			return 1;
		}
	}
	if (!existsDir(dist)) {
		removeDir(runDir);
		printCliFailure({ title: "发布目录存在", reason: REASONS.DIST_MISSING, detail: dist });
		return 1;
	}
	const mainPackageRead = (() => {
		try {
			return JSON.parse(readTextFile(path.join(REPO_ROOT, "package.json")));
		} catch (error) {
			return { error: String(error?.message ?? error) };
		}
	})();
	if (mainPackageRead.error) {
		removeDir(runDir);
		printCliFailure({ title: "主包 package.json 可解析（确定演练包名）", reason: REASONS.DIST_UNREADABLE, detail: mainPackageRead.error });
		return 1;
	}
	ctx.mainPackage = mainPackageRead;
	// R1：离线阶段（preflight/--build 外的本地 npm pack 等）也用中性空 npm 配置，
	// 不继承调用方的 registry 路由。
	ctx.safeUserConfig = writeTextFile(path.join(runDir, "npmrc", "safe.npmrc"), "# drill: intentionally empty (no inherited registry routing)\n");
	ctx.safeGlobalConfig = writeEmptyGlobalConfig({ runDir, label: "safe" });
	// 发布目录不完整不在 CLI 层直接退出：留给 preflight 断言（P1）产出 run.json 证据。
	ctx.assets = readDistAssets(dist);

	const environment = await runEnvToolVersions(ctx);
	const record = createRunRecord({ versions, dist, registry: null, environment });
	let abort = false;

	try {
		// ── 离线 preflight 阶段（选中或作为 registry 阶段的前置）──
		if (selected.includes("preflight") || phaseSelection.needsRegistry) {
			const reported = selected.includes("preflight");
			const phase = beginPhase(record, "preflight", { reported });
			if (reported) printPhaseHeader("preflight");
			for (const item of await PHASES.preflight(ctx)) recordAssertion(phase, item);
			endPhase(record, phase);
			if (!phase.ok) throw new AbortRun();
		}

		// ── registry 阶段：环境/registry/产物投影（静默前置）──
		if (phaseSelection.needsRegistry) {
			const setupPhase = beginPhase(record, "setup", { reported: true });
			try {
				await prepareNormalRegistry(ctx, options);
				await prepareProjection(ctx);
				recordAssertion(setupPhase, {
					id: "S1",
					title: "演练环境就绪（registry + 源产物校验 + 演练产物投影）",
					pass: true,
					detail: `registry=${ctx.registry.mode}; ${ctx.registry.normalUrl}; source=${ctx.source?.name}@${ctx.source?.version}; carrierA=${ctx.projection.carrierA.size}B`,
				});
				// R1：发布/安装前自检实际生效的 registry 路由（含 scoped registry）。
				const scopeCheck = ctx.registry.normalScopeCheck;
				const migrated = ctx.registry.normalConfigInfo?.migrated ?? [];
				recordAssertion(setupPhase, {
					id: "S2",
					title: "registry 路由自检：registry 与 @scope:registry 均指向受检地址（不被用户 npmrc 覆盖）",
					pass: scopeCheck?.ok === true,
					reason: REASONS.REGISTRY_SCOPE_MISMATCH,
					detail: `${scopeCheck?.detail ?? "<未执行>"}；迁移目标 host 凭据=${migrated.length} 项`,
				});
			} catch (error) {
				recordAssertion(setupPhase, setupFailureAssertion(error));
				throw new AbortRun();
			} finally {
				endPhase(record, setupPhase);
			}

			const selectedRegistryPhases = REGISTRY_PHASES.filter((name) => selected.includes(name));
			const lastIndex = REGISTRY_PHASES.indexOf(selectedRegistryPhases[selectedRegistryPhases.length - 1]);
			for (let index = 0; index <= lastIndex; index++) {
				const name = REGISTRY_PHASES[index];
				const reported = selected.includes(name);
				const phase = beginPhase(record, name, { reported });
				if (reported) printPhaseHeader(name);
				const assertions = await PHASES[name](ctx);
				for (const item of assertions) recordAssertion(phase, item);
				endPhase(record, phase);
				if (!phase.ok) {
					if (!reported) {
						// 静默前置失败时把 FAIL 明细打出来（否则用户只看到总失败没有原因）。
						console.log(`\n!! 静默前置阶段 ${name} 失败，明细如下：`);
						for (const item of phase.assertions.filter((entry) => !entry.pass)) {
							console.log(`FAIL  ${item.id} ${item.title} [reason:${item.reason}]${item.detail ? ` (${item.detail})` : ""}`);
						}
					}
					throw new AbortRun();
				}
			}
		}
	} catch (error) {
		if (!(error instanceof AbortRun)) {
			const setupPhase = beginPhase(record, "setup", { reported: true });
			recordAssertion(setupPhase, setupFailureAssertion(error));
			endPhase(record, setupPhase);
		}
		abort = true;
	} finally {
		await stopAllRegistries(ctx);
		record.registry = ctx.registry.mode === null
			? null
			: { ...ctx.registry, normalHandle: undefined, lowLimitHandle: undefined };
		finalizeRecord(record, { runDir, keep: options.keep, evidenceDir: runDir });
		// 成功且未要求保留现场时，清理重型临时内容（保留 run.json 与日志证据）。
		if (record.status === "PASS" && !options.keep) {
			for (const dir of [path.join(runDir, "work"), path.join(runDir, "registry"), path.join(runDir, "home")]) {
				if (existsDir(dir)) removeDir(dir);
			}
		}
		printRunSummary(record);
	}
	return abort || record.status !== "PASS" ? 1 : 0;
}

main()
	.then((code) => process.exit(code))
	.catch((error) => {
		// 兜底：未捕获异常也必须给出稳定 reason 与非 0 退出码。
		printCliFailure({ title: "演练执行", reason: REASONS.SETUP_FAILED, detail: String(error?.stack ?? error).slice(0, 800) });
		process.exit(1);
	});
