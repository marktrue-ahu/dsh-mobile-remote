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

test("每条登记项要么关联真实能力键，要么给出显式豁免理由（G2）", () => {
	const { missingCapabilityField, missingExemption, undeclaredCapabilities } = diffRegisteredEndpoints(source);
	assert.deepEqual(missingCapabilityField, [], `缺少 capability 字段：${missingCapabilityField.join(", ")}`);
	assert.deepEqual(missingExemption, [], `既没能力键也没豁免理由：${missingExemption.join(", ")}`);
	assert.deepEqual(undeclaredCapabilities, [], `登记了未声明的能力键：${undeclaredCapabilities.join(", ")}`);
});

test("负向变异（真实源码）：删掉 bootstrap 的 eventTimeline 声明 → 必须报错（G2）", () => {
	// 在**真实源码副本**上变异，且必须打在 bootstrap 那处——SSE hello 里有一模一样的
	// `capabilities: { eventTimeline: ... }`，打错地方等于没测（这正是 G2 指出的问题）。
	const bootAt = source.search(/rest\s*===\s*["']\/bootstrap["']/);
	assert.ok(bootAt > 0, "找不到 bootstrap 分派");
	const mutated = source.slice(0, bootAt) + source.slice(bootAt).replace(/capabilities:\s*\{\s*eventTimeline:/, "capabilities: {");
	assert.notEqual(mutated, source, "变异没生效：bootstrap 的能力声明结构变了");
	assert.deepEqual(diffRegisteredEndpoints(mutated).undeclaredCapabilities, ["eventTimeline"]);

	// 只改 SSE hello 那处：抽取必须**不受影响**，否则说明抽错了块
	const helloMutated = source.replace(/capabilities:\s*\{\s*eventTimeline:/, "capabilities: {");
	assert.notEqual(helloMutated, source);
	assert.deepEqual(diffRegisteredEndpoints(helloMutated).undeclaredCapabilities, []);
});

test("能力抽取只认 bootstrap 块，不会被 SSE hello 的 capabilities 骗到（G2）", () => {
	// 源码里 hello 的 capabilities 出现在 bootstrap 之前时，抽取仍必须取 bootstrap 的
	const fake = `
		const hello = { capabilities: { sseOnly: true } };
		if (rest === "/bootstrap") {
			sendJson(res, 200, { ok: true, capabilities: { eventTimeline: X, turnOutline: Y } });
		}
	`;
	const declared = extractDeclaredCapabilities(fake);
	assert.equal(declared.has("sseOnly"), false, "不该抽到 hello 的能力");
	assert.ok(declared.has("eventTimeline"));
	assert.ok(declared.has("turnOutline"));
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

test("#35 下载面鉴权属性：/update/apk 是唯一匿名例外，其余 update 路由必须鉴权", () => {
	const byPath = new Map(REGISTERED_ENDPOINTS.map((entry) => [entry.path, entry]));
	assert.equal(byPath.get("/update/apk").auth, "anonymous");
	assert.equal(byPath.get("/update/apk").methods, "GET");
	assert.equal(byPath.get("/update/manifest").auth, "required");
	assert.equal(byPath.get("/update/plugin").auth, "required");
	// 本机特权入口：无需移动口令，但只允许受信本机来源（不是远程控制豁免）。
	assert.equal(byPath.get("/qr-config").auth, "local-privileged");
	// 除这三条以外的移动端端点一律不得登记成匿名（防止有人扩大匿名范围）。
	const anonymous = REGISTERED_ENDPOINTS.filter((entry) => entry.auth === "anonymous").map((entry) => entry.path);
	assert.deepEqual(anonymous, ["/update/apk"]);
});

test("本次新增的自更新端点已登记（含主机源下发插件包）", () => {
	const paths = REGISTERED_ENDPOINTS.map((e) => e.path);
	for (const p of ["/plugin-update", "/update/manifest", "/update/apk", "/update/plugin"]) {
		assert.ok(paths.includes(p), `${p} 未登记`);
	}
});
