import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
	TARGET_REPOSITORY, UPSTREAM_REPOSITORY, synchronizeMain,
	parseMode, safeFailure, formatSummary,
} from "../tools/sync-upstream-main.mjs";

const BEFORE = "a".repeat(40);
const UPSTREAM = "b".repeat(40);
const OTHER = "c".repeat(40);
const TOKEN = "secret-sync-token-never-print";
const context = { actions: true, repository: TARGET_REPOSITORY, ref: "refs/heads/develop", event: "workflow_dispatch" };
const ref = (sha) => ({ ref: "refs/heads/main", object: { type: "commit", sha } });
const comparison = { status: "ahead", ahead_by: 6, behind_by: 0, merge_base_commit: { sha: BEFORE } };
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });

function setup(responses, options = {}) {
	const calls = [];
	const waits = [];
	const queue = [...responses];
	const fetchImpl = async (url, init) => {
		calls.push({ url, ...init });
		assert.ok(queue.length, `Unexpected API request: ${init.method} ${url}`);
		const response = queue.shift();
		if (response instanceof Error) throw response;
		return typeof response === "function" ? response(url, init) : response;
	};
	return {
		calls, waits,
		run: (extra = {}) => synchronizeMain({
			fetchImpl, sleepImpl: async (ms) => waits.push(ms),
			token: TOKEN, context, ...options, ...extra,
		}),
	};
}
const reads = () => [json(ref(BEFORE)), json(ref(UPSTREAM)), json(comparison)];
const writes = (calls) => calls.filter((call) => call.method !== "GET");
const code = (expected) => (error) => { assert.equal(error.code, expected); return true; };

test("默认 CLI 与手动模式均安全：默认只读，拒绝无效或冲突参数", () => {
	assert.equal(parseMode([]), true);
	assert.equal(parseMode(["--dry-run"]), true);
	assert.equal(parseMode(["--apply"]), false);
	for (const args of [["--force"], ["--apply", "--dry-run"], ["--repo=other"]]) {
		assert.throws(() => parseMode(args), code("invalid-arguments"));
	}
});

test("main 已相同时只读，无比较/写入", async () => {
	const h = setup([json(ref(BEFORE)), json(ref(BEFORE))]);
	const result = await h.run({ dryRun: false });
	assert.equal(result.status, "up-to-date");
	assert.equal(result.commits, 0);
	assert.equal(h.calls.length, 2);
	assert.equal(writes(h.calls).length, 0);
});

test("快进预演固定两端 SHA，零写入并生成可审阅摘要", async () => {
	const h = setup(reads());
	const result = await h.run();
	assert.equal(result.status, "would-fast-forward");
	assert.equal(result.commits, 6);
	assert.equal(writes(h.calls).length, 0);
	assert.equal(h.calls[2].url, `https://api.github.com/repos/${TARGET_REPOSITORY}/compare/${BEFORE}...201222-L:${UPSTREAM}`);
	const summary = formatSummary(result);
	assert.ok(summary.includes(BEFORE) && summary.includes(UPSTREAM));
	assert.ok(summary.includes("上游新增提交数：6"));
	assert.ok(!summary.includes(TOKEN));
});

test("实际模式只 PATCH 固定 fork main、force=false，写后验证", async () => {
	const h = setup([...reads(), json({ object: { sha: UPSTREAM } }), json(ref(UPSTREAM))]);
	const result = await h.run({ dryRun: false });
	assert.equal(result.status, "fast-forwarded");
	assert.equal(result.afterSha, UPSTREAM);
	assert.equal(result.recovered, false);
	const [patch] = writes(h.calls);
	assert.equal(writes(h.calls).length, 1);
	assert.equal(patch.url, `https://api.github.com/repos/${TARGET_REPOSITORY}/git/refs/heads/main`);
	assert.deepEqual(JSON.parse(patch.body), { sha: UPSTREAM, force: false });
	for (const call of h.calls) {
		assert.equal(call.redirect, "error");
		assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`);
		assert.ok(call.signal instanceof AbortSignal);
	}
});

test("fork 领先或分叉均停止，不创建 merge、不强推", async () => {
	for (const [status, reason] of [["behind", "fork-ahead"], ["diverged", "fork-diverged"]]) {
		const h = setup([json(ref(BEFORE)), json(ref(UPSTREAM)), json({ ...comparison, status })]);
		await assert.rejects(h.run({ dryRun: false }), code(reason));
		assert.equal(writes(h.calls).length, 0);
	}
});

test("矛盾比较结果/无共同祖先/非法引用 fail closed", async () => {
	for (const bad of [
		{ ...comparison, merge_base_commit: { sha: OTHER } },
		{ ...comparison, behind_by: 1 }, { ...comparison, ahead_by: -1 },
		{ ...comparison, status: "identical" }, {},
	]) {
		const h = setup([json(ref(BEFORE)), json(ref(UPSTREAM)), json(bad)]);
		await assert.rejects(h.run({ dryRun: false }), code("comparison-unproven"));
		assert.equal(writes(h.calls).length, 0);
	}
	const missing = setup([json(ref(BEFORE)), json(ref(UPSTREAM)), json({ message: TOKEN }, 404)]);
	await assert.rejects(missing.run({ dryRun: false }), code("ref-or-comparison-unavailable"));
	assert.equal(writes(missing.calls).length, 0);
	for (const badRef of [ref("not-a-sha"), { ...ref(BEFORE), ref: "refs/tags/main" }, { ...ref(BEFORE), object: { type: "tag", sha: BEFORE } }]) {
		const h = setup([json(badRef)]);
		await assert.rejects(h.run({ dryRun: false }), code("invalid-main-reference"));
	}
});

test("本地仅允许预演；错误仓库/ref/event 与无 token 的实际操作零请求", async () => {
	for (const invalid of [
		{}, { ...context, actions: false }, { ...context, ref: "refs/heads/main" },
		{ ...context, event: "pull_request" }, { ...context, event: "push" },
	]) {
		const h = setup([]);
		await assert.rejects(h.run({ dryRun: false, context: invalid }), code("invalid-ci-context"));
		assert.equal(h.calls.length, 0);
	}
	const wrong = setup([]);
	await assert.rejects(wrong.run({ context: { ...context, repository: UPSTREAM_REPOSITORY } }), code("wrong-repository"));
	const noToken = setup([]);
	await assert.rejects(noToken.run({ dryRun: false, token: "" }), code("token-required"));
	const local = setup(reads());
	assert.equal((await local.run({ context: {}, token: "" })).status, "would-fast-forward");
	assert.ok(local.calls.every((call) => !call.headers.Authorization));
});

test("明确拒绝写入的 401/403/409/422 不重发，不覆盖并发修改", async () => {
	for (const [status, reason] of [[401, "authentication-failed"], [403, "permission-denied"], [409, "update-rejected"], [422, "update-rejected"]]) {
		const h = setup([...reads(), json({ message: TOKEN }, status)]);
		let failure;
		try { await h.run({ dryRun: false }); } catch (error) { failure = safeFailure(error); }
		assert.equal(failure.reason, reason);
		assert.equal(writes(h.calls).length, 1);
		assert.ok(!JSON.stringify(failure).includes(TOKEN));
		assert.ok(!formatSummary(failure).includes(TOKEN));
	}
});

test("写请求响应不确定先读回，已生效算成功，但只写一次", async () => {
	for (const failedResponse of [new Error(`timeout ${TOKEN}`), json({ message: TOKEN }, 503)]) {
		const h = setup([...reads(), failedResponse, json(ref(UPSTREAM))]);
		const result = await h.run({ dryRun: false });
		assert.equal(result.status, "fast-forwarded");
		assert.equal(result.recovered, true);
		assert.match(formatSummary(result), /写入响应不确定.*读回确认/);
		assert.equal(writes(h.calls).length, 1);
		assert.equal(h.calls.at(-1).method, "GET");
	}
});

test("写后目标异常或读回失败不回滚/重发，不假报完成", async () => {
	const mismatched = setup([...reads(), json({}), json(ref(OTHER))]);
	await assert.rejects(mismatched.run({ dryRun: false }), code("verification-mismatch"));
	assert.equal(writes(mismatched.calls).length, 1);
	const uncertain = setup([...reads(), new Error("timeout"), json(ref(BEFORE))]);
	await assert.rejects(uncertain.run({ dryRun: false }), code("update-uncertain"));
	assert.equal(writes(uncertain.calls).length, 1);
	const unreadable = setup([...reads(), json({}), json({}, 401)]);
	await assert.rejects(unreadable.run({ dryRun: false }), code("verification-unavailable"));
	assert.equal(writes(unreadable.calls).length, 1);
});

test("网络与可重试读取错误有界重试；429 遵守短 Retry-After", async () => {
	const h = setup([new Error(TOKEN), json({}, 503), json(ref(BEFORE)), json(ref(BEFORE))]);
	assert.equal((await h.run()).status, "up-to-date");
	assert.deepEqual(h.waits, [1000, 2000]);
	const throttled = setup([json({}, 429, { "Retry-After": "2" }), json(ref(BEFORE)), json(ref(BEFORE))]);
	assert.equal((await throttled.run()).status, "up-to-date");
	assert.deepEqual(throttled.waits, [2000]);
	const exhausted = setup([new Error(TOKEN), new Error(TOKEN), new Error(TOKEN)]);
	await assert.rejects(exhausted.run(), code("api-unreachable"));
	assert.equal(exhausted.calls.length, 3);
});

test("配额用尽或长 Retry-After 立即退出，无无限等待", async () => {
	const rate = setup([json({ message: TOKEN }, 403, { "X-RateLimit-Remaining": "0" })]);
	await assert.rejects(rate.run(), code("rate-limited"));
	assert.equal(rate.calls.length, 1);
	const long = setup([json({}, 429, { "Retry-After": "3600" })]);
	await assert.rejects(long.run(), code("rate-limited"));
	assert.equal(long.calls.length, 1);
	assert.equal(long.waits.length, 0);
});

test("外部错误正文、网络异常文本与非 JSON 响应不进入公开日志", async () => {
	for (const response of [json({ message: TOKEN }, 403), new Response(TOKEN, { status: 200 })]) {
		const h = setup([response]);
		let output;
		try { await h.run(); } catch (error) { output = JSON.stringify(safeFailure(error)) + formatSummary(safeFailure(error)); }
		assert.ok(!output.includes(TOKEN));
	}
	assert.ok(!JSON.stringify(safeFailure(new Error(TOKEN))).includes(TOKEN));
});

test("工作流已废弃定时触发：保留手动入口、default dry-run、固定仓库与 develop、最小权限", () => {
	const workflow = readFileSync(new URL("../.github/workflows/sync-upstream-main.yml", import.meta.url), "utf8");
	// fork 仓库不支持 scheduled workflow，已移除 schedule 触发器；只保留手动运行。
	assert.match(workflow, /^# 已废弃（2026-11-02）：本仓库是 fork，GitHub 不支持在 fork 仓库上按计划触发 scheduled workflow。/m);
	assert.match(workflow, /^on:\n  workflow_dispatch:/m);
	assert.doesNotMatch(workflow, /^\s{2}schedule:/m, "不应保留实际生效的 schedule 触发器");
	assert.match(workflow, /^#\s+schedule:$/m, "应保留恢复 schedule 的注释示例");
	assert.match(workflow, /type: boolean\s+default: true/);
	assert.match(workflow, /contents: write/);
	assert.match(workflow, /github\.repository == 'marktrue-ahu\/dsh-mobile-remote' && github\.ref == 'refs\/heads\/develop'/);
	assert.match(workflow, /persist-credentials: false/);
	assert.match(workflow, /timeout-minutes: 10/);
	assert.match(workflow, /cancel-in-progress: false/);
	assert.doesNotMatch(workflow, /pull_request|npm-publish|npm (install|publish)|id-token:|push:/);
});

test("primary/secondary 限流在 GET/PATCH 中一致分类，不短间隔反复打请求", async () => {
	for (const response of [
		json({}, 403, { "Retry-After": "120", "X-RateLimit-Remaining": "4990" }),
		json({ message: `You have exceeded a secondary rate limit. ${TOKEN}` }, 403),
		json({}, 429),
		json({}, 429, { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "9999999999" }),
	]) {
		const h = setup([response]);
		await assert.rejects(h.run(), code("rate-limited"));
		assert.equal(h.calls.length, 1);
		assert.equal(h.waits.length, 0);
	}
	for (const response of [
		json({}, 403, { "X-RateLimit-Remaining": "0" }),
		json({}, 403, { "Retry-After": "2" }),
		json({ message: "You have exceeded a secondary rate limit." }, 403),
		json({}, 429, { "Retry-After": "2" }),
	]) {
		const h = setup([...reads(), response]);
		await assert.rejects(h.run({ dryRun: false }), code("rate-limited"));
		assert.equal(writes(h.calls).length, 1);
		assert.equal(h.waits.length, 0);
	}
});

test("schedule 真实模式与 408/5xx 写后确认不重发", async () => {
	for (const status of [408, 500]) {
		const h = setup([...reads(), json({}, status), json(ref(UPSTREAM))]);
		const result = await h.run({ dryRun: false, context: { ...context, event: "schedule" } });
		assert.equal(result.status, "fast-forwarded");
		assert.equal(result.recovered, true);
		assert.equal(writes(h.calls).length, 1);
	}
});

test("真实 CLI 拒绝本地 apply/非法参数：退出码非零、stdout完整JSON、不输出token", () => {
	const script = new URL("../tools/sync-upstream-main.mjs", import.meta.url);
	const env = { ...process.env, GH_TOKEN: TOKEN };
	for (const key of ["GITHUB_ACTIONS", "GITHUB_REPOSITORY", "GITHUB_REF", "GITHUB_EVENT_NAME", "GITHUB_STEP_SUMMARY"]) delete env[key];
	for (const [args, reason] of [[["--apply"], "invalid-ci-context"], [["--force"], "invalid-arguments"]]) {
		const result = spawnSync(process.execPath, [script.pathname, ...args], { env, encoding: "utf8", timeout: 5000 });
		assert.equal(result.status, 1);
		assert.equal(result.error, undefined);
		const output = JSON.parse(result.stdout);
		assert.equal(output.reason, reason);
		assert.equal(output.status, "failed");
		assert.ok(!(result.stdout + result.stderr).includes(TOKEN));
	}
});

test("工作流分离读写 job：手动默认只读，不向预演发放 PAT，固定官方 Actions SHA", () => {
	const workflow = readFileSync(new URL("../.github/workflows/sync-upstream-main.yml", import.meta.url), "utf8");
	const guard = "github.repository == 'marktrue-ahu/dsh-mobile-remote' && github.ref == 'refs/heads/develop'";
	assert.ok(workflow.includes(`if: ${guard} && github.event_name == 'workflow_dispatch' && inputs.dry_run`));
	assert.ok(workflow.includes(`if: ${guard} && (github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && !inputs.dry_run))`));
	const preview = workflow.slice(workflow.indexOf("  preview:"), workflow.indexOf("  sync:"));
	const apply = workflow.slice(workflow.indexOf("  sync:"));
	assert.match(preview, /permissions:\s+contents: read/);
	assert.match(preview, /run: node tools\/sync-upstream-main\.mjs --dry-run/);
	assert.doesNotMatch(preview, /secrets\.|contents: write|--apply/);
	assert.match(apply, /permissions:\s+contents: write/);
	assert.match(apply, /secrets\.UPSTREAM_SYNC_TOKEN \|\| github\.token/);
	assert.match(apply, /run: node tools\/sync-upstream-main\.mjs --apply/);
	for (const line of workflow.split("\n").filter((line) => line.includes("uses:"))) {
		assert.match(line, /uses: actions\/(checkout|setup-node)@[a-f0-9]{40} # v6/);
	}
	// 与锁定的 if 表达式对应的布尔真值表；输入省略时 GitHub schema 默认 true。
	const selected = (event, dryRun = true) => {
		if (event === "workflow_dispatch" && dryRun) return "preview";
		if (event === "schedule" || (event === "workflow_dispatch" && !dryRun)) return "sync";
		return null;
	};
	assert.equal(selected("workflow_dispatch"), "preview");
	assert.equal(selected("workflow_dispatch", true), "preview");
	assert.equal(selected("workflow_dispatch", false), "sync");
	assert.equal(selected("schedule"), "sync");
	assert.equal(selected("push"), null);
});

function runMockCli(responses, mode = "--apply") {
	// 覆盖子进程全部 fetch；写请求也只消费内存队列，绝不访问真实远端。
	const preload = "data:text/javascript," + encodeURIComponent(`
		const queue = ${JSON.stringify(responses)};
		globalThis.fetch = async () => {
			if (!queue.length) throw new Error("unexpected mocked API request");
			const next = queue.shift();
			return new Response(JSON.stringify(next.body), {status: next.status ?? 200});
		};
	`);
	const env = {
		...process.env,
		GH_TOKEN: TOKEN,
		GITHUB_ACTIONS: "true",
		GITHUB_REPOSITORY: TARGET_REPOSITORY,
		GITHUB_REF: "refs/heads/develop",
		GITHUB_EVENT_NAME: "workflow_dispatch",
		// 现有目录无法作为 Summary 文件打开：稳定复现摘要写失败，不创建任何文件。
		GITHUB_STEP_SUMMARY: process.cwd(),
	};
	const child = spawnSync(process.execPath, ["--import", preload, fileURLToPath(new URL("../tools/sync-upstream-main.mjs", import.meta.url)), mode], {
		env, encoding: "utf8", timeout: 5000,
	});
	assert.equal(child.error, undefined);
	assert.ok(!(child.stdout + child.stderr).includes(TOKEN));
	return { ...child, result: JSON.parse(child.stdout) };
}

test("W2: Summary 写失败不改变已确认成功的同步/预演退出码", () => {
	for (const scenario of [
		{ status: "fast-forwarded", mode: "--apply", bodies: [ref(BEFORE), ref(UPSTREAM), comparison, {}, ref(UPSTREAM)] },
		{ status: "up-to-date", mode: "--apply", bodies: [ref(BEFORE), ref(BEFORE)] },
		{ status: "would-fast-forward", mode: "--dry-run", bodies: [ref(BEFORE), ref(UPSTREAM), comparison] },
	]) {
		const child = runMockCli(scenario.bodies.map((body) => ({ body })), scenario.mode);
		assert.equal(child.result.status, scenario.status);
		assert.equal(child.status, 0, "摘要写失败不能把成功同步误报为失败");
		assert.match(child.stderr, /::warning::.*Summary/);
	}
});

test("W2: 业务失败与 Summary 同时失败时，仍保留业务失败退出码", () => {
	const child = runMockCli([{ status: 401, body: { message: TOKEN } }]);
	assert.equal(child.status, 1);
	assert.equal(child.result.status, "failed");
	assert.equal(child.result.reason, "authentication-failed");
	assert.match(child.stderr, /::warning::.*Summary/);
});

test("W6: 读取早期失败保留固定仓库上下文与已取得的 SHA，不伪造未知 SHA", async () => {
	for (const [responses, knownSha] of [
		[[json({}, 401)], undefined],
		[[json(ref(BEFORE)), json({}, 401)], BEFORE],
	]) {
		const h = setup(responses);
		let failure;
		try { await h.run(); } catch (error) { failure = safeFailure(error); }
		assert.equal(failure.repository, TARGET_REPOSITORY);
		assert.equal(failure.upstream, UPSTREAM_REPOSITORY);
		assert.equal(failure.branch, "main");
		assert.equal(failure.dryRun, true);
		assert.equal(failure.beforeSha, knownSha);
		assert.equal(failure.upstreamSha, undefined);
		assert.equal(failure.compareUrl, undefined);
		assert.ok(formatSummary(failure).includes("未取得"));
		assert.equal(writes(h.calls).length, 0);
	}
});

test("W3: 真实入口 bash 校验：错误仓库/分支/事件明确失败，两个业务 job 依赖校验", () => {
	const workflow = readFileSync(new URL("../.github/workflows/sync-upstream-main.yml", import.meta.url), "utf8");
	assert.ok(workflow.includes("  validate:"), "必须有不靠 job.if 静默跳过的入口校验");
	const guard = workflow.slice(workflow.indexOf("  validate:"), workflow.indexOf("  preview:"));
	assert.match(guard, /permissions:\s+contents: read/);
	assert.doesNotMatch(guard, /secrets\.|GH_TOKEN|contents: write|uses:/);
	const marker = "        run: |\n";
	assert.ok(guard.includes(marker));
	const script = guard.slice(guard.indexOf(marker) + marker.length).split("\n").map((line) => line.startsWith("          ") ? line.slice(10) : line).join("\n");
	for (const scenario of [
		{ event: "schedule", ref: "refs/heads/develop", repo: TARGET_REPOSITORY, status: 0 },
		{ event: "workflow_dispatch", ref: "refs/heads/develop", repo: TARGET_REPOSITORY, status: 0 },
		{ event: "workflow_dispatch", ref: "refs/heads/main", repo: TARGET_REPOSITORY, status: 1 },
		{ event: "workflow_dispatch", ref: "refs/heads/feature/test", repo: TARGET_REPOSITORY, status: 1 },
		{ event: "workflow_dispatch", ref: "refs/heads/develop", repo: UPSTREAM_REPOSITORY, status: 1 },
		{ event: "pull_request", ref: "refs/heads/develop", repo: TARGET_REPOSITORY, status: 1 },
	]) {
		const child = spawnSync("bash", ["-c", script], {
			env: { PATH: process.env.PATH, GITHUB_EVENT_NAME: scenario.event, GITHUB_REF: scenario.ref, GITHUB_REPOSITORY: scenario.repo },
			encoding: "utf8", timeout: 3000,
		});
		assert.equal(child.error, undefined);
		assert.equal(child.status, scenario.status);
		if (scenario.status) assert.match(child.stdout + child.stderr, /::error::/);
	}
	const preview = workflow.slice(workflow.indexOf("  preview:"), workflow.indexOf("  sync:"));
	const apply = workflow.slice(workflow.indexOf("  sync:"));
	assert.match(preview, /needs: validate/);
	assert.match(apply, /needs: validate/);
});

test("W1: 写入 job 使用独立 upstream-sync environment，预演不需要部署授权", () => {
	const workflow = readFileSync(new URL("../.github/workflows/sync-upstream-main.yml", import.meta.url), "utf8");
	const preview = workflow.slice(workflow.indexOf("  preview:"), workflow.indexOf("  sync:"));
	const apply = workflow.slice(workflow.indexOf("  sync:"));
	assert.doesNotMatch(preview, /environment:/);
	assert.match(apply, /environment: upstream-sync/);
});

test("W6: 失败也保留写后观测到的非目标 SHA，不把观测值伪装成同步成功", async () => {
	for (const [patchResponse, reason] of [[json({}), "verification-mismatch"], [new Error("timeout"), "update-uncertain"]]) {
		const h = setup([...reads(), patchResponse, json(ref(OTHER))]);
		let failure;
		try { await h.run({ dryRun: false }); } catch (error) { failure = safeFailure(error); }
		assert.equal(failure.status, "failed");
		assert.equal(failure.reason, reason);
		assert.equal(failure.beforeSha, BEFORE);
		assert.equal(failure.upstreamSha, UPSTREAM);
		assert.equal(failure.afterSha, OTHER);
		assert.ok(formatSummary(failure).includes(OTHER));
		assert.equal(writes(h.calls).length, 1);
	}
});
