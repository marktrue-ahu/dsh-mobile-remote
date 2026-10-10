// 插件侧的**更新判定**（CONTEXT「内容标识」「对齐提示」「降级指引」）。
//
// 这里只放纯逻辑，不做任何 I/O 决策之外的事：
//   - 规范化发布清单；
//   - 解析 tgz 的下载地址（清单里给 `url`，否则相对清单自身地址解析）；
//   - 比较「本地内容标识 vs 清单内容标识」决定要不要下载（版本号只做提示与排序）；
//   - 识别本机的**安装形态**，据此给出可执行动作或降级指引。
// 下载、校验、落位、pnpm、重启属于执行面，不在这里（见后续阶段的执行模块）。
//
// 三条判据互不代替：能力能不能用看能力声明；要不要下载看**内容标识**；要不要提示看版本号。
import { createHash } from "node:crypto";

/** 本模块能处理的清单 schema。 */
export const SUPPORTED_MANIFEST_SCHEMA = 1;

/** 更新判定结果。 */
export const UPDATE_ACTION = {
	/** 本地内容与清单一致：已是最新。 */
	UP_TO_DATE: "up-to-date",
	/** 清单内容与本地不同、且不早于本地：应更新。 */
	UPDATE_AVAILABLE: "update-available",
	/** 本地比清单新（例如本地装了更新的自建构建）：不降级。 */
	LOCAL_AHEAD: "local-ahead",
	/** 清单不可用或字段缺失：无法判断，如实报出。 */
	UNKNOWN: "unknown",
};

/** 安装形态（决定升级动作，见 docs/06-install-run.md 的三种方式）。 */
export const INSTALL_SHAPE = {
	/** 从 npm/registry 解析（`^3.2.0` 之类）。 */
	REGISTRY: "registry",
	/** `github:owner/repo#tag` 这类 git 依赖。 */
	GITHUB_TAG: "github-tag",
	/** `file:` 指向一个本地 clone（含 .git）。 */
	FILE_CLONE: "file-clone",
	/** `file:` 指向一个已解开的目录（非 git 仓库）。 */
	FILE_DIR: "file-dir",
	/** `file:` 指向一个 .tgz 包。 */
	TGZ_FILE: "tgz-file",
	/** 无法识别。 */
	UNKNOWN: "unknown",
};

/** 更新执行方式：能自动完成，还是只能给出可复制的指引。 */
export const UPDATE_MODE = {
	AUTO: "auto",
	GUIDANCE: "guidance",
};

/** 解析 `X.Y.Z` 或 `X.Y.Z+N`；不合法返回 null。 */
export function parseVersion(value) {
	const m = /^(\d+)\.(\d+)\.(\d+)(?:\+(\d+))?$/.exec(typeof value === "string" ? value.trim() : "");
	if (!m) return null;
	return { major: +m[1], minor: +m[2], patch: +m[3], build: m[4] === undefined ? null : +m[4] };
}

/**
 * 比较两个版本号，返回 -1 / 0 / 1；任一不可解析时返回 null。
 * `+build` 只在语义版本相同时参与比较（App 侧用它判断"有没有更新"）；
 * 两端配对看的是语义版本，见 decideAlignment。
 */
export function compareVersion(a, b) {
	const pa = parseVersion(a);
	const pb = parseVersion(b);
	if (!pa || !pb) return null;
	for (const k of ["major", "minor", "patch"]) {
		if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
	}
	if (pa.build !== null && pb.build !== null && pa.build !== pb.build) return pa.build < pb.build ? -1 : 1;
	return 0;
}

/**
 * 规范化发布清单。只接受 schema 1；`plugin` 段是插件自更新所必需的部分。
 * 缺失字段不猜测：把可选的留空、必需的报错。
 */
export function normalizeReleaseManifest(raw) {
	if (!raw || typeof raw !== "object") return { ok: false, error: "manifest-not-object" };
	if (raw.schema !== SUPPORTED_MANIFEST_SCHEMA) {
		return { ok: false, error: "manifest-schema-unsupported", schema: raw.schema };
	}
	const p = raw.plugin;
	if (!p || typeof p !== "object") return { ok: false, error: "manifest-plugin-missing" };
	if (typeof p.version !== "string" || !parseVersion(p.version)) return { ok: false, error: "manifest-plugin-version-invalid" };
	if (typeof p.file !== "string" || p.file === "") return { ok: false, error: "manifest-plugin-file-missing" };
	const sha256 = typeof p.sha256 === "string" ? p.sha256.toLowerCase() : "";
	if (!/^[0-9a-f]{64}$/.test(sha256)) return { ok: false, error: "manifest-plugin-sha256-invalid" };
	const contentSha256 = typeof p.contentSha256 === "string" ? p.contentSha256.toLowerCase() : "";
	if (contentSha256 !== "" && !/^[0-9a-f]{64}$/.test(contentSha256)) {
		return { ok: false, error: "manifest-plugin-content-sha256-invalid" };
	}
	return {
		ok: true,
		schema: raw.schema,
		plugin: {
			version: p.version,
			file: p.file,
			url: typeof p.url === "string" && p.url !== "" ? p.url : "",
			size: Number.isFinite(p.size) ? p.size : null,
			sha256,
			contentSha256,
		},
		app: raw.app && typeof raw.app === "object" ? raw.app : null,
	};
}

/**
 * 解析插件包的下载地址：清单给了 `url` 就用它，否则相对**清单自身地址**解析。
 * 两者都没有则返回空串（调用方按"来源不可用"处理）。
 */
export function resolvePluginUrl(manifestUrl, plugin) {
	if (plugin?.url) return plugin.url;
	if (!manifestUrl || !plugin?.file) return "";
	try {
		return new URL(plugin.file, manifestUrl).toString();
	} catch {
		return "";
	}
}

/**
 * 决定要不要下载新版本。
 *
 * 判据是**内容标识**：版本号相同而内容不同（真实存在的形态）必须被识别为"应更新"。
 * 缺少内容标识时退化为版本比较，并把这一盲区写进 `reason`，不假装判断是完整的。
 */
export function decidePluginUpdate({ localVersion, localContentSha256, remote }) {
	if (!remote || typeof remote !== "object" || !parseVersion(remote.version)) {
		return { action: UPDATE_ACTION.UNKNOWN, reason: "remote-version-missing" };
	}
	const comparison = compareVersion(remote.version, localVersion ?? "");
	const localDigest = (localContentSha256 ?? "").toLowerCase();
	const remoteDigest = (remote.contentSha256 ?? "").toLowerCase();

	if (localDigest && remoteDigest) {
		if (localDigest === remoteDigest) {
			return { action: UPDATE_ACTION.UP_TO_DATE, reason: "content-identical", comparison };
		}
		if (comparison !== null && comparison < 0) {
			return { action: UPDATE_ACTION.LOCAL_AHEAD, reason: "content-differs-local-newer", comparison };
		}
		return {
			action: UPDATE_ACTION.UPDATE_AVAILABLE,
			reason: comparison === 0 ? "content-differs-same-version" : "content-differs-remote-newer",
			comparison,
		};
	}

	if (comparison === null) return { action: UPDATE_ACTION.UNKNOWN, reason: "local-version-unparseable" };
	if (comparison > 0) return { action: UPDATE_ACTION.UPDATE_AVAILABLE, reason: "version-newer-no-content-digest", comparison };
	if (comparison < 0) return { action: UPDATE_ACTION.LOCAL_AHEAD, reason: "version-older-no-content-digest", comparison };
	// 版本相同又无内容标识：这是"看不见版本号相同内容不同"的盲区，如实标注
	return { action: UPDATE_ACTION.UP_TO_DATE, reason: "version-equal-no-content-digest", comparison };
}

/** 从依赖声明推断安装形态；纯字符串判断，不碰文件系统。 */
export function classifySpecifier(specifier) {
	const s = typeof specifier === "string" ? specifier.trim() : "";
	if (s === "") return INSTALL_SHAPE.UNKNOWN;
	if (/^github:/i.test(s)) return INSTALL_SHAPE.GITHUB_TAG;
	if (/^link:/i.test(s)) return INSTALL_SHAPE.UNKNOWN;
	if (/^file:/i.test(s)) {
		const target = s.slice("file:".length).toLowerCase();
		if (target.endsWith(".tgz") || target.endsWith(".tar.gz")) return INSTALL_SHAPE.TGZ_FILE;
		return INSTALL_SHAPE.FILE_DIR; // 目录形态；是否 git clone 需要文件系统确认
	}
	if (/^[\^~]?\d+\.\d+\.\d+/.test(s) || /^(>|>=|<|<=|=|\*|latest)/.test(s)) return INSTALL_SHAPE.REGISTRY;
	return INSTALL_SHAPE.UNKNOWN;
}

/**
 * 探测安装形态。`specifier` 来自 profile 的 `package.json`；目录形态再用注入的谓词确认
 * 是否 git 仓库。`deps` 可注入，便于在不碰真实文件系统的测试里驱动。
 */
export function detectInstallShape({ specifier, dirPath = "", isGitRepo = () => false } = {}) {
	const base = classifySpecifier(specifier);
	if (base === INSTALL_SHAPE.FILE_DIR && dirPath && isGitRepo(dirPath)) return INSTALL_SHAPE.FILE_CLONE;
	return base;
}

/**
 * 该形态下如何更新。`auto` 表示本机可以自行完成（改依赖声明 + 安装 + 重启）；
 * `guidance` 表示只能给出**与实际安装方式对应的那一条**指引，不并列三条让用户猜。
 */
export function planForShape(shape, { specifier = "", dirPath = "" } = {}) {
	const installCmd = "pnpm install";
	switch (shape) {
	case INSTALL_SHAPE.REGISTRY:
		return {
			mode: UPDATE_MODE.AUTO,
			shape,
			summary: "从 npm 源升级：改写 profile 依赖版本后重新安装",
			steps: [`把 profile 的依赖版本改为新版（当前 ${specifier || "未知"}）`, "重新安装依赖", "重启 DSH 让插件生效"],
			commands: [installCmd],
		};
	case INSTALL_SHAPE.GITHUB_TAG:
		return {
			mode: UPDATE_MODE.AUTO,
			shape,
			summary: "git 依赖升级：把 tag 改到新版本后重新安装",
			steps: [`把 profile 依赖的 tag 改为 v<新版>（当前 ${specifier || "未知"}）`, "重新安装依赖", "重启 DSH 让插件生效"],
			commands: [installCmd],
		};
	case INSTALL_SHAPE.FILE_CLONE:
		return {
			mode: UPDATE_MODE.AUTO,
			shape,
			summary: "本地 clone 升级：拉取新代码后重新安装",
			steps: [`在 clone 目录拉取新版本${dirPath ? `（${dirPath}）` : ""}`, "重新安装依赖", "重启 DSH 让插件生效"],
			commands: [dirPath ? `git -C ${dirPath} pull` : "git pull", installCmd],
		};
	case INSTALL_SHAPE.FILE_DIR:
		return {
			mode: UPDATE_MODE.AUTO,
			shape,
			summary: "本地目录升级：用新版内容替换该目录后重新安装",
			steps: [`用新版插件内容替换该目录${dirPath ? `（${dirPath}）` : ""}`, "重新安装依赖", "重启 DSH 让插件生效"],
			commands: [installCmd],
		};
	case INSTALL_SHAPE.TGZ_FILE:
		return {
			mode: UPDATE_MODE.AUTO,
			shape,
			summary: "tgz 安装升级：换上新版 tgz 后重新安装",
			steps: [`下载新版 tgz 并替换${dirPath ? `（${dirPath}）` : "原包"}`, "重新安装依赖", "重启 DSH 让插件生效"],
			commands: [installCmd],
		};
	default:
		return {
			mode: UPDATE_MODE.GUIDANCE,
			shape: INSTALL_SHAPE.UNKNOWN,
			summary: "无法识别本机插件安装方式，按 docs/06-install-run.md 的三种方式之一处理",
			steps: ["确认插件是通过 clone、git tag 还是 tgz 安装的", "按对应方式更新到新版", "重启 DSH 让插件生效"],
			commands: [],
		};
	}
}

/** 对齐提示用的比较：只看语义版本（不含 `+build`），避免同一发布周期内每次构建都误报。 */
export function compareSemanticVersion(a, b) {
	const pa = parseVersion(a);
	const pb = parseVersion(b);
	if (!pa || !pb) return null;
	const left = `${pa.major}.${pa.minor}.${pa.patch}`;
	const right = `${pb.major}.${pb.minor}.${pb.patch}`;
	if (left === right) return 0;
	return compareVersion(left, right);
}

/** 计算某个文件的 sha256（发布侧与运行侧共用同一写法，避免大小写/编码差异）。 */
export function sha256Hex(buf) {
	return createHash("sha256").update(buf).digest("hex");
}
