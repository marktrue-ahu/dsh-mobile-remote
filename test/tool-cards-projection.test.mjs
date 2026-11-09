/**
 * issue #54（M3 Batch 1）+ issue #66（M3 Batch 2-A）：工具卡结构化投影的单元测试。
 *
 * 覆盖：13 个工具的 `tool/call` summary 字段派生、路径 display（绝不下发绝对路径）、
 * write/edit 的 sizeKb/diff/added/deleted、`tool/result` 的 exitCode/signal/stopped/
 * resultCount（meta 与文本两种来源）、长输出/非法 JSON 的 fail-open、未知工具不投影；
 * issue #66 追加 todo_write（items/counts）、ask_user_question（questions/options/
 * multiSelect）、skill（name）与 ask_user_question 结果 answers 的回放/缺省。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	TOOL_CARD_DIFF_MAX_BYTES,
	TOOL_CARD_TOOLS,
	summarizeEvent,
	toolCallSummaryOf,
	toolCardsCapabilityOf,
	toolNamesOf,
	toolResultCallIdOf,
	toolResultSummaryOf,
} from "../lib/index.js";

const CWD = "/home/mark/proj";
const call = (name, args, cwd = CWD) =>
	summarizeEvent({ seq: 1, type: "tool/call", data: { turn: 1, step: 1, callId: "call-1", name, arguments: typeof args === "string" ? args : JSON.stringify(args) } }, { cwd });
const result = (name, text, meta) =>
	summarizeEvent({
		seq: 2,
		type: "tool/result",
		data: {
			...(name ? { name } : {}),
			message: { content: [{ type: "text", text }] },
			...(meta === undefined ? {} : { meta }),
		},
	});
const summaryOf = (event) => event.data?.summary;

test("能力位：声明本插件实际投影的 13 个工具（Batch 2-A 追加 3 个非文件工具）", () => {
	const caps = toolCardsCapabilityOf();
	assert.equal(caps.version, 1);
	assert.deepEqual(caps.tools, [...TOOL_CARD_TOOLS]);
	assert.deepEqual(TOOL_CARD_TOOLS, [
		"bash",
		"pwsh",
		"read",
		"write",
		"edit",
		"grep",
		"glob",
		"web_fetch",
		"web_search",
		"read_image",
		"todo_write",
		"ask_user_question",
		"skill",
	]);
});

test("command：bash/pwsh 的 command/workdir/background/description，换行压平并 clamp", () => {
	const bash = summaryOf(call("bash", { command: "ls\n-la", workdir: "/home/mark/proj/src", run_in_background: true, description: "List\nfiles" }));
	assert.deepEqual(bash, { kind: "command", tool: "bash", command: "ls -la", workdir: "src", background: true, description: "List files" });
	const pwsh = summaryOf(call("pwsh", { command: "Get-ChildItem" }, "C:\\work"));
	assert.equal(pwsh.kind, "command");
	assert.equal(pwsh.command, "Get-ChildItem");
});

test("file/read：filePath display + 正整数 offset/limit（非法忽略）", () => {
	const read = summaryOf(call("read", { file_path: "/home/mark/proj/src/a.ts", offset: 2, limit: 40 }));
	assert.deepEqual(read, { kind: "file", tool: "read", filePath: "src/a.ts", offset: 2, limit: 40 });
	const invalid = summaryOf(call("read", { file_path: "/home/mark/proj/src/a.ts", offset: 0, limit: -3 }));
	assert.equal(invalid.offset, undefined);
	assert.equal(invalid.limit, undefined);
});

test("file/write：sizeKb 按 UTF-16 长度、diff 为全新增统一 diff", () => {
	const content = "第一行\nsecond line\n";
	const write = summaryOf(call("write", { file_path: "src/new.ts", content }));
	assert.equal(write.kind, "file");
	assert.equal(write.filePath, "src/new.ts");
	assert.equal(write.sizeKb, Math.ceil(content.length / 1024));
	assert.equal(write.diff, "--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,2 @@\n+第一行\n+second line\n");
	// 路径必须已派生：summary 里任何字段都不能含主机绝对路径。
	assert.ok(!JSON.stringify(write).includes("/home/mark/proj"));
});

test("file/edit：sizeKb、added/deleted 按行近似、统一 diff", () => {
	const edit = summaryOf(call("edit", { file_path: "src/a.ts", old_string: "a\nb", new_string: "c" }));
	assert.equal(edit.kind, "file");
	assert.equal(edit.filePath, "src/a.ts");
	assert.equal(edit.sizeKb, Math.ceil(("a\nb".length + "c".length) / 1024));
	assert.equal(edit.added, 1);
	assert.equal(edit.deleted, 2);
	assert.equal(edit.diff, "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,1 @@\n-a\n-b\n+c\n");
});

test("write/edit：diff 超过 8 KiB 时缺省并标 diffTruncated", () => {
	const huge = `${"x".repeat(TOOL_CARD_DIFF_MAX_BYTES)}\n`;
	const write = summaryOf(call("write", { file_path: "big.txt", content: huge }));
	assert.equal(write.diff, undefined);
	assert.equal(write.diffTruncated, true);
	const edit = summaryOf(call("edit", { file_path: "big.txt", old_string: huge, new_string: "" }));
	assert.equal(edit.diff, undefined);
	assert.equal(edit.diffTruncated, true);
});

test("search：grep/glob 的 pattern/path/include（clean 参数）", () => {
	const grep = summaryOf(call("grep", { pattern: "foo\nbar", path: "/home/mark/proj/lib", include: "*.ts" }));
	assert.deepEqual(grep, { kind: "search", tool: "grep", pattern: "foo bar", path: "lib", include: "*.ts" });
	const glob = summaryOf(call("glob", { pattern: "**/*.dart", path: "/home/mark/proj/lib" }));
	assert.deepEqual(glob, { kind: "search", tool: "glob", pattern: "**/*.dart", path: "lib" });
	assert.equal(glob.include, undefined);
});

test("web / image：url、query、filePath", () => {
	assert.deepEqual(
		summaryOf(call("web_fetch", { url: "https://example.test/a?b=1" })),
		{ kind: "web", tool: "web_fetch", url: "https://example.test/a?b=1" },
	);
	assert.deepEqual(
		summaryOf(call("web_search", { queries: ["q1", "q2"] })),
		{ kind: "web", tool: "web_search", query: "q1" },
	);
	assert.deepEqual(
		summaryOf(call("read_image", { file_path: "/home/mark/proj/assets/p.png" })),
		{ kind: "image", tool: "read_image", filePath: "assets/p.png" },
	);
});

test("fail-open：非法 JSON / 未知工具 / 非对象参数不抛错且降级", () => {
	assert.deepEqual(summaryOf(call("bash", "{not json")), { kind: "command", tool: "bash" });
	assert.equal(summaryOf(call("mystery", "{}")), undefined);
	assert.equal(toolCallSummaryOf("bash", undefined, CWD)?.kind, "command");
	assert.equal(toolCallSummaryOf(undefined, "{}", CWD), undefined);
});

test("超长参数被 clamp，不影响摘要生成", () => {
	const long = "x".repeat(5000);
	const bash = summaryOf(call("bash", { command: long, description: long }));
	// clampText 把「截断后缀」计入上限：结果长度恰好等于上限。
	assert.equal(bash.command.length, 200);
	assert.equal(bash.description.length, 120);
	const pattern = summaryOf(call("grep", { pattern: long }));
	assert.equal(pattern.pattern.length, 200);
});

test("result：bash/pwsh 从原始文本末尾解析 exitCode/signal/stopped（不受 2000 字 clamp 影响）", () => {
	const longText = `${"x".repeat(3000)}\n[exit code: 7]`;
	const exit = summaryOf(result("bash", longText));
	assert.equal(exit.exitCode, 7);
	assert.equal(result("pwsh", "[killed by signal: SIGTERM]").data.summary.signal, "SIGTERM");
	assert.equal(result("bash", "[stopped: user cancelled]").data.summary.stopped, "user cancelled");
	// 结果事件不带工具名时不得从内容猜（R14）；由调用方通过 callId→name 关联后传入。
	assert.equal(summaryOf(result(undefined, "boom\n[exit code: 2]")), undefined);
	// 非命令工具文本里的普通数字不会被误判成退出码。
	assert.equal(summaryOf(result("read", "[exit code: 3]")), undefined);
});

test("R13：只解析结果末尾的宿主终止 trailer（最后一条），不取 stdout 正文中的首个标记", () => {
	// 真实命令：stdout 打印 expected marker [exit code: 0]，实际退出 7，宿主在末尾追加 7。
	const misleading = summaryOf(result("bash", "expected marker: [exit code: 0]\nboom\n[exit code: 7]"));
	assert.equal(misleading.exitCode, 7, "必须使用末尾真实终止状态，而不是 stdout 首个匹配");
	// 反向：末尾 0 覆盖正文里的非零假标记。
	const recovered = summaryOf(result("bash", "failed: [exit code: 5]\nrecovered\n[exit code: 0]"));
	assert.equal(recovered.exitCode, 0);
	// 标记不在末尾（命令仍在输出/被截断）→ 不猜，缺省。
	assert.equal(summaryOf(result("bash", "still running [exit code: 7]\nmore output")), undefined);
	// 多种终止标记互斥：最后一条是 signal 时不再给 exit/stopped。
	const precedence = summaryOf(result("bash", "[stopped: cancelled]\n[killed by signal: SIGTERM]"));
	assert.equal(precedence.signal, "SIGTERM");
	assert.equal(precedence.exitCode, undefined);
	assert.equal(precedence.stopped, undefined);
});

test("R14：无工具名/非命令工具不得从内容猜终止状态；callId→name 关联后才可用", () => {
	// 非命令工具成功结果里正文含 marker：不得下发 exit/signal。
	assert.equal(summaryOf(result("read", "内容 [exit code: 3]")), undefined);
	assert.equal(summaryOf(result("grep", "x\n[exit code: 3]")), undefined);
	// 无名字的结果事件：纯函数不猜；调用方按 callId→tool/call.name 解析后传入才允许。
	assert.equal(summaryOf(result(undefined, "x\n[exit code: 3]")), undefined);
	const resolved = summarizeEvent(
		{ seq: 9, type: "tool/result", data: { callId: "call-x", message: { content: [{ type: "text", text: "x\n[exit code: 3]" }] } } },
		{ resolvedToolName: "bash" },
	);
	assert.equal(resolved.data?.summary?.exitCode, 3);
	// 结果事件无 name 但会话里有同名 tool/call：/history 用 toolNamesOf 关联。
	assert.deepEqual([...toolNamesOf([
		{ type: "tool/call", data: { callId: "c1", name: "bash" } },
		{ type: "tool/call", data: { callId: "c2", name: "read" } },
	]).entries()], [["c1", "bash"], ["c2", "read"]]);
});

test("result：grep/glob 匹配总数优先取 meta.total，缺失时按文本解析，解析不到缺省", () => {
	assert.equal(summaryOf(result("grep", "Found 3 of 9 matches", { shape: "matches", total: 9 })).resultCount, 9);
	assert.equal(summaryOf(result("grep", "Found 3 matches")).resultCount, 3);
	assert.equal(summaryOf(result("grep", "No matches found")).resultCount, 0);
	assert.equal(summaryOf(result("glob", "(Showing 20 of 87 paths...")).resultCount, 87);
	assert.equal(summaryOf(result("glob", "a.ts\nb.ts\nc.ts")).resultCount, 3);
	assert.equal(summaryOf(result("glob", "No files found")).resultCount, 0);
	assert.equal(summaryOf(result(undefined, "garbage text")), undefined);
	assert.equal(summaryOf(result("read", "Found 3 matches")), undefined);
});

test("result：meta 形状可识别搜索工具（结果事件无名字时）", () => {
	assert.equal(summaryOf(result(undefined, "", { shape: "paths", total: 12 })).resultCount, 12);
});

test("recheck-4：真实 tool/result 形状（message.source.callId / content[].toolCallId）恢复命令状态", () => {
	// 当前 DSH 的真实形状：event.data 没有 callId；callId 在 message.source.callId、
	// message.toolCallId 与 content[].toolCallId。
	const event = {
		seq: 77,
		type: "tool/result",
		data: {
			turn: 1,
			step: 1,
			message: {
				role: "tool",
				toolCallId: "call-real",
				source: { kind: "tool", callId: "call-real" },
				content: [{
					type: "tool-result",
					toolCallId: "call-real",
					content: [{ type: "text", text: "boom\n[exit code: 7]" }],
				}],
			},
		},
	};
	assert.equal(toolResultCallIdOf(event), "call-real");
	const summarized = summarizeEvent(event, { resolvedToolName: "bash" });
	assert.equal(summarized.data?.callId, "call-real");
	assert.equal(summarized.data?.summary?.exitCode, 7, "真实形状必须能恢复 exitCode，否则命令状态丢失");
	// history/SSE 用同一坐标做 callId→name 关联。
	const names = toolNamesOf([{ type: "tool/call", data: { callId: "call-real", name: "bash" } }]);
	assert.equal(names.get(toolResultCallIdOf(event)), "bash");
});

// ---------------------------------------------------------------------------
// issue #66（M3 Batch 2-A）：todo_write / ask_user_question / skill 结构化投影。
// 契约：/tmp/issue66-contract.md §1.2（tool/call）、§1.3（tool/result）、§1.4（测试覆盖）。
// ---------------------------------------------------------------------------

test("issue66 todo：items 单行化 + 非法 status 归 pending，counts 恒三键且和 = items.length", () => {
	const summary = summaryOf(call("todo_write", {
		todos: [
			{ content: "写测试\n并跑通", status: "completed" },
			{ content: "修复 bug", status: "in_progress" },
			{ content: "未知状态", status: "done" },
			{ content: "缺状态" },
		],
	}));
	assert.equal(summary.kind, "todo");
	assert.equal(summary.tool, "todo_write");
	assert.deepEqual(summary.items, [
		{ content: "写测试 并跑通", status: "completed" },
		{ content: "修复 bug", status: "in_progress" },
		{ content: "未知状态", status: "pending" },
		{ content: "缺状态", status: "pending" },
	]);
	assert.deepEqual(summary.counts, { pending: 2, inProgress: 1, completed: 1 });
	assert.equal(summary.counts.pending + summary.counts.inProgress + summary.counts.completed, summary.items.length);
});

test("issue66 todo：≤50 项截断、content clamp 200、空数组合法、非数组/非法 JSON fail-open", () => {
	const many = Array.from({ length: 60 }, (_, i) => ({ content: `task ${i}`, status: "pending" }));
	const truncated = summaryOf(call("todo_write", { todos: many }));
	assert.equal(truncated.items.length, 50);
	assert.equal(truncated.items[0].content, "task 0");
	assert.equal(truncated.items[49].content, "task 49");
	assert.deepEqual(truncated.counts, { pending: 50, inProgress: 0, completed: 0 });

	const longContent = summaryOf(call("todo_write", { todos: [{ content: "x".repeat(5000), status: "completed" }] }));
	assert.equal(longContent.items[0].content.length, 200, "clampText 的截断后缀计入上限");

	// 空快照是合法的可渲染值（App 显示 0 项），不是 fail-open。
	assert.deepEqual(summaryOf(call("todo_write", { todos: [] })), {
		kind: "todo",
		tool: "todo_write",
		items: [],
		counts: { pending: 0, inProgress: 0, completed: 0 },
	});
	// 非数组/非法 JSON：不猜，只回 kind/tool（App 回退通用卡）。
	assert.deepEqual(summaryOf(call("todo_write", { todos: "nope" })), { kind: "todo", tool: "todo_write" });
	assert.deepEqual(summaryOf(call("todo_write", { todos: null })), { kind: "todo", tool: "todo_write" });
	assert.deepEqual(summaryOf(call("todo_write", "{not json")), { kind: "todo", tool: "todo_write" });
});

test("issue66 todo：跳过非法元素（非对象/content 非 string），counts 只统计保留项", () => {
	// R2（评审）：与 App 逐项降级口径一致——App 会丢弃这些元素，服务端也必须丢弃，
	// 否则折叠行「N 项任务」与展开清单的项数/完成数会对不上。
	const summary = summaryOf(call("todo_write", {
		todos: [42, "x", { content: "ok", status: "completed" }, { content: 7 }],
	}));
	assert.equal(summary.items.length, 1);
	assert.deepEqual(summary.items, [{ content: "ok", status: "completed" }]);
	assert.deepEqual(summary.counts, { pending: 0, inProgress: 0, completed: 1 });
});

test("issue66 todo valid-first：3 个无效项在前，仍保留前 50 个合法项（无效项不占配额）", () => {
	// W-2（评审）：必须先过滤无效项、再按 ≤50 上限截断；无效项不得挤占配额或造成错位。
	const invalid = [42, "x", { content: 7 }];
	const valid = Array.from({ length: 60 }, (_, i) => ({ content: `v${i}`, status: "pending" }));
	const summary = summaryOf(call("todo_write", { todos: [...invalid, ...valid] }));
	assert.equal(summary.items.length, 50);
	assert.deepEqual(
		summary.items.map((item) => item.content),
		Array.from({ length: 50 }, (_, i) => `v${i}`),
		"保留的应是连续的 v0..v49，而不是被无效项挤掉/错位",
	);
	assert.deepEqual(summary.counts, { pending: 50, inProgress: 0, completed: 0 });
});

test("issue66 question：字段映射、id 保留、header/options/multiSelect 按需下发", () => {
	const summary = summaryOf(call("ask_user_question", {
		questions: [
			{
				id: "q1",
				header: "确认\n模式",
				question: "选择哪个模式？\n并说明原因",
				options: [
					{ label: "A\n（推荐）", description: "快速" },
					{ label: "B" },
					{ label: "", description: "无 label 丢弃" },
				],
				multi_select: true,
			},
			{ header: "缺 question 整题丢弃", question: "   " },
			{ id: "   ", question: "没有有效 id 也保留" },
		],
	}));
	assert.equal(summary.kind, "question");
	assert.equal(summary.tool, "ask_user_question");
	assert.deepEqual(summary.questions, [
		{
			id: "q1",
			question: "选择哪个模式？ 并说明原因",
			header: "确认 模式",
			options: [{ label: "A （推荐）", description: "快速" }, { label: "B" }],
			multiSelect: true,
		},
		{ question: "没有有效 id 也保留" },
	]);
});

test("issue66 question：raw id 原样保留（仅 trim 判空，不做 trim/单行化）", () => {
	// I-1（评审）：id 是 App 关联待答的唯一依据，且要与 attention 帧里的宿主原始 id 精确匹配，
	// 因此服务端不能用 trim/单行化改写值（只有纯空白判无效丢弃）。
	const summary = summaryOf(call("ask_user_question", {
		questions: [
			{ id: " q0 ", question: "raw id" },
			{ id: "   ", question: "whitespace-only id" },
			{ id: 7, question: "non-string id" },
		],
	}));
	assert.equal(summary.questions.length, 3);
	assert.equal(summary.questions[0].id, " q0 ", "raw id 必须原样保留（不 trim）");
	assert.equal("id" in summary.questions[1], false, "纯空白 id 不下发");
	assert.equal("id" in summary.questions[2], false, "非 string id 不下发");
});

test("issue66 question：multi_select 与 multiSelect 两种形状都接受，只有 true 才下发", () => {
	const snakeCase = summaryOf(call("ask_user_question", { questions: [{ id: "q1", question: "x", multi_select: true }] }));
	assert.equal(snakeCase.questions[0].multiSelect, true);
	const camelCase = summaryOf(call("ask_user_question", { questions: [{ id: "q2", question: "y", multiSelect: true }] }));
	assert.equal(camelCase.questions[0].multiSelect, true);
	// 契约是严格 `=== true`：false/字符串 "true"/1 都不下发（默认 false）。
	for (const value of [false, "true", 1]) {
		const question = summaryOf(call("ask_user_question", { questions: [{ id: "q3", question: "z", multi_select: value }] })).questions[0];
		assert.equal(question.multiSelect, undefined, `multi_select=${JSON.stringify(value)} 不得下发 multiSelect`);
	}
	const absent = summaryOf(call("ask_user_question", { questions: [{ id: "q4", question: "w" }] })).questions[0];
	assert.equal(absent.multiSelect, undefined);
});

test("issue66 question：≤10 题 / ≤20 选项截断，无效题与无效 option 逐项丢弃", () => {
	const capped = summaryOf(call("ask_user_question", {
		questions: Array.from({ length: 12 }, (_, i) => ({ id: `q${i}`, question: `question ${i}` })),
	}));
	assert.equal(capped.questions.length, 10);
	assert.equal(capped.questions[0].id, "q0");
	assert.equal(capped.questions[9].id, "q9");

	const cappedOptions = summaryOf(call("ask_user_question", {
		questions: [{ question: "pick", options: Array.from({ length: 25 }, (_, i) => ({ label: `option ${i}` })) }],
	}));
	assert.equal(cappedOptions.questions[0].options.length, 20);
	assert.equal(cappedOptions.questions[0].options[19].label, "option 19");

	// 无效题（缺/非字符串/空白 question）整题丢弃；无效 option（缺/非字符串 label）逐项丢弃。
	const dropped = summaryOf(call("ask_user_question", {
		questions: [
			null,
			"not-object",
			{ id: "q-missing", header: "缺 question" },
			{ id: "q-nonstring", question: 42 },
			{ id: "q-blank", question: "  \n " },
			{ id: "q-ok", question: "有效题", options: [null, "x", { label: 7 }, { label: "valid" }] },
			{ id: "q-no-options", question: "无有效选项", options: [{ description: "only desc" }] },
		],
	}));
	assert.deepEqual(dropped.questions, [
		{ id: "q-ok", question: "有效题", options: [{ label: "valid" }] },
		{ id: "q-no-options", question: "无有效选项" },
	]);
});

test("issue66 question valid-first：3 个无效题在前，仍保留前 10 个合法题（无效项不占配额）", () => {
	// W-2（评审）：先过滤无效题、再按 ≤10 上限截断；无效题不得挤占配额或造成错位。
	const invalid = [{ id: "bad0" }, { id: "bad1", question: 42 }, { id: "bad2", question: "  " }];
	const valid = Array.from({ length: 12 }, (_, i) => ({ id: `q${i + 3}`, question: `question ${i + 3}` }));
	const summary = summaryOf(call("ask_user_question", { questions: [...invalid, ...valid] }));
	assert.equal(summary.questions.length, 10);
	assert.deepEqual(
		summary.questions.map((question) => question.id),
		Array.from({ length: 10 }, (_, i) => `q${i + 3}`),
		"首个保留题应是第 4 个输入（q3），连续 q3..q12",
	);
});

test("issue66 question options valid-first：3 个无 label 项在前，仍保留前 20 个合法 option（无效项不占配额）", () => {
	// W-2（评审）：无效 option 必须在截断前丢弃；否则前 3 个无效项会挤掉 o3..o5 并错位。
	const invalid = [{ description: "no label" }, { label: "" }, { label: 7 }];
	const valid = Array.from({ length: 25 }, (_, i) => ({ label: `o${i + 3}` }));
	const summary = summaryOf(call("ask_user_question", {
		questions: [{ id: "q1", question: "pick", options: [...invalid, ...valid] }],
	}));
	assert.equal(summary.questions[0].options.length, 20);
	assert.deepEqual(
		summary.questions[0].options.map((option) => option.label),
		Array.from({ length: 20 }, (_, i) => `o${i + 3}`),
		"首个保留 label 应是第 4 个输入（o3），连续 o3..o22",
	);
});

test("issue66 question：header ≤80 / question ≤300 / label ≤120 / description ≤200 截断（后缀计入上限）", () => {
	const long = "x".repeat(5000);
	const summary = summaryOf(call("ask_user_question", {
		questions: [{
			id: "y".repeat(5000),
			header: long,
			question: long,
			options: [{ label: long, description: long }],
		}],
	}));
	const question = summary.questions[0];
	assert.equal(question.id.length, 120);
	assert.equal(question.header.length, 80);
	assert.equal(question.question.length, 300);
	assert.equal(question.options[0].label.length, 120);
	assert.equal(question.options[0].description.length, 200);
});

test("issue66 question：questions 非数组/空数组/全无效/非法 JSON → 只回 {kind,tool}", () => {
	const minimal = { kind: "question", tool: "ask_user_question" };
	assert.deepEqual(summaryOf(call("ask_user_question", { questions: "nope" })), minimal);
	assert.deepEqual(summaryOf(call("ask_user_question", { questions: {} })), minimal);
	assert.deepEqual(summaryOf(call("ask_user_question", { questions: [] })), minimal);
	assert.deepEqual(summaryOf(call("ask_user_question", { questions: [{ header: "只有 header" }, { question: "" }] })), minimal);
	assert.deepEqual(summaryOf(call("ask_user_question", "{not json")), minimal);
});

test("issue66 skill：name clamp 120，空/缺 name 不可渲染，不泄露 resourceBase/provider", () => {
	assert.deepEqual(summaryOf(call("skill", { name: "guizang-ppt-skill" })), { kind: "skill", tool: "skill", name: "guizang-ppt-skill" });
	assert.equal(summaryOf(call("skill", { name: "n".repeat(5000) })).name.length, 120);

	const minimal = { kind: "skill", tool: "skill" };
	assert.deepEqual(summaryOf(call("skill", { name: "  " })), minimal);
	assert.deepEqual(summaryOf(call("skill", {})), minimal);
	assert.deepEqual(summaryOf(call("skill", "{not json")), minimal);

	// 结果 value 里的 provider/resourceBase/content 一律不下发：summary 只带 name。
	const leak = summaryOf(call("skill", {
		name: "demo",
		provider: "builtin",
		resourceBase: { kind: "directory", path: `${CWD}/.skills/demo` },
		content: "SECRET",
	}));
	assert.deepEqual(leak, { kind: "skill", tool: "skill", name: "demo" });
});

test("issue66 result answers：selected + custom 合并回放，空 selected 保留为空 values", () => {
	const summary = summaryOf(result("ask_user_question", JSON.stringify({
		answers: [
			{ id: "q1", selected: ["选项A", "选项B"], custom: "自定义答案" },
			{ id: "q2", selected: [] },
			{ id: "q3", selected: ["仅选项"] },
		],
	})));
	assert.deepEqual(summary.answers, [
		{ questionId: "q1", values: ["选项A", "选项B", "自定义答案"] },
		{ questionId: "q2", values: [] },
		{ questionId: "q3", values: ["仅选项"] },
	]);
});

test("issue66 result answers：边界形状——缺 selected / selected 非数组 / selected 混合类型", () => {
	// I-2（评审）：values 恒为 string 数组；selected 缺失或非数组 → []（不是缺省整个 answer），
	// selected 里的非字符串项逐项丢弃。App 依赖空数组区分「显式跳过」与「无答案记录」。
	const summary = summaryOf(result("ask_user_question", JSON.stringify({
		answers: [
			{ id: "q1" },
			{ id: "q2", selected: "x" },
			{ id: "q3", selected: ["a", 7, "b"] },
		],
	})));
	assert.deepEqual(summary.answers, [
		{ questionId: "q1", values: [] },
		{ questionId: "q2", values: [] },
		{ questionId: "q3", values: ["a", "b"] },
	]);
});

test("issue66 result answers：无效项/形状不符/pending/坏 JSON/非本工具 → 缺省", () => {
	// 缺/空 id 的 answer 项逐项丢弃；全部无效 → 缺省。
	assert.equal(summaryOf(result("ask_user_question", JSON.stringify({ answers: [{ selected: ["A"] }, { id: "  ", selected: ["B"] }, null, "x"] }))), undefined);
	// answers 非数组 / 顶层非对象 / 空数组 → 缺省。
	assert.equal(summaryOf(result("ask_user_question", JSON.stringify({ answers: {} }))), undefined);
	assert.equal(summaryOf(result("ask_user_question", "[]")), undefined);
	assert.equal(summaryOf(result("ask_user_question", JSON.stringify({ answers: [] }))), undefined);
	// pending 结果（超时未答）没有 answers → 缺省，不得当已答回放。
	assert.equal(summaryOf(result("ask_user_question", JSON.stringify({ pending: true, callId: "call-1", message: "timeout" }))), undefined);
	// 非 JSON / 空文本 → 缺省。
	assert.equal(summaryOf(result("ask_user_question", "not json")), undefined);
	assert.equal(summaryOf(result("ask_user_question", "")), undefined);
	// selected 里的非字符串项逐项丢弃；空白 custom 不追加。
	const filtered = summaryOf(result("ask_user_question", JSON.stringify({ answers: [{ id: "q1", selected: ["A", 7, null, { x: 1 }], custom: "  " }] })));
	assert.deepEqual(filtered.answers, [{ questionId: "q1", values: ["A"] }]);
	// 不是 ask_user_question：即使文本像 answers 也不解析（todo_write/skill 无新增结果字段）。
	const answerJson = JSON.stringify({ answers: [{ id: "q1", selected: ["A"] }] });
	assert.equal(summaryOf(result("todo_write", answerJson)), undefined);
	assert.equal(summaryOf(result("skill", answerJson)), undefined);
	assert.equal(summaryOf(result("bash", answerJson)), undefined);
	// 对照：本工具名字直接给出时正常回放（无名字不猜的对照见下一测试）。
	assert.deepEqual(summaryOf(result("ask_user_question", answerJson)), { answers: [{ questionId: "q1", values: ["A"] }] });
});

test("issue66 result answers：只认调用方解析出的 ask_user_question 名字（无名字不猜）", () => {
	const answerJson = JSON.stringify({ answers: [{ id: "q1", selected: ["A"] }] });
	const rawEvent = { seq: 9, type: "tool/result", data: { callId: "call-q", message: { content: [{ type: "text", text: answerJson }] } } };
	// 结果事件本身没有工具名：纯解析不得猜。
	assert.equal(summaryOf(summarizeEvent(rawEvent)), undefined);
	// 调用方按 callId→tool/call.name 解析后传入，才回放 answers。
	const resolved = summarizeEvent(rawEvent, { resolvedToolName: "ask_user_question" });
	assert.deepEqual(resolved.data?.summary?.answers, [{ questionId: "q1", values: ["A"] }]);
});

test("issue66 result answers：answers ≤10 / values ≤20，questionId clamp 120、值 clamp 200", () => {
	const many = Array.from({ length: 12 }, (_, i) => ({ id: `q${i}`, selected: ["A"] }));
	assert.equal(summaryOf(result("ask_user_question", JSON.stringify({ answers: many }))).answers.length, 10);

	const manyValues = Array.from({ length: 25 }, (_, i) => `v${i}`);
	const capped = summaryOf(result("ask_user_question", JSON.stringify({ answers: [{ id: "q1", selected: manyValues, custom: "自定义" }] })));
	assert.equal(capped.answers[0].values.length, 20);
	assert.equal(capped.answers[0].values[19], "v19");

	const long = "x".repeat(5000);
	const clamped = summaryOf(result("ask_user_question", JSON.stringify({ answers: [{ id: "y".repeat(5000), selected: [long], custom: long }] })));
	assert.equal(clamped.answers[0].questionId.length, 120);
	assert.equal(clamped.answers[0].values[0].length, 200);
	assert.equal(clamped.answers[0].values[1].length, 200);
});

test("issue66：三工具 summary 序列化后不含 CWD/主机绝对路径", () => {
	const summaries = [
		summaryOf(call("todo_write", { todos: [{ content: "run tests", status: "pending" }] })),
		summaryOf(call("ask_user_question", {
			questions: [{ id: "q1", header: "Confirm", question: "Proceed?", options: [{ label: "Yes", description: "go on" }] }],
		})),
		summaryOf(call("skill", {
			name: "guizang-ppt-skill",
			provider: "builtin",
			resourceBase: { kind: "directory", path: `${CWD}/.skills` },
		})),
	];
	for (const summary of summaries) {
		assert.ok(!JSON.stringify(summary).includes(CWD), `summary 不得泄露 CWD: ${JSON.stringify(summary)}`);
	}
	const answers = summaryOf(result("ask_user_question", JSON.stringify({ answers: [{ id: "q1", selected: ["A"] }] })));
	assert.ok(!JSON.stringify(answers).includes(CWD));
});
