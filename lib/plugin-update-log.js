import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { serverOperationPath } from "./plugin-update-transaction.js";

export const UPDATE_LOG_MAX_LINES = 400;
export const UPDATE_LOG_MAX_BYTES = 128 * 1024;
export const UPDATE_LOG_MAX_OPERATIONS = 20;
const MAX_LINE_BYTES = 4096;
const ANSI = /\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const SENSITIVE_KEY = /\b(_authToken|_auth|npm_config_[A-Za-z0-9_-]+|password|token|access_token|refresh_token|api[_-]?key|secret)\s*[:=]\s*([^\s&"']+)/gi;
const URL_USERINFO = /(https?:\/\/)[^/\s@]+@/gi;
const URL_SECRET_QUERY = /([?&](?:token|auth|password|key|secret|signature|access_token|refresh_token)=)[^&#\s]*/gi;

function logPath(home, generation) {
	return `${serverOperationPath(home, generation)}.log.jsonl`;
}

/** Keep the active/new log plus a bounded tail of completed operation logs. */
export function pruneOperationLogs({ home, generation, maxOperations = UPDATE_LOG_MAX_OPERATIONS } = {}) {
	const currentPath = logPath(home, generation);
	const dir = dirname(currentPath);
	if (!existsSync(dir)) return 0;
	const limit = Number.isSafeInteger(maxOperations) && maxOperations > 0 ? maxOperations : UPDATE_LOG_MAX_OPERATIONS;
	try {
		const root = realpathSync(dir);
		const currentName = basename(currentPath);
		const logs = readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isFile() && /^[a-f0-9-]{36}\.json\.log\.jsonl$/.test(entry.name))
			.map((entry) => ({ name: entry.name, mtime: statSync(join(root, entry.name)).mtimeMs }))
			.sort((a, b) => b.mtime - a.mtime);
		const keep = new Set([currentName, ...logs.map((item) => item.name).filter((name) => name !== currentName).slice(0, limit - 1)]);
		let removed = 0;
		for (const item of logs) {
			if (keep.has(item.name)) continue;
			const target = join(root, item.name);
			const resolved = realpathSync(target);
			const rel = relative(root, resolved);
			if (rel !== item.name || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
			rmSync(resolved, { force: true });
			removed++;
		}
		return removed;
	} catch {
		return 0;
	}
}

function readEvents(filePath) {
	try {
		return readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
			.filter((event) => Number.isSafeInteger(event?.seq) && typeof event?.text === "string");
	} catch {
		return [];
	}
}

function sanitize(text, redactPaths = []) {
	let value = String(text ?? "").replace(ANSI, "");
	value = value.replace(/\b(authorization\s*:\s*)(?:basic|bearer)\s+[^\s]+/gi, "$1[REDACTED]");
	value = value.replace(/\b(basic|bearer)\s+[^\s]+/gi, "$1 [REDACTED]");
	value = value.replace(URL_USERINFO, "$1[REDACTED]@");
	value = value.replace(URL_SECRET_QUERY, "$1[REDACTED]");
	value = value.replace(SENSITIVE_KEY, "$1=[REDACTED]");
	for (const path of [...redactPaths].filter((item) => typeof item === "string" && item !== "").sort((a, b) => b.length - a.length)) {
		value = value.split(path).join("[host-path]");
	}
	if (Buffer.byteLength(value) > MAX_LINE_BYTES) {
		let end = Math.min(value.length, MAX_LINE_BYTES);
		while (end > 0 && Buffer.byteLength(value.slice(0, end)) > MAX_LINE_BYTES - 16) end -= 64;
		value = `${value.slice(0, Math.max(0, end))}…[line truncated]`;
	}
	return value;
}

function persistEvents(filePath, events, { maxLines = UPDATE_LOG_MAX_LINES, maxBytes = UPDATE_LOG_MAX_BYTES } = {}) {
	let kept = events.slice(-Math.max(1, maxLines));
	const encoded = () => kept.map((event) => JSON.stringify(event)).join("\n") + (kept.length ? "\n" : "");
	while (kept.length > 0 && Buffer.byteLength(encoded()) > maxBytes) kept = kept.slice(1);
	mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
	const tmp = `${filePath}.${randomUUID()}.tmp`;
	try {
		writeFileSync(tmp, encoded(), { encoding: "utf8", mode: 0o600 });
		renameSync(tmp, filePath);
		try { chmodSync(filePath, 0o600); } catch { /* best-effort on platforms without POSIX modes */ }
	} finally {
		if (existsSync(tmp)) rmSync(tmp, { force: true });
	}
	return kept;
}

function appendEvents(filePath, items, options = {}) {
	if (!Array.isArray(items) || items.length === 0) return readEvents(filePath);
	const events = readEvents(filePath);
	let seq = events.length ? events[events.length - 1].seq + 1 : 1;
	const next = items.map((item) => ({
		seq: seq++,
		at: new Date().toISOString(),
		stage: String(item.stage ?? "unknown"),
		stream: item.stream === "stdout" || item.stream === "stderr" ? item.stream : "status",
		text: sanitize(item.text, options.redactPaths),
	}));
	return persistEvents(filePath, [...events, ...next], options);
}

/** Create a bounded append/replay view keyed only by the server-generated operation generation. */
export function createOperationLog({ home, generation, maxLines = UPDATE_LOG_MAX_LINES, maxBytes = UPDATE_LOG_MAX_BYTES,
	maxOperations = UPDATE_LOG_MAX_OPERATIONS, redactPaths = [] } = {}) {
	const filePath = logPath(home, generation);
	mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
	if (!existsSync(filePath)) writeFileSync(filePath, "", { encoding: "utf8", mode: 0o600 });
	pruneOperationLogs({ home, generation, maxOperations });
	let stage = "staging";
	const pending = { stdout: "", stderr: "" };
	const options = { maxLines, maxBytes, redactPaths };
	return {
		filePath,
		setStage(nextStage, text = "") {
			stage = String(nextStage || "unknown");
			return appendEvents(filePath, [{ stage, stream: "status", text: text || stage }], options);
		},
		appendStatus(text, stageOverride = stage) {
			return appendEvents(filePath, [{ stage: stageOverride, stream: "status", text }], options);
		},
		appendChunk(stream, text) {
			if (stream !== "stdout" && stream !== "stderr") return;
			const merged = `${pending[stream]}${String(text ?? "")}`.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
			const lines = merged.split("\n");
			pending[stream] = lines.pop() ?? "";
			const items = lines.map((line) => ({ stage, stream, text: line }));
			if (items.length) appendEvents(filePath, items, options);
		},
		flush() {
			const items = [];
			for (const stream of ["stdout", "stderr"]) {
				if (pending[stream] !== "") items.push({ stage, stream, text: pending[stream] });
				pending[stream] = "";
			}
			if (items.length) appendEvents(filePath, items, options);
		},
		read(afterSeq = 0) {
			return readOperationLog({ home, generation, afterSeq, maxLines });
		},
	};
}

/** Append one sanitized status event from a separate supervisor process. */
export function appendOperationLog({ home, generation, stage = "supervisor", stream = "status", text = "", maxLines = UPDATE_LOG_MAX_LINES, maxBytes = UPDATE_LOG_MAX_BYTES, redactPaths = [] } = {}) {
	return appendEvents(logPath(home, generation), [{ stage, stream, text }], { maxLines, maxBytes, redactPaths });
}

/** Read only a bounded, sanitized page using a server-owned operation generation. */
export function readOperationLog({ home, generation, afterSeq = 0, maxLines = UPDATE_LOG_MAX_LINES } = {}) {
	const events = readEvents(logPath(home, generation));
	const firstSeq = events[0]?.seq ?? 0;
	const lastSeq = events.at(-1)?.seq ?? 0;
	const cursor = Number.isSafeInteger(afterSeq) && afterSeq >= 0 ? afterSeq : 0;
	return {
		events: events.filter((event) => event.seq > cursor).slice(-Math.max(1, maxLines)),
		firstSeq,
		lastSeq,
		truncated: firstSeq > 0 && (firstSeq > 1 || cursor > 0 && cursor < firstSeq - 1),
	};
}
