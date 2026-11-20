/**
 * GitLab #16：`/m/api/files` 路径安全收口。
 *
 * 目标：文件读取只发生在**当前会话 cwd**（新调用带 sessionId + 相对路径）或
 * **已注册工作区**（旧调用兼容）内；绝对路径、`..`、编码绕过、symlink 逃逸、
 * 目录/设备文件一律拒绝；平台不支持 descriptor-relative 时 fail-closed。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { constants as fsConstants } from "node:fs";
import {
	existsSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, openVerifiedContainedFile } from "../lib/index.js";

const CONFIG = {
	path: "/m",
	authToken: "1234567890123456",
	cookieName: "dsh_mobile_token",
	trustedHosts: [],
	sessionTtlMs: 60_000,
	rechargeUrl: "https://example.test/top-up",
	maxConnections: 4,
	pushUrls: [],
	pushCooldownMs: 1,
	doneGraceMs: 1,
	pushContent: "minimal",
	rateLimit: {},
	lanBridge: { enabled: false, port: 3080, host: "127.0.0.1" },
	approvalMode: "both",
};

class FakeResponse extends EventEmitter {
	constructor() {
		super();
		this.headersSent = false;
		this.statusCode = 0;
		this.headers = {};
		this.chunks = [];
	}
	writeHead(statusCode, headers = {}) {
		this.statusCode = statusCode;
		this.headers = headers;
		this.headersSent = true;
	}
	write(chunk) {
		this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
		return true;
	}
	end(chunk = "") {
		if (chunk !== "") this.write(chunk);
		this.emit("finish");
	}
	destroy() {
		this.destroyed = true;
		this.emit("close");
	}
}

class FakeRequest extends EventEmitter {
	constructor(url, method = "GET", headers = {}) {
		super();
		this.url = url;
		this.method = method;
		this.headers = { host: "127.0.0.1", "x-mobile-token": CONFIG.authToken, ...headers };
		this.socket = { remoteAddress: "127.0.0.1" };
	}
}

function createHarness({ sessions = new Map(), workspaceRoots = [] } = {}) {
	const routes = [];
	const provided = new Map();
	provided.set("sessions", { get: (id) => sessions.get(id) });
	provided.set("workspaceRegistry", { list: () => workspaceRoots.map((path) => ({ path })) });
	const ctx = {
		webServer: { host: "127.0.0.1", port: 43120, register(spec) { routes.push(spec); return () => {}; } },
		logger: { warn() {}, info() {} },
		get(name) { return provided.get(name); },
		provide(name, value) { provided.set(name, value); },
		on() { return () => {}; },
		effect(callback) {
			const disposer = callback?.();
			return typeof disposer === "function" ? disposer : () => {};
		},
		inject() {},
		waterfall: async () => "unavailable",
	};
	const dispose = apply(ctx, CONFIG);
	return {
		route: routes.find((route) => route.path === "/m/api").handler,
		clean() { dispose?.(); },
	};
}

async function call(route, { url, method = "GET", headers = {} } = {}) {
	const req = new FakeRequest(url, method, headers);
	const res = new FakeResponse();
	const finished = new Promise((resolve) => res.once("finish", resolve));
	route(req, res);
	await finished;
	const text = Buffer.concat(res.chunks).toString("utf8");
	let body;
	try { body = JSON.parse(text); } catch { body = text; }
	return { status: res.statusCode, headers: res.headers, body, raw: Buffer.concat(res.chunks), text };
}

function makeWorkspace(name = "wb-path-") {
	const root = mkdtempSync(join(tmpdir(), name));
	mkdirSync(join(root, "sub"));
	writeFileSync(join(root, "README.md"), "hello 世界\n");
	writeFileSync(join(root, "sub", "nested.txt"), "nested\n");
	writeFileSync(join(root, "empty.txt"), "");
	return root;
}

function sessionFor(id, cwd) {
	return { id, header: { cwd } };
}

function filesUrl({ sessionId, path }) {
	const query = [`path=${encodeURIComponent(path)}`];
	if (sessionId !== undefined) query.push(`sessionId=${encodeURIComponent(sessionId)}`);
	return `/m/api/files?${query.join("&")}`;
}

test("session 模式：cwd 内相对路径可下载，Range/HEAD 仍可用", async () => {
	const root = makeWorkspace();
	const harness = createHarness({ sessions: new Map([["s1", sessionFor("s1", root)]]) });
	try {
		const ok = await call(harness.route, { url: filesUrl({ sessionId: "s1", path: "README.md" }) });
		assert.equal(ok.status, 200);
		assert.equal(ok.raw.toString("utf8"), "hello 世界\n");
		assert.equal(ok.headers["connection"], "close");

		const nested = await call(harness.route, { url: filesUrl({ sessionId: "s1", path: "sub/nested.txt" }) });
		assert.equal(nested.status, 200);
		assert.equal(nested.raw.toString("utf8"), "nested\n");

		const range = await call(harness.route, {
			url: filesUrl({ sessionId: "s1", path: "README.md" }),
			headers: { range: "bytes=0-4" },
		});
		assert.equal(range.status, 206);
		assert.equal(range.raw.toString("utf8"), "hello");
		assert.equal(range.headers["content-range"], "bytes 0-4/13");

		const head = await call(harness.route, {
			url: filesUrl({ sessionId: "s1", path: "README.md" }),
			method: "HEAD",
		});
		assert.equal(head.status, 200);
		assert.equal(head.raw.length, 0);
	} finally {
		harness.clean();
	}
});

test("session 模式：绝对路径、..、编码绕过、NUL 一律拒绝", async () => {
	const root = makeWorkspace();
	const harness = createHarness({ sessions: new Map([["s1", sessionFor("s1", root)]]) });
	try {
		const absolute = await call(harness.route, { url: filesUrl({ sessionId: "s1", path: join(root, "README.md") }) });
		assert.equal(absolute.status, 403);
		assert.equal(absolute.body.error, "path-outside-workspace");

		const dotdot = await call(harness.route, { url: filesUrl({ sessionId: "s1", path: "../outside.txt" }) });
		assert.equal(dotdot.status, 403);
		assert.equal(dotdot.body.error, "path-outside-workspace");

		// URL 解码后仍是 `../`，必须在服务端词法层拦住。
		const encoded = await call(harness.route, { url: `/m/api/files?sessionId=s1&path=%2e%2e%2foutside.txt` });
		assert.equal(encoded.status, 403);
		assert.equal(encoded.body.error, "path-outside-workspace");

		const nul = await call(harness.route, { url: `/m/api/files?sessionId=s1&path=README.md%00.png` });
		assert.equal(nul.status, 400);
		assert.equal(nul.body.error, "bad-request");

		const missing = await call(harness.route, { url: "/m/api/files" });
		assert.equal(missing.status, 400);
		assert.equal(missing.body.error, "bad-request");
	} finally {
		harness.clean();
	}
});

test("session 模式：symlink 逃逸、目录、设备文件被拒绝", async (t) => {
	const root = makeWorkspace();
	const outside = makeWorkspace("wb-path-outside-");
	writeFileSync(join(outside, "secret.txt"), "TOP-SECRET\n");
	let linkCreated = true;
	try {
		symlinkSync(join(outside, "secret.txt"), join(root, "leak.txt"));
		symlinkSync(outside, join(root, "leak-dir"));
	} catch (err) {
		linkCreated = false;
		t.skip(`宿主不允许创建符号链接（${err.code}），跳过 symlink 部分`);
	}
	const harness = createHarness({ sessions: new Map([["s1", sessionFor("s1", root)]]) });
	try {
		if (linkCreated) {
			const finalLink = await call(harness.route, { url: filesUrl({ sessionId: "s1", path: "leak.txt" }) });
			assert.equal(finalLink.status, 403);
			assert.equal(finalLink.body.error, "path-outside-workspace");
			assert.ok(!finalLink.text.includes("TOP-SECRET"), "不得泄露链接目标内容");

			const linkDir = await call(harness.route, { url: filesUrl({ sessionId: "s1", path: "leak-dir/secret.txt" }) });
			assert.equal(linkDir.status, 403, "中间目录 symlink 逃逸也必须拒绝");
		}

		const dir = await call(harness.route, { url: filesUrl({ sessionId: "s1", path: "sub" }) });
		assert.equal(dir.status, 400);
		assert.equal(dir.body.error, "not-a-file");

		// /dev/null 是字符设备；把会话 cwd 指向 /dev，确认类型校验先于内容读取。
		if (existsSync("/dev/null")) {
			const devHarness = createHarness({ sessions: new Map([["dev", sessionFor("dev", "/dev")]]) });
			try {
				const dev = await call(devHarness.route, { url: filesUrl({ sessionId: "dev", path: "null" }) });
				assert.equal(dev.status, 400);
				assert.equal(dev.body.error, "not-a-file");
			} finally {
				devHarness.clean();
			}
		}
	} finally {
		harness.clean();
	}
});

test("session 模式：非法/过期会话与跨会话路径拒绝", async () => {
	const root = makeWorkspace();
	const other = makeWorkspace("wb-path-other-");
	writeFileSync(join(other, "other.txt"), "other\n");
	const harness = createHarness({
		sessions: new Map([
			["s1", sessionFor("s1", root)],
			["s2", sessionFor("s2", other)],
		]),
	});
	try {
		const unknown = await call(harness.route, { url: filesUrl({ sessionId: "nope", path: "README.md" }) });
		assert.equal(unknown.status, 404);
		assert.equal(unknown.body.error, "session-not-found");

		const escape = await call(harness.route, { url: filesUrl({ sessionId: "s2", path: "../" + root.split("/").pop() + "/README.md" }) });
		assert.equal(escape.status, 403);
		assert.equal(escape.body.error, "path-outside-workspace");

		const crossAbsolute = await call(harness.route, { url: filesUrl({ sessionId: "s2", path: join(root, "README.md") }) });
		assert.equal(crossAbsolute.status, 403);
	} finally {
		harness.clean();
	}
});

test("旧调用兼容：无 sessionId 仅允许已注册工作区内的绝对路径", async () => {
	const root = makeWorkspace();
	const outside = makeWorkspace("wb-path-unregistered-");
	writeFileSync(join(outside, "secret.txt"), "no\n");
	const harness = createHarness({ workspaceRoots: [root] });
	try {
		const legacyOk = await call(harness.route, { url: filesUrl({ path: join(root, "README.md") }) });
		assert.equal(legacyOk.status, 200);
		assert.equal(legacyOk.raw.toString("utf8"), "hello 世界\n");

		const legacyOutside = await call(harness.route, { url: filesUrl({ path: join(outside, "secret.txt") }) });
		assert.equal(legacyOutside.status, 403);
		assert.equal(legacyOutside.body.error, "path-outside-workspace");

		const relative = await call(harness.route, { url: filesUrl({ path: "README.md" }) });
		assert.equal(relative.status, 400);
		assert.equal(relative.body.error, "session-required");
	} finally {
		harness.clean();
	}
});

test("平台 fail-closed：非 Linux / 无 procfs / 无 O_NOFOLLOW → 503 files-unavailable", () => {
	const root = makeWorkspace();
	const candidateLex = join(root, "README.md");
	const win = openVerifiedContainedFile({ candidateLex, roots: [root], platform: "win32" });
	assert.equal(win.ok, false);
	assert.equal(win.status, 503);
	assert.equal(win.code, "files-unavailable");

	const noProc = openVerifiedContainedFile({
		candidateLex,
		roots: [root],
		platform: "linux",
		fs: {
			existsSync: () => false,
			openSync: () => { throw new Error("must not open"); },
			fstatSync: () => { throw new Error("must not stat"); },
			readlinkSync: () => { throw new Error("must not readlink"); },
			closeSync: () => {},
			constants: fsConstants,
		},
	});
	assert.equal(noProc.status, 503);
	assert.equal(noProc.code, "files-unavailable");
});
