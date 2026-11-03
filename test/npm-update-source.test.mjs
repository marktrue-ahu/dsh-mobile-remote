import assert from "node:assert/strict";
import { test } from "node:test";
import { createNpmPackageView, resolveNpmUpdateCandidate, runNpmView } from "../lib/npm-update-source.js";

const PACKAGE_NAME = "@polaris-l/dsh-mobile-remote";
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
				"@polaris-l/dsh-mobile-remote-app": `npm:${PACKAGE_NAME}@${CARRIER_VERSION}`,
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
			optionalDependencies: { "@polaris-l/dsh-mobile-remote-app": `npm:${PACKAGE_NAME}@3.2.2-app` },
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
		options: { cwd: "/dsh/profiles/web", platform: process.platform },
	}]);
	assert.equal(calls[0].args.includes("--registry"), false, "npm must resolve scope/default registry from host configuration");
});

test("Windows: npm view runs through the shell and a missing npm client is reported distinctly", async () => {
	const calls = [];
	const okExec = (file, args, options, callback) => {
		calls.push({ file, args, options });
		callback(null, JSON.stringify({ "dist-tags": { alpha: PLUGIN_VERSION } }), "");
	};
	const ok = await runNpmView(["view", PACKAGE_NAME, "dist-tags", "--json"], {
		cwd: "/dsh/profiles/desktop",
		platform: "win32",
		execFileImpl: okExec,
	});
	assert.equal(ok.ok, true);
	assert.equal(calls[0].file, "npm");
	assert.equal(calls[0].options.shell, true);
	assert.equal(calls[0].options.cwd, "/dsh/profiles/desktop");

	const missing = await runNpmView(["view", PACKAGE_NAME, "dist-tags", "--json"], {
		platform: "win32",
		execFileImpl: (file, args, options, callback) => callback(Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" }), "", ""),
	});
	assert.deepEqual(missing, { ok: false, error: "npm-client-unavailable" });

	// Windows shell 找不到命令时不是 ENOENT，而是 cmd 的「不是内部或外部命令」。
	const notFound = await runNpmView(["view", PACKAGE_NAME, "dist-tags", "--json"], {
		platform: "win32",
		execFileImpl: (file, args, options, callback) => callback(
			Object.assign(new Error("Command failed: npm view"), { code: 1 }),
			"",
			"'npm' \u4e0d\u662f\u5185\u90e8\u6216\u5916\u90e8\u547d\u4ee4\u3002",
		),
	});
	assert.deepEqual(notFound, { ok: false, error: "npm-client-unavailable" });

	const linuxOptions = [];
	await runNpmView(["view", PACKAGE_NAME, "dist-tags", "--json"], {
		platform: "linux",
		execFileImpl: (file, args, options, callback) => {
			linuxOptions.push(options);
			callback(null, "{}", "");
		},
	});
	assert.equal(linuxOptions[0].shell, undefined, "POSIX 直接 spawn，不经过 shell");
});

test("candidate resolution surfaces npm-client-unavailable instead of blaming the registry", async () => {
	const result = await resolveNpmUpdateCandidate({
		packageName: PACKAGE_NAME,
		localVersion: "3.2.1-alpha.3",
		packageView: async () => {
			throw new Error("npm-client-unavailable");
		},
	});
	assert.equal(result.ok, false);
	assert.equal(result.reason, "npm-client-unavailable");
});

test("accepts the flat dist-tags map that real `npm view … dist-tags --json` prints", async () => {
	// 回归：npm CLI 实际输出是标签映射本身（不是 {"dist-tags": …} 包装）。
	// 旧实现只读 tags["dist-tags"]，导致真实宿主永远报 npm-channel-version-missing。
	const packageDocs = new Map([
		[PACKAGE_NAME, { latest: "3.2.1-alpha.3", alpha: PLUGIN_VERSION, app: "3.2.3-alpha.1-app" }],
		[`${PACKAGE_NAME}@${PLUGIN_VERSION}`, {
			version: PLUGIN_VERSION,
			dist: { integrity: PLUGIN_INTEGRITY },
			optionalDependencies: {
				"@polaris-l/dsh-mobile-remote-app": `npm:${PACKAGE_NAME}@${CARRIER_VERSION}`,
			},
		}],
		[`${PACKAGE_NAME}@${CARRIER_VERSION}`, {
			version: CARRIER_VERSION,
			appVersion: "3.2.2+26",
			pluginContentSha256: "b".repeat(64),
			dist: { integrity: CARRIER_INTEGRITY },
		}],
	]);
	const result = await resolveNpmUpdateCandidate({
		packageName: PACKAGE_NAME,
		localVersion: PLUGIN_VERSION,
		packageView: async (spec) => packageDocs.get(spec) ?? null,
	});
	assert.equal(result.ok, true);
	assert.equal(result.plugin.version, PLUGIN_VERSION);
	assert.equal(result.carrier.version, CARRIER_VERSION);
});


test("records a sanitized, bounded check log without registry URLs", async () => {
	const log = [];
	const failed = await resolveNpmUpdateCandidate({
		packageName: PACKAGE_NAME,
		localVersion: PLUGIN_VERSION,
		packageView: async (spec) => {
			if (spec === PACKAGE_NAME) return { alpha: PLUGIN_VERSION };
			throw new Error("npm-view-failed");
		},
		log,
	});
	assert.equal(failed.ok, false);
	assert.equal(failed.reason, "npm-plugin-metadata-unavailable");
	assert.ok(
		log.some((line) => line.includes(`$ npm view ${PACKAGE_NAME}@${PLUGIN_VERSION} --json`)),
		`检查日志应记录失败的 npm 命令：${JSON.stringify(log)}`,
	);
	assert.ok(log.some((line) => line.includes("→ 失败：npm-registry-unavailable")), JSON.stringify(log));
	assert.ok(log.some((line) => line.includes("→ alpha=" + PLUGIN_VERSION)));
	assert.ok(log.every((line) => !/https?:\/\//.test(line)), "日志不得包含 registry URL");
	assert.ok(log.every((line) => line.length <= 241), "单行日志必须有长度上限");

	const docs = new Map([
		[PACKAGE_NAME, { latest: "3.2.1-alpha.3", alpha: PLUGIN_VERSION }],
		[`${PACKAGE_NAME}@${PLUGIN_VERSION}`, {
			version: PLUGIN_VERSION,
			dist: { integrity: PLUGIN_INTEGRITY },
			optionalDependencies: {
				"@polaris-l/dsh-mobile-remote-app": `npm:${PACKAGE_NAME}@${CARRIER_VERSION}`,
			},
		}],
		[`${PACKAGE_NAME}@${CARRIER_VERSION}`, {
			version: CARRIER_VERSION,
			appVersion: "3.2.2+26",
			pluginContentSha256: "b".repeat(64),
			dist: { integrity: CARRIER_INTEGRITY },
		}],
	]);
	const successLog = [];
	const success = await resolveNpmUpdateCandidate({
		packageName: PACKAGE_NAME,
		localVersion: PLUGIN_VERSION,
		packageView: async (spec) => docs.get(spec) ?? null,
		log: successLog,
	});
	assert.equal(success.ok, true);
	assert.ok(successLog.some((line) => line.includes(`$ npm view ${PACKAGE_NAME}@${PLUGIN_VERSION} --json`)));
	assert.ok(successLog.some((line) => line.includes("→ 插件 v" + PLUGIN_VERSION)));
	assert.ok(successLog.some((line) => line.includes(`→ 载体 v${CARRIER_VERSION} · App build 3.2.2+26`)), JSON.stringify(successLog));
});

test("rc 预发布跟随 rc 通道，并能解析对应的精确 carrier", async () => {
	const packageDocs = new Map([
		[PACKAGE_NAME, { latest: "3.2.1-alpha.3", alpha: "3.2.2-alpha.15", rc: "3.2.2-rc.1" }],
		[`${PACKAGE_NAME}@3.2.2-rc.1`, {
			version: "3.2.2-rc.1",
			dist: { integrity: PLUGIN_INTEGRITY },
			optionalDependencies: {
				"@polaris-l/dsh-mobile-remote-app": `npm:${PACKAGE_NAME}@3.2.2-rc.1-app`,
			},
		}],
		[`${PACKAGE_NAME}@3.2.2-rc.1-app`, {
			version: "3.2.2-rc.1-app",
			appVersion: "3.2.2+40",
			pluginContentSha256: "d".repeat(64),
			dist: { integrity: CARRIER_INTEGRITY },
		}],
	]);
	const result = await resolveNpmUpdateCandidate({
		packageName: PACKAGE_NAME,
		localVersion: "3.2.2-rc.1",
		packageView: async (spec) => packageDocs.get(spec) ?? null,
	});
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.channel, "rc");
	assert.equal(result.plugin.version, "3.2.2-rc.1");
	assert.equal(result.carrier.version, "3.2.2-rc.1-app");
	assert.equal(result.carrier.appVersion, "3.2.2+40");
});

test("未知预发布通道仍明确拒绝，不会退回 latest", async () => {
	const result = await resolveNpmUpdateCandidate({
		packageName: PACKAGE_NAME,
		localVersion: "3.2.2-beta.1",
		packageView: async () => {
			throw new Error("should-not-be-called");
		},
	});
	assert.equal(result.ok, false);
	assert.equal(result.reason, "npm-prerelease-channel-unsupported");
});
