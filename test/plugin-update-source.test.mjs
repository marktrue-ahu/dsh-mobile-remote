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

test("checkForUpdate：取不到清单 → unavailable（不猜、不改动）", async () => {
	const r = await checkForUpdate({
		configValue: "https://my.host/m.json",
		fetchImpl: fakeFetch({}),
		localVersion: "3.2.0",
	});
	assert.equal(r.state, UPDATE_CHECK_STATE.UNAVAILABLE);
	assert.match(r.reason, /manifest-http-404/);
});

test("checkForUpdate：内容标识一致 → 已是最新（即使版本号不同）", async () => {
	const r = await checkForUpdate({
		configValue: "https://my.host/m.json",
		fetchImpl: fakeFetch({ "https://my.host/m.json": { json: manifestDoc({ version: "3.3.0", contentSha256: HASH_B }) } }),
		localVersion: "3.2.0",
		localContentSha256: HASH_B,
	});
	assert.equal(r.state, UPDATE_CHECK_STATE.UP_TO_DATE);
	assert.equal(r.reason, "content-identical");
});

test("checkForUpdate：版本号相同、内容不同 → 应更新（版本比较看不见的形态）", async () => {
	const r = await checkForUpdate({
		configValue: "https://my.host/m.json",
		fetchImpl: fakeFetch({ "https://my.host/m.json": { json: manifestDoc({ version: "3.2.0", contentSha256: HASH_B }) } }),
		localVersion: "3.2.0",
		localContentSha256: HASH_A,
	});
	assert.equal(r.state, UPDATE_CHECK_STATE.UPDATE_AVAILABLE);
	assert.equal(r.reason, "content-differs-same-version");
});

test("checkForUpdate：上游合成来源无内容标识 → 版本比较兜底，并标注 synthesized", async () => {
	const upstream = resolveManifestSource("upstream");
	const r = await checkForUpdate({
		configValue: "upstream",
		fetchImpl: fakeFetch({
			[upstream.api]: {
				json: { tag_name: "v3.3.0", assets: [{ name: "dsh-mobile-remote-v3.3.0.tgz", size: 10, digest: `sha256:${HASH_A}`, browser_download_url: "https://x/p.tgz" }] },
			},
		}),
		localVersion: "3.2.0",
		localContentSha256: HASH_B,
	});
	assert.equal(r.state, UPDATE_CHECK_STATE.UPDATE_AVAILABLE);
	assert.equal(r.reason, "version-newer-no-content-digest");
	assert.equal(r.synthesized, true);
	assert.equal(r.remote.version, "3.3.0");
});
