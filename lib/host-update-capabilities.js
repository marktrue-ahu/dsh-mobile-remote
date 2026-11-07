// 宿主「原生插件更新」能力探测（DSH 0.2.2+ 的 `pluginManager` 服务）。
//
// 背景：0.2.2 起 DSH 自带插件管理器（`@deepseek-ai/dsh-plugin-manager`），它把
// 「装/删/更新插件」做成了宿主内的服务方法，并且 **在 HMR 可用时不重启宿主**：
// `updateBundle()` 会先移除旧版本、再装新版本，由 `hmr.reconcileProfile()` 在进程内
// 重新组合 profile——插件被卸载并重新加载，宿主进程不变。
//
// 我们的自更新原先只会「改 profile 依赖 → pnpm install → 重启宿主」这一条路；当宿主
// 形态判断不出可重启方式（例如容器里没有 systemd、进程环境没有 DSH_PROFILE）时，
// 就整条降级成「请到电脑上运行 pnpm install」的手工指引。有了宿主原生能力后，
// 那种情形可以直接委托给宿主，彻底不需要重启，也不需要用户碰命令行。
//
// 本模块只做**探测**与**能力描述**，不执行更新（执行在 plugin-self-update.js）。

/** 更新执行通道。 */
export const UPDATE_CHANNEL = {
	/** 委托宿主 `pluginManager.updateBundle()`：进程内热更新，不重启。 */
	HOST_MANAGER: "host-manager",
	/** 传统通道：改 profile 依赖 → pnpm install → 重启宿主并做健康确认。 */
	RESTART: "restart",
	/** 两者都不可用，只能给人工指引。 */
	GUIDANCE: "guidance",
};

/** 宿主管理器不可用的稳定原因码（对外只暴露这几类，不含内部异常原文）。 */
export const HOST_MANAGER_REASON = {
	/** 宿主没有 `pluginManager` 服务（0.2.2 之前，或该 bundle 未启用）。 */
	SERVICE_MISSING: "host-manager-service-missing",
	/** 服务存在但没有 `updateBundle` 方法（接口被裁剪/版本不符）。 */
	METHOD_MISSING: "host-manager-method-missing",
	/** 宿主没报告 HMR：更新仍可安装，但结果要重启才生效。 */
	HMR_MISSING: "host-manager-hmr-missing",
	/** 当前安装不是「以自身包名从 registry 装的 profile 依赖」，宿主会拒绝更新。 */
	NOT_UPDATABLE: "host-manager-not-updatable",
	/** 探测过程抛错。 */
	PROBE_FAILED: "host-manager-probe-failed",
};

/** 探测结果的稳定状态。 */
export const HOST_MANAGER_STATE = {
	/** 可用且能免重启生效。 */
	READY: "ready",
	/** 可用，但生效需要重启（无 HMR）。 */
	RESTART_REQUIRED: "restart-required",
	/** 不可用。 */
	UNSUPPORTED: "unsupported",
};

/**
 * 读 `pluginManager` 服务。
 *
 * 探测顺序刻意保守：先拿服务（`ctx.get('pluginManager')`），再确认 `updateBundle`
 * 是可调用函数。**不看版本号**——版本号无法证明该服务真的挂在当前 profile 上
 * （ADR 0017：能力看声明，不看版本号）。任何异常都收敛成 unsupported，不向上抛。
 *
 * @param {object} ctx - cordis 上下文。
 * @returns {{available: boolean, reason: string, service: object|null}}
 */
export function probeHostPluginManager(ctx) {
	let service;
	try {
		service = ctx?.get?.("pluginManager");
	} catch {
		return { available: false, reason: HOST_MANAGER_REASON.PROBE_FAILED, service: null };
	}
	if (!service || typeof service !== "object") {
		return { available: false, reason: HOST_MANAGER_REASON.SERVICE_MISSING, service: null };
	}
	if (typeof service.updateBundle !== "function") {
		return { available: false, reason: HOST_MANAGER_REASON.METHOD_MISSING, service };
	}
	return { available: true, reason: "", service };
}

/**
 * 宿主是否报告 HMR（决定更新结果能否免重启生效）。
 *
 * `pluginManager.updateBundle` 在没有 HMR 时照样能装，只是返回
 * `application: 'restart-required'`。这里单独探测，是为了在**开始更新之前**
 * 就告诉用户「这次会重启」还是「这次不重启」，而不是等装完再报。
 *
 * @param {object} ctx - cordis 上下文。
 * @returns {{available: boolean, reason: string}}
 */
export function probeHostHmr(ctx) {
	let hmr;
	try {
		hmr = ctx?.get?.("hmr");
	} catch {
		return { available: false, reason: HOST_MANAGER_REASON.PROBE_FAILED };
	}
	if (!hmr || typeof hmr !== "object" || typeof hmr.reconcileProfile !== "function") {
		return { available: false, reason: HOST_MANAGER_REASON.HMR_MISSING };
	}
	return { available: true, reason: "" };
}

/**
 * 由 bundle 视图判断宿主会不会接受这次更新。
 *
 * `updateBundle` 的准入是（见 dsh-plugin-manager 的 `updateRefusal`）：
 * 必须是 profile 里的第三方依赖、从 registry 以**自身包名**安装、声明 semver 版本、
 * 不带插件管理职责。`listBundles()` 已经把结论投影成 `updatable` 与
 * `readOnlyReason`，这里直接采信，不重复实现那套判据。
 *
 * @param {object|undefined} bundle - `listBundles()` 里对应本插件的一行。
 * @returns {{ok: boolean, reason: string}}
 */
export function hostManagerAcceptsBundle(bundle) {
	if (!bundle || typeof bundle !== "object") {
		return { ok: false, reason: HOST_MANAGER_REASON.NOT_UPDATABLE };
	}
	if (bundle.updatable !== true) {
		return { ok: false, reason: HOST_MANAGER_REASON.NOT_UPDATABLE };
	}
	if (bundle.readOnlyReason !== undefined) {
		return { ok: false, reason: HOST_MANAGER_REASON.NOT_UPDATABLE };
	}
	return { ok: true, reason: "" };
}

/**
 * 汇总一次探测的结果：宿主管理器可用性 + HMR + 本插件是否可被它更新。
 *
 * 返回的 `channel` 是本进程**应该优先使用**的更新通道；调用方还要结合传统重启通道
 * 是否可用再决定最终通道（见 {@link chooseUpdateChannel}）。
 *
 * @param {object} input
 * @param {object} input.ctx - cordis 上下文。
 * @param {string} input.packageName - 本插件包名。
 * @param {(name: string) => Promise<object[]>} [input.listBundles] - 宿主 `listBundles()`；缺省用服务自己的方法。
 * @returns {Promise<object>} 探测结果（稳定字段，可直接进 bootstrap）。
 */
export async function detectHostUpdateCapabilities({ ctx, packageName, listBundles } = {}) {
	const manager = probeHostPluginManager(ctx);
	const hmr = probeHostHmr(ctx);
	const base = {
		packageName: typeof packageName === "string" ? packageName : "",
		managerAvailable: manager.available,
		managerReason: manager.reason,
		hmrAvailable: hmr.available,
		hmrReason: hmr.reason,
		updatable: false,
		state: HOST_MANAGER_STATE.UNSUPPORTED,
		channel: UPDATE_CHANNEL.GUIDANCE,
	};
	if (!manager.available) return base;
	const service = manager.service;
	let bundle;
	try {
		const list = typeof listBundles === "function" ? listBundles : service.listBundles;
		const bundles = await list.call(service);
		bundle = Array.isArray(bundles) ? bundles.find((item) => item?.name === base.packageName) : undefined;
	} catch {
		return { ...base, managerReason: HOST_MANAGER_REASON.PROBE_FAILED };
	}
	const accepts = hostManagerAcceptsBundle(bundle);
	if (!accepts.ok) {
		return { ...base, managerReason: accepts.reason, installedVersion: bundle?.version ?? "" };
	}
	return {
		...base,
		updatable: true,
		state: hmr.available ? HOST_MANAGER_STATE.READY : HOST_MANAGER_STATE.RESTART_REQUIRED,
		channel: UPDATE_CHANNEL.HOST_MANAGER,
		installedVersion: bundle?.version ?? "",
	};
}

/**
 * 在「宿主原生免重启更新」与「传统重启更新」之间选通道。
 *
 * 规则（顺序即优先级）：
 *   1. 宿主管理器可用 → 用它（免重启，且不依赖我们能重启宿主）。
 *   2. 否则传统重启通道可用（systemd / 前台 web）→ 用重启。
 *   3. 都不行 → 人工指引。
 *
 * 注意第 1 条**不看** `hmrAvailable`：没有 HMR 时宿主管理器仍会把包装好，
 * 只是返回 `restart-required`。这种情形仍优先走管理器——它至少保证了
 * 「依赖真的被装上了」，比我们自己 `pnpm install` 更可靠；重启由宿主报告为准。
 *
 * @param {object} input
 * @param {boolean} input.hostManagerAvailable - 宿主管理器是否可用（且本插件可被它更新）。
 * @param {boolean} input.canRestart - 传统重启通道是否可用。
 * @returns {{channel: string, reason: string}}
 */
export function chooseUpdateChannel({ hostManagerAvailable = false, canRestart = false } = {}) {
	if (hostManagerAvailable) return { channel: UPDATE_CHANNEL.HOST_MANAGER, reason: "" };
	if (canRestart) return { channel: UPDATE_CHANNEL.RESTART, reason: "" };
	return { channel: UPDATE_CHANNEL.GUIDANCE, reason: "no-update-channel" };
}

/** 通道 → 面向用户的一句话说明（手机与桌面共用，避免两端文案漂移）。 */
export function describeUpdateChannel(channel) {
	switch (channel) {
	case UPDATE_CHANNEL.HOST_MANAGER:
		return "由 DSH 插件管理器在进程内更新，无需重启宿主";
	case UPDATE_CHANNEL.RESTART:
		return "安装新版本后重启宿主使插件生效";
	default:
		return "当前形态无法自动更新，需要人工处理";
	}
}
