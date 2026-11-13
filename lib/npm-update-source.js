import { execFile } from "node:child_process";
import { appCarrierAlias, appCarrierVersion } from "./app-carrier.js";
import { parseVersion } from "./plugin-update.js";
import { shellOptions } from "./tool-process.js";

const SRI_PATTERN = /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/;

/**
 * Stable package follows latest; 预发布跟随其自身的通道（alpha / rc）。
 * 例：3.2.2-alpha.15 查 alpha，3.2.2-rc.1 查 rc；绝不把预发布塞给 latest。
 */
export function npmUpdateChannel(localVersion) {
	const parsed = parseVersion(localVersion);
	if (!parsed) return { ok: false, reason: "npm-local-version-invalid" };
	if (parsed.prerelease.length === 0) return { ok: true, channel: "latest" };
	const channel = parsed.prerelease[0];
	if (channel === "alpha" || channel === "rc") return { ok: true, channel };
	return { ok: false, reason: "npm-prerelease-channel-unsupported" };
}

function packageIntegrity(pkg) {
	const value = pkg?.dist?.integrity;
	return typeof value === "string" && SRI_PATTERN.test(value) ? value : "";
}

/**
 * `npm view <pkg> dist-tags --json` prints the tag map itself
 * (`{"latest":"...","alpha":"..."}`), while some adapters/tests hand back the
 * whole packument field (`{"dist-tags":{...}}`). Accept both so the check never
 * fails merely because of the projection shape.
 */
function distTagMap(tags) {
	if (!tags || typeof tags !== "object" || Array.isArray(tags)) return null;
	const nested = tags["dist-tags"];
	if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested;
	return tags;
}

/** 检查日志只放包名/版本/稳定原因码；绝不写 registry URL、凭据或 npm stderr。 */
export const NPM_CHECK_LOG_LIMIT = 40;
const CHECK_LOG_LINE_LIMIT = 240;

function checkRecorder(log) {
	if (!Array.isArray(log)) return () => {};
	return (line) => {
		const text = String(line ?? "").trim();
		if (text === "") return;
		log.push(text.length > CHECK_LOG_LINE_LIMIT ? `${text.slice(0, CHECK_LOG_LINE_LIMIT)}…` : text);
		if (log.length > NPM_CHECK_LOG_LIMIT) log.splice(0, log.length - NPM_CHECK_LOG_LIMIT);
	};
}

/**
 * Resolve an immutable plugin/carrier pair from NPM metadata only.
 * `packageView(spec)` is the host NPM adapter; tests inject a deterministic registry.
 * This function never downloads a tarball and never returns registry URLs or raw metadata.
 * `log` (optional array) receives sanitized, bounded diagnostic lines for the settings UI.
 */
export async function resolveNpmUpdateCandidate({ packageName, localVersion, packageView, log } = {}) {
	const record = checkRecorder(log);
	if (typeof packageName !== "string" || packageName.trim() === "") {
		record(`包名无效：${String(packageName ?? "")}`);
		return { ok: false, reason: "npm-package-name-invalid" };
	}
	if (typeof packageView !== "function") {
		record(`找不到 npm 元数据适配器（${packageName}）`);
		return { ok: false, reason: "npm-client-unavailable" };
	}
	const channel = npmUpdateChannel(localVersion);
	if (!channel.ok) {
		record(`# 本机版本 ${String(localVersion || "未知")} 无法确定 NPM 通道：${channel.reason}`);
		return channel;
	}
	record(`# 本机版本 ${String(localVersion || "未知")} · NPM 通道 ${channel.channel}`);

	let tags;
	record(`$ npm view ${packageName} dist-tags --json`);
	try {
		tags = await packageView(packageName);
	} catch (error) {
		const reason = viewFailureReason(error);
		record(`→ 失败：${reason}`);
		return { ok: false, reason };
	}
	const candidateVersion = distTagMap(tags)?.[channel.channel];
	if (typeof candidateVersion !== "string" || !parseVersion(candidateVersion)) {
		record(`→ 缺少 ${channel.channel} 标签`);
		return { ok: false, reason: "npm-channel-version-missing", channel: channel.channel };
	}
	record(`→ ${channel.channel}=${candidateVersion}`);

	// issue #96：dist-tags 只取一次；插件与 carrier 元数据**并行**取（两者版本都可从
	// dist-tag 候选版本推出），把总检查耗时压到一次 npm view 的量级。
	const carrierVersion = appCarrierVersion(candidateVersion);
	const alias = appCarrierAlias(packageName);
	const expectedAliasSpec = `npm:${packageName}@${carrierVersion}`;
	record(`$ npm view ${packageName}@${candidateVersion} --json`);
	record(`$ npm view ${packageName}@${carrierVersion} --json`);
	const [pluginOutcome, carrierOutcome] = await Promise.all([
		packageView(`${packageName}@${candidateVersion}`).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })),
		packageView(`${packageName}@${carrierVersion}`).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })),
	]);
	if (!pluginOutcome.ok) {
		record(`→ 失败：${viewFailureReason(pluginOutcome.error)}`);
		return { ok: false, reason: "npm-plugin-metadata-unavailable" };
	}
	const plugin = pluginOutcome.value;
	if (!plugin || plugin.version !== candidateVersion) {
		record(`→ 版本不符：${String(plugin?.version ?? "缺失")} ≠ ${candidateVersion}`);
		return { ok: false, reason: "npm-plugin-version-mismatch" };
	}
	const pluginIntegrity = packageIntegrity(plugin);
	if (!pluginIntegrity) {
		record(`→ 元数据缺少 dist.integrity`);
		return { ok: false, reason: "npm-plugin-integrity-missing" };
	}
	record(`→ 插件 v${candidateVersion}`);
	if (plugin.optionalDependencies?.[alias] !== expectedAliasSpec) {
		record(`→ 载体别名不匹配：${String(plugin.optionalDependencies?.[alias] ?? "缺失")}（期望 ${expectedAliasSpec}）`);
		return { ok: false, reason: "npm-carrier-alias-mismatch" };
	}
	if (!carrierOutcome.ok) {
		record(`→ 失败：${viewFailureReason(carrierOutcome.error)}`);
		return { ok: false, reason: "npm-carrier-metadata-unavailable" };
	}
	const carrier = carrierOutcome.value;
	if (!carrier || carrier.version !== carrierVersion) {
		record(`→ 版本不符：${String(carrier?.version ?? "缺失")} ≠ ${carrierVersion}`);
		return { ok: false, reason: "npm-carrier-version-mismatch" };
	}
	const carrierIntegrity = packageIntegrity(carrier);
	if (!carrierIntegrity) {
		record(`→ 元数据缺少 dist.integrity`);
		return { ok: false, reason: "npm-carrier-integrity-missing" };
	}

	const appVersion = typeof carrier.appVersion === "string" ? carrier.appVersion : null;
	if (appVersion !== null) {
		const parsedApp = parseVersion(appVersion);
		const parsedPlugin = parseVersion(candidateVersion);
		if (!parsedApp || parsedApp.build === null) {
			record(`→ App 版本格式无效：${appVersion}`);
			return { ok: false, reason: "npm-app-version-invalid" };
		}
		if (parsedApp.version !== parsedPlugin.version) {
			record(`→ App 版本配对不符：${appVersion} ↔ 插件 ${candidateVersion}`);
			return { ok: false, reason: "npm-app-version-pairing-mismatch" };
		}
	}
	const contentSha256 = typeof carrier.pluginContentSha256 === "string" ? carrier.pluginContentSha256.toLowerCase() : "";
	if (contentSha256 !== "" && !/^[0-9a-f]{64}$/.test(contentSha256)) {
		record(`→ 插件内容标识格式无效（${carrierVersion}）`);
		return { ok: false, reason: "npm-plugin-content-sha256-invalid" };
	}

	record(`→ 载体 v${carrierVersion} · App build ${appVersion ?? "缺失（需预检）"}`);

	return {
		ok: true,
		channel: channel.channel,
		plugin: {
			name: packageName,
			version: candidateVersion,
			integrity: pluginIntegrity,
			contentSha256,
		},
		carrier: {
			name: packageName,
			version: carrierVersion,
			integrity: carrierIntegrity,
			appVersion,
			pluginContentSha256: contentSha256,
			legacyMetadataMissing: appVersion === null,
		},
	};
}

export function runNpmView(args, { cwd = process.cwd(), timeoutMs = 20_000, execFileImpl = execFile, platform = process.platform } = {}) {
	return new Promise((resolve) => {
		execFileImpl("npm", args, {
			cwd,
			env: process.env,
			timeout: timeoutMs,
			maxBuffer: 1024 * 1024,
			windowsHide: true,
			// Windows 上 npm 是 npm.cmd，必须经 shell 解析；POSIX 直接 spawn。
			...shellOptions(platform),
		}, (error, stdout, stderr) => {
			if (error) {
				// npm stderr may contain private registry URLs; expose only a stable source error.
				// 区分「找不到 npm 客户端」与「registry 不可用」，便于界面给出可执行提示：
				// Windows shell 找不到 .cmd 时 cmd 会报「不是内部或外部命令」而不是 ENOENT。
				const stderrText = String(stderr ?? "");
				const clientMissing = error?.code === "ENOENT" || /not recognized|不是内部或外部命令|command not found/i.test(stderrText);
				resolve({ ok: false, error: clientMissing ? "npm-client-unavailable" : "npm-view-failed" });
				return;
			}
			resolve({ ok: true, stdout: String(stdout ?? "") });
		});
	});
}

/** 检查失败原因：npm 客户端缺失是环境问题，不应伪装成 registry 故障。 */
function viewFailureReason(error) {
	return error?.message === "npm-client-unavailable" ? "npm-client-unavailable" : "npm-registry-unavailable";
}

/**
 * Host-side npm view adapter. It deliberately supplies no --registry argument so npm
 * applies the DSH process's project/user config, including scoped registry and credentials.
 */
export function createNpmPackageView({ packageName, cwd, run = runNpmView, platform = process.platform } = {}) {
	return async (spec) => {
		if (typeof spec !== "string" || spec === "") throw new Error("npm-package-spec-invalid");
		const args = spec === packageName
			? ["view", packageName, "dist-tags", "--json"]
			: ["view", spec, "--json"];
		const result = await run(args, { cwd, platform });
		if (!result?.ok) throw new Error(result?.error ?? "npm-view-failed");
		try {
			return JSON.parse(result.stdout);
		} catch {
			throw new Error("npm-view-json-invalid");
		}
	};
}
