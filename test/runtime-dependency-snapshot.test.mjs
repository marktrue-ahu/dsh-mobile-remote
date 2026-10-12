import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { freezePackage, frozenPackageReady, verifyFrozenPackage, verifyRuntimeClosure } from "../lib/runtime-dependency-snapshot.js";

function put(file, content) {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
}
function removeFixture(path, base) {
	assert.ok(resolve(path) === resolve(base) || resolve(path).startsWith(resolve(base) + "/"));
	rmSync(path, { recursive: true, force: true });
}
function fixture(t) {
	const base = mkdtempSync(join(tmpdir(), "runtime-snapshot-"));
	t.after(() => removeFixture(base, base));
	const source = join(base, "source");
	const installed = join(source, "node_modules/.pnpm/plugin@1/node_modules/dsh-mobile-remote");
	const qrcode = join(source, "node_modules/.pnpm/qrcode@1/node_modules/qrcode");
	const pngjs = join(source, "node_modules/.pnpm/pngjs@1/node_modules/pngjs");
	put(join(installed, "package.json"), JSON.stringify({ name: "dsh-mobile-remote", type: "module", dependencies: { qrcode: "1" } }));
	put(join(installed, "lib/index.js"), "export const oldPlugin = true;\n");
	put(join(qrcode, "package.json"), JSON.stringify({ name: "qrcode", main: "index.js", dependencies: { pngjs: "1" } }));
	put(join(qrcode, "index.js"), "exports.toBuffer = async () => require('pngjs').png;\n");
	put(join(pngjs, "package.json"), JSON.stringify({ name: "pngjs", main: "index.js" }));
	put(join(pngjs, "index.js"), "exports.png = Buffer.from([137,80,78,71,13,10,26,10,0]);\n");
	// 标准 pnpm sibling 布局：插件根没有 node_modules，Node 从上一级找到链接。
	symlinkSync(qrcode, join(dirname(installed), "qrcode"), "dir");
	symlinkSync(pngjs, join(dirname(qrcode), "pngjs"), "dir");
	return { base, source, installed, qrcode, pngjs, destination: join(base, "snapshot") };
}
function loadPng(root) {
	return spawnSync(process.execPath, ["--no-global-search-paths", "-e", `
		const { createRequire } = require('node:module');
		const req = createRequire(process.argv[1] + '/package.json');
		req('qrcode').toBuffer('snapshot smoke').then(bytes => {
			if (!Buffer.isBuffer(bytes) || bytes[0] !== 137) throw new Error('not png');
		}).catch(error => { console.error(error); process.exitCode = 1; });
	`, root], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: dirname(root) }, cwd: dirname(root) });
}

test("pnpm sibling 源/store 移除后，冻结快照仍可执行 qrcode 的 lazy PNG API", async (t) => {
	const f = fixture(t);
	assert.equal((await createRequire(join(f.installed, "package.json"))("qrcode").toBuffer("source"))[0], 137);
	const frozen = freezePackage({ sourceRoot: f.installed, destination: f.destination });
	assert.equal(frozen.ok, true, frozen.error);
	removeFixture(f.source, f.base);
	assert.equal(existsSync(f.source), false);
	const loaded = loadPng(f.destination);
	assert.equal(loaded.status, 0, loaded.stderr);
	assert.equal(frozenPackageReady(f.destination), true);
	const checked = verifyRuntimeClosure(f.destination);
	assert.equal(checked.ok, true, checked.error);
	assert.ok(checked.loadedFiles.some((file) => file.endsWith("/index.js")));
	assert.ok(checked.loadedFiles.every((file) => file.startsWith(f.destination + "/")));
});

test("缺 marker 的半目录与坏/旧 marker 都不能复用，也不覆盖旧目标", (t) => {
	const f = fixture(t);
	put(join(f.destination, "lib/index.js"), "OLD PARTIAL\n");
	for (const marker of [null, "{", '{"at":"2026-10-11"}', '{"schema":1,"algorithm":"sha256","digest":"' + "0".repeat(64) + '","entries":1}']) {
		if (marker !== null) put(join(f.destination, ".complete"), marker);
		assert.equal(frozenPackageReady(f.destination), false);
		const frozen = freezePackage({ sourceRoot: f.installed, destination: f.destination });
		assert.equal(frozen.ok, false);
		assert.match(frozen.error, /destination-exists/);
		assert.equal(readFileSync(join(f.destination, "lib/index.js"), "utf8"), "OLD PARTIAL\n");
	}
});

test("完整 marker 不能掩盖损坏依赖字节；digest 不只覆盖插件 lib", (t) => {
	const f = fixture(t);
	assert.equal(freezePackage({ sourceRoot: f.installed, destination: f.destination }).ok, true);
	const req = createRequire(join(f.destination, "package.json"));
	const qrcodeEntry = req.resolve("qrcode");
	const pngEntry = createRequire(qrcodeEntry).resolve("pngjs");
	writeFileSync(pngEntry, "exports.png = Buffer.from('corrupt');\n");
	const checked = verifyFrozenPackage(f.destination);
	assert.equal(checked.ok, false);
	assert.match(checked.error, /integrity-mismatch/);
	assert.equal(frozenPackageReady(f.destination), false);
});

test("完整快照不可覆盖：拷贝失败或再次调用不破坏现有回滚字节", (t) => {
	const f = fixture(t);
	assert.equal(freezePackage({ sourceRoot: f.installed, destination: f.destination }).ok, true);
	const marker = readFileSync(join(f.destination, ".complete"), "utf8");
	const again = freezePackage({ sourceRoot: f.installed, destination: f.destination, copyFile() { throw new Error("must-not-copy"); } });
	assert.equal(again.ok, false);
	assert.match(again.error, /destination-exists/);
	assert.equal(readFileSync(join(f.destination, ".complete"), "utf8"), marker);
	assert.equal(frozenPackageReady(f.destination), true);
});

test("copy 中途抛错或显式失败：不发布半成品/marker，并清理私有 staging", (t) => {
	const f = fixture(t);
	for (const explicit of [false, true]) {
		let calls = 0;
		const failed = freezePackage({ sourceRoot: f.installed, destination: f.destination, copyFile(src, dest) {
			copyFileSync(src, dest);
			if (++calls === 3) {
				assert.equal(existsSync(f.destination), false, "验证前不能观察到已发布目录");
				if (explicit) return { ok: false, error: "copy-return-failure" };
				throw new Error("copy-throw-failure");
			}
		} });
		assert.equal(failed.ok, false);
		assert.match(failed.error, /copy-(throw|return)-failure/);
		assert.equal(existsSync(f.destination), false);
		assert.deepEqual(readdirSync(f.base), ["source"]);
	}
});

test("内部链接传递到外部 store 的目录/文件被实拷贝，移除外链源仍能加载", (t) => {
	const f = fixture(t);
	const external = join(f.base, "external");
	put(join(external, "png.js"), "exports.png = Buffer.from([137,80,78,71,13,10,26,10]);\n");
	removeFixture(join(f.pngjs, "index.js"), f.base);
	symlinkSync(join(external, "png.js"), join(f.pngjs, "index.js"));
	const frozen = freezePackage({ sourceRoot: f.installed, destination: f.destination });
	assert.equal(frozen.ok, true, frozen.error);
	removeFixture(f.source, f.base);
	removeFixture(external, f.base);
	assert.equal(loadPng(f.destination).status, 0);
	assert.equal(frozenPackageReady(f.destination), true);
});

test("必需 broken 依赖链接不能被上层同名污染包兜底后假绿", (t) => {
	const f = fixture(t);
	removeFixture(join(dirname(f.qrcode), "pngjs"), f.base);
	symlinkSync(join(f.base, "missing-pngjs"), join(dirname(f.qrcode), "pngjs"), "dir");
	put(join(f.source, "node_modules/pngjs/package.json"), '{"name":"pngjs","main":"index.js"}');
	put(join(f.source, "node_modules/pngjs/index.js"), "exports.png = Buffer.from([137,80,78,71,13,10,26,10]);\n");
	const frozen = freezePackage({ sourceRoot: f.installed, destination: f.destination });
	assert.equal(frozen.ok, false);
	assert.match(frozen.error, /broken-required-link/);
	assert.equal(existsSync(f.destination), false);
});

test("lib 必需 broken 文件链接不能 skip 后写完成 marker", (t) => {
	const f = fixture(t);
	symlinkSync(join(f.base, "gone.js"), join(f.installed, "lib/required.js"));
	const frozen = freezePackage({ sourceRoot: f.installed, destination: f.destination });
	assert.equal(frozen.ok, false);
	assert.match(frozen.error, /ENOENT/);
	assert.equal(existsSync(f.destination), false);
});

test("依赖 require 抛错或 qrcode 的 lazy API 抛错都阻止发布", (t) => {
	const f = fixture(t);
	for (const code of ["throw new Error('boom-on-require');", "exports.toBuffer = async () => { throw new Error('boom-on-lazy-api'); };", "module.exports = {};"]) {
		put(join(f.qrcode, "index.js"), code);
		const frozen = freezePackage({ sourceRoot: f.installed, destination: f.destination });
		assert.equal(frozen.ok, false);
		assert.match(frozen.error, /qrcode:加载失败/);
		assert.equal(existsSync(f.destination), false);
		assert.deepEqual(readdirSync(f.base), ["source"]);
	}
});

test("依赖循环按真实包身份冻结，不递归失控，internal symlink 闭包可验证", (t) => {
	const f = fixture(t);
	put(join(f.pngjs, "package.json"), JSON.stringify({ name: "pngjs", main: "index.js", dependencies: { qrcode: "1" } }));
	symlinkSync(f.qrcode, join(dirname(f.pngjs), "qrcode"), "dir");
	const frozen = freezePackage({ sourceRoot: f.installed, destination: f.destination });
	assert.equal(frozen.ok, true, frozen.error);
	removeFixture(f.source, f.base);
	assert.equal(verifyFrozenPackage(f.destination).ok, true);
});

test("未声明的 lazy require 也核 realpath：上层污染包即使可加载也必须拒绝", (t) => {
	const f = fixture(t);
	const clean = join(f.base, "release/package");
	put(join(clean, "package.json"), JSON.stringify({ dependencies: { qrcode: "1" } }));
	put(join(clean, "lib/index.js"), "// payload\n");
	put(join(clean, "node_modules/qrcode/package.json"), '{"name":"qrcode","main":"index.js"}');
	put(join(clean, "node_modules/qrcode/index.js"), "exports.toBuffer = async () => require('pollution').png;\n");
	put(join(f.base, "node_modules/pollution/package.json"), '{"name":"pollution","main":"index.js"}');
	put(join(f.base, "node_modules/pollution/index.js"), "exports.png = Buffer.from([137,80,78,71,13,10,26,10]);\n");
	const checked = verifyRuntimeClosure(clean);
	assert.equal(checked.ok, false);
	assert.match(checked.error, /runtime-load-outside-package/);
});

test("恢复复制保留内部相对 symlink 后可跨目录搬迁，原源与快照都移除仍通过 digest", (t) => {
	const f = fixture(t);
	const frozen = freezePackage({ sourceRoot: f.installed, destination: f.destination });
	assert.equal(frozen.ok, true, frozen.error);
	const restored = join(f.base, "restored/installed-package");
	cpSync(f.destination, restored, { recursive: true, dereference: false, verbatimSymlinks: true });
	removeFixture(f.source, f.base);
	removeFixture(f.destination, f.base);
	const checked = verifyFrozenPackage(restored);
	assert.equal(checked.ok, true, checked.error);
	assert.equal(checked.digest, frozen.digest);
	assert.ok(checked.loadedFiles.every((file) => file.startsWith(restored + "/")));
	assert.equal(loadPng(restored).status, 0);
});

test("目标经 symlink 别名落入源目录也必须拒绝，不创建 staging 或修改源", (t) => {
	const f = fixture(t);
	const alias = join(f.base, "alias");
	symlinkSync(join(f.installed, "lib"), alias, "dir");
	const frozen = freezePackage({ sourceRoot: f.installed, destination: join(alias, "nested/snapshot") });
	assert.equal(frozen.ok, false);
	assert.match(frozen.error, /source-destination-overlap/);
	assert.deepEqual(readdirSync(join(f.installed, "lib")), ["index.js"]);
});

test("同名传递依赖的不同版本按真实包身份分别冻结，不因扁平化串版本", (t) => {
	const f = fixture(t);
	put(join(f.installed, "package.json"), JSON.stringify({ dependencies: { qrcode: "1", left: "1", right: "1" } }));
	for (const [name, value] of [["left", 111], ["right", 222]]) {
		const owner = join(f.source, `node_modules/.pnpm/${name}@1/node_modules/${name}`);
		const shared = join(f.source, `node_modules/.pnpm/shared@${value}/node_modules/shared`);
		put(join(owner, "package.json"), JSON.stringify({ name, main: "index.js", dependencies: { shared: String(value) } }));
		put(join(owner, "index.js"), "module.exports = require('shared');\n");
		put(join(shared, "package.json"), '{"name":"shared","main":"index.js"}');
		put(join(shared, "index.js"), `module.exports = ${value};\n`);
		symlinkSync(shared, join(dirname(owner), "shared"), "dir");
		symlinkSync(owner, join(dirname(f.installed), name), "dir");
	}
	const frozen = freezePackage({ sourceRoot: f.installed, destination: f.destination });
	assert.equal(frozen.ok, true, frozen.error);
	removeFixture(f.source, f.base);
	const req = createRequire(join(f.destination, "package.json"));
	assert.equal(req("left"), 111);
	assert.equal(req("right"), 222);
	assert.equal(verifyFrozenPackage(f.destination).ok, true);
});

test("包内 lazy ESM import 的加载闭包可冻结并在移除源后运行", (t) => {
	const f = fixture(t);
	put(join(f.pngjs, "package.json"), JSON.stringify({ name: "pngjs", type: "module", main: "index.mjs" }));
	put(join(f.pngjs, "index.mjs"), "export const png = Buffer.from([137,80,78,71,13,10,26,10]);\n");
	put(join(f.qrcode, "index.js"), "exports.toBuffer = async () => (await import('pngjs')).png;\n");
	const frozen = freezePackage({ sourceRoot: f.installed, destination: f.destination });
	assert.equal(frozen.ok, true, frozen.error);
	removeFixture(f.source, f.base);
	const checked = verifyFrozenPackage(f.destination);
	assert.equal(checked.ok, true, checked.error);
	assert.ok(checked.loadedFiles.some((file) => file.endsWith("/index.mjs")));
	assert.equal(loadPng(f.destination).status, 0);
});

test("require 分支包内但 lazy import 分支传递到外部文件，也不能假绿", (t) => {
	const f = fixture(t);
	const external = join(f.base, "outside.mjs");
	put(external, "export const png = Buffer.from([137,80,78,71,13,10,26,10]);\n");
	put(join(f.pngjs, "package.json"), JSON.stringify({ name: "pngjs", exports: { require: "./index.js", import: "./import.mjs" } }));
	put(join(f.pngjs, "import.mjs"), `export { png } from ${JSON.stringify(external)};\n`);
	put(join(f.qrcode, "index.js"), "exports.toBuffer = async () => (await import('pngjs')).png;\n");
	const frozen = freezePackage({ sourceRoot: f.installed, destination: f.destination });
	assert.equal(frozen.ok, false);
	assert.match(frozen.error, /runtime-load-outside-package/);
	assert.equal(existsSync(f.destination), false);
});

test("真实 qrcode 的标准 pnpm sibling store 移除后，全部 dependencies 与 PNG API 仍在闭包内", (t) => {
	const f = fixture(t);
	const root = fileURLToPath(new URL("..", import.meta.url));
	// 只从当前工作树的已安装依赖构造临时 store，不借真实 profile，也不移除仓库源。
	const store = join(f.source, "actual-qrcode-store");
	const seeded = freezePackage({ sourceRoot: root, destination: store });
	assert.equal(seeded.ok, true, seeded.error);
	removeFixture(join(dirname(f.installed), "qrcode"), f.base);
	symlinkSync(join(store, "node_modules/qrcode"), join(dirname(f.installed), "qrcode"), "dir");
	const frozen = freezePackage({ sourceRoot: f.installed, destination: f.destination });
	assert.equal(frozen.ok, true, frozen.error);
	const checked = verifyFrozenPackage(f.destination);
	assert.equal(checked.ok, true, checked.error);
	assert.ok(checked.packageCount >= 10);
	const qrcodeEntry = createRequire(join(f.destination, "package.json")).resolve("qrcode");
	const pngEntry = createRequire(qrcodeEntry).resolve("pngjs");
	assert.ok(checked.loadedFiles.includes(pngEntry));
	assert.ok(checked.loadedFiles.every((file) => file.startsWith(f.destination + "/")));
	removeFixture(f.source, f.base);
	assert.equal(existsSync(store), false);
	assert.equal(loadPng(f.destination).status, 0);
	assert.equal(verifyFrozenPackage(f.destination).ok, true);
});
