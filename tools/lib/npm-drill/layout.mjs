// 安装布局的**窄结构解析**（R8 续：不新增 YAML 依赖，只解析受支持版本 pnpm 11 的已知结构）。
//
// 严格性来自复评：旧实现"在全文里找键"会被"快照移到 snapshots 之外 / alias 藏进嵌套对象 /
// 落点用前缀后缀命中"绕过。现在：
// - pnpm-lock.yaml v9：只允许顶层 `snapshots:` 段内、**直接层级**（缩进 2）的插件快照；
//   `optionalDependencies:` 必须是快照的直接子级（缩进 4）；alias 映射必须是其直接子级
//   （缩进 6）的标量键值；离开 snapshots 顶层段即停止搜索；重复键/歧义/嵌套一律失败。
// - `.modules.yaml`（pnpm 11 写 JSON，忽略注释行后解析）：`hoistedLocations[<carrier>]`
//   必须是 `string[]`；相对路径规范化后**严格等于** `node_modules/<alias>`；禁止任意前缀/
//   后缀命中与 `..` 越界；绝对路径按调用方给出的 profile 根解析后比较完整相对目标。
import path from "node:path";

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

function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 键行（`foo:`）解析为未加引号的键；不是键行返回 null。 */
function keyOfTrimmed(trimmed) {
	if (trimmed === "" || trimmed.startsWith("-") || !trimmed.endsWith(":")) return null;
	return unquote(trimmed.slice(0, -1));
}

function indexLines(text) {
	return stripCommentLines(text)
		.split(/\r?\n/)
		.map((line, index) => ({ line, index, indent: indentOf(line), trimmed: line.trim() }));
}

/**
 * 在 `snapshots:` 段里定位插件快照块，解析其 `optionalDependencies` 精确映射。
 * @returns {{ok:boolean, reason:string, detail:string, mapping?:Record<string,string>}}
 */
export function parsePnpmLockCarrierAlias(lockText, { pluginName, pluginVersion, carrierAlias }) {
	const entries = indexLines(lockText);
	const snapshotEntries = entries.filter((entry) => entry.indent === 0 && entry.trimmed === "snapshots:");
	if (snapshotEntries.length === 0) return { ok: false, reason: "lock-snapshots-missing", detail: "pnpm-lock.yaml 缺少顶层 snapshots 段" };
	if (snapshotEntries.length > 1) return { ok: false, reason: "lock-snapshots-ambiguous", detail: "pnpm-lock.yaml 出现多个顶层 snapshots 段" };
	const snapshotStart = snapshotEntries[0].index;
	// 离开顶层 snapshots 段（下一个非空且缩进 0 的行）即停止搜索。
	let segmentEnd = entries.length;
	for (const entry of entries) {
		if (entry.index > snapshotStart && entry.trimmed !== "" && entry.indent === 0) {
			segmentEnd = entry.index;
			break;
		}
	}
	const pluginKeyPrefix = `${pluginName}@${pluginVersion}`;
	const isPluginKey = (key) => key === pluginKeyPrefix || key.startsWith(`${pluginKeyPrefix}(`);
	// 插件快照只允许是 snapshots 的直接子级（缩进 2）；任何其他深度的同名键都视为歧义/越界。
	const occurrences = entries.filter((entry) => entry.index > snapshotStart && entry.index < segmentEnd
		&& isPluginKey(keyOfTrimmed(entry.trimmed) ?? ""));
	if (occurrences.length === 0) {
		return { ok: false, reason: "lock-plugin-snapshot-missing", detail: `snapshots 段内未找到 ${pluginKeyPrefix}` };
	}
	if (occurrences.length > 1) {
		return { ok: false, reason: "lock-plugin-snapshot-ambiguous", detail: `snapshots 段内出现多个 ${pluginKeyPrefix} 快照键` };
	}
	const snapshot = occurrences[0];
	if (snapshot.indent !== 2) {
		return { ok: false, reason: "lock-plugin-snapshot-not-direct", detail: `${pluginKeyPrefix} 不在 snapshots 直接层级（缩进 ${snapshot.indent}，期望 2）` };
	}
	// 快照块结束：下一个缩进 ≤ 2 的键行（或段结束）。
	let blockEnd = segmentEnd;
	for (const entry of entries) {
		if (entry.index <= snapshot.index || entry.index >= segmentEnd) continue;
		if (entry.trimmed !== "" && entry.indent <= 2 && keyOfTrimmed(entry.trimmed) !== null) {
			blockEnd = entry.index;
			break;
		}
	}
	// optionalDependencies 只允许快照的直接子级（缩进 4），且只能出现一次。
	const optionalEntries = entries.filter((entry) => entry.index > snapshot.index && entry.index < blockEnd
		&& entry.trimmed === "optionalDependencies:");
	if (optionalEntries.length === 0) {
		return { ok: false, reason: "lock-optional-dependencies-missing", detail: `${pluginKeyPrefix} 快照缺少直接子级 optionalDependencies` };
	}
	if (optionalEntries.length > 1) {
		return { ok: false, reason: "lock-optional-dependencies-ambiguous", detail: `${pluginKeyPrefix} 快照内出现多个 optionalDependencies` };
	}
	const optional = optionalEntries[0];
	if (optional.indent !== 4) {
		return { ok: false, reason: "lock-optional-dependencies-not-direct", detail: `optionalDependencies 缩进 ${optional.indent}（期望 4，必须是快照直接子级）` };
	}
	// alias 映射只允许 optionalDependencies 的直接子级（缩进 6）的标量键值。
	const mapping = {};
	for (const entry of entries) {
		if (entry.index <= optional.index || entry.index >= blockEnd) continue;
		if (entry.trimmed === "") continue;
		if (entry.indent <= optional.indent) break;
		if (entry.indent !== optional.indent + 2) {
			return {
				ok: false,
				reason: "lock-optional-dependencies-nested",
				detail: `optionalDependencies 下出现非常规层级（缩进 ${entry.indent}）：${entry.trimmed.slice(0, 80)}`,
			};
		}
		if (entry.trimmed.startsWith("-")) {
			return { ok: false, reason: "lock-optional-dependencies-not-mapping", detail: `optionalDependencies 下出现列表项：${entry.trimmed.slice(0, 80)}` };
		}
		const colon = entry.trimmed.indexOf(":");
		if (colon === -1) {
			return { ok: false, reason: "lock-optional-dependencies-not-mapping", detail: `optionalDependencies 下出现非键值行：${entry.trimmed.slice(0, 80)}` };
		}
		const key = unquote(entry.trimmed.slice(0, colon));
		const value = entry.trimmed.slice(colon + 1).trim();
		if (key === "" || value === "" || /^[{[]/.test(value) || /^[&*!|>]/.test(value)) {
			return { ok: false, reason: "lock-optional-dependencies-nested", detail: `alias 映射不是标量键值：${entry.trimmed.slice(0, 80)}` };
		}
		if (Object.hasOwn(mapping, key)) {
			return { ok: false, reason: "lock-optional-dependencies-ambiguous", detail: `optionalDependencies 出现重复键 ${key}` };
		}
		mapping[key] = unquote(value);
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
 * 规范化安装落点：拒绝 `..` 越界；绝对路径按 profileRoot 解析后要求仍在根内；
 * 相对路径规范化（反斜杠转 `/`、去掉前导 `./`）后返回，供调用方做**严格等值**比较。
 */
export function normalizeInstallLocation(value, { profileRoot = "" } = {}) {
	const raw = String(value ?? "").replace(/\\/g, "/").trim();
	if (raw === "") return { ok: false, reason: "empty-location" };
	if (raw.split("/").includes("..")) return { ok: false, reason: "path-traversal" };
	let relative = raw;
	const isAbsolutePath = raw.startsWith("/") || /^[A-Za-z]:\//.test(raw);
	if (isAbsolutePath) {
		if (profileRoot === "") return { ok: false, reason: "absolute-without-profile-root" };
		const root = path.resolve(profileRoot);
		const absolute = path.resolve(raw);
		const fromRoot = path.relative(root, absolute);
		if (fromRoot === "" || fromRoot.startsWith("..") || path.isAbsolute(fromRoot)) {
			return { ok: false, reason: "outside-profile-root" };
		}
		relative = fromRoot.replace(/\\/g, "/");
	}
	relative = path.posix.normalize(relative).replace(/^\.\//, "");
	return { ok: true, relative };
}

function validateHoistedLocations(locations, { carrierAlias, profileRoot, carrierKey }) {
	const expected = `node_modules/${carrierAlias}`;
	const normalized = [];
	for (const location of locations) {
		const parsed = normalizeInstallLocation(location, { profileRoot });
		if (!parsed.ok) {
			return { ok: false, reason: "modules-hoisted-location-invalid", detail: `hoistedLocations[${carrierKey}] 落点 ${JSON.stringify(location)} 非法：${parsed.reason}` };
		}
		normalized.push(parsed.relative);
	}
	if (!normalized.includes(expected)) {
		return {
			ok: false,
			reason: "modules-hoisted-location-mismatch",
			detail: `hoistedLocations[${carrierKey}]=${JSON.stringify(normalized)} 期望严格等于 ${expected}`,
			locations: normalized,
		};
	}
	return { ok: true, reason: "ok", detail: `${carrierKey} → ${expected}`, locations: normalized };
}

/**
 * `.modules.yaml`（pnpm 11 写 JSON）里 `hoistedLocations[<carrier>]` 的精确落点。
 * 忽略注释行后按 JSON 解析；不是 JSON 时按窄 YAML 结构解析（兼容旧 pnpm 文本格式）。
 * @returns {{ok:boolean, reason:string, detail:string, locations?:string[]}}
 */
export function parseHoistedLocations(modulesText, { carrierName, carrierVersion, carrierAlias, profileRoot = "" }) {
	const carrierKey = `${carrierName}@${carrierVersion}`;
	const cleaned = stripCommentLines(modulesText);
	let locations = null;
	try {
		const data = JSON.parse(cleaned);
		const hoisted = isPlainObject(data) && isPlainObject(data.hoistedLocations) ? data.hoistedLocations : null;
		if (hoisted === null) {
			return { ok: false, reason: "modules-hoisted-locations-missing", detail: ".modules.yaml 缺少 hoistedLocations 对象" };
		}
		if (!Object.hasOwn(hoisted, carrierKey)) {
			return { ok: false, reason: "modules-hoisted-locations-missing", detail: `hoistedLocations 缺少键 ${carrierKey}` };
		}
		const value = hoisted[carrierKey];
		if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
			return { ok: false, reason: "modules-hoisted-locations-not-string-array", detail: `hoistedLocations[${carrierKey}] 必须是 string[]（实际：${JSON.stringify(value)?.slice(0, 160)}）` };
		}
		locations = value;
	} catch {
		const yaml = parseHoistedLocationsYamlStrict(cleaned, carrierKey);
		if (!yaml.ok) return yaml;
		locations = yaml.locations;
	}
	return validateHoistedLocations(locations, { carrierAlias, profileRoot, carrierKey });
}

/** 窄 YAML 回退（旧 pnpm 文本格式）：顶层 `hoistedLocations:` → 直接子级键 → 直接子级 `- 值`。 */
function parseHoistedLocationsYamlStrict(text, carrierKey) {
	const entries = indexLines(text);
	const roots = entries.filter((entry) => entry.indent === 0 && entry.trimmed === "hoistedLocations:");
	if (roots.length === 0) return { ok: false, reason: "modules-hoisted-locations-missing", detail: "缺少 hoistedLocations 段" };
	if (roots.length > 1) return { ok: false, reason: "modules-hoisted-locations-ambiguous", detail: "出现多个 hoistedLocations 段" };
	const start = roots[0].index;
	let segmentEnd = entries.length;
	for (const entry of entries) {
		if (entry.index > start && entry.trimmed !== "" && entry.indent === 0) {
			segmentEnd = entry.index;
			break;
		}
	}
	const keys = entries.filter((entry) => entry.index > start && entry.index < segmentEnd && keyOfTrimmed(entry.trimmed) === carrierKey);
	if (keys.length === 0) return { ok: false, reason: "modules-hoisted-locations-missing", detail: `hoistedLocations 缺少键 ${carrierKey}` };
	if (keys.length > 1) return { ok: false, reason: "modules-hoisted-locations-ambiguous", detail: `hoistedLocations 出现多个 ${carrierKey}` };
	const key = keys[0];
	if (key.indent !== 2) return { ok: false, reason: "modules-hoisted-locations-not-direct", detail: `${carrierKey} 不在 hoistedLocations 直接层级（缩进 ${key.indent}）` };
	let end = segmentEnd;
	for (const entry of entries) {
		if (entry.index > key.index && entry.index < segmentEnd && entry.trimmed !== "" && entry.indent <= 2 && keyOfTrimmed(entry.trimmed) !== null) {
			end = entry.index;
			break;
		}
	}
	const locations = [];
	for (const entry of entries) {
		if (entry.index <= key.index || entry.index >= end) continue;
		if (entry.trimmed === "") continue;
		if (entry.indent !== key.indent + 2) {
			return { ok: false, reason: "modules-hoisted-locations-nested", detail: `hoistedLocations 下出现非常规层级（缩进 ${entry.indent}）` };
		}
		if (!entry.trimmed.startsWith("- ")) {
			return { ok: false, reason: "modules-hoisted-locations-not-list", detail: `hoistedLocations 下出现非列表行：${entry.trimmed.slice(0, 80)}` };
		}
		locations.push(unquote(entry.trimmed.slice(2)));
	}
	return { ok: true, locations };
}
