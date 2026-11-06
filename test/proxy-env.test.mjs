import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
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
  const keysLine = text.match(/^DSH_ENV_KEYS=.*$/m);
  assert.ok(keysLine, 'DSH_ENV_KEYS must exist in tools/proxy-env.sh');
  const loopback = text.match(/^PROXY_LOOPBACK_NO_PROXY=.*$/m);
  assert.ok(loopback, 'PROXY_LOOPBACK_NO_PROXY must exist in tools/proxy-env.sh');
  return `${keysLine[0]}\n${loopback[0]}\n${grab('read_proxy_env')}\n${grab('merge_no_proxy_defaults')}\n${grab('apply_proxy_values')}\n${grab('apply_proxy_env')}\n${grab('apply_toolchain_env')}\n`;
}

function runWith(envContent) {
  const dir = mkdtempSync(join(tmpdir(), 'proxy-env-'));
  try {
    const envPath = join(dir, '.env');
    if (envContent !== null) writeFileSync(envPath, envContent, { mode: 0o600 });
    const harness = join(dir, 'harness.sh');
    writeFileSync(harness, `${extractHelpers()}
REAL_HOME=/home/harnessuser; apply_toolchain_env ${JSON.stringify(envPath)}
for v in ALL_PROXY all_proxy HTTP_PROXY HTTPS_PROXY http_proxy https_proxy GRADLE_OPTS FLUTTER_ROOT JAVA_HOME ANDROID_HOME ANDROID_SDK_ROOT DSH_GRADLE_WRAPPER; do
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

test('toolchain paths come from .env and fall back to built-in defaults', () => {
  const defaults = runWith(null);
  assert.equal(defaults.FLUTTER_ROOT, '/home/mark/sdk/flutter');
  assert.equal(defaults.JAVA_HOME, '/home/mark/sdk/jdk17');
  assert.equal(defaults.ANDROID_HOME, '/home/mark/sdk/android');
  assert.equal(defaults.ANDROID_SDK_ROOT, '/home/mark/sdk/android');

  const overridden = runWith('DSH_FLUTTER_SDK=/opt/flutter\nDSH_JAVA_HOME=/opt/jdk\nDSH_ANDROID_HOME=/opt/android\n');
  assert.equal(overridden.FLUTTER_ROOT, '/opt/flutter');
  assert.equal(overridden.JAVA_HOME, '/opt/jdk');
  assert.equal(overridden.ANDROID_HOME, '/opt/android');
  // SDK_ROOT must track the resolved home, not a stale inherited value.
  assert.equal(overridden.ANDROID_SDK_ROOT, '/opt/android');
  assert.equal(overridden.DSH_GRADLE_WRAPPER, '/opt/flutter/bin/cache/artifacts/gradle_wrapper');
});

test('the scripts no longer bake machine-specific SDK paths into repeated blocks', () => {
  const text = readFileSync(SCRIPT, 'utf8');
  // 只统计实际回退默认值（注释里的示例路径不算）；默认值必须集中在 apply_toolchain_env。
  const occurrences = (text.match(/\$\{[A-Z_]+:-\/home\/mark\/sdk\//g) ?? []).length;
  assert.equal(occurrences, 3, `expected exactly 3 SDK fallback defaults, found ${occurrences}`);
  assert.match(text, /apply_toolchain_env/);
  const worktree = readFileSync(new URL('../tools/worktree.sh', import.meta.url).pathname, 'utf8');
  assert.equal((worktree.match(/\/home\/mark\/sdk\//g) ?? []).length, 0, 'worktree.sh must not hardcode SDK paths');
  assert.match(worktree, /apply_toolchain_env "\$MAIN_DIR\/\.env"/);
});

test('toolchain env is applied once per parse and PATH never accumulates on repeat calls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proxy-path-'));
  try {
    const harness = join(dir, 'harness.sh');
    writeFileSync(harness, `${extractHelpers()}
REAL_HOME=/home/harnessuser
apply_toolchain_env ${JSON.stringify(join(dir, 'missing.env'))}
apply_toolchain_env ${JSON.stringify(join(dir, 'missing.env'))}
printf '%s\\n' "$PATH"
`, { mode: 0o600 });
    const out = spawnSync('bash', [harness], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir } });
    assert.equal(out.status, 0, out.stderr);
    const path = out.stdout.trim();
    for (const dirName of ['/home/mark/sdk/flutter/bin', '/home/mark/sdk/jdk17/bin', '/home/mark/sdk/android/platform-tools']) {
      assert.equal(path.split(':').filter((entry) => entry === dirName).length, 1, `${dirName} must appear exactly once`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable .env fails loudly instead of silently running unconfigured', () => {
  // Otherwise a permission mistake silently drops the proxy and toolchain paths and
  // the gates still report green, which is worse than failing.
  const dir = mkdtempSync(join(tmpdir(), 'proxy-unreadable-'));
  try {
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'DSH_PROXY_ENABLED=1\n', { mode: 0o000 });
    const harness = join(dir, 'harness.sh');
    writeFileSync(harness, `${extractHelpers()}
die() { printf 'ERR %s\\n' "$*" >&2; exit 7; }
apply_toolchain_env ${JSON.stringify(envPath)}
echo OK
`, { mode: 0o700 });
    const out = spawnSync('bash', [harness], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    // Running as root bypasses permission bits, so only assert when it cannot read.
    if (process.getuid?.() !== 0) {
      assert.equal(out.status, 7, 'expected a fail-closed exit');
      assert.match(out.stderr, /不可读/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
