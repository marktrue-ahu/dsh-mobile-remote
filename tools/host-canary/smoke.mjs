#!/usr/bin/env node
// Installation requires registry access. Runtime is disabled until a verified
// process-tree and filesystem isolation backend is available; netns alone is not one.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, realpath, lstat, readdir, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { MISSING_DEPENDENCY_SPECIFIERS, HINT_CODES, RUNTIME_ERROR_CODES, INSTALL_ERROR_CODES } from './diagnostics.mjs';
export { MISSING_DEPENDENCY_SPECIFIERS, HINT_CODES } from './diagnostics.mjs';

const self = fileURLToPath(import.meta.url);
class CanaryError extends Error {
  constructor(code, status = 'infrastructure-failure', checks = []) { super(code); this.code = code; this.status = status; this.checks = checks; }
}
const fail = (code, status) => { throw new CanaryError(code, status); };

export async function runCanary(options, adapter) {
  const versionValid = typeof options.hostVersion === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(options.hostVersion);
  const shaValid = typeof options.pluginSha === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(options.pluginSha);
  const result = { schema:1, hostVersion:versionValid ? options.hostVersion : '', pluginSha:shaValid ? options.pluginSha : '', status:'infrastructure-failure', stage:'validate', checks:[], errorCode:null };
  let root;
  try {
    if (!versionValid || !shaValid || !options.pluginRoot) fail('invalid-input');
    result.stage = 'sandbox';
    if (adapter.preflight) await adapter.preflight();
    result.stage = 'prepare'; root = await adapter.prepare(options);
    result.stage = 'install'; await adapter.install(root, options);
    result.stage = 'runtime'; result.checks = await adapter.isolatedRun(root, options);
    // Shape must be exactly the 3 core checks plus every capability in fixed
    // order; session-gated capabilities are allowed to be non-ok (reported, not judged).
    const checksOk = Array.isArray(result.checks) && result.checks.length === 3 + capabilityNames.length &&
      ['auth','bootstrap','diagnostics'].every((name,i) => result.checks[i] === name) &&
      capabilityNames.every((name,i) => {
        const state = result.checks[3+i];
        if (!['ok','missing','drift'].some(s => state === `host-capability:${name}:${s}`)) return false;
        if (state !== `host-capability:${name}:ok` && !sessionGatedCapabilityNames.includes(name)) return false;
        return true;
      });
    if (!checksOk) fail('incomplete-checks');
    result.stage = 'complete'; result.status = 'passed';
  } catch (error) {
    result.status = error instanceof CanaryError ? error.status : 'infrastructure-failure';
    result.errorCode = error instanceof CanaryError ? error.code : 'unexpected-error';
    if (error instanceof CanaryError) result.checks = error.checks;
  } finally {
    if (root) try { await adapter.cleanup(root); } catch (error) { result.status = 'infrastructure-failure'; result.stage = 'cleanup'; result.errorCode = error instanceof CanaryError && error.code === 'docker-cleanup-unconfirmed' ? error.code : 'cleanup-failed'; }
  }
  return result;
}

const children = new Set();
let interrupted = false;
function command(bin, args, {cwd, env, timeout = 180000, outputFd, signal, allowAfterInterrupt = false, maxOutput = 8192} = {}) {
  return new Promise((resolvePromise, reject) => {
    if (interrupted && !allowAfterInterrupt) return reject(new CanaryError('interrupted'));
    const child = spawn(bin, args, {cwd, env, detached:true, stdio:['ignore',outputFd ?? 'pipe','ignore']});
    children.add(child);
    let stdout = '', settled = false, timedOut = false, overflow = false;
    child.stdout?.on('data', data => {
      const chunk = data.toString();
      if (stdout.length + chunk.length > maxOutput) overflow = true;
      if (stdout.length < maxOutput) stdout += chunk.slice(0, maxOutput - stdout.length);
    });
    const stop = () => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      if (!settled) { settled = true; children.delete(child); clearTimeout(timer); signal?.removeEventListener('abort',stop); child.stdout?.destroy(); resolvePromise({code:null, stdout, timedOut:true,overflow}); }
    };
    const timer = setTimeout(stop,timeout);
    if (signal?.aborted) stop(); else signal?.addEventListener('abort',stop,{once:true});
    child.on('error', () => { if (!settled) { settled = true; children.delete(child); clearTimeout(timer); signal?.removeEventListener('abort',stop); reject(new CanaryError('process-start-failed')); } });
    child.on('close', code => { if (!settled) { settled = true; children.delete(child); clearTimeout(timer); signal?.removeEventListener('abort',stop); try { process.kill(-child.pid, 'SIGKILL'); } catch {} resolvePromise({code, stdout, timedOut,overflow}); } });
  });
}
// Explicit test seam: only a regular mock-docker binary in a dedicated /tmp
// canary-test directory is executable; production always fixes /usr/bin/docker.
export async function runMockDockerCommand(binary,args,options) {
  const dir = dirname(binary);
  if (!/^\/tmp\/canary-test-[A-Za-z0-9]+$/.test(dir) || basename(binary) !== 'mock-docker' || await realpath(binary).catch(() => '') !== binary) fail('docker-plan-invalid');
  const info = await lstat(binary);
  if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) fail('docker-plan-invalid');
  return command(binary,args,options);
}
export function installCanarySignalHandlers(controller) {
  const handler = () => {
    interrupted = true;
    for (const child of children) if (child.pid) try { process.kill(-child.pid,'SIGKILL'); } catch {}
    controller.abort();
  };
  for (const name of ['SIGINT','SIGTERM']) process.on(name,handler);
  return () => { for (const name of ['SIGINT','SIGTERM']) process.off(name,handler); };
}
// A snapshot consists solely of regular files under lib; no symlink may be
// followed. Paths participate in the digest so missing and extra files differ.
export async function libSnapshot(root) {
  const entries = [];
  async function visit(dir, prefix) {
    const stat = await lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('plugin-snapshot-invalid');
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir,name), relative = prefix ? `${prefix}/${name}` : name;
      const item = await lstat(path);
      if (item.isSymbolicLink()) fail('plugin-snapshot-invalid');
      if (item.isDirectory()) await visit(path,relative);
      else if (item.isFile()) entries.push([relative,createHash('sha256').update(await readFile(path)).digest('hex')]);
      else fail('plugin-snapshot-invalid');
    }
  }
  try { await visit(join(root,'lib'),''); } catch (error) { if (error instanceof CanaryError) throw error; fail('plugin-snapshot-invalid'); }
  if (!entries.length) fail('plugin-snapshot-invalid');
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
export async function verifyPluginSource(pluginRoot, sha, env) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) fail('source-identity-mismatch');
  const root = await realpath(pluginRoot).catch(() => fail('source-identity-mismatch'));
  const run = args => command('git',args,{cwd:root,env,timeout:10000});
  const top = await run(['rev-parse','--show-toplevel']);
  const head = await run(['rev-parse','--verify','HEAD']);
  const status = await run(['status','--porcelain=v1','--untracked-files=no','--ignore-submodules=none']);
  const libStatus = await run(['status','--porcelain=v1','--untracked-files=all','--ignored=matching','--','lib','package.json','cordis.patch.yml']);
  const manifestTracked = await run(['ls-files','--error-unmatch','--','package.json','cordis.patch.yml']);
  const libTracked = await run(['ls-files','--error-unmatch','--','lib']);
  if (top.code !== 0 || head.code !== 0 || status.code !== 0 || libStatus.code !== 0 || manifestTracked.code !== 0 || libTracked.code !== 0 || top.timedOut || head.timedOut || status.timedOut || libStatus.timedOut || manifestTracked.timedOut || libTracked.timedOut || await realpath(top.stdout.trim()).catch(() => '') !== root || head.stdout.trim() !== sha || status.stdout || libStatus.stdout) fail('source-identity-mismatch');
  const manifest = join(root,'package.json');
  if (!(await lstat(manifest)).isFile() || (await lstat(manifest)).isSymbolicLink()) fail('source-identity-mismatch');
  return libSnapshot(root);
}
// npm may add these provenance keys; none selects code or changes activation.
// All other keys, including scripts and unknown future entry points, must match.
const npmProvenanceKeys = new Set(['_id','_integrity','_resolved','_from']);
function installedManifestMatches(source, installed) {
  if (!source || typeof source !== 'object' || Array.isArray(source) || !installed || typeof installed !== 'object' || Array.isArray(installed)) return false;
  const normalized = {...installed};
  for (const key of npmProvenanceKeys) {
    if (!(key in source) && key in normalized) {
      if (typeof normalized[key] !== 'string') return false;
      delete normalized[key];
    }
  }
  return isDeepStrictEqual(normalized,source);
}
async function regularFileHash(path, code) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(code);
    return createHash('sha256').update(await readFile(path)).digest('hex');
  } catch { fail(code); }
}
export async function verifyInstalled(profile, expectedHostVersion, sourceHash, sourceManifest, patchHash) {
  try {
    const hostDir = join(profile,'node_modules/@deepseek-ai/dsh');
    const pluginDir = join(profile,'node_modules/@marktrue/dsh-mobile-remote');
    for (const dir of [hostDir,pluginDir]) if (!(await lstat(dir)).isDirectory() || (await lstat(dir)).isSymbolicLink()) fail('installed-identity-mismatch');
    const hostManifest = join(hostDir,'package.json');
    if (!(await lstat(hostManifest)).isFile() || (await lstat(hostManifest)).isSymbolicLink()) fail('installed-identity-mismatch');
    const host = JSON.parse(await readFile(hostManifest,'utf8'));
    if (host.name !== '@deepseek-ai/dsh' || host.version !== expectedHostVersion) fail('installed-identity-mismatch');
    const pluginManifest = join(pluginDir,'package.json');
    if (!(await lstat(pluginManifest)).isFile() || (await lstat(pluginManifest)).isSymbolicLink()) fail('installed-identity-mismatch');
    const plugin = JSON.parse(await readFile(pluginManifest,'utf8'));
    if (plugin.name !== '@marktrue/dsh-mobile-remote' || !installedManifestMatches(sourceManifest,plugin)) fail('installed-identity-mismatch');
    if (await regularFileHash(join(pluginDir,'cordis.patch.yml'),'installed-identity-mismatch') !== patchHash || await libSnapshot(pluginDir) !== sourceHash) fail('installed-identity-mismatch');
  } catch (error) { if (error instanceof CanaryError && error.code === 'installed-identity-mismatch') throw error; fail('installed-identity-mismatch'); }
}
// Match DSH's installation-first/profile-second Node search, but never inspect
// a symlink or any path outside the isolated profile. This establishes only
// manifest resolvability, not plugin mounting or runtime compatibility.
export async function verifyRequiredBundles(profile) {
  try {
    const root = resolve(profile);
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(root) !== root) fail('host-bundle-unavailable');
    const anchors = [join(root,'node_modules/@deepseek-ai/dsh/package.json'),join(root,'package.json')];
    async function safeDirectory(path) {
      const rel = relative(root,path);
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
      let current = root;
      for (const segment of rel.split(sep)) {
        current = join(current,segment);
        let info; try { info = await lstat(current); } catch (error) { if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false; throw error; }
        if (info.isSymbolicLink()) fail('host-bundle-unavailable');
        if (!info.isDirectory()) return false;
      }
      return true;
    }
    for (const name of ['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']) {
      let found = false;
      const visited = new Set();
      for (const anchor of anchors) {
        for (const search of createRequire(anchor).resolve.paths(name) ?? []) {
          const candidate = resolve(search,name);
          if (visited.has(candidate)) continue;
          visited.add(candidate);
          if (!await safeDirectory(candidate)) continue;
          const manifestPath = join(candidate,'package.json');
          let info; try { info = await lstat(manifestPath); } catch (error) { if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue; throw error; }
          if (!info.isFile() || info.isSymbolicLink()) fail('host-bundle-unavailable');
          const manifest = JSON.parse(await readFile(manifestPath,'utf8'));
          if (manifest?.name !== name) fail('host-bundle-unavailable');
          found = true; break;
        }
        if (found) break;
      }
      if (!found) fail('host-bundle-unavailable');
    }
  } catch { fail('host-bundle-unavailable'); }
}
// Archive only committed executable content and its activation manifest. The
// caller must stream the archive into a private destination, then independently
// compare installed lib hashes. No checkout, symlink, or working-tree tarball.
export function gitArchiveArgs(sha) {
  if (typeof sha !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) fail('source-identity-mismatch');
  return ['archive','--format=tar',sha,'--','package.json','cordis.patch.yml','lib'];
}
// Design-only: no Docker process is launched until a lifecycle backend with
// verified cleanup and a container-only worker is implemented and reviewed.
export const DOCKER_IMAGE = 'node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c';
// Runtime create/inspect/start (15s) + worker probe deadline (75s, not a
// whole-worker watchdog) + wait/log transport slack (15s). The outer deadline
// bounds blocked worker I/O; cleanup remains separately bounded.
export const RUNTIME_LIFECYCLE_MS = 105000;
const profileEnvironment = phase => {
  const base = phase === 'install' ? '/profile' : '/tmp/canary';
  return [`HOME=${base}/home`,`DSH_HOME=${base}/dsh`,`XDG_CONFIG_HOME=${base}/xdg-config`,`XDG_CACHE_HOME=${base}/xdg-cache`,`XDG_DATA_HOME=${base}/xdg-data`,`XDG_STATE_HOME=${base}/xdg-state`,`XDG_RUNTIME_DIR=${base}/xdg-runtime`,`NPM_CONFIG_USERCONFIG=${base}/npmrc`,`NPM_CONFIG_GLOBALCONFIG=${base}/npm-globalrc`];
};
const NODE_IMAGE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
export function validateImageEnvironment(env) {
  if (!Array.isArray(env) || env.some(value => typeof value !== 'string')) fail('docker-image-unverified');
  const map = new Map();
  for (const entry of env) {
    const eq = entry.indexOf('='); if (eq < 1) fail('docker-image-unverified');
    const key = entry.slice(0,eq), value = entry.slice(eq+1);
    if (map.has(key) || !['PATH','NODE_VERSION','YARN_VERSION'].includes(key)) fail('docker-image-unverified');
    map.set(key,value);
  }
  if (map.get('PATH') !== NODE_IMAGE_PATH || !/^24\.\d+\.\d+$/.test(map.get('NODE_VERSION') ?? '') || (map.has('YARN_VERSION') && !/^1\.\d+\.\d+$/.test(map.get('YARN_VERSION')))) fail('docker-image-unverified');
  return [...env];
}
export function dockerCreatePlan({name,phase,source,profile,uid,gid,hostVersion}) {
  const pathOK = value => typeof value === 'string' && /^\/[a-zA-Z0-9_./-]+$/.test(value) && resolve(value) === value && !value.split('/').includes('..');
  const base = typeof profile === 'string' ? dirname(profile) : '';
  if (!/^dsh-canary-[a-f0-9]{32}$/.test(name) || !['install','runtime'].includes(phase) || !pathOK(profile) || !pathOK(source) || !/^\/tmp\/dsh-host-canary-[A-Za-z0-9]+$/.test(base) || profile !== join(base,'profile') || source !== join(base,'source') || !Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(hostVersion)) fail('docker-plan-invalid');
  const args = ['create','--pull=never','--name',name,'--label',`dsh.canary.identity=${name}`,'--network',phase === 'runtime' ? 'none' : 'bridge','--ipc','private','--user',`${uid}:${gid}`,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','256','--memory','2g','--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=128m','--mount',`type=bind,src=${profile},dst=/profile${phase === 'runtime' ? ',readonly' : ''}`];
  if (phase === 'install') args.push('--mount',`type=bind,src=${source},dst=/source,readonly`);
  for (const value of profileEnvironment(phase)) args.push('--env',value);
  args.push('--entrypoint','node',DOCKER_IMAGE,'--input-type=module','--eval',phase === 'install' ? makeInstallWorker(hostVersion) : makeRuntimeWorker());
  return args;
}
const CLEANUP_AUTH = Symbol('cleanup-authority');
const DOCKER_INSPECT_FORMAT = ['{{json .Id}}','{{json .Name}}','{{json (index .Config.Labels "dsh.canary.identity")}}','{{json .State.Running}}','{{json .Config.Image}}','{{json .Config.User}}','{{json .HostConfig.NetworkMode}}','{{json .HostConfig.ReadonlyRootfs}}','{{json .HostConfig.Privileged}}','{{json .HostConfig.PidMode}}','{{json .HostConfig.IpcMode}}','{{json .HostConfig.PublishAllPorts}}','{{json .HostConfig.PidsLimit}}','{{json .HostConfig.Memory}}','{{json .HostConfig.CapDrop}}','{{json .HostConfig.SecurityOpt}}','{{json .HostConfig.PortBindings}}','{{json .Mounts}}','{{json .HostConfig.CapAdd}}','{{json .HostConfig.Devices}}','{{json .HostConfig.DeviceRequests}}','{{json .HostConfig.GroupAdd}}','{{json .HostConfig.Tmpfs}}','{{json .Config.Entrypoint}}','{{json .Config.Cmd}}','{{json .Config.Env}}'].join('\u001e');
// Host-side Docker client uses only a fresh empty config and a fixed binary;
// the host Docker socket is used by the client, never mounted into containers.
// Not called by production until the full backend has been reviewed.
export async function createDockerExecutor(root, runnerEnv, invoke = command) {
  checkHostedRunner(runnerEnv);
  await validateDockerMounts(root);
  const home = join(root,'docker-home'), config = join(root,'docker-config');
  await mkdir(home,{mode:0o700}); await mkdir(config,{mode:0o700});
  const env = {PATH:'/usr/bin:/bin',HOME:home,DOCKER_CONFIG:config};
  const authorized = new Set();
  const execute = async (args,signal,cleanup = false) => {
    if (!Array.isArray(args) || !args.every(value => typeof value === 'string' && !value.includes('\0'))) fail('docker-plan-invalid');
    if (cleanup) {
      const id = args[0] === 'ps' ? args[4]?.slice(3) : args.at(-1);
      const valid = (args[0] === 'kill' || args[0] === 'rm') ? args.length === 2 :
        args[0] === 'inspect' ? args.length === 4 && args[1] === '--format' && args[2] === DOCKER_INSPECT_FORMAT :
        args[0] === 'ps' && args.length === 7 && args[1] === '--all' && args[2] === '--no-trunc' && args[3] === '--filter' && args[4] === `id=${id}` && args[5] === '--format' && args[6] === '{{.ID}}';
      if (!valid || !authorized.has(id)) fail('docker-cleanup-unauthorized');
    }
    return invoke('/usr/bin/docker',args,{cwd:root,env,timeout:310000,signal,allowAfterInterrupt:cleanup,maxOutput:args[0] === 'inspect' ? 65536 : 8192});
  };
  execute[CLEANUP_AUTH] = id => { if (!/^[a-f0-9]{64}$/.test(id)) fail('docker-identity-invalid'); authorized.add(id); };
  return execute;
}
const runtimeWorkerErrors = new Set(RUNTIME_ERROR_CODES);
function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && isDeepStrictEqual(Object.keys(value).sort(),[...keys].sort());
}
function validWorkerChecks(checks, complete = false) {
  if (!Array.isArray(checks) || checks.length > 3 + capabilityNames.length || (complete && checks.length !== 3 + capabilityNames.length)) return false;
  for (let i=0; i<checks.length; i++) {
    if (i < 3) { if (checks[i] !== ['auth','bootstrap','diagnostics'][i]) return false; }
    else if (!['ok','missing','drift'].some(state => checks[i] === `host-capability:${capabilityNames[i-3]}:${state}`)) return false;
  }
  return true;
}
export function parseWorkerOutput(phase, exitCode, data) {
  if (!['install','runtime'].includes(phase) || ![0,1,2].includes(exitCode)) fail('docker-output-invalid');
  if (phase === 'install') {
    if (exitCode === 0 && exactKeys(data,['ok']) && data.ok === true) return {exitCode,ok:true,checks:[],errorCode:null};
    // Install may report the generic failure OR a specific missing-dependency code
    // discovered by the post-install resolution preflight. Both stay within the
    // closed allowlist; anything else is a malformed payload.
    if (exitCode === 2 && exactKeys(data,['ok','errorCode']) && data.ok === false && INSTALL_ERROR_CODES.includes(data.errorCode)) return {exitCode,ok:false,checks:[],errorCode:data.errorCode};
    fail('docker-output-invalid');
  }
  // A successful run may still report a session-gated capability as missing/drift:
  // the canary never opens a browser, so those stay unavailable by construction.
  if (!data || typeof data !== 'object' || !validWorkerChecks(data.checks)) fail('docker-output-invalid');
  const nonGatedAllOk = data.checks.slice(3).every((value,i) => value.endsWith(':ok') || sessionGatedCapabilityNames.includes(capabilityNames[i]));
  if (exitCode === 0 && exactKeys(data,['ok','checks']) && data.ok === true && validWorkerChecks(data.checks,true) && nonGatedAllOk) return {exitCode,ok:true,checks:data.checks,errorCode:null};
  if (!exactKeys(data,['ok','errorCode','checks']) || data.ok !== false || typeof data.errorCode !== 'string' || !runtimeWorkerErrors.has(data.errorCode) || !validWorkerChecks(data.checks)) fail('docker-output-invalid');
  if ((data.errorCode === 'compatibility-check-failed' ? 1 : 2) !== exitCode) fail('docker-output-invalid');
  if (data.errorCode === 'compatibility-check-failed' && (data.checks.length < 1 || data.checks.length >= 3 + capabilityNames.length)) fail('docker-output-invalid');
  if (data.errorCode === 'host-capabilities-inconclusive' && (!validWorkerChecks(data.checks,true) || !data.checks.slice(3).some(value => !value.endsWith(':ok')))) fail('docker-output-invalid');
  return {exitCode,ok:false,checks:data.checks,errorCode:data.errorCode};
}
function validateCanonicalWorkerResult(phase, result) {
  if (!exactKeys(result,['exitCode','ok','checks','errorCode']) || !Array.isArray(result.checks)) fail('docker-output-invalid');
  const data = result.ok === true ? (phase === 'install' ? {ok:true} : {ok:true,checks:result.checks}) :
    (phase === 'install' ? {ok:false,errorCode:result.errorCode} : {ok:false,errorCode:result.errorCode,checks:result.checks});
  if (phase === 'install' && result.checks.length !== 0) fail('docker-output-invalid');
  if (result.ok === true && result.errorCode !== null) fail('docker-output-invalid');
  if (result.ok !== true && result.ok !== false) fail('docker-output-invalid');
  return parseWorkerOutput(phase,result.exitCode,data);
}
// Docker CLI adapter, parameterized so tests never contact a daemon. Raw Docker
// output stays inside this module; only strictly parsed fields leave it.
export function dockerCliDriver(execute) {
  const observed = new Map(), authorized = new Set();
  const run = async (args, signal, cleanup = false) => {
    const result = await execute(args,signal,cleanup);
    if (!result || result.timedOut || result.overflow || result.code !== 0 || typeof result.stdout !== 'string') fail('docker-operation-failed');
    return result.stdout.trim();
  };
  const validId = id => { if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) fail('docker-identity-invalid'); };
  return {
    async ensureImage(signal) {
      await run(['pull',DOCKER_IMAGE],signal);
      const raw = await run(['image','inspect','--format','{{json .RepoDigests}}',DOCKER_IMAGE],signal);
      let digests; try { digests = JSON.parse(raw); } catch { fail('docker-image-unverified'); }
      const digest = DOCKER_IMAGE.slice(DOCKER_IMAGE.indexOf('@'));
      if (!Array.isArray(digests) || !digests.some(value => value === `node${digest}` || value === `docker.io/library/node${digest}`)) fail('docker-image-unverified');
      const rawEnv = await run(['image','inspect','--format','{{json .Config.Env}}',DOCKER_IMAGE],signal);
      let imageEnv; try { imageEnv = JSON.parse(rawEnv); } catch { fail('docker-image-unverified'); }
      return validateImageEnvironment(imageEnv);
    },
    async create(args,signal) { const id = await run(args,signal); validId(id); return id; },
    authorizeCleanup(id,name) {
      validId(id);
      if (observed.get(id) !== name) fail('docker-cleanup-unauthorized');
      authorized.add(id); execute[CLEANUP_AUTH]?.(id);
    },
    async inspect(id,signal,cleanup = false) {
      validId(id);
      if (cleanup && !authorized.has(id)) fail('docker-cleanup-unauthorized');
      let raw;
      try { raw = await run(['inspect','--format',DOCKER_INSPECT_FORMAT,id],signal,cleanup); }
      catch {
        const listed = await run(['ps','--all','--no-trunc','--filter',`id=${id}`,'--format','{{.ID}}'],signal,cleanup);
        if (listed === '') return {kind:'not-found'};
        fail('docker-operation-failed');
      }
      let fields;
      try { fields = raw.split('\u001e').map(field => JSON.parse(field)); } catch { fail('docker-identity-invalid'); }
      if (fields.length !== 26 || fields[0] !== id || typeof fields[1] !== 'string' || !/^\/dsh-canary-[a-f0-9]{32}$/.test(fields[1]) || !/^dsh-canary-[a-f0-9]{32}$/.test(fields[2]) || typeof fields[3] !== 'boolean' || !Array.isArray(fields[17])) fail('docker-identity-invalid');
      const mounts = fields[17].map(mount => ({type:mount.Type,source:mount.Source,destination:mount.Destination,rw:mount.RW}));
      const security = {image:fields[4],user:fields[5],network:fields[6],readonly:fields[7],privileged:fields[8],pidMode:fields[9],ipcMode:fields[10],publishAll:fields[11],pids:fields[12],memory:fields[13],capDrop:fields[14],securityOpt:fields[15],ports:fields[16],mounts,capAdd:fields[18],devices:fields[19],deviceRequests:fields[20],groupAdd:fields[21],tmpfs:fields[22],entrypoint:fields[23],cmd:fields[24],env:fields[25]};
      const name = fields[1].slice(1);
      if (!cleanup && name === fields[2]) observed.set(id,name);
      return {id,name,label:fields[2],running:fields[3],security};
    },
    async start(id,signal) { validId(id); await run(['start',id],signal); },
    async wait(id,signal,phase) {
      validId(id);
      const status = await run(['wait',id],signal);
      if (!/^[012]$/.test(status)) fail('docker-operation-failed');
      // Raw container stderr is discarded by the executor. stdout contains only
      // the strict JSON worker protocol; arbitrary output is never forwarded.
      const logs = await run(['logs',id],signal);
      let data; try { data = JSON.parse(logs); } catch { fail('docker-output-invalid'); }
      return parseWorkerOutput(phase,Number(status),data);
    },
    async kill(id,signal,cleanup = false) { validId(id); if (cleanup && !authorized.has(id)) fail('docker-cleanup-unauthorized'); await run(['kill',id],signal,cleanup); },
    async remove(id,signal,cleanup = false) { validId(id); if (cleanup && !authorized.has(id)) fail('docker-cleanup-unauthorized'); await run(['rm',id],signal,cleanup); },
  };
}
export function verifyDockerInspection(info, options) {
  const security = info?.security;
  if (!security || security.image !== DOCKER_IMAGE || security.user !== `${options.uid}:${options.gid}` || security.network !== (options.phase === 'runtime' ? 'none' : 'bridge') || security.readonly !== true || security.privileged !== false || security.pidMode !== '' || security.ipcMode !== 'private' || security.publishAll !== false || security.pids !== 256 || security.memory !== 2147483648 || !Array.isArray(security.capDrop) || !security.capDrop.includes('ALL') || !Array.isArray(security.securityOpt) || !security.securityOpt.some(value => value === 'no-new-privileges' || value === 'no-new-privileges=true') || (security.ports && Object.keys(security.ports).length > 0)) fail('docker-security-mismatch');
  const empty = value => value == null || (Array.isArray(value) && value.length === 0);
  if (!empty(security.capAdd) || !empty(security.devices) || !empty(security.deviceRequests) || !empty(security.groupAdd) || security.securityOpt.length !== 1 || !security.tmpfs || Object.keys(security.tmpfs).length !== 1 || security.tmpfs['/tmp'] !== 'rw,noexec,nosuid,nodev,size=128m') fail('docker-security-mismatch');
  const imageEnv = validateImageEnvironment(options.imageEnv);
  const expectedEnv = [...imageEnv,...profileEnvironment(options.phase)].sort();
  const expectedCmd = ['--input-type=module','--eval',options.phase === 'install' ? makeInstallWorker(options.hostVersion) : makeRuntimeWorker()];
  if (!isDeepStrictEqual(security.entrypoint,['node']) || !isDeepStrictEqual(security.cmd,expectedCmd) || !Array.isArray(security.env) || !security.env.every(value => typeof value === 'string') || !isDeepStrictEqual([...security.env].sort(),expectedEnv)) fail('docker-security-mismatch');
  const expected = [{source:options.profile,destination:'/profile',rw:options.phase === 'install'},...(options.phase === 'install' ? [{source:options.source,destination:'/source',rw:false}] : [])];
  if (!Array.isArray(security.mounts) || security.mounts.length !== expected.length || !expected.every(entry => security.mounts.some(mount => mount.type === 'bind' && mount.source === entry.source && mount.destination === entry.destination && mount.rw === entry.rw))) fail('docker-security-mismatch');
}
// Injectable lifecycle contract; intentionally not connected to the CLI. Driver
// methods receive opaque IDs and return structured results, never shell strings.
// A create timeout is inherently ambiguous: a daemon could create after the
// client times out, so it MUST remain unconfirmed even if inspect says absent.
export async function managedDocker(client, options, timeoutMs = 10000, signal, clock = () => performance.now()) {
  const createArgs = dockerCreatePlan(options);
  const name = options.name;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000 || typeof clock !== 'function') fail('docker-plan-invalid');
  const now = clock();
  if (!Number.isFinite(now)) fail('docker-plan-invalid');
  const lifecycleDeadline = now + timeoutMs;
  const startDeadline = options.phase === 'runtime' ? Math.min(lifecycleDeadline,now + 15000) : lifecycleDeadline;
  const within = (op, abortable = false, deadline = lifecycleDeadline) => new Promise((ok, bad) => {
    const budget = abortable ? Math.max(0,Math.floor(deadline - clock())) : Math.min(timeoutMs,10000);
    if (budget <= 0) return bad(new CanaryError('docker-operation-timeout'));
    let done = false;
    const operation = new AbortController();
    const finish = (fn, value) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort',onAbort); fn(value); };
    const onAbort = () => { operation.abort(); finish(bad,new CanaryError('interrupted')); };
    const timer = setTimeout(() => { operation.abort(); finish(bad,new CanaryError('docker-operation-timeout')); },budget);
    if (abortable && signal?.aborted) return onAbort();
    if (abortable) signal?.addEventListener('abort',onAbort,{once:true});
    Promise.resolve().then(() => op(operation.signal)).then(value => {
      if (abortable && (!Number.isFinite(clock()) || clock() >= deadline)) { operation.abort(); finish(bad,new CanaryError('docker-operation-timeout')); }
      else finish(ok,value);
    }, error => finish(bad,error));
  });
  let id, error, result, creationUncertain = false, startUncertain = false, cleanupAuthorized = false;
  try {
    try { id = await within(opSignal => client.create(createArgs,opSignal),true,startDeadline); }
    catch (cause) { creationUncertain = true; throw cause; }
    if (!/^[a-f0-9]{64}$/.test(id)) { creationUncertain = true; fail('docker-identity-invalid'); }
    const info = await within(opSignal => client.inspect(id,opSignal),true,startDeadline);
    if (info?.id !== id || info?.name !== name || info?.label !== name) fail('docker-identity-invalid');
    client.authorizeCleanup(id,name); cleanupAuthorized = true;
    if (info.running !== false) fail('docker-security-mismatch');
    verifyDockerInspection(info,options);
    try { await within(opSignal => client.start(id,opSignal),true,startDeadline); }
    catch (cause) { startUncertain = true; throw cause; }
    result = await within(opSignal => client.wait(id,opSignal,options.phase),true);
    if (!result || ![0,1,2].includes(result.exitCode)) fail('docker-execution-failed');
  } catch (cause) { error = cause instanceof CanaryError ? cause : new CanaryError('docker-operation-failed'); }
  let cleanupConfirmed = false;
  if (cleanupAuthorized && id && /^[a-f0-9]{64}$/.test(id)) {
    try {
      const info = await within(opSignal => client.inspect(id,opSignal,true));
      if (info?.id !== id || info?.name !== name || info?.label !== name) throw Error('identity');
      if (info.running) await within(opSignal => client.kill(id,opSignal,true));
      await within(opSignal => client.remove(id,opSignal,true));
      const after = await within(opSignal => client.inspect(id,opSignal,true));
      cleanupConfirmed = after?.kind === 'not-found';
    } catch { cleanupConfirmed = false; }
  }
  if (!cleanupConfirmed || creationUncertain || startUncertain) fail('docker-cleanup-unconfirmed');
  if (error) throw error;
  return result;
}
// Mockable end-to-end model. A real Docker driver is intentionally absent and
// this adapter is never selected by the production CLI.
export function dockerModelAdapter(client, {env,uid,gid,signal}) {
  let context, safeCleanup = true;
  const name = () => `dsh-canary-${randomBytes(16).toString('hex')}`;
  return {
    async preflight() { checkHostedRunner(env); },
    async prepare(options) {
      context = await createSourceArchive(options.pluginRoot,options.pluginSha,env);
      try {
        await prepareContainerProfile(context.root);
        if (context.manifest.name !== '@marktrue/dsh-mobile-remote' || typeof context.manifest.version !== 'string' || !context.manifest.version) fail('source-identity-mismatch');
        return context.root;
      } catch (error) { await removeSourceArchive(context.root); context = undefined; throw error; }
    },
    async install(root,options) {
      const mounts = await validateDockerMounts(root);
      if (typeof client.ensureImage !== 'function') fail('docker-image-unverified');
      const imageController = new AbortController();
      const stopImage = () => imageController.abort();
      const timer = setTimeout(stopImage,310000);
      if (signal?.aborted) stopImage(); else signal?.addEventListener('abort',stopImage,{once:true});
      try {
        context.imageEnv = validateImageEnvironment(await new Promise((resolveImage,rejectImage) => {
          const onAbort = () => rejectImage(new CanaryError('docker-operation-timeout'));
          if (imageController.signal.aborted) return onAbort();
          imageController.signal.addEventListener('abort',onAbort,{once:true});
          Promise.resolve().then(() => client.ensureImage(imageController.signal)).then(resolveImage,rejectImage).finally(() => imageController.signal.removeEventListener('abort',onAbort));
        }));
      } finally { clearTimeout(timer); signal?.removeEventListener('abort',stopImage); }
      let installed;
      try { installed = await managedDocker(client,{...mounts,name:name(),phase:'install',uid,gid,hostVersion:options.hostVersion,imageEnv:context.imageEnv},300000,signal); }
      catch (error) { if (error?.code === 'docker-cleanup-unconfirmed') safeCleanup = false; throw error; }
      installed = validateCanonicalWorkerResult('install',installed);
      if (installed.exitCode !== 0) fail(installed.errorCode);
      if (await verifyPluginSource(options.pluginRoot,options.pluginSha,env) !== context.snapshot) fail('source-identity-mismatch');
      const profile = join(context.profile,'dsh/profiles/canary');
      await verifyInstalled(profile,options.hostVersion,context.snapshot,context.manifest,context.patchHash);
      await verifyRequiredBundles(profile);
    },
    async isolatedRun(root,options) {
      const mounts = await validateDockerMounts(root);
      let result;
      try { result = await managedDocker(client,{...mounts,name:name(),phase:'runtime',uid,gid,hostVersion:options.hostVersion,imageEnv:context.imageEnv},RUNTIME_LIFECYCLE_MS,signal); }
      catch (error) { if (error?.code === 'docker-cleanup-unconfirmed') safeCleanup = false; throw error; }
      result = validateCanonicalWorkerResult('runtime',result);
      const checks = result.checks;
      if (result.errorCode === 'compatibility-check-failed' && result.exitCode === 1) throw new CanaryError('compatibility-check-failed','compatibility-failure',Array.isArray(checks) ? checks : []);
      if (runtimeWorkerErrors.has(result.errorCode)) throw new CanaryError(result.errorCode,'infrastructure-failure',checks);
      if (result.exitCode !== 0 || result.errorCode) fail('docker-output-invalid');
      return checks;
    },
    async cleanup(root) {
      if (!safeCleanup) fail('docker-cleanup-unconfirmed');
      await removeSourceArchive(root);
    },
  };
}
// Hosted wrapper is exported for mocks/review only; production CLI still uses
// the globally disabled adapter below. invoke must be a bounded process runner.
export function hostedDockerAdapter({runnerEnv,uid,gid,signal,invoke}) {
  let driver;
  const gitEnv = {PATH:'/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GITHUB_ACTIONS:runnerEnv.GITHUB_ACTIONS,RUNNER_ENVIRONMENT:runnerEnv.RUNNER_ENVIRONMENT};
  const lazy = {};
  for (const method of ['ensureImage','create','inspect','authorizeCleanup','start','wait','kill','remove']) lazy[method] = (...args) => {
    if (!driver) fail('docker-operation-failed');
    return driver[method](...args);
  };
  const inner = dockerModelAdapter(lazy,{env:gitEnv,uid,gid,signal});
  return {
    ...inner,
    async preflight() {
      checkHostedRunner(runnerEnv);
      if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function' || process.getuid() <= 0 || process.getgid() <= 0 || uid !== process.getuid() || gid !== process.getgid()) fail('runner-identity-mismatch');
      await inner.preflight();
    },
    async prepare(options) {
      const root = await inner.prepare(options);
      try {
        const execute = await createDockerExecutor(root,runnerEnv,invoke);
        driver = dockerCliDriver(execute);
        return root;
      } catch (error) { await inner.cleanup(root); throw error; }
    },
  };
}
export function profileFiles(token) {
  return {
    manifest: {name:'dsh-canary-profile',private:true,dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}}},
    patch: [{insert:[{id:'mobile-remote',name:'@marktrue/dsh-mobile-remote',config:{path:'/m',authToken:token,pluginUpdateManifest:'off',lanBridge:{enabled:false},pushUrls:[]}}]}],
  };
}
const ownedRoots = new Set();
// Materialize a git-archive byte stream only into a newly created private root.
// This helper does not extract or execute the archive and is not wired to CLI.
export async function createSourceArchive(pluginRoot, sha, env) {
  const snapshot = await verifyPluginSource(pluginRoot,sha,env);
  const patch = join(pluginRoot,'cordis.patch.yml');
  const patchHash = await regularFileHash(patch,'source-identity-mismatch');
  let manifest;
  try { manifest = JSON.parse(await readFile(join(pluginRoot,'package.json'),'utf8')); } catch { fail('source-identity-mismatch'); }
  if (!manifest || manifest.name !== '@marktrue/dsh-mobile-remote' || typeof manifest.version !== 'string' || !manifest.version) fail('source-identity-mismatch');
  const root = await mkdtemp(join(tmpdir(),'dsh-host-canary-'));
  ownedRoots.add(root);
  try {
    const source = join(root,'source'), profile = join(root,'profile');
    await mkdir(source,{mode:0o700}); await mkdir(profile,{mode:0o700});
    const archivePath = join(source,'source.tar');
    const file = await open(archivePath,'wx',0o600);
    let result;
    try { result = await command('git',gitArchiveArgs(sha),{cwd:pluginRoot,env,timeout:30000,outputFd:file.fd}); }
    finally { await file.close(); }
    if (result.code !== 0 || result.timedOut) fail('source-archive-failed');
    if (await verifyPluginSource(pluginRoot,sha,env) !== snapshot || await regularFileHash(patch,'source-identity-mismatch') !== patchHash || !isDeepStrictEqual(JSON.parse(await readFile(join(pluginRoot,'package.json'),'utf8')),manifest)) fail('source-identity-mismatch');
    return {root,source,profile,archivePath,snapshot,manifest,patchHash};
  } catch (error) { await cleanupRoot(root); throw error; }
}
export async function validateDockerMounts(root) {
  if (!ownedRoots.has(root) || !/^dsh-host-canary-[A-Za-z0-9]+$/.test(basename(root))) fail('docker-mount-invalid');
  const expected = join(await realpath(tmpdir()),basename(root));
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) !== 0 || (process.getuid && rootStat.uid !== process.getuid()) || (process.getgid && rootStat.gid !== process.getgid()) || await realpath(root) !== expected) fail('docker-mount-invalid');
  for (const name of ['source','profile']) {
    const path = join(root,name), stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()) || (process.getgid && stat.gid !== process.getgid()) || await realpath(path) !== join(expected,name)) fail('docker-mount-invalid');
  }
  const archive = await lstat(join(root,'source','source.tar'));
  if (!archive.isFile() || archive.isSymbolicLink() || (archive.mode & 0o077) !== 0 || (process.getuid && archive.uid !== process.getuid()) || (process.getgid && archive.gid !== process.getgid())) fail('docker-mount-invalid');
  for (const path of [join(root,'profile','token'),join(root,'profile','dsh/profiles/canary/cordis.patch.yml')]) {
    const existing = await lstat(path).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (existing) fail('docker-mount-invalid');
  }
  return {source:join(expected,'source'),profile:join(expected,'profile')};
}
export async function prepareContainerProfile(root) {
  const {profile} = await validateDockerMounts(root);
  if ((await readdir(profile)).length !== 0) fail('docker-mount-invalid');
  for (const dir of ['home','dsh/profiles/canary','xdg-config','xdg-cache','xdg-data','xdg-state','xdg-runtime']) await mkdir(join(profile,dir),{recursive:true,mode:0o700});
  const {manifest} = profileFiles('');
  const target = join(profile,'dsh/profiles/canary');
  await writeFile(join(target,'package.json'),JSON.stringify(manifest),{flag:'wx',mode:0o600});
}
export async function removeSourceArchive(root) { await cleanupRoot(root); }
async function cleanupRoot(root) {
  if (!ownedRoots.has(root) || !/^dsh-host-canary-[A-Za-z0-9]+$/.test(basename(root))) fail('cleanup-failed');
  const expected = join(await realpath(tmpdir()), basename(root));
  if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== expected) fail('cleanup-failed');
  await rm(root, {recursive:true,force:true});
  ownedRoots.delete(root);
}
// These variables are a cooperative mistake guard, not runner authentication.
export function checkHostedRunner(env) {
  if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted') fail('runner-not-ephemeral');
}
// Production CLI adapter: the real isolated Docker backend, still refusing to run
// anywhere that is not a hosted, ephemeral runner. Every isolation guarantee is
// enforced inside hostedDockerAdapter/dockerModelAdapter (network none, non-root,
// read-only mounts, capability drops, bounded lifecycle, verified cleanup); this
// wrapper only supplies the runner identity and an abort signal.
export function createCliAdapter({env = process.env, signal} = {}) {
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') fail('runner-identity-mismatch');
  return hostedDockerAdapter({runnerEnv: env, uid: process.getuid(), gid: process.getgid(), signal});
}
// These two become 'ok' only after a real browser GUI session has connected: the
// workspace registry and the in-process owner Peer are created lazily for a user
// session. This canary deliberately never opens a browser (no model account, no
// GUI, isolated container), so they stay missing/drift here by construction.
// They are still reported for diagnosis, but they must not decide the verdict:
// compatibility of those paths needs a human on a real device, which is exactly
// the manual confirmation step the canary asks for.
const sessionGatedCapabilityNames = Object.freeze(['workspaceRegistry.stateWrite','gateway.eventsPeer']);
const capabilityNames = ['jobs.callerShape','jobs.eventsApi','settings.read','gateway.wireStream','permissionPresets.apply','permissionPresets.catalog','workspaceRegistry.stateWrite','gateway.eventsPeer'];
export function evaluateResponses(unauth, bootstrap, diagnostics, version, pid, repeats = {}) {
  const checks = [];
  const mismatch = (stage, value) => {
    const retry = repeats[stage];
    if (stage === 'auth' || !Number.isInteger(value?.status) || value.status <= 0 || value.status >= 500 || !retry || retry.status !== value.status || JSON.stringify(retry.body) !== JSON.stringify(value.body)) throw new CanaryError('response-inconclusive','infrastructure-failure',checks);
    throw new CanaryError('compatibility-check-failed','compatibility-failure',checks);
  };
  if (unauth?.status !== 401 || unauth?.body?.error !== 'auth-required') mismatch('auth',unauth);
  checks.push('auth');
  // Never attribute protocol drift to an unverified listener/instance.
  if (bootstrap?.status !== 200 || bootstrap.body?.plugin?.name !== 'dsh-mobile-remote' || bootstrap.body?.plugin?.version !== version || !Number.isSafeInteger(pid) || pid <= 0 || bootstrap.body?.plugin?.pid !== pid) throw new CanaryError('host-identity-inconclusive','infrastructure-failure',checks);
  if (bootstrap.body?.ok !== true || bootstrap.body?.auth?.enabled !== true || !bootstrap.body?.capabilities || typeof bootstrap.body.capabilities !== 'object' || Array.isArray(bootstrap.body.capabilities)) mismatch('bootstrap',bootstrap);
  checks.push('bootstrap');
  const data = diagnostics?.body;
  if (diagnostics?.status !== 200 || data?.ok !== true || data?.plugin?.name !== 'dsh-mobile-remote' || data?.plugin?.version !== version || data?.runtime?.authEnabled !== true || data?.runtime?.lanBridge?.listening !== false || data?.services?.webServer !== true || !data?.checks?.hostCapabilities) mismatch('diagnostics',diagnostics);
  checks.push('diagnostics');
  for (const name of capabilityNames) {
    const state = data.checks.hostCapabilities[name];
    if (!['ok','missing','drift'].includes(state)) mismatch('diagnostics',diagnostics);
    checks.push(`host-capability:${name}:${state}`);
  }
  // Missing or drifting services can be caused by an incomplete isolated host.
  // Until service loading is independently proven, this is inconclusive, not
  // evidence of a host/plugin protocol incompatibility.
  // Only capabilities that do not require a browser session may block the verdict.
  // A session-gated capability is reported (so a human sees the truth) but is not
  // evidence of incompatibility in an environment that never opens a GUI.
  const blocking = checks.filter(check => {
    const name = check.slice('host-capability:'.length).replace(/:(?:ok|missing|drift)$/,'');
    return !sessionGatedCapabilityNames.includes(name);
  });
  if (blocking.some(check => check.endsWith(':missing') || check.endsWith(':drift'))) throw new CanaryError('host-capabilities-inconclusive','infrastructure-failure',checks);
  return checks;
}
// /proc is a point-in-time check, not an atomic socket/health guarantee.
// No path or raw proc data is emitted. Reject malformed, missing, unsupported,
// stopped, and uninterruptible states rather than treating them as healthy.
export function readLinuxProcessStat(pid, reader = readFileSync, platform = process.platform) {
  const unknown = {state:'unknown',startTime:null};
  if (platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0 || typeof reader !== 'function') return unknown;
  try {
    const text = reader(`/proc/${pid}/stat`,'utf8');
    if (typeof text !== 'string' || text.length > 8192 || !text.startsWith(`${pid} (`)) return unknown;
    const close = text.lastIndexOf(')');
    if (close < String(pid).length + 2 || text[close+1] !== ' ') return unknown;
    const fields = text.slice(close+2).trim().split(/\s+/);
    if (fields.length < 20 || !/^[A-Za-z]$/.test(fields[0]) || !/^\d+$/.test(fields[19])) return unknown;
    const state = fields[0] === 'R' || fields[0] === 'S' ? 'running' : ['Z','X','x'].includes(fields[0]) ? 'exited' : 'unknown';
    return {state,startTime:fields[19]};
  } catch (error) {
    // A definitely missing entry means the process is gone; an unreadable or
    // transient /proc failure is only unknown and must stay inconclusive.
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return {state:'exited',startTime:null,missing:true};
    return unknown;
  }
}
export function createLinuxChildMonitor(child, readStat = readLinuxProcessStat) {
  let spawnFailed = false, exited = false;
  child.on('error',() => { spawnFailed = true; });
  child.on('exit',() => { exited = true; });
  const pid = child.pid;
  let baseline;
  try { baseline = readStat(pid); } catch { baseline = {state:'unknown',startTime:null}; }
  return () => {
    if (spawnFailed) return 'spawn-error';
    if (exited || child.exitCode != null || child.signalCode != null) return 'exited';
    if (!Number.isSafeInteger(pid) || pid <= 0) return 'starting';
    // The process disappeared before a baseline identity could be read. That is
    // an exit, not an unreadable state: stderr evidence from this child stays
    // usable while the exact identity remains unproven.
    if (baseline?.missing) return 'exited';
    if (!baseline || baseline.state === 'unknown' || !/^\d+$/.test(baseline.startTime ?? '')) return 'proc-unknown';
    let current;
    try { current = readStat(pid); } catch { return 'proc-unknown'; }
    if (!current) return 'proc-unknown';
    if (current.missing) return 'exited';
    if (current.startTime !== baseline.startTime) return 'proc-unknown';
    if (current.state === 'exited') return 'exited';
    return current.state === 'running' ? 'running' : 'proc-unknown';
  };
}
// Observe Node's own ChildProcess exit event and require it to agree with both
// ChildProcess fields. No numeric exit code or signal leaves this closure.
export function createChildExitObserver(child) {
  if (!child || typeof child.on !== 'function' || typeof child.off !== 'function') fail('probe-input-invalid');
  let seen = false, eventCode = null, eventSignal = null, disposed = false;
  const pending = new Set();
  const onExit = (code,signal) => { seen = true; eventCode = code; eventSignal = signal; };
  child.on('exit',onExit);
  const status = () => {
    if (!seen || disposed || child.exitCode !== eventCode || child.signalCode !== eventSignal) return null;
    if (eventSignal === null && Number.isInteger(eventCode) && eventCode >= 0 && eventCode <= 255) return eventCode === 0 ? 'host-process-exited-zero' : 'host-process-exited-nonzero';
    if (eventCode === null && typeof eventSignal === 'string' && /^SIG[A-Z0-9]+$/.test(eventSignal)) return 'host-process-exited-signal';
    return null;
  };
  const wait = budgetMs => new Promise(resolve => {
    const limit = Number.isFinite(budgetMs) ? Math.max(0,Math.min(250,Math.floor(budgetMs))) : 0;
    if (seen || disposed || limit === 0) return resolve();
    let timer, done = false;
    const finish = () => {
      if (done) return; done = true; clearTimeout(timer); pending.delete(finish);
      child.off('exit',finish); child.off('close',finish); child.off('error',finish); resolve();
    };
    pending.add(finish); child.once('exit',finish); child.once('close',finish); child.once('error',finish);
    timer = setTimeout(finish,limit);
    if (seen || disposed) finish();
  });
  const cancelWaits = () => { for (const finish of pending) finish(); };
  const destroy = () => { if (disposed) return; disposed = true; cancelWaits(); child.off('exit',onExit); };
  return {status,wait,cancelWaits,destroy};
}
// Error-text categories are clues only, never proof of root cause. Only a
// bounded prefix is inspected and the original contents are never returned.
// Every fixed hint code this canary may report for a host that exited before it
// became ready. Kept in one place so adding a detection cannot be silently rejected
// by a downstream allowlist that was not updated.
// Well-known peer/runtime dependencies this plugin imports. If startup fails with
// "Cannot find package <x>", the canary reports a SPECIFIC fixed code instead of the
// generic module-not-found one, so a single hosted run is enough to attribute it.
// Only these exact specifiers participate; anything else stays generic.
export function stderrExitHint(text) {
  if (typeof text !== 'string') return null;
  const prefix = text.slice(0,4096);
  if (/\b(?:uv_os_get_passwd|getpwuid(?:_r)?)\b/i.test(prefix)) return 'host-process-exited-hint-user-lookup';
  // Order matters: test the most specific causes first so a generic token further
  // down the prefix (e.g. a stray ENOENT) cannot mask the actionable one.
  for (const [pattern,code] of [
    [/\bEADDRINUSE\b/,'host-process-exited-hint-port-in-use'],
    [/\b(?:ENOMEM|JavaScript heap out of memory|Allocation failed)\b/,'host-process-exited-hint-out-of-memory'],
    [/\b(?:EACCES|EPERM)\b/,'host-process-exited-hint-eacces'],
    [/\bEROFS\b/,'host-process-exited-hint-erofs'],
    [/\bENOENT\b/,'host-process-exited-hint-enoent'],
    [/\bENOSPC\b/,'host-process-exited-hint-enospc'],
    // Identify WHICH well-known dependency is missing. Only names from a closed
    // allowlist are ever mapped to a code; the raw module specifier never leaves
    // this function, so no path or user data can leak through it.
    ...MISSING_DEPENDENCY_SPECIFIERS.map(([specifier,code]) => [new RegExp(`Cannot find package ['"\"]${specifier.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}['"\"]`), code]),
    [/\b(?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND)\b/,'host-process-exited-hint-module-not-found'],
    [/\bERR_DLOPEN_FAILED\b/,'host-process-exited-hint-native-load'],
    // Unsupported runtime: node refuses to start the CLI's declared engine range.
    [/\b(?:Unsupported engine|EBADENGINE|engine .* is incompatible)\b/i,'host-process-exited-hint-engine-mismatch'],
    // The CLI could not parse its own argv/profile (bad or missing --profile data).
    [/\b(?:profile .* does not exist|Unknown argument|Invalid option)\b/i,'host-process-exited-hint-bad-invocation'],
  ]) if (pattern.test(prefix)) return code;
  // Require an actual newline inside the retained prefix; EOF or truncation
  // is not evidence that the observed text was a complete diagnostic line.
  if (/(?:^|\n)dsh: startup failed: (?:1 required plugin|(?:[2-9]|[1-9]\d+) required plugins) did not activate\r?\n/.test(prefix)) return 'host-process-exited-hint-startup-audit';
  return null;
}
// Shared by the generated worker and local tests. No stderr bytes leave this
// closure; hints are fixed codes and no unbounded buffering is permitted.
export function createStderrCollector(stream, ...extraStreams) {
  if (!stream || typeof stream.setEncoding !== 'function' || typeof stream.on !== 'function' || typeof stream.destroy !== 'function') fail('probe-input-invalid');
  // A second (or later) stream — notably stdout — is captured into the SAME bounded
  // prefix. Startup errors are not guaranteed to go to stderr, and discarding stdout
  // previously left only a catch-all error code with no actionable signal.
  const streams = [stream, ...extraStreams.filter(s => s && typeof s.setEncoding === 'function' && typeof s.on === 'function' && typeof s.destroy === 'function')];
  let prefix = '', destroyed = false;
  // Keep a bounded window, but keep the NEWEST bytes: a startup failure is reported
  // at the END of the stream, and a naive "first 4KB" buffer would be filled by
  // unrelated early output (Node banners, tray chatter) and miss it entirely.
  const LIMIT = 4096;
  const onData = chunk => {
    if (typeof chunk !== 'string' || chunk.length === 0) return;
    prefix = (prefix + chunk).slice(-LIMIT);
  };
  const onError = () => {};
  for (const s of streams) { s.setEncoding('utf8'); s.on('data',onData); s.on('error',onError); }
  const hint = () => stderrExitHint(prefix);
  const allDone = () => destroyed || streams.every(s => s.readableEnded || s.destroyed);
  const drain = budgetMs => new Promise(resolve => {
    const limit = Number.isFinite(budgetMs) ? Math.max(0,Math.min(250,Math.floor(budgetMs))) : 0;
    if (allDone() || limit === 0) return resolve();
    let timer, done = false;
    const completed = new Set(), handlers = new Map();
    const finish = () => {
      if (done) return; done = true; clearTimeout(timer);
      for (const [s, handler] of handlers) { s.off('end',handler); s.off('close',handler); s.off('error',handler); }
      resolve();
    };
    for (const s of streams) {
      const handler = () => { completed.add(s); if (destroyed || streams.every(x => completed.has(x) || x.readableEnded || x.destroyed)) finish(); };
      handlers.set(s,handler); s.once('end',handler); s.once('close',handler); s.once('error',handler);
    }
    timer = setTimeout(finish,limit);
    if (allDone()) finish();
  });
  const destroy = () => {
    if (destroyed) return;
    destroyed = true; prefix = '';
    for (const s of streams) { s.off('data',onData); s.off('error',onError); s.destroy(); }
  };
  return {hint,drain,destroy};
}
// Testable worker contract only: the caller must run the transport inside a
// verified container. It receives only fixed relative paths, never a host URL.
async function probeMobileCore({request, token, version, pid, delay, childState = () => 'running', childExitHint = () => null, clock = () => performance.now(), readinessBudgetMs = 40000, maxAttempts = 120, maxDiagnosticAttempts = 40, diagnosticBudgetMs = 20000, probeDeadline = Infinity}) {
  if (typeof request !== 'function' || typeof token !== 'string' || !token || typeof delay !== 'function' || typeof childState !== 'function' || typeof childExitHint !== 'function' || typeof clock !== 'function' || !Number.isInteger(readinessBudgetMs) || readinessBudgetMs < 1 || readinessBudgetMs > 40000 || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 120 || !Number.isInteger(maxDiagnosticAttempts) || maxDiagnosticAttempts < 1 || maxDiagnosticAttempts > 40 || !Number.isInteger(diagnosticBudgetMs) || diagnosticBudgetMs < 1 || diagnosticBudgetMs > 20000 || (probeDeadline !== Infinity && !Number.isFinite(probeDeadline))) fail('probe-input-invalid');
  let identityVerified = false;
  const stateBeforeIdentity = () => {
    let state;
    try { state = childState(); } catch { fail('probe-input-invalid'); }
    if (state === 'spawn-error') fail('host-process-spawn-failed');
    if (state === 'proc-unknown') fail('host-process-state-inconclusive');
    if (state === 'exited') {
      let hint; try { hint = childExitHint(); } catch { hint = null; }
      const allowed = HINT_CODES;
      fail(allowed.includes(hint) ? hint : 'host-process-exited');
    }
    if (state !== 'running' && state !== 'starting') fail('probe-input-invalid');
    if (identityVerified && state !== 'running') fail('host-process-state-inconclusive');
    return state;
  };
  const bounded = async (operation, milliseconds, fallback) => {
    if (milliseconds <= 0) return fallback;
    let timer;
    try { return await Promise.race([Promise.resolve().then(operation),new Promise(resolve => { timer = setTimeout(() => resolve(fallback),milliseconds); })]); }
    catch { return fallback; }
    finally { clearTimeout(timer); }
  };
  const get = async (path, credential, budget = 5000) => {
    stateBeforeIdentity();
    const limit = Math.max(0,Math.floor(Math.min(5000,budget,probeDeadline - clock())));
    const response = await bounded(() => request(path,credential,limit),limit,{status:0,body:null});
    stateBeforeIdentity();
    return response;
  };
  const rejected = response => response?.status === 401 && response?.body?.error === 'auth-required';
  const wrongToken = token === 'canary-invalid' ? 'canary-invalid-alternate' : 'canary-invalid';
  let unauth;
  // 40s readiness + 5s invalid bootstrap + 10s authenticated bootstrap
  // + 20s diagnostic budget; the 105s outer runtime also reserves 15s
  // each for Docker create/inspect/start and result/log transport.
  const readinessDeadline = Math.min(clock() + readinessBudgetMs,probeDeadline);
  const readinessRemaining = () => Math.max(0,readinessDeadline - clock());
  stateBeforeIdentity();
  for (let i=0; i<maxAttempts && readinessRemaining() > 0; i++) {
    stateBeforeIdentity();
    const value = await get('/m/api/bootstrap',null,readinessRemaining());
    const state = stateBeforeIdentity();
    if (state === 'running' && readinessRemaining() > 0 && value?.status === 401 && value?.body?.error === 'auth-required') { unauth = value; break; }
    if (i + 1 < maxAttempts && readinessRemaining() > 0) await bounded(() => delay(Math.min(500,readinessRemaining())),readinessRemaining(),null);
  }
  if (!unauth) fail(stateBeforeIdentity() === 'starting' ? 'host-process-spawn-inconclusive' : 'host-ready-timeout');
  // One invalid credential per endpoint, with a successful authenticated
  // request between endpoints to reset the rate-limit bucket.
  const invalidBootstrap = await get('/m/api/bootstrap',wrongToken);
  stateBeforeIdentity();
  if (!rejected(invalidBootstrap)) fail('host-auth-response-inconclusive');
  const bootstrap = await get('/m/api/bootstrap',token);
  stateBeforeIdentity();
  if (bootstrap?.status !== 200 || bootstrap.body?.plugin?.name !== 'dsh-mobile-remote' || bootstrap.body?.plugin?.version !== version || bootstrap.body?.plugin?.pid !== pid) fail('host-identity-inconclusive');
  identityVerified = true;
  stateBeforeIdentity();
  const bootstrapRetry = await get('/m/api/bootstrap',token);
  // A monotonic wall-clock deadline bounds each request and each delay.
  const diagnosticDeadline = Math.min(clock() + diagnosticBudgetMs,probeDeadline);
  const remaining = () => Math.max(0,diagnosticDeadline - clock());
  if (!rejected(await get('/m/api/diagnostics',null,remaining()))) fail('host-auth-response-inconclusive');
  if (!rejected(await get('/m/api/diagnostics',wrongToken,remaining()))) fail('host-auth-response-inconclusive');
  for (let i=0; i<maxDiagnosticAttempts; i++) {
    const diagnostics = await get('/m/api/diagnostics',token,remaining());
    const diagnosticsRetry = await get('/m/api/diagnostics',token,remaining());
    try {
      const checks = evaluateResponses(unauth,bootstrap,diagnostics,version,pid,{bootstrap:bootstrapRetry,diagnostics:diagnosticsRetry});
      stateBeforeIdentity();
      if (clock() >= probeDeadline) fail('response-inconclusive');
      return checks;
    }
    catch (error) {
      stateBeforeIdentity();
      if (!(error instanceof CanaryError) || error.code !== 'host-capabilities-inconclusive' || i + 1 === maxDiagnosticAttempts || remaining() <= 0) throw error;
      await bounded(() => delay(Math.min(500,remaining())),remaining(),null);
      stateBeforeIdentity();
      if (remaining() <= 0) throw error;
    }
  }
  fail('host-capabilities-inconclusive');
}
// Only invoke after the monitored child is known to have exited. The callback
// returns no text; its sole purpose is to let queued stderr events drain.
// Codes are bounded log clues, not root-cause findings.
export async function resolveExitedChildHint(initialCode, childStderrDrain, childExitHint, budgetMs = 250, exitObserver = {status:() => null,wait:async () => {}}) {
  const allowed = ['host-process-exited', ...HINT_CODES];
  if (!allowed.includes(initialCode) || typeof childStderrDrain !== 'function' || typeof childExitHint !== 'function' || !Number.isFinite(budgetMs) || budgetMs < 0 || !exitObserver || typeof exitObserver.status !== 'function' || typeof exitObserver.wait !== 'function') fail('probe-input-invalid');
  const limit = Math.min(250,Math.floor(budgetMs));
  if (limit > 0) {
    let timer;
    try { await Promise.race([Promise.allSettled([Promise.resolve().then(() => childStderrDrain(limit)),Promise.resolve().then(() => exitObserver.wait(limit))]),new Promise(resolve => { timer = setTimeout(resolve,limit); })]); }
    catch {} finally { clearTimeout(timer); try { exitObserver.cancelWaits?.(); } catch {} }
  }
  let hint; try { hint = childExitHint(); } catch { hint = null; }
  if (allowed.includes(hint) && hint !== 'host-process-exited') return hint;
  if (initialCode !== 'host-process-exited') return initialCode;
  let status; try { status = exitObserver.status(); } catch { status = null; }
  return ['host-process-exited-zero','host-process-exited-nonzero','host-process-exited-signal'].includes(status) ? status : initialCode;
}
export async function probeMobile(options) {
  if (!options || typeof options !== 'object') fail('probe-input-invalid');
  const clock = options.clock ?? (() => performance.now());
  const childStderrDrain = options.childStderrDrain ?? (async () => {});
  const childExitHint = options.childExitHint ?? (() => null);
  const childExitObserver = options.childExitObserver ?? {status:() => null,wait:async () => {}};
  const overallDeadline = options.overallDeadline ?? Infinity;
  const reserve = options.stderrDrainBudgetMs ?? 250;
  if (typeof clock !== 'function' || typeof childStderrDrain !== 'function' || typeof childExitHint !== 'function' || !childExitObserver || typeof childExitObserver.status !== 'function' || typeof childExitObserver.wait !== 'function' || !Number.isInteger(reserve) || reserve < 0 || reserve > 250 || (overallDeadline !== Infinity && !Number.isFinite(overallDeadline))) fail('probe-input-invalid');
  try { return await probeMobileCore({...options,probeDeadline:overallDeadline === Infinity ? Infinity : overallDeadline - reserve}); }
  catch (error) {
    const allowed = ['host-process-exited', ...HINT_CODES];
    if (!(error instanceof CanaryError) || !allowed.includes(error.code)) throw error;
    const remaining = overallDeadline === Infinity ? reserve : Math.max(0,Math.min(reserve,overallDeadline - clock()));
    const code = await resolveExitedChildHint(error.code,childStderrDrain,childExitHint,remaining,childExitObserver);
    throw new CanaryError(code,'infrastructure-failure',error.checks);
  }
}
export function makeInstallWorker(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) fail('docker-plan-invalid');
  return `
const MISSING_DEPENDENCY_SPECIFIERS = ${JSON.stringify(MISSING_DEPENDENCY_SPECIFIERS)};
import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync } from 'node:fs';
try {
  mkdirSync('/tmp/plugin',{recursive:true,mode:0o700});
  execFileSync('tar',['-xf','/source/source.tar','-C','/tmp/plugin','--no-same-owner','--no-same-permissions'],{stdio:'ignore',timeout:30000});
  // Install the host alone: this resolves its full, self-consistent dependency
  // closure. Adding the plugin to the same command lets the plugin's wide peer
  // ranges (">=0.1.0-rc.6 <0.3.0") pull old 0.1.x host packages into the tree,
  // which disables dozens of host rows and drops @deepseek-ai/dsh-web-app, so the
  // host dies before any HTTP surface exists.
  execFileSync('npm',['install','--prefix','/profile/dsh/profiles/canary','--ignore-scripts','--no-audit','--no-fund','--save-exact',${JSON.stringify('@deepseek-ai/dsh@' + version)}],{stdio:'ignore',timeout:300000});
  // Install the plugin into its own PERSISTENT prefix under /profile, then copy it
  // into the host tree as a real directory.
  //
  // Two constraints force this shape:
  //  - Installing into the host prefix directly lets the plugin's wide peer ranges
  //    (">=0.1.0-rc.6 <0.3.0") pull old 0.1.x host packages in and drop
  //    @deepseek-ai/dsh-web-app, so the host dies before serving HTTP.
  //  - Anything left in /tmp lives on the container tmpfs and disappears with the
  //    installer container; a symlink there would dangle for the runtime container
  //    (and verifyInstalled deliberately rejects plugin symlinks anyway).
  // So: resolve the plugin's own dependencies in a separate prefix, then
  // materialize it into the profile tree the runtime container mounts read-only.
  //
  // IMPORTANT: the plugin must be PACKED, not linked. 'npm install <local-path>'
  // (with or without --install-links) only records the directory and never installs
  // that package's own "dependencies" — the plugin would then be missing runtime
  // deps such as qrcode and every host start would die with module-not-found.
  // npm pack honours "bundleDependencies" (qrcode IS bundled by the real release),
  // so dependencies must exist BEFORE packing: install them in place, pack, then
  // install the tarball. That reproduces how a real published package behaves.
  execFileSync('npm',['install','--ignore-scripts','--no-audit','--no-fund'],{cwd:'/tmp/plugin',stdio:'ignore',timeout:300000});
  // npm pack does not create its destination: without this it exits non-zero (254).
  mkdirSync('/tmp/plugin-dist',{recursive:true,mode:0o700});
  execFileSync('npm',['pack','--ignore-scripts','--silent','--pack-destination','/tmp/plugin-dist'],{cwd:'/tmp/plugin',stdio:'ignore',timeout:120000});
  const packed = (await import('node:fs')).readdirSync('/tmp/plugin-dist').filter(f => f.endsWith('.tgz'));
  if (packed.length !== 1) throw new Error('install-failed');
  // Do NOT pass --legacy-peer-deps here. It skips peer resolution, and this plugin
  // declares peers the host does provide (@deepseek-ai/schemastery etc.); without
  // them the host dies at startup with module-not-found. Peers are installed in the
  // scaffolding prefix and the plugin's own nested deps travel with it; the host's
  // tree still wins for anything resolved upward from the profile.
  execFileSync('npm',['install','--prefix','/profile/dsh/profiles/plugin','--ignore-scripts','--no-audit','--no-fund','/tmp/plugin-dist/' + packed[0]],{stdio:'ignore',timeout:300000});
  const srcPlugin = '/profile/dsh/profiles/plugin/node_modules/@marktrue/dsh-mobile-remote';
  const dstScope = '/profile/dsh/profiles/canary/node_modules/@marktrue';
  const dstPlugin = dstScope + '/dsh-mobile-remote';
  mkdirSync(dstScope,{recursive:true});
  // cp -a keeps the plugin's own nested node_modules (its real dependencies).
  execFileSync('cp',['-a',srcPlugin,dstPlugin],{stdio:'ignore',timeout:120000});
  // The separate prefix is scaffolding only; drop it so it cannot be mistaken for
  // part of the installed tree.
  execFileSync('rm',['-rf','/profile/dsh/profiles/plugin'],{stdio:'ignore',timeout:60000});
  // Resolve every dependency the plugin imports in the exact layout the runtime
  // container will mount. Without this, a missing package only surfaces later as a
  // generic host-exit code; here it becomes one specific, attributable install code.
  {
    const { createRequire } = await import('node:module');
    const req = createRequire(dstPlugin + '/lib/index.js');
    for (const [specifier, code] of MISSING_DEPENDENCY_SPECIFIERS) {
      let resolved = true;
      try { req.resolve(specifier); } catch { resolved = false; }
      if (!resolved) throw Object.assign(new Error(code), {code});
    }
  }
  process.stdout.write('{"ok":true}\\n');
} catch (error) {
  const errorCode = MISSING_DEPENDENCY_SPECIFIERS.some(([,code]) => code === error?.code) ? error.code : 'install-failed';
  process.stdout.write(JSON.stringify({ok:false,errorCode}) + '\\n'); process.exitCode = 2;
}
`;
}
// Construct a fixed container-only worker. Token and patch exist only inside
// container tmpfs, never on the host bind, in argv, or in emitted output.
// This remains unverified and is not wired into the production CLI.
export function makeRuntimeWorker() {
  return `import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir, copyFile, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
const capabilityNames = ${JSON.stringify(capabilityNames)};
const sessionGatedCapabilityNames = ${JSON.stringify(sessionGatedCapabilityNames)};
const HINT_CODES = ${JSON.stringify(HINT_CODES)};
const RUNTIME_ERROR_CODES = ${JSON.stringify(RUNTIME_ERROR_CODES)};
const MISSING_DEPENDENCY_SPECIFIERS = ${JSON.stringify(MISSING_DEPENDENCY_SPECIFIERS)};
${CanaryError.toString()}
const fail = ${fail.toString()};
${evaluateResponses.toString()}
${readLinuxProcessStat.toString()}
${createLinuxChildMonitor.toString()}
${createChildExitObserver.toString()}
${stderrExitHint.toString()}
${createStderrCollector.toString()}
${probeMobileCore.toString()}
${resolveExitedChildHint.toString()}
${probeMobile.toString()}
${profileFiles.toString()}
const workerDeadline = performance.now() + 75000;
let child, stderrCollector, childExitObserver;
try {
  const base = '/tmp/canary', target = base + '/dsh/profiles/canary';
  for (const dir of ['home','dsh/profiles/canary','xdg-config','xdg-cache','xdg-data','xdg-state','xdg-runtime']) await mkdir(base + '/' + dir,{recursive:true,mode:0o700});
  // npm install --prefix rewrites this manifest into a plain dependency list and
  // drops dsh.profile.bundles. Without the bundles the base and web bundles never
  // load, so webServer never exists and this plugin stays pending forever: the
  // host then exits with only "1 entry did not activate". Restore the bundle
  // declaration the canary actually asked for before booting.
  {
    const installed = JSON.parse(await readFile('/profile/dsh/profiles/canary/package.json','utf8'));
    const desired = profileFiles('').manifest;
    if (!installed || typeof installed !== 'object' || Array.isArray(installed)) fail('probe-input-invalid');
    installed.dsh = desired.dsh;
    await writeFile(target + '/package.json',JSON.stringify(installed),{flag:'wx',mode:0o600});
  }
  await symlink('/profile/dsh/profiles/canary/node_modules',target + '/node_modules');
  const token = randomBytes(32).toString('hex');
  const {patch} = profileFiles(token);
  await writeFile(target + '/cordis.patch.yml',JSON.stringify(patch),{flag:'wx',mode:0o600});
  const manifest = JSON.parse(await readFile('/profile/dsh/profiles/canary/node_modules/@marktrue/dsh-mobile-remote/package.json','utf8'));
  if (!token || manifest.name !== '@marktrue/dsh-mobile-remote' || typeof manifest.version !== 'string') fail('probe-input-invalid');
  const reservation = createServer();
  await new Promise((ok,bad) => reservation.once('error',bad).listen(0,'127.0.0.1',ok));
  const port = reservation.address().port;
  await new Promise(ok => reservation.close(ok));
  // Self-check BEFORE spawning the host: actually import the plugin entry exactly as
  // the host would, in this container. A failure here is attributable to a fixed code
  // instead of the generic host-exit one, and it distinguishes "plugin cannot load in
  // THIS container" from "host starts and dies later".
  {
    let importError = null;
    try { await import('/profile/dsh/profiles/canary/node_modules/@marktrue/dsh-mobile-remote/lib/index.js'); }
    catch (error) { importError = error; }
    if (importError) {
      const message = typeof importError?.message === 'string' ? importError.message.slice(0,4096) : '';
      let code = 'host-plugin-import-failed';
      for (const [specifier, specific] of MISSING_DEPENDENCY_SPECIFIERS) {
        if (message.includes("'" + specifier + "'")) { code = specific; break; }
      }
      if (code === 'host-plugin-import-failed' && ['ERR_MODULE_NOT_FOUND','MODULE_NOT_FOUND'].includes(importError.code)) code = 'host-plugin-import-missing-module';
      if (code === 'host-plugin-import-failed' && importError.code === 'ERR_DLOPEN_FAILED') code = 'host-plugin-import-native-load';
      fail(code);
    }
  }
  // Capture stdout as well as stderr: the CLI may report a startup failure on either
  // stream, and the canary only ever emits FIXED codes derived from a bounded prefix
  // (never raw text), so widening capture does not widen what leaves the process.
  child = spawn(process.execPath,['/profile/dsh/profiles/canary/node_modules/@deepseek-ai/dsh/lib/bin.js','--profile','canary','--host','127.0.0.1','--port',String(port),'--no-open'],{cwd:'/tmp/canary',env:{...process.env,NARB_DISABLE_NATIVE_CACHE:'1'},stdio:['ignore','pipe','pipe']});
  childExitObserver = createChildExitObserver(child);
  const childState = createLinuxChildMonitor(child);
  stderrCollector = createStderrCollector(child.stderr, child.stdout);
  const childExitHint = stderrCollector.hint;
  const childStderrDrain = stderrCollector.drain;
  const request = async (path, secret, timeoutMs) => {
    const headers = secret ? {'x-mobile-token':secret} : {};
    const res = await fetch('http://127.0.0.1:' + port + path,{headers,signal:AbortSignal.timeout(Math.max(1,Math.floor(timeoutMs)))});
    let body; try { body = await res.json(); } catch { body = null; }
    return {status:res.status,body};
  };
  const checks = await probeMobile({request,token,version:manifest.version,pid:child.pid,childState,childExitHint,childStderrDrain,childExitObserver,overallDeadline:workerDeadline,delay:(ms) => new Promise(ok => setTimeout(ok,ms))});
  const finalState = childState();
  if (finalState === 'exited') fail(await resolveExitedChildHint('host-process-exited',childStderrDrain,childExitHint,Math.max(0,Math.min(250,workerDeadline-performance.now())),childExitObserver));
  if (finalState === 'spawn-error') fail('host-process-spawn-failed');
  if (finalState !== 'running') fail('host-process-state-inconclusive');
  process.stdout.write(JSON.stringify({ok:true,checks}) + '\\n');
} catch (error) {
  const codes = RUNTIME_ERROR_CODES;
  const code = codes.includes(error?.code) ? error.code : 'worker-failed';
  const checks = Array.isArray(error?.checks) ? error.checks.filter(value => typeof value === 'string' && (/^(auth|bootstrap|diagnostics)$/.test(value) || capabilityNames.some(name => ['ok','missing','drift'].some(state => value === 'host-capability:' + name + ':' + state)))) : [];
  process.stdout.write(JSON.stringify({ok:false,errorCode:code,checks}) + '\\n');
  process.exitCode = code === 'compatibility-check-failed' ? 1 : 2;
} finally { childExitObserver?.destroy(); stderrCollector?.destroy(); child?.kill('SIGKILL'); }
`;
}
async function main(args) {
  if (args[0] === '--internal-worker') {
    console.log(JSON.stringify({errorCode:'runtime-sandbox-unavailable',checks:[]})); process.exitCode=1; return;
  }
  if (args.length === 1 && args[0] === '--help') { console.log('Usage: node smoke.mjs --host-version VERSION --plugin-root PATH --out PATH\nRELEASE_SHA must be the full Git commit. Runs the real isolated Docker backend on a hosted runner; fails closed anywhere else.'); return; }
  const flags = {}; let valid = args.length === 6;
  for (let i=0; i<args.length; i+=2) { if (!['--host-version','--plugin-root','--out'].includes(args[i]) || !args[i+1] || flags[args[i]]) valid=false; else flags[args[i]]=args[i+1]; }
  let result;
  try {
    const controller = new AbortController();
    const removeHandlers = installCanarySignalHandlers(controller);
    try {
      result = await runCanary({hostVersion:valid ? flags['--host-version'] : '',pluginRoot:flags['--plugin-root'],pluginSha:process.env.RELEASE_SHA},createCliAdapter({signal:controller.signal}));
    } finally { removeHandlers(); }
  } catch {
    // Any construction/preflight failure is an infrastructure result, never a pass
    // and never a compatibility claim.
    result = {schema:1,hostVersion:valid ? flags['--host-version'] : '',pluginSha:/^[a-f0-9]{40}$/.test(process.env.RELEASE_SHA ?? '') ? process.env.RELEASE_SHA : '',status:'infrastructure-failure',stage:'sandbox',checks:[],errorCode:'runtime-sandbox-unavailable'};
  }
  const json = JSON.stringify(result) + '\n';
  try { if (flags['--out']) await writeFile(flags['--out'],json,{mode:0o600}); else process.stdout.write(json); } catch { process.stderr.write('output-write-failed\n'); process.exitCode=2; return; }
  process.exitCode = result.status === 'passed' ? 0 : result.status === 'compatibility-failure' ? 1 : 2;
}
if (process.argv[1] && resolve(process.argv[1]) === self) {
  const removeHandlers = installCanarySignalHandlers(new AbortController());
  try { await main(process.argv.slice(2)); } finally { removeHandlers(); }
}
