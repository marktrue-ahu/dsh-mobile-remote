// 一次只读取一个 npm dist-tags 快照。仅做候选解析，不运行插件或修改仓库。
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const FIXED_HOSTS = Object.freeze(['0.2.0-rc.2', '0.2.1-rc.5']);
export const HOST_PACKAGE = '@deepseek-ai/dsh';
const URL = 'https://registry.npmjs.org/-/package/@deepseek-ai%2Fdsh/dist-tags';
// 只接受 npm 精确版本，不能把标签、range 或 shell 元字符带到安装命令中。
const IDENT = '(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)';
const VERSION = new RegExp(`^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)(?:-${IDENT}(?:\\.${IDENT})*)?$`);
export const isExactVersion = (value) => typeof value === 'string' && value.length <= 100 && VERSION.test(value);

export function resolveMatrix(tags, mode) {
  if (!['daily', 'weekly'].includes(mode)) throw new Error('invalid-mode');
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) throw new Error('invalid-dist-tags');
  const selected = mode === 'daily' ? ['latest', 'next', 'alpha'] : ['latest'];
  const items = new Map();
  const add = (version, source) => {
    if (!isExactVersion(version)) throw new Error(`invalid-or-missing-${source}`);
    const row = items.get(version) ?? { hostVersion: version, sources: [], isCandidate: false };
    row.sources.push(source);
    // 固定测试目标并不代表已人工确认支持；标签来源即候选，即使也在固定矩阵中。
    if (source !== 'fixed') row.isCandidate = true;
    items.set(version, row);
  };
  if (mode === 'weekly') for (const version of FIXED_HOSTS) add(version, 'fixed');
  for (const channel of selected) add(tags[channel], channel);
  return { schema: 1, mode, hosts: [...items.values()] };
}

export async function resolveSnapshot({ mode, fetchImpl = fetch } = {}) {
  if (!['daily', 'weekly'].includes(mode)) throw new Error('invalid-mode');
  let response;
  try {
    response = await fetchImpl(URL, {
      headers: { accept: 'application/json', 'user-agent': 'dsh-mobile-remote-host-canary' },
      redirect: 'error', signal: AbortSignal.timeout(20_000),
    });
  } catch { throw new Error('registry-unreachable'); }
  if (!response.ok) throw new Error(`registry-http-${response.status}`);
  let tags;
  try { tags = await response.json(); } catch { throw new Error('invalid-dist-tags-json'); }
  return resolveMatrix(tags, mode);
}

async function main() {
  const [mode, ...extra] = process.argv.slice(2);
  if (!mode || extra.length) { console.error('usage: node tools/host-canary/resolve.mjs daily|weekly'); process.exitCode = 1; return; }
  try {
    const matrix = await resolveSnapshot({ mode });
    const compact = JSON.stringify(matrix);
    console.log(compact);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify({ include: matrix.hosts })}\n`);
  } catch (error) {
    // 内部错误仅有稳定原因码，不回显 registry 响应/URL/环境变量。
    const code = /^(invalid-mode|invalid-dist-tags|invalid-or-missing-(fixed|latest|next|alpha)|registry-unreachable|registry-http-\d{3}|invalid-dist-tags-json)$/.test(error?.message ?? '') ? error.message : 'resolution-failed';
    console.error(JSON.stringify({ schema: 1, status: 'infrastructure-failure', stage: 'resolve', errorCode: code }));
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
