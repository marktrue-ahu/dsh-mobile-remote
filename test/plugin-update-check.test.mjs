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

function createCheckServiceTimeout() {
	return createUpdateCheckService({
		checkFn: () => new Promise(() => {}),
		checkTimeoutMs: 30,
	});
}

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

test("#96 review P2：checkFn 任意异常脱敏为失败缓存，async done 返回完整结果", async () => {
	let calls = 0;
	const service = createUpdateCheckService({
		checkFn: async () => { calls += 1; throw new Error("/secret/path boom"); },
	});
	const first = await service.checkSync();
	assert.equal(first.state, "unavailable");
	assert.equal(first.reason, "check-failed");
	assert.ok(!JSON.stringify(first).includes("/secret/path"), "不得泄露 error.message");
	const second = await service.checkSync();
	assert.deepEqual(second, first, "失败缓存命中必须返回完整结果，不能 null");
	assert.equal(calls, 1, "失败缓存命中不得重复 checkFn");

	const started = service.startAsync();
	await new Promise((r) => setImmediate(r));
	const done = service.getAsync(started.checkId);
	assert.equal(done.body.state, "done");
	assert.equal(done.body.result.reason, "check-failed", "async done 不得为 null");

	const timed = createCheckServiceTimeout();
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

test("#96 review：bootstrap checkSync 与立即 force 共享同一 in-flight（npm view 只跑一次）", async () => {
	let calls = 0;
	const service = createUpdateCheckService({
		checkFn: async () => { calls += 1; await new Promise((r) => setTimeout(r, 50)); return { ...UP_TO_DATE }; },
	});
	const bootstrap = service.checkSync();
	const forced = service.check({ force: true });
	const [a, b] = await Promise.all([bootstrap, forced]);
	assert.deepEqual(a, b);
	assert.equal(calls, 1, "bootstrap 与立即 force 不得各跑一遍 npm");
});

test("#96 review：invalidate 清 tasks/in-flight，旧 checkId 不再 done", async () => {
	const service = createUpdateCheckService({
		checkFn: async () => ({ ...UP_TO_DATE }),
	});
	const started = service.startAsync();
	await new Promise((r) => setImmediate(r));
	assert.equal(service.getAsync(started.checkId).body.state, "done");
	service.invalidate();
	assert.equal(service.getAsync(started.checkId).status, 404, "旧 checkId 必须失效");

	const slow = createUpdateCheckService({
		checkFn: () => new Promise(() => {}),
		checkTimeoutMs: 5000,
	});
	const pending = slow.startAsync();
	slow.invalidate();
	const fresh = slow.startAsync();
	assert.notEqual(fresh.checkId, pending.checkId, "invalidate 后不得复用旧 in-flight");
});

test("#96 review P1：failureCache 命中返回完整结果（不 null）；成功->失败->过期恢复", async () => {
	let now = 0;
	let calls = 0;
	let mode = "success";
	const service = createUpdateCheckService({
		checkFn: async () => {
			calls += 1;
			if (mode === "throw") throw new Error("boom");
			return { ...UPDATE_AVAILABLE };
		},
		now: () => now,
		successTtlMs: 1000,
		failureTtlMs: 100,
	});
	assert.equal((await service.checkSync()).state, "update-available");
	mode = "throw";
	const failed = await service.check({ force: true });
	assert.equal(failed.reason, "check-failed");
	const cachedFailure = await service.checkSync();
	assert.deepEqual(cachedFailure, failed, "失败缓存命中必须返回同一完整结果");
	assert.equal(calls, 2);
	now = 101; // 失败 TTL 过期
	mode = "success";
	const recovered = await service.checkSync();
	assert.equal(recovered.state, "update-available");
	assert.equal(calls, 3);
});

test("#96 review P1：invalidate 后旧在途完成（晚于新）不得污染，旧调用方拿到非 null stale", async () => {
	let calls = 0;
	const gates = [];
	const service = createUpdateCheckService({
		checkFn: () => {
			const gate = deferred();
			gates.push(gate);
			calls += 1;
			return gate.promise;
		},
	});
	const oldPromise = service.checkSync();
	await new Promise((r) => setImmediate(r));
	assert.equal(calls, 1);
	service.invalidate();
	const newPromise = service.checkSync();
	await new Promise((r) => setImmediate(r));
	assert.equal(calls, 2);
	// 旧完成晚于新：旧结果必须被丢弃。
	gates[1].resolve({ ...UP_TO_DATE });
	assert.equal((await newPromise).state, "up-to-date");
	gates[0].resolve({ ...UPDATE_AVAILABLE });
	const oldResult = await oldPromise;
	assert.equal(oldResult.state, "unavailable");
	assert.equal(oldResult.reason, "check-stale");
	const cached = await service.checkSync();
	assert.equal(cached.state, "up-to-date", "旧完成不得回填快照");
});

test("#96 review P1：invalidate 后旧在途完成（早于新）同样不回填", async () => {
	const gates = [];
	const service = createUpdateCheckService({
		checkFn: () => {
			const gate = deferred();
			gates.push(gate);
			return gate.promise;
		},
	});
	const oldPromise = service.checkSync();
	await new Promise((r) => setImmediate(r));
	service.invalidate();
	const newPromise = service.checkSync();
	await new Promise((r) => setImmediate(r));
	gates[0].resolve({ ...UPDATE_AVAILABLE }); // 旧先完成
	const oldResult = await oldPromise;
	assert.equal(oldResult.reason, "check-stale");
	gates[1].resolve({ ...UP_TO_DATE });
	assert.equal((await newPromise).state, "up-to-date");
	assert.equal((await service.checkSync()).state, "up-to-date", "旧成功不得覆盖新快照");
});

test("#96 review P2：连续 checkFn throw 只跑一次；TTL 后恢复成功", async () => {
	let now = 0;
	let calls = 0;
	let mode = "throw";
	const service = createUpdateCheckService({
		checkFn: async () => {
			calls += 1;
			if (mode === "throw") throw new Error("secret path /x");
			return { ...UP_TO_DATE };
		},
		now: () => now,
		failureTtlMs: 100,
	});
	const first = await service.checkSync();
	assert.equal(first.reason, "check-failed");
	assert.equal(JSON.stringify(first).includes("/x"), false);
	const second = await service.checkSync();
	assert.deepEqual(second, first);
	assert.equal(calls, 1, "失败缓存内不得再次出网");
	now = 101;
	mode = "success";
	assert.equal((await service.checkSync()).state, "up-to-date");
	assert.equal(calls, 2);
});

test("#96 review P2：submit 在检查 outage/timeout 时返回 503 check-unavailable，不误判 candidate-changed", async () => {
	const home = mkdtempSync(join(tmpdir(), "update-check-outage-"));
	try {
		let views = 0;
		const outage = createPluginUpdateController({
			home,
			configValue: "npm",
			profileDir: home,
			packageName: "pkg",
			npmPackageView: async () => { views += 1; throw new Error("registry down"); },
			capabilities: () => ({ canSelfUpdate: true, updateChannel: "restart" }),
			localVersion: "3.2.4",
			localContentSha256: "",
			status: {},
			log: () => {},
			checkFailureTtlMs: 0,
		});
		const r = await outage.submit({ targetVersion: "3.2.5" });
		assert.equal(r.status, 503);
		assert.equal(r.body.error, "check-unavailable");
		assert.equal(r.body.check.state, "unavailable");
		assert.equal(views, 1, "检查失败后不得因 targetVersion 再强制重查");
	} finally { rmSync(home, { recursive: true, force: true }); }

	const home2 = mkdtempSync(join(tmpdir(), "update-check-timeout-"));
	try {
		const timeout = createPluginUpdateController({
			home: home2,
			configValue: "npm",
			profileDir: home2,
			packageName: "pkg",
			npmPackageView: () => new Promise(() => {}),
			capabilities: () => ({ canSelfUpdate: true, updateChannel: "restart" }),
			localVersion: "3.2.4",
			localContentSha256: "",
			status: {},
			log: () => {},
			checkTimeoutMs: 30,
		});
		const r = await timeout.submit({ targetVersion: "3.2.5" });
		assert.equal(r.status, 503);
		assert.equal(r.body.error, "check-unavailable");
		assert.equal(r.body.reason, "check-timeout");
	} finally { rmSync(home2, { recursive: true, force: true }); }
});
