import assert from "node:assert/strict";
import { test } from "node:test";
import { createNpmPackageView, resolveNpmUpdateCandidate } from "../lib/npm-update-source.js";

const PACKAGE_NAME = "@marktrue/dsh-mobile-remote";
const PLUGIN_VERSION = "3.2.2-alpha.1";
const CARRIER_VERSION = "3.2.2-alpha.1-app";
const PLUGIN_INTEGRITY = "sha512-" + Buffer.from("plugin-integrity").toString("base64");
const CARRIER_INTEGRITY = "sha512-" + Buffer.from("carrier-integrity").toString("base64");

test("预发布插件追踪 alpha，并按插件完整版本解析精确 carrier，不追移动中的 app tag", async () => {
	const calls = [];
	const packageDocs = new Map([
		[PACKAGE_NAME, {
			"dist-tags": {
				latest: "3.2.1-alpha.3",
				alpha: PLUGIN_VERSION,
				app: "3.2.3-alpha.1-app",
			},
		}],
		[`${PACKAGE_NAME}@${PLUGIN_VERSION}`, {
			version: PLUGIN_VERSION,
			dist: { integrity: PLUGIN_INTEGRITY },
			optionalDependencies: {
				"@marktrue/dsh-mobile-remote-app": `npm:${PACKAGE_NAME}@${CARRIER_VERSION}`,
			},
		}],
		[`${PACKAGE_NAME}@${CARRIER_VERSION}`, {
			version: CARRIER_VERSION,
			appVersion: "3.2.2+26",
			pluginContentSha256: "b".repeat(64),
			dist: { integrity: CARRIER_INTEGRITY },
		}],
	]);
	const packageView = async (spec) => {
		calls.push(spec);
		return packageDocs.get(spec) ?? null;
	};

	const result = await resolveNpmUpdateCandidate({
		packageName: PACKAGE_NAME,
		localVersion: "3.2.1-alpha.3",
		packageView,
	});

	assert.equal(result.ok, true, result.reason);
	assert.equal(result.channel, "alpha");
	assert.equal(result.plugin.version, PLUGIN_VERSION);
	assert.equal(result.plugin.integrity, PLUGIN_INTEGRITY);
	assert.equal(result.plugin.contentSha256, "b".repeat(64));
	assert.equal(result.carrier.version, CARRIER_VERSION);
	assert.equal(result.carrier.appVersion, "3.2.2+26");
	assert.equal(result.carrier.integrity, CARRIER_INTEGRITY);
	assert.deepEqual(calls, [
		PACKAGE_NAME,
		`${PACKAGE_NAME}@${PLUGIN_VERSION}`,
		`${PACKAGE_NAME}@${CARRIER_VERSION}`,
	]);
});

test("stable 插件追踪 latest；旧 carrier 缺 App metadata 时标记为需预检而非下载", async () => {
	const packageDocs = new Map([
		[PACKAGE_NAME, { "dist-tags": { latest: "3.2.2", alpha: "3.3.0-alpha.1", app: "3.3.0-alpha.1-app" } }],
		[`${PACKAGE_NAME}@3.2.2`, {
			version: "3.2.2",
			dist: { integrity: PLUGIN_INTEGRITY },
			optionalDependencies: { "@marktrue/dsh-mobile-remote-app": `npm:${PACKAGE_NAME}@3.2.2-app` },
		}],
		[`${PACKAGE_NAME}@3.2.2-app`, { version: "3.2.2-app", dist: { integrity: CARRIER_INTEGRITY } }],
	]);
	const result = await resolveNpmUpdateCandidate({
		packageName: PACKAGE_NAME,
		localVersion: "3.2.1",
		packageView: async (spec) => packageDocs.get(spec) ?? null,
	});
	assert.equal(result.ok, true, result.reason);
	assert.equal(result.channel, "latest");
	assert.equal(result.plugin.version, "3.2.2");
	assert.equal(result.carrier.version, "3.2.2-app");
	assert.equal(result.carrier.appVersion, null);
	assert.equal(result.carrier.legacyMetadataMissing, true);
});

test("npm view adapter follows the host config instead of overriding the registry", async () => {
	const calls = [];
	const packageView = createNpmPackageView({
		packageName: PACKAGE_NAME,
		cwd: "/dsh/profiles/web",
		run: async (args, options) => {
			calls.push({ args, options });
			return { ok: true, stdout: JSON.stringify({ "dist-tags": { alpha: PLUGIN_VERSION } }) };
		},
	});
	const tags = await packageView(PACKAGE_NAME);
	assert.equal(tags["dist-tags"].alpha, PLUGIN_VERSION);
	assert.deepEqual(calls, [{
		args: ["view", PACKAGE_NAME, "dist-tags", "--json"],
		options: { cwd: "/dsh/profiles/web" },
	}]);
	assert.equal(calls[0].args.includes("--registry"), false, "npm must resolve scope/default registry from host configuration");
});
