/**
 * DSH 0.1.2-rc.1 Remote adapter.
 *
 * RC1 replaces the legacy `apiProxy` dot-method surface with the Typert
 * Gateway's `<namespace>/<method>` endpoints and named `args`.  Keeping this
 * translation in one small, dependency-free module makes the compatibility
 * boundary explicit and keeps the mobile HTTP contract unchanged.
 */

/** Endpoint used by the RC1 Gateway to settle a forwarded Remote Event. */
export const RC1_REMOTE_EVENT_RESULT = "$events/result";

/**
 * Translate one legacy mobile method and payload to an RC1 Gateway request.
 * The returned object is suitable for `ctx.typertGateway.invoke()`.
 */
export function rc1RemoteSpec(method, payload = {}) {
	const value = payload && typeof payload === "object" ? payload : {};
	switch (method) {
		case "session.models":
			// RC1's modelCatalog has no sessionId argument.
			return { namespace: "session", method: "modelCatalog", args: {} };
		case "session.list":
			return { namespace: "session", method: "list", args: { _request: {} } };
		case "session.page":
			return { namespace: "session", method: "page", args: { request: value } };
		case "session.selectModel":
			return { namespace: "session", method: "selectModel", args: { request: value } };
		case "session.prompt":
			return { namespace: "session", method: "prompt", args: { request: value } };
		case "session.attachment":
			return { namespace: "session", method: "attachment", args: { request: value } };
		case "session.updateQueue":
			return { namespace: "session", method: "updateQueue", args: { request: value } };
		case "session.fork":
			return { namespace: "session", method: "fork", args: { request: value } };
		case "session.cancel":
			return { namespace: "session", method: "cancel", args: { request: value } };
		case "workspace.archiveSession":
			return { namespace: "workspace", method: "archiveSession", args: { request: value } };
		case "settings.update": {
			const args = { ns: value.ns, patch: value.patch };
			if (Number.isInteger(value.expectedRevision)) args.expectedRevision = value.expectedRevision;
			return { namespace: "settings", method: "update", args };
		}
		case "subagent.list":
			return { namespace: "subagents", method: "list", args: { parentSessionId: value.parentSessionId } };
		case "subagent.interrupt":
			return {
				namespace: "subagents",
				method: "interruptByParent",
				args: {
					childSessionId: value.childSessionId,
					parentSessionId: value.parentSessionId,
					mode: value.mode,
				},
			};
		case "goal.create":
			return {
				namespace: "goals",
				method: "create",
				args: {
					agentId: value.sessionId,
					request: {
						objective: value.objective,
						...(value.maxGoalRounds === undefined ? {} : { maxGoalRounds: value.maxGoalRounds }),
					},
				},
			};
		case "goal.edit":
			return {
				namespace: "goals",
				method: "edit",
				args: { agentId: value.sessionId, ref: value.ref, request: value.request },
			};
		case "goal.pause":
		case "goal.resume":
		case "goal.complete":
		case "goal.clear":
			// RC1 goal Remote（agent lookup 注入 agentId + ref）不接收 reason 参数；
			// `goals/block` 在 0.1.2-rc.1 宿主不存在，故不映射（调用侧也不使用）。
			return {
				namespace: "goals",
				method: method.slice("goal.".length),
				args: {
					agentId: value.sessionId,
					ref: value.ref,
				},
			};
		default:
			throw Object.assign(new Error(`RC1 Remote method is not mapped: ${method}`), {
				code: "rc1-method-unmapped",
				status: 501,
			});
	}
}

/** Preserve the old model-directory shape consumed by the mobile API. */
export function normalizeRc1ModelCatalog(value) {
	if (!value || typeof value !== "object") return value;
	const current = value.current ?? (value.default && typeof value.default === "object"
		? value.default
		: undefined);
	return {
		...value,
		...(current ? { current } : {}),
	};
}

/** Convert an RC1 session-list projection into the old image-limit lookup. */
export function imageLimitsFromRc1SessionList(value, sessionId) {
	const row = value?.items?.find?.((item) => item?.sessionId === sessionId);
	return row?.projections?.values?.imageLimits ?? null;
}

/** Fold the RC1 durable model-selection projection from an attached Session log. */
export function foldRc1ModelSelection(events) {
	let lastUsed = null;
	let pending = null;
	for (const event of Array.isArray(events) ? events : []) {
		if (event?.type === "model/selection" && isModelSelection(event.data)) {
			if (!sameModelSelection(pending, event.data)) pending = event.data;
			continue;
		}
		if (event?.type !== "request/header") continue;
		const config = event.data?.header?.config;
		if (typeof config?.provider !== "string" || typeof config?.model !== "string") continue;
		const used = {
			provider: config.provider,
			model: config.model,
			...(config.reasoningEffort === undefined ? {} : { reasoningEffort: String(config.reasoningEffort) }),
		};
		lastUsed = used;
		if (sameModelSelection(pending, used)) pending = null;
	}
	return pending ?? lastUsed;
}

/** Read the RC1 model-selection projection from one cold Session-list row. */
export function modelSelectionFromRc1SessionList(value, sessionId) {
	const row = value?.items?.find?.((item) => item?.sessionId === sessionId);
	const selection = row?.projections?.values?.modelSelection?.next;
	return isModelSelection(selection) ? selection : null;
}

/** Normalize the RC1 agent identity carried by a scoped Remote Event frame. */
export function sessionIdFromRc1AgentId(agentId) {
	return typeof agentId === "string" ? agentId.replace(/^session:/, "") : "";
}

function isModelSelection(value) {
	return value && typeof value === "object"
		&& typeof value.provider === "string" && value.provider !== ""
		&& typeof value.model === "string" && value.model !== ""
		&& (value.reasoningEffort === undefined || typeof value.reasoningEffort === "string");
}

function sameModelSelection(left, right) {
	return !!left && !!right
		&& left.provider === right.provider
		&& left.model === right.model
		&& left.reasoningEffort === right.reasoningEffort;
}
