// 真实模型回归：只操作脚本创建的临时会话，HTTP 200 不作为完成依据。
import assert from "node:assert/strict";
import { mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const token = process.env.DSH_MOBILE_TOKEN;
assert.ok(token, "DSH_MOBILE_TOKEN is required");
const base = process.env.DSH_MOBILE_BASE ?? "http://127.0.0.1:3080/m";
const headers = { "x-mobile-token": token, "content-type": "application/json" };
async function api(path, body) {
	const response = await fetch(`${base}/api${path}`, {
		method: body === undefined ? "GET" : "POST", headers,
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: AbortSignal.timeout(15000),
	});
	assert.equal(response.status, 200, `${path.split("?")[0]} HTTP ${response.status}`);
	return response.json();
}

const cwd = await mkdtemp(join(tmpdir(), "dsh-first-reply-"));
let sessionId;
let completed = false;
try {
	const created = await api("/sessions", { cwd });
	sessionId = created.sessionId;
	assert.ok(sessionId, "create must return a session");
	await api("/send", { sessionId, requestId: randomUUID(), text: "Reply with OK only. Do not use tools." });
	const deadline = Date.now() + 60000;
	while (Date.now() < deadline) {
		const history = await api(`/history?sessionId=${encodeURIComponent(sessionId)}`);
		const events = history.events ?? [];
		const end = events.find((event) => event.type === "turn/end");
		if (end) {
			const reason = end.data?.reason;
			assert.ok(!reason?.error?.message?.includes("reading 'length'"), "首轮复现：Cannot read properties of undefined (reading 'length')");
			assert.equal(reason?.kind, "completed", "首轮必须正常结束");
			assert.ok(events.some((event) => event.type === "assistant/message" && event.data?.text?.trim()), "必须收到非空模型回复");
			completed = true;
			console.log("RC1 first reply passed: create → send → assistant/message → completed");
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	assert.ok(completed, "60 秒内没有收到完整首轮回复");
} finally {
	if (sessionId) {
		if (!completed) await api("/sessions/stop", { sessionId }).catch(() => console.error("测试会话停止失败"));
		await api("/sessions/archive", { sessionId }).catch(() => console.error("测试会话归档失败"));
	}
	// 只删除空目录；若意外生成文件则保留，避免递归清理。
	await rmdir(cwd).catch(() => {});
}
