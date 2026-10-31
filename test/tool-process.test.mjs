import assert from "node:assert/strict";
import { test } from "node:test";
import { quoteShellArgument, shellOptions } from "../lib/tool-process.js";

test("shellOptions only enables a shell on Windows (.cmd tools)", () => {
	assert.deepEqual(shellOptions("win32"), { shell: true });
	assert.deepEqual(shellOptions("linux"), {});
	assert.deepEqual(shellOptions("darwin"), {});
});

test("quoteShellArgument quotes spaced Windows paths but leaves POSIX arguments untouched", () => {
	assert.equal(quoteShellArgument("C:\\Users\\John Doe\\Temp", "win32"), '"C:\\Users\\John Doe\\Temp"');
	assert.equal(quoteShellArgument("C:\\Users\\mark\\Temp", "win32"), "C:\\Users\\mark\\Temp");
	assert.equal(quoteShellArgument("/home/mark/tmp dir", "linux"), "/home/mark/tmp dir");
	assert.equal(quoteShellArgument("", "win32"), "");
});
