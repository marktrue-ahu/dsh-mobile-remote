import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand } from "../lib/plugin-self-update.js";

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
