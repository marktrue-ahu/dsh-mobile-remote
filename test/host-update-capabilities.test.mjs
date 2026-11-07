// 宿主原生插件管理能力探测（DSH 0.2.2+）与前台上网重启判定的回归测试。
//
// 覆盖三条判据：
//   1. **能力看声明**：`pluginManager` 服务与 `updateBundle` 方法是否真的存在，
//      而不是读宿主版本号（ADR 0017）。
//   2. **通道优先级**：宿主管理器 > 重启 > 人工指引；宿主管理器可用时**不看** HMR
//      是否可用（没 HMR 也会装，只是要重启）。
//   3. **重启形态**：命令行证据（`dsh web ...`）足以判为可重启的前台形态，且
//      respawn 命令复用原参数——容器里没有 systemd/DSH_PROFILE 时旧实现会误判。
import assert from "node:assert/strict";
import test from "node:test";
import {
	chooseUpdateChannel,
	describeUpdateChannel,
	detectHostUpdateCapabilities,
	hostManagerAcceptsBundle,
	HOST_MANAGER_REASON,
	HOST_MANAGER_STATE,
	probeHostHmr,
	probeHostPluginManager,
	UPDATE_CHANNEL,
} from "../lib/host-update-capabilities.js";
import {
	HOST_MANAGER_ERROR,
	interpretHostManagerUpdate,
	runHostManagerUpdate,
	validateHostManagerTarget,
} from "../lib/host-manager-update.js";
import { detectRestartForm, firstDshPositional, isDshWebCommandLine, respawnCommandOf } from "../lib/plugin-self-update.js";

/** 造一个带 `get()` 的假 ctx。 */
function fakeCtx(services = {}) {
	return { get: (name) => services[name] };
}

test("探测：没有 pluginManager 服务 → 不可用，原因是 service-missing", () => {
	const result = probeHostPluginManager(fakeCtx({}));
	assert.equal(result.available, false);
	assert.equal(result.reason, HOST_MANAGER_REASON.SERVICE_MISSING);
});

test("探测：服务存在但缺 updateBundle 方法 → 不可用（不按版本号推断）", () => {
	const result = probeHostPluginManager(fakeCtx({ pluginManager: { listBundles: async () => [] } }));
	assert.equal(result.available, false);
	assert.equal(result.reason, HOST_MANAGER_REASON.METHOD_MISSING);
});

test("探测：服务与 updateBundle 都在 → 可用", () => {
	const service = { updateBundle: async () => ({}), listBundles: async () => [] };
	const result = probeHostPluginManager(fakeCtx({ pluginManager: service }));
	assert.equal(result.available, true);
	assert.equal(result.service, service);
});

test("探测：ctx.get 抛错 → 收敛为 unsupported，不向上抛", () => {
	const ctx = { get: () => { throw new Error("boom"); } };
	assert.equal(probeHostPluginManager(ctx).available, false);
	assert.equal(probeHostHmr(ctx).available, false);
});

test("探测 HMR：缺服务 → hmr-missing", () => {
	assert.equal(probeHostHmr(fakeCtx({})).available, false);
	assert.equal(probeHostHmr(fakeCtx({})).reason, HOST_MANAGER_REASON.HMR_MISSING);
});

test("探测 HMR：有 reconcileProfile 才算可用", () => {
	assert.equal(probeHostHmr(fakeCtx({ hmr: { reconcileProfile: async () => ({}) } })).available, true);
	assert.equal(probeHostHmr(fakeCtx({ hmr: {} })).available, false);
});

test("bundle 准入：updatable=false 或带 readOnlyReason 一律拒绝", () => {
	assert.equal(hostManagerAcceptsBundle(undefined).ok, false);
	assert.equal(hostManagerAcceptsBundle({ updatable: false }).ok, false);
	assert.equal(hostManagerAcceptsBundle({ updatable: true, readOnlyReason: "management-required" }).ok, false);
	assert.equal(hostManagerAcceptsBundle({ updatable: true }).ok, true);
});

test("汇总探测：可用 + HMR → ready；可用无 HMR → restart-required", async () => {
	const service = { updateBundle: async () => ({}), listBundles: async () => [{ name: "pkg", updatable: true, version: "1.0.0" }] };
	const ready = await detectHostUpdateCapabilities({
		ctx: fakeCtx({ pluginManager: service, hmr: { reconcileProfile: async () => ({}) } }),
		packageName: "pkg",
	});
	assert.equal(ready.state, HOST_MANAGER_STATE.READY);
	assert.equal(ready.channel, UPDATE_CHANNEL.HOST_MANAGER);
	assert.equal(ready.installedVersion, "1.0.0");

	const restart = await detectHostUpdateCapabilities({ ctx: fakeCtx({ pluginManager: service }), packageName: "pkg" });
	assert.equal(restart.state, HOST_MANAGER_STATE.RESTART_REQUIRED);
	// 没有 HMR 仍走宿主管理器：它至少保证依赖真的装上，只是结果要重启生效。
	assert.equal(restart.channel, UPDATE_CHANNEL.HOST_MANAGER);
});

test("汇总探测：bundle 不可被宿主更新 → unsupported + not-updatable", async () => {
	const service = { updateBundle: async () => ({}), listBundles: async () => [{ name: "pkg", updatable: false }] };
	const result = await detectHostUpdateCapabilities({ ctx: fakeCtx({ pluginManager: service }), packageName: "pkg" });
	assert.equal(result.state, HOST_MANAGER_STATE.UNSUPPORTED);
	assert.equal(result.reason ?? result.managerReason, HOST_MANAGER_REASON.NOT_UPDATABLE);
	assert.equal(result.updatable, false);
});

test("汇总探测：listBundles 抛错 → probe-failed，不抛出", async () => {
	const service = { updateBundle: async () => ({}), listBundles: async () => { throw new Error("io"); } };
	const result = await detectHostUpdateCapabilities({ ctx: fakeCtx({ pluginManager: service }), packageName: "pkg" });
	assert.equal(result.managerReason, HOST_MANAGER_REASON.PROBE_FAILED);
	assert.equal(result.managerAvailable, true);
});

test("通道选择：宿主管理器优先于重启；都不行给 guidance", () => {
	assert.equal(chooseUpdateChannel({ hostManagerAvailable: true, canRestart: true }).channel, UPDATE_CHANNEL.HOST_MANAGER);
	assert.equal(chooseUpdateChannel({ hostManagerAvailable: false, canRestart: true }).channel, UPDATE_CHANNEL.RESTART);
	const none = chooseUpdateChannel({});
	assert.equal(none.channel, UPDATE_CHANNEL.GUIDANCE);
	assert.equal(none.reason, "no-update-channel");
});

test("通道文案：宿主管理器明确说明不重启", () => {
	assert.match(describeUpdateChannel(UPDATE_CHANNEL.HOST_MANAGER), /无需重启/);
	assert.match(describeUpdateChannel(UPDATE_CHANNEL.RESTART), /重启/);
});

test("目标校验：非法版本与不高于已装版本都提前拒绝", () => {
	assert.equal(validateHostManagerTarget({ targetVersion: "not-a-version" }).reason, HOST_MANAGER_ERROR.VERSION_INVALID);
	assert.equal(validateHostManagerTarget({ targetVersion: "1.0.0", installedVersion: "1.0.0" }).reason, HOST_MANAGER_ERROR.VERSION_NOT_NEWER);
	assert.equal(validateHostManagerTarget({ targetVersion: "1.0.0", installedVersion: "2.0.0" }).reason, HOST_MANAGER_ERROR.VERSION_NOT_NEWER);
	assert.equal(validateHostManagerTarget({ targetVersion: "2.0.0", installedVersion: "1.0.0" }).ok, true);
	// 我们的比较器认不出时放行给宿主判定，不因解析面更窄而误拒。
	assert.equal(validateHostManagerTarget({ targetVersion: "2.0.0-beta.1", installedVersion: "1.0.0" }).ok, true);
});

test("结果解释：applied 成功；restart-required 需重启；failed 带稳定码", () => {
	assert.equal(interpretHostManagerUpdate({ from: "1.0.0", to: "2.0.0", step: "install",
		result: { application: "applied" } }).ok, true);

	const restart = interpretHostManagerUpdate({ result: { application: "restart-required", restartReason: "no-hmr" } });
	assert.equal(restart.ok, false);
	assert.equal(restart.reason, HOST_MANAGER_ERROR.RESTART_REQUIRED);
	assert.equal(restart.detail, "no-hmr");

	const failed = interpretHostManagerUpdate({ result: { application: "failed", error: { code: "operation-error", diagnostic: "SECRET /home/mark/.npmrc" } } });
	assert.equal(failed.ok, false);
	assert.equal(failed.reason, HOST_MANAGER_ERROR.REJECTED);
	// 只透出稳定 code，绝不把宿主 diagnostic（可能含路径/凭据）带给客户端。
	assert.equal(failed.detail, "operation-error");
	assert.ok(!JSON.stringify(failed).includes("SECRET"));

	assert.equal(interpretHostManagerUpdate({ result: { application: "cancelled" } }).reason, HOST_MANAGER_ERROR.CANCELLED);
	assert.equal(interpretHostManagerUpdate({ result: { application: "overridden" } }).reason, HOST_MANAGER_ERROR.OVERRIDDEN);
});

test("结果解释：没有 result 也收敛成 rejected，不抛错", () => {
	const result = interpretHostManagerUpdate({ from: "1.0.0", to: "2.0.0" });
	assert.equal(result.ok, false);
	assert.equal(result.reason, HOST_MANAGER_ERROR.REJECTED);
});

test("执行：调 updateBundle 收到正确的包名与版本，且只在显式给 registry 时才传 options", async () => {
	const calls = [];
	const service = { updateBundle: async (name, version, options) => { calls.push({ name, version, options }); return { from: "1.0.0", to: version, step: "install", result: { application: "applied" } }; } };
	const plain = await runHostManagerUpdate({ service, packageName: "pkg", targetVersion: "2.0.0", installedVersion: "1.0.0" });
	assert.equal(plain.ok, true);
	assert.equal(calls[0].name, "pkg");
	assert.equal(calls[0].version, "2.0.0");
	assert.equal(calls[0].options, undefined);

	await runHostManagerUpdate({ service, packageName: "pkg", targetVersion: "2.0.1", installedVersion: "1.0.0", registry: "https://r.example" });
	assert.equal(calls[1].options.registry, "https://r.example");
});

test("执行：没有服务时返回 unavailable，不抛错", async () => {
	const result = await runHostManagerUpdate({ service: null, packageName: "pkg", targetVersion: "2.0.0" });
	assert.equal(result.ok, false);
	assert.equal(result.reason, HOST_MANAGER_REASON.SERVICE_MISSING);
});

test("执行：宿主 reject（锁超时/销毁）→ call-failed，不是未捕获异常", async () => {
	const service = { updateBundle: async () => { const e = new Error("disposed"); e.code = "disposed"; throw e; } };
	const result = await runHostManagerUpdate({ service, packageName: "pkg", targetVersion: "2.0.0", installedVersion: "1.0.0" });
	assert.equal(result.ok, false);
	assert.equal(result.reason, HOST_MANAGER_ERROR.CALL_FAILED);
	assert.equal(result.detail, "disposed");
});

test("执行：目标版本不高于已装 → 不调用宿主", async () => {
	let called = false;
	const service = { updateBundle: async () => { called = true; return {}; } };
	const result = await runHostManagerUpdate({ service, packageName: "pkg", targetVersion: "1.0.0", installedVersion: "1.0.0" });
	assert.equal(result.ok, false);
	assert.equal(result.reason, HOST_MANAGER_ERROR.VERSION_NOT_NEWER);
	assert.equal(called, false);
});

test("重启形态：容器里没有 systemd/DSH_PROFILE，但命令行是 dsh web → web-foreground", () => {
	const form = detectRestartForm({
		env: {},
		platform: "linux",
		hasSystemdUnit: () => false,
		commandLine: ["/usr/bin/node", "/home/mark/.local/bin/dsh", "web", "--no-open", "--port", "3082"],
	});
	assert.equal(form, "web-foreground");
});

test("重启形态：命令行不是 web 子命令仍然 unsupported（不误判）", () => {
	assert.equal(detectRestartForm({ env: {}, platform: "linux", hasSystemdUnit: () => false,
		commandLine: ["/usr/bin/node", "/home/mark/.local/bin/dsh", "plugin", "install"] }), "unsupported");
	assert.equal(detectRestartForm({ env: {}, platform: "linux", commandLine: [] }), "unsupported");
	// macOS/Windows 明确不支持自动重启
	assert.equal(detectRestartForm({ platform: "darwin", commandLine: ["node", "/x/dsh", "web"] }), "unsupported");
});

test("路径识别：只认 dsh 入口后的第一个位置参数是 web", () => {
	assert.equal(isDshWebCommandLine(["node", "/x/dsh", "web"]), true);
	assert.equal(isDshWebCommandLine(["node", "/x/dsh", "web", "extra"]), true);
	assert.equal(isDshWebCommandLine(["node", "/x/not-dsh", "web"]), false);
	assert.equal(isDshWebCommandLine(["node"]), false);
	assert.equal(isDshWebCommandLine([]), false);
});

test("位置参数解析：跳过 dsh 自身会吃值的选项，不把选项取值当子命令", () => {
	// `--profile web` 是「启动名为 web 的 profile」，不是 web 子命令——这是最危险的误判。
	assert.equal(firstDshPositional(["--profile", "web"]), "");
	assert.equal(firstDshPositional(["--profile", "web", "run"]), "run");
	assert.equal(firstDshPositional(["--profile=web", "web"]), "web");
	assert.equal(firstDshPositional(["--patch", "a.yml", "web"]), "web");
	assert.equal(firstDshPositional(["--from-default-profile", "web"]), "");
	// 不在选项表里的 --flag 不吞取值（宁可少跳，也不猜）。
	assert.equal(firstDshPositional(["--unknown", "web"]), "web");
	// 因此 `dsh --profile web` 不会被误判成前台 web 形态。
	assert.equal(isDshWebCommandLine(["node", "/x/dsh", "--profile", "web"]), false);
});

test("respawn 命令复用原参数，并对含空格的路径加引号", () => {
	const command = respawnCommandOf(["/usr/bin/node", "/home/mark/my dsh/dsh", "web", "--port", "3082"]);
	assert.ok(command.startsWith(process.execPath));
	assert.match(command, /'\/home\/mark\/my dsh\/dsh'/);
	assert.match(command, /web --port 3082$/);
	// 不是 dsh web 形态就不给命令，由调用方退回保守写法。
	assert.equal(respawnCommandOf(["node", "/x/dsh", "plugin", "list"]), "");
});
