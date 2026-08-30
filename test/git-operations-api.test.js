import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGitOperationManager } from "../lib/git-operations.js";
import { acceptedOperationResponse } from "../lib/git-write-service.js";

function response() {
	const res = new EventEmitter();
	res.headersSent = false;
	res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers; res.headersSent = true; };
	res.end = (body = "") => { res.body = body; res.emit("finish"); };
	res.write = () => true;
	return res;
}

function request(method, url, body) {
	const req = new EventEmitter();
	req.method = method;
	req.url = url;
	req.headers = { host: "127.0.0.1:3080" };
	req.socket = { remoteAddress: "127.0.0.1" };
	if (body !== undefined) {
		const text = JSON.stringify(body);
		req.headers["content-length"] = String(Buffer.byteLength(text));
		queueMicrotask(() => { req.emit("data", Buffer.from(text)); req.emit("end"); });
	}
	return req;
}

function config() {
	return {
		path: "/m", authToken: "", cookieName: "token", sessionTtlMs: 1000,
		rechargeUrl: "https://example.test", maxConnections: 4, pushUrls: [],
		pushCooldownMs: 1000, doneGraceMs: 1000, pushContent: "minimal",
		rateLimit: { maxFailures: 10, windowMs: 60000, blockMs: 60000 },
		lanBridge: { enabled: false, port: 3080, host: "127.0.0.1" },
	};
}

test("accepted operation DTO is stable and queryable", () => {
	const dto = acceptedOperationResponse({ operationId: "op/1", requestId: "req-12345678", status: "queued", deduplicated: true });
	assert.deepEqual(dto, {
		ok: true, accepted: true, operationId: "op/1", requestId: "req-12345678", status: "queued", deduplicated: true,
		queryUrl: "/git/operations/op%2F1", queryLink: "/git/operations/op%2F1",
		operation: { operationId: "op/1", requestId: "req-12345678", status: "queued", deduplicated: true },
	});
});

test("B2 route contracts are explicit", () => {
	const source = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
	assert.match(source, /action must be create or rename/);
	assert.ok(source.includes('rest === "/git/branch-switch/preflight" ? "switch"'));
	assert.match(source, /acceptedOperationResponse\(value/);
	assert.match(source, /params must be the preflight params object/);
	assert.match(source, /const params = body\.params/);
});

test("B1 write routes are POST-only and do not shadow GET commit details", () => {
	const source = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
	assert.match(source, /if \(method === "POST" && \["\/git\/change-sets"/);
	for (const route of ["/git/branches/preflight", "/git/branches", "/git/branch-switch/preflight", "/git/branch-switch", "/git/branch-rename"]) assert.ok(source.includes(`"${route}"`), `missing B2 route ${route}`);
	assert.ok(source.includes('const gitMatch = /^\\/git\\/(context|status|branches|remotes|graph|commit|diff)$/.exec(rest);'));
});

test("B3 routes require the mobile contract and expose staged sync operations", () => {
	const source = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
	for (const route of ["/git/fetch/preflight", "/git/fetch", "/git/pull/preflight", "/git/pull", "/git/push/preflight", "/git/push", "/git/sync/preflight", "/git/sync", "/git/abort/preflight", "/git/abort", "/git/confirmations"]) assert.ok(source.includes(`"${route}"`), `missing B3 route ${route}`);
	assert.match(source, /requireGitContract\(req, res\)/);
	assert.match(source, /acceptedOperationResponse\(value, `\/git\/operations/);
});

test("B0 operation list is exposed through the mobile API and capabilities", async (t) => {
	let apply;
	try {
		({ apply } = await import("../lib/index.js"));
	} catch (error) {
		if (error?.code === "ERR_MODULE_NOT_FOUND") return t.skip("plugin dependencies are unavailable in this checkout");
		throw error;
	}
	const root = mkdtempSync(join(tmpdir(), "dsh-git-api-"));
	const manager = createGitOperationManager({ filePath: join(root, "operations.log") });
	await manager.start();
	const registrations = [];
	const provided = new Map([["gitOperations", manager]]);
	const ctx = {
		webServer: { port: 3080, register(spec) { registrations.push(spec); return () => {}; } },
		logger: { warn() {}, info() {} },
		get(name) { return provided.get(name); },
		provide(name, value) { provided.set(name, value); },
		on() { return () => {}; },
	};
	let dispose;
	try {
		dispose = apply(ctx, config());
		const route = registrations.find((item) => item.path === "/m/api").handler;
		const listResponse = response();
		const listDone = new Promise((resolve) => listResponse.once("finish", resolve));
		route(request("GET", "/m/api/git/operations"), listResponse);
		await listDone;
		assert.equal(listResponse.statusCode, 200);
		assert.deepEqual(JSON.parse(listResponse.body), { ok: true, operations: [], nextCursor: null });

		const capsResponse = response();
		const capsDone = new Promise((resolve) => capsResponse.once("finish", resolve));
		route(request("GET", "/m/api/git/capabilities"), capsResponse);
		await capsDone;
		const caps = JSON.parse(capsResponse.body);
		assert.equal(caps.ok, true);
		assert.equal(caps.git.operations.operationPersistence, true);
		assert.equal(caps.git.operations.features.operations, true);
	} finally {
		dispose?.();
		manager.stop();
		rmSync(root, { recursive: true, force: true });
	}
});
