import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { packNpmTarball, prepareNpmArtifacts, runCommand } from "../lib/plugin-self-update.js";
import { pluginContentDigest } from "../lib/plugin-content-digest.js";

const PACKAGE_NAME = "@polaris-l/dsh-mobile-remote";
const VERSION = "3.2.2-alpha.1";
const PACKAGE_SPEC = `${PACKAGE_NAME}@${VERSION}`;
const sha512 = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

test("packNpmTarball uses host npm config and verifies exact package SRI", async () => {
	const base = await mkdtemp(join(tmpdir(), "npm-pack-artifact-"));
	const destDir = join(base, "work");
	const profileDir = join(base, "profile");
	await mkdir(profileDir, { recursive: true });
	const bytes = Buffer.from("immutable npm tarball fixture");
	const integrity = sha512(bytes);
	let invocation;
	try {
		const result = await packNpmTarball({
			packageName: PACKAGE_NAME,
			version: VERSION,
			expectedIntegrity: integrity,
			destDir,
			cwd: profileDir,
			run: async (command, args, options) => {
				invocation = { command, args, options };
				const filename = "polaris-l-dsh-mobile-remote-3.2.2-alpha.1.tgz";
				await writeFile(join(destDir, filename), bytes);
				return { ok: true, stdout: JSON.stringify([{ name: PACKAGE_NAME, version: VERSION, filename, integrity }]) };
			},
		});
		assert.equal(result.ok, true, result.error);
		assert.deepEqual(await readFile(result.file), bytes);
		assert.equal(result.integrity, integrity);
		assert.equal(invocation.command, "npm");
		assert.ok(invocation.args.includes("--ignore-scripts"));
		assert.ok(invocation.args.includes("--json"));
		assert.ok(invocation.args.includes(PACKAGE_SPEC));
		assert.equal(invocation.args.includes("--registry"), false);
		assert.equal(invocation.options.cwd, profileDir);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("packNpmTarball rejects bytes that disagree with the locked packument integrity", async () => {
	const base = await mkdtemp(join(tmpdir(), "npm-pack-bad-"));
	const destDir = join(base, "work");
	const expectedBytes = Buffer.from("expected");
	const actualBytes = Buffer.from("tampered");
	const expectedIntegrity = sha512(expectedBytes);
	try {
		const result = await packNpmTarball({
			packageName: PACKAGE_NAME,
			version: VERSION,
			expectedIntegrity,
			destDir,
			run: async () => {
				const filename = "tampered.tgz";
				await writeFile(join(destDir, filename), actualBytes);
				return { ok: true, stdout: JSON.stringify([{ name: PACKAGE_NAME, version: VERSION, filename, integrity: expectedIntegrity }]) };
			},
		});
		assert.equal(result.ok, false);
		assert.equal(result.error, "npm-pack-integrity-mismatch");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("NPM artifact preparation checks tarball SRI, embedded pairing manifest, APK and plugin content", async () => {
	const base = await mkdtemp(join(tmpdir(), "npm-pair-verify-"));
	const pluginRoot = join(base, "plugin-root");
	const carrierRoot = join(base, "carrier-root");
	const workDir = join(base, "work");
	const pluginPackageDir = join(pluginRoot, "package");
	const carrierPackageDir = join(carrierRoot, "package");
	const pluginVersion = "3.3.0-alpha.1";
	const carrierVersion = `${pluginVersion}-app`;
	const appVersion = "3.3.0+70";
	// npm pack 规范化后的文件名（scope 前缀、无发布产物的 `-v`）
	const pluginFilename = "polaris-l-dsh-mobile-remote-3.3.0-alpha.1.tgz";
	// 发布清单里记录的是发布产物名；两者不同是真实 NPM 路径的常态。
	const releasePluginFilename = "dsh-mobile-remote-v3.3.0-alpha.1.tgz";
	const carrierFilename = "polaris-l-dsh-mobile-remote-3.3.0-alpha.1-app.tgz";
	const apkName = "DSH-Remote-v3.3.0.apk";
	const apkBytes = Buffer.from("fixture apk bytes");
	let pluginTgz, carrierTgz, pluginContentSha256, pluginIntegrity, carrierIntegrity, pluginSha256;
	try {
		await mkdir(join(pluginPackageDir, "lib"), { recursive: true });
		await mkdir(carrierPackageDir, { recursive: true });
		await writeFile(join(pluginPackageDir, "lib", "index.js"), "export const plugin = 'candidate';\n");
		await writeFile(join(pluginPackageDir, "package.json"), JSON.stringify({
			name: PACKAGE_NAME, version: pluginVersion,
			optionalDependencies: { "@polaris-l/dsh-mobile-remote-app": `npm:${PACKAGE_NAME}@${carrierVersion}` },
		}));
		pluginContentSha256 = pluginContentDigest(pluginPackageDir);
		pluginTgz = join(base, pluginFilename);
		execFileSync("tar", ["-czf", pluginTgz, "-C", pluginRoot, "package"]);
		const pluginBytes = await readFile(pluginTgz);
		pluginIntegrity = sha512(pluginBytes);
		pluginSha256 = createHash("sha256").update(pluginBytes).digest("hex");
		const manifest = {
			schema: 1,
			version: appVersion,
			apk: apkName,
			size: apkBytes.length,
			sha256: createHash("sha256").update(apkBytes).digest("hex"),
			app: { version: appVersion, file: apkName, size: apkBytes.length, sha256: createHash("sha256").update(apkBytes).digest("hex") },
			plugin: { version: pluginVersion, file: releasePluginFilename, size: pluginBytes.length, sha256: pluginSha256, contentSha256: pluginContentSha256 },
		};
		await writeFile(join(carrierPackageDir, "manifest.json"), JSON.stringify(manifest));
		await writeFile(join(carrierPackageDir, apkName), apkBytes);
		await writeFile(join(carrierPackageDir, "package.json"), JSON.stringify({
			name: PACKAGE_NAME, version: carrierVersion, dsh: { appCarrier: true }, appVersion,
			pluginContentSha256, files: [apkName, "manifest.json", "README.md", "LICENSE"],
		}));
		carrierTgz = join(base, carrierFilename);
		execFileSync("tar", ["-czf", carrierTgz, "-C", carrierRoot, "package"]);
		carrierIntegrity = sha512(await readFile(carrierTgz));

		const artifacts = new Map([
			[`${PACKAGE_NAME}@${pluginVersion}`, { path: pluginTgz, filename: pluginFilename, integrity: pluginIntegrity }],
			[`${PACKAGE_NAME}@${carrierVersion}`, { path: carrierTgz, filename: carrierFilename, integrity: carrierIntegrity }],
		]);
		const run = async (command, args, options) => {
			if (command === "npm" && args[0] === "pack") {
				const spec = args.at(-1);
				const artifact = artifacts.get(spec);
				assert.ok(artifact, `unexpected npm spec ${spec}`);
				const destination = args[args.indexOf("--pack-destination") + 1];
				await mkdir(destination, { recursive: true });
				await writeFile(join(destination, artifact.filename), await readFile(artifact.path));
				return { ok: true, stdout: JSON.stringify([{ name: PACKAGE_NAME, version: spec.slice(PACKAGE_NAME.length + 1), filename: artifact.filename, integrity: artifact.integrity }]) };
			}
			return runCommand(command, args, options);
		};
		const candidate = {
			plugin: { name: PACKAGE_NAME, version: pluginVersion, integrity: pluginIntegrity, contentSha256: pluginContentSha256 },
			carrier: { name: PACKAGE_NAME, version: carrierVersion, integrity: carrierIntegrity, appVersion, pluginContentSha256, legacyMetadataMissing: false },
		};
		const result = await prepareNpmArtifacts({ npmCandidate: candidate, packageName: PACKAGE_NAME, profileDir: base, workDir, runCommandImpl: run });
		assert.equal(result.ok, true, result.error);
		assert.equal(result.manifest.app.version, appVersion);
		assert.equal(result.manifest.plugin.contentSha256, pluginContentSha256);
		assert.equal(result.pluginContentSha256, pluginContentSha256);
		assert.equal(result.pluginTarballSha256, pluginSha256);
		assert.equal(result.carrierAppVersion, appVersion);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});
