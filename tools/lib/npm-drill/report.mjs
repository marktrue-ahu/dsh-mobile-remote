// 演练运行记录与输出（唯一 CLI seam 的一部分）：
// 逐条 PASS/FAIL、结尾 RESULT / REASONS / 证据目录；结构化记录写到 <状态目录>/drill/<UTC>-<版本>/run.json。
import fs from "node:fs";
import path from "node:path";
import { ensureDir, writeTextFile } from "./process.mjs";
import { normalizeReason } from "./reasons.mjs";

export const RUN_RECORD_SCHEMA = "npm-drill/v1";

/** UTC 时间戳（用于 run 目录名）：20261022T001234Z。 */
export function utcStamp(date = new Date()) {
	const pad = (value) => String(value).padStart(2, "0");
	return [
		date.getUTCFullYear(),
		pad(date.getUTCMonth() + 1),
		pad(date.getUTCDate()),
		"T",
		pad(date.getUTCHours()),
		pad(date.getUTCMinutes()),
		pad(date.getUTCSeconds()),
		"Z",
	].join("");
}

export function createRunRecord({ versions, dist, registry, environment, pluginTag = "latest" }) {
	const startedAt = new Date();
	return {
		schema: RUN_RECORD_SCHEMA,
		tool: "npm-drill",
		drillVersion: versions.pluginA,
		carrierVersion: versions.carrierA,
		pluginTag,
		versions,
		dist,
		status: "RUNNING",
		startedAt: startedAt.toISOString(),
		finishedAt: null,
		durationMs: 0,
		registry: registry ?? null,
		environment: environment ?? null,
		phases: [],
		reasons: [],
		evidence: null,
		_startedAtMs: startedAt.getTime(),
	};
}

/** 开始一个阶段。`reported=false` 表示它是为调试选中阶段而自动执行的静默前置。 */
export function beginPhase(record, name, { reported = true } = {}) {
	const phase = {
		name,
		reported,
		ok: true,
		durationMs: 0,
		assertions: [],
		startedAt: Date.now(),
	};
	record.phases.push(phase);
	return phase;
}

/** 记录一条断言（同时打印到 stdout；静默前置只记录不打印）。 */
export function recordAssertion(phase, assertion) {
	const reason = assertion.pass ? null : normalizeReason(assertion.reason);
	const item = {
		id: assertion.id,
		title: assertion.title,
		pass: Boolean(assertion.pass),
		reason,
		detail: assertion.detail ?? "",
		durationMs: assertion.durationMs ?? 0,
	};
	phase.assertions.push(item);
	if (!item.pass) phase.ok = false;
	if (phase.reported) printAssertion(item);
	return item;
}

export function endPhase(record, phase) {
	// 时钟回拨（WSL 偶发）会让耗时变负，展示层按 0 clamp。
	phase.durationMs = Math.max(0, Date.now() - phase.startedAt);
	delete phase.startedAt;
	if (phase.reported) {
		const total = phase.assertions.length;
		const passed = phase.assertions.filter((assertion) => assertion.pass).length;
		console.log(`-- ${phase.name}: ${passed}/${total} ${phase.ok ? "PASS" : "FAIL"} (${formatDuration(phase.durationMs)}) --`);
	}
}

export function printPhaseHeader(name) {
	console.log(`\n== phase ${name} ==`);
}

export function printAssertion(item) {
	const suffix = item.pass ? "" : ` [reason:${item.reason}]`;
	const detail = item.detail ? ` (${item.detail})` : "";
	console.log(`${item.pass ? "PASS" : "FAIL"}  ${item.id} ${item.title}${suffix}${detail}`);
}

export function formatDuration(ms) {
	return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/** 收尾：计算 status/reasons/耗时，写 run.json，打印 RESULT/REASONS/证据目录。返回最终记录。 */
export function finalizeRecord(record, { runDir, keep, evidenceDir }) {
	record.status = record.phases.every((phase) => phase.ok) ? "PASS" : "FAIL";
	record.finishedAt = new Date().toISOString();
	record.durationMs = Math.max(0, Date.now() - record._startedAtMs);
	record.reasons = [...new Set(record.phases.flatMap((phase) => phase.assertions.filter((assertion) => !assertion.pass).map((assertion) => assertion.reason)))];
	record.evidence = {
		dir: evidenceDir ?? runDir,
		runJson: path.join(runDir, "run.json"),
		keep: Boolean(keep),
	};
	delete record._startedAtMs;
	ensureDir(runDir);
	writeTextFile(path.join(runDir, "run.json"), `${JSON.stringify(record, null, 2)}\n`);
	return record;
}

export function printRunSummary(record) {
	const reasons = record.reasons.length === 0 ? "none" : record.reasons.join(",");
	console.log(`\nRESULT: ${record.status}`);
	console.log(`PLUGIN_TAG: ${record.pluginTag ?? "latest"}`);
	console.log(`REASONS: ${reasons}`);
	console.log(`DURATION: ${(record.durationMs / 1000).toFixed(1)}s`);
	console.log(`EVIDENCE: ${record.evidence.dir}`);
}

/** 离线/参数错误时的一致性输出（不产生 run.json）。 */
export function printCliFailure({ title, reason, detail = "" }) {
	console.log(`FAIL  ${title} [reason:${normalizeReason(reason)}]${detail ? ` (${detail})` : ""}`);
	console.log("\nRESULT: FAIL");
	console.log(`REASONS: ${normalizeReason(reason)}`);
}

export function readRunRecord(file) {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}
