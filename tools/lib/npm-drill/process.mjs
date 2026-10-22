// 演练子进程与环境隔离工具：所有命令都在**隔离 HOME** 下运行，只允许访问 127.0.0.1 上的
// 临时 registry；输出同时写证据日志。纯内部工具（不对演练之外暴露 seam）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

const MAX_CAPTURE = 2 * 1024 * 1024;

/** 去掉 ANSI 转义（npm 输出在 TTY/管道下的颜色码可能干扰错误码整行匹配）。 */
export function stripAnsi(text) {
	return String(text ?? "").replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/**
 * 清掉从父进程继承的 npm 路由/凭据类配置。
 *
 * R1：npm 对 scoped 包优先使用 `@scope:registry` 与 `NPM_CONFIG_USERCONFIG` 里的路由；如果
 * 演练子进程原样继承用户配置，`--registry` 并不能真正把发布/安装钉在受检地址上。因此所有
 * npm/pnpm 子进程都必须**显式**拿到演练生成的专用 userconfig/globalconfig（见 registry.mjs
 * `buildIsolatedUserConfig`），继承链上的路由与 token 一律清除。
 */
function scrubInheritedNpmRouting(env) {
	for (const key of Object.keys(env)) {
		const lower = key.toLowerCase();
		if (lower === "npm_token" || lower === "node_auth_token") {
			delete env[key];
			continue;
		}
		if (!lower.startsWith("npm_config_")) continue;
		const routing = lower.includes("registry") || lower.includes("userconfig") || lower.includes("globalconfig")
			|| lower.includes("tag") || lower.includes("@") || lower.includes("token") || lower.includes("auth");
		if (routing) delete env[key];
	}
}

/** 隔离的进程环境：独立 HOME/XDG/npm cache，清空代理变量与继承的 npm 路由配置。 */
export function isolatedEnv({ home, extra = {}, clearProxy = true, scrubNpmRouting = true }) {
	const env = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: path.join(home, ".config"),
		XDG_CACHE_HOME: path.join(home, ".cache"),
		XDG_DATA_HOME: path.join(home, ".local", "share"),
		npm_config_cache: path.join(home, ".npm-cache"),
		npm_config_audit: "false",
		npm_config_fund: "false",
		npm_config_update_notifier: "false",
		npm_config_loglevel: "warn",
		NO_PROXY: "127.0.0.1,localhost",
		no_proxy: "127.0.0.1,localhost",
	};
	if (clearProxy) {
		for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) {
			env[key] = "";
		}
	}
	if (scrubNpmRouting) scrubInheritedNpmRouting(env);
	return { ...env, ...extra };
}

/**
 * 从子进程输出里抽取 npm **结构化错误码**（R5：只认独立错误码行，不扫描裸数字）。
 * npm 11 形如 `npm error code E413`；旧版形如 `npm ERR! code E413`。
 */
export function npmErrorCodes(result) {
	const text = stripAnsi(`${result?.stdout ?? ""}\n${result?.stderr ?? ""}`);
	const codes = [];
	for (const line of text.split(/\r?\n/)) {
		const match = /^npm (?:error|ERR!) code ([A-Z0-9_]+)\s*$/.exec(line.trim());
		if (match) codes.push(match[1]);
	}
	return [...new Set(codes)];
}

/** 取一个本机空闲端口（只绑定 127.0.0.1）。 */
export async function freePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.unref();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			server.close(() => (port > 0 ? resolve(port) : reject(new Error("no-free-port"))));
		});
	});
}

export function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendLog(logFile, chunk) {
	if (!logFile) return;
	try {
		fs.appendFileSync(logFile, chunk);
	} catch {
		// 证据日志写失败不应改变演练结果；run.json 里会记录日志路径。
	}
}

/**
 * 运行一个子进程并采集输出。
 * @returns {Promise<{ok:boolean,status:number|null,signal:string|null,stdout:string,stderr:string,error:string|null,durationMs:number}>}
 */
export async function runCommand({ command, args = [], cwd = process.cwd(), env = process.env, logFile = null, timeoutMs = 180_000, label = "" }) {
	const startedAt = Date.now();
	if (logFile) {
		appendLog(logFile, `\n$ ${command} ${args.join(" ")}  (cwd=${cwd})\n`);
	}
	return new Promise((resolve) => {
		const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		const stdout = [];
		const stderr = [];
		let captured = 0;
		let settled = false;
		let timer = null;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve({ ...result, durationMs: Date.now() - startedAt });
		};
		const collect = (target) => (chunk) => {
			const text = chunk.toString();
			if (captured < MAX_CAPTURE) {
				target.push(text);
				captured += text.length;
			}
			appendLog(logFile, text);
		};
		child.stdout.on("data", collect(stdout));
		child.stderr.on("data", collect(stderr));
		child.on("error", (error) => {
			appendLog(logFile, `\n[spawn error] ${error.message}\n`);
			finish({ ok: false, status: null, signal: null, stdout: stdout.join(""), stderr: stderr.join(""), error: error.message });
		});
		child.on("close", (status, signal) => {
			const stdoutText = stdout.join("");
			const stderrText = stderr.join("");
			appendLog(logFile, `\n[exit ${status ?? signal}] ${label}\n`);
			finish({ ok: status === 0, status, signal, stdout: stdoutText, stderr: stderrText, error: null });
		});
		timer = setTimeout(() => {
			appendLog(logFile, `\n[timeout ${timeoutMs}ms] ${label}\n`);
			try {
				child.kill("SIGKILL");
			} catch {
				// 忽略：进程可能已退出。
			}
			finish({ ok: false, status: null, signal: "SIGKILL", stdout: stdout.join(""), stderr: stderr.join(""), error: `timeout-${timeoutMs}ms` });
		}, timeoutMs);
	});
}

/** 命令是否可用（`<cmd> --version` 成功）。 */
export async function commandVersion({ command, env = process.env, logFile = null }) {
	const result = await runCommand({ command, args: ["--version"], env, logFile, timeoutMs: 30_000, label: `${command} --version` });
	if (!result.ok) return { ok: false, version: null, result };
	const text = `${result.stdout}\n${result.stderr}`;
	const version = /\d+\.\d+\.\d+[0-9A-Za-z.+-]*/.exec(text)?.[0] ?? null;
	return { ok: true, version, result };
}

export function ensureDir(dir) {
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/** 写文件（父目录自动创建）。 */
export function writeTextFile(file, content) {
	ensureDir(path.dirname(file));
	fs.writeFileSync(file, content);
	return file;
}

export function readTextFile(file) {
	return fs.readFileSync(file, "utf8");
}

export function existsFile(file) {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

export function existsDir(dir) {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

/** 尽量用硬链接复制（同文件系统零拷贝），失败回退普通复制；用于大 APK/载体 tarball 的夹具。 */
export function linkOrCopyFile(source, destination) {
	ensureDir(path.dirname(destination));
	try {
		fs.linkSync(source, destination);
		return "link";
	} catch {
		fs.copyFileSync(source, destination);
		return "copy";
	}
}

/** 安全删除目录（只允许删除调用方明确给出的目录；不存在则忽略）。 */
export function removeDir(dir) {
	if (typeof dir !== "string" || dir === "" || path.parse(path.resolve(dir)).root === path.resolve(dir)) {
		throw new Error("unsafe-remove-dir");
	}
	fs.rmSync(dir, { recursive: true, force: true });
}

export function tmpRoot() {
	return os.tmpdir();
}
