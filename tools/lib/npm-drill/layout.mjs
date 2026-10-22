// 安装布局的**窄结构解析**（R8：不新增 YAML 依赖，只解析受支持版本 pnpm 11 的已知结构，
// 忽略注释行；找不到结构即返回稳定原因，绝不用"字符串共现"冒充事实）。
//
// - pnpm-lock.yaml v9：`snapshots:` 下当前插件快照 `<name>@<version>:` 的
//   `optionalDependencies:` 段必须精确映射 `<carrierAlias>: <carrierName>@<carrierVersion>`；
// - `.modules.yaml`（pnpm 11 实际写 JSON）：`hoistedLocations[<carrierName>@<carrierVersion>]`
//   必须包含精确落点 `node_modules/<carrierAlias>`。

/** 去掉整行注释（以 `#` 开头，忽略缩进）；用于兼容"评审在文件末尾追加正确名字注释"的绕过。 */
export function stripCommentLines(text) {
	return String(text ?? "")
		.split(/\r?\n/)
		.filter((line) => !line.trimStart().startsWith("#"))
		.join("\n");
}

function unquote(value) {
	const text = String(value ?? "").trim();
	if (text.length >= 2 && ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"')))) {
		return text.slice(1, -1);
	}
	return text;
}

function indentOf(line) {
	return /^\s*/.exec(line)?.[0].length ?? 0;
}

/**
 * 在 `snapshots:` 段里定位插件快照块，解析其 `optionalDependencies` 精确映射。
 * @returns {{ok:boolean, reason:string, detail:string, mapping?:Record<string,string>}}
 */
export function parsePnpmLockCarrierAlias(lockText, { pluginName, pluginVersion, carrierAlias }) {
	const lines = stripCommentLines(lockText).split(/\r?\n/);
	const snapshotStart = lines.findIndex((line) => line.trim() === "snapshots:");
	if (snapshotStart === -1) return { ok: false, reason: "lock-snapshots-missing", detail: "pnpm-lock.yaml 缺少 snapshots 段" };
	const pluginKeyPrefix = `${pluginName}@${pluginVersion}`;
	let blockStart = -1;
	let blockIndent = 0;
	let blockEnd = lines.length;
	for (let index = snapshotStart + 1; index < lines.length; index++) {
		const line = lines[index];
		if (line.trim() === "") continue;
		const indent = indentOf(line);
		const trimmed = line.trim();
		if (blockStart === -1) {
			// 快照键：缩进 2 的 `<name>@<version>:`（允许 peer 后缀 `(…)` 与引号）。
			if (indent !== 2 || trimmed.startsWith("-") || !trimmed.endsWith(":")) continue;
			const key = unquote(trimmed.slice(0, -1));
			if (key === pluginKeyPrefix || key.startsWith(`${pluginKeyPrefix}(`)) {
				blockStart = index;
				blockIndent = indent;
			}
			continue;
		}
		// 块结束：下一个缩进 ≤ 2 的键行。
		if (indent <= blockIndent && trimmed.endsWith(":")) {
			blockEnd = index;
			break;
		}
	}
	if (blockStart === -1) {
		return { ok: false, reason: "lock-plugin-snapshot-missing", detail: `snapshots 下未找到 ${pluginKeyPrefix}` };
	}
	let optionalStart = -1;
	for (let index = blockStart + 1; index < blockEnd; index++) {
		if (lines[index].trim() === "optionalDependencies:") {
			optionalStart = index;
			break;
		}
	}
	if (optionalStart === -1) {
		return { ok: false, reason: "lock-optional-dependencies-missing", detail: `${pluginKeyPrefix} 快照缺少 optionalDependencies` };
	}
	const mapping = {};
	for (let index = optionalStart + 1; index < blockEnd; index++) {
		const line = lines[index];
		if (line.trim() === "") continue;
		if (indentOf(line) <= indentOf(lines[optionalStart])) break;
		const trimmed = line.trim();
		if (trimmed.startsWith("-")) continue;
		const colon = trimmed.indexOf(":");
		if (colon === -1) continue;
		mapping[unquote(trimmed.slice(0, colon))] = unquote(trimmed.slice(colon + 1));
	}
	const expected = `${pluginName}@${pluginVersion}-app`;
	const actual = mapping[carrierAlias];
	if (actual !== expected) {
		return {
			ok: false,
			reason: "lock-carrier-alias-mismatch",
			detail: `${carrierAlias}=${actual ?? "<未映射>"} 期望=${expected}（实际映射：${JSON.stringify(mapping)}）`,
			mapping,
		};
	}
	return { ok: true, reason: "ok", detail: `${carrierAlias} → ${expected}`, mapping };
}

/**
 * `.modules.yaml`（pnpm 11 写 JSON）里 `hoistedLocations[<carrier>]` 的精确落点。
 * 忽略注释行后按 JSON 解析；不是 JSON 时按窄 YAML 结构解析（兼容旧 pnpm 文本格式）。
 * @returns {{ok:boolean, reason:string, detail:string, locations?:string[]}}
 */
export function parseHoistedLocations(modulesText, { carrierName, carrierVersion, carrierAlias }) {
	const cleaned = stripCommentLines(modulesText);
	const carrierKey = `${carrierName}@${carrierVersion}`;
	const expected = `node_modules/${carrierAlias}`;
	let locations = null;
	try {
		const data = JSON.parse(cleaned);
		const hoisted = data && typeof data.hoistedLocations === "object" && data.hoistedLocations !== null
			? data.hoistedLocations
			: null;
		if (hoisted !== null && Array.isArray(hoisted[carrierKey])) locations = hoisted[carrierKey].map(String);
	} catch {
		locations = parseHoistedLocationsYaml(cleaned, carrierKey);
	}
	if (locations === null) {
		return { ok: false, reason: "modules-hoisted-locations-missing", detail: `.modules.yaml 未找到 hoistedLocations[${carrierKey}]` };
	}
	const normalized = locations.map((location) => String(location).replace(/\\/g, "/").replace(/^\.\//, ""));
	const found = normalized.some((location) => location === expected || location.endsWith(`/${expected}`));
	if (!found) {
		return {
			ok: false,
			reason: "modules-hoisted-location-mismatch",
			detail: `hoistedLocations[${carrierKey}]=${JSON.stringify(normalized)} 期望包含 ${expected}`,
			locations: normalized,
		};
	}
	return { ok: true, reason: "ok", detail: `${carrierKey} → ${expected}`, locations: normalized };
}

/** 窄 YAML 回退：`hoistedLocations:` → 缩进键 → `- 值` 列表。 */
function parseHoistedLocationsYaml(text, carrierKey) {
	const lines = text.split(/\r?\n/);
	const start = lines.findIndex((line) => line.trim() === "hoistedLocations:");
	if (start === -1) return null;
	let keyIndent = -1;
	let collecting = false;
	let locations = null;
	for (let index = start + 1; index < lines.length; index++) {
		const line = lines[index];
		if (line.trim() === "") continue;
		const indent = indentOf(line);
		const trimmed = line.trim();
		if (!collecting) {
			if (indent === 0) return null; // 段结束
			if (trimmed.endsWith(":")) {
				const key = unquote(trimmed.slice(0, -1));
				if (key === carrierKey) {
					collecting = true;
					keyIndent = indent;
					locations = [];
				}
			}
			continue;
		}
		if (indent <= keyIndent) break;
		if (trimmed.startsWith("- ")) locations.push(unquote(trimmed.slice(2)));
	}
	return locations;
}
