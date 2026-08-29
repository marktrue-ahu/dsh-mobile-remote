import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGitOperationManager } from "../lib/git-operations.js";

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

test("B1 write routes are POST-only and do not shadow GET commit details", () => {
	const source = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
	assert.match(source, /if \(method === "POST" && \["\/git\/change-sets"/);
	assert.ok(source.includes('const gitMatch = /^\\/git\\/(context|status|branches|graph|commit|diff)$/.exec(rest);'));
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
