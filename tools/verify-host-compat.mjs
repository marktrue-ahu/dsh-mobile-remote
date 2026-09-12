// DSH 0.1.5-rc.2 适配（Spec Issue #7，ADR Issue #9）单元检查：
// ① 宿主版本范围判定（受支持代际的下界与后续补丁）；
// ② 能力探测的独立性与语义（三项能力必须可分别表达「能调用但不能收事件」这类半可用状态）。
// 从已安装 profile 副本导入（仓库根 node_modules 无 @deepseek-ai 依赖）；可用 DSH_MOBILE_PLUGIN 指定模块路径。
import { pathToFileURL } from "node:url";

const candidates = [
	process.env.DSH_MOBILE_PLUGIN,
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
const { isHostVersionSupported, SUPPORTED_HOST_MIN } = mod;

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") => {
	if (cond) { pass++; console.log(`PASS  ${name}`); }
	else { fail++; console.log(`FAIL  ${name} ${extra}`); }
};

// 1. 下界本身受支持，且与 peer 下界同源
check("下界常量为 [0,1,5]", JSON.stringify(SUPPORTED_HOST_MIN) === "[0,1,5]", JSON.stringify(SUPPORTED_HOST_MIN));
check("目标版本 0.1.5-rc.2 受支持", isHostVersionSupported("0.1.5-rc.2") === true);
check("下界放宽到 0.1.5-rc.3（同 tuple 的后续 RC）", isHostVersionSupported("0.1.5-rc.3") === true);
check("0.1.5 正式版受支持", isHostVersionSupported("0.1.5") === true);
check("0.1.6 受支持（同代后续补丁）", isHostVersionSupported("0.1.6") === true);
check("0.1.9-alpha.1 受支持", isHostVersionSupported("0.1.9-alpha.1") === true);
check("0.1.5-rc.1 不受支持（低于下界的同 tuple prerelease）", isHostVersionSupported("0.1.5-rc.1") === false);
check("0.1.5-rc.0 不受支持", isHostVersionSupported("0.1.5-rc.0") === false);
check("0.1.5-alpha.1 不受支持", isHostVersionSupported("0.1.5-alpha.1") === false);
check("0.1.4-rc.9 不受支持（patch 低于下界）", isHostVersionSupported("0.1.4-rc.9") === false);

// 2. 旧代与越界版本不受支持（"只支持当前代际"）
check("0.1.2-rc.1 不受支持", isHostVersionSupported("0.1.2-rc.1") === false);
check("0.1.1-rc.2 不受支持", isHostVersionSupported("0.1.1-rc.2") === false);
check("0.1.4 不受支持", isHostVersionSupported("0.1.4") === false);
check("0.0.9 不受支持", isHostVersionSupported("0.0.9") === false);
check("0.2.0 不受支持（换代际需重新适配）", isHostVersionSupported("0.2.0") === false);
check("1.0.0 不受支持（主版本换代际，不因“更新”放行）", isHostVersionSupported("1.0.0") === false);
check("0.3.0 不受支持（同主版本但高于受支持上界）", isHostVersionSupported("0.3.0") === false);

// 3. 不可解析 → null（未知，不谎报为不支持）
check("undefined → null", isHostVersionSupported(undefined) === null);
check("null → null", isHostVersionSupported(null) === null);
check("空串 → null", isHostVersionSupported("") === null);
check("非版本串 → null", isHostVersionSupported("unknown") === null);
check("残缺版本 → null", isHostVersionSupported("0.1") === null);

// 4. 空白容忍（manifest 里的版本串理论上干净，但读盘来源不可全信）
check("首尾空白容忍", isHostVersionSupported("  0.1.5-rc.2  ") === true);

// 5. 构建元数据不干扰判定
check("带 +build 元数据", isHostVersionSupported("0.1.5-rc.2+build.7") === true);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
