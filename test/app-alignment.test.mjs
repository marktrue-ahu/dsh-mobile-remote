// 两端对齐状态（CONTEXT「对齐提示」）的语义：
// 版本号只决定提示文案；比较只看语义版本 `X.Y.Z`；旧 App 不上报版本头是可靠信号而非错误。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ALIGNMENT_STATE,
	APP_VERSION_HEADER,
	computeAppAlignment,
	noteAppAlignment,
	readAppVersionHeader,
	semanticVersion,
} from "../lib/app-alignment.js";

const align = (header, pluginVersion = "3.2.0") => computeAppAlignment({ appVersionHeader: header, pluginVersion });

test("semanticVersion 只取 X.Y.Z（build 与 prerelease 都不参与配对）", () => {
	assert.equal(semanticVersion("3.2.0+44"), "3.2.0");
	assert.equal(semanticVersion("3.2.0"), "3.2.0");
	assert.equal(semanticVersion("3.2.1-alpha.1"), "3.2.1");
	assert.equal(semanticVersion("3.2.1-alpha.1+24"), "3.2.1");
	assert.equal(semanticVersion("bad"), "");
	assert.equal(semanticVersion(undefined), "");
});

test("插件 prerelease 与 App X.Y.Z+N 按 core 3.2.1 对齐（release/v3.2.1-alpha.1 契约）", () => {
	const r = computeAppAlignment({ appVersionHeader: "3.2.1+24", pluginVersion: "3.2.1-alpha.1" });
	assert.equal(r.state, ALIGNMENT_STATE.OK);
	assert.equal(r.reason, "aligned");
	assert.equal(r.hint, "");
	assert.equal(r.appVersion, "3.2.1+24");
	assert.equal(r.pluginVersion, "3.2.1-alpha.1");
	assert.equal(r.expectedAppVersion, "3.2.1");
});

test("插件 prerelease 的两端新旧仍按 core 判断", () => {
	const olderApp = computeAppAlignment({ appVersionHeader: "3.2.0+23", pluginVersion: "3.2.1-alpha.1" });
	assert.equal(olderApp.state, ALIGNMENT_STATE.APP_OUTDATED);
	assert.equal(olderApp.reason, "app-older-than-plugin");
	assert.match(olderApp.hint, /3\.2\.1/);

	const newerApp = computeAppAlignment({ appVersionHeader: "3.2.2+1", pluginVersion: "3.2.1-alpha.1" });
	assert.equal(newerApp.state, ALIGNMENT_STATE.PLUGIN_OUTDATED);
	assert.equal(newerApp.reason, "plugin-older-than-app");
});

test("readAppVersionHeader 容忍缺失、数组与空白", () => {
	assert.equal(readAppVersionHeader({}), "");
	assert.equal(readAppVersionHeader({ [APP_VERSION_HEADER]: " 3.2.0 " }), "3.2.0");
	assert.equal(readAppVersionHeader({ [APP_VERSION_HEADER]: ["3.2.0", "x"] }), "3.2.0");
	assert.equal(readAppVersionHeader({ [APP_VERSION_HEADER]: 42 }), "");
	assert.equal(readAppVersionHeader(null), "");
});

test("旧 App 未上报版本头 → UNKNOWN，并给出 PC 端可读提示（自举靠这个信号）", () => {
	const r = align("");
	assert.equal(r.state, ALIGNMENT_STATE.UNKNOWN);
	assert.equal(r.reason, "app-version-header-missing");
	assert.equal(r.appVersion, null);
	assert.equal(r.pluginVersion, "3.2.0");
	assert.equal(r.expectedAppVersion, "3.2.0");
	assert.match(r.hint, /未上报版本/);
});

test("语义版本一致 → OK；同一周期内不同 build 不误报", () => {
	for (const header of ["3.2.0", "3.2.0+1", "3.2.0+44"]) {
		const r = align(header);
		assert.equal(r.state, ALIGNMENT_STATE.OK, header);
		assert.equal(r.reason, "aligned");
		assert.equal(r.hint, "");
	}
});

test("App 落后 → APP_OUTDATED（提示去更新 App）", () => {
	const r = align("3.1.5+40");
	assert.equal(r.state, ALIGNMENT_STATE.APP_OUTDATED);
	assert.equal(r.reason, "app-older-than-plugin");
	assert.equal(r.appVersion, "3.1.5+40");
	assert.match(r.hint, /落后于本机插件/);
});

test("插件落后 → PLUGIN_OUTDATED（提示去更新插件）", () => {
	const r = align("3.3.0");
	assert.equal(r.state, ALIGNMENT_STATE.PLUGIN_OUTDATED);
	assert.equal(r.reason, "plugin-older-than-app");
	assert.match(r.hint, /本机插件.*落后于手机 App/);
});

test("版本不可解析 → UNKNOWN（不猜）", () => {
	assert.equal(align("not-a-version").state, ALIGNMENT_STATE.UNKNOWN);
	assert.equal(align("not-a-version").reason, "app-version-unparseable");
	assert.equal(
		computeAppAlignment({ appVersionHeader: "3.2.0", pluginVersion: "unknown" }).state,
		ALIGNMENT_STATE.UNKNOWN,
	);
	assert.equal(
		computeAppAlignment({ appVersionHeader: "3.2.0", pluginVersion: "unknown" }).reason,
		"plugin-version-unparseable",
	);
});

test("noteAppAlignment 只在结论变化时提示一次（bootstrap 会反复调用）", () => {
	const lines = [];
	const logger = { warn: (m) => lines.push(`warn:${m}`), info: (m) => lines.push(`info:${m}`) };
	const seen = { key: "" };
	const outdated = align("3.1.5");
	assert.equal(noteAppAlignment(logger, outdated, seen), true);
	assert.equal(noteAppAlignment(logger, outdated, seen), false);
	assert.equal(lines.length, 1);
	assert.match(lines[0], /^warn:mobile-remote: /);

	// 结论变化 → 再提示一次
	assert.equal(noteAppAlignment(logger, align("3.3.0"), seen), true);
	assert.equal(lines.length, 2);

	// 对齐 → 不提示
	assert.equal(noteAppAlignment(logger, align("3.2.0"), seen), false);
	assert.equal(lines.length, 2);

	// 旧 App（UNKNOWN）走 info，不算告警
	const seen2 = { key: "" };
	assert.equal(noteAppAlignment(logger, align(""), seen2), true);
	assert.equal(lines.length, 3);
	assert.match(lines[2], /^info:mobile-remote: /);
});
