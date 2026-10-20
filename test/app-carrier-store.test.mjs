// App 载体托管区（lib/app-carrier-store.js）的对外契约测试。
//
// 只测外部可观察行为：布局/所有权、提交协议（暂存 → 校验 → 不可变对象 → 原子指针）、
// profile 隔离、releaseId/v1 固定向量、24h 保留与 GC（含租约/句柄保护、profile 存活性、
// 遗弃指针墓碑）、稳定状态语义与提交锁顺序。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as store from "../lib/app-carrier-store.js";

// ── 固定测试向量（P0 契约，禁止随实现"顺手重算"）─────────────────────────────
// 这些值冻结了 releaseId/v1 的规范序列化（字段顺序 + 归一化规则）。任何顺序/归一化变化
// 都会让向量失配——此时必须新增 `releaseId/v2` 前缀，而不是改这些期望值。

const VECTOR_1 = {
	app: {
		version: "3.2.0+7",
		file: "DSH-Remote-v3.2.0+7.apk",
		size: 15,
		sha256: "b85d672c8f1b917c585b3349a994fa2e387ba43fe7eeafa86415c712cd80983d",
	},
	plugin: {
		version: "3.2.0",
		file: "dsh-mobile-remote-v3.2.0.tgz",
		size: 18,
		sha256: "c6c3cbd4b4a9a733a084fc8066f2a4e5581045a869ec0afcb71a8fd1d614d535",
		contentSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
	},
};
const VECTOR_1_CANONICAL =
	'releaseId/v1\n{"app":{"version":"3.2.0+7","file":"DSH-Remote-v3.2.0+7.apk","size":15,"sha256":"b85d672c8f1b917c585b3349a994fa2e387ba43fe7eeafa86415c712cd80983d"},"plugin":{"version":"3.2.0","file":"dsh-mobile-remote-v3.2.0.tgz","size":18,"sha256":"c6c3cbd4b4a9a733a084fc8066f2a4e5581045a869ec0afcb71a8fd1d614d535","contentSha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}}';
const VECTOR_1_ID = "a81ec84536b8cb9629be059db2c0ddf8a6e7cb78e6d0b091d93b52138926f10e";

const VECTOR_2 = {
	app: {
		version: "2.9.0+12",
		file: "DSH-Remote-v2.9.0.apk",
		size: 14,
		sha256: "7c4de418af1219b0e25763b399cc51ad01f4301e7ac5eb7fd2fe9ea439cbfdee",
	},
	plugin: {
		version: "2.9.0",
		file: "dsh-mobile-remote-v2.9.0.tgz",
		size: 17,
		sha256: "ccd3fcaeab94094c940d64d186d1d58d03b71514331e48070b444418cbe42201",
		contentSha256: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
	},
};
const VECTOR_2_ID = "fd687d23b6f8ef145a4e1771ecd2c8936dc22992e74efc2eec852d797c0be64f";

// ── 测试脚手架 ───────────────────────────────────────────────────────────────

const T0 = Date.parse("2026-10-20T00:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const CONTENT_SHA = "0123456789abcdef".repeat(4);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

let testHome;

test.before(() => {
	// 隔离 HOME：即使实现将来引入用户目录状态，也不会污染开发机。
	testHome = mkdtempSync(join(tmpdir(), "dsh-carrier-home-"));
	process.env.HOME = testHome;
});

test.after(() => {
	rmSync(testHome, { recursive: true, force: true });
});

function makeSetup() {
	const root = mkdtempSync(join(tmpdir(), "dsh-carrier-"));
	const updateDir = join(root, "update");
	const profileDirOf = (key) => {
		const dir = join(root, "profiles", key);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "package.json"), '{"name":"mock-profile"}\n');
		return dir;
	};
	return { root, updateDir, profileDirOf };
}

function withSetup(fn) {
	const setup = makeSetup();
	try {
		return fn(setup);
	} finally {
		rmSync(setup.root, { recursive: true, force: true });
	}
}

function pathsOf(setup) {
	return store.carrierPaths(setup.updateDir);
}

function writeManualFile(setup, name, bytes) {
	const dir = join(setup.updateDir, "manual");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, name);
	writeFileSync(file, bytes);
	return file;
}

function readJsonFile(file) {
	return JSON.parse(readFileSync(file, "utf8"));
}

function apkObjectFile(setup, product) {
	return join(pathsOf(setup).apkObjects, product.identity.app.sha256, "app.apk");
}

/** 构造一组两段产物 + 清单（写进人工区），返回身份与 releaseId。 */
function makeProduct(setup, {
	appSeed,
	pluginSeed = appSeed,
	appVersion = "3.2.0+7",
	pluginVersion = "3.2.0",
	contentSha256 = CONTENT_SHA,
	notes,
} = {}) {
	const appBytes = Buffer.from(`apk-${appSeed}\n`);
	const pluginBytes = Buffer.from(`tgz-${pluginSeed}\n`);
	const appFileName = `DSH-Remote-${appSeed}.apk`;
	const pluginFileName = `dsh-mobile-remote-${pluginSeed}.tgz`;
	const appPath = writeManualFile(setup, appFileName, appBytes);
	const pluginPath = writeManualFile(setup, pluginFileName, pluginBytes);
	const manifest = {
		schema: 1,
		app: { version: appVersion, file: appFileName, size: appBytes.length, sha256: sha256(appBytes) },
		plugin: {
			version: pluginVersion,
			file: pluginFileName,
			size: pluginBytes.length,
			sha256: sha256(pluginBytes),
			contentSha256,
		},
		notes: notes ?? `notes-${appSeed}`,
	};
	const identity = store.normalizeReleaseIdentity({ app: manifest.app, plugin: manifest.plugin });
	return {
		appSeed,
		pluginSeed,
		appBytes,
		pluginBytes,
		appPath,
		pluginPath,
		manifest,
		identity,
		releaseId: store.computeReleaseId(identity),
	};
}

/** 一步发布（stage + publish）；测试前一步失败直接断言失败。 */
function publishProduct(setup, product, {
	profileKey = "web-abc",
	profileDir,
	select = true,
	source = "manual",
	now = T0,
	lease,
} = {}) {
	const dir = profileDir ?? setup.profileDirOf(profileKey);
	const staged = store.stageRelease({
		updateDir: setup.updateDir,
		manifest: product.manifest,
		appPath: product.appPath,
		pluginPath: product.pluginPath,
		source,
		now,
	});
	assert.equal(staged.ok, true, `stage 失败: ${staged.reason ?? ""}`);
	const published = store.publishStagedRelease({
		updateDir: setup.updateDir,
		stagingId: staged.stagingId,
		profileKey,
		profileDir: dir,
		select,
		now,
		lease,
	});
	assert.equal(published.ok, true, `publish 失败: ${published.reason ?? ""}`);
	return { product, staged, published, releaseId: published.releaseId };
}

// ── releaseId/v1 ─────────────────────────────────────────────────────────────

test("releaseId/v1：固定测试向量钉住规范序列化（≥2 组）", () => {
	assert.equal(store.RELEASE_ID_PREFIX, "releaseId/v1");
	assert.deepEqual(
		[...store.RELEASE_ID_FIELD_ORDER],
		[
			"app.version",
			"app.file",
			"app.size",
			"app.sha256",
			"plugin.version",
			"plugin.file",
			"plugin.size",
			"plugin.sha256",
			"plugin.contentSha256",
		],
	);
	assert.equal(store.releaseIdCanonical(VECTOR_1), VECTOR_1_CANONICAL);
	assert.equal(store.computeReleaseId(VECTOR_1), VECTOR_1_ID);
	assert.equal(store.computeReleaseId(VECTOR_2), VECTOR_2_ID);
	assert.notEqual(VECTOR_1_ID, VECTOR_2_ID);
});

test("releaseId 归一化：字段插入顺序/大小写/空白归一，URL 与备注不参与身份", () => {
	// 输入对象键顺序无关（规范序列化的顺序由实现固定，不由调用方决定）。
	assert.equal(store.computeReleaseId({ plugin: VECTOR_1.plugin, app: VECTOR_1.app }), VECTOR_1_ID);
	// 归一化：首尾空白、哈希大小写。
	const normalized = {
		app: {
			version: " 3.2.0+7 ",
			file: " DSH-Remote-v3.2.0+7.apk ",
			size: 15,
			sha256: VECTOR_1.app.sha256.toUpperCase(),
		},
		plugin: {
			version: "3.2.0",
			file: "dsh-mobile-remote-v3.2.0.tgz",
			size: 18,
			sha256: ` ${VECTOR_1.plugin.sha256} `,
			contentSha256: VECTOR_1.plugin.contentSha256.toUpperCase(),
		},
	};
	assert.equal(store.computeReleaseId(normalized), VECTOR_1_ID);
	// URL/备注/临时地址不参与身份。
	const manifest = {
		schema: 1,
		app: { ...VECTOR_1.app },
		plugin: { ...VECTOR_1.plugin, url: "https://example.invalid/plugin.tgz?token=tmp" },
		version: VECTOR_1.app.version,
		apk: VECTOR_1.app.file,
		size: VECTOR_1.app.size,
		sha256: VECTOR_1.app.sha256,
		notes: "本次发布的备注",
	};
	const fromManifest = store.releaseIdentityFromManifest(manifest);
	assert.equal(fromManifest.ok, true);
	assert.equal(fromManifest.releaseId, VECTOR_1_ID);
	// 身份字段真的变了 → releaseId 变化（说明哈希不是常量）。
	const changed = { ...VECTOR_1, app: { ...VECTOR_1.app, size: 16 } };
	assert.notEqual(store.computeReleaseId(changed), VECTOR_1_ID);
});

test("非法身份/清单返回稳定 mismatch，不把错误当异常抛给服务面", () => {
	assert.throws(() => store.computeReleaseId({}), /app:missing/);
	assert.throws(() => store.computeReleaseId({ app: {}, plugin: {} }), /app\.version/);
	const cases = [
		[null, "manifest-invalid"],
		[{ schema: 2, app: VECTOR_1.app, plugin: VECTOR_1.plugin }, "manifest-schema-unknown"],
		[{ schema: 1, app: { ...VECTOR_1.app, sha256: "nope" }, plugin: VECTOR_1.plugin }, "manifest-identity-invalid"],
		[{ schema: 1, app: { ...VECTOR_1.app, file: "../escape.apk" }, plugin: VECTOR_1.plugin }, "manifest-identity-invalid"],
		[{ schema: 1, app: { ...VECTOR_1.app, size: -1 }, plugin: VECTOR_1.plugin }, "manifest-identity-invalid"],
	];
	for (const [manifest, reason] of cases) {
		const result = store.releaseIdentityFromManifest(manifest);
		assert.equal(result.ok, false);
		assert.equal(result.status, "mismatch");
		assert.equal(result.reason, reason);
	}
});

// ── 所有权与布局 ─────────────────────────────────────────────────────────────

test("ensureCarrierStore：建立带布局版本与所有权标记的分层托管区（幂等）", () => {
	withSetup((setup) => {
		const created = store.ensureCarrierStore({ updateDir: setup.updateDir });
		assert.equal(created.ok, true);
		assert.equal(created.status, "ready");
		assert.equal(created.created, true);
		const paths = pathsOf(setup);
		const ownership = readJsonFile(paths.ownerFile);
		assert.equal(ownership.module, "dsh-mobile-remote");
		assert.equal(ownership.kind, "app-carrier");
		assert.equal(ownership.layout, 1);
		for (const dir of [paths.objects, paths.apkObjects, paths.pluginObjects, paths.releases, paths.profiles, paths.leases, paths.staging]) {
			assert.equal(statSync(dir).isDirectory(), true, `${dir} 应存在`);
		}
		const again = store.ensureCarrierStore({ updateDir: setup.updateDir });
		assert.equal(again.ok, true);
		assert.equal(again.created, false);
	});
});

test("已有目录但无所有权标记：不接管、不递归清理、不新增任何文件", () => {
	withSetup((setup) => {
		const paths = pathsOf(setup);
		mkdirSync(join(paths.apkObjects, "aa".repeat(32)), { recursive: true });
		writeFileSync(join(paths.root, "hand-written.txt"), "keep-me");
		const before = readdirSync(paths.root).sort();
		for (const result of [
			store.ensureCarrierStore({ updateDir: setup.updateDir }),
			store.ensureCarrierStore({ updateDir: setup.updateDir, create: false }),
			store.readCarrierOwnership({ updateDir: setup.updateDir }),
			store.collectGarbage({ updateDir: setup.updateDir, now: T0 + 365 * DAY }),
		]) {
			assert.equal(result.ok, false);
			assert.equal(result.status, "unusable");
			assert.equal(result.reason, "ownership-missing");
		}
		assert.equal(existsSync(paths.ownerFile), false, "不得写所有权标记");
		assert.deepEqual(readdirSync(paths.root).sort(), before, "不得新增/删除文件");
		assert.equal(readFileSync(join(paths.root, "hand-written.txt"), "utf8"), "keep-me");
	});
});

test("布局版本未知或所有权属于别的模块：不接管，GC 也拒绝清理", () => {
	withSetup((setup) => {
		const paths = pathsOf(setup);
		mkdirSync(paths.root, { recursive: true });
		writeFileSync(join(paths.root, "keep.txt"), "keep");
		writeFileSync(paths.ownerFile, JSON.stringify({ module: "dsh-mobile-remote", kind: "app-carrier", layout: 99 }));
		const unknown = store.ensureCarrierStore({ updateDir: setup.updateDir });
		assert.equal(unknown.ok, false);
		assert.equal(unknown.reason, "layout-version-unknown");
		const gc = store.collectGarbage({ updateDir: setup.updateDir, now: T0 });
		assert.equal(gc.ok, false);
		assert.equal(gc.reason, "layout-version-unknown");
		assert.equal(readFileSync(join(paths.root, "keep.txt"), "utf8"), "keep");

		writeFileSync(paths.ownerFile, JSON.stringify({ module: "someone-else", kind: "app-carrier", layout: 1 }));
		const foreign = store.ensureCarrierStore({ updateDir: setup.updateDir });
		assert.equal(foreign.ok, false);
		assert.equal(foreign.reason, "ownership-foreign");
		assert.equal(store.collectGarbage({ updateDir: setup.updateDir }).reason, "ownership-foreign");
	});
});

test("updateDir 缺失/非法：所有入口返回 update-dir-missing（不猜当前目录）", () => {
	assert.equal(store.carrierPaths(""), null);
	assert.equal(store.carrierPaths("   "), null);
	assert.equal(store.carrierRoot(null), null);
	for (const updateDir of ["", "   ", null, undefined, 42]) {
		for (const result of [
			store.ensureCarrierStore({ updateDir }),
			store.readCarrierOwnership({ updateDir }),
			store.readCurrentRelease({ updateDir, profileKey: "web-abc" }),
			store.resolveRelease({ updateDir, releaseId: "a".repeat(64) }),
			store.collectGarbage({ updateDir }),
		]) {
			assert.equal(result.ok, false);
			assert.equal(result.status, "unusable");
			assert.equal(result.reason, "update-dir-missing");
		}
	}
});

test("人工区：自动写入与 GC 都不读改人工区文件", () => {
	withSetup((setup) => {
		mkdirSync(join(setup.updateDir, "handmade"), { recursive: true });
		writeFileSync(join(setup.updateDir, "manifest.json"), '{"manual":true}\n');
		writeFileSync(join(setup.updateDir, "mobile.apk"), "handmade-apk-bytes");
		writeFileSync(join(setup.updateDir, "handmade", "notes.txt"), "handwritten");
		const before = new Map(
			["manifest.json", "mobile.apk", "handmade/notes.txt"].map((name) => {
				const file = join(setup.updateDir, name);
				const stat = statSync(file);
				return [name, { ino: stat.ino, size: stat.size, bytes: readFileSync(file) }];
			}),
		);
		const product = makeProduct(setup, { appSeed: "manual-area" });
		publishProduct(setup, product);
		store.collectGarbage({ updateDir: setup.updateDir, now: T0 + 100 * DAY });
		for (const [name, expected] of before) {
			const file = join(setup.updateDir, name);
			const stat = statSync(file);
			assert.equal(stat.ino, expected.ino, `${name} 的 inode 不应变化`);
			assert.equal(stat.size, expected.size);
			assert.deepEqual(readFileSync(file), expected.bytes);
		}
	});
});

// ── 提交协议 ─────────────────────────────────────────────────────────────────

test("提交协议：暂存 → 校验 → 不可变对象 → 最后原子更新指针；人工导入为独立 inode", () => {
	withSetup((setup) => {
		const product = makeProduct(setup, { appSeed: "commit" });
		const { staged, published, releaseId } = publishProduct(setup, product);
		assert.equal(staged.status, "staged");
		assert.equal(published.status, "ready");
		const paths = pathsOf(setup);
		const objectFile = apkObjectFile(setup, product);
		assert.equal(existsSync(objectFile), true);
		assert.equal(existsSync(join(paths.releases, releaseId, "manifest.json")), true);
		const pointer = readJsonFile(join(paths.profiles, "web-abc", "current.json"));
		assert.equal(pointer.current.releaseId, releaseId);
		assert.deepEqual(pointer.superseded, []);
		assert.deepEqual(readdirSync(paths.staging), [], "提交成功后暂存区应清空");
		// 人工导入必须复制为独立 inode（人工区后续变化不能污染托管对象）。
		assert.notEqual(statSync(objectFile).ino, statSync(product.appPath).ino);
		assert.equal(statSync(objectFile).mode & 0o777, 0o444);
		assert.deepEqual(readFileSync(objectFile), product.appBytes);
		const current = store.readCurrentRelease({ updateDir: setup.updateDir, profileKey: "web-abc" });
		assert.equal(current.status, "ready");
		assert.equal(current.releaseId, releaseId);
		assert.equal(current.manifest.notes, product.manifest.notes);
		assert.equal(current.app.path, objectFile);
		assert.equal(current.app.size, product.appBytes.length);
	});
});

test("载体源：硬链接共享只读 inode，源文件绝不移动/改写", () => {
	withSetup((setup) => {
		const product = makeProduct(setup, { appSeed: "hardlink" });
		const staged = store.stageRelease({
			updateDir: setup.updateDir,
			manifest: product.manifest,
			appPath: product.appPath,
			pluginPath: product.pluginPath,
			source: "carrier",
			now: T0,
		});
		assert.equal(staged.ok, true);
		assert.equal(staged.app.mode, "link");
		const stagedFile = join(pathsOf(setup).staging, staged.stagingId, "app.apk");
		assert.equal(statSync(stagedFile).ino, statSync(product.appPath).ino);
		const published = store.publishStagedRelease({
			updateDir: setup.updateDir,
			stagingId: staged.stagingId,
			profileKey: "web-abc",
			profileDir: setup.profileDirOf("web-abc"),
			now: T0,
		});
		assert.equal(published.ok, true);
		const objectFile = apkObjectFile(setup, product);
		assert.equal(statSync(objectFile).ino, statSync(product.appPath).ino, "硬链接应共享同一只读 inode");
		assert.equal(existsSync(product.appPath), true, "载体原件不得被移动");
		assert.deepEqual(readFileSync(product.appPath), product.appBytes, "载体原件不得被改写");
	});
});

test("硬链接不可用（跨文件系统/不支持/权限）时回退复制，源仍在", () => {
	withSetup((setup) => {
		const product = makeProduct(setup, { appSeed: "fallback" });
		const staged = store.stageRelease({
			updateDir: setup.updateDir,
			manifest: product.manifest,
			appPath: product.appPath,
			pluginPath: product.pluginPath,
			source: "carrier",
			now: T0,
			linkFile() {
				const error = new Error("cross-device link");
				error.code = "EXDEV";
				throw error;
			},
		});
		assert.equal(staged.ok, true);
		assert.equal(staged.app.mode, "copy");
		const published = store.publishStagedRelease({
			updateDir: setup.updateDir,
			stagingId: staged.stagingId,
			profileKey: "web-abc",
			profileDir: setup.profileDirOf("web-abc"),
			now: T0,
		});
		assert.equal(published.ok, true);
		assert.notEqual(statSync(apkObjectFile(setup, product)).ino, statSync(product.appPath).ino);
		assert.equal(existsSync(product.appPath), true);
		assert.deepEqual(readFileSync(product.appPath), product.appBytes);

		// 非回退错误码（如 I/O 失败）不静默降级：返回稳定不可用状态。
		const broken = store.stageRelease({
			updateDir: setup.updateDir,
			manifest: product.manifest,
			appPath: product.appPath,
			pluginPath: product.pluginPath,
			source: "carrier",
			now: T0,
			linkFile() {
				const error = new Error("io error");
				error.code = "EIO";
				throw error;
			},
		});
		assert.equal(broken.ok, false);
		assert.equal(broken.status, "unusable");
		assert.equal(broken.reason, "link-failed");
	});
});

test("校验失败（size/sha）：物质止于暂存区，不产生可服务对象/记录/指针", () => {
	withSetup((setup) => {
		const product = makeProduct(setup, { appSeed: "reject" });
		const paths = pathsOf(setup);
		const cases = [
			[{ ...product.manifest, app: { ...product.manifest.app, sha256: "0".repeat(64) } }, "app-hash-mismatch"],
			[{ ...product.manifest, app: { ...product.manifest.app, size: product.appBytes.length + 1 } }, "app-size-mismatch"],
			[{ ...product.manifest, plugin: { ...product.manifest.plugin, sha256: "1".repeat(64) } }, "plugin-hash-mismatch"],
		];
		for (const [manifest, reason] of cases) {
			const staged = store.stageRelease({
				updateDir: setup.updateDir,
				manifest,
				appPath: product.appPath,
				pluginPath: product.pluginPath,
				now: T0,
			});
			assert.equal(staged.ok, false);
			assert.equal(staged.status, "mismatch");
			assert.equal(staged.reason, reason);
		}
		assert.deepEqual(readdirSync(paths.staging), [], "校验失败要清理暂存残片");
		assert.deepEqual(readdirSync(paths.releases), []);
		assert.deepEqual(readdirSync(paths.apkObjects), []);
		assert.deepEqual(readdirSync(paths.profiles), []);
		assert.equal(store.readCurrentRelease({ updateDir: setup.updateDir, profileKey: "web-abc" }).reason, "no-current-release");
	});
});

test("暂存未提交：不可服务（无 release 记录/指针）；GC 到期回收暂存残留", () => {
	withSetup((setup) => {
		const product = makeProduct(setup, { appSeed: "staged-only" });
		const staged = store.stageRelease({
			updateDir: setup.updateDir,
			manifest: product.manifest,
			appPath: product.appPath,
			pluginPath: product.pluginPath,
			now: T0,
		});
		assert.equal(staged.ok, true);
		assert.equal(store.resolveRelease({ updateDir: setup.updateDir, releaseId: product.releaseId }).status, "not-ready");
		assert.equal(store.readCurrentRelease({ updateDir: setup.updateDir, profileKey: "web-abc" }).reason, "no-current-release");
		// 未到回收年龄：不动（可能是另一个写者正在提交）。
		const early = store.collectGarbage({ updateDir: setup.updateDir, now: T0 + 30 * 60 * 1000, stagingTtlMs: HOUR });
		assert.equal(early.ok, true);
		assert.deepEqual(early.staging.removed, []);
		// 到期：回收，且不留下可服务的对象/记录。
		const late = store.collectGarbage({ updateDir: setup.updateDir, now: T0 + 2 * HOUR, stagingTtlMs: HOUR });
		assert.equal(late.ok, true);
		assert.deepEqual(late.staging.removed, [staged.stagingId]);
		assert.deepEqual(readdirSync(pathsOf(setup).staging), []);
		assert.deepEqual(readdirSync(pathsOf(setup).releases), []);
	});
});

test("已发布对象禁止原地覆盖：目标被破坏时报 mismatch 且不改写既有 inode", () => {
	withSetup((setup) => {
		const product = makeProduct(setup, { appSeed: "immutable-object" });
		publishProduct(setup, product);
		const objectFile = apkObjectFile(setup, product);
		const tampered = Buffer.concat([product.appBytes, Buffer.from("tamper\n")]);
		chmodSync(objectFile, 0o644);
		writeFileSync(objectFile, tampered);
		chmodSync(objectFile, 0o444);

		const stagedAgain = store.stageRelease({
			updateDir: setup.updateDir,
			manifest: product.manifest,
			appPath: product.appPath,
			pluginPath: product.pluginPath,
			now: T0,
		});
		const publishAgain = store.publishStagedRelease({
			updateDir: setup.updateDir,
			stagingId: stagedAgain.stagingId,
			profileKey: "web-abc",
			profileDir: setup.profileDirOf("web-abc"),
			now: T0,
		});
		assert.equal(publishAgain.ok, false);
		assert.equal(publishAgain.reason, "object-integrity-mismatch");
		assert.deepEqual(readFileSync(objectFile), tampered, "不得原地覆盖已发布 inode");
		const resolved = store.resolveReleaseObject({ updateDir: setup.updateDir, releaseId: product.releaseId, sha256: product.identity.app.sha256 });
		assert.equal(resolved.ok, false);
		assert.equal(resolved.status, "mismatch");
	});
});

test("发布记录不可变：同一身份再次导入不覆盖首个记录与备注", () => {
	withSetup((setup) => {
		const product = makeProduct(setup, { appSeed: "immutable-record", notes: "first-notes" });
		publishProduct(setup, product);
		const secondManifest = { ...product.manifest, notes: "second-notes" };
		const staged = store.stageRelease({
			updateDir: setup.updateDir,
			manifest: secondManifest,
			appPath: product.appPath,
			pluginPath: product.pluginPath,
			now: T0,
		});
		const published = store.publishStagedRelease({
			updateDir: setup.updateDir,
			stagingId: staged.stagingId,
			profileKey: "web-abc",
			profileDir: setup.profileDirOf("web-abc"),
			now: T0,
		});
		assert.equal(published.ok, true);
		assert.equal(published.changed, false, "相同 releaseId 重复导入不应重新切换指针");
		const record = readJsonFile(join(pathsOf(setup).releases, product.releaseId, "release.json"));
		assert.equal(record.manifest.notes, "first-notes");
		assert.equal(store.readCurrentRelease({ updateDir: setup.updateDir, profileKey: "web-abc" }).manifest.notes, "first-notes");
	});
});

// ── profile 隔离 ─────────────────────────────────────────────────────────────

test("profileKey 缺失或非法：明确不可用，不猜 profile、不写指针", () => {
	withSetup((setup) => {
		const product = makeProduct(setup, { appSeed: "no-profile" });
		const staged = store.stageRelease({
			updateDir: setup.updateDir,
			manifest: product.manifest,
			appPath: product.appPath,
			pluginPath: product.pluginPath,
			now: T0,
		});
		for (const profileKey of ["", undefined, "   "]) {
			const result = store.publishStagedRelease({ updateDir: setup.updateDir, stagingId: staged.stagingId, profileKey, now: T0 });
			assert.equal(result.ok, false);
			assert.equal(result.status, "unusable");
			assert.equal(result.reason, "profile-unknown");
		}
		for (const profileKey of ["../escape", "a/b", "..", ".hidden", "x".repeat(65)]) {
			const result = store.publishStagedRelease({ updateDir: setup.updateDir, stagingId: staged.stagingId, profileKey, now: T0 });
			assert.equal(result.ok, false);
			assert.equal(result.reason, "profile-key-invalid");
		}
		assert.deepEqual(readdirSync(pathsOf(setup).profiles), []);
		assert.equal(store.readCurrentRelease({ updateDir: setup.updateDir, profileKey: "" }).reason, "profile-unknown");
	});
});

test("profile 隔离：不同 profile 的 current 指针互不覆盖", () => {
	withSetup((setup) => {
		const webProduct = makeProduct(setup, { appSeed: "iso-web" });
		const cliProduct = makeProduct(setup, { appSeed: "iso-cli" });
		publishProduct(setup, webProduct, { profileKey: "web-abc" });
		publishProduct(setup, cliProduct, { profileKey: "cli-def" });
		const paths = pathsOf(setup);
		const webPointer = readJsonFile(join(paths.profiles, "web-abc", "current.json"));
		const cliPointer = readJsonFile(join(paths.profiles, "cli-def", "current.json"));
		assert.equal(webPointer.current.releaseId, webProduct.releaseId);
		assert.equal(cliPointer.current.releaseId, cliProduct.releaseId);
		assert.equal(store.readCurrentRelease({ updateDir: setup.updateDir, profileKey: "web-abc" }).releaseId, webProduct.releaseId);
		assert.equal(store.readCurrentRelease({ updateDir: setup.updateDir, profileKey: "cli-def" }).releaseId, cliProduct.releaseId);
		// 一个 profile 换发布不影响另一个。
		const newer = makeProduct(setup, { appSeed: "iso-web-2" });
		publishProduct(setup, newer, { profileKey: "web-abc" });
		assert.equal(store.readCurrentRelease({ updateDir: setup.updateDir, profileKey: "cli-def" }).releaseId, cliProduct.releaseId);
	});
});

test("候选发布（select=false）不切换 current；selectRelease 在健康确认后切换", () => {
	withSetup((setup) => {
		const current = makeProduct(setup, { appSeed: "select-current" });
		const candidate = makeProduct(setup, { appSeed: "select-candidate" });
		publishProduct(setup, current, { profileKey: "web-abc" });
		const staged = store.stageRelease({
			updateDir: setup.updateDir,
			manifest: candidate.manifest,
			appPath: candidate.appPath,
			pluginPath: candidate.pluginPath,
			now: T0,
		});
		const published = store.publishStagedRelease({
			updateDir: setup.updateDir,
			stagingId: staged.stagingId,
			profileKey: "web-abc",
			profileDir: setup.profileDirOf("web-abc"),
			select: false,
			now: T0,
		});
		assert.equal(published.ok, true);
		assert.equal(published.selected, false);
		assert.equal(store.readCurrentRelease({ updateDir: setup.updateDir, profileKey: "web-abc" }).releaseId, current.releaseId);
		assert.equal(store.resolveRelease({ updateDir: setup.updateDir, releaseId: candidate.releaseId }).status, "ready");
		const selected = store.selectRelease({
			updateDir: setup.updateDir,
			profileKey: "web-abc",
			releaseId: candidate.releaseId,
			profileDir: setup.profileDirOf("web-abc"),
			now: T0 + 2 * HOUR,
		});
		assert.equal(selected.ok, true);
		assert.equal(selected.changed, true);
		const nowCurrent = store.readCurrentRelease({ updateDir: setup.updateDir, profileKey: "web-abc" });
		assert.equal(nowCurrent.releaseId, candidate.releaseId);
		const pointer = readJsonFile(join(pathsOf(setup).profiles, "web-abc", "current.json"));
		assert.equal(pointer.superseded.length, 1);
		assert.equal(pointer.superseded[0].releaseId, current.releaseId);
		assert.equal(pointer.superseded[0].retainUntil, new Date(T0 + 2 * HOUR + DAY).toISOString());
	});
});

test("回滚重选：selectRelease 旧发布后，被放弃的新发布进入本 profile 的 24h 窗口", () => {
	withSetup((setup) => {
		const a = makeProduct(setup, { appSeed: "rollback-a" });
		const b = makeProduct(setup, { appSeed: "rollback-b" });
		publishProduct(setup, a, { profileKey: "web-abc", now: T0 });
		publishProduct(setup, b, { profileKey: "web-abc", now: T0 });
		const back = store.selectRelease({
			updateDir: setup.updateDir,
			profileKey: "web-abc",
			releaseId: a.releaseId,
			profileDir: setup.profileDirOf("web-abc"),
			now: T0 + 3 * HOUR,
		});
		assert.equal(back.ok, true);
		assert.equal(store.readCurrentRelease({ updateDir: setup.updateDir, profileKey: "web-abc" }).releaseId, a.releaseId);
		const pointer = readJsonFile(join(pathsOf(setup).profiles, "web-abc", "current.json"));
		assert.deepEqual(pointer.superseded.map((entry) => entry.releaseId), [b.releaseId]);
		assert.equal(pointer.superseded[0].retainUntil, new Date(T0 + 3 * HOUR + DAY).toISOString());
		// 不存在的 release 不能选为当前发布。
		const unknown = store.selectRelease({ updateDir: setup.updateDir, profileKey: "web-abc", releaseId: "9".repeat(64), now: T0 + 4 * HOUR });
		assert.equal(unknown.ok, false);
		assert.equal(unknown.reason, "release-unknown");
	});
});

// ── 服务面状态语义 ───────────────────────────────────────────────────────────

test("固定目标解析：ready / mismatch / invalid / not-ready 稳定区分", () => {
	withSetup((setup) => {
		const product = makeProduct(setup, { appSeed: "fixed-target" });
		publishProduct(setup, product);
		const readyResult = store.resolveReleaseObject({
			updateDir: setup.updateDir,
			releaseId: product.releaseId,
			sha256: product.identity.app.sha256,
			kind: "apk",
		});
		assert.equal(readyResult.status, "ready");
		assert.equal(readyResult.size, product.appBytes.length);
		assert.deepEqual(readFileSync(readyResult.path), product.appBytes);

		const wrongHash = store.resolveReleaseObject({ updateDir: setup.updateDir, releaseId: product.releaseId, sha256: "0".repeat(64) });
		assert.equal(wrongHash.status, "mismatch");
		assert.equal(wrongHash.reason, "object-identity-mismatch");

		const badRelease = store.resolveReleaseObject({ updateDir: setup.updateDir, releaseId: "not-a-release-id", sha256: product.identity.app.sha256 });
		assert.equal(badRelease.status, "invalid");
		assert.equal(badRelease.reason, "release-id-invalid");

		const badHash = store.resolveReleaseObject({ updateDir: setup.updateDir, releaseId: product.releaseId, sha256: "nope" });
		assert.equal(badHash.status, "invalid");
		assert.equal(badHash.reason, "object-sha256-invalid");

		const unknown = store.resolveReleaseObject({ updateDir: setup.updateDir, releaseId: "f".repeat(64), sha256: product.identity.app.sha256 });
		assert.equal(unknown.status, "not-ready");
		assert.equal(unknown.reason, "release-unknown");

		const opened = store.openReleaseObject({ updateDir: setup.updateDir, releaseId: product.releaseId, sha256: product.identity.app.sha256 });
		assert.equal(opened.ok, true);
		assert.equal(opened.handle.size, product.appBytes.length);
		opened.handle.close();
		opened.handle.close(); // 幂等
	});
});

test("对象缺失 → not-ready（503 语义）；插件对象未导入单独报告", () => {
	withSetup((setup) => {
		const product = makeProduct(setup, { appSeed: "missing-object" });
		publishProduct(setup, product);
		rmSync(apkObjectFile(setup, product));
		const resolved = store.resolveReleaseObject({ updateDir: setup.updateDir, releaseId: product.releaseId, sha256: product.identity.app.sha256 });
		assert.equal(resolved.ok, false);
		assert.equal(resolved.status, "not-ready");
		assert.equal(resolved.reason, "object-missing");
		const current = store.readCurrentRelease({ updateDir: setup.updateDir, profileKey: "web-abc" });
		assert.equal(current.ok, false);
		assert.equal(current.status, "not-ready");
		assert.equal(current.reason, "app-object-missing");
		assert.equal(store.resolveRelease({ updateDir: setup.updateDir, releaseId: product.releaseId }).status, "ready", "记录仍在，只影响可服务性");

		// 只带 APK、不导入 tgz：当前入口可用，但插件对象明确报告未导入。
		const apkOnly = makeProduct(setup, { appSeed: "apk-only" });
		const staged = store.stageRelease({
			updateDir: setup.updateDir,
			manifest: apkOnly.manifest,
			appPath: apkOnly.appPath,
			now: T0,
		});
		const published = store.publishStagedRelease({
			updateDir: setup.updateDir,
			stagingId: staged.stagingId,
			profileKey: "web-abc",
			profileDir: setup.profileDirOf("web-abc"),
			now: T0,
		});
		assert.equal(published.ok, true);
		const currentApkOnly = store.readCurrentRelease({ updateDir: setup.updateDir, profileKey: "web-abc" });
		assert.equal(currentApkOnly.status, "ready");
		assert.equal(currentApkOnly.plugin.available, false);
		assert.equal(currentApkOnly.plugin.reason, "plugin-object-not-imported");
		const pluginObject = store.resolveReleaseObject({
			updateDir: setup.updateDir,
			releaseId: apkOnly.releaseId,
			sha256: apkOnly.identity.plugin.sha256,
			kind: "plugin",
		});
		assert.equal(pluginObject.reason, "plugin-object-not-imported");
	});
});

test("受控复核（verify）发现字节被替换 → mismatch，不服务被替换内容", () => {
	withSetup((setup) => {
		const product = makeProduct(setup, { appSeed: "verify" });
		publishProduct(setup, product);
		const objectFile = apkObjectFile(setup, product);
		chmodSync(objectFile, 0o644);
		writeFileSync(objectFile, Buffer.from("x".repeat(product.appBytes.length)));
		chmodSync(objectFile, 0o444);
		const trusted = store.resolveReleaseObject({ updateDir: setup.updateDir, releaseId: product.releaseId, sha256: product.identity.app.sha256 });
		assert.equal(trusted.status, "ready", "默认按不可变对象契约信任，不逐请求哈希");
		const verified = store.resolveReleaseObject({
			updateDir: setup.updateDir,
			releaseId: product.releaseId,
			sha256: product.identity.app.sha256,
			verify: true,
		});
		assert.equal(verified.status, "mismatch");
		assert.equal(verified.reason, "object-hash-mismatch");
		const currentVerified = store.readCurrentRelease({ updateDir: setup.updateDir, profileKey: "web-abc", verify: true });
		assert.equal(currentVerified.status, "mismatch");
	});
});

// ── 保留与 GC ────────────────────────────────────────────────────────────────

test("当前发布不因时间到期被删除", () => {
	withSetup((setup) => {
		const product = makeProduct(setup, { appSeed: "current-forever" });
		publishProduct(setup, product);
		const report = store.collectGarbage({ updateDir: setup.updateDir, now: T0 + 365 * DAY });
		assert.equal(report.ok, true);
		assert.equal(report.releases.expired.includes(product.releaseId), false);
		assert.equal(store.readCurrentRelease({ updateDir: setup.updateDir, profileKey: "web-abc" }).status, "ready");
		assert.equal(existsSync(apkObjectFile(setup, product)), true);
	});
});

test("被替代后按真实替代时刻保留 24h：重复调用/重读不重置，边界到点过期", () => {
	withSetup((setup) => {
		const a = makeProduct(setup, { appSeed: "retain-a" });
		const b = makeProduct(setup, { appSeed: "retain-b" });
		publishProduct(setup, a, { now: T0 });
		publishProduct(setup, b, { now: T0 });
		const pointerFile = join(pathsOf(setup).profiles, "web-abc", "current.json");
		const snapshot = readFileSync(pointerFile);
		// 重读当前发布、幂等重复发布会重置时钟吗？不会。
		store.readCurrentRelease({ updateDir: setup.updateDir, profileKey: "web-abc" });
		const repeat = publishProduct(setup, b, { now: T0 + 5 * HOUR });
		assert.equal(repeat.published.changed, false);
		assert.deepEqual(readFileSync(pointerFile), snapshot, "重复调用不得重写指针/重置保留窗口");
		const early = store.collectGarbage({ updateDir: setup.updateDir, now: T0 + DAY - 1 });
		assert.equal(early.ok, true);
		assert.equal(early.releases.expired.includes(a.releaseId), false);
		assert.equal(store.resolveRelease({ updateDir: setup.updateDir, releaseId: a.releaseId }).status, "ready");
		const late = store.collectGarbage({ updateDir: setup.updateDir, now: T0 + DAY });
		assert.equal(late.ok, true);
		assert.deepEqual(late.releases.expired, [a.releaseId]);
		assert.equal(store.resolveRelease({ updateDir: setup.updateDir, releaseId: a.releaseId }).status, "expired");
		assert.equal(existsSync(join(pathsOf(setup).releases, a.releaseId, "tombstone.json")), true);
		assert.equal(existsSync(join(pathsOf(setup).releases, a.releaseId, "release.json")), false);
		assert.equal(existsSync(apkObjectFile(setup, a)), false);
		assert.equal(store.readCurrentRelease({ updateDir: setup.updateDir, profileKey: "web-abc" }).releaseId, b.releaseId);
	});
});

test("真实重新激活后再次被替代是新选用周期：窗口从新替代时刻重新起算", () => {
	withSetup((setup) => {
		const a = makeProduct(setup, { appSeed: "cycle-a" });
		const b = makeProduct(setup, { appSeed: "cycle-b" });
		const c = makeProduct(setup, { appSeed: "cycle-c" });
		publishProduct(setup, a, { now: T0 });
		publishProduct(setup, b, { now: T0 }); // A 第一次被替代：窗口到 T0+24h
		store.selectRelease({ updateDir: setup.updateDir, profileKey: "web-abc", releaseId: a.releaseId, now: T0 + 2 * HOUR });
		publishProduct(setup, c, { now: T0 + 3 * HOUR }); // A 再次被替代：新周期窗口到 T0+27h
		const stillThere = store.collectGarbage({ updateDir: setup.updateDir, now: T0 + 24 * HOUR + HOUR });
		assert.equal(stillThere.releases.expired.includes(a.releaseId), false, "新周期窗口未到");
		assert.equal(store.resolveRelease({ updateDir: setup.updateDir, releaseId: a.releaseId }).status, "ready");
		const expired = store.collectGarbage({ updateDir: setup.updateDir, now: T0 + 27 * HOUR });
		assert.ok(expired.releases.expired.includes(a.releaseId), "A 的新周期窗口到点");
		assert.equal(store.resolveRelease({ updateDir: setup.updateDir, releaseId: c.releaseId }).status, "ready", "当前发布保留");
	});
});

test("GC 汇总所有 profile：后弃用者仍获得自己的完整 24h 窗口", () => {
	withSetup((setup) => {
		const a = makeProduct(setup, { appSeed: "union-a" });
		const b = makeProduct(setup, { appSeed: "union-b" });
		const c = makeProduct(setup, { appSeed: "union-c" });
		publishProduct(setup, a, { profileKey: "web-abc", now: T0 });
		publishProduct(setup, a, { profileKey: "cli-def", now: T0 });
		publishProduct(setup, b, { profileKey: "web-abc", now: T0 }); // web 在 0h 弃用 A（窗口 24h）
		publishProduct(setup, c, { profileKey: "cli-def", now: T0 + 23 * HOUR }); // cli 在 23h 弃用 A（窗口 47h）
		const keep1 = store.collectGarbage({ updateDir: setup.updateDir, now: T0 + 25 * HOUR });
		assert.equal(keep1.ok, true);
		assert.equal(store.resolveRelease({ updateDir: setup.updateDir, releaseId: a.releaseId }).status, "ready");
		assert.equal(keep1.releases.expired.includes(a.releaseId), false, "web 的窗口虽已过，cli 的并集窗口仍保护 A");
		const keep2 = store.collectGarbage({ updateDir: setup.updateDir, now: T0 + 47 * HOUR - 1 });
		assert.equal(keep2.ok, true);
		assert.equal(store.resolveRelease({ updateDir: setup.updateDir, releaseId: a.releaseId }).status, "ready");
		const expire = store.collectGarbage({ updateDir: setup.updateDir, now: T0 + 47 * HOUR });
		assert.equal(expire.ok, true);
		assert.equal(store.resolveRelease({ updateDir: setup.updateDir, releaseId: a.releaseId }).status, "expired");
	});
});

test("同一 APK 哈希仍被当前发布使用时不能删除该对象", () => {
	withSetup((setup) => {
		// A 与 C 共享同一 APK 字节（同对象哈希），但插件段不同 → releaseId 不同。
		const a = makeProduct(setup, { appSeed: "shared", pluginSeed: "shared-a" });
		const b = makeProduct(setup, { appSeed: "shared-b", pluginSeed: "shared-b" });
		const c = makeProduct(setup, { appSeed: "shared", pluginSeed: "shared-c" });
		assert.equal(a.identity.app.sha256, c.identity.app.sha256);
		assert.notEqual(a.releaseId, c.releaseId);
		publishProduct(setup, a, { now: T0 });
		publishProduct(setup, b, { now: T0 }); // A 被替代 → 24h 窗口
		publishProduct(setup, c, { now: T0 + 12 * HOUR }); // C 进入 current，继续使用 A 的 APK 对象
		const report = store.collectGarbage({ updateDir: setup.updateDir, now: T0 + 25 * HOUR });
		assert.equal(report.ok, true);
		assert.equal(store.resolveRelease({ updateDir: setup.updateDir, releaseId: a.releaseId }).status, "expired");
		const objectFile = join(pathsOf(setup).apkObjects, a.identity.app.sha256, "app.apk");
		assert.equal(existsSync(objectFile), true, "共享对象仍被 current 使用");
		const cObject = store.resolveReleaseObject({
			updateDir: setup.updateDir,
			releaseId: c.releaseId,
			sha256: c.identity.app.sha256,
		});
		assert.equal(cObject.status, "ready");
		assert.deepEqual(readFileSync(cObject.path), a.appBytes);
	});
});

test("有效租约保护候选对象；终态释放后从终态时刻起算 24h 窗口", () => {
	withSetup((setup) => {
		const current = makeProduct(setup, { appSeed: "lease-current" });
		const candidate = makeProduct(setup, { appSeed: "lease-candidate" });
		publishProduct(setup, current, { now: T0 });
		const staged = store.stageRelease({
			updateDir: setup.updateDir,
			manifest: candidate.manifest,
			appPath: candidate.appPath,
			pluginPath: candidate.pluginPath,
			now: T0,
		});
		const published = store.publishStagedRelease({
			updateDir: setup.updateDir,
			stagingId: staged.stagingId,
			profileKey: "web-abc",
			profileDir: setup.profileDirOf("web-abc"),
			select: false,
			now: T0,
		});
		assert.equal(published.ok, true);
		const claim = store.claimReleaseLease({
			updateDir: setup.updateDir,
			profileKey: "web-abc",
			releaseIds: [candidate.releaseId],
			generation: "gen-lease-1",
			now: T0,
			ttlMs: 2 * DAY,
		});
		assert.equal(claim.ok, true);
		const protectedRun = store.collectGarbage({ updateDir: setup.updateDir, now: T0 + DAY, leaseTtlMs: 2 * DAY });
		assert.equal(protectedRun.ok, true);
		assert.deepEqual(protectedRun.leases.protected, [claim.lease.leaseId]);
		assert.equal(store.resolveRelease({ updateDir: setup.updateDir, releaseId: candidate.releaseId }).status, "ready");
		const released = store.releaseReleaseLease({
			updateDir: setup.updateDir,
			leaseId: claim.lease.leaseId,
			generation: "gen-lease-1",
			phase: "settled",
			now: T0 + DAY,
		});
		assert.equal(released.ok, true);
		assert.deepEqual(released.retention, [{ releaseId: candidate.releaseId, retainUntil: new Date(T0 + 2 * DAY).toISOString() }]);
		const keep = store.collectGarbage({ updateDir: setup.updateDir, now: T0 + 2 * DAY - 1 });
		assert.equal(keep.ok, true);
		assert.equal(store.resolveRelease({ updateDir: setup.updateDir, releaseId: candidate.releaseId }).status, "ready");
		const expire = store.collectGarbage({ updateDir: setup.updateDir, now: T0 + 2 * DAY });
		assert.equal(expire.ok, true);
		assert.equal(store.resolveRelease({ updateDir: setup.updateDir, releaseId: candidate.releaseId }).status, "expired");
	});
});

test("终态释放不缩短已承诺的 24h 窗口；重复终态调用不延长/不重置", () => {
	withSetup((setup) => {
		const a = makeProduct(setup, { appSeed: "shorten-a" });
		const b = makeProduct(setup, { appSeed: "shorten-b" });
		publishProduct(setup, a, { now: T0 });
		publishProduct(setup, b, { now: T0 }); // A 被替代：窗口到 T0+24h
		const claim = store.claimReleaseLease({
			updateDir: setup.updateDir,
			profileKey: "web-abc",
			releaseIds: [a.releaseId],
			generation: "gen-shorten",
			now: T0 + HOUR,
		});
		assert.equal(claim.ok, true);
		const released = store.releaseReleaseLease({
			updateDir: setup.updateDir,
			leaseId: claim.lease.leaseId,
			generation: "gen-shorten",
			now: T0 + HOUR,
		});
		assert.equal(released.ok, true);
		assert.deepEqual(released.retention, [], "已有承诺窗口的发布不从租约终态重算");
		const repeat = store.releaseReleaseLease({
			updateDir: setup.updateDir,
			leaseId: claim.lease.leaseId,
			generation: "gen-shorten",
			now: T0 + 10 * HOUR,
		});
		assert.equal(repeat.ok, true);
		assert.equal(repeat.changed, false);
		assert.deepEqual(repeat.retention, []);
		// 窗口仍是 T0+24h（未被缩短、也未被延长）。
		const keep = store.collectGarbage({ updateDir: setup.updateDir, now: T0 + DAY - 1 });
		assert.equal(keep.releases.expired.includes(a.releaseId), false);
		const expire = store.collectGarbage({ updateDir: setup.updateDir, now: T0 + DAY });
		assert.deepEqual(expire.releases.expired, [a.releaseId]);
	});
});

test("已打开句柄保护的对象不删；关闭后可回收", () => {
	withSetup((setup) => {
		const a = makeProduct(setup, { appSeed: "pin-a" });
		const b = makeProduct(setup, { appSeed: "pin-b" });
		publishProduct(setup, a, { now: T0 });
		const handle = store.openCurrentApp({ updateDir: setup.updateDir, profileKey: "web-abc" });
		assert.equal(handle.ok, true);
		publishProduct(setup, b, { now: T0 }); // A 进入 24h 窗口
		const report = store.collectGarbage({ updateDir: setup.updateDir, now: T0 + DAY });
		assert.equal(report.ok, true);
		assert.equal(store.resolveRelease({ updateDir: setup.updateDir, releaseId: a.releaseId }).status, "expired");
		// 已打开句柄的文件仍在，内容可读（在途响应不被切断）。
		assert.equal(existsSync(handle.handle.path), true);
		assert.deepEqual(readFileSync(handle.handle.path), a.appBytes);
		handle.handle.close();
		const afterClose = store.collectGarbage({ updateDir: setup.updateDir, now: T0 + DAY });
		assert.equal(afterClose.ok, true);
		assert.equal(existsSync(handle.handle.path), false);
	});
});

test("GC 前核对 profile 存活性：遗弃指针先写墓碑再释放引用", () => {
	withSetup((setup) => {
		const product = makeProduct(setup, { appSeed: "dead-profile" });
		const profileDir = setup.profileDirOf("web-abc");
		publishProduct(setup, product, { profileKey: "web-abc", profileDir });
		// 另一个存活 profile 不应被误判。
		const liveProduct = makeProduct(setup, { appSeed: "live-profile" });
		publishProduct(setup, liveProduct, { profileKey: "cli-def" });
		rmSync(join(profileDir, "package.json"));
		const report = store.collectGarbage({ updateDir: setup.updateDir, now: T0 + HOUR });
		assert.equal(report.ok, true);
		assert.ok(report.profiles.tombstoned.includes("web-abc"));
		assert.deepEqual(report.profiles.live, ["cli-def"]);
		const paths = pathsOf(setup);
		assert.equal(existsSync(join(paths.profiles, "web-abc", "current.json")), false, "释放引用");
		const tombstone = readJsonFile(join(paths.profiles, "web-abc", "tombstone.json"));
		assert.equal(tombstone.profileKey, "web-abc");
		assert.equal(tombstone.reason, "profile-gone");
		assert.equal(tombstone.current.releaseId, product.releaseId);
		assert.equal(store.resolveRelease({ updateDir: setup.updateDir, releaseId: product.releaseId }).status, "expired");
		assert.equal(store.resolveRelease({ updateDir: setup.updateDir, releaseId: liveProduct.releaseId }).status, "ready");
		assert.equal(store.readCurrentRelease({ updateDir: setup.updateDir, profileKey: "cli-def" }).status, "ready");
	});
});

test("死/超时租约收敛：先释放引用，再按收敛时刻起算保留窗口", () => {
	withSetup((setup) => {
		const candidate = makeProduct(setup, { appSeed: "stale-lease" });
		const staged = store.stageRelease({
			updateDir: setup.updateDir,
			manifest: candidate.manifest,
			appPath: candidate.appPath,
			pluginPath: candidate.pluginPath,
			now: T0,
		});
		const published = store.publishStagedRelease({
			updateDir: setup.updateDir,
			stagingId: staged.stagingId,
			profileKey: "web-abc",
			profileDir: setup.profileDirOf("web-abc"),
			select: false,
			now: T0,
		});
		assert.equal(published.ok, true);
		const claim = store.claimReleaseLease({
			updateDir: setup.updateDir,
			profileKey: "web-abc",
			releaseIds: [candidate.releaseId],
			generation: "gen-stale",
			now: T0,
			ttlMs: 10 * 60 * 1000,
		});
		assert.equal(claim.ok, true);
		const report = store.collectGarbage({ updateDir: setup.updateDir, now: T0 + HOUR });
		assert.equal(report.ok, true);
		assert.deepEqual(report.leases.converged, [claim.lease.leaseId]);
		const lease = store.readReleaseLease({ updateDir: setup.updateDir, leaseId: claim.lease.leaseId });
		assert.equal(lease.lease.phase, "expired");
		const keep = store.collectGarbage({ updateDir: setup.updateDir, now: T0 + HOUR + DAY - 1 });
		assert.equal(store.resolveRelease({ updateDir: setup.updateDir, releaseId: candidate.releaseId }).status, "ready");
		const expire = store.collectGarbage({ updateDir: setup.updateDir, now: T0 + HOUR + DAY });
		assert.equal(store.resolveRelease({ updateDir: setup.updateDir, releaseId: candidate.releaseId }).status, "expired");
	});
});

test("GC 只删本 module 的托管对象：人工区、未知文件、未知目录原样保留", () => {
	withSetup((setup) => {
		const product = makeProduct(setup, { appSeed: "gc-scope" });
		publishProduct(setup, product);
		const paths = pathsOf(setup);
		// 未知文件：托管对象目录内、release 目录内的未知条目、未知目录、未知暂存目录。
		const objectDir = join(paths.apkObjects, product.identity.app.sha256);
		writeFileSync(join(objectDir, "extra.bin"), "unknown-object-dir-entry");
		mkdirSync(join(paths.releases, "not-a-release-id"), { recursive: true });
		writeFileSync(join(paths.releases, "not-a-release-id", "foo.txt"), "unknown-release-dir");
		mkdirSync(join(paths.staging, "not-our-staging"), { recursive: true });
		writeFileSync(join(paths.staging, "not-our-staging", "x.bin"), "unknown-staging");
		mkdirSync(join(paths.root, "unknown-top"), { recursive: true });
		writeFileSync(join(paths.root, "unknown-top", "y.bin"), "unknown-top");
		writeFileSync(join(setup.updateDir, "manual-notes.txt"), "manual");
		// 让当前发布过期：替换成另一个发布，并把时间推到窗口之后。
		const b = makeProduct(setup, { appSeed: "gc-scope-b" });
		publishProduct(setup, b, { now: T0 });
		const report = store.collectGarbage({ updateDir: setup.updateDir, now: T0 + DAY, stagingTtlMs: 1 });
		assert.equal(report.ok, true);
		assert.equal(store.resolveRelease({ updateDir: setup.updateDir, releaseId: product.releaseId }).status, "expired");
		assert.equal(readFileSync(join(objectDir, "extra.bin"), "utf8"), "unknown-object-dir-entry");
		assert.equal(existsSync(objectDir), true, "含未知文件的对象目录不得整目录删除");
		assert.equal(readFileSync(join(paths.releases, "not-a-release-id", "foo.txt"), "utf8"), "unknown-release-dir");
		assert.equal(readFileSync(join(paths.staging, "not-our-staging", "x.bin"), "utf8"), "unknown-staging");
		assert.equal(readFileSync(join(paths.root, "unknown-top", "y.bin"), "utf8"), "unknown-top");
		assert.equal(readFileSync(join(setup.updateDir, "manual-notes.txt"), "utf8"), "manual");
	});
});

test("过期墓碑之后重新导入同一身份：恢复就绪并清掉墓碑，原地址仍返回原字节", () => {
	withSetup((setup) => {
		const a = makeProduct(setup, { appSeed: "revive-a" });
		const b = makeProduct(setup, { appSeed: "revive-b" });
		publishProduct(setup, a, { now: T0 });
		publishProduct(setup, b, { now: T0 });
		store.collectGarbage({ updateDir: setup.updateDir, now: T0 + DAY });
		assert.equal(store.resolveRelease({ updateDir: setup.updateDir, releaseId: a.releaseId }).status, "expired");
		const paths = pathsOf(setup);
		assert.equal(existsSync(join(paths.releases, a.releaseId, "tombstone.json")), true);
		const revived = publishProduct(setup, a, { now: T0 + DAY + HOUR });
		assert.equal(revived.releaseId, a.releaseId);
		assert.equal(store.resolveRelease({ updateDir: setup.updateDir, releaseId: a.releaseId }).status, "ready");
		assert.equal(existsSync(join(paths.releases, a.releaseId, "tombstone.json")), false);
		const resolved = store.resolveReleaseObject({
			updateDir: setup.updateDir,
			releaseId: a.releaseId,
			sha256: a.identity.app.sha256,
			verify: true,
		});
		assert.equal(resolved.status, "ready");
		assert.deepEqual(readFileSync(resolved.path), a.appBytes);
	});
});

// ── 提交锁与陈旧写者 ─────────────────────────────────────────────────────────

test("提交锁：持锁期间其它写者立即 busy；持 token 可重入；死持有者的锁可回收", () => {
	withSetup((setup) => {
		const product = makeProduct(setup, { appSeed: "lock" });
		const staged = store.stageRelease({
			updateDir: setup.updateDir,
			manifest: product.manifest,
			appPath: product.appPath,
			pluginPath: product.pluginPath,
			now: T0,
		});
		assert.equal(staged.ok, true);
		const outcome = store.withCarrierCommitLock({ updateDir: setup.updateDir, now: T0 }, (token) => {
			assert.equal(typeof token, "string");
			assert.ok(token.length > 8);
			const status = store.readCommitLock({ updateDir: setup.updateDir });
			assert.equal(status.locked, true);
			// 无 token 的写者不能被排队等待，立即返回 busy。
			const busy = store.publishStagedRelease({
				updateDir: setup.updateDir,
				stagingId: staged.stagingId,
				profileKey: "web-abc",
				now: T0,
			});
			assert.equal(busy.ok, false);
			assert.equal(busy.status, "busy");
			assert.equal(busy.reason, "commit-lock-busy");
			const busyGc = store.collectGarbage({ updateDir: setup.updateDir, now: T0 });
			assert.equal(busyGc.status, "busy");
			// GC 与提交在同一个锁下：持 token 可重入。
			const nestedGc = store.collectGarbage({ updateDir: setup.updateDir, now: T0, lockToken: token });
			assert.equal(nestedGc.ok, true);
			const nested = store.publishStagedRelease({
				updateDir: setup.updateDir,
				stagingId: staged.stagingId,
				profileKey: "web-abc",
				profileDir: setup.profileDirOf("web-abc"),
				lockToken: token,
				now: T0,
			});
			assert.equal(nested.ok, true);
			return nested;
		});
		assert.equal(outcome.ok, true);
		const unlocked = store.readCommitLock({ updateDir: setup.updateDir });
		assert.equal(unlocked.locked, false);
		// 无效 token 不能借重入绕过锁。
		const forged = store.publishStagedRelease({
			updateDir: setup.updateDir,
			stagingId: staged.stagingId,
			profileKey: "web-abc",
			profileDir: setup.profileDirOf("web-abc"),
			lockToken: "forged-token",
			now: T0,
		});
		assert.equal(forged.status, "busy");
		// 持有者进程已死（pid 不存在）→ 锁可被回收，写入继续。
		const fresh = makeProduct(setup, { appSeed: "lock-dead-holder" });
		const freshStaged = store.stageRelease({
			updateDir: setup.updateDir,
			manifest: fresh.manifest,
			appPath: fresh.appPath,
			pluginPath: fresh.pluginPath,
			now: T0,
		});
		const lockDir = pathsOf(setup).commitLock;
		mkdirSync(lockDir, { recursive: true });
		writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ schema: 1, token: "dead", pid: 999_999_999 }));
		const afterDeadHolder = store.publishStagedRelease({
			updateDir: setup.updateDir,
			stagingId: freshStaged.stagingId,
			profileKey: "web-abc",
			profileDir: setup.profileDirOf("web-abc"),
			now: T0,
		});
		assert.equal(afterDeadHolder.ok, true);
		// 同步回调契约：返回 Promise 视为误用，且锁必须已释放。
		const asyncCallback = store.withCarrierCommitLock({ updateDir: setup.updateDir, now: T0 }, async () => 1);
		assert.equal(asyncCallback.ok, false);
		assert.equal(asyncCallback.reason, "commit-lock-failed");
		assert.equal(store.readCommitLock({ updateDir: setup.updateDir }).locked, false);
	});
});

test("陈旧事务代际的写者不能提交指针：租约缺失/终态/代际不符都拒绝", () => {
	withSetup((setup) => {
		const a = makeProduct(setup, { appSeed: "lease-writer-a" });
		publishProduct(setup, a, { now: T0 });
		const b = makeProduct(setup, { appSeed: "lease-writer-b" });
		const staged = store.stageRelease({
			updateDir: setup.updateDir,
			manifest: b.manifest,
			appPath: b.appPath,
			pluginPath: b.pluginPath,
			now: T0,
		});
		const claim = store.claimReleaseLease({
			updateDir: setup.updateDir,
			profileKey: "web-abc",
			releaseIds: [a.releaseId],
			generation: "gen-current",
			now: T0,
		});
		assert.equal(claim.ok, true);
		// 代际不符 → 陈旧写者不能提交指针。
		const stale = store.publishStagedRelease({
			updateDir: setup.updateDir,
			stagingId: staged.stagingId,
			profileKey: "web-abc",
			profileDir: setup.profileDirOf("web-abc"),
			lease: { leaseId: claim.lease.leaseId, generation: "gen-stale", phase: "installing" },
			now: T0,
		});
		assert.equal(stale.ok, false);
		assert.equal(stale.reason, "carrier-lease-lost");
		assert.equal(store.readCurrentRelease({ updateDir: setup.updateDir, profileKey: "web-abc" }).releaseId, a.releaseId);
		// 显式终态租约不能提交。
		const terminal = store.publishStagedRelease({
			updateDir: setup.updateDir,
			stagingId: staged.stagingId,
			profileKey: "web-abc",
			lease: { leaseId: claim.lease.leaseId, generation: "gen-current", phase: "settled" },
			now: T0,
		});
		assert.equal(terminal.reason, "lease-terminal");
		// requireLease 但没有租约。
		const missing = store.publishStagedRelease({
			updateDir: setup.updateDir,
			stagingId: staged.stagingId,
			profileKey: "web-abc",
			requireLease: true,
			now: T0,
		});
		assert.equal(missing.reason, "lease-required");
		// 终态之后：同代际也不能再写。
		store.releaseReleaseLease({ updateDir: setup.updateDir, leaseId: claim.lease.leaseId, generation: "gen-current", now: T0 + HOUR });
		const afterTerminal = store.publishStagedRelease({
			updateDir: setup.updateDir,
			stagingId: staged.stagingId,
			profileKey: "web-abc",
			lease: { leaseId: claim.lease.leaseId, generation: "gen-current", phase: "installing" },
			now: T0 + 2 * HOUR,
		});
		assert.equal(afterTerminal.reason, "carrier-lease-terminal");
		assert.equal(store.updateReleaseLease({ updateDir: setup.updateDir, leaseId: claim.lease.leaseId, generation: "other", phase: "installing" }).reason, "carrier-lease-lost");
	});
});

// ── 状态语义 ─────────────────────────────────────────────────────────────────

test("垃圾参数返回稳定状态而不是抛裸异常", () => {
	const calls = [
		() => store.stageRelease(),
		() => store.stageRelease({ updateDir: "", manifest: null }),
		() => store.publishRelease(),
		() => store.publishStagedRelease(),
		() => store.selectRelease(),
		() => store.ensureCarrierStore(),
		() => store.readCarrierOwnership(),
		() => store.readProfilePointer(),
		() => store.readCurrentRelease(),
		() => store.readCurrentRelease({}),
		() => store.openCurrentApp(),
		() => store.resolveRelease(),
		() => store.resolveReleaseObject(),
		() => store.openReleaseObject(),
		() => store.readStagedRelease(),
		() => store.discardStagedRelease(),
		() => store.claimReleaseLease(),
		() => store.updateReleaseLease(),
		() => store.releaseReleaseLease(),
		() => store.readReleaseLease(),
		() => store.collectGarbage(),
		() => store.readCommitLock(),
		() => store.withCarrierCommitLock(),
		() => store.withCarrierCommitLock({ updateDir: "" }, () => 1),
	];
	const allowed = new Set(["unusable", "invalid", "not-ready", "busy", "mismatch", "expired"]);
	for (const call of calls) {
		let result;
		assert.doesNotThrow(() => {
			result = call();
		});
		assert.equal(result.ok, false);
		assert.equal(typeof result.reason, "string");
		assert.ok(result.reason.length > 0);
		assert.ok(allowed.has(result.status), `未预期状态: ${result.status}/${result.reason}`);
	}
});
