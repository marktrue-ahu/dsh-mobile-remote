import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createOperationLog, readOperationLog } from "../lib/plugin-update-log.js";

test("operation log persists sanitized line events and resumes from a sequence cursor", () => {
	const home = mkdtempSync(join(tmpdir(), "plugin-update-log-"));
	const generation = randomUUID();
	try {
		const log = createOperationLog({ home, generation, maxLines: 5, maxBytes: 4096, redactPaths: [home, "/profile/private"] });
		log.setStage("install");
		log.appendChunk("stdout", "pnpm install started\nDownloading package\n");
		log.appendChunk("stderr", "Authorization: Bearer secret-token-value\n");
		log.appendChunk("stdout", "https://user:password@registry.example/pkg?token=private-query\n");
		log.flush();

		const page = readOperationLog({ home, generation, afterSeq: 0 });
		assert.ok(page.events.length > 0);
		assert.equal(page.firstSeq, 1);
		assert.equal(page.truncated, false);
		assert.ok(page.events.some((event) => event.stage === "install" && event.stream === "stdout"));
		const serialized = JSON.stringify(page.events);
		for (const secret of ["secret-token-value", "user:password", "private-query", home, "/profile/private"]) {
			assert.equal(serialized.includes(secret), false, `log must redact ${secret}`);
		}
		const cursor = page.events[1].seq;
		const tail = readOperationLog({ home, generation, afterSeq: cursor });
		assert.ok(tail.events.every((event) => event.seq > cursor));

		for (let index = 0; index < 8; index += 1) log.appendChunk("stdout", `line-${index}\n`);
		const bounded = readOperationLog({ home, generation, afterSeq: 0 });
		assert.ok(bounded.events.length <= 5);
		assert.equal(bounded.truncated, true);
		assert.ok(bounded.events.at(-1).seq > bounded.events[0].seq);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("operation log retention pins the active operation and prunes the oldest completed logs", () => {
	const home = mkdtempSync(join(tmpdir(), "plugin-update-log-retention-"));
	const generations = [randomUUID(), randomUUID(), randomUUID()];
	try {
		const first = createOperationLog({ home, generation: generations[0], maxOperations: 2 });
		first.setStage("finished", "old completed operation");
		const old = new Date(Date.now() - 60_000);
		utimesSync(first.filePath, old, old);
		const second = createOperationLog({ home, generation: generations[1], maxOperations: 2 });
		second.setStage("finished", "newer completed operation");
		const active = createOperationLog({ home, generation: generations[2], maxOperations: 2 });
		active.setStage("staging", "active operation");
		assert.equal(existsSync(first.filePath), false);
		assert.equal(existsSync(second.filePath), true);
		assert.equal(existsSync(active.filePath), true);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
