// 端点登记表（ADR 0019「能力登记强制化」；评审 #32 note 1286 的 W2）。
//
// 三条判据里「能力能不能用」看的是**能力声明**；而声明要成立，前提是"新增端点时必须有人
// 登记它"。此前这件事只写在 CONTRIBUTING 的文字要求里，没有机制兜底——于是必然漏。
//
// 这里把登记变成**可被测试检出**的东西：
//   - 从 `lib/index.js` 抽取所有正向分派（`rest === "..."`、`new Set([...]).has(rest)`），
//     与登记表**双向**比对：漏登记、陈旧登记、**方法不符**都会失败；
//   - 抽取正则容忍引号与空白差异（`rest === '/x'`、`rest==="/x"` 同样会被抓到）；
//   - 每条登记项都必须显式写出 `capability`（能力键或 `null`）；写了键就必须真的在
//     bootstrap 的 capabilities 里声明过，否则失败。
//
// 已知边界（不假装更强）：`methods` 由源码按分派段落推导，是**契约快照**而非运行期保证；
// 端点自身仍靠 `requireGet`/`method` 检查在运行时兜底。

/** 抽取正向分派所用的源码文件（相对仓库根）。 */
export const ENDPOINT_DISPATCH_SOURCE = "lib/index.js";

/** 从源码抽取"正向分派"及其方法（按分派段落判定，不看固定窗口）。 */
export function extractEndpointDetails(source) {
	const lines = source.split("\n");
	const marks = [];
	lines.forEach((line, index) => {
		for (const m of line.matchAll(/rest\s*===\s*['"]([^'"]+)['"]/g)) marks.push({ index, path: m[1] });
		for (const group of line.matchAll(/new Set\(\[([^\]]+)\]\)\s*\.has\(rest\)/g)) {
			for (const m of group[1].matchAll(/['"]([^'"]+)['"]/g)) marks.push({ index, path: m[1] });
		}
	});
	marks.sort((a, b) => a.index - b.index);
	const markLines = [...new Set(marks.map((m) => m.index))].sort((a, b) => a - b);
	const out = new Map();
	for (const { index, path } of marks) {
		if (out.has(path)) continue;
		const next = markLines.find((l) => l > index);
		const segment = lines.slice(index, next ?? Math.min(lines.length, index + 400)).join("\n");
		let methods = "GET/POST";
		if (/requireGet\(method,\s*res\)/.test(segment)) methods = "GET";
		else if (/method\s*!==\s*['"]POST['"]/.test(segment)) methods = "POST";
		out.set(path, methods);
	}
	return out;
}

/**
 * 抽取 **bootstrap 响应**里实际声明的能力键（G2）。
 * 只认 `/bootstrap` 处理器里的那个 `capabilities: {...}` 块——SSE hello 里也有
 * `capabilities`，按"源码里第一个"抽取会误判（那样负向变异根本测不出来）。
 */
export function extractDeclaredCapabilities(source) {
	const lines = source.split("\n");
	const bootstrapAt = lines.findIndex((l) => /rest\s*===\s*['"]\/bootstrap['"]/.test(l));
	const from = bootstrapAt >= 0 ? bootstrapAt : 0;
	const tail = lines.slice(from).join("\n");
	const m = /capabilities:\s*\{/.exec(tail);
	if (!m) return new Set();
	// 从 `{` 起做花括号配平，取出完整块
	const open = tail.indexOf("{", m.index);
	let depth = 0;
	let end = -1;
	for (let i = open; i < tail.length; i++) {
		if (tail[i] === "{") depth++;
		else if (tail[i] === "}") {
			depth--;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	if (end < 0) return new Set();
	const block = tail.slice(open + 1, end);
	return new Set([...block.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map((x) => x[1]));
}

/** 未声明能力时的显式豁免理由（登记表要求二者必居其一）。 */
export const NO_CAPABILITY_NEEDED = "端点级能力由 App 按 404/缺字段降级；能力声明机制覆盖的是帧/字段级特性";

/**
 * 双向比对。返回 `missing`（源码有、表里没有）、`stale`（表里有、源码没有）、
 * `methodMismatch`（方法不符）与 `undeclaredCapabilities`（登记了未声明的能力键）。
 */
export function diffRegisteredEndpoints(source, registered = REGISTERED_ENDPOINTS) {
	const dispatched = extractEndpointDetails(source);
	const known = new Map(registered.map((e) => [e.path, e]));
	const declared = extractDeclaredCapabilities(source);
	const missing = [...dispatched.keys()].filter((p) => !known.has(p)).sort();
	const stale = [...known.keys()].filter((p) => !dispatched.has(p)).sort();
	const methodMismatch = [...dispatched.entries()]
		.filter(([p, methods]) => known.has(p) && known.get(p).methods && known.get(p).methods !== methods)
		.map(([p, methods]) => ({ path: p, registered: known.get(p).methods, source: methods }))
		.sort((a, b) => a.path.localeCompare(b.path));
	const undeclaredCapabilities = [...new Set(
		registered.map((e) => e.capability).filter((c) => typeof c === "string" && c !== "" && !declared.has(c)),
	)].sort();
	const missingCapabilityField = registered.filter((e) => !("capability" in e)).map((e) => e.path).sort();
	// 没关联能力键的必须给出**显式豁免理由**（G2：不允许"忘了写"和"确实不需要"长得一样）
	const missingExemption = registered
		.filter((e) => (e.capability === null || e.capability === undefined) && !(typeof e.why === "string" && e.why.trim() !== ""))
		.map((e) => e.path)
		.sort();
	return { missing, stale, methodMismatch, undeclaredCapabilities, missingCapabilityField, missingExemption, dispatched, declared };
}

/** 已登记的 `/m/api/*` 端点（`path` 是去掉 `/m/api` 前缀后的部分）。 */
export const REGISTERED_ENDPOINTS = Object.freeze([
	{ path: "/account-usage", methods: "GET", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/actions", methods: "GET", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/attachment", methods: "GET", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/balance", methods: "GET", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/bootstrap", methods: "GET", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/catalog", methods: "GET", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/commands", methods: "GET/POST", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/defaults", methods: "GET/POST", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/dev/approval-test", methods: "GET/POST", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/diagnostics", methods: "GET", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/directories", methods: "GET", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/event-detail", methods: "GET", capability: "eventTimeline" },
	{ path: "/events", methods: "GET/POST", capability: "eventTimeline" },
	{ path: "/feedback", methods: "GET/POST", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/files", methods: "GET/POST", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/files/upload", methods: "GET/POST", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/git/branches", methods: "GET", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/git/capabilities", methods: "GET", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/git/commit", methods: "GET", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/git/graph", methods: "GET", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/git/preview", methods: "GET", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/git/repository", methods: "GET", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/git/worktree", methods: "GET", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/goal", methods: "GET/POST", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/history", methods: "GET", capability: "eventTimeline" },
	{ path: "/jobs", methods: "GET", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/jobs/kill", methods: "GET/POST", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/llm-providers", methods: "GET/POST", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/llm-providers/probe", methods: "GET/POST", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/messages", methods: "GET/POST", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/notifications", methods: "GET", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/notifications/delete", methods: "GET/POST", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/notifications/read", methods: "GET/POST", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/plugin-update", methods: "POST", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/push-test", methods: "GET/POST", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/qr-config", methods: "GET", capability: null, auth: "local-privileged", why: NO_CAPABILITY_NEEDED },
	{ path: "/queue", methods: "GET", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/respond", methods: "GET/POST", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/send", methods: "GET/POST", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/send-receipt", methods: "GET", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/session-config", methods: "GET/POST", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/sessions", methods: "GET/POST", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/sessions/archive", methods: "GET/POST", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/sessions/fork", methods: "GET/POST", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/sessions/stop", methods: "GET/POST", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/sessions/touch", methods: "GET/POST", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/sessions/unarchive", methods: "GET/POST", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/subagents", methods: "GET", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/subagents/interrupt", methods: "GET/POST", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/todos", methods: "GET", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/update/apk", methods: "GET", capability: null, auth: "anonymous", why: NO_CAPABILITY_NEEDED },
	{ path: "/update/manifest", methods: "GET", capability: null, auth: "required", why: NO_CAPABILITY_NEEDED },
	{ path: "/update/plugin", methods: "GET", capability: null, auth: "required", why: NO_CAPABILITY_NEEDED },
	{ path: "/usage", methods: "GET", capability: null, why: NO_CAPABILITY_NEEDED },
	{ path: "/workspaces", methods: "GET", capability: null, why: NO_CAPABILITY_NEEDED },
]);
