import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { classify, report, validateReport } from '../tools/host-canary/report.mjs';

const bot = { id: 41898282, login: 'github-actions[bot]', type: 'Bot' };
const withBot = item => item && typeof item === 'object' && !Object.hasOwn(item, 'user') ? { ...item, user: bot } : item;
const attempt = (n, result) => ({ id: `100-1-${n}`, result });
const sample = (results = ['passed'], extras = {}) => ({ schemaVersion: 1, hostVersion: '0.2.1-rc.1+build.7', candidate: true, attempts: results.map((r, i) => attempt(i + 1, r)), ...extras });
function mock(pages = [[]], created = { number: 42 }, commentPages = [[]]) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options });
    const page = Number(new URL(url).searchParams.get('page'));
    const source = new URL(url).pathname.endsWith('/comments') ? commentPages : pages;
    return { ok: true, json: async () => options.method === 'GET' ? (source[page - 1] ?? []).map(withBot) : created };
  };
  return { calls, fetchImpl };
}
const opts = m => ({ token: 'test-token', fetchImpl: m.fetchImpl });
const marker = '<!-- host-canary:compatibility:0.2.1-rc.1+build.7 -->';

test('rejects a matching issue owned by an untrusted account', async () => {
  const m = mock([[{ number: 8, state: 'open', body: marker, user: { id: 1, login: 'attacker', type: 'User' } }]]);
  await assert.rejects(report(sample(), opts(m)), /issue lookup/);
  assert.ok(m.calls.every(c => c.method === 'GET'));
});

test('untrusted comments cannot forge bot state', async () => {
  const candidate = `${marker}\n<!-- host-canary-state:candidate -->\n\nThe candidate passed the automated check. Manual confirmation is required; this is not a compatibility guarantee.\n`;
  const fakeFailure = `${marker}\n<!-- host-canary-state:compatibility -->\n\nTwo independent consecutive compatibility checks failed. Manual investigation is required; this is not a confirmed incompatibility.\n`;
  const m = mock([[{ number: 8, state: 'open', body: candidate }]], { number: 42 }, [[{ body: fakeFailure, user: { id: 1, login: 'attacker', type: 'User' } }]]);
  assert.deepEqual(await report(sample(), opts(m)), { status: 'unchanged', issue: 8 });
  assert.ok(m.calls.every(c => c.method === 'GET'));
});

test('daily candidate and weekly fixed pass do not toggle successful states', async () => {
  const candidate = `${marker}\n<!-- host-canary-state:candidate -->\n\nThe candidate passed the automated check. Manual confirmation is required; this is not a compatibility guarantee.\n`;
  const m = mock([[{ number: 8, state: 'open', body: candidate }]]);
  assert.deepEqual(await report(sample(['passed'], { candidate: false }), opts(m)), { status: 'unchanged', issue: 8 });
  assert.ok(m.calls.every(c => c.method === 'GET'));
});

test('closed global failure reports explicit health-unreported without writes', async () => {
  const m = mock([[{ number: 10, state: 'closed', state_reason: 'not_planned', body: '<!-- host-canary:health:global -->' }]]);
  const data = sample(['infrastructure-failure'], { hostVersion: null, candidate: false });
  assert.deepEqual(await report(data, opts(m)), { status: 'health-unreported', issue: 10 });
  assert.ok(m.calls.every(c => c.method === 'GET'));
});

test('marker issue identity must be complete and exact, across pages', async () => {
  const filler = Array.from({ length: 100 }, () => ({ number: 1, state: 'open', body: 'unrelated human issue', user: null }));
  for (const user of [null, { id: 41898282, login: 'impostor', type: 'Bot' }, { id: 123, login: 'github-actions[bot]', type: 'Bot' }, { id: 41898282, login: 'github-actions[bot]', type: 'User' }]) {
    const m = mock([filler, [{ number: 8, state: 'open', body: marker, user }]]);
    await assert.rejects(report(sample(), opts(m)), /issue lookup failed/);
    assert.ok(m.calls.every(c => c.method === 'GET'));
  }
});

test('ambiguous comment identity on any page prevents issue writes', async () => {
  const candidate = `${marker}\n<!-- host-canary-state:candidate -->\n\nThe candidate passed the automated check. Manual confirmation is required; this is not a compatibility guarantee.\n`;
  const issue = { number: 8, state: 'open', body: candidate };
  const filler = Array.from({ length: 100 }, () => ({ body: 'Human discussion', user: { id: 1, login: 'human', type: 'User' } }));
  for (const user of [null, { id: 41898282, login: 'other', type: 'Bot' }, { id: 2, login: 'github-actions[bot]', type: 'Bot' }, { login: 'human', type: 'User' }]) {
    const m = mock([[issue]], { number: 42 }, [filler, [{ body: 'ignored text', user }]]);
    await assert.rejects(report(sample(['compatibility-failure', 'compatibility-failure']), opts(m)), /issue lookup failed/);
    assert.ok(m.calls.every(c => c.method === 'GET'));
  }
});

test('spoofed human comment cannot cause a closed issue to reopen', async () => {
  const failure = `${marker}\n<!-- host-canary-state:compatibility -->\n\nTwo independent consecutive compatibility checks failed. Manual investigation is required; this is not a confirmed incompatibility.\n`;
  const fakeRecovery = `${marker}\n<!-- host-canary-state:recovered -->\n\nThe latest automated check passed after a previous report. Manual review is required; this is not a compatibility guarantee.\n`;
  const issue = { number: 8, state: 'closed', state_reason: 'completed', body: failure };
  const m = mock([[issue]], { number: 42 }, [[{ body: fakeRecovery, user: { id: 1, login: 'human', type: 'User' } }]]);
  assert.deepEqual(await report(sample(['compatibility-failure', 'compatibility-failure']), opts(m)), { status: 'closed', issue: 8 });
  assert.ok(m.calls.every(c => c.method === 'GET'));
});

test('daily weekly success cycles preserve recovery and still allow real regression', async () => {
  const failure = `${marker}\n<!-- host-canary-state:compatibility -->\n\nTwo independent consecutive compatibility checks failed. Manual investigation is required; this is not a confirmed incompatibility.\n`;
  const issue = { number: 8, state: 'open', body: failure };
  const first = mock([[issue]]);
  assert.equal((await report(sample(['passed'], { candidate: false }), opts(first))).status, 'updated');
  const recovery = JSON.parse(first.calls.at(-1).body).body;
  const daily = mock([[issue]], { number: 42 }, [[{ body: recovery }]]);
  assert.equal((await report(sample(), opts(daily))).status, 'updated');
  const candidate = JSON.parse(daily.calls.at(-1).body).body;
  assert.match(candidate, /host-canary-state:candidate/);
  const weekly = mock([[issue]], { number: 42 }, [[{ body: recovery }, { body: candidate }]]);
  assert.equal((await report(sample(['passed'], { candidate: false }), opts(weekly))).status, 'unchanged');
  const dailyAgain = mock([[issue]], { number: 42 }, [[{ body: recovery }, { body: candidate }]]);
  assert.equal((await report(sample(), opts(dailyAgain))).status, 'unchanged');
  const again = mock([[issue]], { number: 42 }, [[{ body: recovery }, { body: candidate }]]);
  assert.equal((await report(sample(['compatibility-failure', 'compatibility-failure']), opts(again))).status, 'updated');
  assert.match(JSON.parse(again.calls.at(-1).body).body, /host-canary-state:compatibility/);
});

test('candidate history spans trusted bot comments only across pages', async () => {
  const failure = `${marker}\n<!-- host-canary-state:compatibility -->\n\nTwo independent consecutive compatibility checks failed. Manual investigation is required; this is not a confirmed incompatibility.\n`;
  const candidate = `${marker}\n<!-- host-canary-state:candidate -->\n\nThe candidate passed the automated check. Manual confirmation is required; this is not a compatibility guarantee.\n`;
  const recovered = `${marker}\n<!-- host-canary-state:recovered -->\n\nThe latest automated check passed after a previous report. Manual review is required; this is not a compatibility guarantee.\n`;
  const issue = { number: 8, state: 'open', body: failure };
  const human = { id: 5, login: 'human', type: 'User' };
  const filler = Array.from({ length: 99 }, () => ({ body: 'Human note', user: human }));
  const trusted = mock([[issue]], { number: 42 }, [[{ body: candidate }, ...filler], [{ body: recovered }]]);
  assert.equal((await report(sample(), opts(trusted))).status, 'unchanged');
  assert.ok(trusted.calls.every(c => c.method === 'GET'));
  const forged = mock([[issue]], { number: 42 }, [[{ body: candidate, user: human }, ...filler], [{ body: recovered }]]);
  assert.equal((await report(sample(), opts(forged))).status, 'updated');
  assert.match(JSON.parse(forged.calls.at(-1).body).body, /host-canary-state:candidate/);
});

test('closed global health CLI exits nonzero with fixed non-secret status', () => {
  const preload = `globalThis.fetch = async () => ({ok: true, json: async () => [{number: 10, state: 'closed', state_reason: 'completed', body: '<!-- host-canary:health:global -->', user: {id: 41898282, login: 'github-actions[bot]', type: 'Bot'}}]})`;
  const data = sample(['infrastructure-failure'], { hostVersion: null, candidate: false });
  const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, 'tools/host-canary/report.mjs'], {
    input: JSON.stringify(data), encoding: 'utf8', env: { PATH: process.env.PATH, GH_TOKEN: 'test-token' },
  });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), { status: 'health-unreported', issue: 10 });
  assert.doesNotMatch(result.stdout + result.stderr, /test-token/);
});

test('strict bounded report schema and independent ordered attempts', () => {
  for (const bad of [
    sample([], {}), sample(['passed'], { hostVersion: '01.2.3' }), sample(['passed'], { hostVersion: '1.2.3-01' }),
    sample(['passed'], { hostVersion: '1.2.3\nsecret' }), sample(['passed'], { hostVersion: `1.2.3-${'a'.repeat(128)}` }),
    sample(['passed'], { extra: 'secret' }), sample(['passed'], { candidate: 'true' }),
    sample(['passed'], { attempts: [{ id: '1-1-1', result: 'passed', log: 'secret' }] }),
    sample(['passed'], { attempts: [attempt(1, 'passed'), attempt(1, 'compatibility-failure')] }),
    sample(['passed'], { attempts: [{ id: '$(touch x)', result: 'passed' }] }),
    sample(Array(11).fill('passed')), sample(['unknown']),
  ]) assert.throws(() => validateReport(bad), /invalid report/);
  assert.equal(validateReport(sample()).schemaVersion, 1);
});

test('classification separates pending, candidate and health', async () => {
  assert.equal(classify(sample(['compatibility-failure'])), 'pending');
  assert.equal(classify(sample(['compatibility-failure', 'passed', 'compatibility-failure'])), 'pending');
  assert.equal(classify(sample(['compatibility-failure', 'compatibility-failure'])), 'compatibility');
  assert.equal(classify(sample(['compatibility-failure', 'infrastructure-failure'])), 'health');
  assert.equal(classify(sample(['passed'])), 'candidate');
  assert.equal(classify(sample(['passed'], { candidate: false })), 'passed');
  assert.deepEqual(await report(sample(['compatibility-failure'])), { status: 'pending' });
});

test('creates candidate pending human confirmation using fixed repository', async () => {
  const m = mock();
  assert.deepEqual(await report(sample(), opts(m)), { status: 'created', issue: 42 });
  assert.equal(m.calls.length, 2);
  assert.equal(m.calls[1].url, 'https://api.github.com/repos/marktrue-ahu/dsh-mobile-remote/issues');
  const body = JSON.parse(m.calls[1].body);
  assert.ok(body.body.includes(marker));
  assert.match(body.body, /Manual confirmation/);
  assert.doesNotMatch(body.body, /test-token|100-1-1/);
});

test('reuses exact marker across candidate and failure, including later pages', async () => {
  const filler = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, state: 'open', body: 'unrelated' }));
  const m = mock([filler, [{ number: 200, state: 'open', body: marker }]]);
  assert.deepEqual(await report(sample(['compatibility-failure', 'compatibility-failure']), opts(m)), { status: 'updated', issue: 200 });
  assert.equal(m.calls.length, 4);
  assert.equal(m.calls[3].url, 'https://api.github.com/repos/marktrue-ahu/dsh-mobile-remote/issues/200/comments');
  assert.match(JSON.parse(m.calls[3].body).body, /Two independent consecutive/);
});

test('repeated state does not write and human issue content is preserved', async () => {
  const candidateBody = `${marker}\n<!-- host-canary-state:candidate -->\n\nThe candidate passed the automated check. Manual confirmation is required; this is not a compatibility guarantee.\n`;
  const original = `${candidateBody}\nHuman notes: keep these intact.`;
  const m = mock([[{ number: 8, state: 'open', body: original }]]);
  assert.deepEqual(await report(sample(), opts(m)), { status: 'unchanged', issue: 8 });
  assert.ok(m.calls.every(call => call.method === 'GET'));
  assert.equal(original, `${candidateBody}\nHuman notes: keep these intact.`);
});

test('status transition appends once; repeated transition reads all comment pages', async () => {
  const candidateBody = `${marker}\n<!-- host-canary-state:candidate -->\n\nThe candidate passed the automated check. Manual confirmation is required; this is not a compatibility guarantee.\n`;
  const failureBody = `${marker}\n<!-- host-canary-state:compatibility -->\n\nTwo independent consecutive compatibility checks failed. Manual investigation is required; this is not a confirmed incompatibility.\n`;
  const issue = { number: 8, state: 'open', body: `${candidateBody}\nHuman notes` };
  const first = mock([[issue]], { number: 42 }, [[{ body: 'Human comment: retain me' }]]);
  assert.deepEqual(await report(sample(['compatibility-failure', 'compatibility-failure']), opts(first)), { status: 'updated', issue: 8 });
  assert.equal(first.calls.filter(c => c.method === 'POST').length, 1);
  assert.equal(JSON.parse(first.calls.at(-1).body).body, failureBody);
  const filler = Array.from({ length: 100 }, () => ({ body: 'Human comment' }));
  const repeat = mock([[issue]], { number: 42 }, [filler, [{ body: failureBody }, { body: 'Human note after transition' }]]);
  assert.deepEqual(await report(sample(['compatibility-failure', 'compatibility-failure']), opts(repeat)), { status: 'unchanged', issue: 8 });
  assert.equal(repeat.calls.length, 3);
  assert.ok(repeat.calls.every(call => call.method === 'GET'));
  const revert = mock([[issue]], { number: 42 }, [[{ body: failureBody }]]);
  assert.deepEqual(await report(sample(), opts(revert)), { status: 'updated', issue: 8 });
  assert.equal(JSON.parse(revert.calls.at(-1).body).body, candidateBody);
});

test('incomplete or malformed comment lookup never writes', async () => {
  const issue = { number: 8, state: 'open', body: marker };
  for (const pages of [Array(100).fill(Array(100).fill({ body: 'human' })), [[{ body: null }]]]) {
    const m = mock([[issue]], { number: 42 }, pages);
    await assert.rejects(report(sample(), opts(m)), /issue lookup/);
    assert.ok(m.calls.every(call => call.method === 'GET'));
  }
});

test('global health only accepts dedicated schema and uses fixed marker', async () => {
  const global = sample(['infrastructure-failure'], { hostVersion: null, candidate: false });
  const m = mock();
  assert.equal((await report(global, opts(m))).status, 'created');
  const body = JSON.parse(m.calls[1].body).body;
  assert.match(body, /<!-- host-canary:health:global -->/);
  assert.match(body, /not a compatibility verdict for any host version/);
  for (const bad of [
    { ...global, candidate: true }, { ...global, attempts: [attempt(1, 'compatibility-failure')] },
    { ...global, attempts: [attempt(1, 'infrastructure-failure'), attempt(2, 'infrastructure-failure')] },
  ]) assert.throws(() => validateReport(bad), /invalid report/);
  const repeated = mock([[{ number: 5, state: 'open', body }]]);
  assert.equal((await report(global, opts(repeated))).status, 'unchanged');
  assert.ok(repeated.calls.every(c => c.method === 'GET'));
});

test('global success recovers only an existing open global health issue', async () => {
  const global = sample(['passed'], { hostVersion: null, candidate: false });
  assert.equal(classify(global), 'health-recovered');
  const missing = mock();
  assert.deepEqual(await report(global, opts(missing)), { status: 'passed' });
  assert.ok(missing.calls.every(c => c.method === 'GET'));
  const opening = '<!-- host-canary:health:global -->\n<!-- host-canary-state:health -->\n\nVersion resolution or the workflow failed to produce results. This is not a compatibility verdict for any host version; investigate the check infrastructure.\n';
  const m = mock([[{ number: 5, state: 'open', body: opening + '\nHuman notes' }]]);
  assert.deepEqual(await report(global, opts(m)), { status: 'updated', issue: 5 });
  const recovery = JSON.parse(m.calls.at(-1).body).body;
  assert.match(recovery, /host-canary-state:health-recovered/);
  const repeat = mock([[{ number: 5, state: 'open', body: opening }]], { number: 42 }, [[{ body: recovery }]]);
  assert.deepEqual(await report(global, opts(repeat)), { status: 'unchanged', issue: 5 });
  assert.ok(repeat.calls.every(c => c.method === 'GET'));
  const closed = mock([[{ number: 5, state: 'closed', state_reason: 'completed', body: opening }]]);
  assert.deepEqual(await report(global, opts(closed)), { status: 'closed', issue: 5 });
  assert.ok(closed.calls.every(c => c.method === 'GET'));
});

test('infrastructure then one compatibility failure reports only health', async () => {
  const data = sample(['infrastructure-failure', 'compatibility-failure']);
  assert.equal(classify(data), 'health');
  const m = mock();
  assert.equal((await report(data, opts(m))).status, 'created');
  const body = JSON.parse(m.calls.at(-1).body).body;
  assert.match(body, /host-canary:health:/);
  assert.match(body, /unconfirmed/);
  assert.match(body, /not a compatibility verdict/);
  assert.equal(classify(sample(['infrastructure-failure', 'compatibility-failure', 'compatibility-failure'])), 'compatibility');
});

test('completed closed issues reopen only for known changed failure state', async () => {
  const candidate = `${marker}\n<!-- host-canary-state:candidate -->\n\nThe candidate passed the automated check. Manual confirmation is required; this is not a compatibility guarantee.\n`;
  const issue = { number: 8, state: 'closed', state_reason: 'completed', body: candidate + '\nHuman notes' };
  const fail = sample(['compatibility-failure', 'compatibility-failure']);
  const m = mock([[issue]]);
  assert.deepEqual(await report(fail, opts(m)), { status: 'reopened', issue: 8 });
  assert.deepEqual(m.calls.map(c => c.method), ['GET', 'GET', 'PATCH', 'POST']);
  assert.deepEqual(JSON.parse(m.calls[2].body), { state: 'open' });
  assert.match(JSON.parse(m.calls[3].body).body, /host-canary-state:compatibility/);
  const previous = JSON.parse(m.calls[3].body).body;
  const repeat = mock([[issue]], { number: 42 }, [[{ body: previous }]]);
  assert.deepEqual(await report(fail, opts(repeat)), { status: 'closed', issue: 8 });
  assert.ok(repeat.calls.every(c => c.method === 'GET'));
  for (const reason of ['not_planned', null, 'unknown']) {
    const blocked = mock([[{ ...issue, state_reason: reason }]]);
    assert.deepEqual(await report(fail, opts(blocked)), { status: 'closed', issue: 8 });
    assert.ok(blocked.calls.every(c => c.method === 'GET'));
  }
  const uncertain = mock([[{ ...issue, body: marker }]]);
  assert.equal((await report(fail, opts(uncertain))).status, 'closed');
  assert.ok(uncertain.calls.every(c => c.method === 'GET'));
  const candidateAgain = mock([[issue]]);
  assert.equal((await report(sample(), opts(candidateAgain))).status, 'closed');
  assert.ok(candidateAgain.calls.every(c => c.method === 'GET'));
});

test('closed failure records recovery once, then reopens on a new regression', async () => {
  const failure = `${marker}\n<!-- host-canary-state:compatibility -->\n\nTwo independent consecutive compatibility checks failed. Manual investigation is required; this is not a confirmed incompatibility.\n`;
  const issue = { number: 8, state: 'closed', state_reason: 'completed', body: `${failure}\nHuman notes kept` };
  const pass = sample(['passed'], { candidate: false });
  const first = mock([[issue]]);
  assert.deepEqual(await report(pass, opts(first)), { status: 'updated-closed', issue: 8 });
  assert.deepEqual(first.calls.map(c => c.method), ['GET', 'GET', 'POST']);
  assert.match(issue.body, /Human notes kept/);
  const recovered = JSON.parse(first.calls.at(-1).body).body;
  assert.match(recovered, /host-canary-state:recovered/);
  const filler = Array.from({ length: 100 }, () => ({ body: 'Human comment' }));
  const repeat = mock([[issue]], { number: 42 }, [filler, [{ body: recovered }]]);
  assert.deepEqual(await report(pass, opts(repeat)), { status: 'closed', issue: 8 });
  assert.ok(repeat.calls.every(c => c.method === 'GET'));
  const regression = mock([[issue]], { number: 42 }, [filler, [{ body: recovered }]]);
  assert.deepEqual(await report(sample(['compatibility-failure', 'compatibility-failure']), opts(regression)), { status: 'reopened', issue: 8 });
  assert.deepEqual(regression.calls.map(c => c.method), ['GET', 'GET', 'GET', 'PATCH', 'POST']);
  const prohibited = mock([[{ ...issue, state_reason: 'not_planned' }]]);
  assert.deepEqual(await report(pass, opts(prohibited)), { status: 'closed', issue: 8 });
  assert.ok(prohibited.calls.every(c => c.method === 'GET'));
});

test('closed candidate and health recover without reopening, global closed stays untouched', async () => {
  const failure = `${marker}\n<!-- host-canary-state:compatibility -->\n\nTwo independent consecutive compatibility checks failed. Manual investigation is required; this is not a confirmed incompatibility.\n`;
  const health = '<!-- host-canary:health:0.2.1-rc.1+build.7 -->\n<!-- host-canary-state:health -->\n\nThe automated canary encountered an infrastructure failure. This is not a compatibility verdict; investigate the check infrastructure.\n';
  const issues = [{ number: 8, state: 'closed', state_reason: 'completed', body: failure }, { number: 9, state: 'closed', state_reason: 'completed', body: health }];
  const m = mock([issues]);
  assert.deepEqual(await report(sample(), opts(m)), { status: 'updated-closed', issue: 8, health: { status: 'updated-closed', issue: 9 } });
  assert.deepEqual(m.calls.map(c => c.method), ['GET', 'GET', 'GET', 'POST', 'POST']);
  assert.match(JSON.parse(m.calls[3].body).body, /host-canary-state:candidate/);
  assert.match(JSON.parse(m.calls[4].body).body, /host-canary-state:health-recovered/);
  const healthRecovery = JSON.parse(m.calls[4].body).body;
  const regression = mock([[issues[1]]], { number: 42 }, [[{ body: healthRecovery }]]);
  assert.deepEqual(await report(sample(['infrastructure-failure']), opts(regression)), { status: 'reopened', issue: 9 });
  const globalIssue = { number: 10, state: 'closed', state_reason: 'completed', body: '<!-- host-canary:health:global -->' };
  const global = mock([[globalIssue]]);
  assert.deepEqual(await report(sample(['passed'], { hostVersion: null, candidate: false }), opts(global)), { status: 'closed', issue: 10 });
  assert.ok(global.calls.every(c => c.method === 'GET'));
});

test('completed health issue reopens after a known recovery, but lookup errors prevent writes', async () => {
  const health = '<!-- host-canary:health:0.2.1-rc.1+build.7 -->';
  const recovered = `${health}\n<!-- host-canary-state:health-recovered -->\n\nThe latest automated check produced a passing result. The previously reported infrastructure problem may have recovered; manual review is required.\n`;
  const issue = { number: 9, state: 'closed', state_reason: 'completed', body: recovered };
  const m = mock([[issue]]);
  assert.equal((await report(sample(['infrastructure-failure']), opts(m))).status, 'reopened');
  assert.deepEqual(m.calls.map(c => c.method), ['GET', 'GET', 'PATCH', 'POST']);
  const bad = mock([[issue]], { number: 42 }, [[{ body: null }]]);
  await assert.rejects(report(sample(['infrastructure-failure']), opts(bad)), /issue lookup/);
  assert.ok(bad.calls.every(c => c.method === 'GET'));
});

test('reopen write failure is sanitized and never retried', async () => {
  const candidate = `${marker}\n<!-- host-canary-state:candidate -->\n\nThe candidate passed the automated check. Manual confirmation is required; this is not a compatibility guarantee.\n`;
  for (const failMethod of ['PATCH', 'POST']) {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push(options.method);
      if (options.method === failMethod) throw new Error('raw credential and log');
      return { ok: true, json: async () => options.method === 'GET' ? (url.includes('/comments') ? [] : [withBot({ number: 8, state: 'closed', state_reason: 'completed', body: candidate })]) : {} };
    };
    await assert.rejects(report(sample(['compatibility-failure', 'compatibility-failure']), { token: 'test-token', fetchImpl }), e => e.message === 'issue write failed; outcome may be uncertain');
    assert.equal(calls.filter(method => method === failMethod).length, 1);
    if (failMethod === 'PATCH') assert.ok(!calls.includes('POST'));
  }
});

test('trusted SHA and run metadata are validated and do not affect state deduplication', async () => {
  const sha = 'abcdef0123456789abcdef0123456789abcdef01';
  const first = mock();
  await report(sample(), { ...opts(first), pluginSha: sha, runId: '12345' });
  const body = JSON.parse(first.calls[1].body).body;
  assert.ok(body.includes(sha));
  assert.ok(body.includes('https://github.com/marktrue-ahu/dsh-mobile-remote/actions/runs/12345'));
  const repeat = mock([[{ number: 9, state: 'open', body }]]);
  assert.equal((await report(sample(), { ...opts(repeat), pluginSha: '1'.repeat(40), runId: '99' })).status, 'unchanged');
  assert.ok(repeat.calls.every(c => c.method === 'GET'));
  for (const extra of [{ pluginSha: 'A'.repeat(40) }, { pluginSha: 'a'.repeat(39) }, { runId: '01' }, { runId: '1/../../secret' }]) {
    const m = mock();
    await assert.rejects(report(sample(), { ...opts(m), ...extra }), /report unavailable/);
    assert.equal(m.calls.length, 0);
  }
});

test('fixed passing result recovers existing compatibility and health without creating or closing', async () => {
  const healthMarker = '<!-- host-canary:health:0.2.1-rc.1+build.7 -->';
  const original = `${marker}\nHuman notes must remain`;
  const issues = [{ number: 8, state: 'open', body: original }, { number: 9, state: 'open', body: `${healthMarker}\nHuman health notes` }];
  const m = mock([issues]);
  const data = sample(['passed'], { candidate: false });
  assert.deepEqual(await report(data, opts(m)), { status: 'updated', issue: 8, health: { status: 'updated', issue: 9 } });
  assert.equal(m.calls.filter(c => c.method === 'GET' && !c.url.includes('/comments')).length, 1);
  const posts = m.calls.filter(c => c.method === 'POST');
  assert.equal(posts.length, 2);
  assert.match(JSON.parse(posts[0].body).body, /host-canary-state:recovered/);
  assert.match(JSON.parse(posts[1].body).body, /host-canary-state:health-recovered/);
  assert.equal(issues[0].body, original);
  const previous = new Map(posts.map(c => [new URL(c.url).pathname, JSON.parse(c.body).body]));
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options });
    const parsed = new URL(url);
    const result = parsed.pathname.endsWith('/comments') ? [{ body: previous.get(parsed.pathname) }] : issues;
    return { ok: true, json: async () => result.map(withBot) };
  };
  assert.deepEqual(await report(data, { token: 'test-token', fetchImpl }), { status: 'unchanged', issue: 8, health: { status: 'unchanged', issue: 9 } });
  assert.ok(calls.every(c => c.method === 'GET'));
});

test('candidate pass keeps candidate policy while recovering existing health', async () => {
  const health = { number: 9, state: 'open', body: '<!-- host-canary:health:0.2.1-rc.1+build.7 -->\nHuman health notes' };
  const m = mock([[health]]);
  assert.deepEqual(await report(sample(), opts(m)), { status: 'created', issue: 42, health: { status: 'updated', issue: 9 } });
  const posts = m.calls.filter(c => c.method === 'POST');
  assert.equal(posts.length, 2);
  assert.match(JSON.parse(posts[0].body).body, /host-canary-state:candidate/);
  assert.match(JSON.parse(posts[1].body).body, /host-canary-state:health-recovered/);
});

test('a failed second recovery lookup performs no partial write', async () => {
  const healthMarker = '<!-- host-canary:health:0.2.1-rc.1+build.7 -->';
  const issues = [{ number: 8, state: 'open', body: marker }, { number: 9, state: 'open', body: healthMarker }];
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(options.method);
    if (url.includes('/9/comments')) throw new Error('hidden');
    return { ok: true, json: async () => url.includes('/comments') ? [] : issues.map(withBot) };
  };
  await assert.rejects(report(sample(['passed'], { candidate: false }), { token: 'test-token', fetchImpl }), /issue lookup failed/);
  assert.ok(calls.every(method => method === 'GET'));
});

test('fixed pass without issues never creates, and closed recovery stays closed', async () => {
  const data = sample(['passed'], { candidate: false });
  const missing = mock();
  assert.deepEqual(await report(data, opts(missing)), { status: 'passed' });
  assert.ok(missing.calls.every(c => c.method === 'GET'));
  const closed = mock([[{ number: 8, state: 'closed', state_reason: 'not_planned', body: marker }]]);
  assert.deepEqual(await report(data, opts(closed)), { status: 'closed', issue: 8 });
  assert.ok(closed.calls.every(c => c.method === 'GET'));
});

test('health marker separate; closed and not_planned are never reopened', async () => {
  const health = mock();
  await report(sample(['infrastructure-failure']), opts(health));
  const payload = JSON.parse(health.calls[1].body);
  assert.match(payload.body, /host-canary:health:/);
  assert.match(payload.body, /not a compatibility verdict/);
  const closed = mock([[{ number: 4, state: 'closed', state_reason: 'not_planned', body: marker }]]);
  assert.deepEqual(await report(sample(), opts(closed)), { status: 'closed', issue: 4 });
  assert.equal(closed.calls.length, 1);
});

test('exact marker matching excludes similar versions and pull requests', async () => {
  const m = mock([[{ number: 1, state: 'open', body: `${marker}x` }, { number: 2, state: 'open', body: marker, pull_request: {} }]]);
  assert.equal((await report(sample(), opts(m))).status, 'created');
});

test('ambiguous, truncated, malformed, and unavailable lookups fail closed', async () => {
  const issue = { number: 1, state: 'open', body: marker };
  for (const m of [mock([[issue, issue]]), mock([[{ number: 1, state: 'open' }]]), mock(Array(100).fill(Array(100).fill({ body: null })))]) {
    await assert.rejects(report(sample(), opts(m)), /issue lookup/);
    assert.ok(m.calls.every(c => c.method === 'GET'));
  }
  let calls = 0;
  await assert.rejects(report(sample(), { token: 'test-token', fetchImpl: async () => { calls++; throw Error('raw secret'); } }), e => !e.message.includes('secret'));
  assert.equal(calls, 1);
});

test('write failures are not retried and hide response details', async () => {
  let calls = 0;
  await assert.rejects(report(sample(), { token: 'test-token', fetchImpl: async () => {
    calls++;
    if (calls === 1) return { ok: true, json: async () => [] };
    throw Error('token and raw logs');
  } }), /outcome may be uncertain/);
  assert.equal(calls, 2);
});

test('CLI never echoes malicious input or token and never executes input', () => {
  const input = JSON.stringify(sample(['passed'], { hostVersion: '$(touch x) token-secret' }));
  const result = spawnSync(process.execPath, ['tools/host-canary/report.mjs'], { input, encoding: 'utf8', env: { ...process.env, GH_TOKEN: 'token-secret' } });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /token-secret|touch x/);
});
