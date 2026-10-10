// 端点登记表（ADR 0019「能力登记强制化」）。
//
// 三条判据里「能力能不能用」看的是**能力声明**；而声明要成立，前提是"新增端点时
// 必须有人登记它"。此前这件事只写在 CONTRIBUTING 的文字要求里，没有机制兜底，
// 于是必然漏（现状：只有 2 个特性被声明为 capability，其余靠 `not-found` 猜）。
//
// 这里把登记变成**可被测试检出**的东西：`test/endpoint-registration.test.mjs` 从
// `lib/index.js` 抽取所有正向分派（`rest === "..."` 与 `new Set([...]).has(rest)`），
// 与本表双向比对——漏登记、或登记表陈旧，都会让测试失败。
//
// 新增端点时：在这里加一行即可（顺带想清楚它是否需要能力声明）。

/** 抽取正向分派所用的源码文件（相对仓库根）。 */
export const ENDPOINT_DISPATCH_SOURCE = "lib/index.js";

/**
 * 从源码里抽取被分派的端点集合。
 * 只认**正向分派**：`rest === "/x"` 与 `new Set([...]).has(rest)`；
 * `rest !== "/x"` 是守卫（例如 "/qr-config" 被单独排除），不是端点。
 */
export function extractDispatchedEndpoints(source) {
	const found = new Set();
	for (const m of source.matchAll(/rest === "([^"]+)"/g)) found.add(m[1]);
	for (const group of source.matchAll(/new Set\(\[([^\]]+)\]\)\.has\(rest\)/g)) {
		for (const m of group[1].matchAll(/"([^"]+)"/g)) found.add(m[1]);
	}
	return found;
}

/**
 * 比对源码与登记表，返回差异（两者都为空表示一致）。
 * `missing` = 源码里有、登记表里没有（**漏登记**）；`stale` = 登记表里有、源码里没有（**陈旧**）。
 */
export function diffRegisteredEndpoints(source, registered = REGISTERED_ENDPOINTS) {
	const dispatched = extractDispatchedEndpoints(source);
	const known = new Set(registered);
	return {
		missing: [...dispatched].filter((p) => !known.has(p)).sort(),
		stale: [...known].filter((p) => !dispatched.has(p)).sort(),
		dispatched,
	};
}

/** 已登记的 `/m/api/*` 端点（`rest` 是去掉 `/m/api` 前缀后的部分）。 */
export const REGISTERED_ENDPOINTS = Object.freeze([
	"/account-usage",
	"/actions",
	"/attachment",
	"/balance",
	"/bootstrap",
	"/catalog",
	"/commands",
	"/defaults",
	"/dev/approval-test",
	"/diagnostics",
	"/directories",
	"/event-detail",
	"/events",
	"/feedback",
	"/files",
	"/files/upload",
	"/git/branches",
	"/git/capabilities",
	"/git/commit",
	"/git/graph",
	"/git/preview",
	"/git/repository",
	"/git/worktree",
	"/goal",
	"/history",
	"/jobs",
	"/jobs/kill",
	"/llm-providers",
	"/llm-providers/probe",
	"/messages",
	"/notifications",
	"/notifications/delete",
	"/notifications/read",
	"/plugin-update",
	"/push-test",
	"/qr-config",
	"/queue",
	"/respond",
	"/send",
	"/send-receipt",
	"/session-config",
	"/sessions",
	"/sessions/archive",
	"/sessions/fork",
	"/sessions/stop",
	"/sessions/touch",
	"/sessions/unarchive",
	"/subagents",
	"/subagents/interrupt",
	"/todos",
	"/update/apk",
	"/update/manifest",
	"/usage",
	"/workspaces",
]);
