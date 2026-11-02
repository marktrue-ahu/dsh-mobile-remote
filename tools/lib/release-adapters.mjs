#!/usr/bin/env node
// 发布工具的 git / npm **适配器**（issue #43）。
//
// 设计目的：所有网络/仓库读取都通过可注入的适配器完成，测试可完全离线、确定性：
//   - 默认适配器：git CLI（本地仓库）+ npm CLI 只读查询（`npm view` / `npm pack`，绝不 publish）。
//   - 测试适配器：通过 `--adapters <module>` 或环境变量 DSH_RELEASE_ADAPTERS 指向一个模块，
//     该模块导出 `createAdapters({ repoRoot, packageName, registry, env })`，形状与下方默认实现一致。
//
// 适配器接口（同步；调用方 catch 后映射为稳定 reason）：
//   git: {
//     fetch({remotes, branch})                      拉取 remotes 的分支与 tags（release-meta 必须显式 fetch）
//     revParse(ref) -> sha|null
//     show(ref, path) -> text|null                  `git show <ref>:<path>`；不存在返回 null
//     listTags() -> [{name, sha}]                   本地 tags（用于历史 build 与 tag 对比）
//     listRemoteTags(remote) -> [{name, sha}]       `git ls-remote --tags`（含 peeled SHA）
//     createBranchWithFile({branch, base, path, content, message}) -> {commit}
//   }
//   npm: {
//     listVersions(packageName) -> string[]         半开区间：E404 → []
//     viewVersion(packageName, version) -> object|null  E404 → null；对象含 version/appVersion/dist.integrity
//     distTags(packageName) -> Record<string,string>    E404 → {}
//     downloadTarball(packageName, version, destDir) -> {file}  npm pack（只读下载）
//   }
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { RELEASE_META_BRANCH, RELEASE_META_PATH, reason } from "./release-policy.mjs";

const TAG_PATTERN = "refs/tags/v*";

// m3：所有外部命令必须有界（防挂死 CI/本机）。超时可通过环境变量覆盖（仅供测试/特殊环境）。
function timeoutFromEnv(env, name, fallback) {
	const raw = Number.parseInt(String(env?.[name] ?? ""), 10);
	return Number.isSafeInteger(raw) && raw > 0 ? raw : fallback;
}

/** 所有外部命令的有界超时（毫秒）；可用环境变量覆盖（测试/特殊环境）。 */
export function releaseTimeouts(env = process.env) {
	return {
		git: timeoutFromEnv(env, "DSH_RELEASE_GIT_TIMEOUT_MS", 120_000),
		gitLong: timeoutFromEnv(env, "DSH_RELEASE_GIT_FETCH_TIMEOUT_MS", 300_000),
		npmView: timeoutFromEnv(env, "DSH_RELEASE_NPM_VIEW_TIMEOUT_MS", 60_000),
		npmPack: timeoutFromEnv(env, "DSH_RELEASE_NPM_PACK_TIMEOUT_MS", 300_000),
	};
}

function run(command, args, options = {}) {
	return spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
}

/** 有界运行：超时抛出带稳定 `releaseReason` 的错误，由调用方映射成 fail-closed reason。 */
function runBounded(command, args, { timeout, releaseReason, ...options } = {}) {
	const result = run(command, args, { ...options, timeout });
	if (result.error && (result.error.code === "ETIMEDOUT" || result.signal === "SIGTERM")) {
		const error = new Error(`${command} ${args[0] ?? ""} timed out after ${timeout}ms`);
		error.code = "ETIMEDOUT";
		error.releaseReason = releaseReason ?? "external-command-timeout";
		throw error;
	}
	return result;
}

function registryArgs(packageName, registry) {
	const args = [];
	if (registry) {
		args.push("--registry", registry);
		const scope = /^(@[^/]+)\//.exec(packageName)?.[1];
		if (scope) args.push(`--${scope}:registry=${registry}`);
	}
	return args;
}

/**
 * 只读 `npm view`。**必须把包目标与字段分开拼 argv**（task-19 blocker）：
 *   `npm view <pkg> versions`、`npm view <pkg>@<ver>`、`npm view <pkg> dist-tags`。
 * registry 参数按 **packageName** 推导 scope（packageSpec 可能带 `@version`）。
 * @param {{packageName:string, packageSpec?:string, fields?:string[]}} target
 */
function npmView({ packageName, packageSpec = packageName, fields = [] }, { registry = null, env = process.env } = {}) {
	const args = ["view", packageSpec, ...fields, "--json", "--prefer-online", ...registryArgs(packageName, registry)];
	const result = runBounded("npm", args, {
		env,
		timeout: releaseTimeouts(env).npmView,
		releaseReason: "npm-metadata-unavailable",
	});
	if (result.error) throw new Error(`npm view ${packageSpec} failed: ${result.error.message}`);
	if (result.status !== 0) {
		const output = `${result.stderr ?? ""}${result.stdout ?? ""}`;
		if (/\bE404\b/.test(output) || /is not in this registry/.test(output)) return { ok: true, missing: true, value: null };
		const code = /npm error code (\S+)/.exec(output)?.[1] ?? "unknown";
		throw new Error(`npm view ${packageSpec} failed (code=${code}): ${output.trim().split("\n").slice(-3).join(" ")}`);
	}
	const text = String(result.stdout ?? "").trim();
	if (text === "") return { ok: true, missing: true, value: null };
	return { ok: true, missing: false, value: JSON.parse(text) };
}

function parseRemoteTags(stdout) {
	const byName = new Map();
	for (const line of String(stdout ?? "").split(/\r?\n/)) {
		const match = /^([0-9a-f]{40,64})\t(refs\/tags\/(.+))$/.exec(line.trim());
		if (!match) continue;
		const [, sha, , ref] = match;
		const peeled = ref.endsWith("^{}");
		const name = peeled ? ref.slice(0, -3) : ref;
		if (peeled || !byName.has(name)) byName.set(name, { name, sha });
	}
	return [...byName.values()];
}

/** 默认 git 适配器（本地仓库、只读 + 仅在显式 createBranchWithFile 时用 plumbing 写 ref）。 */
export function createDefaultGitAdapter({ repoRoot, env = process.env }) {
	const timeouts = releaseTimeouts(env);
	const git = (args, { timeout = timeouts.git, ...options } = {}) => runBounded(
		"git",
		["-C", repoRoot, ...args],
		{ env, timeout, releaseReason: "git-metadata-unavailable", ...options },
	);
	const gitText = (args) => {
		const result = git(args);
		if (result.status !== 0) return null;
		return String(result.stdout ?? "");
	};
	const adapter = {
		git,
		fetch({ remotes = ["origin", "github"] } = {}) {
			// 设计稿 §8：必须 `--multiple`（不是把两个 remote 当位置参数重复）。先普通 fetch，
			// 再显式 fetch release-meta（部分 CI checkout 的默认 refspec 不含所有分支）。
			const result = git(["fetch", "--multiple", "--tags", ...remotes], { timeout: timeouts.gitLong });
			if (result.status !== 0) {
				throw new Error(`git fetch --multiple --tags ${remotes.join(" ")} failed: ${(result.stderr ?? "").trim()}`);
			}
			// release-meta 拉取失败不在这里抛错：交给 readReleaseMetaFromRemotes 统一给出
			// 稳定的 `release-meta-missing` fail-closed reason（而不是笼统的 git-fetch-failed）。
			adapter.releaseMetaFetchErrors = [];
			for (const remote of remotes) {
				const meta = git([
					"fetch", "--no-tags", remote,
					`+refs/heads/${RELEASE_META_BRANCH}:refs/remotes/${remote}/${RELEASE_META_BRANCH}`,
				], { timeout: timeouts.gitLong });
				if (meta.status !== 0) {
					adapter.releaseMetaFetchErrors.push({
						remote,
						detail: (meta.stderr ?? "").trim(),
					});
				}
			}
		},
		revParse(ref) {
			const result = git(["rev-parse", "--verify", "--quiet", ref]);
			return result.status === 0 ? String(result.stdout ?? "").trim() : null;
		},
		show(ref, filePath) {
			const result = git(["show", `${ref}:${filePath}`]);
			return result.status === 0 ? String(result.stdout ?? "") : null;
		},
		listTags() {
			const text = gitText(["for-each-ref", TAG_PATTERN, "--format=%(refname:short)\t%(objectname)"]);
			if (text === null) return [];
			return text.split(/\r?\n/).filter(Boolean).map((line) => {
				const [name, sha] = line.split("\t");
				return { name, sha };
			});
		},
		listRemoteTags(remote) {
			const result = git(["ls-remote", "--tags", remote, TAG_PATTERN], { timeout: timeouts.gitLong });
			if (result.status !== 0) throw new Error(`git ls-remote --tags ${remote} failed: ${(result.stderr ?? "").trim()}`);
			return parseRemoteTags(result.stdout);
		},
		createBranchWithFile({ branch, base = "HEAD", path: filePath, content, message }) {
			const baseSha = adapter.revParse(base);
			if (baseSha === null) throw new Error(`base ref 不存在: ${base}`);
			const blob = runBounded("git", ["-C", repoRoot, "hash-object", "-w", "--stdin"], { input: content, env, timeout: timeouts.git, releaseReason: "git-metadata-unavailable" });
			if (blob.status !== 0) throw new Error(`git hash-object 失败: ${(blob.stderr ?? "").trim()}`);
			const blobSha = String(blob.stdout ?? "").trim();
			const treeInput = `100644 blob ${blobSha}\t${filePath}\n`;
			const tree = runBounded("git", ["-C", repoRoot, "mktree"], { input: treeInput, env, timeout: timeouts.git, releaseReason: "git-metadata-unavailable" });
			if (tree.status !== 0) throw new Error(`git mktree 失败: ${(tree.stderr ?? "").trim()}`);
			const treeSha = String(tree.stdout ?? "").trim();
			const commit = runBounded("git", [
				"-C", repoRoot, "commit-tree", treeSha, "-p", baseSha, "-m", String(message ?? `chore(release-meta): seed ${filePath}`),
			], { env, timeout: timeouts.git, releaseReason: "git-metadata-unavailable" });
			if (commit.status !== 0) throw new Error(`git commit-tree 失败: ${(commit.stderr ?? "").trim()}`);
			const commitSha = String(commit.stdout ?? "").trim();
			const existing = git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
			const update = git(["update-ref", `refs/heads/${branch}`, commitSha, existing.status === 0 ? String(existing.stdout ?? "").trim() : ""]);
			if (update.status !== 0) throw new Error(`git update-ref refs/heads/${branch} 失败: ${(update.stderr ?? "").trim()}`);
			return { branch, commit: commitSha, base: baseSha, path: filePath };
		},
	};
	return adapter;
}

/** 默认 npm 适配器：只有只读 `npm view` / `npm pack`；绝不 publish / dist-tag 写入。 */
export function createDefaultNpmAdapter({ packageName, registry = null, env = process.env }) {
	return {
		listVersions(pkg = packageName) {
			const result = npmView({ packageName: pkg, fields: ["versions"] }, { registry, env });
			if (result.missing) return [];
			const value = result.value;
			if (Array.isArray(value)) return value.map(String);
			if (typeof value === "string") return [value];
			throw new Error(`npm view ${pkg} versions 返回非法 JSON: ${JSON.stringify(value)?.slice(0, 200)}`);
		},
		viewVersion(pkg = packageName, version) {
			const result = npmView({ packageName: pkg, packageSpec: `${pkg}@${version}` }, { registry, env });
			if (result.missing) return null;
			return result.value;
		},
		distTags(pkg = packageName) {
			const result = npmView({ packageName: pkg, fields: ["dist-tags"] }, { registry, env });
			if (result.missing) return {};
			return result.value && typeof result.value === "object" ? result.value : {};
		},
		downloadTarball(pkg = packageName, version, destDir) {
			fs.mkdirSync(destDir, { recursive: true });
			const args = [
				"pack", `${pkg}@${version}`,
				"--pack-destination", destDir,
				"--json",
				...registryArgs(pkg, registry),
			];
			const result = runBounded("npm", args, {
				env,
				timeout: releaseTimeouts(env).npmPack,
				releaseReason: "npm-metadata-unavailable",
			});
			if (result.status !== 0) {
				throw new Error(`npm pack ${pkg}@${version} failed: ${(result.stderr ?? "").trim()}`);
			}
			const parsed = JSON.parse(String(result.stdout ?? "[]"));
			const filename = parsed?.[0]?.filename;
			if (typeof filename !== "string" || filename === "") throw new Error("npm pack 未返回 filename");
			const file = path.join(destDir, filename);
			if (!fs.existsSync(file)) throw new Error(`npm pack 产物不存在: ${file}`);
			return { file, filename };
		},
	};
}

/** 依据 `--adapters` / DSH_RELEASE_ADAPTERS 加载适配器；否则用默认实现。 */
export async function loadAdapters({ adaptersPath = null, repoRoot, packageName, registry = null } = {}) {
	const modulePath = adaptersPath ?? process.env.DSH_RELEASE_ADAPTERS ?? "";
	if (modulePath === "") {
		return {
			git: createDefaultGitAdapter({ repoRoot }),
			npm: createDefaultNpmAdapter({ packageName, registry }),
			source: "default",
		};
	}
	const resolved = modulePath.startsWith(".") || modulePath.startsWith("/")
		? path.resolve(modulePath)
		: modulePath;
	const module = await import(resolved.startsWith("/") ? `file://${resolved}` : resolved);
	const factory = module.createAdapters ?? module.default;
	if (typeof factory !== "function") {
		throw new Error(`适配器模块必须导出 createAdapters({repoRoot, packageName, registry}): ${modulePath}`);
	}
	const adapters = await factory({ repoRoot, packageName, registry, env: process.env });
	if (!adapters?.git || !adapters?.npm) throw new Error(`适配器模块缺少 git/npm: ${modulePath}`);
	return { ...adapters, source: modulePath };
}

// ── release-meta 读取 ────────────────────────────────────────────────────────────────

/**
 * 从多个 git remote 读取 `release-meta:build-policy.json`（只读；调用前必须已 fetch）。
 * 返回与 `assertReleaseMetaSources` / `loadBuildPolicyFromSources` 兼容的结构。
 * @returns {{sources: Record<string,{name:string, ref:string, sha:string|null, content:string|null}>, reasons:object[]}}
 */
export function readReleaseMetaFromRemotes({ git, remotes = ["origin", "github"], branch = RELEASE_META_BRANCH, path: policyPath = RELEASE_META_PATH }) {
	const sources = {};
	const reasons = [];
	for (const remote of remotes) {
		const ref = `refs/remotes/${remote}/${branch}`;
		const sha = git.revParse(ref);
		const content = sha === null ? null : git.show(ref, policyPath);
		sources[remote] = { name: remote, ref, sha, content };
		if (sha === null) reasons.push(reason("release-meta-missing", `${remote}/${branch} 不存在（ref=${ref}）`));
		else if (content === null) reasons.push(reason("release-meta-missing", `${ref}:${policyPath} 不存在`));
	}
	return { sources, reasons };
}

/** 读取 tag 提交里的 pubspec 版本（历史 build）。 */
export function parsePubspecVersion(text) {
	const match = /^version:[ \t]*([0-9]+\.[0-9]+\.[0-9]+\+[0-9]+)(?:[ \t]+#.*)?[ \t]*$/m.exec(String(text ?? ""));
	if (!match) return null;
	const [, full] = match;
	const [core, buildText] = full.split("+");
	return { full, core, build: Number.parseInt(buildText, 10) };
}

/**
 * 读取所有发布 tag 提交里的 build（**只用于分配端避免复用**；CI 不用它做判据）。
 * @param {{git:object, tags:Array, packageName?:string|null}} input
 * @returns {{ok:boolean, maxBuild:number, perTag:Array<{tag:string,build:number}>, ignored:Array<{tag:string,reason:string}>, reasons:object[]}}
 *
 * `packageName` 用于区分**本 fork 的发布 tag** 与上游/镜像 tag：tag 的 package.json 若不是
 * 本包（或没有 package.json），视为非本仓库发布 tag 并忽略；只有确认是本包却缺少/非法
 * pubspec build 时才 fail-closed（防止悄悄忽略损坏的发布 tag 造成 build 复用）。
 */
export function readHistoricalTagBuilds({ git, tags, packageName = null }) {
	const reasons = [];
	const perTag = [];
	const ignored = [];
	for (const entry of tags) {
		const tag = typeof entry === "string" ? entry : entry?.name;
		if (typeof tag !== "string" || !/^v\d/.test(tag)) continue;
		if (packageName !== null && packageName !== undefined) {
			const packageJsonText = git.show(tag, "package.json");
			let tagPackageName = null;
			try {
				tagPackageName = packageJsonText === null ? null : JSON.parse(packageJsonText).name ?? null;
			} catch {
				tagPackageName = null;
			}
			if (tagPackageName !== packageName) {
				ignored.push({ tag, reason: "not-this-package" });
				continue;
			}
		}
		const pubspec = git.show(tag, "dsh-mobile-app/pubspec.yaml");
		if (pubspec === null) {
			reasons.push(reason("tag-build-invalid", `${tag} 缺少 dsh-mobile-app/pubspec.yaml`));
			continue;
		}
		const parsed = parsePubspecVersion(pubspec);
		if (parsed === null) {
			reasons.push(reason("tag-build-invalid", `${tag} 的 pubspec version 不是 X.Y.Z+N`));
			continue;
		}
		perTag.push({ tag, build: parsed.build, version: parsed.full });
	}
	const maxBuild = perTag.reduce((max, entry) => (entry.build > max ? entry.build : max), 0);
	return { ok: reasons.length === 0, maxBuild, perTag, ignored, reasons };
}

/**
 * 从 npm 读取全部已发布 carrier 元数据（版本以 `-app` 结尾）。
 * 不认识的版本格式忽略（不是 carrier）；carrier 缺 appVersion 由 frontier 计算 fail-closed。
 * @returns {{ok:boolean, carriers:Array<{version:string, appVersion?:string|null, integrity?:string}>, reasons:object[]}}
 */
export function readPublishedCarriers({ npm, packageName }) {
	const reasons = [];
	let versions = [];
	try {
		versions = npm.listVersions(packageName);
	} catch (error) {
		return { ok: false, carriers: [], reasons: [reason("npm-metadata-unavailable", String(error?.message ?? error))] };
	}
	const carriers = [];
	for (const version of versions) {
		const text = String(version);
		if (!text.endsWith("-app")) continue;
		let metadata = null;
		try {
			metadata = npm.viewVersion(packageName, text);
		} catch (error) {
			return { ok: false, carriers: [], reasons: [reason("npm-metadata-unavailable", `${text}: ${String(error?.message ?? error)}`)] };
		}
		if (metadata === null) {
			reasons.push(reason("carrier-metadata-missing", `${packageName}@${text} 在 versions 中出现但 view 不可读`));
			continue;
		}
		const integrity = metadata?.dist?.integrity;
		carriers.push({
			version: text,
			appVersion: metadata?.appVersion ?? null,
			integrity: typeof integrity === "string" ? integrity : undefined,
		});
	}
	return { ok: reasons.length === 0, carriers, reasons };
}

/** 计算 npm tarball 的 sha512 integrity。 */
export function fileIntegrity(file) {
	return `sha512-${crypto.createHash("sha512").update(fs.readFileSync(file)).digest("base64")}`;
}

/**
 * 读取 carrier tarball 内嵌 app build：优先 package/manifest.json 的 app.version，
 * 否则由调用方注入的 `readApkBuild`（aapt 实读）兜底。只读取，不修改包。
 * @param {{carrierDir:string, readApkBuild?: (apkPath:string)=>number|null}} input
 * @returns {{ok:boolean, build:number|null, evidence:object, reasons:object[]}}
 */
export function readEmbeddedCarrierBuild({ carrierDir, readApkBuild = null }) {
	const reasons = [];
	const manifestFile = path.join(carrierDir, "manifest.json");
	let manifest = null;
	try {
		manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
	} catch {
		manifest = null;
	}
	const appVersion = manifest?.app?.version;
	if (typeof appVersion === "string") {
		const match = /^\d+\.\d+\.\d+\+(\d+)$/.exec(appVersion);
		if (match) {
			return { ok: true, build: Number.parseInt(match[1], 10), evidence: { method: "manifest", appVersion }, reasons: [] };
		}
	}
	if (typeof readApkBuild === "function") {
		const apkName = manifest?.app?.file ?? (Array.isArray(manifest?.files) ? manifest.files.find((file) => /\.apk$/i.test(String(file))) : null);
		if (typeof apkName === "string" && apkName !== "") {
			const apkPath = path.join(carrierDir, apkName);
			const build = readApkBuild(apkPath);
			if (Number.isSafeInteger(build) && build > 0) {
				return { ok: true, build, evidence: { method: "apk", apk: apkName }, reasons: [] };
			}
		}
	}
	reasons.push(reason("legacy-carrier-build-unreadable", `无法从 ${carrierDir} 读取 App build（manifest.app.version 缺失且 APK 不可读）`));
	return { ok: false, build: null, evidence: {}, reasons };
}
