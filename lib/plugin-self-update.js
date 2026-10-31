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
import { createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { appCarrierAlias, discoverAppCarrier } from "./app-carrier.js";
import { pluginContentDigest } from "./plugin-content-digest.js";
import { fetchUpdateResource } from "./update-fetch.js";
import { decidePluginUpdate, normalizeReleaseManifest } from "./plugin-update.js";
import { NPM_CHECK_LOG_LIMIT, createNpmPackageView, resolveNpmUpdateCandidate } from "./npm-update-source.js";
import { quoteShellArgument, shellOptions } from "./tool-process.js";
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
export const UPDATE_SOURCE_KIND = { NPM: "npm", UPSTREAM: "upstream", OFF: "off", CUSTOM: "custom", INVALID: "invalid" };

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

/** 异步跑一个子进程；两个输出管道始终并行 drain，避免高输出安装被管道背压卡住。 */
export function runCommand(cmd, args, { cwd, timeoutMs = 10 * 60 * 1000, maxOutputBytes = 16 * 1024, onOutput, platform = process.platform } = {}) {
	return new Promise((resolve) => {
		let child;
		try {
			// Windows 上 npm/pnpm 是 .cmd，必须经 shell 才能解析（见 tool-process.js）。
			child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], ...shellOptions(platform) });
		} catch (e) {
			resolve({ ok: false, error: String(e?.message ?? e), exitCode: null, stdout: "", stderr: "" });
			return;
		}
		const cap = Number.isSafeInteger(maxOutputBytes) && maxOutputBytes > 0 ? maxOutputBytes : 16 * 1024;
		let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), timedOut = false, callbackFailed = false, settled = false;
		const appendTail = (prior, chunk) => {
			const next = Buffer.concat([prior, Buffer.from(chunk)]);
			return next.length > cap ? next.subarray(next.length - cap) : next;
		};
		const onChunk = (stream, buffer) => {
			if (stream === "stdout") stdout = appendTail(stdout, buffer);
			else stderr = appendTail(stderr, buffer);
			if (typeof onOutput === "function") {
				try { onOutput(stream, Buffer.from(buffer).toString("utf8")); }
				catch { callbackFailed = true; }
			}
		};
		let timer;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ ...result, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
		};
		timer = setTimeout(() => {
			timedOut = true;
			try { child.kill("SIGKILL"); } catch { /* already exited */ }
		}, timeoutMs);
		child.stdout?.on("data", chunk => onChunk("stdout", chunk));
		child.stderr?.on("data", chunk => onChunk("stderr", chunk));
		child.on("error", (e) => finish({ ok: false, error: String(e?.message ?? e), exitCode: null }));
		child.on("close", (code) => {
			if (timedOut) {
				finish({ ok: false, error: `timeout-after-${Math.round(timeoutMs / 1000)}s`, exitCode: code });
				return;
			}
			if (callbackFailed) {
				finish({ ok: false, error: "output-capture-failed", exitCode: code });
				return;
			}
			finish(code === 0
				? { ok: true, exitCode: 0 }
				: { ok: false, error: `exit-${code ?? "unknown"}`, exitCode: code });
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

/** Resolve the fork's fixed NPM source; legacy source values migrate to NPM, only off disables. */
export function resolvePluginUpdateSource(configValue) {
	const value = typeof configValue === "string" ? configValue.trim() : "";
	if (value === "off") return { kind: UPDATE_SOURCE_KIND.OFF };
	if (value === "" || value === "npm" || value === "upstream" || /^https:\/\/\S+$/.test(value)) {
		return { kind: UPDATE_SOURCE_KIND.NPM, migrated: value !== "" && value !== "npm" };
	}
	try {
		const url = new URL(value);
		if (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost") && url.pathname.startsWith("/")) {
			return { kind: UPDATE_SOURCE_KIND.NPM, migrated: true };
		}
	} catch {
		// invalid values are rejected below
	}
	return { kind: UPDATE_SOURCE_KIND.INVALID, value };
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
	configValue = "npm",
	packageName = "",
	npmPackageView = null,
	npmCwd,
	localVersion = "",
	localContentSha256 = "",
	fetchImpl = fetch,
	userAgent = "dsh-mobile-remote",
	capabilities = null,
	auth = {},
} = {}) {
	const withCaps = (r) => (capabilities ? { ...r, ...capabilities } : r);
	// 检查日志（脱敏、限行长）：和手机端日志一样可展开/复制，避免“只给一个错误码”的黑盒。
	const checkLog = [];
	const finish = (result) => withCaps({
		...result,
		source: "npm",
		checkedAt: new Date().toISOString(),
		checkLog: checkLog.slice(-NPM_CHECK_LOG_LIMIT),
	});
	const source = resolvePluginUpdateSource(configValue);
	if (source.kind === UPDATE_SOURCE_KIND.OFF) {
		return finish({ state: UPDATE_CHECK_STATE.DISABLED, reason: "update-source-off" });
	}
	if (source.kind === UPDATE_SOURCE_KIND.INVALID) {
		checkLog.push("更新来源配置无效（应固定为宿主 npm registry）");
		return finish({ state: UPDATE_CHECK_STATE.UNAVAILABLE, reason: "update-source-invalid" });
	}
	const view = npmPackageView ?? createNpmPackageView({ packageName, cwd: npmCwd });
	const resolved = await resolveNpmUpdateCandidate({ packageName, localVersion, packageView: view, log: checkLog });
	if (!resolved.ok) {
		checkLog.push(`检查失败：${resolved.reason}`);
		return finish({ state: UPDATE_CHECK_STATE.UNAVAILABLE, reason: resolved.reason });
	}
	const remote = { version: resolved.plugin.version, contentSha256: resolved.plugin.contentSha256 || "" };
	const decision = decidePluginUpdate({ localVersion, localContentSha256, remote });
	// NPM versions are immutable. Never turn a same-version content mutation into an update.
	if (decision.reason === "content-differs-same-version") {
		checkLog.push(`检查失败：${remote.version} 内容标识与已安装内容不一致（不可变版本不得覆盖）`);
		return finish({ state: UPDATE_CHECK_STATE.UNAVAILABLE, reason: "npm-version-content-mismatch" });
	}
	checkLog.push(`结论：${decision.action}（${decision.reason}）`);
	return finish({
		state: decision.action,
		reason: decision.reason,
		candidate: resolved,
		remote: {
			version: resolved.plugin.version,
			contentSha256: resolved.plugin.contentSha256 || "",
			integrity: resolved.plugin.integrity,
			carrierVersion: resolved.carrier.version,
			appVersion: resolved.carrier.appVersion,
			legacyCarrierMetadata: resolved.carrier.legacyMetadataMissing,
		},
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
export function defaultRunInstall(profileDir, { onOutput, platform = process.platform } = {}) {
	return runCommand("pnpm", ["install"], { cwd: profileDir, onOutput, platform });
}

async function fileIntegrity(file, algorithm = "sha512") {
	const digest = createHash(algorithm);
	for await (const chunk of createReadStream(file)) digest.update(chunk);
	return `${algorithm}-${digest.digest("base64")}`;
}

/** Pack an exact NPM version through the host npm config and verify its immutable SRI. */
export async function packNpmTarball({ packageName, version, expectedIntegrity, destDir, cwd, run = runCommand, platform = process.platform } = {}) {
	if (!packageName || !version || !expectedIntegrity || !destDir) return { ok: false, error: "npm-pack-input-invalid" };
	mkdirSync(destDir, { recursive: true });
	// Windows shell 下含空白的临时目录必须引用，否则会被拆成多个参数。
	const result = await run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", quoteShellArgument(destDir, platform), `${packageName}@${version}`], {
		cwd, timeoutMs: 120_000, maxOutputBytes: 256 * 1024, ...shellOptions(platform),
	});
	if (!result?.ok) return { ok: false, error: "npm-pack-failed" };
	let entries;
	try { entries = JSON.parse(result.stdout); } catch { return { ok: false, error: "npm-pack-json-invalid" }; }
	const entry = Array.isArray(entries) && entries.length === 1 ? entries[0] : null;
	if (!entry || entry.name !== packageName || entry.version !== version || entry.integrity !== expectedIntegrity) {
		return { ok: false, error: "npm-pack-metadata-mismatch" };
	}
	const filename = typeof entry.filename === "string" ? basename(entry.filename) : "";
	if (filename === "" || !filename.endsWith(".tgz")) return { ok: false, error: "npm-pack-filename-invalid" };
	const file = join(destDir, filename);
	try {
		if (!statSync(file).isFile()) return { ok: false, error: "npm-pack-tarball-missing" };
	} catch { return { ok: false, error: "npm-pack-tarball-missing" }; }
	let actualIntegrity;
	try { actualIntegrity = await fileIntegrity(file); } catch { return { ok: false, error: "npm-pack-tarball-unreadable" }; }
	if (actualIntegrity !== expectedIntegrity) return { ok: false, error: "npm-pack-integrity-mismatch" };
	return { ok: true, file, filename, integrity: actualIntegrity, size: statSync(file).size };
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

async function fileSha256(file) {
	const digest = createHash("sha256");
	for await (const chunk of createReadStream(file)) digest.update(chunk);
	return digest.digest("hex");
}

async function safeTarListing(tarball, run = runCommand) {
	const listing = await run("tar", ["-tzf", tarball], { timeoutMs: 30_000, maxOutputBytes: 256 * 1024 });
	if (!listing?.ok) return { ok: false, error: "npm-tar-list-failed" };
	const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
	if (entries.length === 0 || entries.length > 2048) return { ok: false, error: "npm-tar-list-invalid" };
	for (const entry of entries) {
		const normalized = entry.replace(/\\/g, "/");
		if (normalized.startsWith("/") || normalized.split("/").includes("..") || (normalized !== "package" && !normalized.startsWith("package/"))) {
			return { ok: false, error: "npm-tar-path-invalid" };
		}
	}
	return { ok: true };
}

/** Download and validate the exact NPM pair before touching the profile. */
export async function prepareNpmArtifacts({ npmCandidate, packageName, profileDir, workDir, runCommandImpl = runCommand, runTar = defaultRunTar } = {}) {
	const name = packageName || npmCandidate?.plugin?.name || "";
	if (!npmCandidate?.plugin?.version || !npmCandidate?.carrier?.version || !name || !profileDir || !workDir) {
		return { ok: false, error: "npm-candidate-incomplete" };
	}
	const pluginPackDir = join(workDir, "npm-plugin");
	const carrierPackDir = join(workDir, "npm-carrier");
	const plugin = await packNpmTarball({ packageName: name, version: npmCandidate.plugin.version,
		expectedIntegrity: npmCandidate.plugin.integrity, destDir: pluginPackDir, cwd: profileDir, run: runCommandImpl });
	if (!plugin.ok) return plugin;
	const carrier = await packNpmTarball({ packageName: name, version: npmCandidate.carrier.version,
		expectedIntegrity: npmCandidate.carrier.integrity, destDir: carrierPackDir, cwd: profileDir, run: runCommandImpl });
	if (!carrier.ok) return carrier;

	const pluginListing = await safeTarListing(plugin.file, runCommandImpl);
	if (!pluginListing.ok) return pluginListing;
	const carrierListing = await safeTarListing(carrier.file, runCommandImpl);
	if (!carrierListing.ok) return carrierListing;
	const pluginExtract = await extractVerified({ tgzPath: plugin.file, workDir: join(workDir, "plugin-extract"),
		contentSha256: npmCandidate.plugin.contentSha256 || "", runTar });
	if (!pluginExtract.ok) return { ok: false, error: `npm-plugin-${pluginExtract.error}` };
	const carrierExtractDir = join(workDir, "carrier-extract");
	rmSync(carrierExtractDir, { recursive: true, force: true });
	mkdirSync(carrierExtractDir, { recursive: true });
	const carrierUnpack = await runTar(carrier.file, carrierExtractDir);
	if (!carrierUnpack?.ok) return { ok: false, error: "npm-carrier-extract-failed" };
	const carrierPackageDir = join(carrierExtractDir, "package");
	let manifest;
	try { manifest = JSON.parse(readFileSync(join(carrierPackageDir, "manifest.json"), "utf8")); }
	catch { return { ok: false, error: "npm-carrier-manifest-unreadable" }; }
	if (manifest?.schema !== 1 || manifest?.plugin?.version !== npmCandidate.plugin.version
		|| manifest?.plugin?.file !== plugin.filename || manifest?.plugin?.size !== plugin.size) {
		return { ok: false, error: "npm-carrier-plugin-identity-mismatch" };
	}
	let tarballSha256;
	try { tarballSha256 = await fileSha256(plugin.file); } catch { return { ok: false, error: "npm-plugin-tarball-unreadable" }; }
	if (manifest.plugin.sha256 !== tarballSha256) return { ok: false, error: "npm-plugin-tarball-sha256-mismatch" };
	const pluginContentSha256 = pluginExtract.digest;
	if (manifest.plugin.contentSha256 !== pluginContentSha256) return { ok: false, error: "npm-plugin-content-sha256-mismatch" };
	if (npmCandidate.plugin.contentSha256 && npmCandidate.plugin.contentSha256 !== pluginContentSha256) {
		return { ok: false, error: "npm-packument-content-sha256-mismatch" };
	}
	if (npmCandidate.carrier.appVersion && npmCandidate.carrier.appVersion !== manifest.app?.version) {
		return { ok: false, error: "npm-packument-app-version-mismatch" };
	}
	if (npmCandidate.carrier.pluginContentSha256 && npmCandidate.carrier.pluginContentSha256 !== manifest.plugin.contentSha256) {
		return { ok: false, error: "npm-packument-content-sha256-mismatch" };
	}

	const alias = appCarrierAlias(name);
	const link = join(pluginExtract.packageDir, "node_modules", alias);
	try {
		mkdirSync(dirname(link), { recursive: true });
		symlinkSync(carrierPackageDir, link, "dir");
	} catch { return { ok: false, error: "npm-carrier-link-failed" }; }
	const inspected = discoverAppCarrier({ pluginRoot: pluginExtract.packageDir, dshHome: join(workDir, "isolated-dsh") });
	if (!inspected.ok || inspected.pluginContent?.matches !== true) {
		return { ok: false, error: inspected.reason || "npm-carrier-validation-failed" };
	}
	return {
		ok: true,
		workDir,
		pluginTgzPath: plugin.file,
		carrierTgzPath: carrier.file,
		pluginPackageDir: pluginExtract.packageDir,
		carrierPackageDir,
		pluginContentSha256,
		pluginTarballSha256: tarballSha256,
		carrierAppVersion: inspected.manifest.appVersion,
		manifest,
	};
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
  home, plugin, release = null, npmCandidate = null, packageName = "", manifestUrl = "", profileDir, restartForm = "unsupported", hostPid = process.pid,
  port = 3080, basePath = "/m", token = "", profile = "web", dshCommand = "dsh", installedRoot = "", pluginRoot = "",
  needsEscape = false, supervisorTimeoutMs = 15_000, freezeImpl = freezeSupervisor, spawnArmedImpl = spawnSupervisorArmed,
  awaitReadyImpl = waitForSupervisorReady, opId = newOperationId(), fetchImpl = fetch, auth = {}, runTar = defaultRunTar,
  runInstall = defaultRunInstall, onStep = () => {}, onOutput = () => {}, prepareNpmArtifactsImpl = prepareNpmArtifacts,
  preparedNpmArtifacts = null, log = () => {}, now = () => Date.now(),
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
    profileDir, installedRoot, manifestUrl, release, npmCandidate, restartForm, hostPid, port, basePath, token, profile, dshCommand,
    lockPath, currentFile, targetVersion: plugin?.version ?? "", targetContentSha256: plugin?.contentSha256 ?? "", attempts: 0 };
  let destructive = false, step = "supervisor", npmWorkDir = "";
  const save = (patch, expectedPhases) => { tx = writeOwnedTransaction(stateFile, { ...tx, ...patch }, { lockPath, lease, currentFile, expectedPhases }); return tx; };
  const fail = error => {
    if (npmCandidate && npmWorkDir) {
      try { rmSync(npmWorkDir, { recursive: true, force: true }); } catch { /* recovery snapshot is independent of NPM scratch */ }
    }
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
    if (npmCandidate && !preparedNpmArtifacts) npmWorkDir = work;
    let staged, npmPrepared = null;
    step = UPDATE_STEP.DOWNLOAD; onStep(step);
    if (npmCandidate) {
      if (npmCandidate.carrier?.legacyMetadataMissing && !preparedNpmArtifacts) return fail("legacy-carrier-preparation-required");
      npmPrepared = preparedNpmArtifacts ?? await prepareNpmArtifactsImpl({ npmCandidate, packageName: packageName || npmCandidate.plugin?.name,
        profileDir, workDir: work, runCommandImpl: runCommand, runTar });
      assertUpdateLease(lockPath, lease);
      if (!npmPrepared?.ok) return fail(npmPrepared?.error ?? "npm-artifact-preparation-failed");
      if (npmPrepared.manifest?.plugin?.version !== npmCandidate.plugin.version
        || npmPrepared.manifest?.plugin?.contentSha256 !== npmPrepared.pluginContentSha256
        || npmPrepared.manifest?.app?.version !== npmPrepared.carrierAppVersion) return fail("npm-prepared-candidate-mismatch");
      staged = { ok: true, digest: npmPrepared.pluginContentSha256, packageDir: npmPrepared.pluginPackageDir };
    } else {
      const tgzPath = join(work, "plugin.tgz");
      const downloaded = await downloadVerified({ url: resolvePluginUrl(manifestUrl, plugin), destPath: tgzPath,
        sha256: plugin.sha256, size: plugin.size ?? null, fetchImpl, auth });
      assertUpdateLease(lockPath, lease);
      if (!downloaded.ok) return fail(downloaded.error);
      onStep(UPDATE_STEP.VERIFY); step = UPDATE_STEP.EXTRACT; onStep(step);
      staged = await extractVerified({ tgzPath, workDir: join(work, "extract"), contentSha256: plugin.contentSha256, runTar });
      assertUpdateLease(lockPath, lease);
      if (!staged.ok) return fail(staged.error);
    }
    if (!staged?.digest || !staged.packageDir) return fail("staged-plugin-invalid");
    const destDir = artifactDir(artifactRoot(home), staged.digest);
    if (existsSync(destDir)) {
      if (pluginContentDigest(destDir) !== staged.digest) return fail("artifact-integrity-mismatch");
    } else {
      mkdirSync(dirname(destDir), { recursive: true });
      if (npmCandidate) rmSync(join(staged.packageDir, "node_modules"), { recursive: true, force: true });
      renameSync(staged.packageDir, destDir);
    }

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
    const npmPackageName = npmCandidate?.plugin?.name || packageName;
    const targetAppVersion = npmPrepared?.carrierAppVersion || npmPrepared?.manifest?.app?.version || npmCandidate?.carrier?.appVersion || null;
    const resolvedNpmCandidate = npmCandidate ? {
      ...npmCandidate,
      plugin: { ...npmCandidate.plugin, contentSha256: staged.digest },
      carrier: { ...npmCandidate.carrier, appVersion: targetAppVersion,
        pluginContentSha256: staged.digest, legacyMetadataMissing: false },
    } : null;
    // Durable recovery metadata precedes the first destructive write, so crashes also recover.
    save({ phase: "installing", artifactDir: destDir, targetContentSha256: staged.digest, targetAppVersion,
      previousContentSha256: previousContent, previousSnapshotDir: previousSnapshot, previousSpecifier: oldSpecifier, dependencyKey,
      profileSnapshot: { packageJson: packageFile, pnpmLock, dependencyKey }, npmCandidate: resolvedNpmCandidate,
      release: tx.release ? { ...tx.release, plugin: { ...tx.release.plugin, contentSha256: staged.digest } } : null }, ["staging"]);
    destructive = true; step = UPDATE_STEP.SWITCH; onStep(step);
    const exactNpmSpecifier = npmCandidate
      ? (dependencyKey === npmPackageName ? npmCandidate.plugin.version : `npm:${npmPackageName}@${npmCandidate.plugin.version}`)
      : `file:${destDir}`;
    const switched = switchOwnedDependency({ profileDir, nextSpecifier: exactNpmSpecifier, key: dependencyKey, lockPath, lease });
    if (!switched.ok) return fail(switched.error);
    step = UPDATE_STEP.INSTALL; onStep(step); assertUpdateLease(lockPath, lease);
    const installed = await runInstall(profileDir, { onOutput });
    assertUpdateLease(lockPath, lease);
    if (!installed?.ok) return fail(installed?.error ?? "install-failed");
    if (npmCandidate) {
      const targetPath = join(profileDir, "node_modules", ...dependencyKey.split("/"));
      let resolvedRoot;
      try { resolvedRoot = realpathSync(targetPath); } catch { return fail("npm-installed-plugin-missing"); }
      let installedPackage;
      try { installedPackage = JSON.parse(readFileSync(join(resolvedRoot, "package.json"), "utf8")); }
      catch { return fail("npm-installed-package-invalid"); }
      if (installedPackage.name !== npmPackageName || installedPackage.version !== npmCandidate.plugin.version) return fail("npm-installed-package-identity-mismatch");
      let installedDigest;
      try { installedDigest = pluginContentDigest(resolvedRoot); } catch { return fail("npm-installed-content-unreadable"); }
      if (installedDigest !== staged.digest) return fail("npm-installed-content-sha256-mismatch");
      const installedCarrier = discoverAppCarrier({ pluginRoot: resolvedRoot, dshHome: join(home, ".dsh") });
      if (!installedCarrier.ok || installedCarrier.pluginContent?.matches !== true) return fail(`npm-installed-carrier-invalid:${installedCarrier.reason ?? "content-mismatch"}`);
      if (installedCarrier.carrier.version !== npmCandidate.carrier.version || installedCarrier.manifest.appVersion !== targetAppVersion) {
        return fail("npm-installed-carrier-pairing-mismatch");
      }
      if (installedCarrier.manifest.pluginTgzSha256 !== npmPrepared.manifest.plugin.sha256
        || installedCarrier.manifest.contentSha256 !== staged.digest
        || installedCarrier.apk.sha256 !== npmPrepared.manifest.app?.sha256
        || installedCarrier.apk.size !== npmPrepared.manifest.app?.size) {
        return fail("npm-installed-carrier-integrity-mismatch");
      }
    }
    if (npmCandidate) {
      // The package-manager install is complete; discard its NPM tarball/extraction scratch before restart.
      try { rmSync(work, { recursive: true, force: true }); } catch { /* cleanup cannot invalidate an installed package */ }
    }
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
