// GitHub main 上游镜像同步（#41）。只更新固定仓库的 main，绝不合并或强推。
// 默认只读预演；真正写入仅允许在 fork/develop 的 schedule / workflow_dispatch 中执行。
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const TARGET_REPOSITORY = "marktrue-ahu/dsh-mobile-remote";
export const UPSTREAM_REPOSITORY = "201222-L/dsh-mobile-remote";
const API_ROOT = "https://api.github.com";
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const READ_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;
// GitHub 对 compare 响应的 files 数组有上限（300）；达到上限时不能断言「没有 workflow 变更」。
const COMPARE_FILE_LIMIT = 300;
const WORKFLOW_PREFIX = ".github/workflows/";
const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

export class SyncError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "SyncError";
		this.code = code;
	}
}

function apiError(status) {
	if (status === 401) return new SyncError("authentication-failed", "GitHub 认证失败，请检查同步 token。");
	if (status === 403) return new SyncError("permission-denied", "GitHub 拒绝访问：检查 Contents 写权限、分支保护；上游含 workflow 变更时可能需要 Workflows 写权限。");
	if (status === 429) return new SyncError("rate-limited", "GitHub API 限流，请稍后重试。");
	if (status === 404) return new SyncError("ref-or-comparison-unavailable", "仓库、main 引用或跨 fork 提交比较不可用，请检查仓库关系与历史。");
	if (status === 409 || status === 422) return new SyncError("update-rejected", "GitHub 拒绝更新，可能存在并发修改或非快进历史；未强推，请人工检查。");
	return new SyncError("github-api-failed", `GitHub API 请求失败（HTTP ${status}），本次不继续同步。`);
}

// 从 compare 响应提取本次区间内被新增/修改/删除的 workflow 文件。
// 目的是把「写入被拒」拆成可自解释的原因，而不是让维护者只看到泛化的 permission-denied。
// files 可能因响应上限被截断，此时只报告已见部分并标注可能不完整，不声称清单是全集。
export function workflowChanges(comparison) {
	const files = Array.isArray(comparison?.files) ? comparison.files : [];
	const paths = files
		.map((file) => file?.filename)
		.filter((name) => typeof name === "string" && name.startsWith(WORKFLOW_PREFIX))
		.sort();
	// compare 的 files 数组上限是 300；只有真的顶到上限才不能断言「没有 workflow 变更」，
	// 提交数本身不说明 files 是否被截断，不能据此判定。
	const truncated = files.length >= COMPARE_FILE_LIMIT;
	return { paths, truncated };
}

function workflowPermissionError(paths, truncated, status) {
	const list = paths.length ? paths.join("、") : "（响应已截断，未能列出具体文件）";
	return new SyncError(
		"workflow-permission-required",
		`上游本次引入了 ${WORKFLOW_PREFIX} 下的变更（${list}${truncated ? "，清单可能不完整" : ""}），`
		+ `而 GitHub 以 HTTP ${status} 拒绝了这次引用更新。`
		+ "GitHub 不允许内置 GITHUB_TOKEN 更新 workflow 文件（它拿不到 workflows 权限），"
		+ "仅有 Contents 写权限的细粒度 token 也不行；这是独立于并发修改/非快进历史/认证失效的权限规则。"
		+ "处置：在 fork 的 Environment `upstream-sync` 配置 secret `UPSTREAM_SYNC_TOKEN`"
		+ "（细粒度 PAT，需 Contents:write 与 Workflows:write），或改用具备 workflows 权限的 GitHub App token。"
		+ "未扩大任何权限，也未重发写请求。",
	);
}

export function assertContext({ dryRun, context = {}, token = "" }) {
	if (context.repository && context.repository !== TARGET_REPOSITORY) {
		throw new SyncError("wrong-repository", "同步只允许针对固定的 fork 仓库运行。");
	}
	if (context.actions || !dryRun) {
		if (!context.actions || context.repository !== TARGET_REPOSITORY
			|| context.ref !== "refs/heads/develop"
			|| !["schedule", "workflow_dispatch"].includes(context.event)) {
			throw new SyncError("invalid-ci-context", "实际同步仅允许在 fork/develop 的 schedule 或 workflow_dispatch 中执行。");
		}
	}
	if (!dryRun && !token) throw new SyncError("token-required", "实际同步需要 GitHub token；本次未发送写请求。");
}

function retryDelay(value) {
	if (!value) return null;
	const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
	return Number.isFinite(delay) && delay <= 5000 ? Math.max(0, delay) : null;
}

// primary/secondary rate limit 在 GET 与 PATCH 中一致分类；不把限流误报成权限不足。
async function rateLimit(response) {
	const primary = response.headers.get("x-ratelimit-remaining") === "0";
	const retryAfter = response.headers.get("retry-after");
	let secondary = false;
	if (response.status === 403 && !primary && !retryAfter) {
		try {
			const body = await response.json();
			secondary = /secondary rate limit|rate limit exceeded|abuse detection/i.test(String(body?.message ?? ""));
		} catch { /* 不公开原始错误正文。 */ }
	}
	if (response.status !== 429 && !(response.status === 403 && (primary || retryAfter || secondary))) return null;
	// primary 配额耗尽等下轮再试；secondary 未给 Retry-After 时应至少等 60 秒，
	// 超出本任务的短重试窗口，所以直接退出，不用 1/2 秒重试继续压 API。
	return { delay: primary ? null : retryDelay(retryAfter) };
}

function createClient({ token, fetchImpl, sleepImpl }) {
	const headers = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "dsh-mobile-remote-upstream-sync",
	};
	if (token) headers.Authorization = `Bearer ${token}`;
	const request = (path, options = {}) => fetchImpl(`${API_ROOT}${path}`, {
		method: "GET",
		headers,
		redirect: "error", // 凭据不能随 API 重定向发送到其他地址。
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		...options,
	});
	return {
		async read(path) {
			for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
				let response;
				try {
					response = await request(path);
				} catch {
					if (attempt + 1 === READ_ATTEMPTS) throw new SyncError("api-unreachable", "GitHub API 网络不可用或请求超时。");
					await sleepImpl((attempt + 1) * 1000);
					continue;
				}
				if (response.ok) {
					try { return await response.json(); }
					catch { throw new SyncError("invalid-api-response", "GitHub API 未返回有效 JSON；不继续同步。"); }
				}
				const limit = await rateLimit(response);
				if (limit) {
					if (limit.delay === null || attempt + 1 === READ_ATTEMPTS) {
						throw new SyncError("rate-limited", "GitHub API 已限流，请等待配额恢复后重试。");
					}
					await sleepImpl(limit.delay);
					continue;
				}
				if (![500, 502, 503, 504].includes(response.status) || attempt + 1 === READ_ATTEMPTS) {
					throw apiError(response.status);
				}
				const retryAfter = response.headers.get("retry-after");
				const delay = retryAfter ? retryDelay(retryAfter) : (attempt + 1) * 1000;
				if (delay === null) throw apiError(response.status);
				await sleepImpl(delay);
			}
		},
		async update(sha, { hasWorkflowChanges = false, workflowPaths = [], workflowTruncated = false } = {}) {
			let response;
			try {
				response = await request(`/repos/${TARGET_REPOSITORY}/git/refs/heads/main`, {
					method: "PATCH",
					body: JSON.stringify({ sha, force: false }),
					headers: { ...headers, "Content-Type": "application/json" },
				});
			} catch { return false; } // 写入是否发生不明：由调用方读回确认，绝不重发 PATCH。
			if (response.ok) return true;
			if (await rateLimit(response)) throw new SyncError("rate-limited", "GitHub API 已限流，本次不重发写请求，请等待恢复后重试。");
			if (response.status >= 500 || response.status === 408) return false;
			// 已知本次区间改了 workflow 文件，且写入被 403/422 拒绝：这是 workflows 权限规则，
			// 不是并发修改或非快进历史。给出独立原因与清单，避免与 permission-denied/update-rejected 混淆。
			if (hasWorkflowChanges && [403, 422].includes(response.status)) {
				throw workflowPermissionError(workflowPaths, workflowTruncated, response.status);
			}
			throw apiError(response.status);
		},
	};
}

function mainSha(ref) {
	const sha = ref?.object?.sha;
	if (ref?.ref !== "refs/heads/main" || ref?.object?.type !== "commit"
		|| typeof sha !== "string" || !SHA_PATTERN.test(sha)) {
		throw new SyncError("invalid-main-reference", "GitHub main 引用不是有效的 commit SHA；不继续同步。");
	}
	return sha;
}

export async function synchronizeMain({
	dryRun = true,
	token = "",
	context = {},
	fetchImpl = fetch,
	sleepImpl = sleep,
} = {}) {
	// 在任何读取前建立固定上下文。读取到的 SHA 立即保存，后续失败也不丢失；
	// 尚未读到的 SHA 保持缺失，不用推测值补齐。
	const result = {
		repository: TARGET_REPOSITORY,
		upstream: UPSTREAM_REPOSITORY,
		branch: "main",
		dryRun,
	};
	try {
		assertContext({ dryRun, context, token });
		const client = createClient({ token, fetchImpl, sleepImpl });
		const beforeSha = mainSha(await client.read(`/repos/${TARGET_REPOSITORY}/git/ref/heads/main`));
		result.beforeSha = beforeSha;
		const upstreamSha = mainSha(await client.read(`/repos/${UPSTREAM_REPOSITORY}/git/ref/heads/main`));
		result.upstreamSha = upstreamSha;
		result.compareUrl = `https://github.com/${TARGET_REPOSITORY}/compare/${beforeSha}...201222-L:${upstreamSha}`;
		if (beforeSha === upstreamSha) return { ...result, status: "up-to-date", commits: 0, afterSha: beforeSha };
		// 两端 SHA 均固定。上游在本次运行中继续前进，不会替换本次目标。
		const comparison = await client.read(`/repos/${TARGET_REPOSITORY}/compare/${beforeSha}...201222-L:${upstreamSha}`);
		if (comparison?.status === "behind") throw new SyncError("fork-ahead", "fork main 领先于上游，违反纯镜像约定；保留现状，请人工检查。");
		if (comparison?.status === "diverged") throw new SyncError("fork-diverged", "fork main 与上游历史分叉；保留现状，不合并、不强推。");
		if (comparison?.status !== "ahead" || comparison.behind_by !== 0
			|| !Number.isSafeInteger(comparison.ahead_by) || comparison.ahead_by <= 0
			|| comparison.merge_base_commit?.sha !== beforeSha) {
			throw new SyncError("comparison-unproven", "无法证明 fork main 是本次上游目标的祖先；不更新引用。");
		}
		result.commits = comparison.ahead_by;
		// 先算清 workflow 变更，供写入失败时给出可自解释的原因；预演也照常报告，
		// 让维护者能在真正写入前就知道这一轮会撞上 workflows 权限规则。
		const { paths: workflowPaths, truncated: workflowTruncated } = workflowChanges(comparison);
		result.workflowChanges = workflowPaths;
		if (workflowTruncated) result.workflowChangesTruncated = true;
		if (dryRun) return { ...result, status: "would-fast-forward" };
		const acknowledged = await client.update(upstreamSha, {
			hasWorkflowChanges: workflowPaths.length > 0 || workflowTruncated,
			workflowPaths,
			workflowTruncated,
		});
		let afterSha;
		try { afterSha = mainSha(await client.read(`/repos/${TARGET_REPOSITORY}/git/ref/heads/main`)); }
		catch { throw new SyncError("verification-unavailable", "已尝试快进更新，但无法读回确认结果；请先检查远端 main，不盲目重试写入。"); }
		result.afterSha = afterSha; // 即使目标不符，也保留真实读到的 main SHA 供排障。
		if (afterSha !== upstreamSha) {
			throw new SyncError(acknowledged ? "verification-mismatch" : "update-uncertain",
				"写后 main 未确认到本次固定的上游 SHA；可能存在并发修改，本次不重发写请求、不回滚或强推。");
		}
		return { ...result, status: "fast-forwarded", afterSha, recovered: !acknowledged };
	} catch (error) {
		if (error instanceof SyncError) error.result = result;
		throw error;
	}
}

export function safeFailure(error) {
	if (error instanceof SyncError) return { ...error.result, status: "failed", reason: error.code, message: error.message };
	return { status: "failed", reason: "unexpected-sync-failure", message: "同步发生未预期错误；未输出原始响应或凭据，请检查工作流环境。" };
}

export function formatSummary(result) {
	const lines = [
		"## 上游 main 同步", "",
		`- 目标仓库：\`${TARGET_REPOSITORY}:main\``,
		`- 上游仓库：\`${UPSTREAM_REPOSITORY}:main\``,
		`- 状态：\`${result.status}\``,
		`- 原 fork main：${result.beforeSha ? `\`${result.beforeSha}\`` : "未取得"}`,
		`- 本次上游目标：${result.upstreamSha ? `\`${result.upstreamSha}\`` : "未取得"}`,
	];
	if (result.afterSha) lines.push(`- 读回的 main：\`${result.afterSha}\``);
	if (result.recovered) lines.push("- 写入响应不确定，已通过读回确认生效，未重发写请求。");
	if (result.commits !== undefined) lines.push(`- 上游新增提交数：${result.commits}`);
	if (Array.isArray(result.workflowChanges) && result.workflowChanges.length) {
		lines.push(
			`- 本次区间涉及 \`${WORKFLOW_PREFIX}\` 的变更（${result.workflowChanges.length} 个）：`,
			...result.workflowChanges.map((path) => `  - \`${path}\``),
		);
		if (result.workflowChangesTruncated) lines.push("  - ⚠ 比较响应已截断，以上清单可能不完整。");
	}
	if (result.compareUrl) lines.push(`- [查看本次提交比较](${result.compareUrl})`);
	if (result.reason) lines.push(`- 原因：\`${result.reason}\``, `- 说明：${result.message}`);
	lines.push("", "本脚本仅直接操作 GitHub main，不直接合并 develop、更新 release/tag/npm 或同步本地/GitLab；PAT/App 产生的 push 可能触发其他工作流，需另行审查。", "");
	return lines.join("\n");
}

export function parseMode(args) {
	if (args.length === 0) return true;
	if (args.length === 1 && args[0] === "--dry-run") return true;
	if (args.length === 1 && args[0] === "--apply") return false;
	throw new SyncError("invalid-arguments", "用法：node tools/sync-upstream-main.mjs [--dry-run|--apply]（默认预演）。");
}

async function main() {
	let result;
	try {
		result = await synchronizeMain({
			dryRun: parseMode(process.argv.slice(2)),
			token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "",
			context: {
				actions: process.env.GITHUB_ACTIONS === "true",
				repository: process.env.GITHUB_REPOSITORY,
				ref: process.env.GITHUB_REF,
				event: process.env.GITHUB_EVENT_NAME,
			},
		});
	} catch (error) { result = safeFailure(error); process.exitCode = 1; }
	console.log(JSON.stringify(result, null, 2));
	if (process.env.GITHUB_STEP_SUMMARY) {
		try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, formatSummary(result)); }
		catch {
			// 摘要是辅助输出。main 可能已经更新，不能因写摘要失败把成功误报为失败。
			console.error("::warning::无法写入 Actions Summary；同步结果与退出码保持不变，请以 stdout 中的状态和 SHA 为准。");
		}
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
