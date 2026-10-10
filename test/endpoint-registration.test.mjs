// 端点登记机制的契约（ADR 0019「能力登记强制化」；评审 #32 note 1286 的 W2）：
// 漏登记、陈旧登记、**方法不符**、登记了未声明的能力键，都必须让测试失败；
// 抽取必须容忍引号/空白差异，不能靠"固定空格 + 双引号"。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";
import {
	ENDPOINT_DISPATCH_SOURCE,
	REGISTERED_ENDPOINTS,
	diffRegisteredEndpoints,
	extractDeclaredCapabilities,
	extractEndpointDetails,
} from "../lib/endpoint-registry.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const source = readFileSync(join(ROOT, ENDPOINT_DISPATCH_SOURCE), "utf8");

test("源码里的每个正向分派端点都已登记（新增端点必须登记）", () => {
	const { missing } = diffRegisteredEndpoints(source);
	assert.deepEqual(missing, [], `未登记的端点：\n  ${missing.join("\n  ")}`);
});

test("登记表不陈旧（表里有、源码里没有的条目必须清掉）", () => {
	const { stale } = diffRegisteredEndpoints(source);
	assert.deepEqual(stale, [], `陈旧登记：\n  ${stale.join("\n  ")}`);
});

test("登记的方法必须与源码分派一致", () => {
	const { methodMismatch } = diffRegisteredEndpoints(source);
	assert.deepEqual(methodMismatch, [], `方法不符：${JSON.stringify(methodMismatch)}`);
});

test("每条登记项都显式写出 capability；写了键就必须真的声明过", () => {
	const { missingCapabilityField, undeclaredCapabilities } = diffRegisteredEndpoints(source);
	assert.deepEqual(missingCapabilityField, [], `缺少 capability 字段：${missingCapabilityField.join(", ")}`);
	assert.deepEqual(undeclaredCapabilities, [], `登记了未声明的能力键：${undeclaredCapabilities.join(", ")}`);
});

test("登记表无重复", () => {
	const paths = REGISTERED_ENDPOINTS.map((e) => e.path);
	assert.equal(new Set(paths).size, paths.length);
});

test("bootstrap 的能力声明可被抽取，且不为空（能力判据有实体）", () => {
	const declared = extractDeclaredCapabilities(source);
	assert.ok(declared.size > 0, "抽取不到任何能力声明，说明抽取规则或声明结构已变");
	assert.ok(declared.has("eventTimeline"));
});

test("抽取容忍引号与空白差异（W2 的负向变异）", () => {
	const variants = [
		`if (rest === "/a") { if (requireGet(method, res)) return; }`,
		`if (rest === '/a') { if (requireGet(method, res)) return; }`,
		`if (rest==="/a") { if (requireGet(method, res)) return; }`,
		`if ( rest === "/a" ) { if (requireGet(method, res)) return; }`,
		`if (new Set(['/a']).has(rest)) { if (requireGet(method, res)) return; }`,
	];
	for (const src of variants) {
		const details = extractEndpointDetails(src);
		assert.equal(details.get("/a"), "GET", src);
	}
});

test("比对器能揪出漏登记/陈旧/方法不符/未声明能力（机制真的会咬人）", () => {
	const fake = `
		if (rest === "/new-one") { if (method !== "POST") return; }
		if (rest === "/known") { if (requireGet(method, res)) return; }
	`;
	const r = diffRegisteredEndpoints(fake, [
		{ path: "/known", methods: "GET", capability: null },
		{ path: "/gone", methods: "GET", capability: null },
	]);
	assert.deepEqual(r.missing, ["/new-one"]);
	assert.deepEqual(r.stale, ["/gone"]);
	// 方法不符：源码是 POST，登记写 GET
	const mismatch = diffRegisteredEndpoints(fake, [
		{ path: "/new-one", methods: "GET", capability: null },
		{ path: "/known", methods: "GET", capability: null },
	]);
	assert.deepEqual(mismatch.methodMismatch, [{ path: "/new-one", registered: "GET", source: "POST" }]);
	// 未声明能力键
	const caps = diffRegisteredEndpoints(fake, [
		{ path: "/new-one", methods: "POST", capability: "noSuchCapability" },
		{ path: "/known", methods: "GET", capability: null },
	]);
	assert.deepEqual(caps.undeclaredCapabilities, ["noSuchCapability"]);
	// 缺 capability 字段
	const missingField = diffRegisteredEndpoints(fake, [
		{ path: "/new-one", methods: "POST" },
		{ path: "/known", methods: "GET" },
	]);
	assert.deepEqual(missingField.missingCapabilityField, ["/known", "/new-one"]);
});

test("本次新增的自更新端点已登记（含主机源下发插件包）", () => {
	const paths = REGISTERED_ENDPOINTS.map((e) => e.path);
	for (const p of ["/plugin-update", "/update/manifest", "/update/apk", "/update/plugin"]) {
		assert.ok(paths.includes(p), `${p} 未登记`);
	}
});
