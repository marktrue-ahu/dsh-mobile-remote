// 演练产物投影的回归：载体包内轻量元数据必须随清单一起投影。
//
// 背景：npm-drill 投影会把真实 dist 改成一次性的 9.9.x 演练版本，并把载体 manifest 的
// app.version 改成 <演练插件版本>+<原构建号>。若载体 package.json 的 appVersion /
// pluginContentSha256 不跟着改写，运行时载体发现会误报
// carrier-app-version-metadata-mismatch，导致 drill 假失败（A11/A13 级联）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { projectCarrier } from "../tools/lib/npm-drill/projection.mjs";

function sha256(buffer) {
	return createHash("sha256").update(buffer).digest("hex");
}

test("projectCarrier rewrites carrier package metadata together with projected manifest", async () => {
	const work = mkdtempSync(join(tmpdir(), "npm-drill-projection-"));
	const sourceParent = join(work, "source");
	const source = join(sourceParent, "package");
	mkdirSync(source, { recursive: true });
	const apk = Buffer.from([1, 2, 3, 4]);
	writeFileSync(join(source, "app.apk"), apk);
	const sourceManifest = {
		schema: 1,
		version: "3.2.1+26",
		apk: "app.apk",
		size: apk.length,
		sha256: sha256(apk),
		app: { version: "3.2.1+26", file: "app.apk", size: apk.length, sha256: sha256(apk) },
		plugin: {
			version: "3.2.1-rc.1",
			file: "dsh-mobile-remote-v3.2.1-rc.1.tgz",
			size: 3,
			sha256: "b".repeat(64),
			contentSha256: "c".repeat(64),
		},
	};
	writeFileSync(join(source, "manifest.json"), `${JSON.stringify(sourceManifest, null, 2)}\n`);
	writeFileSync(join(source, "package.json"), `${JSON.stringify({
		name: "@marktrue/dsh-mobile-remote",
		version: "3.2.1-rc.1-app",
		appVersion: "3.2.1+26",
		pluginContentSha256: "c".repeat(64),
		dsh: { appCarrier: true },
	}, null, 2)}\n`);
	const sourceTgz = join(work, "source-carrier.tgz");
	execFileSync("tar", ["-czf", sourceTgz, "-C", sourceParent, "package"]);

	const pluginProject = {
		pluginVersion: "9.9.123",
		filename: "dsh-mobile-remote-9.9.123.tgz",
		size: 3,
		sha256: "b".repeat(64),
		contentSha256: "d".repeat(64),
	};
	const result = await projectCarrier({
		sourceTgz,
		workDir: work,
		version: "9.9.123-app",
		manifest: sourceManifest,
		pluginProject,
		env: process.env,
		logFile: join(work, "project.log"),
		label: "projection-regression",
	});
	assert.equal(result.ok, true, JSON.stringify(result));

	const pkg = JSON.parse(execFileSync("tar", ["-xzOf", result.tarball, "package/package.json"], { encoding: "utf8" }));
	assert.equal(pkg.version, "9.9.123-app");
	assert.equal(pkg.appVersion, "9.9.123+26", "载体包内 appVersion 必须随清单投影");
	assert.equal(pkg.pluginContentSha256, pluginProject.contentSha256, "载体包内 pluginContentSha256 必须随投影插件内容标识改写");

	const manifest = JSON.parse(execFileSync("tar", ["-xzOf", result.tarball, "package/manifest.json"], { encoding: "utf8" }));
	assert.equal(manifest.app.version, "9.9.123+26");
	assert.equal(manifest.plugin.version, "9.9.123");
	assert.equal(manifest.plugin.contentSha256, pluginProject.contentSha256);
});
