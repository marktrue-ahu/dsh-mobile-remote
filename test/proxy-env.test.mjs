import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// tools/proxy-env.sh reads proxy settings from a gitignored .env in the main
// checkout. These tests exercise that parser in isolation: the real script must
// never bake host-specific proxy addresses into version control, and an absent
// or disabled .env must leave the environment completely untouched.
const SCRIPT = new URL('../tools/proxy-env.sh', import.meta.url).pathname;

function extractHelpers() {
  const text = spawnSync('cat', [SCRIPT], { encoding: 'utf8' }).stdout;
  const grab = (name) => {
    const start = text.indexOf(`\n${name}() {`);
    assert.ok(start >= 0, `${name} must exist in tools/proxy-env.sh`);
    const end = text.indexOf('\n}\n', start);
    assert.ok(end > start, `${name} must be a complete function`);
    return text.slice(start + 1, end + 2);
  };
  return `${grab('read_proxy_env')}\n${grab('apply_proxy_env')}\n`;
}

function runWith(envContent) {
  const dir = mkdtempSync(join(tmpdir(), 'proxy-env-'));
  try {
    const envPath = join(dir, '.env');
    if (envContent !== null) writeFileSync(envPath, envContent, { mode: 0o600 });
    const harness = join(dir, 'harness.sh');
    writeFileSync(harness, `${extractHelpers()}
apply_proxy_env ${JSON.stringify(envPath)}
for v in ALL_PROXY all_proxy HTTP_PROXY HTTPS_PROXY http_proxy https_proxy GRADLE_OPTS; do
  eval "printf '%s=%s\\\\n' \\"$v\\" \\"\\\${$v-}\\""
done
`, { mode: 0o600 });
    const out = spawnSync('bash', [harness], {
      encoding: 'utf8',
      // Start from a clean slate so inherited proxy vars cannot mask a bug.
      env: { PATH: process.env.PATH, GRADLE_OPTS: '' },
    });
    assert.equal(out.status, 0, out.stderr);
    return Object.fromEntries(out.stdout.trim().split('\n').filter(Boolean).map(line => {
      const i = line.indexOf('=');
      return [line.slice(0, i), line.slice(i + 1)];
    }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('an absent .env sets no proxy at all', () => {
  const env = runWith(null);
  for (const key of ['ALL_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'GRADLE_OPTS']) {
    assert.equal(env[key], '', `${key} must stay unset without .env`);
  }
});

test('a disabled switch wins even when proxy values are present', () => {
  const env = runWith('DSH_PROXY_ENABLED=0\nDSH_PROXY_SOCKS=socks5://10.0.0.1:1088\nDSH_PROXY_HTTP=http://10.0.0.1:8080\n');
  for (const key of ['ALL_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'GRADLE_OPTS']) {
    assert.equal(env[key], '', `${key} must stay unset when disabled`);
  }
});

test('enabled socks proxy also configures Gradle, which ignores ALL_PROXY', () => {
  const env = runWith('DSH_PROXY_ENABLED=1\nDSH_PROXY_SOCKS=socks5://10.0.0.1:1088\n');
  assert.equal(env.ALL_PROXY, 'socks5://10.0.0.1:1088');
  assert.equal(env.GRADLE_OPTS, '-DsocksProxyHost=10.0.0.1 -DsocksProxyPort=1088');
  assert.equal(env.HTTP_PROXY, '', 'a socks-only config must not invent an HTTP proxy');
});

test('enabled HTTP proxy sets both cases but leaves Gradle alone', () => {
  const env = runWith('DSH_PROXY_ENABLED=1\nDSH_PROXY_HTTP=http://10.0.0.2:8080\n');
  assert.equal(env.HTTP_PROXY, 'http://10.0.0.2:8080');
  assert.equal(env.HTTPS_PROXY, 'http://10.0.0.2:8080');
  assert.equal(env.http_proxy, 'http://10.0.0.2:8080');
  assert.equal(env.GRADLE_OPTS, '', 'HTTP-only config must not set socks properties');
});

test('quotes, comments and blank lines are tolerated', () => {
  const env = runWith('# comment\n\nDSH_PROXY_ENABLED=1\nDSH_PROXY_SOCKS="socks5://9.9.9.9:1080"\n');
  assert.equal(env.ALL_PROXY, 'socks5://9.9.9.9:1080');
  assert.equal(env.GRADLE_OPTS, '-DsocksProxyHost=9.9.9.9 -DsocksProxyPort=1080');
});

test('both proxies can be active together', () => {
  const env = runWith('DSH_PROXY_ENABLED=1\nDSH_PROXY_HTTP=http://1.1.1.1:3128\nDSH_PROXY_SOCKS=socks5://2.2.2.2:1088\n');
  assert.equal(env.HTTPS_PROXY, 'http://1.1.1.1:3128');
  assert.equal(env.ALL_PROXY, 'socks5://2.2.2.2:1088');
  assert.equal(env.GRADLE_OPTS, '-DsocksProxyHost=2.2.2.2 -DsocksProxyPort=1088');
});

test('a malformed socks value yields no bogus Gradle properties', () => {
  const env = runWith('DSH_PROXY_ENABLED=1\nDSH_PROXY_SOCKS=socks5://brokenhost\n');
  assert.equal(env.ALL_PROXY, 'socks5://brokenhost');
  assert.equal(env.GRADLE_OPTS, '', 'no port means no Gradle socks properties');
});

test('unrelated .env keys are ignored', () => {
  const env = runWith('DSH_PROXY_ENABLED=1\nSECRET_TOKEN=leak\nDSH_PROXY_SOCKS=socks5://3.3.3.3:1088\n');
  assert.equal(env.ALL_PROXY, 'socks5://3.3.3.3:1088');
  assert.doesNotMatch(JSON.stringify(env), /leak/, 'unknown keys must not be exported');
});

test('the repository ignores .env so host addresses never reach version control', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proxy-ignore-'));
  try {
    const out = spawnSync('git', ['check-ignore', '-v', '.env'], {
      cwd: new URL('..', import.meta.url).pathname,
      encoding: 'utf8',
    });
    // .env need not exist for check-ignore to report the rule; a match exits 0.
    assert.equal(out.status, 0, '.env must be covered by .gitignore');
    assert.match(out.stdout, /\.gitignore:\d+:\.env/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
