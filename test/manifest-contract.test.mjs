// 发布清单（CONTEXT「发布清单」）的契约：生成器产出的清单必须能被校验器逐项证实，
// 且与产物（APK / 插件 tgz）逐字节一致。清单是「是否需要更新」的唯一权威，
// 所以「清单与产物不一致」必须是**可检出的失败**，而不是靠人眼看。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { pluginContentDigest } from "../lib/plugin-content-digest.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GEN = join(ROOT, "dsh-mobile-app", "tools", "gen-manifest.js");
const VERIFY = join(ROOT, "dsh-mobile-app", "tools", "verify-update-manifest.mjs");

const APK_BYTES = Buffer.from("fake apk bytes for manifest contract\n");

/** 铺一套发布产物：插件源码 + 由它打包出的 tgz + APK + CHANGELOG。 */
async function makeFixture({ pluginUrl = "", pluginPkg = null } = {}) {
	const base = await mkdtemp(join(tmpdir(), "manifest-contract-"));
	const dist = join(base, "dist");
	const plugin = join(base, "plugin");
	const stage = join(base, "stage");
	await mkdir(dist, { recursive: true });
	await mkdir(plugin, { recursive: true });

	await writeFile(
		join(plugin, "package.json"),
		JSON.stringify(pluginPkg ?? { name: "dsh-mobile-remote", version: "3.2.0" }, null, 2) + "\n",
	);
	await mkdir(join(plugin, "lib"), { recursive: true });
	await writeFile(join(plugin, "lib", "index.js"), "export const plugin = true;\n");

	// tgz 的 package/ 必须是插件根的等价副本（内容标识要对得上）
	await cp(plugin, join(stage, "package"), { recursive: true });
	const tgz = join(dist, "dsh-mobile-remote-v3.2.0.tgz");
	const tar = spawnSync("tar", ["-czf", tgz, "-C", stage, "package"], { encoding: "utf8" });
	assert.equal(tar.status, 0, `tar 打包失败：${tar.stderr}`);

	const apk = join(dist, "DSH-Remote-v3.2.0.apk");
	await writeFile(apk, APK_BYTES);

	const changelog = join(base, "CHANGELOG.md");
	await writeFile(changelog, "## v3.2.0（模拟）— 契约测试条目\n\n- 一条说明。\n");

	const manifest = join(dist, "manifest.json");
	const args = [
		GEN,
		"--apk", apk,
		"--version", "3.2.0+44",
		"--plugin-tgz", tgz,
		"--plugin-root", plugin,
		"--changelog", changelog,
		"--out", manifest,
	];
	if (pluginUrl) args.push("--plugin-url", pluginUrl);
	const gen = spawnSync(process.execPath, args, { encoding: "utf8" });
	assert.equal(gen.status, 0, `gen-manifest 失败：${gen.stderr}${gen.stdout}`);

	return { base, dist, tgz, apk, manifest, plugin };
}

function verify(dist) {
	return spawnSync(process.execPath, [VERIFY, dist], { encoding: "utf8" });
}

test("清单描述两端产物：schema/app/plugin 齐全，且镜像与 app 段同源", async () => {
	const f = await makeFixture({ pluginUrl: "https://example.com/dsh-mobile-remote-v3.2.0.tgz" });
	try {
		const m = JSON.parse(await readFile(f.manifest, "utf8"));
		assert.equal(m.schema, 1);
		assert.equal(m.app.version, "3.2.0+44");
		assert.equal(m.app.file, "DSH-Remote-v3.2.0.apk");
		assert.equal(m.app.size, APK_BYTES.length);
		assert.equal(m.plugin.version, "3.2.0");
		assert.equal(m.plugin.file, "dsh-mobile-remote-v3.2.0.tgz");
		assert.equal(m.plugin.url, "https://example.com/dsh-mobile-remote-v3.2.0.tgz");
		// 兼容镜像
		assert.equal(m.version, m.app.version);
		assert.equal(m.apk, m.app.file);
		assert.equal(m.size, m.app.size);
		assert.equal(m.sha256, m.app.sha256);
		assert.ok(typeof m.notes === "string" && m.notes.includes("契约测试条目"));
	} finally {
		await rm(f.base, { recursive: true, force: true });
	}
});

test("plugin.contentSha256 等于对插件源码的实算值（发布侧与运行侧同算法）", async () => {
	const f = await makeFixture();
	try {
		const m = JSON.parse(await readFile(f.manifest, "utf8"));
		assert.equal(m.plugin.contentSha256, pluginContentDigest(f.plugin));
	} finally {
		await rm(f.base, { recursive: true, force: true });
	}
});

test("校验器对自洽的产物返回 0（含 tgz 解包复算）", async () => {
	const f = await makeFixture();
	try {
		const r = verify(f.dist);
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.match(r.stdout, /RESULT: PASS/);
		assert.match(r.stdout, /plugin\.contentSha256 与 tgz 解包实算一致/);
	} finally {
		await rm(f.base, { recursive: true, force: true });
	}
});

test("tgz 被篡改（字节级）→ 校验器失败", async () => {
	const f = await makeFixture();
	try {
		await appendFile(f.tgz, "tampered");
		const r = verify(f.dist);
		assert.notEqual(r.status, 0);
		assert.match(r.stdout, /RESULT: FAIL/);
		assert.match(r.stdout, /plugin\.size 与字节数一致/);
	} finally {
		await rm(f.base, { recursive: true, force: true });
	}
});

test("tgz 内插件内容被替换而清单未更新 → 校验器失败（内容标识与字节哈希都会变）", async () => {
	const f = await makeFixture();
	try {
		const stage = join(f.base, "stage2");
		await cp(f.plugin, join(stage, "package"), { recursive: true });
		await writeFile(join(stage, "package", "lib", "index.js"), "export const plugin = 'tampered';\n");
		const tar = spawnSync("tar", ["-czf", f.tgz, "-C", stage, "package"], { encoding: "utf8" });
		assert.equal(tar.status, 0, tar.stderr);

		const m = JSON.parse(await readFile(f.manifest, "utf8"));
		assert.notEqual(m.plugin.contentSha256, pluginContentDigest(join(stage, "package")));

		const r = verify(f.dist);
		assert.notEqual(r.status, 0, r.stdout);
		assert.match(r.stdout, /RESULT: FAIL/);
	} finally {
		await rm(f.base, { recursive: true, force: true });
	}
});

test("镜像与 app 段不一致（旧版 App 读到的值与新字段不同）→ 校验器失败", async () => {
	const f = await makeFixture();
	try {
		const m = JSON.parse(await readFile(f.manifest, "utf8"));
		m.version = "3.2.0+99"; // 只改镜像，不改 app 段
		await writeFile(f.manifest, JSON.stringify(m, null, 2) + "\n");
		const r = verify(f.dist);
		assert.notEqual(r.status, 0);
		assert.match(r.stdout, /镜像 version 与 app\.version 一致/);
	} finally {
		await rm(f.base, { recursive: true, force: true });
	}
});

test("缺 plugin 段的旧清单 → 校验器失败（不再把半份清单当通过）", async () => {
	const f = await makeFixture();
	try {
		const m = JSON.parse(await readFile(f.manifest, "utf8"));
		delete m.plugin;
		await writeFile(f.manifest, JSON.stringify(m, null, 2) + "\n");
		const r = verify(f.dist);
		assert.notEqual(r.status, 0);
		assert.match(r.stdout, /plugin\.version 为 X\.Y\.Z/);
	} finally {
		await rm(f.base, { recursive: true, force: true });
	}
});

test("生成器拒绝缺少 plugin-tgz 的调用（发布必须同时产出两端）", async () => {
	const f = await makeFixture();
	try {
		const gen = spawnSync(process.execPath, [
			GEN,
			"--apk", f.apk,
			"--version", "3.2.0+44",
			"--changelog", join(f.base, "CHANGELOG.md"),
			"--out", join(f.dist, "manifest2.json"),
		], { encoding: "utf8" });
		assert.notEqual(gen.status, 0);
		assert.match(gen.stderr, /--plugin-tgz/);
	} finally {
		await rm(f.base, { recursive: true, force: true });
	}
});

test("未给 plugin-url 时不写 url 字段（由消费方相对清单地址解析）", async () => {
	const f = await makeFixture();
	try {
		const m = JSON.parse(await readFile(f.manifest, "utf8"));
		assert.equal("url" in m.plugin, false);
	} finally {
		await rm(f.base, { recursive: true, force: true });
	}
});

test("plugin.url 非法（解析不了 / 非 https 非回环）→ 校验器失败（W4）", async () => {
	const f = await makeFixture({ pluginUrl: "https://example.com/p.tgz" });
	try {
		for (const bad of ["https://[bad", "http://192.168.1.5/p.tgz", "file:///p.tgz", "not a url"]) {
			const m = JSON.parse(await readFile(f.manifest, "utf8"));
			m.plugin.url = bad;
			await writeFile(f.manifest, JSON.stringify(m, null, 2) + "\n");
			const r = verify(f.dist);
			assert.notEqual(r.status, 0, `应拒绝：${bad}`);
			assert.match(r.stdout, /plugin\.url 若给出则为可解析的 https/);
		}
		// 回环 http 允许（自建主机源场景）
		const ok = JSON.parse(await readFile(f.manifest, "utf8"));
		ok.plugin.url = "http://127.0.0.1:3080/m/api/update/plugin";
		await writeFile(f.manifest, JSON.stringify(ok, null, 2) + "\n");
		assert.equal(verify(f.dist).status, 0);
	} finally {
		await rm(f.base, { recursive: true, force: true });
	}
});

test("tgz 未内联运行时依赖 → 校验器失败（R13：不能只看哈希）", async () => {
	const f = await makeFixture({
		pluginPkg: { name: "dsh-mobile-remote", version: "3.2.0", dependencies: { qrcode: "^1.5.4" } },
	});
	try {
		const r = verify(f.dist);
		assert.notEqual(r.status, 0);
		assert.match(r.stdout, /tgz 自包含运行时依赖/);
		assert.match(r.stdout, /缺：qrcode/);
	} finally {
		await rm(f.base, { recursive: true, force: true });
	}
});

test("tgz 已内联运行时依赖 → 该项通过（与真实发布产物一致）", async () => {
	const f = await makeFixture({
		pluginPkg: { name: "dsh-mobile-remote", version: "3.2.0", dependencies: { qrcode: "^1.5.4" } },
	});
	try {
		// 把依赖"内联"进 tgz（真实流程由 npm pack + bundleDependencies 完成）
		const bundled = join(f.base, "stage", "package", "node_modules", "qrcode");
		await mkdir(bundled, { recursive: true });
		await writeFile(join(bundled, "package.json"), '{"name":"qrcode","version":"1.5.4","main":"index.js"}\n');
		await writeFile(join(bundled, "index.js"), "module.exports = {};\n");
		const tar = spawnSync("tar", ["-czf", f.tgz, "-C", join(f.base, "stage"), "package"], { encoding: "utf8" });
		assert.equal(tar.status, 0, tar.stderr);
		// 内容变了 → 重新生成清单再校验
		const gen = spawnSync(process.execPath, [
			GEN,
			"--apk", f.apk,
			"--version", "3.2.0+44",
			"--plugin-tgz", f.tgz,
			"--plugin-root", f.plugin,
			"--changelog", join(f.base, "CHANGELOG.md"),
			"--out", f.manifest,
		], { encoding: "utf8" });
		assert.equal(gen.status, 0, gen.stderr);
		const r = verify(f.dist);
		assert.equal(r.status, 0, r.stdout);
		assert.match(r.stdout, /tgz 自包含运行时依赖（解包后可解析） \(dependencies=qrcode\)/);
	} finally {
		await rm(f.base, { recursive: true, force: true });
	}
});
