// DSH 0.1.5-rc.2 Web/Linux live acceptance probe.
//
// Required: DSH_MOBILE_TOKEN
// Optional: DSH_MOBILE_BASE (default http://127.0.0.1:3080/m)
//           DSH_ACCEPTANCE_MUTATE=1 to exercise controlled session/directory writes.
// Default mode makes no successful business writes; expected-rejection probes still use POST.
//
// Mutating mode creates two sessions and archives them before exit. It also creates
// a temporary directory under an authorized workspace and removes it locally.
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { resolve } from "node:path";

const token = process.env.DSH_MOBILE_TOKEN;
const base = (process.env.DSH_MOBILE_BASE ?? "http://127.0.0.1:3080/m").replace(/\/$/, "");
const baseUrl = new URL(base);
const localHost = ["127.0.0.1", "localhost", "::1"].includes(baseUrl.hostname);
const mutate = process.env.DSH_ACCEPTANCE_MUTATE === "1";
if (!token) throw new Error("DSH_MOBILE_TOKEN is required");

const headers = { "x-mobile-token": token, "content-type": "application/json" };
let passed = 0;
let failed = 0;
const createdSessions = [];

function report(ok, label, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? passed++ : failed++;
}

async function call(label, path, { method = "GET", body, expected = 200, customHeaders = headers } = {}) {
  let response;
  let value;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers: customHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    try { value = JSON.parse(text); } catch { value = text; }
  } catch (err) {
    report(false, label, err?.message ?? String(err));
    return { status: 0, value: null };
  }
  const statuses = Array.isArray(expected) ? expected : [expected];
  const ok = statuses.includes(response.status);
  report(ok, label, `HTTP ${response.status}${ok ? "" : ` (${value?.error ?? String(value).slice(0, 100)})`}`);
  return { status: response.status, value, headers: response.headers };
}

function hostHeaderStatus(host) {
  const url = new URL(`${base}/api/bootstrap`);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "GET",
      headers: { "x-mobile-token": token, host },
      timeout: 10_000,
    }, (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode));
    });
    req.once("timeout", () => req.destroy(new Error("timeout")));
    req.once("error", reject);
    req.end();
  });
}

async function waitForHistory(sessionId, predicate, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/history?sessionId=${encodeURIComponent(sessionId)}&limit=100`, {
        headers,
        signal: AbortSignal.timeout(30_000),
      });
      const value = await response.json();
      const events = value?.events ?? [];
      if (response.status === 200 && predicate(events)) {
        report(true, "T09 send appears in history and turn completes");
        return events;
      }
    } catch {
      // A transient read failure is retried until the acceptance deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  report(false, "T09 send appears in history and turn completes", "timeout");
  return [];
}

async function archive(sessionId) {
  if (!sessionId) return;
  await call("T04 archive cleanup", "/api/sessions/archive", {
    method: "POST",
    body: { sessionId },
    expected: 200,
  });
}

try {
  await call("T03 missing token rejected", "/api/bootstrap", { customHeaders: {}, expected: 401 });
  const bootstrap = await call("T02/T03 authenticated bootstrap", "/api/bootstrap");
  const boot = bootstrap.value;
  report(Array.isArray(boot?.server?.urls) && boot.server.urls.length > 0, "T02 bootstrap advertises connection URLs");

  try {
    const status = await hostHeaderStatus("evil.example");
    report(status === 403, "T03 forged Host rejected", `HTTP ${status}`);
  } catch (err) {
    report(false, "T03 forged Host rejected", err?.message ?? String(err));
  }

  await call("T02 loopback QR config", "/api/qr-config");
  const diagnostics = await call("T18/T23 diagnostics", "/api/diagnostics");
  const host = diagnostics.value?.host;
  report(host?.version === "0.1.5-rc.2", "T18 host version", String(host?.version));
  report(host?.supported === true, "T23 supported host range");
  report(host?.capabilities?.hasRemoteInvoke === true, "T18 Remote invoke capability");
  report(host?.capabilities?.hasRemoteEventBridge === true, "T18 Remote event capability");
  report(host?.capabilities?.hasColdSessionResume === true, "T18 cold session resume capability");

  await call("T04 sessions", "/api/sessions");
  const catalog = await call("T10 catalog", "/api/catalog");
  report(Array.isArray(catalog.value?.models) || Array.isArray(catalog.value?.modelGroups), "T10 model catalog has model data");
  const workspaces = await call("T12 workspaces", "/api/workspaces");
  report(Array.isArray(workspaces.value?.workspaces), "T12 workspace list shape");
  const roots = await call("T12 directory roots", "/api/directories?path=");
  report(typeof roots.value?.sep === "string", "T12 directory separator advertised", String(roots.value?.sep));
  await call("T12 WSL legacy path normalization", `/api/directories?path=${encodeURIComponent("/\\home")}`);
  await call("T11 provider catalog", "/api/llm-providers");
  await call("T11 balance proxy", "/api/balance", { expected: [200, 400, 502] });
  await call("T15 notifications", "/api/notifications");
  await call("T17 actions", "/api/actions");

  const existingSession = boot?.agents?.[0]?.id ?? boot?.sessions?.[0]?.id;
  if (existingSession) {
    const q = encodeURIComponent(existingSession);
    await call("T08 queue view", `/api/queue?sessionId=${q}`);
    await call("T09 recent history", `/api/history?sessionId=${q}&limit=20`);
    await call("T10 session config", `/api/session-config?sessionId=${q}`);
    await call("T16 jobs", `/api/jobs?sessionId=${q}`);
    await call("T16 subagents", `/api/subagents?parentSessionId=${q}`);
    await call("T16 goal", `/api/goal?sessionId=${q}`);
    await call("T17 commands", `/api/commands?sessionId=${q}`);
    await call("T18 usage", `/api/usage?sessionId=${q}`);
    await call("T05 empty text rejected", "/api/send", { method: "POST", body: { sessionId: existingSession, text: "" }, expected: 400 });
  } else {
    report(false, "live host has an acceptance session");
  }

  await call("T05 nonexistent session rejected", "/api/send", {
    method: "POST",
    body: { sessionId: "acceptance-missing-session", text: "x" },
    expected: 404,
  });
  await call("T06 nonexistent receipt rejected", "/api/send-receipt?sessionId=acceptance-missing-session&requestId=acceptance-missing-request", { expected: 404 });
  await call("T16 invalid job session rejected", "/api/jobs?sessionId=acceptance-missing-session", { expected: 404 });
  await call("T17 invalid command session rejected", "/api/commands?sessionId=acceptance-missing-session", { expected: 404 });

  if (mutate) {
    const workspace = workspaces.value?.workspaces?.find((item) => typeof item?.path === "string" && item.path);
    if (!workspace) {
      report(false, "T12 controlled mutation workspace available");
    } else {
      if (!localHost) {
        report(false, "T12 controlled directory mutation requires a loopback DSH_MOBILE_BASE");
      } else {
        const dirName = `dsh-acceptance-${randomUUID()}`;
        const expectedTarget = resolve(workspace.path, dirName);
        const made = await call("T12 create directory", "/api/directories", {
          method: "POST",
          body: { path: workspace.path, name: dirName },
        });
        const target = made.value?.path;
        const createdHere = made.status === 200 && typeof target === "string" && resolve(target) === expectedTarget;
        report(createdHere, "T12 created path stays under selected workspace");
        if (createdHere) {
          try {
            const listed = await call("T12 list created directory", `/api/directories?path=${encodeURIComponent(workspace.path)}`);
            report(listed.value?.dirs?.includes(dirName), "T12 created directory is visible");
          } finally {
            // Delete only the UUID-named path that this run successfully created on this local host.
            rmSync(expectedTarget, { recursive: true, force: true });
            report(!existsSync(expectedTarget), "T12 created directory is removed after the probe");
          }
        }
      }

      const created = await call("T04 create session without explicit model", "/api/sessions", {
        method: "POST",
        body: { preset: "standard", cwd: workspace.path, permissionPreset: "workspace-write" },
      });
      const sessionId = created.value?.sessionId;
      if (typeof sessionId !== "string" || !sessionId) {
        report(false, "T04 new session id returned");
      } else {
        createdSessions.push(sessionId);
        const config = await call("T04/T10 new session config", `/api/session-config?sessionId=${encodeURIComponent(sessionId)}`);
        report(typeof config.value?.config?.model === "string" && config.value.config.model !== "", "T04 default model bound");
        report(typeof config.value?.config?.provider === "string" && config.value.config.provider !== "", "T04 default provider bound");

        await call("T04 archive", "/api/sessions/archive", { method: "POST", body: { sessionId } });
        const archivedList = await call("T04 sessions after archive", "/api/sessions");
        report(archivedList.value?.sessions?.find((item) => item.id === sessionId)?.archived === true, "T04 archive state is visible");
        await call("T04 unarchive", "/api/sessions/unarchive", { method: "POST", body: { sessionId } });
        const activeList = await call("T04 sessions after unarchive", "/api/sessions");
        report(activeList.value?.sessions?.find((item) => item.id === sessionId)?.archived === false, "T04 unarchive state is visible");

        await call("T16 create goal", "/api/goal", { method: "POST", body: { sessionId, action: "create", objective: "Acceptance probe goal", maxGoalRounds: 2 } });
        const createdGoal = await call("T16 read created goal", `/api/goal?sessionId=${encodeURIComponent(sessionId)}`);
        report(createdGoal.value?.goal?.phase === "active", "T16 created goal is active");
        await call("T16 pause goal", "/api/goal", { method: "POST", body: { sessionId, action: "pause" } });
        const pausedGoal = await call("T16 read paused goal", `/api/goal?sessionId=${encodeURIComponent(sessionId)}`);
        report(pausedGoal.value?.goal?.phase === "paused", "T16 goal is paused");
        await call("T16 resume goal", "/api/goal", { method: "POST", body: { sessionId, action: "resume" } });
        const resumedGoal = await call("T16 read resumed goal", `/api/goal?sessionId=${encodeURIComponent(sessionId)}`);
        report(resumedGoal.value?.goal?.phase === "active", "T16 goal resumes active");
        await call("T16 complete goal", "/api/goal", { method: "POST", body: { sessionId, action: "complete" } });
        const completedGoal = await call("T16 read completed goal", `/api/goal?sessionId=${encodeURIComponent(sessionId)}`);
        report(completedGoal.value?.goal?.phase === "complete", "T16 goal is complete");

        const requestId = randomUUID();
        const message = `DSH mobile acceptance ${requestId}: reply exactly ACCEPTANCE_OK.`;
        const first = await call("T05 send to idle session", "/api/send", { method: "POST", body: { sessionId, text: message, requestId } });
        const duplicate = await call("T06 duplicate requestId", "/api/send", { method: "POST", body: { sessionId, text: message, requestId } });
        report(first.value?.messageId && first.value.messageId === duplicate.value?.messageId, "T06 duplicate returns original messageId");
        const receipt = await call("T06 send receipt", `/api/send-receipt?sessionId=${encodeURIComponent(sessionId)}&requestId=${encodeURIComponent(requestId)}`);
        report(receipt.value?.receipt?.status === "done", "T06 receipt reaches done", String(receipt.value?.receipt?.status));

        const events = await waitForHistory(sessionId, (items) => {
          const user = items.find((event) => event.type === "user/message" && event.data?.text?.includes(requestId));
          if (!user) return false;
          return items.some((event) => event.type === "turn/end" && event.seq > user.seq);
        });
        const matchingUsers = events.filter((event) => event.type === "user/message" && event.data?.text?.includes(requestId));
        report(matchingUsers.length === 1, "T06 request executes at most once", `${matchingUsers.length} matching user events`);
        const userSeq = matchingUsers[0]?.seq ?? -1;
        const endSeq = events.find((event) => event.type === "turn/end" && event.seq > userSeq)?.seq ?? Number.POSITIVE_INFINITY;
        const assistant = events.find((event) => event.type === "assistant/message" && event.seq > userSeq && event.seq < endSeq && typeof event.data?.messageId === "string");
        report(assistant?.data?.text?.trim() === "ACCEPTANCE_OK", "T09 assistant response belongs to this turn", assistant?.data?.text?.trim() ?? "missing");
        if (assistant) {
          await call("T17 positive feedback", "/api/feedback", { method: "POST", body: { sessionId, messageId: assistant.data.messageId, rating: "positive" } });
          const positive = await call("T17 feedback list after positive", `/api/feedback?sessionId=${encodeURIComponent(sessionId)}`);
          report(positive.value?.items?.some((item) => item.messageId === assistant.data.messageId && item.rating === "positive"), "T17 positive feedback is persisted");
          await call("T17 clear feedback", "/api/feedback", { method: "POST", body: { sessionId, messageId: assistant.data.messageId, rating: "none" } });
          const cleared = await call("T17 feedback list after clear", `/api/feedback?sessionId=${encodeURIComponent(sessionId)}`);
          report(!cleared.value?.items?.some((item) => item.messageId === assistant.data.messageId), "T17 cleared feedback is absent");
        }

        const forked = await call("T04 fork session", "/api/sessions/fork", { method: "POST", body: { sessionId } });
        const childSessionId = forked.value?.sessionId;
        report(typeof childSessionId === "string" && childSessionId !== "" && childSessionId !== sessionId, "T04 fork returns a distinct session");
        if (typeof childSessionId === "string" && childSessionId !== "") createdSessions.push(childSessionId);
        await call("T04 stop endpoint", "/api/sessions/stop", { method: "POST", body: { sessionId } });
      }
    }
  } else {
    console.log("SKIP  controlled write checks (set DSH_ACCEPTANCE_MUTATE=1)");
  }
} finally {
  for (const sessionId of createdSessions.reverse()) await archive(sessionId);
}

console.log(`\nRESULT ${passed} passed / ${failed} failed${mutate ? " (controlled writes enabled)" : ""}`);
if (failed) process.exitCode = 1;
