// v3.1.1(issue #5) 服务端单测：normalizeServerPath 分隔符归一。
// 场景：旧版移动端在 WSL/Linux 上把 `/home` 拼成 `/\home`（Windows 反斜杠习惯），
// 归一化后 readdir/mkdir/建会话 cwd 才能命中真实目录。
// 从已安装 profile 副本导入（仓库根 node_modules 无 @deepseek-ai 依赖）；
// 可用 DSH_MOBILE_PLUGIN 指定模块路径。
import { pathToFileURL } from "node:url";

const candidates = [
  process.env.DSH_MOBILE_PLUGIN,
  "C:/Users/30623/.dsh/profiles/desktop/node_modules/dsh-mobile-remote/lib/index.js",
  "C:/Users/30623/.dsh/profiles/web/node_modules/dsh-mobile-remote/lib/index.js",
  new URL("../lib/index.js", import.meta.url).pathname,
].filter(Boolean).map((p) => (/^[a-zA-Z]:[\\/]/.test(p) ? pathToFileURL(p).href : p));

let mod = null;
for (const p of candidates) {
  try {
    mod = await import(p);
    if (mod) break;
  } catch {
    // 尝试下一个候选
  }
}
if (!mod) {
  console.error("FAIL: 无法导入插件模块（先同步 profile 副本或设 DSH_MOBILE_PLUGIN）");
  process.exit(1);
}
const { normalizeServerPath } = mod;

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} ${extra}`); }
};

// 1. POSIX（WSL/Linux/macOS）：\ → /（issue #5 主场景）
{
  // 旧版 App 拼出的 /\home 归一为 //home：重复斜杠在 POSIX 与 /home 等价（readdir 有效）
  check(
    "POSIX: /\\home 归一为 //home（等价 /home）",
    normalizeServerPath("/\\home", "linux") === "//home",
    normalizeServerPath("/\\home", "linux")
  );
  check(
    "POSIX: 正常路径原样保留",
    normalizeServerPath("/home/user/project", "linux") === "/home/user/project"
  );
  check(
    "POSIX: 混合 \\home\\user\\x 归一",
    normalizeServerPath("\\home\\user\\x", "darwin") === "/home/user/x"
  );
  check("POSIX: 空串原样", normalizeServerPath("", "linux") === "");
}

// 2. Windows：/ → \；盘符与 \\ 路径不受影响
{
  check(
    "Windows: C:/Users 归一为 C:\\Users",
    normalizeServerPath("C:/Users", "win32") === "C:\\Users",
    normalizeServerPath("C:/Users", "win32")
  );
  check(
    "Windows: 盘符路径 C:\\Users 原样保留",
    normalizeServerPath("C:\\Users\\dev", "win32") === "C:\\Users\\dev"
  );
  check(
    "Windows: UNC //server/share 归一为 \\\\server\\share",
    normalizeServerPath("//server/share", "win32") === "\\\\server\\share"
  );
}

// 3. 非字符串（undefined）安全返回（调用方未传 path 的场景）
check("非字符串原样返回", normalizeServerPath(undefined) === undefined);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
