// 演练 registry 子域：临时 Verdaccio 实例（正常 200mb / 失败演练 10mb）、健康检查、
// registry 元数据查询（dist-tags / versions）、npm 发布与 pnpm 安装封装。
//
// ── R1 安全围栏（复评 BLOCKING）────────────────────────────────────────────────────
// npm 对 scoped 包优先使用 `@scope:registry`，且会继承 `NPM_CONFIG_USERCONFIG` 里的路由；
// 只给子进程传 `--registry` 并不能阻止"发到用户配置里的另一个源"。因此演练**永远不原样继承**
// 用户 npm 配置：为每个受检 registry 生成专用 userconfig（固定 registry 与 `@scope:registry`），
// 只迁移目标 host 的凭据；发布/安装前用 `npm config get` 自检实际生效路由，失败即 fail-closed。
//
// 其余硬约束：临时实例只绑定 127.0.0.1、无 uplink、数据目录在仓库外；只检查全局 Verdaccio
// 是否存在，绝不自动安装或修改全局环境（issue #37 Implementation Decisions）。
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
	ensureDir, existsFile, freePort, isolatedEnv, readTextFile, runCommand, sleep, writeTextFile,
} from "./process.mjs";

/** 正常演练实例的请求体上限（> 实测发布请求体，issue #37）。 */
export const NORMAL_MAX_BODY = "200mb";
/** 失败演练实例的上限：默认 10mb（Verdaccio 默认值），用于复现 E413。 */
export const LOW_LIMIT_MAX_BODY = "10mb";

/** registry 地址归一（统一尾斜杠），用于 npm 配置与比对。 */
export function normalizeRegistryUrl(url) {
	return `${String(url ?? "").trim().replace(/\/+$/, "")}/`;
}

/** 包名 → scope（`@marktrue/dsh-mobile-remote` → `@marktrue`；无 scope 返回空串）。 */
export function packageScope(packageName) {
	const match = /^(@[^/\s]+)\//.exec(String(packageName ?? ""));
	return match ? match[1] : "";
}

/** 读取 npmrc 文本为有序键值（忽略空行与注释；值保持原始文本）。 */
export function parseNpmrcEntries(text) {
	const entries = [];
	for (const line of String(text ?? "").split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		entries.push({ key: trimmed.slice(0, eq).trim(), value: trimmed.slice(eq + 1).trim() });
	}
	return entries;
}

function npmAuthEnv({ env, userconfig, globalconfig }) {
	const merged = { ...env };
	if (userconfig !== "") {
		merged.NPM_CONFIG_USERCONFIG = userconfig;
		merged.npm_config_userconfig = userconfig;
	}
	if (globalconfig !== "") {
		merged.NPM_CONFIG_GLOBALCONFIG = globalconfig;
		merged.npm_config_globalconfig = globalconfig;
	}
	return merged;
}

/**
 * 解析 npm nerf-dart 凭据键：`//host[:port]/path/:_authToken` → `{host, path, field}`。
 * 仅识别受支持的凭据字段；其他键（registry=、scope 路由等）不迁移。
 */
export function parseNerfDartKey(key) {
	const match = /^\/\/([^/]+)(\/[^:]*)?:(_authToken|_auth|_password|username|email)$/i.exec(String(key ?? ""));
	if (!match) return null;
	const rawPath = match[2] ?? "/";
	const host = match[1];
	const pathName = rawPath.endsWith("/") ? rawPath : `${rawPath}/`;
	return { host, path: pathName, field: match[3].toLowerCase() };
}

/** 凭据路径是否是受检 registry 路径的前缀（npm 的最长前缀匹配语义）。 */
export function nerfDartAppliesTo(credentialPath, registryPath) {
	const cred = String(credentialPath ?? "");
	const target = String(registryPath ?? "");
	return cred !== "" && cred.startsWith("/") && target.startsWith(cred);
}

/**
 * R1：生成演练专用 userconfig。
 * - 固定 `registry=<受检地址>` 与 `@<scope>:registry=<受检地址>`（scope 从**已校验的真实源包名**推导）；
 * - 仅迁移**受检 registry 路径**实际需要的凭据（npm nerf-dart 前缀语义）：同 host 下其他
 *   registry 路径的凭据不迁移；
 * - 目标路径无用户凭据时，可用调用方提供的一次性 token 或环境 `NPM_TOKEN`/`NODE_AUTH_TOKEN`。
 */
export function buildIsolatedUserConfig({
	runDir,
	label,
	registryUrl,
	pluginName,
	sourceUserConfigPath = "",
	env = process.env,
	authToken = "",
}) {
	const target = normalizeRegistryUrl(registryUrl);
	const parsed = new URL(target);
	const host = parsed.host;
	const registryPath = parsed.pathname.endsWith("/") ? parsed.pathname : `${parsed.pathname}/`;
	const scope = packageScope(pluginName);
	const lines = [`registry=${target}`];
	if (scope !== "") lines.push(`${scope}:registry=${target}`);
	const migrated = [];
	const skipped = [];
	if (sourceUserConfigPath !== "" && existsFile(sourceUserConfigPath)) {
		for (const entry of parseNpmrcEntries(readTextFile(sourceUserConfigPath))) {
			const credential = parseNerfDartKey(entry.key);
			if (credential === null) continue;
			if (credential.host !== host) continue;
			// R1 续：同一 host 下只有"受检 registry 路径的前缀"凭据才迁移；其他路径的
			// registry 命名空间凭据不得带进演练子进程（否则包内/项目配置改投时仍有凭据可用）。
			if (!nerfDartAppliesTo(credential.path, registryPath)) {
				skipped.push(entry.key);
				continue;
			}
			lines.push(`${entry.key}=${entry.value}`);
			migrated.push(entry.key);
		}
	}
	const hasHostToken = migrated.some((key) => /:(_authToken|_auth)$/i.test(key));
	let usedEnvToken = false;
	if (!hasHostToken) {
		const envToken = typeof env.NPM_TOKEN === "string" && env.NPM_TOKEN !== ""
			? env.NPM_TOKEN
			: (typeof env.NODE_AUTH_TOKEN === "string" ? env.NODE_AUTH_TOKEN : "");
		const materialized = authToken !== "" ? authToken : envToken;
		if (materialized !== "") {
			lines.push(`//${host}/:_authToken=${materialized}`);
			usedEnvToken = authToken === "" && envToken !== "";
		}
	}
	const userconfig = path.join(runDir, "npmrc", `${label}.npmrc`);
	ensureDir(path.dirname(userconfig));
	writeTextFile(userconfig, `${lines.join("\n")}\n`);
	try {
		fs.chmodSync(userconfig, 0o600);
	} catch {
		// 权限收紧失败不阻塞；文件只含一次性演练 token。
	}
	return { ok: true, path: userconfig, host, scope, registryPath, migrated, skipped, usedEnvToken };
}

/** 空白 globalconfig：屏蔽系统/全局 npm 配置里的 registry 路由（只影响演练子进程）。 */
export function writeEmptyGlobalConfig({ runDir, label }) {
	const file = path.join(runDir, "npmrc", `${label}.global.npmrc`);
	ensureDir(path.dirname(file));
	writeTextFile(file, "# drill: intentionally empty (blocks global registry routing)\n");
	return file;
}

/**
 * npm finds project .npmrc by walking upward from cwd. Keep config probes and publishes
 * under a synthetic project root so a caller's $HOME/package.json/.npmrc cannot override
 * the isolated userconfig (e.g. a local prefix/npmmirror setting).
 */
function isolatedNpmProjectCwd(userconfig) {
	if (userconfig === "") return process.cwd();
	const cwd = path.join(path.dirname(userconfig), "config-probe");
	ensureDir(cwd);
	const packageJson = path.join(cwd, "package.json");
	if (!existsFile(packageJson)) {
		writeTextFile(packageJson, `${JSON.stringify({ name: "npm-drill-config-probe", private: true }, null, 2)}\n`);
	}
	return cwd;
}

function unquoteNpmValue(value) {
	const text = String(value ?? "").trim();
	if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
		return text.slice(1, -1);
	}
	return text;
}

/**
 * R1：发布/安装前自检——用与发布**相同**的 userconfig/globalconfig 读取实际生效的
 * `registry` 与 `@<scope>:registry`，两者都必须等于受检地址，否则 fail-closed。
 */
export async function verifyRegistryScope({ registryUrl, userconfig, globalconfig = "", pluginName, env, logFile = null }) {
	const target = normalizeRegistryUrl(registryUrl);
	const scope = packageScope(pluginName);
	const runEnv = npmAuthEnv({ env: env ?? isolatedEnv({ home: path.dirname(path.dirname(userconfig)) }), userconfig, globalconfig });
	const argsFor = (key) => [
		"config", "get", key,
		"--userconfig", userconfig,
		...(globalconfig !== "" ? ["--globalconfig", globalconfig] : []),
	];
	const read = async (key) => {
		const result = await runCommand({
			command: "npm",
			args: argsFor(key),
			// 用独立的临时 package root 作为 cwd，避免向上发现调用方项目的 .npmrc。
			cwd: isolatedNpmProjectCwd(userconfig),
			env: runEnv,
			logFile,
			timeoutMs: 30_000,
			label: `npm config get ${key}`,
		});
		return { ok: result.ok, value: result.ok ? String(result.stdout).trim() : "" };
	};
	const registryValue = await read("registry");
	const scopeKey = scope !== "" ? `${scope}:registry` : null;
	const scopeValue = scopeKey === null ? { ok: true, value: target } : await read(scopeKey);
	const normalize = (value) => normalizeRegistryUrl(unquoteNpmValue(value));
	const ok = registryValue.ok && scopeValue.ok
		&& normalize(registryValue.value) === target
		&& (scopeKey === null || normalize(scopeValue.value) === target);
	return {
		ok,
		target,
		registry: normalize(registryValue.value),
		scoped: scopeKey === null ? null : normalize(scopeValue.value),
		detail: `registry=${normalize(registryValue.value) || "<空>"} ${scopeKey ?? "@scope:registry"}=${scopeKey === null ? "<无 scope>" : (normalize(scopeValue.value) || "<空>")} 期望=${target}`,
	};
}

/** Verdaccio 是否已全局安装（只检查，不安装）。 */
export async function detectVerdaccio({ env, logFile = null }) {
	const result = await runCommand({ command: "verdaccio", args: ["--version"], env, logFile, timeoutMs: 30_000, label: "verdaccio --version" });
	if (!result.ok) return { ok: false, version: null, hint: "npm i -g verdaccio@6.10.6", detail: (result.error ?? result.stderr ?? "").trim().slice(0, 300) };
	const version = /\d+\.\d+\.\d+[0-9A-Za-z.+-]*/.exec(`${result.stdout}\n${result.stderr}`)?.[0] ?? "unknown";
	return { ok: true, version, hint: "", detail: version };
}

/** Verdaccio 配置（临时实例：本地存储、无 uplink、$all 可读写，便于演练匿名发布）。 */
export function verdaccioConfigText({ storageDir, port, maxBodySize }) {
	return [
		`storage: ${JSON.stringify(storageDir)}`,
		`listen: 127.0.0.1:${port}`,
		`max_body_size: ${maxBodySize}`,
		"uplinks: {}",
		"web:",
		"  enable: false",
		"log: { type: stdout, format: pretty, level: warn }",
		"# 演练实例允许匿名读、$all 发布；npm publish 仍需要本地 token，先由演练脚本注册一次性用户。",
		"auth:",
		"  htpasswd:",
		`    file: ${JSON.stringify(`${storageDir}/htpasswd`)}`,
		"    algorithm: bcrypt",
		"    rounds: 4",
		"    max_users: 100",
		"packages:",
		"  '@*/*':",
		"    access: $all",
		"    publish: $all",
		"    unpublish: $all",
		"  '**':",
		"    access: $all",
		"    publish: $all",
		"    unpublish: $all",
		"",
	].join("\n");
}

/** 起一个 Verdaccio 实例；返回句柄（含日志文件与 URL）。 */
export async function startVerdaccio({ runDir, name, env, logFile, maxBodySize = NORMAL_MAX_BODY }) {
	const port = await freePort();
	const base = path.join(runDir, "registry", name);
	const storageDir = ensureDir(path.join(base, "storage"));
	const configFile = writeTextFile(path.join(base, "config.yaml"), verdaccioConfigText({ storageDir, port, maxBodySize }));
	const registryLog = logFile ?? path.join(runDir, "logs", `${name}.log`);
	ensureDir(path.dirname(registryLog));
	writeTextFile(registryLog, `# verdaccio ${name}: 127.0.0.1:${port}, max_body_size=${maxBodySize}\n`);
	const child = spawn("verdaccio", ["--config", configFile], {
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const handle = {
		name,
		port,
		url: `http://127.0.0.1:${port}`,
		configFile,
		storageDir,
		logFile: registryLog,
		child,
		maxBodySize,
		startedAt: Date.now(),
	};
	const stream = fs.createWriteStream(registryLog, { flags: "a" });
	child.stdout.pipe(stream);
	child.stderr.pipe(stream);
	child.on("close", (code, signal) => {
		handle.exit = { code, signal, at: Date.now() };
		stream.end();
	});
	child.on("error", (error) => {
		handle.spawnError = String(error?.message ?? error);
	});
	return handle;
}

/** 轮询 registry 健康检查（`/-/ping`）直到就绪或超时。 */
export async function waitForRegistry(url, { timeoutMs = 30_000, intervalMs = 150 } = {}) {
	const deadline = Date.now() + timeoutMs;
	const pingUrl = new URL("/-/ping", url).toString();
	let last = "";
	while (Date.now() < deadline) {
		try {
			const response = await fetch(pingUrl, { signal: AbortSignal.timeout(2_000) });
			last = `http-${response.status}`;
			if (response.ok || response.status === 404) return { ok: true, detail: last };
			await response.arrayBuffer();
		} catch (error) {
			last = String(error?.message ?? error).slice(0, 200);
		}
		await sleep(intervalMs);
	}
	return { ok: false, detail: last || "timeout" };
}

/** 停止 Verdaccio（SIGTERM，超时再 SIGKILL）；返回退出信息。 */
export async function stopVerdaccio(handle, { timeoutMs = 8_000 } = {}) {
	if (!handle || !handle.child || handle.child.exitCode !== null || handle.child.signalCode !== null) {
		return { ok: true, detail: "already-exited" };
	}
	const child = handle.child;
	const exited = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
	try {
		child.kill("SIGTERM");
	} catch {
		// 已退出。
	}
	const timeout = sleep(timeoutMs).then(() => "timeout");
	const result = await Promise.race([exited, timeout]);
	if (result === "timeout") {
		try {
			child.kill("SIGKILL");
		} catch {
			// 忽略。
		}
		return { ok: false, detail: "sigkill-after-timeout" };
	}
	return { ok: true, detail: `exit-${result.code ?? result.signal}` };
}

/** 包名 → registry packument URL（scoped 包路径只编码 `/`）。 */
export function packumentUrl(registryUrl, packageName) {
	const encoded = String(packageName).replace("/", "%2f");
	return `${registryUrl.replace(/\/+$/, "")}/${encoded}`;
}

/** 读取 registry 元数据（versions + dist-tags）。 */
export async function fetchPackument(registryUrl, packageName, { timeoutMs = 20_000 } = {}) {
	try {
		const response = await fetch(packumentUrl(registryUrl, packageName), {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) return { ok: false, status: response.status, error: `http-${response.status}`, json: null };
		const json = await response.json();
		return { ok: true, status: response.status, error: null, json };
	} catch (error) {
		return { ok: false, status: null, error: String(error?.message ?? error), json: null };
	}
}

export function packumentVersions(json) {
	const versions = json && typeof json.versions === "object" && json.versions !== null ? json.versions : {};
	return Object.keys(versions);
}

export function packumentDistTags(json) {
	return json && typeof json["dist-tags"] === "object" && json["dist-tags"] !== null ? json["dist-tags"] : {};
}

function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * R9 续：packument 结构校验（共用元数据读取层）。
 * “某版本不存在”只能由**有效版本列表**证明：响应必须是同名包的非数组对象、versions 是非数组
 * 对象，且必须能看到刚刚发布的版本（版本对象若带 name/version 还必须匹配）。HTTP 200 的错误
 * JSON、缺 versions、versions:null/[]、包名不符、刚发布版本不可见都不得当作“确实不存在”。
 * @returns {{ok:boolean, reason:string, detail:string, versions:object|null}}
 */
export function validatePackument(json, { packageName, requiredVersions = [] } = {}) {
	if (!isPlainObject(json)) {
		return { ok: false, reason: "packument-not-object", detail: `响应不是非数组对象（实际：${Array.isArray(json) ? "数组" : typeof json}）`, versions: null };
	}
	if (Object.hasOwn(json, "error") && json.error !== undefined) {
		return { ok: false, reason: "packument-error-field", detail: `响应含 error 字段：${JSON.stringify(json.error).slice(0, 160)}`, versions: null };
	}
	if (typeof json.name !== "string" || json.name !== packageName) {
		return { ok: false, reason: "packument-name-mismatch", detail: `响应 name=${JSON.stringify(json.name ?? null)} 期望=${packageName}`, versions: null };
	}
	if (!isPlainObject(json.versions)) {
		return { ok: false, reason: "packument-versions-not-object", detail: `versions 不是非数组对象（实际：${json.versions === undefined ? "缺失" : Array.isArray(json.versions) ? "数组" : typeof json.versions}）`, versions: null };
	}
	const versions = json.versions;
	for (const required of requiredVersions) {
		if (!Object.hasOwn(versions, required)) {
			return { ok: false, reason: "packument-required-version-missing", detail: `versions 中看不到刚发布的 ${required}（共 ${Object.keys(versions).length} 个版本）`, versions: null };
		}
		const entry = versions[required];
		if (!isPlainObject(entry)) {
			return { ok: false, reason: "packument-version-entry-invalid", detail: `versions[${required}] 不是版本对象（实际：${entry === null ? "null" : typeof entry}）`, versions: null };
		}
		if (Object.hasOwn(entry, "name") && entry.name !== packageName) {
			return { ok: false, reason: "packument-version-name-mismatch", detail: `versions[${required}].name=${JSON.stringify(entry.name)}`, versions: null };
		}
		if (Object.hasOwn(entry, "version") && entry.version !== required) {
			return { ok: false, reason: "packument-version-version-mismatch", detail: `versions[${required}].version=${JSON.stringify(entry.version)}`, versions: null };
		}
	}
	return { ok: true, reason: "ok", detail: `versions=${Object.keys(versions).length}`, versions };
}

/** 读取并**结构校验** packument；任何失败都返回稳定 reason，调用方据此 fail-closed。 */
export async function fetchPackumentChecked({ registryUrl, packageName, requiredVersions = [], timeoutMs = 20_000 }) {
	const raw = await fetchPackument(registryUrl, packageName, { timeoutMs });
	if (!raw.ok) {
		return {
			ok: false,
			reason: "packument-fetch-failed",
			detail: `${raw.error ?? "fetch-failed"}${raw.status === null ? "" : ` status=${raw.status}`}`,
			versions: null,
			json: raw.json,
		};
	}
	const validated = validatePackument(raw.json, { packageName, requiredVersions });
	return { ...validated, json: raw.json, status: raw.status };
}

/**
 * R1 续：npm publish 的 argv 同时固定默认 registry 与作用域 registry。
 * 包内 `publishConfig["@scope:registry"]` 会在 npm 配置合并中生效，只有**CLI 单参数**
 * `--@scope:registry=<受检地址>` 的优先级能覆盖它（复核已实测：错路径 PUT 2→0）。
 * scope 必须来自**已校验的真实源包名**（不是根 package.json 的猜测）。
 */
export async function npmPublish({
	tarball,
	tag,
	registryUrl,
	env,
	logFile,
	label,
	userconfig = "",
	globalconfig = "",
	pluginName = "",
}) {
	const scope = packageScope(pluginName);
	const pinned = scope === "" ? "" : `--${scope}:registry=${normalizeRegistryUrl(registryUrl)}`;
	return runCommand({
		command: "npm",
		cwd: isolatedNpmProjectCwd(userconfig),
		args: [
			"publish", tarball,
			"--registry", registryUrl,
			// 必须是单个 argv 元素（`--@scope:registry=URL`），不能拆成两个参数。
			...(pinned === "" ? [] : [pinned]),
			"--tag", tag,
			"--access", "public",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"--loglevel", "notice",
			...(userconfig !== "" ? ["--userconfig", userconfig] : []),
			...(globalconfig !== "" ? ["--globalconfig", globalconfig] : []),
		],
		env: npmAuthEnv({ env, userconfig, globalconfig }),
		logFile,
		timeoutMs: 180_000,
		label: label ?? `npm publish ${path.basename(tarball)} --tag ${tag}`,
	});
}

/**
 * 在临时 registry 上注册一个一次性演练用户（npm publish 需要 token；publish: $all 只放开权限，
 * npm CLI 仍要求凭据）。返回 token。
 */
export async function ensureRegistryUser({ url, username, password, email, logFile }) {
	const endpoint = `${url.replace(/\/+$/, "")}/-/user/org.couchdb.user:${encodeURIComponent(username)}`;
	try {
		const response = await fetch(endpoint, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: username, password, email, type: "user" }),
			signal: AbortSignal.timeout(20_000),
		});
		const json = await response.json().catch(() => null);
		if (!response.ok || typeof json?.token !== "string" || json.token === "") {
			return { ok: false, detail: `http-${response.status} ${JSON.stringify(json).slice(0, 200)}` };
		}
		return { ok: true, token: json.token, detail: `user=${username}` };
	} catch (error) {
		return { ok: false, detail: String(error?.message ?? error).slice(0, 300) };
	}
}

/** 在隔离 profile 目录里写 pnpm 配置（hoisted 布局，与真实 profile 一致；R1 同时钉住 scoped registry）。 */
export function writeProfile({ profileDir, registryUrl, pluginName = "" }) {
	ensureDir(profileDir);
	writeTextFile(path.join(profileDir, "package.json"), `${JSON.stringify({ name: "dsh-drill-profile", private: true }, null, 2)}\n`);
	// pnpm 10+ 的 pnpm 专属设置放在 pnpm-workspace.yaml（.npmrc 只保留 registry）。
	// autoInstallPeers=false：插件声明的是宿主提供的 peer（@deepseek-ai/*），演练 registry 只承载
	// 本次发布的两个包，不应尝试从本地源安装宿主依赖。
	writeTextFile(
		path.join(profileDir, "pnpm-workspace.yaml"),
		[
			"packages:",
			"  - .",
			"nodeLinker: hoisted",
			"autoInstallPeers: false",
			"strictPeerDependencies: false",
			"fetchRetries: 0",
			"",
		].join("\n"),
	);
	const target = normalizeRegistryUrl(registryUrl);
	const scope = packageScope(pluginName);
	const npmrc = [`registry=${target}`];
	if (scope !== "") npmrc.push(`${scope}:registry=${target}`);
	npmrc.push("auto-install-peers=false", "strict-peer-dependencies=false", "");
	writeTextFile(path.join(profileDir, ".npmrc"), npmrc.join("\n"));
	return profileDir;
}

/** pnpm add 精确版本（隔离 HOME；hoisted 布局；使用专用 userconfig/globalconfig）。 */
export async function pnpmAdd({ profileDir, spec, registryUrl, env, logFile, label, userconfig = "", globalconfig = "" }) {
	return runCommand({
		command: "pnpm",
		args: [
			"add", spec,
			"--registry", registryUrl,
			"--reporter", "append-only",
		],
		cwd: profileDir,
		env: npmAuthEnv({ env: { ...env, npm_config_registry: registryUrl }, userconfig, globalconfig }),
		logFile,
		timeoutMs: 240_000,
		label: label ?? `pnpm add ${spec}`,
	});
}

export function toolEnvForRegistry({ home, registryUrl }) {
	return isolatedEnv({ home, extra: { npm_config_registry: registryUrl } });
}
