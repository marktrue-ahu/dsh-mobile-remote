// 插件自更新（CONTEXT「插件自更新」「更新接续」）。
//
// 本模块负责**事务的推进**，副作用一律可注入；"重启后是否真的生效、失败怎么回滚"
// 交给独立的外部监督器（`lib/update-supervisor.js`）——因为回滚绝不能依赖新版插件
// 能否加载成功（评审 #32 note 1286 的 R1）。
//
// 关键约束（都来自那次评审）：
//   - 产物目录按**内容标识**命名且不可变，同版本不同内容不会互相覆盖（R2）；
//   - profile 目录靠**验证式查找**得到，不靠模块层级推断（R3）；
//   - 下载地址由 `resolvePluginUrl()` 解析后接入执行链（R4）；
//   - 期望内容标识以**解包后复算的值**为准（合成清单没有它也能正确收尾）（R5）；
//   - 安装/解包用**异步子进程**，不在宿主主线程上阻塞 HTTP/SSE/agent（R6）。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { pluginContentDigest } from "./plugin-content-digest.js";
import { fetchUpdateResource } from "./update-fetch.js";
import { decidePluginUpdate, normalizeReleaseManifest } from "./plugin-update.js";
import {
	TRANSACTION_PHASE,
	acquireLock,
	assertUpdateLease,
	serverOperationPath,
	switchOwnedDependency,
	validOperationId,
	writeOwnedTransaction,
	artifactDir,
	artifactRoot,
	convergeStaleTransaction,
	defaultCopyDir,
	dependencyKeyIn,
	dependencyKeysFor,
	LEGACY_DEPENDENCY_KEY,
	dirReady,
	newOperationId,
	readTransaction,
	releaseLock,
	snapshotDir,
	snapshotInstalled,
	snapshotReady,
	snapshotRoot,
	transactionFile,
	updateLockPath,
	workRoot,
	writeTransaction,
} from "./plugin-update-transaction.js";

export { TRANSACTION_PHASE };
export { transactionFile };
export { updateLockPath };
export const updateLockFile = updateLockPath;

/** 兼容旧名（状态文件即事务文件）。 */
export const updateStateFile = transactionFile;
export const readUpdateState = readTransaction;
export const writeUpdateState = writeTransaction;

/** 插件自更新的默认来源：上游仓库的 Release（清单优先，缺失则按 release 资产合成）。 */
export const UPSTREAM_REPO = "201222-L/dsh-mobile-remote";
export const UPSTREAM_MANIFEST_URL = `https://github.com/${UPSTREAM_REPO}/releases/latest/download/manifest.json`;
export const UPSTREAM_RELEASES_API = `https://api.github.com/repos/${UPSTREAM_REPO}/releases/latest`;

/** 更新来源的三种配置形态。 */
export const UPDATE_SOURCE_KIND = { UPSTREAM: "upstream", OFF: "off", CUSTOM: "custom", INVALID: "invalid" };

/** 检查结果（会随 bootstrap/diagnostics 下发，也是 PC 端提示的依据）。 */
export const UPDATE_CHECK_STATE = {
	DISABLED: "disabled",
	UNAVAILABLE: "unavailable",
	UP_TO_DATE: "up-to-date",
	UPDATE_AVAILABLE: "update-available",
	LOCAL_AHEAD: "local-ahead",
	UNKNOWN: "unknown",
};

/** 自更新过程阶段（进度上报用）。 */
export const UPDATE_STEP = {
	DOWNLOAD: "download",
	VERIFY: "verify",
	EXTRACT: "extract",
	SNAPSHOT: "snapshot",
	SWITCH: "switch",
	INSTALL: "install",
	RESTART: "restart",
};

/** 回滚最多一次：避免"重启风暴"。 */
export const MAX_ROLLBACK_ATTEMPTS = 1;

/** 异步跑一个子进程（**不阻塞宿主事件循环**）。 */
export function runCommand(cmd, args, { cwd, timeoutMs = 10 * 60 * 1000 } = {}) {
	return new Promise((resolve) => {
		let child;
		try {
			// stdout 直接丢弃（**不能**设成 pipe 又不消费：管道写满后子进程会阻塞到超时，F5）。
			// stderr 保留尾部若干字节用于报错。
			child = spawn(cmd, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
		} catch (e) {
			resolve({ ok: false, error: String(e?.message ?? e) });
			return;
		}
		const STDERR_CAP = 16 * 1024;
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGKILL");
			} catch {
				// 已经退出
			}
		}, timeoutMs);
		child.stderr?.on("data", (d) => {
			stderr += d.toString();
			if (stderr.length > STDERR_CAP) stderr = stderr.slice(-STDERR_CAP);
		});
		child.on("error", (e) => {
			clearTimeout(timer);
			resolve({ ok: false, error: String(e?.message ?? e) });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (timedOut) {
				resolve({ ok: false, error: `timeout-after-${Math.round(timeoutMs / 1000)}s${stderr ? `: ${stderr.trim()}` : ""}` });
				return;
			}
			resolve(code === 0 ? { ok: true } : { ok: false, error: (stderr || `exit ${code}`).trim() });
		});
	});
}

// ── 更新来源 ──────────────────────────────────────────────────────────────

/** 解析配置里的更新来源。默认 `upstream`；`off` 表示完全不检查；其余必须是 https 地址。 */
export function resolveManifestSource(configValue) {
	const v = typeof configValue === "string" ? configValue.trim() : "";
	if (v === "" || v === "off") return { kind: UPDATE_SOURCE_KIND.OFF };
	if (v === "upstream") return { kind: UPDATE_SOURCE_KIND.UPSTREAM, url: UPSTREAM_MANIFEST_URL, api: UPSTREAM_RELEASES_API };
	// 自建主机源就在同一台机器上：受保护端点走回环 http（凭据只发给这个 origin）。
	// 外部地址仍只允许 https，不放宽。
	if (/^https:\/\/\S+$/.test(v)) return { kind: UPDATE_SOURCE_KIND.CUSTOM, url: v };
	try {
		const u = new URL(v);
		if (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.pathname.startsWith("/")) {
			return { kind: UPDATE_SOURCE_KIND.CUSTOM, url: v, loopback: true };
		}
	} catch {
		// 交给下面判非法
	}
	return { kind: UPDATE_SOURCE_KIND.INVALID, value: v };
}

async function fetchJson(url, fetchImpl, userAgent, auth = {}) {
	try {
		const { response: res, finalUrl } = await fetchUpdateResource(url, { fetchImpl, ...auth,
			headers: { "user-agent": userAgent, accept: "application/json" }, signal: AbortSignal.timeout(10_000),
		});
		if (!res?.ok) return { ok: false, error: `manifest-http-${res?.status ?? "?"}` };
		return { ok: true, json: await res.json(), finalUrl };
	} catch (e) {
		return { ok: false, error: `manifest-fetch-failed: ${e?.message ?? e}` };
	}
}

/**
 * 从 GitHub Release 资产**合成**一份清单。上游尚未把 manifest.json 作为发布资产时，
 * 走这条路仍能拿到版本号与字节哈希（asset 自带的 digest），只是**没有内容标识**——
 * 执行时以解包后复算的内容标识为准（R5），判定阶段则如实标注 synthesized。
 */
export async function synthesizeFromGithubRelease(apiUrl, { fetchImpl = fetch, userAgent = "dsh-mobile-remote" } = {}) {
	const r = await fetchJson(apiUrl, fetchImpl, userAgent);
	if (!r.ok) return { ok: false, error: r.error };
	const release = r.json ?? {};
	const version = String(release.tag_name ?? "").replace(/^v/, "");
	const asset = (Array.isArray(release.assets) ? release.assets : []).find((a) => typeof a?.name === "string" && a.name.endsWith(".tgz"));
	if (!version || !asset) return { ok: false, error: "release-asset-missing" };
	const digest = String(asset.digest ?? "");
	const manifest = normalizeReleaseManifest({
		schema: 1,
		plugin: {
			version,
			file: asset.name,
			url: asset.browser_download_url ?? "",
			size: Number.isFinite(asset.size) ? asset.size : undefined,
			sha256: digest.startsWith("sha256:") ? digest.slice("sha256:".length) : "",
		},
	});
	if (!manifest.ok) return { ok: false, error: manifest.error };
	return { ok: true, manifest, synthesized: true };
}

/** 主机源返回的是 `{ ok, manifest }` 信封；解包后再规范化（G1）。 */
export function unwrapManifestEnvelope(raw) {
	if (raw && typeof raw === "object" && !Array.isArray(raw) && raw.manifest && typeof raw.manifest === "object" && !("schema" in raw)) {
		return raw.manifest;
	}
	return raw;
}

/** 取回并规范化发布清单。upstream 优先取清单资产；取不到再按 release 资产合成。 */
export async function fetchReleaseManifest({ source, fetchImpl = fetch, userAgent = "dsh-mobile-remote", auth = {} } = {}) {
	if (!source || source.kind === UPDATE_SOURCE_KIND.OFF) return { ok: false, error: "update-source-off" };
	if (source.kind === UPDATE_SOURCE_KIND.INVALID) return { ok: false, error: "update-source-invalid" };
	if (source.kind === UPDATE_SOURCE_KIND.UPSTREAM) {
		const direct = await fetchJson(source.url, fetchImpl, userAgent, auth);
		if (direct.ok) {
			const manifest = normalizeReleaseManifest(unwrapManifestEnvelope(direct.json));
			if (manifest.ok) return { ok: true, manifest, synthesized: false, manifestUrl: direct.finalUrl };
		}
		const synthesized = await synthesizeFromGithubRelease(source.api, { fetchImpl, userAgent });
		return synthesized.ok ? { ...synthesized, manifestUrl: source.api } : synthesized;
	}
	const custom = await fetchJson(source.url, fetchImpl, userAgent, auth);
	if (!custom.ok) return { ok: false, error: custom.error };
	const manifest = normalizeReleaseManifest(unwrapManifestEnvelope(custom.json));
	if (!manifest.ok) return { ok: false, error: manifest.error };
	return { ok: true, manifest, synthesized: false, manifestUrl: custom.finalUrl };
}

/**
 * 解析插件包的下载地址（G1）：
 *   - 清单给了**绝对** url → 直接用；
 *   - 清单给了**相对** url → 相对**清单自身地址**解析（主机源就是这种：`/m/api/update/plugin`）；
 *   - 只给了文件名 → 同样相对清单地址解析。
 */
export function resolvePluginUrl(manifestUrl, plugin) {
	const raw = typeof plugin?.url === "string" ? plugin.url.trim() : "";
	const target = raw !== "" ? raw : (plugin?.file ?? "");
	if (target === "") return "";
	try {
		// 绝对地址直接返回（校验交给下载器的协议白名单）
		if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return target;
		if (!manifestUrl) return "";
		return new URL(target, manifestUrl).toString();
	} catch {
		return "";
	}
}

/** 只允许 https（或本机回环 http，供自建主机源使用）。 */
export function isAllowedDownloadUrl(url) {
	try {
		const u = new URL(url);
		if (u.protocol === "https:") return true;
		if (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost")) return true;
		return false;
	} catch {
		return false;
	}
}

/**
 * 该形态下如何更新；不能自更新时给出**与实际安装方式对应的那一条**降级指引（R11）。
 * `canSelfUpdate` 由调用方按宿主运行形态判定后传入。
 */
export function planForShape(shape, { specifier = "", dirPath = "", canSelfUpdate = true, reason = "" } = {}) {
	const installCmd = "pnpm install";
	const base = (() => {
		switch (shape) {
		case "registry":
			return {
				summary: "从 npm 源升级：改写 profile 依赖版本后重新安装",
				steps: [`把 profile 的依赖版本改为新版（当前 ${specifier || "未知"}）`, "重新安装依赖", "重启 DSH 让插件生效"],
				commands: [installCmd],
			};
		case "github-tag":
			return {
				summary: "git 依赖升级：把 tag 改到新版本后重新安装",
				steps: [`把 profile 依赖的 tag 改为 v<新版>（当前 ${specifier || "未知"}）`, "重新安装依赖", "重启 DSH 让插件生效"],
				commands: [installCmd],
			};
		case "file-clone":
			return {
				summary: "本地 clone 升级：拉取新代码后重新安装",
				steps: [`在 clone 目录拉取新版本${dirPath ? `（${dirPath}）` : ""}`, "重新安装依赖", "重启 DSH 让插件生效"],
				commands: [dirPath ? `git -C ${dirPath} pull` : "git pull", installCmd],
			};
		case "file-dir":
			return {
				summary: "本地目录升级：用新版内容替换该目录后重新安装",
				steps: [`用新版插件内容替换该目录${dirPath ? `（${dirPath}）` : ""}`, "重新安装依赖", "重启 DSH 让插件生效"],
				commands: [installCmd],
			};
		case "tgz-file":
			return {
				summary: "tgz 安装升级：换上新版 tgz 后重新安装",
				steps: [`下载新版 tgz 并替换${dirPath ? `（${dirPath}）` : "原包"}`, "重新安装依赖", "重启 DSH 让插件生效"],
				commands: [installCmd],
			};
		default:
			return {
				summary: "无法识别本机插件安装方式，按 docs/06-install-run.md 的三种方式之一处理",
				steps: ["确认插件是通过 clone、git tag 还是 tgz 安装的", "按对应方式更新到新版", "重启 DSH 让插件生效"],
				commands: [],
			};
		}
	})();
	return { ...base, shape, mode: canSelfUpdate ? "auto" : "guidance", reason };
}

/** 检查是否有新版（**不下载、不改动任何东西**）。 */
export async function checkForUpdate({
	configValue = "upstream",
	localVersion = "",
	localContentSha256 = "",
	fetchImpl = fetch,
	userAgent = "dsh-mobile-remote",
	capabilities = null,
	auth = {},
} = {}) {
	const withCaps = (r) => (capabilities ? { ...r, ...capabilities } : r);
	const source = resolveManifestSource(configValue);
	if (source.kind === UPDATE_SOURCE_KIND.OFF) {
		return withCaps({ state: UPDATE_CHECK_STATE.DISABLED, reason: "update-source-off", checkedAt: new Date().toISOString() });
	}
	if (source.kind === UPDATE_SOURCE_KIND.INVALID) {
		return withCaps({
			state: UPDATE_CHECK_STATE.UNAVAILABLE,
			reason: "update-source-invalid",
			source: String(source.value ?? ""),
			checkedAt: new Date().toISOString(),
		});
	}
	const fetched = await fetchReleaseManifest({ source, fetchImpl, userAgent, auth });
	if (!fetched.ok) {
		return withCaps({ state: UPDATE_CHECK_STATE.UNAVAILABLE, reason: fetched.error, source: source.kind, checkedAt: new Date().toISOString() });
	}
	const decision = decidePluginUpdate({ localVersion, localContentSha256, remote: fetched.manifest.plugin });
	return withCaps({
		state: decision.action,
		reason: decision.reason,
		source: source.kind,
		synthesized: Boolean(fetched.synthesized),
		manifestUrl: fetched.manifestUrl ?? "",
		release: fixedReleaseSnapshot(fetched.manifest, fetched.manifestUrl),
		remote: {
			version: fetched.manifest.plugin.version,
			contentSha256: fetched.manifest.plugin.contentSha256 || "",
			sha256: fetched.manifest.plugin.sha256 || "",
			size: fetched.manifest.plugin.size ?? null,
			url: resolvePluginUrl(fetched.manifestUrl ?? "", fetched.manifest.plugin),
		},
		checkedAt: new Date().toISOString(),
	});
}

export function fixedReleaseSnapshot(manifest, manifestUrl = "") {
  const app = manifest.app ? { ...manifest.app, url: resolvePluginUrl(manifestUrl, manifest.app) } : null;
  return { schema: 1, manifestUrl, app, plugin: { ...manifest.plugin, url: resolvePluginUrl(manifestUrl, manifest.plugin) } };
}

// ── 下载 / 解包 ───────────────────────────────────────────────────────────

/**
 * 下载到文件并校验。**先落盘到临时名再改名**，避免半成品被当成成品。
 * `size`/`sha256` 任一不符即删除文件并失败——不做"先装上再说"。
 */
export async function downloadVerified({ url, destPath, sha256, size = null, fetchImpl = fetch, onProgress, auth = {} } = {}) {
	if (!url) return { ok: false, error: "download-url-missing" };
	if (!isAllowedDownloadUrl(url)) return { ok: false, error: "download-url-not-allowed" };
	let response;
	try {
		({ response } = await fetchUpdateResource(url, { fetchImpl, ...auth, signal: AbortSignal.timeout(120_000) }));
	} catch (e) {
		return { ok: false, error: `download-failed: ${e?.message ?? e}` };
	}
	if (!response?.ok) return { ok: false, error: `download-http-${response?.status ?? "?"}` };

	mkdirSync(dirname(destPath), { recursive: true });
	const tmpPath = `${destPath}.part`;
	try {
		const chunks = [];
		let bytes = 0;
		for await (const chunk of response.body ?? []) {
			chunks.push(Buffer.from(chunk));
			bytes += chunk.length;
			onProgress?.(bytes, size ?? response.headers?.get?.("content-length") ?? null);
		}
		const buf = Buffer.concat(chunks);
		bytes = buf.length;
		if (size !== null && bytes !== size) {
			return { ok: false, error: `download-size-mismatch: ${bytes} != ${size}` };
		}
		const digest = createHash("sha256").update(buf).digest("hex");
		if (sha256 && digest !== String(sha256).toLowerCase()) {
			return { ok: false, error: `download-sha256-mismatch: ${digest}` };
		}
		writeFileSync(tmpPath, buf);
		renameSync(tmpPath, destPath);
		return { ok: true, bytes, sha256: digest };
	} catch (e) {
		try {
			rmSync(tmpPath, { force: true });
		} catch {
			// 清理失败不掩盖原始错误
		}
		return { ok: false, error: `download-failed: ${e?.message ?? e}` };
	}
}

/** 默认解包器：系统 tar（异步，不阻塞宿主）。 */
export function defaultRunTar(tgzPath, destDir) {
	return runCommand("tar", ["-xzf", tgzPath, "-C", destDir]);
}

/** 默认安装器：包管理器（异步、带超时）。 */
export function defaultRunInstall(profileDir) {
	return runCommand("pnpm", ["install"], { cwd: profileDir });
}

/**
 * 解包并复核**内容标识**：把「发布侧声明的内容」与「真正落到磁盘上的内容」钉在一起。
 * 返回值里的 `digest` 就是**复算出的真实内容标识**——事务以它作为期望值（R5）。
 */
export async function extractVerified({ tgzPath, workDir, contentSha256, runTar = defaultRunTar } = {}) {
	rmSync(workDir, { recursive: true, force: true });
	mkdirSync(workDir, { recursive: true });
	const r = await runTar(tgzPath, workDir);
	if (!r?.ok) return { ok: false, error: `extract-failed: ${r?.error ?? "unknown"}` };
	const packageDir = join(workDir, "package");
	if (!existsSync(packageDir)) return { ok: false, error: "extract-missing-package-dir" };
	const digest = pluginContentDigest(packageDir);
	const expected = String(contentSha256 ?? "").toLowerCase();
	if (expected && digest !== expected) {
		return { ok: false, error: `content-sha256-mismatch: ${digest}`, digest, packageDir };
	}
	return { ok: true, digest, packageDir };
}

/** 把解包好的版本目录记进 profile 的依赖声明（持久生效的关键，见 ADR 0019）。 */
export function switchDependencySpecifier({ profileDir, nextSpecifier, keys = [LEGACY_DEPENDENCY_KEY], readJson = readJsonFile, writeJson = writeJsonFile } = {}) {
	const file = join(profileDir, "package.json");
	let doc;
	try {
		doc = readJson(file);
	} catch (e) {
		return { ok: false, error: `profile-package-unreadable: ${e?.message ?? e}` };
	}
	const deps = doc?.dependencies;
	if (!deps || typeof deps !== "object") return { ok: false, error: "profile-has-no-dependencies" };
	// 键可能是旧包名，也可能是带 scope 的新包名：改**实际存在的那个**，不新增第二个依赖。
	const key = dependencyKeyIn(doc, keys) || (keys.includes(LEGACY_DEPENDENCY_KEY) ? LEGACY_DEPENDENCY_KEY : keys[0]);
	const previous = typeof deps[key] === "string" ? deps[key] : "";
	if (previous === "") return { ok: false, error: "profile-dependency-missing" };
	deps[key] = nextSpecifier;
	try {
		writeJson(file, doc);
	} catch (e) {
		return { ok: false, error: `profile-package-unwritable: ${e?.message ?? e}` };
	}
	return { ok: true, previous, next: nextSpecifier, file, key };
}

function readJsonFile(file) {
	return JSON.parse(readFileSync(file, "utf8"));
}

function writeJsonFile(file, doc) {
	writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

// ── 重启 ──────────────────────────────────────────────────────────────────

export function restartPlan({ form, pid = null, profile = "web", dshCommand = "dsh" } = {}) {
	switch (form) {
	case "web-systemd":
		return {
			mode: "supervised",
			steps: ["终止当前宿主进程", "由 systemd 的 Restart=always 用原参数拉起"],
			commands: pid ? [`kill -TERM ${pid}`] : ["systemctl --user restart dsh-web.service"],
		};
	case "web-foreground":
		return {
			mode: "respawn",
			steps: ["终止当前宿主进程", "由分离脚本重新拉起 dsh web"],
			commands: pid ? [`kill -TERM ${pid}`, `${dshCommand} web --profile ${profile}`] : [`${dshCommand} web --profile ${profile}`],
		};
	default:
		return {
			mode: "unsupported",
			steps: ["当前形态不支持自动重启（DSH Desktop / macOS 需要人工重启）"],
			commands: [],
		};
	}
}

/**
 * 识别本机可自动重启的形态。
 * **默认读真实 `process.env`**——生产调用漏传 env 会让前台 web 永远探测不到（评审 R12）。
 */
export function detectRestartForm({ env = process.env, platform = process.platform, hasSystemdUnit = () => false } = {}) {
	if (platform === "win32" || platform === "darwin") return "unsupported";
	if (hasSystemdUnit()) return "web-systemd";
	if (env?.DSH_PROFILE || env?.DSH_WEB_FOREGROUND === "1") return "web-foreground";
	return "unsupported";
}

export function buildRestartScript({ plan, pid = null, delayMs = 3000 } = {}) {
	const seconds = Math.max(0, Math.round(delayMs / 1000));
	if (plan?.mode === "supervised") {
		return pid ? `sleep ${seconds}; kill -TERM ${pid}` : "";
	}
	if (plan?.mode === "respawn") {
		const respawn = plan.commands?.[plan.commands.length - 1] ?? "";
		if (!respawn) return "";
		const kill = pid ? `kill -TERM ${pid}; sleep 2; ` : "";
		return `sleep ${seconds}; ${kill}nohup ${respawn} >/dev/null 2>&1 &`;
	}
	return "";
}

/** 执行重启：分离一个 shell 去跑脚本。 */
export function runRestart({ plan, pid = null, delayMs = 3000, spawnImpl = spawn, log = () => {} } = {}) {
	const script = buildRestartScript({ plan, pid, delayMs });
	if (script === "") return { ok: false, error: "restart-unsupported" };
	try {
		const child = spawnImpl("bash", ["-lc", script], { detached: true, stdio: "ignore" });
		child.unref?.();
		log(`mobile-remote: 已安排重启（${plan.mode}）：${script}`);
		return { ok: true, script, pid: child.pid ?? null };
	} catch (e) {
		return { ok: false, error: `restart-spawn-failed: ${e?.message ?? e}` };
	}
}

/** 监督器冻结目录：启动前把自身代码复制到这里，不依赖之后可能被 pnpm 清理的模块目录。 */
export function supervisorRoot(home, id) {
  // Only the server-generated UUID is a filesystem component, never the client request ID.
  serverOperationPath(home, id);
  return join(home, ".dsh", "mobile-remote", "supervisor", id);
}
export function freezeSupervisor({ pluginRoot, home, id, destDir = supervisorRoot(home, id), copyDir = defaultCopyDir } = {}) {
  const expected = supervisorRoot(home, id);
  if (destDir !== expected) return { ok: false, error: "supervisor-path-outside-root" };
  if (existsSync(destDir)) return { ok: false, error: "supervisor-already-frozen" };
  const src = join(pluginRoot, "lib");
  if (!existsSync(src)) return { ok: false, error: "plugin-lib-missing" };
  mkdirSync(destDir, { recursive: true });
  const result = copyDir(src, join(destDir, "lib"));
  if (!result?.ok) return { ok: false, error: "freeze-failed" };
  writeFileSync(join(destDir, "package.json"), '{"type":"module"}\n');
  const entry = join(destDir, "lib", "update-supervisor.js");
  return existsSync(entry) ? { ok: true, entry } : { ok: false, error: "freeze-missing-entry" };
}

/**
 * 启动监督器并**等它就绪回执**（F2）。
 * systemd 托管时必须经 transient unit 逃逸出宿主 cgroup，否则停宿主会把它一起杀掉；
 * 逃逸或就绪失败一律 fail-closed（调用方在**任何破坏性改动之前**据此中止）。
 */
export function spawnSupervisorArmed({
	frozenEntry,
	stateFile,
	readyFile,
	opId,
	generation,
	needsEscape = false,
	unitName = "",
	nodePath = process.execPath,
	timeoutMs = 15_000,
	spawnImpl = spawn,
	runImpl = null,
	sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
	now = () => Date.now(),
	log = () => {},
} = {}) {
	const args = [frozenEntry, "--state", stateFile, "--op", opId, "--generation", generation, "--arm", "--ready", readyFile];
	let mode = "detached";
	if (needsEscape) {
		const unit = unitName || `dsh-plugin-supervisor-${String(opId).slice(0, 8)}`;
		const run = runImpl ?? ((cmd, argv) => spawnSync(cmd, argv, { encoding: "utf8", env: { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}` } }));
		const r = run("systemd-run", ["--user", "--unit", unit, "--collect", "--quiet", "--", nodePath, ...args]);
		if (r?.error) return { ok: false, error: `escape-failed: ${r.error.message ?? r.error}` };
		if (typeof r?.status === "number" && r.status !== 0) {
			return { ok: false, error: `escape-failed: exit ${r.status} ${String(r.stderr ?? "").trim()}` };
		}
		mode = "systemd-run";
	} else {
		try {
			const child = spawnImpl(nodePath, args, { detached: true, stdio: "ignore" });
			child.unref?.();
		} catch (e) {
			return { ok: false, error: `supervisor-spawn-failed: ${e?.message ?? e}` };
		}
	}
	return { ok: true, mode, readyFile, args };
}

/** 等监督器写出就绪回执；超时即失败（调用方 fail-closed）。 */
export async function waitForSupervisorReady({
	readyFile,
	opId,
	generation,
	timeoutMs = 15_000,
	pollMs = 200,
	readFile = (f) => readFileSync(f, "utf8"),
	sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
	now = () => Date.now(),
} = {}) {
	const deadline = now() + timeoutMs;
	while (now() < deadline) {
		try {
			const doc = JSON.parse(readFile(readyFile));
			if (doc && Number.isFinite(doc.pid) && (!opId || doc.opId === opId) && (!generation || doc.generation === generation)) return { ok: true, ready: doc };
		} catch {
			// 还没写好
		}
		await sleep(pollMs);
	}
	return { ok: false, error: "supervisor-not-ready" };
}

// ── 事务推进 ──────────────────────────────────────────────────────────────

/**
 * 推进一次自更新事务。
 *
 * 顺序即安全性：**先下载校验 → 再解包复核内容标识 → 快照当前内容 → 最后才动 profile**。
 * 任何一步失败都可以直接放弃，此时还没有发生需要重启的变更。
 *
 * 返回 `{ok, step, error?, transaction}`；成功后事务处于 `restart-pending`，
 * 由调用方启动外部监督器接管（重启 + 健康确认 + 失败回滚）。
 */
export async function runSelfUpdate({
  home, plugin, release = null, manifestUrl = "", profileDir, restartForm = "unsupported", hostPid = process.pid,
  port = 3080, basePath = "/m", token = "", profile = "web", dshCommand = "dsh", installedRoot = "", pluginRoot = "",
  needsEscape = false, supervisorTimeoutMs = 15_000, freezeImpl = freezeSupervisor, spawnArmedImpl = spawnSupervisorArmed,
  awaitReadyImpl = waitForSupervisorReady, opId = newOperationId(), fetchImpl = fetch, auth = {}, runTar = defaultRunTar,
  runInstall = defaultRunInstall, onStep = () => {}, log = () => {}, now = () => Date.now(),
  lease: admittedLease, initialTransaction, stateFile: operationStateFile, currentFile = transactionFile(home),
  lockPath = updateLockPath(home),
} = {}) {
  if (!validOperationId(opId)) return { ok: false, step: "input", error: "invalid-operation-id" };
  if (!profileDir) return { ok: false, step: "profile", error: "profile-not-found" };
  const grant = acquireLock(lockPath, { opId, lease: admittedLease, stateFile: currentFile });
  if (!grant.ok) return { ok: false, step: "lock", error: grant.error, holder: grant.holder };
  const lease = grant.lease, id = lease.generation;
  const stateFile = operationStateFile || serverOperationPath(home, id);
  let tx = initialTransaction ?? { opId, lease, id, phase: "staging", startedAt: new Date(now()).toISOString(),
    profileDir, installedRoot, manifestUrl, release, restartForm, hostPid, port, basePath, token, profile, dshCommand,
    lockPath, currentFile, targetVersion: plugin?.version ?? "", targetContentSha256: plugin?.contentSha256 ?? "", attempts: 0 };
  let destructive = false, step = "supervisor";
  const save = (patch, expectedPhases) => { tx = writeOwnedTransaction(stateFile, { ...tx, ...patch }, { lockPath, lease, currentFile, expectedPhases }); return tx; };
  const fail = error => {
    // 一旦可能动过 profile/安装字节，只有已 armed 的监督器能结束这个事务（C5）。
    if (destructive) {
      save({ phase: "rolling-back", rolledBack: true, result: { ok: false, reason: error }, recoveryCause: error }, ["installing"]);
      return { ok: false, step, error, transaction: tx };
    }
    save({ phase: "failed", result: { ok: false, reason: error } }, ["staging"]);
    releaseLock(lockPath, lease, { stateFile });
    return { ok: false, step, error, transaction: tx };
  };
  try {
    save({ release: release || tx.release, lockPath, currentFile }, ["staging"]);
    const frozenDir = supervisorRoot(home, id);
    const frozen = freezeImpl({ pluginRoot, home, id, destDir: frozenDir });
    if (!frozen.ok) return fail(frozen.error);
    const readyFile = join(frozenDir, "ready.json");
    const armed = spawnArmedImpl({ frozenEntry: frozen.entry, stateFile, readyFile, opId, generation: lease.generation,
      needsEscape, unitName: `dsh-plugin-supervisor-${id}`, log });
    if (!armed.ok) return fail(armed.error);
    const ready = await awaitReadyImpl({ readyFile, opId, generation: lease.generation, timeoutMs: supervisorTimeoutMs });
    if (!ready.ok) return fail(ready.error);
    assertUpdateLease(lockPath, lease);

    const work = join(workRoot(home), id); mkdirSync(work, { recursive: true });
    const tgzPath = join(work, "plugin.tgz"); step = UPDATE_STEP.DOWNLOAD; onStep(step);
    const downloaded = await downloadVerified({ url: resolvePluginUrl(manifestUrl, plugin), destPath: tgzPath,
      sha256: plugin.sha256, size: plugin.size ?? null, fetchImpl, auth });
    assertUpdateLease(lockPath, lease);
    if (!downloaded.ok) return fail(downloaded.error);
    onStep(UPDATE_STEP.VERIFY); step = UPDATE_STEP.EXTRACT; onStep(step);
    const staged = await extractVerified({ tgzPath, workDir: join(work, "extract"), contentSha256: plugin.contentSha256, runTar });
    assertUpdateLease(lockPath, lease);
    if (!staged.ok) return fail(staged.error);
    const destDir = artifactDir(artifactRoot(home), staged.digest);
    if (existsSync(destDir)) {
      if (pluginContentDigest(destDir) !== staged.digest) return fail("artifact-integrity-mismatch");
    } else { mkdirSync(dirname(destDir), { recursive: true }); renameSync(staged.packageDir, destDir); }

    step = UPDATE_STEP.SNAPSHOT; onStep(step);
    if (!installedRoot || !existsSync(installedRoot)) return fail("installed-root-missing");
    const previousContent = pluginContentDigest(installedRoot);
    const previousSnapshot = snapshotDir(snapshotRoot(home), previousContent);
    if (!snapshotReady(previousSnapshot)) {
      if (existsSync(previousSnapshot)) return fail("snapshot-incomplete-or-corrupt");
      const snap = snapshotInstalled({ installedRoot, destDir: previousSnapshot });
      if (!snap.ok) return fail(snap.error);
    }
    if (pluginContentDigest(previousSnapshot) !== previousContent) return fail("snapshot-content-mismatch");
    const packageFile = readFileSync(join(profileDir, "package.json"), "utf8");
    const pnpmLock = existsSync(join(profileDir, "pnpm-lock.yaml")) ? readFileSync(join(profileDir, "pnpm-lock.yaml"), "utf8") : null;
    // 依赖键自描述（npm 正式渠道下包名带 scope，键随之改变）
    const dependencyKeys = dependencyKeysFor(pluginRoot);
    const dependencyKey = dependencyKeyIn(JSON.parse(packageFile), dependencyKeys) || LEGACY_DEPENDENCY_KEY;
    const oldSpecifier = JSON.parse(packageFile).dependencies?.[dependencyKey];
    // Durable recovery metadata precedes the first destructive write, so crashes also recover.
    save({ phase: "installing", artifactDir: destDir, targetContentSha256: staged.digest, previousContentSha256: previousContent,
      previousSnapshotDir: previousSnapshot, previousSpecifier: oldSpecifier, dependencyKey,
      profileSnapshot: { packageJson: packageFile, pnpmLock, dependencyKey },
      release: tx.release ? { ...tx.release, plugin: { ...tx.release.plugin, contentSha256: staged.digest } } : null }, ["staging"]);
    destructive = true; step = UPDATE_STEP.SWITCH; onStep(step);
    const switched = switchOwnedDependency({ profileDir, nextSpecifier: `file:${destDir}`, key: dependencyKey, lockPath, lease });
    if (!switched.ok) return fail(switched.error);
    step = UPDATE_STEP.INSTALL; onStep(step); assertUpdateLease(lockPath, lease);
    const installed = await runInstall(profileDir);
    assertUpdateLease(lockPath, lease);
    if (!installed?.ok) return fail(installed?.error ?? "install-failed");
    step = UPDATE_STEP.RESTART; onStep(step);
    save({ phase: "restart-pending", installedAt: new Date(now()).toISOString(), result: null }, ["installing"]);
    log(`mobile-remote: 已落位，监督器将确认内容 ${staged.digest.slice(0,12)}`);
    return { ok: true, step, transaction: tx };
  } catch(e) {
    if (e.message === "lease-lost") return { ok: false, step, error: "lease-lost" };
    try { return fail(e.message); } catch { return { ok: false, step, error: e.message }; }
  }
}

/**
 * 插件侧对事务的**只读报告/收敛**（F6）：不再由新版插件自己回滚（那是监督器的职责），
 * 但**任何非终态**（staging / installing / restart-pending）在持有者已死且超时后
 * 都必须收敛为 FAILED，否则后续更新会永久 busy。
 */
export function reportPendingUpdate({ stateFile, lockPath = "", localContentSha256 = "", supervisorAlive = false, timeoutMs = 10 * 60 * 1000, now = () => Date.now() } = {}) {
	const tx = readTransaction(stateFile);
	if (!tx) return { action: "none", reason: "no-transaction", transaction: null };
	if (isTerminalPhase(tx.phase)) return { action: "none", reason: `phase-${tx.phase}`, transaction: tx };
	if (tx.phase === TRANSACTION_PHASE.RESTART_PENDING) {
		const target = String(tx.targetContentSha256 ?? "").toLowerCase();
		if (target !== "" && String(localContentSha256 ?? "").toLowerCase() === target) {
			return { action: "matched", reason: "loaded-target-content", transaction: tx };
		}
	}
	if (!lockPath) return { action: "waiting", reason: "no-lock-path", transaction: tx };
	const converged = convergeStaleTransaction({ stateFile, lockPath, now, staleMs: timeoutMs });
	if (converged.action === "converged") {
		return { action: "expired", reason: "holder-gone", transaction: converged.transaction };
	}
	if (converged.action === "active") {
		return { action: "waiting", reason: supervisorAlive ? "supervisor-running" : "update-in-progress", transaction: tx };
	}
	return { action: "waiting", reason: `phase-${tx.phase}`, transaction: tx };
}

/** 事务是否已到终态（供 App 判断"结果待确认"）。 */
export function isTerminalPhase(phase) {
	return phase === TRANSACTION_PHASE.SETTLED || phase === TRANSACTION_PHASE.ROLLED_BACK || phase === TRANSACTION_PHASE.FAILED;
}

/** 回滚中间态：既不是"成功"也不是"终态"（App 不得据此推进，F7）。 */
export function isRollingBack(phase) {
	return phase === TRANSACTION_PHASE.ROLLING_BACK;
}

/** 快照/产物目录是否可用（诊断用）。 */
export { dirReady };
