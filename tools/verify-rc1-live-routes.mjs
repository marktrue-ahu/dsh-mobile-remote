import assert from "node:assert/strict";

const token = process.env.DSH_MOBILE_TOKEN;
const base = process.env.DSH_MOBILE_BASE ?? "http://127.0.0.1:3080/m";
assert.ok(token, "DSH_MOBILE_TOKEN is required");

const headers = { "x-mobile-token": token };
const sessionsResponse = await fetch(`${base}/api/sessions`, { headers });
assert.equal(sessionsResponse.status, 200, "session list must be available");
const sessions = await sessionsResponse.json();
const live = (sessions.sessions ?? []).find((row) => row.live === true);
assert.ok(live?.id, "a live session is required for the RC1 route check");

const checks = [
	["session-config", `/api/session-config?sessionId=${encodeURIComponent(live.id)}`],
	["history", `/api/history?sessionId=${encodeURIComponent(live.id)}&limit=1`],
	["usage", `/api/usage?sessionId=${encodeURIComponent(live.id)}`],
];
for (const [name, path] of checks) {
	const response = await fetch(`${base}${path}`, { headers });
	const body = await response.text();
	assert.equal(response.status, 200, `${name} returned HTTP ${response.status}: ${body.slice(0, 200)}`);
}

console.log(`RC1 live route checks passed (${checks.length} endpoints)`);
