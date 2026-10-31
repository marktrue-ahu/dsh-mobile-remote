import { execFile } from "node:child_process";
import { appCarrierAlias, appCarrierVersion } from "./app-carrier.js";
import { parseVersion } from "./plugin-update.js";
import { shellOptions } from "./tool-process.js";

const SRI_PATTERN = /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/;

/** Stable package follows latest; the fork's supported prerelease channel follows alpha. */
export function npmUpdateChannel(localVersion) {
	const parsed = parseVersion(localVersion);
	if (!parsed) return { ok: false, reason: "npm-local-version-invalid" };
	if (parsed.prerelease.length === 0) return { ok: true, channel: "latest" };
	if (parsed.prerelease[0] === "alpha") return { ok: true, channel: "alpha" };
	return { ok: false, reason: "npm-prerelease-channel-unsupported" };
}

function packageIntegrity(pkg) {
	const value = pkg?.dist?.integrity;
	return typeof value === "string" && SRI_PATTERN.test(value) ? value : "";
}

/**
 * `npm view <pkg> dist-tags --json` prints the tag map itself
 * (`{"latest":"...","alpha":"..."}`), while some adapters/tests hand back the
 * whole packument field (`{"dist-tags":{...}}`). Accept both so the check never
 * fails merely because of the projection shape.
 */
function distTagMap(tags) {
	if (!tags || typeof tags !== "object" || Array.isArray(tags)) return null;
	const nested = tags["dist-tags"];
	if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested;
	return tags;
}

/**
 * Resolve an immutable plugin/carrier pair from NPM metadata only.
 * `packageView(spec)` is the host NPM adapter; tests inject a deterministic registry.
 * This function never downloads a tarball and never returns registry URLs or raw metadata.
 */
export async function resolveNpmUpdateCandidate({ packageName, localVersion, packageView } = {}) {
	if (typeof packageName !== "string" || packageName.trim() === "") {
		return { ok: false, reason: "npm-package-name-invalid" };
	}
	if (typeof packageView !== "function") return { ok: false, reason: "npm-client-unavailable" };
	const channel = npmUpdateChannel(localVersion);
	if (!channel.ok) return channel;

	let tags;
	try {
		tags = await packageView(packageName);
	} catch (error) {
		return { ok: false, reason: viewFailureReason(error) };
	}
	const candidateVersion = distTagMap(tags)?.[channel.channel];
	if (typeof candidateVersion !== "string" || !parseVersion(candidateVersion)) {
		return { ok: false, reason: "npm-channel-version-missing", channel: channel.channel };
	}

	let plugin;
	try {
		plugin = await packageView(`${packageName}@${candidateVersion}`);
	} catch {
		return { ok: false, reason: "npm-plugin-metadata-unavailable" };
	}
	if (!plugin || plugin.version !== candidateVersion) return { ok: false, reason: "npm-plugin-version-mismatch" };
	const pluginIntegrity = packageIntegrity(plugin);
	if (!pluginIntegrity) return { ok: false, reason: "npm-plugin-integrity-missing" };

	const carrierVersion = appCarrierVersion(candidateVersion);
	const alias = appCarrierAlias(packageName);
	const expectedAliasSpec = `npm:${packageName}@${carrierVersion}`;
	if (plugin.optionalDependencies?.[alias] !== expectedAliasSpec) {
		return { ok: false, reason: "npm-carrier-alias-mismatch" };
	}

	let carrier;
	try {
		carrier = await packageView(`${packageName}@${carrierVersion}`);
	} catch {
		return { ok: false, reason: "npm-carrier-metadata-unavailable" };
	}
	if (!carrier || carrier.version !== carrierVersion) return { ok: false, reason: "npm-carrier-version-mismatch" };
	const carrierIntegrity = packageIntegrity(carrier);
	if (!carrierIntegrity) return { ok: false, reason: "npm-carrier-integrity-missing" };

	const appVersion = typeof carrier.appVersion === "string" ? carrier.appVersion : null;
	if (appVersion !== null) {
		const parsedApp = parseVersion(appVersion);
		const parsedPlugin = parseVersion(candidateVersion);
		if (!parsedApp || parsedApp.build === null) return { ok: false, reason: "npm-app-version-invalid" };
		if (parsedApp.version !== parsedPlugin.version) return { ok: false, reason: "npm-app-version-pairing-mismatch" };
	}
	const contentSha256 = typeof carrier.pluginContentSha256 === "string" ? carrier.pluginContentSha256.toLowerCase() : "";
	if (contentSha256 !== "" && !/^[0-9a-f]{64}$/.test(contentSha256)) {
		return { ok: false, reason: "npm-plugin-content-sha256-invalid" };
	}

	return {
		ok: true,
		channel: channel.channel,
		plugin: {
			name: packageName,
			version: candidateVersion,
			integrity: pluginIntegrity,
			contentSha256,
		},
		carrier: {
			name: packageName,
			version: carrierVersion,
			integrity: carrierIntegrity,
			appVersion,
			pluginContentSha256: contentSha256,
			legacyMetadataMissing: appVersion === null,
		},
	};
}

export function runNpmView(args, { cwd = process.cwd(), timeoutMs = 20_000, execFileImpl = execFile, platform = process.platform } = {}) {
	return new Promise((resolve) => {
		execFileImpl("npm", args, {
			cwd,
			env: process.env,
			timeout: timeoutMs,
			maxBuffer: 1024 * 1024,
			windowsHide: true,
			// Windows 上 npm 是 npm.cmd，必须经 shell 解析；POSIX 直接 spawn。
			...shellOptions(platform),
		}, (error, stdout, stderr) => {
			if (error) {
				// npm stderr may contain private registry URLs; expose only a stable source error.
				// 区分「找不到 npm 客户端」与「registry 不可用」，便于界面给出可执行提示：
				// Windows shell 找不到 .cmd 时 cmd 会报「不是内部或外部命令」而不是 ENOENT。
				const stderrText = String(stderr ?? "");
				const clientMissing = error?.code === "ENOENT" || /not recognized|不是内部或外部命令|command not found/i.test(stderrText);
				resolve({ ok: false, error: clientMissing ? "npm-client-unavailable" : "npm-view-failed" });
				return;
			}
			resolve({ ok: true, stdout: String(stdout ?? "") });
		});
	});
}

/** 检查失败原因：npm 客户端缺失是环境问题，不应伪装成 registry 故障。 */
function viewFailureReason(error) {
	return error?.message === "npm-client-unavailable" ? "npm-client-unavailable" : "npm-registry-unavailable";
}

/**
 * Host-side npm view adapter. It deliberately supplies no --registry argument so npm
 * applies the DSH process's project/user config, including scoped registry and credentials.
 */
export function createNpmPackageView({ packageName, cwd, run = runNpmView, platform = process.platform } = {}) {
	return async (spec) => {
		if (typeof spec !== "string" || spec === "") throw new Error("npm-package-spec-invalid");
		const args = spec === packageName
			? ["view", packageName, "dist-tags", "--json"]
			: ["view", spec, "--json"];
		const result = await run(args, { cwd, platform });
		if (!result?.ok) throw new Error(result?.error ?? "npm-view-failed");
		try {
			return JSON.parse(result.stdout);
		} catch {
			throw new Error("npm-view-json-invalid");
		}
	};
}
