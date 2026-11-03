import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { appCarrierAlias, appCarrierVersion } from "../lib/app-carrier.js";
import { pluginContentDigest } from "../lib/plugin-content-digest.js";
import { runSelfUpdate } from "../lib/plugin-self-update.js";
import { superviseUpdate } from "../lib/update-supervisor.js";
import { artifactDir, artifactRoot, finishOwnedTerminal, readLock, readTransaction, releaseLock, serverOperationPath, updateLockPath } from "../lib/plugin-update-transaction.js";

const PACKAGE_NAME = "@polaris-l/dsh-mobile-remote";
const OLD_VERSION = "3.2.1-alpha.3";
const NEXT_VERSION = "3.2.2-alpha.1";
const CARRIER_VERSION = appCarrierVersion(NEXT_VERSION);
const APP_VERSION = "3.2.2+26";
const APK_NAME = "DSH-Remote-v3.2.2.apk";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function write(file, content) {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
}

test("NPM transaction installs an exact scoped version and verifies the carrier before restart", async () => {
	const base = mkdtempSync(join(tmpdir(), "npm-update-transaction-"));
	const home = join(base, "home");
	const profileDir = join(base, "profile");
	const installedRoot = join(profileDir, "node_modules", ...PACKAGE_NAME.split("/"));
	const candidatePackageDir = join(base, "prepared", "package");
	const carrierPackageDir = join(base, "prepared-carrier", "package");
	const apkBytes = Buffer.from("matched carrier APK fixture");
	const oldSource = "export const current = 'old';\n";
	const newSource = "export const current = 'new';\n";
	write(join(installedRoot, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version: OLD_VERSION }));
	write(join(installedRoot, "lib", "index.js"), oldSource);
	write(join(profileDir, "package.json"), JSON.stringify({ name: "web-profile", dependencies: { [PACKAGE_NAME]: OLD_VERSION, qrcode: "^1.5.4" } }));
	write(join(profileDir, "pnpm-lock.yaml"), "old-lock\n");
	write(join(candidatePackageDir, "package.json"), JSON.stringify({
		name: PACKAGE_NAME,
		version: NEXT_VERSION,
		optionalDependencies: { [appCarrierAlias(PACKAGE_NAME)]: `npm:${PACKAGE_NAME}@${CARRIER_VERSION}` },
	}));
	write(join(candidatePackageDir, "lib", "index.js"), newSource);
	const contentSha256 = pluginContentDigest(candidatePackageDir);
	const appSha256 = sha256(apkBytes);
	const manifest = {
		schema: 1,
		version: APP_VERSION,
		apk: APK_NAME,
		size: apkBytes.length,
		sha256: appSha256,
		app: { version: APP_VERSION, file: APK_NAME, size: apkBytes.length, sha256: appSha256 },
		plugin: { version: NEXT_VERSION, file: "plugin.tgz", size: 8, sha256: "a".repeat(64), contentSha256 },
	};
	write(join(carrierPackageDir, "package.json"), JSON.stringify({
		name: PACKAGE_NAME,
		version: CARRIER_VERSION,
		dsh: { appCarrier: true },
		appVersion: APP_VERSION,
		pluginContentSha256: contentSha256,
	}));
	write(join(carrierPackageDir, "manifest.json"), JSON.stringify(manifest));
	write(join(carrierPackageDir, APK_NAME), apkBytes);
	const npmCandidate = {
		plugin: { name: PACKAGE_NAME, version: NEXT_VERSION, integrity: "sha512-Y2FuZGlkYXRl", contentSha256: "" },
		carrier: { name: PACKAGE_NAME, version: CARRIER_VERSION, integrity: "sha512-Y2Fycmllcg==", appVersion: null, pluginContentSha256: "", legacyMetadataMissing: true },
	};
	const preparedNpmArtifacts = {
		ok: true,
		pluginPackageDir: candidatePackageDir,
		carrierPackageDir,
		pluginContentSha256: contentSha256,
		pluginTarballSha256: "a".repeat(64),
		carrierAppVersion: APP_VERSION,
		manifest,
	};
	let installOutput = "";
	const outputChunks = [];
	try {
		const result = await runSelfUpdate({
			home,
			profileDir,
			installedRoot,
			pluginRoot: installedRoot,
			plugin: npmCandidate.plugin,
			npmCandidate,
			preparedNpmArtifacts,
			restartForm: "web-foreground",
			freezeImpl: () => ({ ok: true, entry: "/fixture" }),
			spawnArmedImpl: () => ({ ok: true, mode: "fixture" }),
			awaitReadyImpl: async () => ({ ok: true, ready: { pid: process.pid } }),
			onOutput: (stream, text) => outputChunks.push({ stream, text }),
			runInstall: async (profile, { onOutput } = {}) => {
				const doc = JSON.parse(readFileSync(join(profile, "package.json"), "utf8"));
				assert.equal(doc.dependencies[PACKAGE_NAME], NEXT_VERSION, "profile must keep an exact NPM spec, not file:");
				rmSync(installedRoot, { recursive: true, force: true });
				mkdirSync(dirname(installedRoot), { recursive: true });
				const artifact = artifactDir(artifactRoot(home), contentSha256);
				cpSync(artifact, installedRoot, { recursive: true });
				const carrierLink = join(installedRoot, "node_modules", appCarrierAlias(PACKAGE_NAME));
				mkdirSync(dirname(carrierLink), { recursive: true });
				symlinkSync(carrierPackageDir, carrierLink, "dir");
				onOutput?.("stdout", "pnpm install complete\n");
				installOutput += "done";
				return { ok: true };
			},
		});
		assert.equal(result.ok, true, result.error);
		assert.equal(result.transaction.phase, "restart-pending");
		assert.equal(result.transaction.targetVersion, NEXT_VERSION);
		assert.equal(result.transaction.targetContentSha256, contentSha256);
		assert.equal(result.transaction.targetAppVersion, APP_VERSION);
		assert.equal(result.transaction.npmCandidate.carrier.legacyMetadataMissing, false);
		assert.equal(installOutput, "done");
		assert.ok(outputChunks.some((chunk) => chunk.stream === "stdout" && chunk.text.includes("pnpm install complete")));
		assert.equal(pluginContentDigest(installedRoot), contentSha256);
		const profileDoc = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8"));
		assert.equal(profileDoc.dependencies[PACKAGE_NAME], NEXT_VERSION);
	} finally {
		const lockPath = updateLockPath(home);
		const holder = readLock(lockPath);
		if (holder) {
			const stateFile = serverOperationPath(home, holder.generation);
			try { finishOwnedTerminal(stateFile, { phase: "failed", result: { ok: false, reason: "fixture-cleanup" }, expectedPhases: ["restart-pending"] }, { lockPath, lease: holder }); } catch {}
			releaseLock(lockPath, holder);
		}
		rmSync(base, { recursive: true, force: true });
	}
});

test("NPM rollback restores the prior exact scoped version and old package bytes", async () => {
	const base = mkdtempSync(join(tmpdir(), "npm-update-rollback-"));
	const home = join(base, "home");
	const profileDir = join(base, "profile");
	const installedRoot = join(profileDir, "node_modules", ...PACKAGE_NAME.split("/"));
	const candidatePackageDir = join(base, "prepared", "package");
	const carrierPackageDir = join(base, "prepared-carrier", "package");
	const oldSource = "export const current = 'rollback-old';\n";
	const newSource = "export const current = 'rollback-new';\n";
	write(join(installedRoot, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version: OLD_VERSION }));
	write(join(installedRoot, "lib", "index.js"), oldSource);
	const oldDigest = pluginContentDigest(installedRoot);
	write(join(profileDir, "package.json"), JSON.stringify({ name: "web-profile", dependencies: { [PACKAGE_NAME]: OLD_VERSION, qrcode: "^1.5.4" } }));
	write(join(profileDir, "pnpm-lock.yaml"), "old-lock\n");
	write(join(candidatePackageDir, "package.json"), JSON.stringify({
		name: PACKAGE_NAME, version: NEXT_VERSION,
		optionalDependencies: { [appCarrierAlias(PACKAGE_NAME)]: `npm:${PACKAGE_NAME}@${CARRIER_VERSION}` },
	}));
	write(join(candidatePackageDir, "lib", "index.js"), newSource);
	const contentSha256 = pluginContentDigest(candidatePackageDir);
	const apkBytes = Buffer.from("rollback carrier APK");
	const appSha256 = sha256(apkBytes);
	const manifest = {
		schema: 1, version: APP_VERSION, apk: APK_NAME, size: apkBytes.length, sha256: appSha256,
		app: { version: APP_VERSION, file: APK_NAME, size: apkBytes.length, sha256: appSha256 },
		plugin: { version: NEXT_VERSION, file: "plugin.tgz", size: 8, sha256: "a".repeat(64), contentSha256 },
	};
	write(join(carrierPackageDir, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version: CARRIER_VERSION, dsh: { appCarrier: true }, appVersion: APP_VERSION, pluginContentSha256: contentSha256 }));
	write(join(carrierPackageDir, "manifest.json"), JSON.stringify(manifest));
	write(join(carrierPackageDir, APK_NAME), apkBytes);
	const npmCandidate = {
		plugin: { name: PACKAGE_NAME, version: NEXT_VERSION, integrity: "sha512-Y2FuZGlkYXRl", contentSha256 },
		carrier: { name: PACKAGE_NAME, version: CARRIER_VERSION, integrity: "sha512-Y2Fycmllcg==", appVersion: APP_VERSION, pluginContentSha256: contentSha256, legacyMetadataMissing: false },
	};
	try {
		const failed = await runSelfUpdate({
			home, profileDir, installedRoot, pluginRoot: installedRoot, plugin: npmCandidate.plugin, npmCandidate,
			restartForm: "web-foreground",
			freezeImpl: () => ({ ok: true, entry: "/fixture" }),
			spawnArmedImpl: () => ({ ok: true, mode: "fixture" }),
			awaitReadyImpl: async () => ({ ok: true, ready: { pid: process.pid } }),
			prepareNpmArtifactsImpl: async () => ({ ok: true, pluginPackageDir: candidatePackageDir, carrierPackageDir,
				pluginContentSha256: contentSha256, pluginTarballSha256: "a".repeat(64), carrierAppVersion: APP_VERSION, manifest }),
			runInstall: async (profile) => {
				const doc = JSON.parse(readFileSync(join(profile, "package.json"), "utf8"));
				assert.equal(doc.dependencies[PACKAGE_NAME], NEXT_VERSION);
				rmSync(installedRoot, { recursive: true, force: true });
				mkdirSync(dirname(installedRoot), { recursive: true });
				cpSync(artifactDir(artifactRoot(home), contentSha256), installedRoot, { recursive: true });
				writeFileSync(join(installedRoot, "lib", "index.js"), "partial broken install\n");
				return { ok: false, error: "pnpm-install-failed" };
			},
		});
		assert.equal(failed.ok, false);
		assert.equal(failed.transaction.phase, "rolling-back");
		const stateFile = serverOperationPath(home, failed.transaction.lease.generation);
		const rolledBack = await superviseUpdate({
			stateFile,
			restart: async () => ({ ok: true }),
			waitForHost: async () => ({ ok: pluginContentDigest(installedRoot) === oldDigest, matched: "content" }),
		});
		assert.equal(rolledBack.phase, "rolled-back", JSON.stringify(rolledBack.result));
		assert.equal(pluginContentDigest(installedRoot), oldDigest);
		const profileDoc = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8"));
		assert.equal(profileDoc.dependencies[PACKAGE_NAME], OLD_VERSION, "rollback must restore the exact prior NPM version, not file:");
		assert.equal(readFileSync(join(profileDir, "pnpm-lock.yaml"), "utf8"), "old-lock\n");
	} finally {
		const lockPath = updateLockPath(home);
		const holder = readLock(lockPath);
		if (holder) releaseLock(lockPath, holder);
		rmSync(base, { recursive: true, force: true });
	}
});
