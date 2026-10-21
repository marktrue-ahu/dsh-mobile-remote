// 演练 registry 子域：临时 Verdaccio 实例（正常 200mb / 失败演练 10mb）、健康检查、
// registry 元数据查询（dist-tags / versions）、npm publish 与 pnpm install 封装。
//
// 硬约束：只绑定 127.0.0.1、无 uplink、数据目录在仓库外；只检查全局 Verdaccio 是否存在，
// 绝不自动安装或修改全局环境（issue #37 Implementation Decisions）。
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
	ensureDir, freePort, isolatedEnv, runCommand, sleep, writeTextFile,
} from "./process.mjs";

/** 正常演练实例的请求体上限（> 实测发布请求体，issue #37）。 */
export const NORMAL_MAX_BODY = "200mb";
/** 失败演练实例的上限：默认 10mb（Verdaccio 默认值），用于复现 E413。 */
export const LOW_LIMIT_MAX_BODY = "10mb";

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

/** npm publish（本地 registry，禁止任何公共源）。`tag` 必须显式给出（载体 app / 插件 latest）。 */
export async function npmPublish({ tarball, tag, registryUrl, env, logFile, label, userconfig = "" }) {
	const publishEnv = userconfig !== "" ? { ...env, NPM_CONFIG_USERCONFIG: userconfig } : env;
	return runCommand({
		command: "npm",
		args: [
			"publish", tarball,
			"--registry", registryUrl,
			"--tag", tag,
			"--access", "public",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"--loglevel", "notice",
			...(userconfig !== "" ? ["--userconfig", userconfig] : []),
		],
		env: publishEnv,
		logFile,
		timeoutMs: 180_000,
		label: label ?? `npm publish ${path.basename(tarball)} --tag ${tag}`,
	});
}

/**
 * 在临时 registry 上注册一个一次性演练用户（npm publish 需要 token；publish: $all 只放开权限，
 * npm CLI 仍要求凭据）。返回 token 与 npmrc 路径。
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

/** 为一个 registry 写 npm 认证配置（只含该 registry 的 token；文件在运行目录内）。 */
export function writeRegistryNpmrc({ runDir, label, url, token }) {
	const parsed = new URL(url);
	const userconfig = path.join(runDir, "npmrc", `${label}.npmrc`);
	ensureDir(path.dirname(userconfig));
	writeTextFile(userconfig, [
		`registry=${url.replace(/\/+$/, "")}/`,
		`//${parsed.host}/:_authToken=${token}`,
		"",
	].join("\n"));
	return userconfig;
}

/** 在隔离 profile 目录里写 pnpm 配置（hoisted 布局，与真实 profile 一致）。 */
export function writeProfile({ profileDir, registryUrl }) {
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
	writeTextFile(path.join(profileDir, ".npmrc"), `registry=${registryUrl}\nauto-install-peers=false\nstrict-peer-dependencies=false\n`);
	return profileDir;
}

/** pnpm add 精确版本（隔离 HOME；hoisted 布局）。 */
export async function pnpmAdd({ profileDir, spec, registryUrl, env, logFile, label }) {
	return runCommand({
		command: "pnpm",
		args: [
			"add", spec,
			"--registry", registryUrl,
			"--reporter", "append-only",
		],
		cwd: profileDir,
		env: { ...env, npm_config_registry: registryUrl },
		logFile,
		timeoutMs: 240_000,
		label: label ?? `pnpm add ${spec}`,
	});
}

export function toolEnvForRegistry({ home, registryUrl }) {
	return isolatedEnv({ home, extra: { npm_config_registry: registryUrl } });
}
