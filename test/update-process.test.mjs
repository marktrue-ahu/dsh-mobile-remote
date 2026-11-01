import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand } from "../lib/plugin-self-update.js";

test("runCommand routes Windows commands through the shell so npm.cmd/pnpm.cmd resolve", async () => {
	// `cd` 是 shell 内建命令：只有 shell 为 true 时才能执行（Windows 上 .cmd 同理）。
	const viaShell = await runCommand("cd", [], { platform: "win32", timeoutMs: 5_000 });
	assert.equal(viaShell.ok, true, viaShell.error);
	const direct = await runCommand("cd", [], { platform: "linux", timeoutMs: 5_000 });
	assert.equal(direct.ok, false);
});

test("runCommand drains both streams, captures bounded tails, and forwards live chunks", async () => {
	const chunks = [];
	const childCode = [
		"const chunk = 'x'.repeat(128 * 1024);",
		"process.stdout.write('OUT-BEGIN\\n' + chunk + '\\nOUT-END\\n');",
		"process.stderr.write('ERR-BEGIN\\n' + chunk + '\\nERR-END\\n');",
	].join(" ");
	const result = await runCommand(process.execPath, ["-e", childCode], {
		timeoutMs: 10_000,
		maxOutputBytes: 1024,
		onOutput: (stream, text) => chunks.push({ stream, text }),
	});

	assert.equal(result.ok, true, result.error);
	assert.match(result.stdout, /OUT-END/);
	assert.match(result.stderr, /ERR-END/);
	assert.ok(Buffer.byteLength(result.stdout) <= 1024);
	assert.ok(Buffer.byteLength(result.stderr) <= 1024);
	assert.ok(chunks.some((chunk) => chunk.stream === "stdout" && chunk.text.includes("OUT-BEGIN")));
	assert.ok(chunks.some((chunk) => chunk.stream === "stderr" && chunk.text.includes("ERR-BEGIN")));
	assert.ok(chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.text), 0) > 128 * 1024);
});
