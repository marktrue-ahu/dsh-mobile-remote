// 演练五阶段 + 20 条断言的实现（issue #37「验收核心」）。
//
// 断言只依赖外部可观察事实：registry HTTP 元数据、npm/pnpm 退出码、安装后的文件系统布局、
// 载体发现结果、插件内容标识、预检 CLI 的稳定 reason。不断言内部函数调用顺序。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_CARRIER_STATUS, discoverAppCarrier } from "../../../lib/app-carrier.js";
import { pluginContentDigest } from "../../../lib/plugin-content-digest.js";
import { sha256Buffer, sha256File } from "../../../dsh-mobile-app/tools/lib/release-checks.mjs";
import {
	ensureDir, existsDir, existsFile, isolatedEnv, npmErrorCodes, readTextFile,
} from "./process.mjs";
import {
	LOW_LIMIT_MAX_BODY, fetchPackument, fetchPackumentChecked, npmPublish, packumentDistTags,
	packumentVersions, pnpmAdd, verifyRegistryScope, writeProfile,
} from "./registry.mjs";
import {
	makePreflightFixture, projectCarrier, projectPlugin, runPublishCarrierCheck,
	validateSourceArtifacts,
} from "./projection.mjs";
import { parseHoistedLocations, parsePnpmLockCarrierAlias } from "./layout.mjs";
import { REASONS } from "./reasons.mjs";
import { validateDrillVersions } from "./versions.mjs";


/** 断言包装：异常一律转成 FAIL（reason 兜底 drill-assertion-failed），并记录耗时。 */
async function assertion(id, title, run) {
	const started = Date.now();
	try {
		const result = await run();
		return {
			id,
			title,
			pass: Boolean(result?.pass),
			reason: result?.pass ? null : (result?.reason ?? REASONS.ASSERTION_FAILED),
			detail: result?.detail ?? "",
			durationMs: Date.now() - started,
		};
	} catch (error) {
		return {
			id,
			title,
			pass: false,
			reason: REASONS.ASSERTION_FAILED,
			detail: String(error?.message ?? error).slice(0, 500),
			durationMs: Date.now() - started,
		};
	}
}

function tail(text, limit = 400) {
	const value = String(text ?? "").trim();
	return value.length <= limit ? value : `…${value.slice(-limit)}`;
}

function installedRoot(profileDir, packageName) {
	return path.join(profileDir, "node_modules", ...String(packageName).split("/"));
}

async function registryAlive(url) {
	try {
		const response = await fetch(new URL("/-/ping", url), { signal: AbortSignal.timeout(5_000) });
		return { ok: true, detail: `http-${response.status}` };
	} catch (error) {
		return { ok: false, detail: String(error?.message ?? error).slice(0, 200) };
	}
}

/**
 * R1：所有 npm/pnpm 子进程都用演练生成的**专用** userconfig/globalconfig（显式固定
 * registry 与 `@scope:registry`，只含目标 host 凭据）；离线阶段用中性空配置，避免继承用户路由。
 */
function envForContext(ctx, registryUrl = ctx.registry.normalUrl) {
	const isLowLimit = registryUrl !== null && registryUrl === ctx.registry.lowLimitUrl;
	const userconfig = isLowLimit
		? ctx.registry.lowLimitUserConfig
		: (registryUrl ? ctx.registry.normalUserConfig : ctx.safeUserConfig);
	const globalconfig = isLowLimit
		? ctx.registry.lowLimitGlobalConfig
		: (registryUrl ? ctx.registry.normalGlobalConfig : ctx.safeGlobalConfig);
	const extra = {};
	if (registryUrl) extra.npm_config_registry = registryUrl;
	if (typeof userconfig === "string" && userconfig !== "") {
		extra.NPM_CONFIG_USERCONFIG = userconfig;
		extra.npm_config_userconfig = userconfig;
	}
	if (typeof globalconfig === "string" && globalconfig !== "") {
		extra.NPM_CONFIG_GLOBALCONFIG = globalconfig;
		extra.npm_config_globalconfig = globalconfig;
	}
	return isolatedEnv({ home: ctx.home, extra });
}

/** 源产物校验通过后，包名以**源插件包内真实 package.json** 为准（R2：不用合成元数据）。 */
function pluginName(ctx) {
	return ctx.source?.name ?? ctx.mainPackage?.name ?? "";
}

function logFile(ctx, name) {
	return path.join(ctx.logsDir, `${name}.log`);
}

// ── 静默前置：产物投影（可被 preflight 阶段单独覆盖，不在 20 条断言内）────────────────────

export async function prepareProjection(ctx) {
	const name = pluginName(ctx);
	const workDir = ensureDir(path.join(ctx.workDir, "artifacts"));
	const env = envForContext(ctx, null);
	const log = logFile(ctx, "projection");
	const pluginA = await projectPlugin({
		sourceTgz: ctx.assets.pluginTgz,
		workDir,
		name,
		version: ctx.versions.pluginA,
		carrierVersion: ctx.versions.carrierA,
		env,
		logFile: log,
		label: `project plugin ${ctx.versions.pluginA}`,
	});
	if (!pluginA.ok) throw new Error(`${REASONS.PROJECTION_FAILED}: ${pluginA.error}`);
	const carrierA = await projectCarrier({
		sourceTgz: ctx.assets.carrierTgz,
		workDir,
		version: ctx.versions.carrierA,
		manifest: ctx.assets.manifest,
		pluginProject: { ...pluginA, pluginVersion: ctx.versions.pluginA },
		env,
		logFile: log,
		label: `project carrier ${ctx.versions.carrierA}`,
	});
	if (!carrierA.ok) throw new Error(`${REASONS.PROJECTION_FAILED}: ${carrierA.error}`);
	const pluginB = await projectPlugin({
		sourceTgz: ctx.assets.pluginTgz,
		workDir,
		name,
		version: ctx.versions.pluginB,
		carrierVersion: ctx.versions.carrierB,
		env,
		logFile: log,
		label: `project plugin ${ctx.versions.pluginB}`,
	});
	if (!pluginB.ok) throw new Error(`${REASONS.PROJECTION_FAILED}: ${pluginB.error}`);
	const carrierB = await projectCarrier({
		sourceTgz: ctx.assets.carrierTgz,
		workDir,
		version: ctx.versions.carrierB,
		manifest: ctx.assets.manifest,
		pluginProject: { ...pluginB, pluginVersion: ctx.versions.pluginB },
		env,
		logFile: log,
		label: `project carrier ${ctx.versions.carrierB}`,
	});
	if (!carrierB.ok) throw new Error(`${REASONS.PROJECTION_FAILED}: ${carrierB.error}`);
	const pluginOnly = await projectPlugin({
		sourceTgz: ctx.assets.pluginTgz,
		workDir,
		name,
		version: ctx.versions.pluginOnly,
		carrierVersion: ctx.versions.carrierOnlyMissing,
		env,
		logFile: log,
		label: `project plugin-only ${ctx.versions.pluginOnly}`,
	});
	if (!pluginOnly.ok) throw new Error(`${REASONS.PROJECTION_FAILED}: ${pluginOnly.error}`);
	ctx.projection = { pluginA, carrierA, pluginB, carrierB, pluginOnly };
}

// ── 阶段 0（离线）：preflight ─────────────────────────────────────────────────────────

export async function preflightPhase(ctx) {
	const assertions = [];
	assertions.push(await assertion("P1", "源产物不变量通过（真实插件 tgz/精确别名/内容标识）且对源 dist 预检 PASS（离线）", async () => {
		const result = await validateSourceArtifacts({
			assets: ctx.assets,
			workDir: path.join(ctx.workDir, "source-validation"),
			env: envForContext(ctx, null),
			logFile: logFile(ctx, "preflight-source"),
		});
		if (!result.ok) {
			return { pass: false, reason: result.reason, detail: result.detail };
		}
		ctx.source = result;
		return {
			pass: true,
			detail: `source=${result.name}@${result.version}; 内容标识=${result.contentSha256.slice(0, 12)}…; publish-carrier-check PASS`,
		};
	}));
	assertions.push(await assertion("P2", "演练版本命名合法（9.9.x ↔ 9.9.x-app，纯 X.Y.Z，A/B/C 互不相同）", async () => {
		const result = validateDrillVersions(ctx.versions);
		return {
			pass: result.ok,
			reason: REASONS.VERSION_NAMESPACE_INVALID,
			detail: result.ok
				? `${ctx.versions.pluginA} / ${ctx.versions.pluginB} / ${ctx.versions.pluginOnly}`
				: result.problems.join(","),
		};
	}));
	return assertions;
}

// ── 阶段 1：publish（A1–A4）───────────────────────────────────────────────────────────

export async function publishPhase(ctx) {
	const assertions = [];
	const name = pluginName(ctx);
	const registryUrl = ctx.registry.normalUrl;
	const env = envForContext(ctx, registryUrl);
	const meta = () => fetchPackument(registryUrl, name);

	assertions.push(await assertion("A1", "registry 存活（本地临时实例或显式复用地址）", async () => {
		const probe = await registryAlive(registryUrl);
		return { pass: probe.ok, reason: REASONS.REGISTRY_NOT_ALIVE, detail: `${registryUrl} ${probe.detail}` };
	}));

	// 真实发布顺序：先载体（app tag），再主插件（latest）。
	const carrierPublish = await npmPublish({
		tarball: ctx.projection.carrierA.tarball,
		tag: "app",
		registryUrl,
		env,
		userconfig: ctx.registry.normalUserConfig,
		pluginName: name,
		logFile: logFile(ctx, "publish-carrier-a"),
		label: `npm publish carrierA ${ctx.versions.carrierA} --tag app`,
	});
	const pluginPublish = await npmPublish({
		tarball: ctx.projection.pluginA.tarball,
		tag: "latest",
		registryUrl,
		env,
		userconfig: ctx.registry.normalUserConfig,
		pluginName: name,
		logFile: logFile(ctx, "publish-plugin-a"),
		label: `npm publish pluginA ${ctx.versions.pluginA}`,
	});
	ctx.publish = { carrierPublish, pluginPublish };

	assertions.push(await assertion("A2", "插件发布成功且 registry 可查询到该版本", async () => {
		const current = await meta();
		const versions = current.ok ? packumentVersions(current.json) : [];
		const pass = pluginPublish.ok && current.ok && versions.includes(ctx.versions.pluginA);
		return {
			pass,
			reason: REASONS.PUBLISH_VERSION_MISSING,
			detail: pass
				? `${name}@${ctx.versions.pluginA}`
				: `publish=${pluginPublish.status}; meta=${current.error ?? "ok"}; versions=${versions.length}`,
		};
	}));

	assertions.push(await assertion("A3", "载体发布成功；dist-tags 中 app→载体、latest→插件，载体不在 latest", async () => {
		const current = await meta();
		if (!current.ok) {
			return { pass: false, reason: REASONS.CARRIER_PUBLISH_FAILED, detail: `registry meta: ${current.error}` };
		}
		const tags = packumentDistTags(current.json);
		const pass = carrierPublish.ok
			&& tags.app === ctx.versions.carrierA
			&& tags.latest === ctx.versions.pluginA
			&& tags.latest !== ctx.versions.carrierA;
		return {
			pass,
			reason: REASONS.DIST_TAG_MISMATCH,
			detail: `publish=${carrierPublish.status}; dist-tags=${JSON.stringify(tags)}`,
		};
	}));

	assertions.push(await assertion("A4", "重复发布同版本被拒（版本不可覆盖）", async () => {
		const duplicate = await npmPublish({
			tarball: ctx.projection.pluginA.tarball,
			tag: "latest",
			registryUrl,
			env,
			userconfig: ctx.registry.normalUserConfig,
			pluginName: name,
			logFile: logFile(ctx, "republish-plugin-a"),
			label: "npm publish duplicate pluginA",
		});
		const output = `${duplicate.stdout}\n${duplicate.stderr}`;
		const rejected = !duplicate.ok && /E403|EPUBLISHCONFLICT|already present|cannot publish|forbidden|409|403/i.test(output);
		return {
			pass: rejected,
			reason: REASONS.REPUBLISH_NOT_REJECTED,
			detail: rejected ? "duplicate rejected" : `exit=${duplicate.status}; ${tail(output, 300)}`,
		};
	}));

	ctx.metaA = await meta();
	return assertions;
}

// ── 阶段 2：install（A5–A10）─────────────────────────────────────────────────────────

function aliasPackageName(name) {
	return `${name}-app`;
}

export async function installPhase(ctx) {
	const assertions = [];
	const name = pluginName(ctx);
	const registryUrl = ctx.registry.normalUrl;
	const env = envForContext(ctx, registryUrl);
	const profileDir = writeProfile({ profileDir: path.join(ctx.workDir, "profile-a"), registryUrl, pluginName: name });
	const installLog = logFile(ctx, "pnpm-install-a");
	const install = await pnpmAdd({
		profileDir,
		spec: `${name}@${ctx.versions.pluginA}`,
		registryUrl,
		env,
		logFile: installLog,
		label: `pnpm add ${name}@${ctx.versions.pluginA}`,
	});
	const pluginDir = installedRoot(profileDir, name);
	const aliasDir = installedRoot(profileDir, aliasPackageName(name));
	ctx.install = { profileDir, pluginDir, aliasDir };

	assertions.push(await assertion("A5", "全新隔离 HOME + 新 profile 安装主插件成功", async () => {
		let version = null;
		try {
			version = JSON.parse(readTextFile(path.join(pluginDir, "package.json"))).version ?? null;
		} catch {
			version = null;
		}
		const pass = install.ok && version === ctx.versions.pluginA;
		return {
			pass,
			reason: install.ok ? REASONS.PLUGIN_NOT_INSTALLED : REASONS.INSTALL_FAILED,
			detail: `exit=${install.status}; installed=${version ?? "<缺失>"}`,
		};
	}));

	assertions.push(await assertion("A6", "载体别名目录存在（optionalDependencies 精确别名落点）", async () => {
		const pass = existsDir(aliasDir);
		return { pass, reason: REASONS.CARRIER_ALIAS_MISSING, detail: aliasDir };
	}));

	assertions.push(await assertion("A7", "别名目录 package.json 的真实 name/version 正确且带载体数据标记", async () => {
		try {
			const pkg = JSON.parse(readTextFile(path.join(aliasDir, "package.json")));
			const pass = pkg.name === name && pkg.version === ctx.versions.carrierA && pkg.dsh?.appCarrier === true;
			return {
				pass,
				reason: REASONS.CARRIER_IDENTITY_MISMATCH,
				detail: `name=${pkg.name}; version=${pkg.version}; appCarrier=${pkg.dsh?.appCarrier}`,
			};
		} catch (error) {
			return { pass: false, reason: REASONS.CARRIER_ALIAS_MISSING, detail: String(error?.message ?? error) };
		}
	}));

	assertions.push(await assertion("A8", "载体内 APK 的 size 与 sha256 与发布清单一致", async () => {
		const app = ctx.assets.manifest.app ?? {};
		const apkFile = path.join(aliasDir, String(app.file ?? ""));
		if (!existsFile(apkFile)) {
			return { pass: false, reason: REASONS.APK_BYTES_MISMATCH, detail: `APK 缺失：${app.file ?? "<未知>"}` };
		}
		const buffer = fs.readFileSync(apkFile);
		const pass = buffer.length === app.size && sha256Buffer(buffer) === app.sha256;
		return { pass, reason: REASONS.APK_BYTES_MISMATCH, detail: `size=${buffer.length}/${app.size}` };
	}));

	assertions.push(await assertion("A9", "lockfile 中插件快照的 optionalDependencies 精确映射载体别名", async () => {
		const lockfile = path.join(profileDir, "pnpm-lock.yaml");
		if (!existsFile(lockfile)) return { pass: false, reason: REASONS.LOCKFILE_ALIAS_MISSING, detail: "pnpm-lock.yaml 缺失" };
		const parsed = parsePnpmLockCarrierAlias(readTextFile(lockfile), {
			pluginName: name,
			pluginVersion: ctx.versions.pluginA,
			carrierAlias: aliasPackageName(name),
		});
		return { pass: parsed.ok, reason: REASONS.LOCKFILE_ALIAS_MISSING, detail: parsed.detail };
	}));

	assertions.push(await assertion("A10", ".modules.yaml 的 hoistedLocations 精确落点包含载体", async () => {
		const modulesFile = path.join(profileDir, "node_modules", ".modules.yaml");
		if (!existsFile(modulesFile)) return { pass: false, reason: REASONS.HOISTED_MAPPING_MISSING, detail: ".modules.yaml 缺失" };
		const parsed = parseHoistedLocations(readTextFile(modulesFile), {
			carrierName: name,
			carrierVersion: ctx.versions.carrierA,
			carrierAlias: aliasPackageName(name),
			profileRoot: profileDir,
		});
		return { pass: parsed.ok, reason: REASONS.HOISTED_MAPPING_MISSING, detail: parsed.detail };
	}));

	return assertions;
}

// ── 阶段 3：discover（A11–A13）───────────────────────────────────────────────────────

export async function discoverPhase(ctx) {
	const assertions = [];
	const name = pluginName(ctx);
	const pluginDir = fs.realpathSync(ctx.install.pluginDir);
	const aliasDir = installedRoot(ctx.install.profileDir, aliasPackageName(name));
	const discovery = discoverAppCarrier({ pluginRoot: pluginDir, dshHome: ctx.dshHome });

	assertions.push(await assertion("A11", "实际安装布局下载体发现返回 found，来源为插件自身作用域", async () => {
		const pass = discovery.status === APP_CARRIER_STATUS.FOUND && discovery.discoveredVia === "plugin";
		return {
			pass,
			reason: discovery.status === APP_CARRIER_STATUS.FOUND
				? REASONS.CARRIER_DISCOVERY_SOURCE_MISMATCH
				: REASONS.CARRIER_NOT_FOUND,
			detail: `status=${discovery.status}; reason=${discovery.reason}; via=${discovery.discoveredVia ?? "<无>"}`,
		};
	}));

	assertions.push(await assertion("A12", "载体清单的 App 版本（构建号）与发布目录清单一致，APK 身份一致", async () => {
		const manifestFile = path.join(aliasDir, "manifest.json");
		if (!existsFile(manifestFile)) return { pass: false, reason: REASONS.CARRIER_MANIFEST_APP_MISMATCH, detail: "manifest.json 缺失" };
		const manifest = JSON.parse(readTextFile(manifestFile));
		const expected = ctx.assets.manifest.app ?? {};
		const buildOf = (version) => /^\d+\.\d+\.\d+\+(\d+)$/.exec(String(version ?? ""))?.[1] ?? null;
		const build = buildOf(manifest.app?.version);
		// 演练清单的 app 语义版本被投影成演练版本（运行时版本契约），但构建号与 APK 身份必须
		// 仍与发布目录清单一致：App 字节与构建号才是「发布的那个 App」。
		const pass = build !== null
			&& build === buildOf(expected.version)
			&& manifest.app?.file === expected.file
			&& manifest.app?.size === expected.size
			&& manifest.app?.sha256 === expected.sha256;
		return {
			pass,
			reason: REASONS.CARRIER_MANIFEST_APP_MISMATCH,
			detail: `carrier=${manifest.app?.version}/${manifest.app?.sha256?.slice(0, 12)} 源=${expected.version}/${String(expected.sha256).slice(0, 12)}`,
		};
	}));

	assertions.push(await assertion("A13", "已安装插件内容标识与随包清单的 plugin.contentSha256 一致（expected 读自安装目录）", async () => {
		// R4：expected 必须来自**实际安装/实际发现的载体清单**，不能用内存里的投影清单。
		const installedManifestFile = path.join(aliasDir, "manifest.json");
		if (!existsFile(installedManifestFile)) {
			return { pass: false, reason: REASONS.INSTALLED_CARRIER_MANIFEST_MISMATCH, detail: "安装载体清单缺失" };
		}
		let installedManifest;
		try {
			installedManifest = JSON.parse(readTextFile(installedManifestFile));
		} catch (error) {
			return { pass: false, reason: REASONS.INSTALLED_CARRIER_MANIFEST_MISMATCH, detail: String(error?.message ?? error) };
		}
		const expected = installedManifest.plugin?.contentSha256;
		const actual = pluginContentDigest(pluginDir);
		// 随包清单除摘要外，还应与本次投影发布的身份一致（版本/文件名/大小/字节哈希）。
		const projected = ctx.projection.carrierA.manifest.plugin;
		const identityOk = installedManifest.plugin?.version === projected.version
			&& installedManifest.plugin?.file === projected.file
			&& installedManifest.plugin?.size === projected.size
			&& installedManifest.plugin?.sha256 === projected.sha256
			&& typeof expected === "string" && /^[a-f0-9]{64}$/.test(expected);
		if (!identityOk) {
			return {
				pass: false,
				reason: REASONS.INSTALLED_CARRIER_MANIFEST_MISMATCH,
				detail: `安装清单 plugin 段与投影身份不符：${JSON.stringify(installedManifest.plugin ?? null)}`,
			};
		}
		// 载体发现另行返回 pluginContent.matches；FOUND 不代表摘要匹配，必须显式要求它成立。
		const discoveryMatches = discovery.pluginContent?.matches === true;
		const pass = actual === expected && discoveryMatches;
		return {
			pass,
			reason: REASONS.PLUGIN_DIGEST_MISMATCH,
			detail: `actual=${actual.slice(0, 12)}… installed-manifest=${String(expected).slice(0, 12)}… discovery.matches=${discovery.pluginContent?.matches}`,
		};
	}));

	ctx.discoveryA = discovery;
	return assertions;
}

// ── 阶段 4：update（A14–A16）────────────────────────────────────────────────────────

export async function updatePhase(ctx) {
	const assertions = [];
	const name = pluginName(ctx);
	const registryUrl = ctx.registry.normalUrl;
	const env = envForContext(ctx, registryUrl);
	const meta = () => fetchPackument(registryUrl, name);

	const carrierPublishB = await npmPublish({
		tarball: ctx.projection.carrierB.tarball,
		tag: "app",
		registryUrl,
		env,
		userconfig: ctx.registry.normalUserConfig,
		pluginName: name,
		logFile: logFile(ctx, "publish-carrier-b"),
		label: `npm publish carrierB ${ctx.versions.carrierB} --tag app`,
	});
	const pluginPublishB = await npmPublish({
		tarball: ctx.projection.pluginB.tarball,
		tag: "latest",
		registryUrl,
		env,
		userconfig: ctx.registry.normalUserConfig,
		pluginName: name,
		logFile: logFile(ctx, "publish-plugin-b"),
		label: `npm publish pluginB ${ctx.versions.pluginB}`,
	});

	assertions.push(await assertion("A14", "发布第二对新版本成功（插件 + 载体 + dist-tags）", async () => {
		const current = await meta();
		const versions = current.ok ? packumentVersions(current.json) : [];
		const tags = current.ok ? packumentDistTags(current.json) : {};
		const pass = carrierPublishB.ok && pluginPublishB.ok && current.ok
			&& versions.includes(ctx.versions.pluginB)
			&& versions.includes(ctx.versions.carrierB)
			&& tags.app === ctx.versions.carrierB
			&& tags.latest === ctx.versions.pluginB;
		return {
			pass,
			reason: REASONS.SECOND_PAIR_PUBLISH_FAILED,
			detail: `carrier=${carrierPublishB.status}; plugin=${pluginPublishB.status}; tags=${JSON.stringify(tags)}`,
		};
	}));

	const update = await pnpmAdd({
		profileDir: ctx.install.profileDir,
		spec: `${name}@${ctx.versions.pluginB}`,
		registryUrl,
		env,
		logFile: logFile(ctx, "pnpm-update-b"),
		label: `pnpm add ${name}@${ctx.versions.pluginB}`,
	});
	const aliasDir = installedRoot(ctx.install.profileDir, aliasPackageName(name));
	const pluginDirB = installedRoot(ctx.install.profileDir, name);

	assertions.push(await assertion("A15", "原安装更新成功，别名目录版本变为新载体版本", async () => {
		let carrierVersion = null;
		let pluginVersion = null;
		try {
			carrierVersion = JSON.parse(readTextFile(path.join(aliasDir, "package.json"))).version ?? null;
			pluginVersion = JSON.parse(readTextFile(path.join(pluginDirB, "package.json"))).version ?? null;
		} catch {
			// 交给 pass 判定。
		}
		const pass = update.ok && pluginVersion === ctx.versions.pluginB && carrierVersion === ctx.versions.carrierB;
		return {
			pass,
			reason: REASONS.UPDATE_FAILED,
			detail: `exit=${update.status}; plugin=${pluginVersion ?? "<缺失>"}; carrier=${carrierVersion ?? "<缺失>"}`,
		};
	}));

	assertions.push(await assertion("A16", "旧载体被替换，再次发现得到新版本", async () => {
		const pluginDir = fs.realpathSync(pluginDirB);
		const discovery = discoverAppCarrier({ pluginRoot: pluginDir, dshHome: ctx.dshHome });
		const aliasVersion = (() => {
			try {
				return JSON.parse(readTextFile(path.join(aliasDir, "package.json"))).version ?? null;
			} catch {
				return null;
			}
		})();
		const pass = discovery.status === APP_CARRIER_STATUS.FOUND
			&& discovery.carrier?.version === ctx.versions.carrierB
			&& aliasVersion === ctx.versions.carrierB
			&& discovery.carrier?.version !== ctx.versions.carrierA;
		return {
			pass,
			reason: REASONS.CARRIER_NOT_REPLACED,
			detail: `status=${discovery.status}; discovered=${discovery.carrier?.version ?? "<无>"}; installed=${aliasVersion ?? "<无>"}`,
		};
	}));

	ctx.metaB = await meta();
	return assertions;
}

// ── 阶段 5：failure（A17–A20）───────────────────────────────────────────────────────

export async function failurePhase(ctx) {
	const assertions = [];
	const name = pluginName(ctx);
	const registryUrl = ctx.registry.normalUrl;
	const env = envForContext(ctx, registryUrl);

	// A17：只发插件、不发载体 → 安装不报错但别名缺失，发现结果为「载体未安装」。
	const pluginOnlyPublish = await npmPublish({
		tarball: ctx.projection.pluginOnly.tarball,
		tag: "latest",
		registryUrl,
		env,
		userconfig: ctx.registry.normalUserConfig,
		pluginName: name,
		logFile: logFile(ctx, "publish-plugin-only"),
		label: `npm publish pluginOnly ${ctx.versions.pluginOnly}`,
	});
	const profileC = writeProfile({ profileDir: path.join(ctx.workDir, "profile-c"), registryUrl, pluginName: name });
	const installC = await pnpmAdd({
		profileDir: profileC,
		spec: `${name}@${ctx.versions.pluginOnly}`,
		registryUrl,
		env,
		logFile: logFile(ctx, "pnpm-install-plugin-only"),
		label: `pnpm add ${name}@${ctx.versions.pluginOnly}`,
	});
	assertions.push(await assertion("A17", "只发插件不发载体：安装不报错但别名目录缺失，发现结果为「载体未安装」", async () => {
		const pluginDirC = installedRoot(profileC, name);
		const aliasDirC = installedRoot(profileC, aliasPackageName(name));
		// R9：先核验这次降级确实经过"缺失 optional 载体"路径，而不是包里根本没声明。
		let installedPkg = null;
		try {
			installedPkg = JSON.parse(readTextFile(path.join(pluginDirC, "package.json")));
		} catch {
			installedPkg = null;
		}
		const alias = aliasPackageName(name);
		const expectedAlias = `npm:${name}@${ctx.versions.carrierOnlyMissing}`;
		const declaredOk = installedPkg?.version === ctx.versions.pluginOnly
			&& installedPkg?.optionalDependencies?.[alias] === expectedAlias;
		if (!declaredOk) {
			return {
				pass: false,
				reason: REASONS.PLUGIN_ONLY_METADATA_MISMATCH,
				detail: `installed=${installedPkg?.version ?? "<缺失>"}; ${alias}=${installedPkg?.optionalDependencies?.[alias] ?? "<未声明>"} 期望=${expectedAlias}`,
			};
		}
		// R9 续：只有**结构有效**的 packument（同名、versions 为非数组对象、能看到刚发布的
		// pluginOnly）才有资格证明"载体版本不存在"；HTTP 200 的错误 JSON 等一律 fail-closed。
		const current = await fetchPackumentChecked({
			registryUrl,
			packageName: name,
			requiredVersions: [ctx.versions.pluginOnly],
		});
		if (!current.ok) {
			return {
				pass: false,
				reason: REASONS.CARRIER_ABSENCE_CHECK_FAILED,
				detail: `${current.reason}: ${current.detail}`,
			};
		}
		const carrierInRegistry = Object.hasOwn(current.versions, ctx.versions.carrierOnlyMissing);
		if (carrierInRegistry) {
			return {
				pass: false,
				reason: REASONS.MISSING_CARRIER_UNEXPECTEDLY_PRESENT,
				detail: `registry 意外存在 ${ctx.versions.carrierOnlyMissing}`,
			};
		}
		let discovery = { status: null, reason: null };
		try {
			discovery = discoverAppCarrier({ pluginRoot: fs.realpathSync(pluginDirC), dshHome: ctx.dshHome });
		} catch {
			// 保持 status=null。
		}
		const pass = pluginOnlyPublish.ok
			&& installC.ok
			&& !existsDir(aliasDirC)
			&& discovery.status === APP_CARRIER_STATUS.MISSING
			&& discovery.reason === "carrier-not-installed";
		return {
			pass,
			reason: REASONS.OPTIONAL_MISSING_DEGRADED_MISMATCH,
			detail: `declared=${alias}→${expectedAlias}; carrierAbsent=${!carrierInRegistry}; publish=${pluginOnlyPublish.status}; install=${installC.status}; aliasMissing=${!existsDir(aliasDirC)}; discovery=${discovery.status}/${discovery.reason}`,
		};
	}));

	// A18：载体发布元数据不合规 → 预检以稳定 reason 失败。
	const fixtureBadMetadata = await makePreflightFixture({
		assets: ctx.assets,
		workDir: path.join(ctx.workDir, "fixtures"),
		kind: "bad-metadata",
		mainPackage: ctx.source?.packageJson ?? ctx.mainPackage,
		env: envForContext(ctx, null),
		logFile: logFile(ctx, "fixture-bad-metadata"),
	});
	assertions.push(await assertion("A18", "载体发布元数据不合规时，预检以稳定 reason 失败", async () => {
		if (!fixtureBadMetadata.ok) {
			return { pass: false, reason: REASONS.PREFLIGHT_REASON_MISMATCH, detail: fixtureBadMetadata.error };
		}
		const preflight = await runPublishCarrierCheck({
			distDir: fixtureBadMetadata.dir,
			mainPkgPath: fixtureBadMetadata.mainPkgPath,
			env: envForContext(ctx, null),
			logFile: logFile(ctx, "preflight-bad-metadata"),
		});
		if (preflight.ok) return { pass: false, reason: REASONS.WEB_PREFLIGHT_UNEXPECTED_PASS, detail: "预检意外通过" };
		const expected = "carrier-publish-tag-not-app";
		const pass = preflight.reasons.includes(expected);
		return {
			pass,
			reason: REASONS.PREFLIGHT_REASON_MISMATCH,
			detail: `reasons=${preflight.reasons.join(",") || "<无>"} 期望=${expected}`,
		};
	}));

	// A19：版本配对错误 → 预检以稳定 reason 失败。
	const fixtureBadPairing = await makePreflightFixture({
		assets: ctx.assets,
		workDir: path.join(ctx.workDir, "fixtures"),
		kind: "bad-version-pairing",
		mainPackage: ctx.source?.packageJson ?? ctx.mainPackage,
		env: envForContext(ctx, null),
		logFile: logFile(ctx, "fixture-bad-version-pairing"),
	});
	assertions.push(await assertion("A19", "版本配对错误时，预检以稳定 reason 失败", async () => {
		if (!fixtureBadPairing.ok) {
			return { pass: false, reason: REASONS.PREFLIGHT_REASON_MISMATCH, detail: fixtureBadPairing.error };
		}
		const preflight = await runPublishCarrierCheck({
			distDir: fixtureBadPairing.dir,
			mainPkgPath: fixtureBadPairing.mainPkgPath,
			env: envForContext(ctx, null),
			logFile: logFile(ctx, "preflight-bad-version-pairing"),
		});
		if (preflight.ok) return { pass: false, reason: REASONS.WEB_PREFLIGHT_UNEXPECTED_PASS, detail: "预检意外通过" };
		const expected = "manifest-plugin-version-mismatch";
		const pass = preflight.reasons.includes(expected);
		return {
			pass,
			reason: REASONS.PREFLIGHT_REASON_MISMATCH,
			detail: `reasons=${preflight.reasons.join(",") || "<无>"} 期望=${expected}`,
		};
	}));

	// A20：低上限 registry 复现 E413（请求体过大）。
	assertions.push(await assertion("A20", "低上限（10mb）registry 发布大体量载体失败（E413 类）", async () => {
		const ready = await ctx.ensureLowLimitRegistry();
		if (!ready.ok) {
			return { pass: false, reason: REASONS.REGISTRY_LOW_LIMIT_NOT_READY, detail: ready.detail };
		}
		const tarballBytes = ctx.projection.carrierA.size;
		// R1：低上限发布同样先做路由自检（专用 userconfig 必须把 scope 钉在该实例上）。
		const scopeCheck = await verifyRegistryScope({
			registryUrl: ready.url,
			userconfig: ctx.registry.lowLimitUserConfig,
			globalconfig: ctx.registry.lowLimitGlobalConfig,
			pluginName: name,
			env: envForContext(ctx, null),
			logFile: logFile(ctx, "scope-check-low-limit"),
		});
		if (!scopeCheck.ok) {
			return { pass: false, reason: REASONS.REGISTRY_SCOPE_MISMATCH, detail: scopeCheck.detail };
		}
		const publish = await npmPublish({
			tarball: ctx.projection.carrierA.tarball,
			tag: "app",
			registryUrl: ready.url,
			env: envForContext(ctx, ready.url),
			userconfig: ctx.registry.lowLimitUserConfig,
			pluginName: name,
			globalconfig: ctx.registry.lowLimitGlobalConfig,
			logFile: logFile(ctx, "publish-low-limit"),
			label: "npm publish carrierA to low-limit registry",
		});
		// R5：只认 npm **结构化错误码**（整行 `npm error code E413`）；不扫描任意文本里的裸数字。
		const codes = npmErrorCodes(publish);
		const matched = codes.includes("E413");
		const pass = !publish.ok && matched;
		return {
			pass,
			reason: REASONS.E413_NOT_REPRODUCED,
			detail: pass
				? `tarball=${tarballBytes}B; lowLimit=${LOW_LIMIT_MAX_BODY}; npmErrorCodes=${codes.join(",")}`
				: `tarball=${tarballBytes}B; exit=${publish.status}; npmErrorCodes=${codes.join(",") || "<无>"}; ${tail(`${publish.stdout}\n${publish.stderr}`, 300)}`,
		};
	}));

	return assertions;
}

export const PHASES = Object.freeze({
	preflight: preflightPhase,
	publish: publishPhase,
	install: installPhase,
	discover: discoverPhase,
	update: updatePhase,
	failure: failurePhase,
});

/** 5 个 registry 阶段（preflight 是离线辅助阶段，不属于 20 条断言）。 */
export const REGISTRY_PHASES = Object.freeze(["publish", "install", "discover", "update", "failure"]);

/** 20 条断言的稳定 ID（供测试与文档核对）。 */
export const ASSERTION_IDS = Object.freeze(
	Array.from({ length: 20 }, (_, index) => `A${index + 1}`),
);


