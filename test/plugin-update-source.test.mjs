// 更新来源的解析与检查（阶段 4b）：只回答"有没有新版"，**不下载、不改动任何东西**。
// 上游尚未把清单作为发布资产时，退化为按 Release 资产合成——此时没有内容标识，
// 判定会退化为版本比较，并如实标注盲区。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	UPDATE_CHECK_STATE,
	UPDATE_SOURCE_KIND,
	checkForUpdate,
	fetchReleaseManifest,
	resolveManifestSource,
	resolvePluginUpdateSource,
	synthesizeFromGithubRelease,
	UPSTREAM_MANIFEST_URL,
} from "../lib/plugin-self-update.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

/** 极简 fetch 替身：按 url 命中固定响应。 */
function fakeFetch(routes) {
	return async (url) => {
		const hit = routes[url];
		if (!hit) return { ok: false, status: 404, json: async () => ({}) };
		return { ok: hit.ok !== false, status: hit.status ?? 200, json: async () => hit.json };
	};
}

const manifestDoc = ({ version = "3.3.0", contentSha256 = HASH_B } = {}) => ({
	schema: 1,
	app: { version: "3.3.0+50", file: "a.apk", size: 1, sha256: HASH_A },
	plugin: { version, file: `dsh-mobile-remote-v${version}.tgz`, url: `https://example.com/${version}.tgz`, size: 10, sha256: HASH_A, contentSha256 },
});

const NPM_PACKAGE_NAME = "@polaris-l/dsh-mobile-remote";
function fakeNpmPackageView({ version, appVersion, contentSha256 = HASH_B } = {}) {
	const carrierVersion = `${version}-app`;
	const core = version.split("-")[0];
	const sri = text => `sha512-${Buffer.from(text).toString("base64")}`;
	const docs = new Map([
		[NPM_PACKAGE_NAME, { "dist-tags": { latest: version, alpha: version, app: carrierVersion } }],
		[`${NPM_PACKAGE_NAME}@${version}`, {
			version, dist: { integrity: sri("plugin") },
			optionalDependencies: { "@polaris-l/dsh-mobile-remote-app": `npm:${NPM_PACKAGE_NAME}@${carrierVersion}` },
		}],
		[`${NPM_PACKAGE_NAME}@${carrierVersion}`, {
			version: carrierVersion, appVersion: appVersion ?? `${core}+50`, pluginContentSha256: contentSha256,
			dist: { integrity: sri("carrier") },
		}],
	]);
	return async spec => docs.get(spec) ?? null;
}

test("resolveManifestSource：off / upstream / 自定义 https / 非法值四态分明", () => {
	assert.equal(resolveManifestSource("").kind, UPDATE_SOURCE_KIND.OFF);
	assert.equal(resolveManifestSource("off").kind, UPDATE_SOURCE_KIND.OFF);
	assert.equal(resolveManifestSource(undefined).kind, UPDATE_SOURCE_KIND.OFF);

	const upstream = resolveManifestSource("upstream");
	assert.equal(upstream.kind, UPDATE_SOURCE_KIND.UPSTREAM);
	assert.equal(upstream.url, UPSTREAM_MANIFEST_URL);

	const custom = resolveManifestSource("https://my.host/update/manifest.json");
	assert.equal(custom.kind, UPDATE_SOURCE_KIND.CUSTOM);
	assert.equal(custom.url, "https://my.host/update/manifest.json");

	assert.equal(resolveManifestSource("http://insecure.host/m.json").kind, UPDATE_SOURCE_KIND.INVALID);
	assert.equal(resolveManifestSource("ftp://x/m.json").kind, UPDATE_SOURCE_KIND.INVALID);
});

test("plugin update source is NPM-only; old non-off source values migrate to npm", () => {
	assert.equal(resolvePluginUpdateSource("npm").kind, UPDATE_SOURCE_KIND.NPM);
	assert.equal(resolvePluginUpdateSource("off").kind, UPDATE_SOURCE_KIND.OFF);
	assert.equal(resolvePluginUpdateSource("upstream").kind, UPDATE_SOURCE_KIND.NPM);
	assert.equal(resolvePluginUpdateSource("https://legacy.example/manifest.json").kind, UPDATE_SOURCE_KIND.NPM);
	assert.equal(resolvePluginUpdateSource("ftp://invalid.example/manifest.json").kind, UPDATE_SOURCE_KIND.INVALID);
});

test("fetchReleaseManifest：upstream 有清单资产时直接用清单", async () => {
	const r = await fetchReleaseManifest({
		source: resolveManifestSource("upstream"),
		fetchImpl: fakeFetch({ [UPSTREAM_MANIFEST_URL]: { json: manifestDoc() } }),
	});
	assert.equal(r.ok, true, r.error);
	assert.equal(r.synthesized, false);
	assert.equal(r.manifest.plugin.version, "3.3.0");
	assert.equal(r.manifest.plugin.contentSha256, HASH_B);
});

test("fetchReleaseManifest：清单缺失时按 Release 资产合成（有 sha256、无内容标识）", async () => {
	const upstream = resolveManifestSource("upstream");
	const r = await fetchReleaseManifest({
		source: upstream,
		fetchImpl: fakeFetch({
			[upstream.api]: {
				json: {
					tag_name: "v3.3.0",
					assets: [
						{ name: "DSH-Remote-v3.3.0.apk", size: 99, digest: `sha256:${HASH_A}`, browser_download_url: "https://x/a.apk" },
						{ name: "dsh-mobile-remote-v3.3.0.tgz", size: 10, digest: `sha256:${HASH_A}`, browser_download_url: "https://x/p.tgz" },
					],
				},
			},
		}),
	});
	assert.equal(r.ok, true, r.error);
	assert.equal(r.synthesized, true);
	assert.equal(r.manifest.plugin.version, "3.3.0");
	assert.equal(r.manifest.plugin.sha256, HASH_A);
	assert.equal(r.manifest.plugin.contentSha256, "");
	assert.equal(r.manifest.plugin.url, "https://x/p.tgz");
});

test("fetchReleaseManifest：清单与 release 都取不到 → 明确失败；off → 拒绝", async () => {
	const upstream = resolveManifestSource("upstream");
	const fail = await fetchReleaseManifest({
		source: upstream,
		fetchImpl: fakeFetch({ [upstream.api]: { json: { tag_name: "v3.3.0", assets: [] } } }),
	});
	assert.equal(fail.ok, false);
	assert.equal(fail.error, "release-asset-missing");

	const off = await fetchReleaseManifest({ source: resolveManifestSource("off") });
	assert.equal(off.error, "update-source-off");
	assert.equal((await fetchReleaseManifest({ source: resolveManifestSource("http://x") })).error, "update-source-invalid");
});

test("synthesizeFromGithubRelease：缺少 tgz 资产或 tag → 明确失败", async () => {
	const noTgz = await synthesizeFromGithubRelease("https://api/x", {
		fetchImpl: fakeFetch({ "https://api/x": { json: { tag_name: "v3.3.0", assets: [{ name: "a.apk" }] } } }),
	});
	assert.equal(noTgz.ok, false);
	assert.equal(noTgz.error, "release-asset-missing");

	const noTag = await synthesizeFromGithubRelease("https://api/x", {
		fetchImpl: fakeFetch({ "https://api/x": { json: { tag_name: "", assets: [{ name: "p.tgz", size: 1, digest: `sha256:${HASH_A}` }] } } }),
	});
	assert.equal(noTag.error, "release-asset-missing");
});

test("checkForUpdate：off 不检查；非法来源如实报不可用", async () => {
	const off = await checkForUpdate({ configValue: "off" });
	assert.equal(off.state, UPDATE_CHECK_STATE.DISABLED);

	const invalid = await checkForUpdate({ configValue: "http://insecure/m.json" });
	assert.equal(invalid.state, UPDATE_CHECK_STATE.UNAVAILABLE);
	assert.equal(invalid.reason, "update-source-invalid");
});

test("checkForUpdate: registry 查询失败时返回不可用且不暴露 npm stderr", async () => {
	const r = await checkForUpdate({
		configValue: "npm",
		packageName: NPM_PACKAGE_NAME,
		localVersion: "3.2.1",
		npmPackageView: async () => { throw new Error("auth token=secret-private-value"); },
	});
	assert.equal(r.state, UPDATE_CHECK_STATE.UNAVAILABLE);
	assert.equal(r.reason, "npm-registry-unavailable");
	assert.equal(JSON.stringify(r).includes("secret-private-value"), false);
});

test("checkForUpdate: 内容标识相同即已是最新（即使 NPM 版本更新）", async () => {
	const r = await checkForUpdate({
		configValue: "npm",
		packageName: NPM_PACKAGE_NAME,
		localVersion: "3.2.0",
		localContentSha256: HASH_B,
		npmPackageView: fakeNpmPackageView({ version: "3.3.0", contentSha256: HASH_B }),
	});
	assert.equal(r.state, UPDATE_CHECK_STATE.UP_TO_DATE);
	assert.equal(r.reason, "content-identical");
});

test("checkForUpdate: 同版本内容标识变化 fail-closed", async () => {
	const r = await checkForUpdate({
		configValue: "npm",
		packageName: NPM_PACKAGE_NAME,
		localVersion: "3.2.0",
		localContentSha256: HASH_A,
		npmPackageView: fakeNpmPackageView({ version: "3.2.0", contentSha256: HASH_B }),
	});
	assert.equal(r.state, UPDATE_CHECK_STATE.UNAVAILABLE);
	assert.equal(r.reason, "npm-version-content-mismatch");
});

test("checkForUpdate: legacy upstream 配置迁移到 NPM 检查，不再访问 GitHub", async () => {
	let calls = 0;
	const r = await checkForUpdate({
		configValue: "upstream",
		packageName: NPM_PACKAGE_NAME,
		localVersion: "3.2.0",
		localContentSha256: HASH_A,
		npmPackageView: async (spec) => { calls += 1; return fakeNpmPackageView({ version: "3.3.0" })(spec); },
	});
	assert.equal(r.state, UPDATE_CHECK_STATE.UPDATE_AVAILABLE);
	assert.equal(r.source, "npm");
	assert.equal(r.candidate.plugin.version, "3.3.0");
	assert.equal(calls, 3);
});

test("checkForUpdate: NPM uses installed prerelease channel and returns a sanitized exact pair", async () => {
	const packageName = "@polaris-l/dsh-mobile-remote";
	const pluginVersion = "3.2.2-alpha.1";
	const carrierVersion = "3.2.2-alpha.1-app";
	const calls = [];
	const documents = new Map([
		[packageName, { "dist-tags": { latest: "3.2.1-alpha.3", alpha: pluginVersion, app: "3.2.3-alpha.1-app" } }],
		[`${packageName}@${pluginVersion}`, {
			version: pluginVersion,
			dist: { integrity: `sha512-${Buffer.from("plugin").toString("base64")}` },
			optionalDependencies: {
				"@polaris-l/dsh-mobile-remote-app": `npm:${packageName}@${carrierVersion}`,
			},
		}],
		[`${packageName}@${carrierVersion}`, {
			version: carrierVersion,
			appVersion: "3.2.2+26",
			dist: { integrity: `sha512-${Buffer.from("carrier").toString("base64")}` },
		}],
	]);
	const npmPackageView = async (spec) => { calls.push(spec); return documents.get(spec) ?? null; };
	const r = await checkForUpdate({
		configValue: "npm",
		packageName,
		localVersion: "3.2.1-alpha.3",
		localContentSha256: HASH_A,
		npmPackageView,
	});
	assert.equal(r.state, UPDATE_CHECK_STATE.UPDATE_AVAILABLE);
	assert.equal(r.source, "npm");
	assert.equal(r.candidate.channel, "alpha");
	assert.equal(r.candidate.plugin.version, pluginVersion);
	assert.equal(r.candidate.carrier.version, carrierVersion);
	assert.equal(r.candidate.carrier.appVersion, "3.2.2+26");
	assert.equal(JSON.stringify(r).includes("registry.example"), false);
	assert.deepEqual(calls, [packageName, `${packageName}@${pluginVersion}`, `${packageName}@${carrierVersion}`]);
});
