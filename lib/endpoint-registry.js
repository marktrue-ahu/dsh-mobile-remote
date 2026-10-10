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

/** 抽取 bootstrap 里实际声明的能力键。 */
export function extractDeclaredCapabilities(source) {
	const m = /capabilities:\s*\{([\s\S]*?)\n\s*\}/.exec(source);
	if (!m) return new Set();
	return new Set([...m[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map((x) => x[1]));
}

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
	return { missing, stale, methodMismatch, undeclaredCapabilities, missingCapabilityField, dispatched, declared };
}

/** 已登记的 `/m/api/*` 端点（`path` 是去掉 `/m/api` 前缀后的部分）。 */
export const REGISTERED_ENDPOINTS = Object.freeze([
	{ path: "/account-usage", methods: "GET", capability: null },
	{ path: "/actions", methods: "GET", capability: null },
	{ path: "/attachment", methods: "GET", capability: null },
	{ path: "/balance", methods: "GET", capability: null },
	{ path: "/bootstrap", methods: "GET", capability: null },
	{ path: "/catalog", methods: "GET", capability: null },
	{ path: "/commands", methods: "GET/POST", capability: null },
	{ path: "/defaults", methods: "GET/POST", capability: null },
	{ path: "/dev/approval-test", methods: "GET/POST", capability: null },
	{ path: "/diagnostics", methods: "GET", capability: null },
	{ path: "/directories", methods: "GET", capability: null },
	{ path: "/event-detail", methods: "GET", capability: null },
	{ path: "/events", methods: "GET/POST", capability: null },
	{ path: "/feedback", methods: "GET/POST", capability: null },
	{ path: "/files", methods: "GET/POST", capability: null },
	{ path: "/files/upload", methods: "GET/POST", capability: null },
	{ path: "/git/branches", methods: "GET", capability: null },
	{ path: "/git/capabilities", methods: "GET", capability: null },
	{ path: "/git/commit", methods: "GET", capability: null },
	{ path: "/git/graph", methods: "GET", capability: null },
	{ path: "/git/preview", methods: "GET", capability: null },
	{ path: "/git/repository", methods: "GET", capability: null },
	{ path: "/git/worktree", methods: "GET", capability: null },
	{ path: "/goal", methods: "GET/POST", capability: null },
	{ path: "/history", methods: "GET", capability: null },
	{ path: "/jobs", methods: "GET", capability: null },
	{ path: "/jobs/kill", methods: "GET/POST", capability: null },
	{ path: "/llm-providers", methods: "GET/POST", capability: null },
	{ path: "/llm-providers/probe", methods: "GET/POST", capability: null },
	{ path: "/messages", methods: "GET/POST", capability: null },
	{ path: "/notifications", methods: "GET", capability: null },
	{ path: "/notifications/delete", methods: "GET/POST", capability: null },
	{ path: "/notifications/read", methods: "GET/POST", capability: null },
	{ path: "/plugin-update", methods: "POST", capability: null },
	{ path: "/push-test", methods: "GET/POST", capability: null },
	{ path: "/qr-config", methods: "GET", capability: null },
	{ path: "/queue", methods: "GET", capability: null },
	{ path: "/respond", methods: "GET/POST", capability: null },
	{ path: "/send", methods: "GET/POST", capability: null },
	{ path: "/send-receipt", methods: "GET", capability: null },
	{ path: "/session-config", methods: "GET/POST", capability: null },
	{ path: "/sessions", methods: "GET/POST", capability: null },
	{ path: "/sessions/archive", methods: "GET/POST", capability: null },
	{ path: "/sessions/fork", methods: "GET/POST", capability: null },
	{ path: "/sessions/stop", methods: "GET/POST", capability: null },
	{ path: "/sessions/touch", methods: "GET/POST", capability: null },
	{ path: "/sessions/unarchive", methods: "GET/POST", capability: null },
	{ path: "/subagents", methods: "GET", capability: null },
	{ path: "/subagents/interrupt", methods: "GET/POST", capability: null },
	{ path: "/todos", methods: "GET", capability: null },
	{ path: "/update/apk", methods: "GET", capability: null },
	{ path: "/update/manifest", methods: "GET", capability: null },
	{ path: "/update/plugin", methods: "GET", capability: null },
	{ path: "/usage", methods: "GET", capability: null },
	{ path: "/workspaces", methods: "GET", capability: null },
]);
