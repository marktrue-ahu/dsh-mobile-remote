// 内容标识（CONTEXT「内容标识」）的语义契约：
// 发布侧、产物侧与运行侧必须能对同一份插件算出同一个值，因此「哪些文件参与、以什么顺序、
// 换行怎么处理」都是契约的一部分，必须被钉死。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { CONTENT_DIGEST_VERSION, pluginContentDigest, pluginContentFiles } from "../lib/plugin-content-digest.js";

/** 在临时目录里铺出一个插件骨架；entries 为 { 相对路径: 内容 }。 */
async function makePlugin(entries) {
	const root = await mkdtemp(join(tmpdir(), "plugin-digest-"));
	for (const [rel, content] of Object.entries(entries)) {
		const file = join(root, rel);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, content);
	}
	return root;
}

test("同一目录两次计算结果一致（无随机性）", async () => {
	const root = await makePlugin({
		"package.json": '{"name":"dsh-mobile-remote","version":"3.2.0"}\n',
		"lib/index.js": "export const a = 1;\n",
		"lib/sub/b.js": "export const b = 2;\n",
	});
	try {
		assert.equal(pluginContentDigest(root), pluginContentDigest(root));
		assert.match(pluginContentDigest(root), /^[0-9a-f]{64}$/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("CRLF 与 LF 得到同一内容标识（Windows 检出与 Linux 打包必须一致）", async () => {
	const lf = await makePlugin({
		"package.json": '{"version":"3.2.0"}\n',
		"lib/index.js": "const a = 1;\nconst b = 2;\n",
	});
	const crlf = await makePlugin({
		"package.json": '{"version":"3.2.0"}\r\n',
		"lib/index.js": "const a = 1;\r\nconst b = 2;\r\n",
	});
	try {
		assert.equal(pluginContentDigest(lf), pluginContentDigest(crlf));
	} finally {
		await rm(lf, { recursive: true, force: true });
		await rm(crlf, { recursive: true, force: true });
	}
});

test("仅换行风格之外的内容变化会改变标识", async () => {
	const before = await makePlugin({ "package.json": "{}\n", "lib/index.js": "const a = 1;\n" });
	const after = await makePlugin({ "package.json": "{}\n", "lib/index.js": "const a = 2;\n" });
	try {
		assert.notEqual(pluginContentDigest(before), pluginContentDigest(after));
	} finally {
		await rm(before, { recursive: true, force: true });
		await rm(after, { recursive: true, force: true });
	}
});

test("新增、删除参与文件都会改变标识（同一版本号不同内容可被检出）", async () => {
	const base = { "package.json": '{"version":"3.2.0"}\n', "lib/index.js": "export const a = 1;\n" };
	const a = await makePlugin(base);
	const b = await makePlugin({ ...base, "lib/extra.js": "export const c = 3;\n" });
	try {
		assert.notEqual(pluginContentDigest(a), pluginContentDigest(b));
	} finally {
		await rm(a, { recursive: true, force: true });
		await rm(b, { recursive: true, force: true });
	}
});

test("package.json 参与哈希", async () => {
	const a = await makePlugin({ "package.json": '{"version":"3.2.0"}\n', "lib/index.js": "1\n" });
	const b = await makePlugin({ "package.json": '{"version":"3.2.1"}\n', "lib/index.js": "1\n" });
	try {
		assert.notEqual(pluginContentDigest(a), pluginContentDigest(b));
	} finally {
		await rm(a, { recursive: true, force: true });
		await rm(b, { recursive: true, force: true });
	}
});

test("node_modules 与点文件不参与（安装产物不应影响标识）", async () => {
	const plain = await makePlugin({ "package.json": "{}\n", "lib/index.js": "1\n" });
	const noisy = await makePlugin({
		"package.json": "{}\n",
		"lib/index.js": "1\n",
		"lib/node_modules/dep/index.js": "junk\n",
		"lib/.hidden": "junk\n",
		"node_modules/top/index.js": "junk\n",
	});
	try {
		assert.equal(pluginContentDigest(plain), pluginContentDigest(noisy));
	} finally {
		await rm(plain, { recursive: true, force: true });
		await rm(noisy, { recursive: true, force: true });
	}
});

test("lib/ 之外的文件不参与（docs、README 等改动不构成新版本）", async () => {
	const a = await makePlugin({ "package.json": "{}\n", "lib/index.js": "1\n" });
	const b = await makePlugin({ "package.json": "{}\n", "lib/index.js": "1\n", "docs/03-api.md": "changed\n" });
	try {
		assert.equal(pluginContentDigest(a), pluginContentDigest(b));
	} finally {
		await rm(a, { recursive: true, force: true });
		await rm(b, { recursive: true, force: true });
	}
});

test("参与文件清单按字节序升序、以 / 分隔（与文件系统枚举顺序无关）", async () => {
	const root = await makePlugin({
		"package.json": "{}\n",
		"lib/z.js": "z\n",
		"lib/a.js": "a\n",
		"lib/m/n.js": "n\n",
	});
	try {
		assert.deepEqual(pluginContentFiles(root), ["lib/a.js", "lib/m/n.js", "lib/z.js", "package.json"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("算法版本常量存在且为正整数（改算法必须递增）", () => {
	assert.equal(Number.isInteger(CONTENT_DIGEST_VERSION), true);
	assert.ok(CONTENT_DIGEST_VERSION >= 1);
});
