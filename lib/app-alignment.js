// 两端对齐状态（CONTEXT「对齐提示」）。
//
// 判据是**版本号**，且只用于决定**提示文案**——不参与任何能力可用性判定
// （能力看声明，见 ADR 0017 与 ADR 0019 的三条判据分离）。
// 比较只看 core `X.Y.Z`：App 的 `+build` 是它自己的构建号，同一发布周期内每次构建
// 都不同；插件可能是 prerelease（如 `3.2.1-alpha.1`，发布通道用）。两者都不参与配对，
// 因此插件 `3.2.1-alpha.1` 与 App `3.2.1+24` 按 core `3.2.1` 视为对齐。
//
// 自举：已装在用户手机上的旧 App 不会上报版本头，因此「头缺失」本身就是
// 「这是旧 App」的可靠信号——PC 端据此就能提示，不必等 App 先升级。
import { parseVersion } from "./plugin-update.js";

/** App 上报自身版本所用的请求头。 */
export const APP_VERSION_HEADER = "x-mobile-app-version";

/** 对齐状态。 */
export const ALIGNMENT_STATE = {
	/** 两端语义版本一致。 */
	OK: "ok",
	/** 手机 App 落后于插件：应更新 App。 */
	APP_OUTDATED: "app-outdated",
	/** 插件落后于手机 App：应更新插件。 */
	PLUGIN_OUTDATED: "plugin-outdated",
	/** 无法判定（旧 App 未上报、或版本不可解析）——如实报出，不猜。 */
	UNKNOWN: "unknown",
};

/** 取 core `X.Y.Z`（prerelease 与 build 都剥离）；不可解析返回 ""。 */
export function semanticVersion(value) {
	const p = parseVersion(value);
	return p ? p.version : "";
}

/** 从请求头读 App 版本；缺失或形状异常一律返回空串。 */
export function readAppVersionHeader(headers) {
	if (!headers || typeof headers !== "object") return "";
	const raw = headers[APP_VERSION_HEADER];
	const value = Array.isArray(raw) ? raw[0] : raw;
	return typeof value === "string" ? value.trim() : "";
}

/**
 * 计算两端对齐状态。返回结构可直接放进 bootstrap / diagnostics 响应。
 * `hint` 是给人看的说明（PC 端日志与诊断页用）；手机端应按 `reason` 自行本地化。
 */
export function computeAppAlignment({ appVersionHeader, pluginVersion }) {
	const pluginSemver = semanticVersion(pluginVersion);
	const appRaw = typeof appVersionHeader === "string" ? appVersionHeader.trim() : "";
	const base = {
		appVersion: appRaw === "" ? null : appRaw,
		pluginVersion: pluginVersion ?? "",
		expectedAppVersion: pluginSemver || null,
	};
	if (pluginSemver === "") {
		return { ...base, state: ALIGNMENT_STATE.UNKNOWN, reason: "plugin-version-unparseable", hint: "插件自身版本不可解析，无法判定两端是否对齐" };
	}
	if (appRaw === "") {
		return {
			...base,
			state: ALIGNMENT_STATE.UNKNOWN,
			reason: "app-version-header-missing",
			hint: `手机 App 未上报版本（通常是旧版 App）；无法确认两端是否对齐。插件为 ${pluginVersion}，建议把 App 更新到同版本。`,
		};
	}
	const appSemver = semanticVersion(appRaw);
	if (appSemver === "") {
		return { ...base, state: ALIGNMENT_STATE.UNKNOWN, reason: "app-version-unparseable", hint: `手机 App 上报的版本无法解析：${appRaw}` };
	}
	if (appSemver === pluginSemver) {
		return { ...base, state: ALIGNMENT_STATE.OK, reason: "aligned", hint: "" };
	}
	const older = compareSemver(appSemver, pluginSemver) < 0;
	if (older) {
		return {
			...base,
			state: ALIGNMENT_STATE.APP_OUTDATED,
			reason: "app-older-than-plugin",
			hint: `手机 App（${appRaw}）落后于本机插件（${pluginVersion}）：新功能会被明确提示而非静默失效。请在手机上把 App 更新到 ${pluginSemver}。`,
		};
	}
	return {
		...base,
		state: ALIGNMENT_STATE.PLUGIN_OUTDATED,
		reason: "plugin-older-than-app",
		hint: `本机插件（${pluginVersion}）落后于手机 App（${appRaw}）：请在电脑上把插件更新到 ${appSemver} 并重启 DSH。`,
	};
}

/** 内部：比较两个语义版本（入参已保证可解析）。 */
function compareSemver(a, b) {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
	}
	return 0;
}

/**
 * 只在结论变化时提示一次（bootstrap 会在启动、下拉刷新、重连时反复调用，
 * 每次都记日志会把 DSH 日志刷满）。`seen` 是该插件实例作用域内的去重载体。
 */
export function noteAppAlignment(logger, alignment, seen) {
	if (!alignment || alignment.state === ALIGNMENT_STATE.OK) return false;
	const key = `${alignment.state}:${alignment.appVersion ?? "-"}`;
	if (seen.key === key) return false;
	seen.key = key;
	const line = `mobile-remote: ${alignment.hint}`;
	if (alignment.state === ALIGNMENT_STATE.UNKNOWN) logger?.info?.(line);
	else logger?.warn?.(line);
	return true;
}
