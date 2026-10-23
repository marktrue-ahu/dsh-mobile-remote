// 插件侧更新判定的契约：
//   - 「要不要下载」只看**内容标识**（版本号相同、内容不同必须被识别为应更新）；
//   - 缺内容标识时如实标注盲区，不假装判断完整；
//   - 「降级指引」按安装形态给出**对应那一条**，不并列三条让用户猜。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	INSTALL_SHAPE,
	UPDATE_ACTION,
	UPDATE_MODE,
	classifySpecifier,
	compareSemanticVersion,
	compareVersion,
	decidePluginUpdate,
	detectInstallShape,
	normalizeReleaseManifest,
	parseVersion,
	planForShape,
	resolvePluginUrl,
} from "../lib/plugin-update.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

const goodManifest = (over = {}) => ({
	schema: 1,
	app: { version: "3.2.0+44" },
	plugin: {
		version: "3.2.0",
		file: "dsh-mobile-remote-v3.2.0.tgz",
		size: 100,
		sha256: DIGEST_A,
		contentSha256: DIGEST_B,
		...over,
	},
});

test("parseVersion 只接受 X.Y.Z 与 X.Y.Z+N", () => {
	assert.deepEqual(parseVersion("3.2.0"), { major: 3, minor: 2, patch: 0, build: null });
	assert.deepEqual(parseVersion("3.2.0+44"), { major: 3, minor: 2, patch: 0, build: 44 });
	assert.deepEqual(parseVersion(" 3.2.0 "), { major: 3, minor: 2, patch: 0, build: null });
	assert.equal(parseVersion("3.2"), null);
	assert.equal(parseVersion("v3.2.0"), null);
	assert.equal(parseVersion(""), null);
	assert.equal(parseVersion(undefined), null);
});

test("compareVersion 在语义版本相同时才比较 build", () => {
	assert.equal(compareVersion("3.2.0", "3.2.0"), 0);
	assert.equal(compareVersion("3.2.0+44", "3.2.0+23"), 1);
	assert.equal(compareVersion("3.1.9+99", "3.2.0+1"), -1);
	assert.equal(compareVersion("3.2.0+44", "3.2.0"), 0); // 一侧无 build 时不参与
	assert.equal(compareVersion("bad", "3.2.0"), null);
});

test("compareSemanticVersion 忽略 build（同一发布周期内不误报）", () => {
	assert.equal(compareSemanticVersion("3.2.0+44", "3.2.0+23"), 0);
	assert.equal(compareSemanticVersion("3.2.0", "3.1.5"), 1);
	assert.equal(compareSemanticVersion("3.1.5", "3.2.0"), -1);
});

test("normalizeReleaseManifest 接受 schema 1 并保留所需字段", () => {
	const r = normalizeReleaseManifest(goodManifest());
	assert.equal(r.ok, true);
	assert.equal(r.plugin.version, "3.2.0");
	assert.equal(r.plugin.sha256, DIGEST_A);
	assert.equal(r.plugin.contentSha256, DIGEST_B);
	assert.equal(r.plugin.url, "");
	assert.equal(r.app.version, "3.2.0+44");
});

test("normalizeReleaseManifest 对缺失/非法字段报明确错误，不猜测", () => {
	assert.equal(normalizeReleaseManifest(null).error, "manifest-not-object");
	assert.equal(normalizeReleaseManifest({ schema: 2, plugin: {} }).error, "manifest-schema-unsupported");
	assert.equal(normalizeReleaseManifest({ schema: 1 }).error, "manifest-plugin-missing");
	assert.equal(normalizeReleaseManifest(goodManifest({ version: "3.2" })).error, "manifest-plugin-version-invalid");
	assert.equal(normalizeReleaseManifest(goodManifest({ file: "" })).error, "manifest-plugin-file-missing");
	assert.equal(normalizeReleaseManifest(goodManifest({ sha256: "zz" })).error, "manifest-plugin-sha256-invalid");
	assert.equal(
		normalizeReleaseManifest(goodManifest({ contentSha256: "not-a-hash" })).error,
		"manifest-plugin-content-sha256-invalid",
	);
});

test("normalizeReleaseManifest：contentSha256 可缺省（旧清单仍可解析）", () => {
	const m = goodManifest();
	delete m.plugin.contentSha256;
	const r = normalizeReleaseManifest(m);
	assert.equal(r.ok, true);
	assert.equal(r.plugin.contentSha256, "");
});

test("resolvePluginUrl：清单给了 url 就用它，否则相对清单地址解析", () => {
	const base = "https://example.com/releases/v3.2.0/manifest.json";
	assert.equal(resolvePluginUrl(base, { url: "https://cdn/x.tgz", file: "y.tgz" }), "https://cdn/x.tgz");
	assert.equal(resolvePluginUrl(base, { url: "", file: "dsh-mobile-remote-v3.2.0.tgz" }), "https://example.com/releases/v3.2.0/dsh-mobile-remote-v3.2.0.tgz");
	assert.equal(resolvePluginUrl("", { url: "", file: "x.tgz" }), "");
	assert.equal(resolvePluginUrl(base, { url: "", file: "" }), "");
});

test("内容标识相同 → 已是最新（即使版本号不同也不下载）", () => {
	const r = decidePluginUpdate({
		localVersion: "3.2.0",
		localContentSha256: DIGEST_B,
		remote: { version: "3.2.1", contentSha256: DIGEST_B },
	});
	assert.equal(r.action, UPDATE_ACTION.UP_TO_DATE);
	assert.equal(r.reason, "content-identical");
});

test("版本号相同、内容不同 → 判定为应更新（这正是版本比较看不见的形态）", () => {
	const r = decidePluginUpdate({
		localVersion: "3.2.0",
		localContentSha256: DIGEST_A,
		remote: { version: "3.2.0", contentSha256: DIGEST_B },
	});
	assert.equal(r.action, UPDATE_ACTION.UPDATE_AVAILABLE);
	assert.equal(r.reason, "content-differs-same-version");
	assert.equal(r.comparison, 0);
});

test("远端更新 → 应更新；本地更新 → 不降级", () => {
	assert.equal(
		decidePluginUpdate({ localVersion: "3.1.5", localContentSha256: DIGEST_A, remote: { version: "3.2.0", contentSha256: DIGEST_B } }).action,
		UPDATE_ACTION.UPDATE_AVAILABLE,
	);
	assert.equal(
		decidePluginUpdate({ localVersion: "3.2.0", localContentSha256: DIGEST_A, remote: { version: "3.1.5", contentSha256: DIGEST_B } }).action,
		UPDATE_ACTION.LOCAL_AHEAD,
	);
});

test("缺内容标识时退化为版本比较，并在 reason 里标注盲区", () => {
	const newer = decidePluginUpdate({ localVersion: "3.1.5", localContentSha256: DIGEST_A, remote: { version: "3.2.0", contentSha256: "" } });
	assert.equal(newer.action, UPDATE_ACTION.UPDATE_AVAILABLE);
	assert.equal(newer.reason, "version-newer-no-content-digest");

	const equal = decidePluginUpdate({ localVersion: "3.2.0", localContentSha256: DIGEST_A, remote: { version: "3.2.0", contentSha256: "" } });
	assert.equal(equal.action, UPDATE_ACTION.UP_TO_DATE);
	assert.equal(equal.reason, "version-equal-no-content-digest");
});

test("远端版本不可解析 → UNKNOWN（不猜）", () => {
	assert.equal(decidePluginUpdate({ localVersion: "3.2.0", localContentSha256: "", remote: { version: "x" } }).action, UPDATE_ACTION.UNKNOWN);
	assert.equal(decidePluginUpdate({ localVersion: "3.2.0", localContentSha256: "", remote: null }).action, UPDATE_ACTION.UNKNOWN);
});

test("classifySpecifier 覆盖 docs/06 的三种安装方式", () => {
	assert.equal(classifySpecifier("^3.2.0"), INSTALL_SHAPE.REGISTRY);
	assert.equal(classifySpecifier("3.2.0"), INSTALL_SHAPE.REGISTRY);
	assert.equal(classifySpecifier("github:201222-L/dsh-mobile-remote#v3.2.0"), INSTALL_SHAPE.GITHUB_TAG);
	assert.equal(classifySpecifier("file:/home/me/dsh-mobile-remote"), INSTALL_SHAPE.FILE_DIR);
	assert.equal(classifySpecifier("file:./dsh-mobile-remote-v3.2.0.tgz"), INSTALL_SHAPE.TGZ_FILE);
	assert.equal(classifySpecifier("link:../plugin"), INSTALL_SHAPE.UNKNOWN);
	assert.equal(classifySpecifier(""), INSTALL_SHAPE.UNKNOWN);
});

test("detectInstallShape 用注入的谓词区分 clone 与普通目录", () => {
	const spec = "file:/home/me/dsh-mobile-remote";
	assert.equal(detectInstallShape({ specifier: spec, dirPath: "/home/me/dsh-mobile-remote", isGitRepo: () => true }), INSTALL_SHAPE.FILE_CLONE);
	assert.equal(detectInstallShape({ specifier: spec, dirPath: "/home/me/dsh-mobile-remote", isGitRepo: () => false }), INSTALL_SHAPE.FILE_DIR);
	assert.equal(detectInstallShape({ specifier: "github:a/b#v1" }), INSTALL_SHAPE.GITHUB_TAG);
});

test("planForShape：可自动的形态给出可执行命令", () => {
	for (const shape of [INSTALL_SHAPE.REGISTRY, INSTALL_SHAPE.GITHUB_TAG, INSTALL_SHAPE.FILE_DIR, INSTALL_SHAPE.TGZ_FILE]) {
		const plan = planForShape(shape, { specifier: "^3.1.5" });
		assert.equal(plan.mode, UPDATE_MODE.AUTO, shape);
		assert.ok(plan.commands.length > 0, shape);
		assert.ok(plan.summary.length > 0, shape);
	}
	const clone = planForShape(INSTALL_SHAPE.FILE_CLONE, { dirPath: "/home/me/plugin" });
	assert.equal(clone.mode, UPDATE_MODE.AUTO);
	assert.match(clone.commands[0], /git -C \/home\/me\/plugin pull/);
});

test("planForShape：无法识别时给指引而非并列三条，且不带可执行命令", () => {
	const plan = planForShape(INSTALL_SHAPE.UNKNOWN);
	assert.equal(plan.mode, UPDATE_MODE.GUIDANCE);
	assert.deepEqual(plan.commands, []);
	assert.ok(plan.steps.length <= 3);
	assert.match(plan.summary, /无法识别/);
});
