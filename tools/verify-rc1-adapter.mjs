import assert from "node:assert/strict";
import {
	foldRc1ModelSelection,
	imageLimitsFromRc1SessionList,
	modelSelectionFromRc1SessionList,
	normalizeRc1ModelCatalog,
	rc1RemoteSpec,
	sessionIdFromRc1AgentId,
} from "../lib/rc1-adapter.js";

const prompt = {
	requestId: "request-1",
	sessionId: "session-1",
	mode: "queue",
	content: [{ type: "text", text: "hello" }],
};

assert.deepEqual(rc1RemoteSpec("session.models", { sessionId: "ignored" }), {
	namespace: "session",
	method: "modelCatalog",
	args: {},
});
assert.deepEqual(rc1RemoteSpec("session.list"), {
	namespace: "session",
	method: "list",
	args: { _request: {} },
});
assert.deepEqual(rc1RemoteSpec("session.prompt", prompt), {
	namespace: "session",
	method: "prompt",
	args: { request: prompt },
});
assert.deepEqual(rc1RemoteSpec("session.page", { address: { sessionId: "session-1" }, throughSeq: 3 }), {
	namespace: "session",
	method: "page",
	args: { request: { address: { sessionId: "session-1" }, throughSeq: 3 } },
});
assert.deepEqual(rc1RemoteSpec("workspace.archiveSession", { sessionId: "session-1" }), {
	namespace: "workspace",
	method: "archiveSession",
	args: { request: { sessionId: "session-1" } },
});
assert.deepEqual(rc1RemoteSpec("settings.update", { ns: "permission", patch: { defaultPreset: "ask" } }), {
	namespace: "settings",
	method: "update",
	args: { ns: "permission", patch: { defaultPreset: "ask" } },
});
assert.deepEqual(rc1RemoteSpec("settings.update", {
	ns: "permission",
	patch: { defaultPreset: "ask" },
	expectedRevision: 7,
}), {
	namespace: "settings",
	method: "update",
	args: { ns: "permission", patch: { defaultPreset: "ask" }, expectedRevision: 7 },
});
assert.deepEqual(rc1RemoteSpec("subagent.list", { parentSessionId: "parent" }), {
	namespace: "subagents",
	method: "list",
	args: { parentSessionId: "parent" },
});
assert.deepEqual(rc1RemoteSpec("subagent.interrupt", {
	parentSessionId: "parent",
	childSessionId: "child",
	mode: "continuable",
}), {
	namespace: "subagents",
	method: "interruptByParent",
	args: { parentSessionId: "parent", childSessionId: "child", mode: "continuable" },
});
assert.deepEqual(rc1RemoteSpec("goal.create", {
	sessionId: "session-1",
	objective: "ship",
	maxGoalRounds: 4,
}), {
	namespace: "goals",
	method: "create",
	args: { agentId: "session-1", request: { objective: "ship", maxGoalRounds: 4 } },
});
assert.deepEqual(rc1RemoteSpec("goal.pause", {
	sessionId: "session-1",
	ref: { id: "goal-1", revision: 2 },
}), {
	namespace: "goals",
	method: "pause",
	args: { agentId: "session-1", ref: { id: "goal-1", revision: 2 } },
});

assert.deepEqual(normalizeRc1ModelCatalog({
	default: { provider: "deepseek-official", model: "deepseek-chat" },
	groups: [],
}), {
	default: { provider: "deepseek-official", model: "deepseek-chat" },
	current: { provider: "deepseek-official", model: "deepseek-chat" },
	groups: [],
});
assert.deepEqual(imageLimitsFromRc1SessionList({
	items: [{
		sessionId: "session-1",
		projections: { values: { imageLimits: { maxImagesPerMessage: 3 } } },
	}],
}, "session-1"), { maxImagesPerMessage: 3 });
assert.deepEqual(foldRc1ModelSelection([
	{ type: "model/selection", data: { provider: "p", model: "m", reasoningEffort: "high" } },
	{ type: "request/header", data: { header: { config: { provider: "p", model: "m", reasoningEffort: "high" } } } },
]), { provider: "p", model: "m", reasoningEffort: "high" });
assert.deepEqual(modelSelectionFromRc1SessionList({
	items: [{ sessionId: "session-1", projections: { values: { modelSelection: {
		lastUsed: { provider: "p", model: "old" },
		next: { provider: "p", model: "new" },
	} } } }],
}, "session-1"), { provider: "p", model: "new" });
assert.equal(sessionIdFromRc1AgentId("session:session-1"), "session-1");
assert.equal(sessionIdFromRc1AgentId("session-1"), "session-1");

assert.throws(() => rc1RemoteSpec("session.history", {}), (error) => {
	assert.equal(error.code, "rc1-method-unmapped");
	assert.equal(error.status, 501);
	return true;
});

console.log("RC1 adapter checks passed");
