// 发布测试共享夹具（issue #43）：历史 tag / legacy carrier / build-policy 种子。
// 数值取自设计稿 §12 的实测数据（2026-11-02）。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serializeBuildPolicy } from "../../tools/lib/release-policy.mjs";

export const PACKAGE_NAME = "@marktrue/dsh-mobile-remote";

/** 固定且形状合法的 npm integrity（sha512-<86 base64>==）；同一 version 结果稳定。 */
export function fixtureIntegrity(version) {
	const body = crypto.createHash("sha512").update(String(version)).digest("base64");
	return `sha512-${body}`;
}

/** 设计稿 §12 的 8 个历史 tag 与 build（含重复值 24/24、26/26、27/27）。 */
export const HISTORICAL_TAG_BUILDS = [
	["v3.2.1-alpha.1", 24],
	["v3.2.1-alpha.2", 24],
	["v3.2.1-alpha.3", 25],
	["v3.2.1-rc.1", 26],
	["v3.2.2-alpha.1", 26],
	["v3.2.2-rc.1", 27],
	["v3.2.3-alpha.1", 27],
	["v3.2.3-rc.1", 28],
];

/** 8 个已发布 carrier；前 3 个是迁移前缺顶层 appVersion 的旧格式。 */
export const HISTORICAL_CARRIERS = HISTORICAL_TAG_BUILDS.map(([tag, build], index) => {
	const plugin = tag.slice(1);
	return {
		version: `${plugin}-app`,
		legacy: index < 3,
		appBuild: build,
		integrity: fixtureIntegrity(`${plugin}-app`),
	};
});

export function tagSha(tag) {
	return crypto.createHash("sha1").update(tag).digest("hex");
}

export function buildPolicySeed({ watermark = 32, intents = [] } = {}) {
	return {
		schema: 1,
		watermark,
		legacyTags: HISTORICAL_TAG_BUILDS.map(([tag]) => tag),
		legacyCarriers: HISTORICAL_CARRIERS.map(({ version, integrity, appBuild }) => ({ version, integrity, appBuild })),
		updatedAt: "2026-11-02",
		intents,
	};
}

export function tagFiles() {
	const files = {};
	for (const [tag, build] of HISTORICAL_TAG_BUILDS) {
		const core = tag.slice(1).split("-")[0];
		files[tag] = {
			"package.json": `${JSON.stringify({ name: PACKAGE_NAME, version: tag.slice(1) }, null, 2)}\n`,
			"dsh-mobile-app/pubspec.yaml": `name: dsh_mobile_app\nversion: ${core}+${build}\n`,
		};
	}
	// 上游/镜像 tag（不属于本 fork 的发布 tag）：必须被忽略而不是让分配 fail-closed。
	files["v0.9.0-rc.1"] = { "package.json": `${JSON.stringify({ name: "@upstream/dsh" }, null, 2)}\n` };
	return files;
}

export function remoteTags() {
	const tags = [...HISTORICAL_TAG_BUILDS.map(([tag]) => ({ name: tag, sha: tagSha(tag) })), { name: "v0.9.0-rc.1", sha: tagSha("v0.9.0-rc.1") }];
	return { origin: tags, github: tags.map((entry) => ({ ...entry })) };
}

/**
 * 构造 fake adapter state（test/helpers/fake-release-adapters.mjs 消费）。
 * @param {{carriers?: Array<{version:string, appVersion?:string|null, integrity?:string}>, releaseMeta?:object, intents?:object[]}} options
 */
export function fakeState({
	carriers = HISTORICAL_CARRIERS.map((carrier) => ({
		version: carrier.version,
		appVersion: carrier.legacy ? null : `${carrier.version.slice(0, -4).split("-")[0]}+${carrier.appBuild}`,
		integrity: carrier.integrity,
	})),
	releaseMeta = null,
	intents = [],
	extraMetadata = {},
} = {}) {
	const policy = buildPolicySeed({ intents });
	const content = serializeBuildPolicy(policy);
	const meta = releaseMeta ?? { origin: { sha: "a".repeat(40), content }, github: { sha: "a".repeat(40), content } };
	const metadata = {};
	for (const carrier of carriers) {
		metadata[carrier.version] = {
			version: carrier.version,
			appVersion: carrier.appVersion ?? undefined,
			dist: { integrity: carrier.integrity },
		};
	}
	Object.assign(metadata, extraMetadata);
	return {
		releaseMeta: meta,
		tags: [...HISTORICAL_TAG_BUILDS.map(([tag]) => ({ name: tag, sha: tagSha(tag) })), { name: "v0.9.0-rc.1", sha: tagSha("v0.9.0-rc.1") }],
		tagFiles: tagFiles(),
		remoteTags: remoteTags(),
		npm: {
			versions: carriers.map((carrier) => carrier.version),
			metadata,
			distTags: {},
			tarballs: {},
		},
	};
}

export function writeFakeState(dir, state) {
	const file = path.join(dir, "fake-state.json");
	fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	return file;
}

export const FAKE_ADAPTERS = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-release-adapters.mjs");
