// 新建会话缺省模型兜底验证（v3.1.0 修复验收）：
// 不带 model 创建会话 → 发一条极短消息 → 断言收到 assistant 回复且 turn/end 无 {{model}} 组装错误 → 归档。
// 用法：DSH_MOBILE_TOKEN=xxx node tools/verify-no-model-session.mjs [base]
const T = process.env.DSH_MOBILE_TOKEN;
const base = process.env.DSH_MOBILE_BASE ?? "http://127.0.0.1:3080/m";
if (!T) {
  console.error("缺少 DSH_MOBILE_TOKEN 环境变量");
  process.exit(2);
}
const H = { "content-type": "application/json", "x-mobile-token": T };
const j = async (path, opt) => {
  const r = await fetch(base + path, { ...opt, headers: { ...H, ...(opt?.headers ?? {}) } });
  const b = await r.json().catch(() => null);
  return { status: r.status, body: b };
};

// 1) 创建（不带 model / provider / reasoningEffort——崩溃复现路径）
const created = await j("/api/sessions", { method: "POST", body: JSON.stringify({ preset: "standard", cwd: "F:/dsh-outpost" }) });
if (created.status !== 200 || !created.body?.sessionId) {
  console.error(`FAIL: 创建会话失败 ${created.status} ${JSON.stringify(created.body)}`);
  process.exit(1);
}
const sid = created.body.sessionId;
console.log("创建会话（无 model）=>", sid);

// 2) 发消息
const sent = await j("/api/send", { method: "POST", body: JSON.stringify({ sessionId: sid, text: "Reply with exactly: OK" }) });
if (sent.status !== 200) {
  console.error(`FAIL: send ${sent.status} ${JSON.stringify(sent.body)}`);
  process.exit(1);
}

// 3) 轮询历史：等 assistant 回复或 turn 出错
const deadline = Date.now() + 90000;
let assistant = null;
let turnErr = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 4000));
  const hist = await j(`/api/history?sessionId=${sid}&after=0&limit=100`);
  for (const e of hist.body?.events ?? []) {
    if (e.type === "assistant/message" && !assistant) assistant = e;
    if (e.type === "turn/end" && typeof e.data?.reason === "object" && e.data?.reason?.kind === "error") turnErr = e.data.reason.error;
  }
  if (assistant || turnErr) break;
}
if (turnErr) {
  console.error(`FAIL: turn 出错 ${JSON.stringify(turnErr)}`);
  await j(`/api/sessions/archive`, { method: "POST", body: JSON.stringify({ sessionId: sid }) }).catch(() => {});
  process.exit(1);
}
if (!assistant) {
  console.error("FAIL: 超时未收到 assistant 回复");
  await j(`/api/sessions/archive`, { method: "POST", body: JSON.stringify({ sessionId: sid }) }).catch(() => {});
  process.exit(1);
}
console.log("PASS: 无 model 新会话可正常回复 =>", assistant.data?.text?.slice(0, 40));
await j(`/api/sessions/archive`, { method: "POST", body: JSON.stringify({ sessionId: sid }) }).catch(() => {});
console.log("PASS: 已归档测试会话");

// 场景 B（P1-2 回归）：仅传 reasoningEffort、不传 model——同样必须绑定默认模型并正常回复
const created2 = await j("/api/sessions", { method: "POST", body: JSON.stringify({ preset: "standard", cwd: "F:/dsh-outpost", reasoningEffort: "low" }) });
if (created2.status !== 200 || !created2.body?.sessionId) {
  console.error(`FAIL(B): 创建会话失败 ${created2.status} ${JSON.stringify(created2.body)}`);
  process.exit(1);
}
const sid2 = created2.body.sessionId;
console.log("创建会话（仅 reasoningEffort）=>", sid2);
const sent2 = await j("/api/send", { method: "POST", body: JSON.stringify({ sessionId: sid2, text: "Reply with exactly: OK" }) });
if (sent2.status !== 200) {
  console.error(`FAIL(B): send ${sent2.status} ${JSON.stringify(sent2.body)}`);
  process.exit(1);
}
const deadline2 = Date.now() + 90000;
let assistant2 = null;
let turnErr2 = null;
while (Date.now() < deadline2) {
  await new Promise((r) => setTimeout(r, 4000));
  const hist = await j(`/api/history?sessionId=${sid2}&after=0&limit=100`);
  for (const e of hist.body?.events ?? []) {
    if (e.type === "assistant/message" && !assistant2) assistant2 = e;
    if (e.type === "turn/end" && typeof e.data?.reason === "object" && e.data?.reason?.kind === "error") turnErr2 = e.data.reason.error;
  }
  if (assistant2 || turnErr2) break;
}
if (turnErr2 || !assistant2) {
  console.error(`FAIL(B): ${turnErr2 ? JSON.stringify(turnErr2) : "超时未收到 assistant 回复"}`);
  await j(`/api/sessions/archive`, { method: "POST", body: JSON.stringify({ sessionId: sid2 }) }).catch(() => {});
  process.exit(1);
}
console.log("PASS(B): 仅 reasoningEffort 新会话可正常回复 =>", assistant2.data?.text?.slice(0, 40));
await j(`/api/sessions/archive`, { method: "POST", body: JSON.stringify({ sessionId: sid2 }) }).catch(() => {});
console.log("PASS(B): 已归档测试会话");
process.exit(0);
