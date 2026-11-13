// issue #96：更新检查快照/总 deadline/异步 checkId 生命周期/去重/缓存 TTL/提交复用。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUpdateCheckService } from "../lib/plugin-update-check.js";
import { resolveNpmUpdateCandidate } from "../lib/npm-update-source.js";
import { createPluginUpdateController } from "../lib/plugin-update-controller.js";

const UPDATE_AVAILABLE = { state: "update-available", reason: "version-newer", candidate: { plugin: { version: "3.2.5" } }, checkedAt: "t" };
const UP_TO_DATE = { state: "up-to-date", reason: "same-version", checkedAt: "t" };
const UNAVAILABLE = { state: "unavailable", reason: "npm-registry-unavailable", checkedAt: "t" };

function deferred() {
	let resolve;
	const promise = new Promise((r) => { resolve = r; });
	return { promise, resolve };
}

test("#96 检查总 deadline：超时返回 check-timeout，不返回半结果", async () => {
	let resolveCheck;
	const service = createUpdateCheckService({
		checkFn: () => new Promise((r) => { resolveCheck = r; }),
		checkTimeoutMs: 40,
	});
	const started = Date.now();
	const result = await service.checkSync();
	assert.equal(result.state, "unavailable");
	assert.equal(result.reason, "check-timeout");
	assert.equal(result.candidate, undefined, "不得返回半结果");
	assert.ok(Date.now() - started < 500);
	resolveCheck(UPDATE_AVAILABLE);
});

test("#96 缓存：成功 5min、force 绕过、invalidate 清空", async () => {
	let now = 0;
	let calls = 0;
	const service = createUpdateCheckService({
		checkFn: async () => { calls += 1; return { ...UPDATE_AVAILABLE }; },
		now: () => now,
		successTtlMs: 1000,
	});
	await service.checkSync();
	await service.checkSync();
	assert.equal(calls, 1);
	now = 1001;
	await service.checkSync();
	assert.equal(calls, 2, "5min 边界过期后重查");
	await service.check({ force: true });
	assert.equal(calls, 3, "force 绕过缓存");
	service.invalidate();
	await service.checkSync();
	assert.equal(calls, 4);
});

test("#96 缓存：失败/unavailable 30s TTL", async () => {
	let now = 0;
	let calls = 0;
	const service = createUpdateCheckService({
		checkFn: async () => { calls += 1; return { ...UNAVAILABLE }; },
		now: () => now,
		failureTtlMs: 100,
	});
	await service.checkSync();
	await service.checkSync();
	assert.equal(calls, 1);
	now = 101;
	await service.checkSync();
	assert.equal(calls, 2, "失败缓存到期后重查");
});

test("#96 缓存 key 含更新源/本地版本：源配置变化后自然失效", async () => {
	let key = "npm|3.2.4";
	let calls = 0;
	const service = createUpdateCheckService({
		checkFn: async () => { calls += 1; return { ...UP_TO_DATE }; },
		cacheKey: () => key,
	});
	await service.checkSync();
	await service.checkSync();
	assert.equal(calls, 1);
	key = "off|3.2.4";
	await service.checkSync();
	assert.equal(calls, 2, "源配置变化必须重新检查");
});

test("#96 异步：POST 形状 checking；checkId 轮询 done；未知 404；同 key in-flight 去重", async () => {
	const gate = deferred();
	let calls = 0;
	const service = createUpdateCheckService({
		checkFn: async () => { calls += 1; return gate.promise; },
	});
	const first = service.startAsync();
	assert.deepEqual(first.state, "checking");
	assert.ok(first.checkId);
	const second = service.startAsync();
	assert.equal(second.checkId, first.checkId, "同 key in-flight 复用");
	await new Promise((r) => setImmediate(r));
	assert.equal(calls, 1);
	assert.deepEqual(service.getAsync(first.checkId).body, { state: "checking", checkId: first.checkId });
	assert.equal(service.getAsync("missing").status, 404);

	gate.resolve(UPDATE_AVAILABLE);
	await new Promise((r) => setImmediate(r));
	const done = service.getAsync(first.checkId);
	assert.equal(done.status, 200);
	assert.equal(done.body.state, "done");
	assert.equal(done.body.result.state, "update-available");
});

test("#96 异步：检查抛错 → error 状态；过期未知/检查超时明确", async () => {
	const service = createUpdateCheckService({
		checkFn: async () => { throw new Error("boom"); },
	});
	const started = service.startAsync();
	await new Promise((r) => setImmediate(r));
	const result = service.getAsync(started.checkId);
	assert.equal(result.body.state, "error");
	assert.equal(result.body.error, "boom");

	const timed = createUpdateCheckService({
		checkFn: () => new Promise(() => {}),
		checkTimeoutMs: 30,
	});
	const t = timed.startAsync();
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(timed.getAsync(t.checkId).body.result.reason, "check-timeout");
});

test("#96 npm resolver：dist-tags 后 plugin/carrier 并行（总耗时接近单次）", async () => {
	const calls = [];
	const packageView = async (spec) => {
		calls.push({ spec, at: Date.now() });
		if (spec === "pkg") return { latest: "3.2.5" };
		await new Promise((r) => setTimeout(r, 60));
		if (spec === "pkg@3.2.5") {
			return {
				version: "3.2.5",
				optionalDependencies: { "pkg-app": "npm:pkg@3.2.5-app" },
				dist: { integrity: "sha512-" + Buffer.from("p").toString("base64") },
			};
		}
		return {
			version: "3.2.5-app",
			appVersion: "3.2.5+47",
			dist: { integrity: "sha512-" + Buffer.from("c").toString("base64") },
		};
	};
	const started = Date.now();
	const result = await resolveNpmUpdateCandidate({ packageName: "pkg", localVersion: "3.2.4", packageView });
	const elapsed = Date.now() - started;
	assert.equal(result.ok, true);
	assert.ok(elapsed < 110, `并行耗时 ${elapsed}ms 应明显小于两次串行 120ms`);
	const pluginCall = calls.find((c) => c.spec === "pkg@3.2.5");
	const carrierCall = calls.find((c) => c.spec === "pkg@3.2.5-app");
	assert.ok(Math.abs(pluginCall.at - carrierCall.at) < 40, "两次 npm view 应并行启动");
});

test("#96 controller submit：复用 5min 快照；targetVersion 不匹配 -> 强制重查", async () => {
	const home = mkdtempSync(join(tmpdir(), "update-check-96-"));
	let views = 0;
	const packageView = async (spec) => {
		views += 1;
		if (spec === "pkg") return { latest: "3.2.4" };
		if (spec === "pkg@3.2.4") {
			return {
				version: "3.2.4",
				optionalDependencies: { "pkg-app": "npm:pkg@3.2.4-app" },
				dist: { integrity: "sha512-" + Buffer.from("p").toString("base64") },
			};
		}
		return {
			version: "3.2.4-app",
			appVersion: "3.2.4+47",
			dist: { integrity: "sha512-" + Buffer.from("c").toString("base64") },
		};
	};
	const status = {};
	const controller = createPluginUpdateController({
		home,
		configValue: "npm",
		profileDir: home,
		packageName: "pkg",
		npmPackageView: packageView,
		capabilities: () => ({ canSelfUpdate: true, updateChannel: "restart" }),
		localVersion: "3.2.4",
		localContentSha256: "",
		status,
		log: () => {},
	});
	try {
		const first = await controller.submit({});
		assert.equal(first.body.action, "none");
		const viewsAfterFirst = views;
		await controller.submit({});
		assert.equal(views, viewsAfterFirst, "5min 快照内 submit 不再查 npm");
		const mismatch = await controller.submit({ targetVersion: "9.9.9" });
		assert.equal(mismatch.status, 409);
		assert.equal(mismatch.body.error, "candidate-changed");
		assert.ok(views > viewsAfterFirst, "targetVersion 不匹配应强制重查一次");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
