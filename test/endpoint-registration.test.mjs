// 端点登记机制的契约（ADR 0019「能力登记强制化」）：
// 「能力能不能用」这条判据要靠能力声明成立，而声明要成立就必须有人登记新端点。
// 这里把"登记"变成**可被测试检出**的约束：漏登记或登记表陈旧都会失败。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";
import {
	ENDPOINT_DISPATCH_SOURCE,
	REGISTERED_ENDPOINTS,
	diffRegisteredEndpoints,
	extractDispatchedEndpoints,
} from "../lib/endpoint-registry.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const source = readFileSync(join(ROOT, ENDPOINT_DISPATCH_SOURCE), "utf8");

test("源码里的每个正向分派端点都已登记（新增端点必须登记）", () => {
	const { missing } = diffRegisteredEndpoints(source);
	assert.deepEqual(
		missing,
		[],
		`以下端点已在 ${ENDPOINT_DISPATCH_SOURCE} 分派但未登记到 lib/endpoint-registry.js：\n  ${missing.join("\n  ")}`,
	);
});

test("登记表不陈旧（表里有、源码里没有的条目必须清掉）", () => {
	const { stale } = diffRegisteredEndpoints(source);
	assert.deepEqual(
		stale,
		[],
		`以下登记项在 ${ENDPOINT_DISPATCH_SOURCE} 里已找不到分派，属陈旧登记：\n  ${stale.join("\n  ")}`,
	);
});

test("登记表无重复", () => {
	assert.equal(new Set(REGISTERED_ENDPOINTS).size, REGISTERED_ENDPOINTS.length);
});

test("抽取器只认正向分派：守卫（rest !== ...）不算端点", () => {
	const fake = `
		if (rest === "/a") { return; }
		if (rest !== "/guard") { return; }
		if (new Set(["/b", "/c"]).has(rest)) { return; }
	`;
	const found = extractDispatchedEndpoints(fake);
	assert.deepEqual([...found].sort(), ["/a", "/b", "/c"]);
});

test("比对器能揪出漏登记与陈旧登记（机制真的会咬人）", () => {
	const fake = 'if (rest === "/new-one") {} if (rest === "/known") {}';
	const r = diffRegisteredEndpoints(fake, ["/known", "/gone"]);
	assert.deepEqual(r.missing, ["/new-one"]);
	assert.deepEqual(r.stale, ["/gone"]);
	assert.deepEqual(diffRegisteredEndpoints(fake, ["/known", "/new-one"]), {
		missing: [],
		stale: [],
		dispatched: new Set(["/new-one", "/known"]),
	});
});

test("本次新增的自更新端点已登记", () => {
	assert.ok(REGISTERED_ENDPOINTS.includes("/plugin-update"));
	assert.ok(REGISTERED_ENDPOINTS.includes("/update/manifest"));
	assert.ok(REGISTERED_ENDPOINTS.includes("/update/apk"));
});
