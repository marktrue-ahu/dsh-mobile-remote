// The caller must serialize ALL reporter runs for this repository. GitHub's
// issue list/create API does not provide an atomic uniqueness constraint.
import { pathToFileURL } from 'node:url';

const API = 'https://api.github.com/repos/marktrue-ahu/dsh-mobile-remote/issues';
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const keysEqual = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.sort().join(',');
const invalid = () => { throw new Error('invalid report'); };
const trustedBot = user => user !== null && typeof user === 'object' && !Array.isArray(user) &&
  user.id === 41898282 && user.login === 'github-actions[bot]' && user.type === 'Bot';

export function validateReport(data) {
  if (!keysEqual(data, ['schemaVersion', 'hostVersion', 'candidate', 'attempts']) || data.schemaVersion !== 1 ||
      !(data.hostVersion === null || (typeof data.hostVersion === 'string' && data.hostVersion.length <= 128 && SEMVER.test(data.hostVersion))) ||
      typeof data.candidate !== 'boolean' || !Array.isArray(data.attempts) || data.attempts.length < 1 || data.attempts.length > 10) invalid();
  if (data.hostVersion === null && (data.candidate !== false || data.attempts.length !== 1 || !['infrastructure-failure', 'passed'].includes(data.attempts[0]?.result))) invalid();
  const ids = new Set();
  for (const attempt of data.attempts) {
    if (!keysEqual(attempt, ['id', 'result']) || typeof attempt.id !== 'string' ||
        !/^[1-9]\d{0,19}-[1-9]\d{0,9}-[1-9]\d{0,9}$/.test(attempt.id) || ids.has(attempt.id) ||
        !['passed', 'compatibility-failure', 'infrastructure-failure'].includes(attempt.result)) invalid();
    ids.add(attempt.id);
  }
  return data;
}

export function classify(data) {
  validateReport(data);
  const last = data.attempts.at(-1).result;
  if (last === 'infrastructure-failure') return 'health';
  if (last === 'compatibility-failure') {
    if (data.attempts.at(-2)?.result === last) return 'compatibility';
    return data.attempts.slice(0, -1).some(attempt => attempt.result === 'infrastructure-failure') ? 'health' : 'pending';
  }
  return data.hostVersion === null ? 'health-recovered' : data.candidate ? 'candidate' : 'passed';
}

function issueContent(version, kind) {
  const identity = version === null ? 'global' : version;
  const isHealth = kind === 'health' || kind === 'health-recovered';
  const marker = `<!-- host-canary:${isHealth ? 'health' : 'compatibility'}:${identity} -->`;
  const title = isHealth ? `[Host canary health] ${identity}` : `[Host canary] ${identity}`;
  const text = {
    health: version === null ? 'Version resolution or the workflow failed to produce results. This is not a compatibility verdict for any host version; investigate the check infrastructure.' : 'The automated canary encountered an infrastructure failure. This is not a compatibility verdict; investigate the check infrastructure.',
    compatibility: 'Two independent consecutive compatibility checks failed. Manual investigation is required; this is not a confirmed incompatibility.',
    candidate: 'The candidate passed the automated check. Manual confirmation is required; this is not a compatibility guarantee.',
    recovered: 'The latest automated check passed after a previous report. Manual review is required; this is not a compatibility guarantee.',
    'health-recovered': version === null ? 'The reporting workflow completed successfully. The previously reported global infrastructure problem may have recovered; manual review is required.' : 'The latest automated check produced a passing result. The previously reported infrastructure problem may have recovered; manual review is required.',
  }[kind];
  return { marker, title, body: `${marker}\n<!-- host-canary-state:${kind} -->\n\n${text}\n` };
}

// fetch is injectable so tests never contact GitHub. Never expose response bodies,
// raw exceptions or the token. A timeout on a write has an uncertain outcome;
// callers must reconcile before retrying, not blindly retry the write.
export async function report(data, { token, pluginSha, runId, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const kind = classify(data);
  if ((pluginSha !== undefined && (typeof pluginSha !== 'string' || !/^[0-9a-f]{40}$/.test(pluginSha))) ||
      (runId !== undefined && (typeof runId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(runId)))) throw new Error('report unavailable');
  if (kind === 'pending') return { status: kind };
  if (typeof token !== 'string' || token.length < 1 || token.length > 4096 || /[\r\n]/.test(token)) throw new Error('report unavailable');
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('report unavailable');
  const targets = [{ kind: kind === 'passed' ? 'recovered' : kind, create: kind !== 'passed' && kind !== 'health-recovered' }];
  if (kind === 'passed' || kind === 'candidate') targets.push({ kind: 'health-recovered', create: false });
  for (const target of targets) {
    const content = issueContent(data.hostVersion, target.kind);
    const unconfirmed = target.kind === 'health' && data.attempts.at(-1).result === 'compatibility-failure'
      ? '\nOne compatibility check differed; this is unconfirmed and is not a compatibility verdict.\n' : '';
    Object.assign(target, content, { body: content.body + unconfirmed + (pluginSha ? `\nPlugin commit: \`${pluginSha}\`\n` : '') +
      (runId ? `\nWorkflow run: https://github.com/marktrue-ahu/dsh-mobile-remote/actions/runs/${runId}\n` : '') });
    if (target.body.includes(token) || target.title.includes(token)) throw new Error('report unavailable');
    target.matches = [];
  }
  async function request(url, method = 'GET', payload) {
    try {
      const response = await fetchImpl(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      if (!response.ok) throw new Error();
      return await response.json();
    } catch {
      throw new Error(method === 'GET' ? 'issue lookup failed' : 'issue write failed; outcome may be uncertain');
    }
  }
  let finished = false;
  for (let page = 1; page <= 100; page++) {
    const issues = await request(`${API}?state=all&per_page=100&page=${page}`);
    if (!Array.isArray(issues) || issues.length > 100) throw new Error('issue lookup failed');
    for (const issue of issues) {
      if (!issue || typeof issue !== 'object' || Array.isArray(issue)) throw new Error('issue lookup failed');
      if (issue.pull_request) continue;
      if (typeof issue.body !== 'string' && issue.body !== null) throw new Error('issue lookup failed');
      const lines = (issue.body ?? '').split(/\r?\n/);
      for (const target of targets) if (lines.includes(target.marker)) {
        if (!Number.isSafeInteger(issue.number) || issue.number < 1 || !['open', 'closed'].includes(issue.state) || !trustedBot(issue.user)) throw new Error('issue lookup failed');
        target.matches.push(issue);
      }
    }
    if (issues.length < 100) { finished = true; break; }
  }
  if (!finished || targets.some(target => target.matches.length > 1) ||
      (targets.length === 2 && targets[0].matches[0] && targets[0].matches[0] === targets[1].matches[0])) throw new Error('issue lookup ambiguous');
  // Resolve all lookups before any write, including both recovery targets.
  for (const target of targets) {
    const issue = target.matches[0];
    if (!issue) { target.result = { status: target.create ? 'create' : 'passed' }; continue; }
    if (issue.state === 'closed' && (issue.state_reason !== 'completed' || data.hostVersion === null)) {
      target.result = { status: data.hostVersion === null && target.kind === 'health' ? 'health-unreported' : 'closed', issue: issue.number }; continue;
    }
    const kinds = target.kind === 'health' || target.kind === 'health-recovered' ? ['health', 'health-recovered'] : ['candidate', 'compatibility', 'recovered'];
    const bodies = new Map(kinds.map(k => [k, issueContent(data.hostVersion, k).body]));
    // The generated opening text remains recognizable if a human appends notes.
    // Ambiguous or edited openings are unknown; later machine comments win.
    const opening = [...bodies].filter(([, text]) => issue.body?.startsWith(text));
    let previous = opening.length === 1 ? opening[0][0] : undefined;
    let candidateSeen = previous === 'candidate';
    let commentsComplete = false;
    for (let page = 1; page <= 100; page++) {
      const comments = await request(`${API}/${issue.number}/comments?per_page=100&page=${page}`);
      if (!Array.isArray(comments) || comments.length > 100) throw new Error('issue lookup failed');
      // GitHub lists issue comments in ascending ID order, oldest first.
      for (const comment of comments) {
        if (!comment || typeof comment !== 'object' || Array.isArray(comment) || typeof comment.body !== 'string') throw new Error('issue lookup failed');
        const user = comment.user;
        if (!user || typeof user !== 'object' || Array.isArray(user) || !Number.isSafeInteger(user.id) || user.id < 1 ||
            typeof user.login !== 'string' || !user.login || !['Bot', 'User'].includes(user.type)) throw new Error('issue lookup failed');
        if (!trustedBot(user)) {
          if (user.id === 41898282 || user.login === 'github-actions[bot]') throw new Error('issue lookup failed');
          continue;
        }
        for (const [status, text] of bodies) if (comment.body.startsWith(text)) {
          previous = status;
          if (status === 'candidate') candidateSeen = true;
        }
      }
      if (comments.length < 100) { commentsComplete = true; break; }
    }
    if (!commentsComplete) throw new Error('issue lookup ambiguous');
    const sameState = previous === target.kind ||
      (previous === 'candidate' && target.kind === 'recovered') ||
      (previous === 'recovered' && target.kind === 'candidate' && candidateSeen);
    if (issue.state === 'closed') {
      // Unknown previous state is not evidence of a new regression.
      if (!previous || sameState) target.result = { status: 'closed', issue: issue.number };
      else if (['health', 'compatibility'].includes(target.kind)) target.result = { status: 'reopen', issue: issue.number };
      else target.result = { status: 'update-closed', issue: issue.number };
    } else target.result = { status: sameState ? 'unchanged' : 'update', issue: issue.number };
  }
  for (const target of targets) {
    if (target.result.status === 'reopen') {
      // Only change state: never replace the issue body or human content.
      await request(`${API}/${target.result.issue}`, 'PATCH', { state: 'open' });
      await request(`${API}/${target.result.issue}/comments`, 'POST', { body: target.body });
      target.result.status = 'reopened';
    } else if (target.result.status === 'update' || target.result.status === 'update-closed') {
      // Append only: never replace the issue body or a human's comments.
      const closed = target.result.status === 'update-closed';
      await request(`${API}/${target.result.issue}/comments`, 'POST', { body: target.body });
      target.result.status = closed ? 'updated-closed' : 'updated';
    } else if (target.result.status === 'create') {
      const created = await request(API, 'POST', { title: target.title, body: target.body });
      if (!created || !Number.isSafeInteger(created.number) || created.number < 1) throw new Error('issue write failed; outcome may be uncertain');
      target.result = { status: 'created', issue: created.number };
    }
  }
  const result = targets[0].result;
  if (targets[1] && targets[1].result.status !== 'passed') result.health = targets[1].result;
  return result;
}

async function main() {
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 16384) throw new Error();
    }
    const result = await report(JSON.parse(input), { token: process.env.GH_TOKEN, pluginSha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status === 'health-unreported') process.exitCode = 1;
  } catch {
    // Never print attacker-controlled input, exception messages or credentials.
    process.stderr.write('host canary report failed; check input and GitHub access; write outcome may be uncertain\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
