import { execFile } from "node:child_process";
import { appCarrierAlias, appCarrierVersion } from "./app-carrier.js";
import { parseVersion } from "./plugin-update.js";

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
	} catch {
		return { ok: false, reason: "npm-registry-unavailable" };
	}
	const candidateVersion = tags?.["dist-tags"]?.[channel.channel];
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

function runNpmView(args, { cwd = process.cwd(), timeoutMs = 20_000, execFileImpl = execFile } = {}) {
	return new Promise((resolve) => {
		execFileImpl("npm", args, {
			cwd,
			env: process.env,
			timeout: timeoutMs,
			maxBuffer: 1024 * 1024,
			windowsHide: true,
		}, (error, stdout, _stderr) => {
			if (error) {
				// npm stderr may contain private registry URLs; expose only a stable source error.
				resolve({ ok: false, error: "npm-view-failed" });
				return;
			}
			resolve({ ok: true, stdout: String(stdout ?? "") });
		});
	});
}

/**
 * Host-side npm view adapter. It deliberately supplies no --registry argument so npm
 * applies the DSH process's project/user config, including scoped registry and credentials.
 */
export function createNpmPackageView({ packageName, cwd, run = runNpmView } = {}) {
	return async (spec) => {
		if (typeof spec !== "string" || spec === "") throw new Error("npm-package-spec-invalid");
		const args = spec === packageName
			? ["view", packageName, "dist-tags", "--json"]
			: ["view", spec, "--json"];
		const result = await run(args, { cwd });
		if (!result?.ok) throw new Error("npm-view-failed");
		try {
			return JSON.parse(result.stdout);
		} catch {
			throw new Error("npm-view-json-invalid");
		}
	};
}
