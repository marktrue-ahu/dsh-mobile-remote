import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { zstdDecompressSync } from "node:zlib";
import test from "node:test";

import { LARGE_FIXTURE_BYTES, writeSessionCorpusFixtures, writeSessionLogFixture } from "./helpers/session-log-fixtures.mjs";

let apply;
let testHome;

test.before(async () => {
	testHome = await mkdtemp(join(tmpdir(), "dsh-session-title-refresh-home-"));
	process.env.HOME = testHome;
	({ apply } = await import("../lib/index.js"));
});

test.after(async () => {
	await rm(testHome, { recursive: true, force: true });
});

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
	approvalMode: "mobile",
};

const deferred = () => {
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
};

const waitFor = async (predicate, message, timeoutMs = 10_000) => {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail(typeof message === "function" ? message() : message);
};

const delay = (ms, signal) => new Promise((resolve, reject) => {
	if (signal?.aborted) return reject(signal.reason);
	const timer = setTimeout(done, ms);
	function done() {
		signal?.removeEventListener("abort", aborted);
		resolve();
	}
	function aborted() {
		clearTimeout(timer);
		signal?.removeEventListener("abort", aborted);
		reject(signal.reason);
	}
	signal?.addEventListener("abort", aborted, { once: true });
});

class FakeResponse extends EventEmitter {
	constructor() {
		super();
		this.headersSent = false;
		this.chunks = [];
	}
	writeHead(statusCode) {
		this.statusCode = statusCode;
		this.headersSent = true;
	}
	write(chunk) {
		this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
		return true;
	}
	end(chunk = "") {
		if (chunk !== "") this.chunks.push(String(chunk));
		this.writableEnded = true;
		this.emit("finish");
	}
	destroy() {
		this.destroyed = true;
		this.emit("close");
	}
}

class FakeRequest extends EventEmitter {
	constructor(url) {
		super();
		this.url = url;
		this.method = "GET";
		this.headers = { host: "127.0.0.1", "x-mobile-token": CONFIG.authToken };
		this.socket = { remoteAddress: "127.0.0.1" };
		this.complete = true;
		this.readable = true;
		this.destroyed = false;
	}
}

const parseFixtureTitle = (raw, fixture) => {
	const plaintextFrames = [];
	let offset = 0;
	for (const frameLength of fixture.frameLengths) {
		const end = offset + frameLength;
		plaintextFrames.push(zstdDecompressSync(raw.subarray(offset, end)));
		offset = end;
	}
	assert.equal(offset, raw.byteLength, `fixture ${fixture.id} frame index must cover its artifact`);
	const rows = Buffer.concat(plaintextFrames).toString("utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
	const header = rows[0];
	const titleEvent = rows.findLast((row) => row.type === "session/title");
	return { header, title: titleEvent?.data?.title ?? null };
};

function createHarness(fixtures, {
	statDelayMs = () => 0,
	revisionListDelayMs = () => 0,
	listDelayMs = () => 0,
	listNeverSettles = false,
	beforeTitleRead,
	persistenceRoot = fixtures[0]?.root,
	persistenceName = "session-persistence-jsonl",
	persistenceCompression = "zstd",
} = {}) {
	const routes = [];
	const handlers = [];
	const logs = [];
	const fixtureById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
	const historicalRevision = createHash("sha256")
		.update(fixtures.map(({ file, sizeBytes }) => `${file}\\0${sizeBytes}`).sort().join("\\n"))
		.digest("hex");
	const records = fixtures.map((fixture) => ({
		header: { ...fixture.header },
		live: false,
		persisted: true,
	}));
	const listCalls = { count: 0 };
	const revisionLists = { count: 0 };
	const statCalls = { ids: new Set(), revisions: new Map() };
	const readCalls = { batches: 0, sessions: 0, ids: [], titles: new Map(), aborted: 0, signals: [] };
	const provided = new Map();
	const sessions = new Map();
	provided.set("sessions", { get: (id) => sessions.get(id), list: () => [...sessions.values()] });
	const persistenceSnapshot = async (id, signal) => {
		signal?.throwIfAborted();
		const fixture = fixtureById.get(id);
		if (!fixture) return undefined;
		const statDelay = statDelayMs();
		if (statDelay > 0) await delay(statDelay, signal);
		const metadata = await stat(fixture.file, { bigint: true });
		signal?.throwIfAborted();
		const fileRevision = [metadata.dev, metadata.ino, metadata.size, metadata.mtimeNs, metadata.ctimeNs].join(":");
		const revision = fixture.version === 3 ? `${fileRevision}:${historicalRevision}` : fileRevision;
		statCalls.ids.add(id);
		statCalls.revisions.set(id, revision);
		return { header: fixture.header, revision, sizeBytes: Number(metadata.size) };
	};
	provided.set("sessionPersistence", {
		name: persistenceName,
		config: { root: persistenceRoot, compression: persistenceCompression },
		async list({ signal } = {}) {
			revisionLists.count += 1;
			const listingDelay = revisionListDelayMs();
			if (listingDelay > 0) await delay(listingDelay, signal);
			const snapshots = [];
			for (const fixture of fixtures) {
				const snapshot = await persistenceSnapshot(fixture.id, signal);
				if (snapshot) snapshots.push(snapshot);
			}
			return snapshots;
		},
		async stat(id, { signal } = {}) {
			return persistenceSnapshot(id, signal);
		},
	});
	provided.set("sessionQuery", {
		async listSessions(signal) {
			listCalls.count += 1;
			signal?.throwIfAborted();
			if (listNeverSettles) return new Promise(() => {});
			const listingDelay = listDelayMs();
			if (listingDelay > 0) await delay(listingDelay, signal);
			return records;
		},
		async readTitleSnapshots(ids, signal) {
			readCalls.batches += 1;
			readCalls.signals.push(signal);
			try {
				await beforeTitleRead?.(ids, signal);
				const results = await Promise.all(ids.map(async (id) => {
					signal?.throwIfAborted();
					const fixture = fixtureById.get(id);
					if (!fixture) return { sessionId: id, status: "rejected" };
					const raw = await readFile(fixture.file, { signal });
					signal?.throwIfAborted();
					readCalls.sessions += 1;
					readCalls.ids.push(id);
					const parsed = parseFixtureTitle(raw, fixture);
					readCalls.titles.set(id, parsed.title);
					return {
						sessionId: id,
						status: "fulfilled",
						value: {
							session: parsed.header,
							...(parsed.title ? { title: { title: parsed.title } } : {}),
						},
					};
				}));
				return results;
			} catch (error) {
				if (signal?.aborted) readCalls.aborted += 1;
				throw error;
			}
		},
	});
	const ctx = {
		webServer: { host: "127.0.0.1", port: 43120, register(spec) { routes.push(spec); return () => {}; } },
		logger: { warn(...args) { logs.push(args.join(" ")); }, info() {} },
		get(name) { return provided.get(name); },
		provide(name, value) { provided.set(name, value); },
		on(event, handler) { handlers.push([event, handler]); return () => {}; },
		effect(callback) {
			const disposer = callback?.();
			return typeof disposer === "function" ? disposer : () => {};
		},
		inject() {},
	};
	const dispose = apply(ctx, CONFIG);
	return {
		route: routes.find((route) => route.path === "/m/api").handler,
		records,
		listCalls,
		revisionLists,
		statCalls,
		readCalls,
		logs,
		clean() { dispose?.(); },
	};
}

function startRequest(route, url = "/m/api/sessions") {
	const req = new FakeRequest(url);
	const res = new FakeResponse();
	const finished = new Promise((resolve) => res.once("finish", () => {
		resolve({ status: res.statusCode, body: JSON.parse(res.chunks.join("") || "{}") });
	}));
	route(req, res);
	return { req, res, finished };
}

const request = async (route, url) => startRequest(route, url).finished;

test("真实 V3/V4 日志与 20 MiB 会话：首屏有界，预热后重启仍命中且不重读日志", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "session-title-refresh-home-"));
	const root = await mkdtemp(join(tmpdir(), "session-title-real-logs-"));
	process.env.HOME = home;
	let harness;
	t.after(async () => {
		harness?.clean();
		await rm(home, { recursive: true, force: true });
		await rm(root, { recursive: true, force: true });
	});
	const fixtures = writeSessionCorpusFixtures(root, { count: 28, largePayloadBytes: LARGE_FIXTURE_BYTES });
	const large = fixtures.find((fixture) => fixture.id === "fixture-large-v4");
	assert.ok(large.sizeBytes >= LARGE_FIXTURE_BYTES, `large fixture has ${large.sizeBytes} bytes`);
	assert.ok(fixtures.some((fixture) => fixture.version === 3));
	assert.ok(fixtures.some((fixture) => fixture.version === 4));
	harness = createHarness(fixtures);
	const startedAt = performance.now();
	const first = await request(harness.route);
	const elapsedMs = performance.now() - startedAt;
	assert.equal(first.status, 200);
	assert.equal(first.body.sessions.length, fixtures.length, "partial title work must not truncate the session list");
	assert.ok(elapsedMs < 2000, `first response took ${elapsedMs.toFixed(1)} ms`);
	await waitFor(() => harness.readCalls.sessions === fixtures.length, "background warm-up did not finish all fixture logs");
	await new Promise((resolve) => setImmediate(resolve)); // let the coordinator commit the final batch result
	assert.equal(harness.readCalls.sessions, fixtures.length, "each cold title log is read once");
	assert.equal(harness.revisionLists.count, 1, "one corpus revision listing must serve the whole refresh pass");
	assert.equal(harness.readCalls.titles.get(large.id), large.title, "fixture reader must extract the large log title");
	assert.ok(harness.statCalls.revisions.get(large.id), "large session must produce a usable revision");
	const cachePath = join(home, ".dsh", "mobile-remote", "session-titles.json");
	let cachedIds = [];
	await waitFor(async () => {
		try {
			const current = JSON.parse(await readFile(cachePath, "utf8"));
			cachedIds = Object.keys(current.entries);
			return current.entries[large.id]?.title === large.title;
		} catch {
			return false;
		}
	}, () => `large title was not durably flushed; ids=${cachedIds.join(",")} revision=${harness.statCalls.revisions.get(large.id)}`);
	harness.clean(); // flush the persistent cache before simulating a host restart
	harness = null;
	const persisted = JSON.parse(await readFile(cachePath, "utf8"));
	assert.equal(persisted.entries[large.id]?.title, large.title, `large-session title missing; cached ids: ${Object.keys(persisted.entries).join(",")}`);

	harness = createHarness(fixtures);
	const second = await request(harness.route);
	assert.equal(second.status, 200);
	assert.equal(second.body.sessions.length, fixtures.length);
	const byId = new Map(second.body.sessions.map((row) => [row.id, row]));
	for (const fixture of fixtures) assert.equal(byId.get(fixture.id)?.title, fixture.title, `title for ${fixture.id}`);
	assert.equal(harness.readCalls.sessions, 0, `same revisions after restart must not trigger new log reads: ${harness.readCalls.ids.join(",")}`);
	assert.equal(harness.revisionLists.count, 1, "all revision reads on a refresh pass use one snapshot listing");
	harness.clean();
	harness = null;

	const changedFixture = writeSessionLogFixture(root, {
		id: "fixture-1",
		version: 4,
		title: "Changed V4 title",
		createdAt: fixtures.find((fixture) => fixture.id === "fixture-1").header.createdAt,
	});
	const changedFixtures = fixtures.map((fixture) => fixture.id === changedFixture.id ? changedFixture : fixture);
	harness = createHarness(changedFixtures);
	const changed = await request(harness.route);
	const changedById = new Map(changed.body.sessions.map((row) => [row.id, row]));
	assert.equal(changedById.get(changedFixture.id)?.title, changedFixture.title);
	assert.equal(
		harness.readCalls.sessions,
		fixtures.filter((fixture) => fixture.version === 3).length + 1,
		"V3's corpus-wide revision conservatively invalidates old titles, plus the changed V4 session",
	);
	harness.clean();
	harness = null;
});

test("354 个 V3/V4 会话冷请求仍完整返回且只取一次批量 revision 快照", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "session-title-refresh-home-"));
	const root = await mkdtemp(join(tmpdir(), "session-title-scale-354-"));
	process.env.HOME = home;
	let harness;
	t.after(async () => {
		harness?.clean();
		await rm(home, { recursive: true, force: true });
		await rm(root, { recursive: true, force: true });
	});
	const fixtures = writeSessionCorpusFixtures(root, { count: 353, largePayloadBytes: 0 });
	assert.equal(fixtures.length, 354);
	harness = createHarness(fixtures);
	const startedAt = performance.now();
	const result = await request(harness.route);
	const elapsedMs = performance.now() - startedAt;
	assert.equal(result.status, 200);
	assert.equal(result.body.sessions.length, 354, "cold title folding must not truncate the corpus response");
	assert.ok(elapsedMs < 2000, `354-session response took ${elapsedMs.toFixed(1)} ms`);
	await waitFor(() => harness.readCalls.sessions === fixtures.length, "354-session background warm-up did not finish");
	assert.equal(harness.revisionLists.count, 1, "all session revisions must come from one bulk snapshot");
});

test("跨重启标题缓存按 JSONL 根目录隔离", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "session-title-refresh-home-"));
	const root = await mkdtemp(join(tmpdir(), "session-title-root-scope-"));
	process.env.HOME = home;
	let harness;
	t.after(async () => {
		harness?.clean();
		await rm(home, { recursive: true, force: true });
		await rm(root, { recursive: true, force: true });
	});
	const fixtures = writeSessionCorpusFixtures(root, { count: 2, largePayloadBytes: 0 });
	harness = createHarness(fixtures);
	await request(harness.route);
	harness.clean();
	harness = null;

	harness = createHarness(fixtures, { persistenceRoot: join(root, "other-store") });
	const result = await request(harness.route);
	assert.equal(result.status, 200);
	assert.equal(harness.readCalls.sessions, fixtures.length, "a different JSONL root must not reuse another store's opaque revisions");
	harness.clean();
	harness = null;

	harness = createHarness(fixtures, { persistenceName: "unknown-session-persistence" });
	const unsupported = await request(harness.route);
	assert.equal(unsupported.status, 200);
	assert.equal(harness.readCalls.sessions, fixtures.length, "unknown providers must not reuse opaque tokens across restarts");
	harness.clean();
	harness = null;
});

test("/sessions 标题预算包含完整语料枚举耗时", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "session-title-refresh-home-"));
	const root = await mkdtemp(join(tmpdir(), "session-title-list-budget-"));
	process.env.HOME = home;
	let harness;
	t.after(async () => {
		harness?.clean();
		await rm(home, { recursive: true, force: true });
		await rm(root, { recursive: true, force: true });
	});
	const fixtures = writeSessionCorpusFixtures(root, { count: 20, largePayloadBytes: 0 });
	harness = createHarness(fixtures, {
		listDelayMs: () => 900,
		revisionListDelayMs: () => 1400,
	});
	const startedAt = performance.now();
	const result = await request(harness.route);
	const elapsedMs = performance.now() - startedAt;
	assert.equal(result.status, 200);
	assert.equal(result.body.sessions.length, fixtures.length);
	assert.ok(elapsedMs < 2000, `list + bounded title wait took ${elapsedMs.toFixed(1)} ms`);
});

test("/subagents 标题预算同样包含完整语料枚举耗时", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "session-title-refresh-home-"));
	const root = await mkdtemp(join(tmpdir(), "session-title-subagent-budget-"));
	process.env.HOME = home;
	let harness;
	t.after(async () => {
		harness?.clean();
		await rm(home, { recursive: true, force: true });
		await rm(root, { recursive: true, force: true });
	});
	const fixtures = writeSessionCorpusFixtures(root, { count: 20, largePayloadBytes: 0 });
	harness = createHarness(fixtures, {
		listDelayMs: () => 900,
		revisionListDelayMs: () => 1400,
	});
	for (const record of harness.records.slice(1)) {
		record.header.origin = "subagent";
		record.header.parentSession = fixtures[0].id;
	}
	const startedAt = performance.now();
	const result = await request(harness.route, `/m/api/subagents?parentSessionId=${encodeURIComponent(fixtures[0].id)}`);
	const elapsedMs = performance.now() - startedAt;
	assert.equal(result.status, 200);
	assert.equal(result.body.subagents.length, fixtures.length - 1);
	assert.ok(elapsedMs < 2000, `subagent enumeration + title wait took ${elapsedMs.toFixed(1)} ms`);
});

test("语料枚举超过总预算时 /sessions 与 /subagents 明确返回超时", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "session-title-refresh-home-"));
	const root = await mkdtemp(join(tmpdir(), "session-title-enumeration-timeout-"));
	process.env.HOME = home;
	let harness;
	t.after(async () => {
		harness?.clean();
		await rm(home, { recursive: true, force: true });
		await rm(root, { recursive: true, force: true });
	});
	const fixtures = writeSessionCorpusFixtures(root, { count: 2, largePayloadBytes: 0 });
	harness = createHarness(fixtures, { listNeverSettles: true });
	let startedAt = performance.now();
	let result = await request(harness.route);
	assert.equal(result.status, 504);
	assert.equal(result.body.error, "sessions-timeout");
	assert.ok(performance.now() - startedAt < 2000, "slow /sessions enumeration must not hang the sole entry point");
	harness.clean();
	harness = createHarness(fixtures, { listDelayMs: () => 5_000 });
	startedAt = performance.now();
	result = await request(harness.route, `/m/api/subagents?parentSessionId=${encodeURIComponent(fixtures[0].id)}`);
	assert.equal(result.status, 504);
	assert.equal(result.body.error, "subagents-timeout");
	assert.ok(performance.now() - startedAt < 2000, "slow persisted subagent enumeration must fail clearly too");
});

test("并发 /sessions 共享同一标题折叠；一个客户端断开不取消另一个", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "session-title-refresh-home-"));
	const root = await mkdtemp(join(tmpdir(), "session-title-concurrent-"));
	process.env.HOME = home;
	let harness;
	t.after(async () => {
		harness?.clean();
		await rm(home, { recursive: true, force: true });
		await rm(root, { recursive: true, force: true });
	});
	const fixtures = writeSessionCorpusFixtures(root, { count: 4, largePayloadBytes: 0 });
	const readStarted = deferred();
	const finishRead = deferred();
	let internalSignal;
	harness = createHarness(fixtures, {
		beforeTitleRead: async (_ids, signal) => {
			internalSignal = signal;
			readStarted.resolve();
			await new Promise((resolve, reject) => {
				if (signal.aborted) return reject(signal.reason);
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				finishRead.promise.then(resolve, reject);
			});
		},
	});
	const first = startRequest(harness.route);
	await readStarted.promise;
	const second = startRequest(harness.route);
	await waitFor(() => harness.listCalls.count === 2, "second list request did not join");
	await new Promise((resolve) => setImmediate(resolve));
	first.res.destroy();
	assert.equal(internalSignal.aborted, false, "one disconnected waiter must not kill shared work");
	finishRead.resolve();
	const secondResult = await second.finished;
	assert.equal(secondResult.status, 200);
	assert.equal(secondResult.body.sessions.length, fixtures.length);
	assert.equal(harness.readCalls.batches, 2, "five sessions should fold in two bounded batches, not once per HTTP request");
	assert.equal(harness.revisionLists.count, 1, "overlapping requests share one corpus revision snapshot");
	assert.equal(harness.readCalls.sessions, fixtures.length);
});

test("最后一个 /sessions 等待者断开后取消上游标题读取", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "session-title-refresh-home-"));
	const root = await mkdtemp(join(tmpdir(), "session-title-cancel-"));
	process.env.HOME = home;
	let harness;
	t.after(async () => {
		harness?.clean();
		await rm(home, { recursive: true, force: true });
		await rm(root, { recursive: true, force: true });
	});
	const fixtures = writeSessionCorpusFixtures(root, { count: 2, largePayloadBytes: 0 });
	const readStarted = deferred();
	let internalSignal;
	harness = createHarness(fixtures, {
		beforeTitleRead: async (_ids, signal) => {
			internalSignal = signal;
			readStarted.resolve();
			await new Promise((resolve, reject) => {
				if (signal.aborted) return reject(signal.reason);
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				resolve();
			});
		},
	});
	const pending = startRequest(harness.route);
	await readStarted.promise;
	pending.res.destroy();
	await waitFor(() => internalSignal.aborted, "last request cancellation did not reach title read");
	await waitFor(() => harness.readCalls.aborted === 1, "aborted title read did not settle");
	assert.equal(harness.readCalls.sessions, 0, "no fixture event rows should be parsed after abort");
	assert.deepEqual(pending.res.chunks, [], "cancelled request must not write a response");
});

test("休眠父会话的子代理列表复用 revision 标题缓存", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "session-title-refresh-home-"));
	const root = await mkdtemp(join(tmpdir(), "session-title-subagents-"));
	process.env.HOME = home;
	let harness;
	t.after(async () => {
		harness?.clean();
		await rm(home, { recursive: true, force: true });
		await rm(root, { recursive: true, force: true });
	});
	const fixtures = writeSessionCorpusFixtures(root, { count: 2, largePayloadBytes: 0 });
	harness = createHarness(fixtures);
	harness.records[1].header.origin = "subagent";
	harness.records[1].header.parentSession = fixtures[0].id;
	const result = await request(harness.route, `/m/api/subagents?parentSessionId=${encodeURIComponent(fixtures[0].id)}`);
	assert.equal(result.status, 200);
	assert.equal(result.body.parentAvailable, false);
	assert.equal(result.body.subagents.length, 1);
	assert.equal(result.body.subagents[0].title, fixtures[1].title);
	assert.equal(harness.readCalls.sessions, 1);
});
