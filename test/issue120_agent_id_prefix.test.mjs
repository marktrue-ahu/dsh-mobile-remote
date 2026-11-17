// issue #120（防御性修复）：$events 帧的 agentId 可能是 `session:` 前缀的 agent id，
// 不能直接当 sessionId 广播给手机（后者按 session 过滤，整帧会被丢弃）。
//
// 这里覆盖：question/requested 与 approval/requested 两条 $events 路径都会把
// `session:abc-123` 归一成 `abc-123`；无前缀时行为不变（回归保护）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { apply } from '../lib/index.js';

const CONFIG = {
  path: '/m',
  authToken: '1234567890123456',
  cookieName: 'dsh_mobile_token',
  trustedHosts: [],
  sessionTtlMs: 60_000,
  rechargeUrl: 'https://example.test/top-up',
  maxConnections: 4,
  pushUrls: [],
  pushCooldownMs: 1,
  doneGraceMs: 1,
  pushContent: 'minimal',
  rateLimit: {},
  lanBridge: { enabled: false, port: 3080, host: '127.0.0.1' },
  approvalMode: 'both',
};

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.headersSent = false;
    this.chunks = [];
  }
  writeHead(statusCode) {
    this.statusCode = statusCode;
    this.headersSent = true;
  }
  write(chunk) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    return true;
  }
  end(chunk = '') {
    if (chunk !== '') this.chunks.push(String(chunk));
    this.emit('finish');
  }
  destroy() {
    this.destroyed = true;
    this.emit('close');
  }
}

class FakeRequest extends EventEmitter {
  constructor(url, method = 'GET') {
    super();
    this.url = url;
    this.method = method;
    this.headers = { host: '127.0.0.1', 'x-mobile-token': CONFIG.authToken, 'content-type': 'application/json' };
    this.socket = { remoteAddress: '127.0.0.1' };
  }
}

const QUESTION_FRAME = (agentId) => ({
  type: 'waterfall',
  event: 'user-questions/request',
  eventId: 'ev-q-prefix',
  agentId,
  request: { questions: [{ id: 'q1', question: '继续吗？', options: [{ label: '继续' }] }] },
});
const APPROVAL_FRAME = (agentId) => ({
  type: 'waterfall',
  event: 'approval/request',
  eventId: 'ev-a-prefix',
  agentId,
  request: { toolName: 'write', callId: 'call-1', reason: 'test' },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createHarness(frames) {
  const routes = [];
  const provided = new Map();
  let dispose;
  const ctx = {
    webServer: { host: '127.0.0.1', port: 43120, register(spec) { routes.push(spec); return () => {}; } },
    logger: { info() {}, warn() {} },
    get(name) { return provided.get(name); },
    provide(name, value) { provided.set(name, value); },
    on() { return () => {}; },
    effect(callback) { callback?.(); return () => {}; },
    inject() {},
    waterfall: async () => 'unavailable',
  };
  provided.set('typertGateway', {
    async invokeRpc() { return { ok: true, value: {} }; },
    async dispatchRpc() { return { ok: true, value: undefined }; },
    // 与真实 $events 同语义：ready 后投递帧，然后保持连接直到 abort。
    async openWireStream(endpoint, payload, signal) {
      return (async function* frames_() {
        yield { type: 'ready', clientId: 'c-1' };
        for (const frame of frames) yield frame;
        await new Promise((resolve) => {
          if (!signal || signal.aborted) return resolve();
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      })();
    },
  });
  dispose = apply(ctx, { ...CONFIG, ...{} });
  return {
    route: (path) => routes.find((r) => r.path === path)?.handler,
    clean() { dispose?.(); },
  };
}

/** 打开 SSE 连接，读出 `pendingFrames` 回放里的 question/approval 帧。 */
async function replayFrames(harness) {
  const res = new FakeResponse();
  harness.route('/m/api')(new FakeRequest('/m/api/events'), res);
  await sleep(50);
  const text = res.chunks.join('');
  res.destroy();
  return [...text.matchAll(/data: (\{.*\})/g)].map((m) => {
    try { return JSON.parse(m[1]); } catch { return null; }
  }).filter(Boolean);
}

test('$events 的 agentId 带 session: 前缀：question/approval 帧归一成纯 sessionId', async () => {
  const h = createHarness([QUESTION_FRAME('session:abc-123'), APPROVAL_FRAME('session:abc-123')]);
  try {
    // 等 $events 通道就绪并处理两帧（ready → waterfall）。
    await sleep(250);
    const frames = await replayFrames(h);
    const question = frames.find((f) => f.type === 'mobile/frame' && f.frame?.type === 'question/requested');
    const approval = frames.find((f) => f.type === 'mobile/frame' && f.frame?.type === 'approval/requested');
    assert.ok(question, 'question/requested 必须出现在回放帧里');
    assert.ok(approval, 'approval/requested 必须出现在回放帧里');
    assert.equal(question.frame.sessionId, 'abc-123', 'question 帧不得带 session: 前缀');
    assert.equal(approval.frame.sessionId, 'abc-123', 'approval 帧不得带 session: 前缀');
    assert.ok(!JSON.stringify(frames).includes('session:abc-123'), '任何对外帧都不得暴露 agent id 前缀');
  } finally {
    h.clean();
  }
});

test('$events 的 agentId 无前缀：sessionId 原样保留（回归保护）', async () => {
  const h = createHarness([QUESTION_FRAME('plain-session')]);
  try {
    await sleep(250);
    const frames = await replayFrames(h);
    const question = frames.find((f) => f.type === 'mobile/frame' && f.frame?.type === 'question/requested');
    assert.ok(question);
    assert.equal(question.frame.sessionId, 'plain-session');
  } finally {
    h.clean();
  }
});
