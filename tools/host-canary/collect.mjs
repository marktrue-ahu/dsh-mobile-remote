// Run only in the separate issues:write reporting job. Artifacts are untrusted data;
// never execute their content or include arbitrary artifact strings in logs/issues.
import { lstatSync, readFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isExactVersion } from './resolve.mjs';
import { report } from './report.mjs';
import { RUNTIME_ERROR_CODES, INSTALL_ERROR_CODES } from './diagnostics.mjs';

const STATUSES = new Set(['passed', 'compatibility-failure', 'infrastructure-failure']);
const SOURCES = new Set(['fixed', 'latest', 'next', 'alpha']);
const CAPABILITIES = Object.freeze(['jobs.callerShape', 'jobs.eventsApi', 'settings.read', 'gateway.wireStream', 'permissionPresets.apply', 'permissionPresets.catalog', 'workspaceRegistry.stateWrite', 'gateway.eventsPeer']);
const PASS_CHECKS = Object.freeze(['auth', 'bootstrap', 'diagnostics', ...CAPABILITIES.map(name => `host-capability:${name}:ok`)]);
// Capabilities that only become 'ok' after a real browser GUI session connects.
// A passing canary still reports them, and may report them as missing/drift,
// because it never opens a browser; those paths need human device verification.
const SESSION_GATED = Object.freeze(['workspaceRegistry.stateWrite', 'gateway.eventsPeer']);
const isSessionGatedIndex = i => i >= 3 && SESSION_GATED.includes(CAPABILITIES[i - 3]);
const isPassingChecks = checks => Array.isArray(checks) && checks.length === PASS_CHECKS.length &&
  checks.every((value, i) => value === PASS_CHECKS[i] || (isSessionGatedIndex(i) && ['missing', 'drift'].some(state => value === `host-capability:${CAPABILITIES[i - 3]}:${state}`)));
const CHECKS = new Set([...['auth', 'bootstrap', 'diagnostics'], ...CAPABILITIES.flatMap(name => ['ok', 'missing', 'drift'].map(state => `host-capability:${name}:${state}`))]);
const STAGES = new Set(['validate', 'sandbox', 'prepare', 'install', 'runtime', 'complete', 'cleanup']);
const ERROR_CODES = new Set([...RUNTIME_ERROR_CODES, ...INSTALL_ERROR_CODES, 'invalid-input', 'incomplete-checks', 'interrupted', 'process-start-failed', 'plugin-snapshot-invalid', 'source-identity-mismatch', 'installed-identity-mismatch', 'docker-plan-invalid', 'docker-operation-failed', 'docker-identity-invalid', 'docker-image-unverified', 'docker-output-invalid', 'docker-security-mismatch', 'docker-operation-timeout', 'docker-execution-failed', 'docker-cleanup-unconfirmed', 'docker-cleanup-unauthorized', 'runner-identity-mismatch', 'install-failed', 'install-timeout', 'invalid-checks', 'compatibility-check-failed', 'host-start-inconclusive', 'host-ready-timeout', 'host-auth-response-inconclusive', 'host-identity-inconclusive', 'host-bundle-unavailable', 'response-inconclusive', 'host-capabilities-inconclusive', 'probe-input-invalid', 'worker-failed', 'source-archive-failed', 'docker-mount-invalid', 'cleanup-failed', 'runner-not-ephemeral', 'runtime-sandbox-unavailable', 'unexpected-error']);
const ID = /^[1-9]\d{0,19}$/;
const ATTEMPT = /^[1-9]\d{0,9}$/;
const SHA = /^[0-9a-f]{40}$/;
const ISSUE_STATUSES = new Set(['pending', 'passed', 'created', 'updated', 'updated-closed', 'reopened', 'unchanged', 'closed', 'health-unreported']);
function validIssueOutcome(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && ISSUE_STATUSES.has(value.status) &&
    (value.issue === undefined || (Number.isSafeInteger(value.issue) && value.issue > 0));
}
function validCheckPrefix(checks) {
  return checks.every((value, i) => i < 3 ? value === PASS_CHECKS[i] :
    ['ok', 'missing', 'drift'].some(state => value === `host-capability:${CAPABILITIES[i - 3]}:${state}`));
}
function requireContext({ runId, runAttempt, pluginSha }) {
  if (!ID.test(runId ?? '') || !ATTEMPT.test(runAttempt ?? '') || !SHA.test(pluginSha ?? '')) throw new Error('invalid-context');
}
export function validateMatrix(matrix) {
  if (!matrix || typeof matrix !== 'object' || Array.isArray(matrix) || Object.keys(matrix).join(',') !== 'include' || !Array.isArray(matrix.include) || !matrix.include.length || matrix.include.length > 5) throw new Error('invalid-matrix');
  const seen = new Set();
  for (const row of matrix.include) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).sort().join(',') !== 'hostVersion,isCandidate,sources' || !isExactVersion(row.hostVersion) || seen.has(row.hostVersion) || !Array.isArray(row.sources) || !row.sources.length || row.sources.length > 4 || new Set(row.sources).size !== row.sources.length || row.sources.some(s => !SOURCES.has(s)) || row.isCandidate !== row.sources.some(s => s !== 'fixed')) throw new Error('invalid-matrix');
    seen.add(row.hostVersion);
  }
  return matrix.include;
}

function parseArtifact(root, hostVersion, name, pluginSha) {
  try {
    const rootStat = lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
    const dir = join(root, `host-canary-${hostVersion}`);
    const dirStat = lstatSync(dir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return null;
    const file = join(dir, `${name}.json`);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) return null;
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.schema !== 1 || data.hostVersion !== hostVersion || data.pluginSha !== pluginSha || !STATUSES.has(data.status) || !Array.isArray(data.checks) || data.checks.length > 11 || new Set(data.checks).size !== data.checks.length || data.checks.some(value => !CHECKS.has(value)) || !validCheckPrefix(data.checks)) return null;
    if (data.status === 'passed' && (data.stage !== 'complete' || data.errorCode !== null || !isPassingChecks(data.checks))) return null;
    if (data.status === 'compatibility-failure' && (data.stage !== 'runtime' || data.errorCode !== 'compatibility-check-failed' || data.checks.length < 1 || data.checks.length >= PASS_CHECKS.length)) return null;
    return { status: data.status, stage: STAGES.has(data.stage) ? data.stage : 'unknown', errorCode: ERROR_CODES.has(data.errorCode) ? data.errorCode : null, checks: data.checks };
  } catch { return null; }
}

export function buildReports({ matrix, root, runId, runAttempt, pluginSha }) {
  requireContext({ runId, runAttempt, pluginSha });
  if (typeof root !== 'string' || !root || !root.startsWith('/')) throw new Error('invalid-artifact-root');
  return validateMatrix(matrix).map(row => {
    const first = parseArtifact(root, row.hostVersion, 'first', pluginSha) ?? { status: 'infrastructure-failure', stage: 'artifact', errorCode: 'missing-or-invalid-result' };
    const attempts = [{ id: `${runId}-${runAttempt}-1`, result: first.status }];
    let second;
    if (first.status !== 'passed') {
      second = parseArtifact(root, row.hostVersion, 'second', pluginSha) ?? { status: 'infrastructure-failure', stage: 'artifact', errorCode: 'missing-or-invalid-retry' };
      attempts.push({ id: `${runId}-${runAttempt}-2`, result: second.status });
    }
    return { data: { schemaVersion: 1, hostVersion: row.hostVersion, candidate: row.isCandidate, attempts }, sources: row.sources, first, second };
  });
}

export async function publishReports({ entries, token, pluginSha, runId, reportImpl = report }) {
  const results = [];
  for (const entry of entries) {
    try {
      const outcome = await reportImpl(entry.data, { token, pluginSha, runId });
      if (!validIssueOutcome(outcome) || (outcome.health !== undefined && !validIssueOutcome(outcome.health))) throw new Error('invalid-report-outcome');
      results.push({ ...entry, issue: outcome.status, issueNumber: outcome.issue, ...(outcome.health === undefined ? {} : { health: { status: outcome.health.status, ...(outcome.health.issue === undefined ? {} : { issue: outcome.health.issue }) } }) });
    } catch {
      // A GitHub write may have succeeded despite an error response. Never blindly retry it.
      results.push({ ...entry, issue: 'report-failed' });
    }
  }
  return results;
}

export async function recoverGlobalHealth({ results, smokeResult, runId, runAttempt, pluginSha, token, reportImpl = report }) {
  // Only a completely successful run is recovery evidence. Never create a new
  // global issue merely to announce success, and never close one automatically.
  if (smokeResult !== 'success' || !results.length || results.some(row => (row.second ?? row.first).status !== 'passed' || ['report-failed', 'health-unreported'].includes(row.issue))) return { status: 'not-attempted' };
  requireContext({ runId, runAttempt, pluginSha });
  try {
    return await reportImpl({ schemaVersion: 1, hostVersion: null, candidate: false, attempts: [{ id: `${runId}-${runAttempt}-1`, result: 'passed' }] }, { token, pluginSha, runId });
  } catch { return { status: 'report-failed' }; }
}

export function summary(results, { pluginSha, mode }) {
  const text = ['## DSH 宿主兼容性检查', '', `- 插件 commit: \`${pluginSha}\``, `- 模式: \`${mode}\``, '- 计划环境：隔离 Linux 宿主，npm 安装且禁用安装脚本；实际完成阶段以表格为准，不代表其他包管理器。', '- 宿主版本以安装包的 name/version 为准，未独立证明宿主全部文件及依赖的完整性。', '- 报告代码来自当前 develop 提交；需确保 develop 写入和工作流修改权限受信。', '- artifact 的 schema 校验不能独立证明观测真实性，结果仅供人工复核。', '- 本结果仅为隔离宿主有限冒烟，不代表真实账号、Desktop 或 Android 真机验收。', '', '| 宿主版本 | 来源 | 首次结果 | 最终结果 | 最终阶段 | 最终原因码 | issue |', '|---|---|---|---|---|---|---|'];
  for (const row of results) {
    const result = row.second ?? row.first;
    const first = `${row.first.status}${row.first.errorCode ? ` (${row.first.errorCode})` : ''}`;
    text.push(`| ${row.data.hostVersion ?? '版本未解析'} | ${row.sources.join(', ') || 'unknown'} | ${first} | ${result.status} | ${result.stage} | ${result.errorCode ?? '—'} | ${row.issue}${row.issueNumber ? ` #${row.issueNumber}` : ''} |`);
  }
  if (results.some(row => row.data.hostVersion === null && row.issue === 'health-unreported')) {
    text.push('', '⚠️ 全局健康议题已关闭，本次基础设施故障未自动重开或向议题追加通知，请人工检查。');
  }
  for (const row of results) {
    if (row.health) text.push('', `- ${row.data.hostVersion} 的独立健康议题：${row.health.status}${row.health.issue ? ` #${row.health.issue}` : ''}`);
  }
  for (const row of results) {
    const capabilities = (row.second ?? row.first).checks?.filter(c => c.startsWith('host-capability:')) ?? [];
    if (capabilities.length) text.push('', `### ${row.data.hostVersion} 宿主能力`, ...capabilities.map(c => `- \`${c.slice('host-capability:'.length)}\``));
  }
  return `${text.join('\n')}\n`;
}

async function main() {
  const ctx = { runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, pluginSha: process.env.RELEASE_SHA };
  let entries, mode = process.env.CANARY_MODE;
  try {
    requireContext(ctx);
    if (process.env.RESOLVE_RESULT !== 'success') throw new Error('resolution-failed');
    if (!['daily', 'weekly'].includes(mode)) throw new Error('invalid-mode');
    entries = buildReports({ matrix: JSON.parse(process.env.CANARY_MATRIX ?? ''), root: process.env.CANARY_ARTIFACTS, ...ctx });
  } catch {
    // Failure before version resolution cannot be assigned to a fabricated host version.
    mode = 'unavailable';
    entries = [{ data: { schemaVersion: 1, hostVersion: null, candidate: false, attempts: [{ id: `${ctx.runId}-${ctx.runAttempt}-1`, result: 'infrastructure-failure' }] }, sources: [], first: { status: 'infrastructure-failure', stage: 'resolve', errorCode: 'resolution-or-context-failed' } }];
  }
  const results = await publishReports({ entries, token: process.env.GH_TOKEN, pluginSha: ctx.pluginSha, runId: ctx.runId });
  const globalRecovery = await recoverGlobalHealth({ results, smokeResult: process.env.SMOKE_RESULT, ...ctx, token: process.env.GH_TOKEN });
  const safeSha = SHA.test(ctx.pluginSha ?? '') ? ctx.pluginSha : 'unknown';
  let output = summary(results, { pluginSha: safeSha, mode });
  if (globalRecovery.status !== 'not-attempted' && globalRecovery.status !== 'passed') output += `\n- 全局运行健康跟踪：${globalRecovery.status}${globalRecovery.issue ? ` #${globalRecovery.issue}` : ''}\n`;
  console.log(output);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, output); }
    catch { console.error('::warning::无法写入 Summary；请查看报告 job 日志。'); }
  }
  if (process.env.SMOKE_RESULT !== 'success' || globalRecovery.status === 'report-failed' || results.some(r => (r.second ?? r.first).status !== 'passed' || ['report-failed', 'health-unreported'].includes(r.issue))) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
