// 通过宿主原生插件管理器执行更新（DSH 0.2.2+）：不重启宿主。
//
// 与 `plugin-self-update.js` 那条「改依赖 → pnpm install → 重启 → 健康确认」的传统
// 通道并列；本模块只在宿主提供 `pluginManager.updateBundle()` 时使用。
//
// 为什么优先用它：
//   1. **不重启**：宿主在 HMR 可用时移除旧版本、装新版本并在进程内重新组合 profile，
//      插件被重新加载而宿主进程不变——手机与桌面都不掉连接。
//   2. **判定权交给宿主**：registry 选择、pnpm 配置、凭据、兼容性豁免、构建脚本批准
//      全部由宿主那一套既有实现决定，我们不重复实现、也不绕过它的安全检查。
//   3. **失败即回滚**：宿主在装新版本失败/取消时会把旧版本装回去，并把结果如实报出来。
//
// 本模块不做的事：不自己跑 pnpm、不改 profile 文件、不做健康判定（宿主的
// `application` 字段就是结论）。
import { compareVersion, parseVersion } from "./plugin-update.js";
import { HOST_MANAGER_REASON, UPDATE_CHANNEL } from "./host-update-capabilities.js";

/** 宿主更新失败的稳定原因码（对外只暴露这一类，不含宿主异常原文）。 */
export const HOST_MANAGER_ERROR = {
	/** 探测阶段就不可用。 */
	UNAVAILABLE: "host-manager-unavailable",
	/** 目标版本不是合法 semver。 */
	VERSION_INVALID: "host-manager-version-invalid",
	/** 目标版本不高于已安装版本（宿主会拒绝，这里提前挡）。 */
	VERSION_NOT_NEWER: "host-manager-version-not-newer",
	/** 宿主拒绝（`ChangeResult.application === 'failed'`）。 */
	REJECTED: "host-manager-rejected",
	/** 用户/调用方取消。 */
	CANCELLED: "host-manager-cancelled",
	/** 装上了但需要重启才生效。 */
	RESTART_REQUIRED: "host-manager-restart-required",
	/** 调用 itself 抛错。 */
	CALL_FAILED: "host-manager-call-failed",
	/** 被替代/覆盖（同一插件条目上有更高优先级的覆盖）。 */
	OVERRIDDEN: "host-manager-overridden",
};

/**
 * 把宿主的 `ChangeResult`（以及 `updateBundle` 外层结果）压成我们自己的稳定结论。
 *
 * 宿主字段语义（见 dsh-plugin-manager 的 `ChangeResult` / `PluginUpdateResult`）：
 *   - `application: 'applied'` → 已生效，无需重启；
 *   - `application: 'restart-required'` → 装了但下次启动才生效；
 *   - `application: 'failed' | 'cancelled'` → 未生效（`restore` 存在时表示旧版本已装回）；
 *   - `application: 'overridden'` → 被其它条目覆盖。
 *
 * @param {object|undefined} outcome - `updateBundle()` 的返回值。
 * @returns {{ok: boolean, reason: string, restored: boolean, from: string, to: string, step: string, detail: string}}
 */
export function interpretHostManagerUpdate(outcome) {
	const from = typeof outcome?.from === "string" ? outcome.from : "";
	const to = typeof outcome?.to === "string" ? outcome.to : "";
	const step = typeof outcome?.step === "string" ? outcome.step : "";
	const base = { from, to, step, restored: Boolean(outcome?.restore) };
	// `updateBundle` 在「检查阶段就拒绝」时也可能没有 result。
	const result = outcome?.result;
	if (!result || typeof result !== "object") {
		const reason = typeof result === "string" ? result : "";
		return { ...base, ok: false, reason: HOST_MANAGER_ERROR.REJECTED, detail: reason };
	}
	switch (result.application) {
	case "applied":
		return { ...base, ok: true, reason: "", detail: "" };
	case "restart-required":
		return { ...base, ok: false, reason: HOST_MANAGER_ERROR.RESTART_REQUIRED, detail: String(result.restartReason ?? "") };
	case "cancelled":
		return { ...base, ok: false, reason: HOST_MANAGER_ERROR.CANCELLED, detail: "" };
	case "overridden":
		return { ...base, ok: false, reason: HOST_MANAGER_ERROR.OVERRIDDEN, detail: "" };
	case "failed":
	default: {
		// 宿主的 error 是结构化对象（code/diagnostic）；只取 code，绝不透传 diagnostic 原文
		// （可能含 registry URL、凭据或缺路径）。
		const code = typeof result.error?.code === "string" ? result.error.code : "";
		return { ...base, ok: false, reason: HOST_MANAGER_ERROR.REJECTED, detail: code };
	}
	}
}

/**
 * 校验目标版本可以交给宿主更新。
 *
 * 宿主自己也会校验（`semver.gt`），这里提前挡是为了给出**我们自己的稳定原因码**，
 * 而不是把宿主的英文 diagnostic 抛给手机。
 *
 * @param {object} input
 * @param {string} input.targetVersion - 目标版本。
 * @param {string} input.installedVersion - 当前已安装版本。
 * @returns {{ok: boolean, reason: string}}
 */
export function validateHostManagerTarget({ targetVersion, installedVersion } = {}) {
	if (!parseVersion(targetVersion)) return { ok: false, reason: HOST_MANAGER_ERROR.VERSION_INVALID };
	if (installedVersion) {
		const comparison = compareVersion(targetVersion, installedVersion);
		// 比较不出来时放行给宿主判定：我们的比较器只认 `X.Y.Z[-pre][+N]`，
		// 而宿主用的是完整 semver——不因为我们的解析面更窄就误拒。
		if (comparison !== null && comparison <= 0) {
			return { ok: false, reason: HOST_MANAGER_ERROR.VERSION_NOT_NEWER };
		}
	}
	return { ok: true, reason: "" };
}

/**
 * 通过宿主插件管理器更新本插件。
 *
 * 执行顺序刻意固定：
 *   1. 探测结论必须可用（`probe.channel === host-manager`），否则直接拒绝；
 *   2. 校验目标版本；
 *   3. 调 `updateBundle(name, version, { registry?, requestId? })`；
 *   4. 把结果压成稳定结论。
 *
 * 不在这里做重试：宿主的 `updateBundle` 内部已经处理了 registry 回退与失败回滚，
 * 我们外加一层重试只会让「已经回滚过的事」再发生一次。
 *
 * @param {object} input
 * @param {object} input.service - `pluginManager` 服务实例。
 * @param {string} input.packageName - 本插件包名。
 * @param {string} input.targetVersion - 目标版本。
 * @param {string} [input.installedVersion] - 当前版本（用于提前挡降级）。
 * @param {string} [input.registry] - 指定 registry；缺省由宿主按配置决定。
 * @param {string} [input.requestId] - 宿主用它关联进度与日志。
 * @param {(progress: object) => void} [input.onProgress] - 宿主 `update-state` 事件的转发。
 * @param {object} [input.log] - 结构化日志（注入以便测试）。
 * @returns {Promise<object>} 稳定结论。
 */
export async function runHostManagerUpdate({
	service,
	packageName,
	targetVersion,
	installedVersion = "",
	registry,
	requestId,
	onProgress,
	log = {},
} = {}) {
	if (!service || typeof service.updateBundle !== "function") {
		return { ok: false, channel: UPDATE_CHANNEL.HOST_MANAGER, reason: HOST_MANAGER_REASON.SERVICE_MISSING, from: "", to: String(targetVersion ?? ""), step: "", restored: false };
	}
	if (typeof packageName !== "string" || packageName === "") {
		return { ok: false, channel: UPDATE_CHANNEL.HOST_MANAGER, reason: HOST_MANAGER_REASON.NOT_UPDATABLE, from: "", to: String(targetVersion ?? ""), step: "", restored: false };
	}
	const validated = validateHostManagerTarget({ targetVersion, installedVersion });
	if (!validated.ok) {
		return { ok: false, channel: UPDATE_CHANNEL.HOST_MANAGER, reason: validated.reason, from: String(installedVersion ?? ""), to: String(targetVersion ?? ""), step: "check", restored: false };
	}
	const options = {};
	// 只在调用方明确给了 registry 时才传：缺省要比「传 undefined」更明确地走宿主配置。
	if (typeof registry === "string" && registry !== "") options.registry = registry;
	if (typeof requestId === "string" && requestId !== "") options.requestId = requestId;
	let outcome;
	try {
		log.stage?.("host-manager", `Updating ${packageName} to ${targetVersion} through the host plugin manager`);
		outcome = await service.updateBundle(packageName, targetVersion, Object.keys(options).length > 0 ? options : undefined);
	} catch (error) {
		// 宿主在锁超时/服务销毁时是 reject 而不是返回失败结果；这仍然是一次失败结论。
		log.fail?.("host-manager", "Host plugin manager update call rejected");
		return {
			ok: false,
			channel: UPDATE_CHANNEL.HOST_MANAGER,
			reason: HOST_MANAGER_ERROR.CALL_FAILED,
			from: String(installedVersion ?? ""),
			to: String(targetVersion ?? ""),
			step: "",
			restored: false,
			detail: typeof error?.code === "string" ? error.code : "",
		};
	}
	const interpreted = interpretHostManagerUpdate(outcome);
	if (typeof onProgress === "function") {
		try {
			onProgress({ step: interpreted.step, from: interpreted.from, to: interpreted.to });
		} catch {
			// 进度回调不应影响更新结论
		}
	}
	return { ...interpreted, channel: UPDATE_CHANNEL.HOST_MANAGER };
}
