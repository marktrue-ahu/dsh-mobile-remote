#!/usr/bin/env node
// 桌面形态自适应（docs/design/desktop-form-adaptation.md §3）：私有网卡地址筛选、LAN 桥
// 端点选择与端口持久化。
//
// 为什么单独成模块：自适应里真正有风险的是「选」这一步——多网卡时绑哪块、状态文件坏了
// 怎么办、候选端口全被占时会不会漂到区间外、显式端口被占时会不会偷偷改端口。这些必须能
// 脱离 ctx / HTTP / 真实 listen 单独钉死，所以这里只做纯决策 + 状态文件读写；真正的
// `net.createServer().listen()` 探测由接线方以 `canBind` 注入。
//
// 约定：
// - 失败一律返回 `{ ok:false, reason }`（reason 是稳定词表），不抛异常；状态文件坏掉
//   只应让本次重新选端口，绝不能让插件启动失败；
// - 不写 stdout：日志只经注入的 `log(message)` 回调（warn 级），避免污染宿主日志格式；
// - 自动模式安全默认：只挑 RFC1918 私有 IPv4，找不到就不开桥，绝不回退 0.0.0.0。
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

/**
 * 自动模式的候选端口，顺序即探测顺序。跳过 web 宿主惯用的 3080；用满 3089 后报
 * `no-free-port` 而不是随机挑高位端口——端口要与手机端配对，漂到区间外等于不可预期。
 * @type {readonly number[]}
 */
export const BRIDGE_PORT_CANDIDATES = Object.freeze([3081, 3082, 3083, 3084, 3085, 3086, 3087, 3088, 3089]);

/** 状态文件 schema 版本；字段语义变化必须递增，旧/未知 schema 一律不信任（宁可重选端口）。 */
const BRIDGE_STATE_SCHEMA = 1;

/** profileKey 会拼进文件名：只放行安全字符，挡住 `../` 一类路径穿越。 */
const PROFILE_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

/** 严格解析点分十进制 IPv4；非 IPv4（IPv6、畸形串、越界）返回 null。 */
function parseIpv4(address) {
	if (typeof address !== "string") return null;
	const parts = address.split(".");
	if (parts.length !== 4) return null;
	const octets = [];
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const value = Number(part);
		if (value > 255) return null;
		octets.push(value);
	}
	return octets;
}

/** RFC1918 私有地址：10/8、172.16/12、192.168/16（回环/链路本地/公网自然不在此列）。 */
function isPrivateIpv4(address) {
	const octets = parseIpv4(address);
	if (!octets) return false;
	const [first, second] = octets;
	if (first === 10) return true;
	if (first === 172 && second >= 16 && second <= 31) return true;
	return first === 192 && second === 168;
}

/** 回环（127/8）与链路本地（169.254/16）：即便 internal 标记缺失也不当作局域网地址。 */
function isLoopbackOrLinkLocal(address) {
	const octets = parseIpv4(address);
	if (!octets) return false;
	return octets[0] === 127 || (octets[0] === 169 && octets[1] === 254);
}

/** Node 22 起 family 是字符串 "IPv4"，老版本是数字 4：两种都认，其余一律不算 IPv4。 */
function isIpv4Family(family) {
	return family === "IPv4" || family === 4;
}

/** 端口必须是 1..65535 的整数（0 表示"随机端口"，不是可用配置值）。 */
function isValidPort(port) {
	return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** 状态文件路径：`<dshHome>/mobile-remote/lan-bridge/<profileKey>.json`。 */
function bridgeStatePath(dshHome, profileKey) {
	return join(dshHome, "mobile-remote", "lan-bridge", `${profileKey}.json`);
}

/** 校验并拼状态文件路径；不安全/缺失的输入返回 null（调用方据此返回稳定 reason）。 */
function safeStatePath(dshHome, profileKey) {
	if (typeof dshHome !== "string" || dshHome.length === 0) return null;
	if (!isSafeProfileKey(profileKey)) return null;
	return bridgeStatePath(dshHome, profileKey);
}

function isSafeProfileKey(profileKey) {
	return (
		typeof profileKey === "string" &&
		PROFILE_KEY_PATTERN.test(profileKey) &&
		profileKey !== "." &&
		profileKey !== ".."
	);
}

/** 尽力同步目录项（平台不支持时忽略：正确性不依赖它，只有崩溃恢复语义有差异）。 */
function fsyncDir(dir) {
	try {
		const fd = openSync(dir, "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	} catch {
		// 某些文件系统不允许对目录 fsync：忽略
	}
}

/** 清理写在半途的临时文件；失败无伤大雅（残缺 .tmp 不会被读侧当作状态）。 */
function removeTempFile(file) {
	try {
		if (existsSync(file)) rmSync(file, { force: true });
	} catch {
		// 清理失败不改变本次写入结果
	}
}

/**
 * 列出可作为局域网桥绑定地址的私有 IPv4，按系统网卡顺序去重。
 * @param {NodeJS.Dict<Array<{ address: string, family: string|number, internal: boolean }>>} [interfaces]
 *   默认取 `os.networkInterfaces()`；注入形态与它一致（测试用假网卡表）。
 * @returns {string[]} 私有 IPv4 地址（可能是空数组：没有任何可用的局域网网卡）
 */
export function listPrivateIpv4(interfaces = networkInterfaces()) {
	return listPrivateEntries(interfaces).map((entry) => entry.address);
}

/** 虚拟网卡名字特征：这些网卡的私有地址通常手机不可达（WSL/Hyper-V/Docker/VMware/VirtualBox/隧道）。 */
const VIRTUAL_INTERFACE_PATTERN = /vmnet|vethernet|virtualbox|vmware|hyper-?v|wsl|docker|veth|virbr|utun|tailscale|zerotier|hamachi/i;

/**
 * 私有 IPv4 的"手机可达性"排序（越小越优先）：
 *   0 = 家庭/办公局域网常见段（192.168.x / 10.x）——手机最可能在同网段；
 *   1 = 172.16-31（常被 Docker/WSL/NAT/组网虚拟网占用）；
 *   2 = Tailscale CGNAT（100.64/10）；
 *   3 = 其它私有段。
 *
 * 为什么需要排序而不是"取第一个"：多网卡机器（Windows 的 WSL/Hyper-V、WSL 内的 docker0）
 * 常把手机不可达的私有地址排在 OS 顺序前面（真机验收实测：WSL 下 172.17.255.124 排在
 * 192.168.50.142 之前），直接取首个会把桥绑到手机连不上的地址，而诊断仍显示 listening=true。
 * @param {string} address
 * @returns {0|1|2|3}
 */
export function rankPrivateIpv4(address) {
	const octets = parseIpv4(address);
	if (!octets) return 3;
	const [first, second] = octets;
	if (first === 10 || (first === 192 && second === 168)) return 0;
	if (first === 172 && second >= 16 && second <= 31) return 1;
	if (first === 100 && second >= 64 && second <= 127) return 2;
	return 3;
}

/** 带网卡名的私有地址条目（排序需要网卡名；对外 listPrivateIpv4 仍只给地址）。 */
function listPrivateEntries(interfaces = networkInterfaces()) {
	const found = [];
	const seen = new Set();
	const table = interfaces && typeof interfaces === "object" ? interfaces : {};
	for (const [name, entries] of Object.entries(table)) {
		if (!Array.isArray(entries)) continue;
		for (const entry of entries) {
			if (!entry || typeof entry !== "object") continue;
			if (entry.internal === true) continue;
			if (!isIpv4Family(entry.family)) continue;
			if (typeof entry.address !== "string") continue;
			if (isLoopbackOrLinkLocal(entry.address)) continue;
			if (!isPrivateIpv4(entry.address)) continue;
			if (seen.has(entry.address)) continue;
			seen.add(entry.address);
			found.push({ address: entry.address, name: String(name ?? "") });
		}
	}
	return found;
}

/**
 * 首选私有 IPv4（自动模式的绑定地址），没有则 null。
 *
 * 规则：先排除"名字像虚拟网卡"的候选（仅当还有别的候选时），再按 rankPrivateIpv4 取最优、
 * 同 rank 保持网卡顺序。全被判定为虚拟网卡时回退到全部候选——宁可绑一个不确定的地址，
 * 也不要因为名字规则误判而拒绝开桥。
 * @param {NodeJS.Dict<Array<{ address: string, family: string|number, internal: boolean }>>} [interfaces]
 * @returns {string|null}
 */
export function pickPrivateAddress(interfaces = networkInterfaces()) {
	const entries = listPrivateEntries(interfaces);
	if (entries.length === 0) return null;
	const physical = entries.filter((entry) => !VIRTUAL_INTERFACE_PATTERN.test(entry.name));
	const pool = physical.length > 0 ? physical : entries;
	let best = pool[0];
	let bestRank = rankPrivateIpv4(best.address);
	for (const entry of pool) {
		const rank = rankPrivateIpv4(entry.address);
		if (rank < bestRank) {
			best = entry;
			bestRank = rank;
		}
	}
	return best.address;
}

/**
 * 读取持久化的桥端点（设计 §3.3：重启后复用端口，手机不必重扫码）。
 *
 * 状态文件只是优化，坏了必须能自愈：坏 JSON、缺字段、端口越界、未知 schema、路径不安全
 * 或不可读，一律返回 null，由上层重新选端口。
 * @param {{ dshHome?: string, profileKey?: string }} [input]
 * @returns {{ port: number, host: string } | null}
 */
export function readPersistedBridge(options = {}) {
	const { dshHome, profileKey } = options ?? {};
	const file = safeStatePath(dshHome, profileKey);
	if (!file) return null;
	let raw;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return null; // 不存在 / 不可读：都视为无持久化状态
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	if (parsed.schema !== BRIDGE_STATE_SCHEMA) return null;
	if (!isValidPort(parsed.port)) return null;
	if (typeof parsed.host !== "string" || parsed.host.length === 0) return null;
	return { port: parsed.port, host: parsed.host };
}

/**
 * 原子持久化桥端点（schema:1、0600）。
 *
 * 为什么是"同目录 tmp + rename"：崩溃/并发时读侧要么看到旧状态、要么看到完整新状态，
 * 不会读到写了一半的 JSON 而误判端口。0600 是安全契约（文件里有内网地址），显式
 * chmod 是因为 open 的 mode 会被进程 umask 影响。
 * @param {{ dshHome?: string, profileKey?: string, port?: number, host?: string }} [input]
 * @returns {{ ok: true } | { ok: false, reason: string }} reason ∈
 *   missing-dsh-home / bad-profile-key / invalid-port / invalid-host /
 *   mkdir-failed / write-failed / rename-failed
 */
export function persistBridge(options = {}) {
	const { dshHome, profileKey, port, host } = options ?? {};
	if (typeof dshHome !== "string" || dshHome.length === 0) return { ok: false, reason: "missing-dsh-home" };
	if (!isSafeProfileKey(profileKey)) return { ok: false, reason: "bad-profile-key" };
	if (!isValidPort(port)) return { ok: false, reason: "invalid-port" };
	if (typeof host !== "string" || host.length === 0) return { ok: false, reason: "invalid-host" };
	const file = bridgeStatePath(dshHome, profileKey);
	const dir = dirname(file);
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	} catch {
		return { ok: false, reason: "mkdir-failed" };
	}
	const tmp = `${file}.${process.pid}-${Math.random().toString(36).slice(2, 10)}.tmp`;
	const payload = `${JSON.stringify({ schema: BRIDGE_STATE_SCHEMA, port, host, at: new Date().toISOString() }, null, 2)}\n`;
	try {
		const fd = openSync(tmp, "wx", 0o600);
		try {
			writeFileSync(fd, payload, "utf8");
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		chmodSync(tmp, 0o600);
	} catch {
		removeTempFile(tmp);
		return { ok: false, reason: "write-failed" };
	}
	try {
		renameSync(tmp, file);
	} catch {
		removeTempFile(tmp);
		return { ok: false, reason: "rename-failed" };
	}
	fsyncDir(dir);
	return { ok: true };
}

/**
 * 选择 LAN 桥的绑定端点（host + port）。
 *
 * 优先级（设计 §3.3/§3.4，显式永远覆盖自动）：
 *   1. host：显式 `explicitHost` > `pickAddress()`（自动模式只绑私有 IPv4）；
 *      两者都没有 → `no-host`；自动模式无私有地址 → `no-private-address`（不回退 0.0.0.0）。
 *   2. port：显式 `explicitPort`（portSource=config；绑定失败即 `port-in-use`，**不自动改
 *      端口**——用户给的端口是契约）> `persisted`（portSource=persisted）> 按 `candidates`
 *      顺序探测（portSource=probe）> `no-free-port`（禁止向候选区间外漂移）。
 *
 * `canBind(host, port)` 是注入的异步谓词（生产实现用 net.createServer 试 listen 后 close；
 * 测试用假实现）。它抛异常时该端口按不可用处理——探针失败不该拖垮启动。
 * @param {{
 *   candidates?: number[],
 *   explicitPort?: number,
 *   explicitHost?: string,
 *   persisted?: { port?: unknown, host?: string } | null,
 *   canBind?: (host: string, port: number) => boolean | Promise<boolean>,
 *   pickAddress?: () => string | null,
 *   log?: (message: string) => void,
 * }} [input]
 * @returns {Promise<{ ok: true, host: string, port: number, portSource: "config"|"persisted"|"probe" }
 *   | { ok: false, reason: "no-host"|"no-private-address"|"invalid-explicit-port"|"port-in-use"|"no-free-port"|"missing-can-bind" }>}
 */
export async function selectBridgeEndpoint(options = {}) {
	const {
		candidates = BRIDGE_PORT_CANDIDATES,
		explicitPort,
		explicitHost,
		persisted,
		canBind,
		pickAddress,
		log = () => {},
	} = options ?? {};
	// 注入的日志回调也必须当成不可信输入：它抛异常不能改变选端点的结果。
	const warn = (message) => {
		try {
			log(message);
		} catch {
			// 日志失败不影响决策
		}
	};

	let host;
	if (typeof explicitHost === "string" && explicitHost.length > 0) {
		host = explicitHost;
	} else {
		if (typeof pickAddress !== "function") return { ok: false, reason: "no-host" };
		let picked;
		try {
			picked = pickAddress();
		} catch {
			picked = null;
		}
		if (typeof picked !== "string" || picked.length === 0) return { ok: false, reason: "no-private-address" };
		host = picked;
	}
	// 配置值先校验：非法端口没必要再去看绑定谓词是否可用。
	if (explicitPort !== undefined && explicitPort !== null && !isValidPort(explicitPort)) {
		return { ok: false, reason: "invalid-explicit-port" };
	}
	if (typeof canBind !== "function") return { ok: false, reason: "missing-can-bind" };

	/** 探测某个端点是否可绑；谓词异常按不可用处理（fail-closed 到下一个候选）。 */
	const bindable = async (port) => {
		try {
			return Boolean(await canBind(host, port));
		} catch (err) {
			warn(`mobile-remote: 桥端口探测异常（${host}:${port}）：${err?.message ?? err}`);
			return false;
		}
	};

	if (explicitPort !== undefined && explicitPort !== null) {
		if (await bindable(explicitPort)) return { ok: true, host, port: explicitPort, portSource: "config" };
		return { ok: false, reason: "port-in-use" };
	}

	const tried = new Set();
	const persistedPort = isValidPort(persisted?.port) ? persisted.port : null;
	if (persistedPort !== null) {
		tried.add(persistedPort);
		if (await bindable(persistedPort)) return { ok: true, host, port: persistedPort, portSource: "persisted" };
		warn(`mobile-remote: 持久化桥端口 ${persistedPort} 不可用，按候选序列重新探测`);
	}

	const list = Array.isArray(candidates) ? candidates : BRIDGE_PORT_CANDIDATES;
	for (const port of list) {
		if (!isValidPort(port)) continue;
		if (tried.has(port)) continue; // 持久化端口刚试过，不重复探测
		tried.add(port);
		if (await bindable(port)) return { ok: true, host, port, portSource: "probe" };
	}
	warn(`mobile-remote: 候选端口全部不可用（no-free-port）：${host}`);
	return { ok: false, reason: "no-free-port" };
}

// ── 运行形态证据（#36 follow-up，issue note 1509 §3）────────────────────────
//
// 为什么不能只看 profile 名/目录后缀：名字与目录都是磁盘上可被复制/伪造的弱事实。
// 0.2.1-rc.2 的真实 Desktop 链路（本机实机核验）是：
//   1. Electron 主进程（`@deepseek-ai/dsh-desktop`）用 **Electron 可执行文件 + Node 模式**
//      （`ELECTRON_RUN_AS_NODE=1`）spawn `@deepseek-ai/dsh-desktop-host` 宿主进程；
//   2. 该宿主进程硬编码 `runProfile({ profile: "desktop", resolvedProfile: {...} })`，
//      于是插件进程里的 `profileContext.name === "desktop"`、`dir === <home>/profiles/desktop`；
//   3. 该版本 Desktop profile 的 `startedBundles` 只是用户 profile 清单里的
//      `dsh-base`/`dsh-web-app`/实验 bundle，**没有 Desktop 专属 marker**（不能当证据）。
// 因此可信 Desktop 证据 = env（既有）> 服务（既有）> profileContext 身份 +
// **Electron 宿主运行标记**（`process.versions.electron`，Electron 在 Node 模式下仍保留该字段，
// 已在本机对同版本 Desktop 运行时实测）。任何一项缺失都保持 unknown/fail-closed。

/** 形态证据来源（诊断 `formSource` 的稳定词表）。 */
export const FORM_SOURCE = Object.freeze({
	ENVIRONMENT: "environment",
	SERVICE: "desktopBrowserAccess",
	PROFILE: "desktop-profile",
	UNKNOWN: "unknown",
});

/**
 * 平台可靠的目录规范化：解析 symlink/junction、去掉 `.`/`..` 与重复分隔符、统一大小写盘符。
 * 不存在/不可读返回 null（调用方据此 fail-closed，绝不拿原始字符串硬猜）。
 * @param {unknown} value
 * @param {{ realpath?: (path: string) => string }} [options]
 * @returns {string|null}
 */
export function canonicalHostPath(value, { realpath = realpathSync.native } = {}) {
	if (typeof value !== "string" || value === "") return null;
	// N4：宿主事实应为绝对路径；相对路径会按 cwd 解析而产生伪等价，直接 fail-closed。
	if (!isAbsolute(value)) return null;
	try {
		return realpath(value);
	} catch {
		return null;
	}
}

/**
 * 平台目录等价判断：Windows 覆盖盘符/大小写/分隔符/junction（realpath 解析 + 大小写不敏感），
 * 其它平台按 realpath 结果精确比较。任一侧不可规范化 → false（多义即不可信）。
 * @param {string} left
 * @param {string} right
 * @param {{ canonicalize?: (path: string) => string|null, platform?: string }} [options]
 * @returns {boolean}
 */
export function sameHostPath(left, right, { canonicalize = canonicalHostPath, platform = process.platform } = {}) {
	const a = canonicalize(left);
	const b = canonicalize(right);
	if (typeof a !== "string" || typeof b !== "string" || a === "" || b === "") return false;
	return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Desktop 宿主进程入口的**精确后缀**（Windows DSH 0.2.1-rc.2 实机核验的 argv[1] 形状）。 */
export const DESKTOP_HOST_ENTRY_SUFFIX = "@deepseek-ai/dsh-desktop-host/lib/index.js";

/** 仅做分隔符规范化（用于 marker 后缀匹配；不解析文件系统、不展开 symlink）。 */
function normalizeEntryPath(value) {
	return String(value ?? "").replace(/\\/g, "/").replace(/\/+/g, "/");
}

/** 该启动参数是否精确指向 Desktop 宿主进程入口（必须是完整路径段后缀，不接受子串）。 */
export function isDesktopHostEntry(value) {
	const entry = normalizeEntryPath(value);
	if (entry === "" || !entry.startsWith("/") && !/^[A-Za-z]:\//.test(entry) && !entry.startsWith("//")) return false;
	return entry.endsWith(`/${DESKTOP_HOST_ENTRY_SUFFIX}`);
}

/**
 * 在进程启动 argv 的**启动器控制前缀**（argv[1..3]）中查找 Desktop 宿主入口。
 *
 * 为什么不用 `argv.includes(marker)`：应用参数（用户可传）也在 argv 里，任意位置匹配会把
 * 用户参数当宿主证据；只检查 launch 前缀（argv[0] 是可执行文件，Node flags 在
 * process.execArgv，Windows 实机核验见 test/desktop-form.test.mjs 的 argv 布局断言）。
 * @param {string[]} [argv]
 * @returns {string} 命中的原始 argv 项；未命中返回 ""
 */
export function desktopHostEntryOf(argv = process.argv) {
	const list = Array.isArray(argv) ? argv : [];
	const limit = Math.min(3, list.length - 1);
	for (let index = 1; index <= limit; index += 1) {
		if (isDesktopHostEntry(list[index])) return String(list[index]);
	}
	return "";
}

/**
 * 解析当前（插件进程的）运行形态证据。
 *
 * 优先级（与 issue note 1509 一致）：
 *   1. 既有 `DSH_DESKTOP=1` 环境信号 → environment；
 *   2. 既有 `desktopBrowserAccess` 服务信号 → desktopBrowserAccess；
 *   3. 宿主提供的**当前活跃** `profileContext` + 经 Windows 实机证据核验的启动 marker：
 *      `profileContext.name==="desktop"` + canonical `dir===<home>/profiles/desktop` +
 *      `process.versions.electron` 非空 + 进程 argv 启动前缀含精确的
 *      `@deepseek-ai/dsh-desktop-host/lib/index.js` 入口 → desktop-profile；
 *   4. 其它一律 cli + source unknown（附稳定 reason，便于诊断；绝不开启自动 LAN）。
 *
 * 不采信：basename、任意 `profiles/desktop` 目录（profileContext 之外）、cwd、
 * `updateProfileDir`、`DSH_PROFILE`/shell 调用、祖先 package.json 依赖声明、其它非活跃安装。
 *
 * @param {{
 *   environment?: Record<string, string|undefined>,
 *   versions?: Record<string, string|undefined>,
 *   profileContext?: { name?: unknown, dir?: unknown, home?: unknown } | null,
 *   hasDesktopBrowserAccess?: boolean,
 *   argv?: string[],
 *   hostEntry?: string,
 *   canonicalize?: (path: string) => string|null,
 *   platform?: string,
 * }} [input]
 * @returns {{ form: "desktop"|"cli", source: string, reason: string }}
 *   reason ∈ ""（可信）、profile-context-missing、profile-context-invalid、
 *   profile-not-desktop、desktop-launch-evidence-missing、desktop-host-marker-missing、
 *   profile-dir-untrusted
 */
export function resolveRuntimeFormEvidence({
	environment = process.env,
	versions = process.versions,
	profileContext,
	hasDesktopBrowserAccess = false,
	argv,
	hostEntry,
	canonicalize,
	platform = process.platform,
} = {}) {
	if (String(environment?.DSH_DESKTOP ?? "") === "1") {
		return { form: "desktop", source: FORM_SOURCE.ENVIRONMENT, reason: "" };
	}
	if (hasDesktopBrowserAccess === true) {
		return { form: "desktop", source: FORM_SOURCE.SERVICE, reason: "" };
	}
	if (!profileContext || typeof profileContext !== "object") {
		return { form: "cli", source: FORM_SOURCE.UNKNOWN, reason: "profile-context-missing" };
	}
	const name = profileContext.name;
	const dir = profileContext.dir;
	const home = profileContext.home;
	if (typeof name !== "string" || name === "" || typeof dir !== "string" || dir === "" || typeof home !== "string" || home === "") {
		return { form: "cli", source: FORM_SOURCE.UNKNOWN, reason: "profile-context-invalid" };
	}
	if (name !== "desktop") {
		// profileContext 是宿主的可信事实：它明说了当前活跃 profile 不是 desktop → 不猜。
		return { form: "cli", source: FORM_SOURCE.UNKNOWN, reason: "profile-not-desktop" };
	}
	// 仅 name==="desktop" 不足以授权（note 1509）：必须有该版本可核验的 Desktop 启动证据。
	// 证据 1：进程确实运行在 Electron 运行时里（Node 模式也会保留该字段）。
	const electron = typeof versions?.electron === "string" ? versions.electron : "";
	if (electron === "") {
		return { form: "cli", source: FORM_SOURCE.UNKNOWN, reason: "desktop-launch-evidence-missing" };
	}
	// 证据 2（W2）：启动 argv 前缀必须精确指向 Desktop 私有宿主入口
	// `@deepseek-ai/dsh-desktop-host/lib/index.js`。只靠 Electron 运行时不足以证明宿主身份
	// （任意 Electron 应用都可能承载 dsh profile）；startedBundles 在本版本没有 Desktop marker。
	const resolvedHostEntry = typeof hostEntry === "string" ? hostEntry : desktopHostEntryOf(argv ?? process.argv);
	if (!isDesktopHostEntry(resolvedHostEntry)) {
		return { form: "cli", source: FORM_SOURCE.UNKNOWN, reason: "desktop-host-marker-missing" };
	}
	// 目录必须是宿主管理根下的 desktop 实际目录（平台可靠等价，覆盖盘符/大小写/分隔符/junction）。
	if (!sameHostPath(dir, join(home, "profiles", "desktop"), { canonicalize, platform })) {
		return { form: "cli", source: FORM_SOURCE.UNKNOWN, reason: "profile-dir-untrusted" };
	}
	return { form: "desktop", source: FORM_SOURCE.PROFILE, reason: "" };
}

// ── 手机端点视图（#36 follow-up，issue note 1509 §5）─────────────────────────
//
// 唯一权威：**真实监听事实** + 显式配置。绝不把"私有 IP + 回环 webserver 端口"拼成
// 看似 LAN 的地址（#36 实机误导 URL 的根因）。内部 worker/监督器 locator 不经过这里。

/** 回环主机名：localhost、127/8、IPv6 ::1、IPv4-mapped 回环（URL.hostname 可能带方括号）。 */
export function isLoopbackHostname(value) {
	let host = String(value ?? "").trim().toLowerCase();
	if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
	if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
	if (host.startsWith("::ffff:")) {
		// IPv4-mapped：点分形式递归；URL 规范化后的十六进制形式（如 ::ffff:7f00:1）解析最后 32 位。
		const mapped = host.slice("::ffff:".length);
		if (mapped.includes(".")) return isLoopbackHostname(mapped);
		const parts = mapped.split(":");
		if (parts.length === 2 && parts.every((part) => /^[0-9a-f]{1,4}$/.test(part))) {
			const address = ((parseInt(parts[0], 16) << 16) | parseInt(parts[1], 16)) >>> 0;
			return ((address >>> 24) & 0xff) === 127;
		}
		return false;
	}
	if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
	const first = Number(host.split(".")[0]);
	return first === 127;
}

/** 未指定/通配主机名：0.0.0.0、::、0:0:0:0:0:0:0:0。 */
export function isUnspecifiedHostname(value) {
	let host = String(value ?? "").trim().toLowerCase();
	if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
	return host === "0.0.0.0" || host === "::" || host === "0:0:0:0:0:0:0:0";
}

/** 取 URL 的 hostname（小写、去 IPv6 方括号）；非 http(s)/不可解析返回 ""。 */
function originHostname(origin) {
	try {
		const url = new URL(String(origin));
		if (url.protocol !== "http:" && url.protocol !== "https:") return "";
		return String(url.hostname ?? "").toLowerCase();
	} catch {
		return "";
	}
}

/** 端点不可用时的稳定 hint（可执行、不含本机路径/凭据）。 */
function endpointHint(reason, fallback = "") {
	switch (reason) {
	case "bridge-starting":
		return "LAN 桥正在启动，请稍候；连接页会自动重试（也可点「刷新连接信息」）。";
	case "loopback-only":
		return "电脑端 webserver 只监听回环地址且 LAN 桥未监听，手机无法连接。请在有局域网的桌面形态下运行，或显式配置 lanBridge.enabled/port；也可配置 publicOrigin/受信代理地址。";
	case "bridge-failed":
		return fallback !== "" ? fallback : "LAN 桥启动失败；请在电脑诊断页查看 lanBridge.reason 后重试。";
	case "bridge-disabled":
		return fallback !== "" ? fallback : "LAN 桥已按显式配置关闭；如手机需要连接请显式配置 lanBridge.enabled:true。";
	case "form-unknown":
		return fallback !== "" ? fallback : "宿主形态无法可信判定，未自动开启 LAN 桥；请显式配置 lanBridge.enabled:true。";
	case "no-private-address":
		return fallback !== "" ? fallback : "未找到私有局域网地址；请连接局域网或显式配置 lanBridge.host。";
	case "no-free-port":
		return fallback !== "" ? fallback : "候选端口 3081-3089 均不可用；请释放端口或显式配置 lanBridge.port。";
	case "ipv6-listener-unsupported":
		return "当前监听为 IPv6-only，暂不生成 IPv4 手机地址；请显式配置 IPv4 host（如 0.0.0.0 或具体局域网地址）。";
	case "address-unavailable":
		return "未找到可用的局域网 IPv4 地址；请连接局域网或配置 publicOrigin/受信代理地址。";
	default:
		return fallback;
	}
}

/** 视图对象工厂（统一 shape，避免调用方各拼一套）。 */
function endpointView(state, source, origins, reason) {
	return {
		state,
		source,
		origins,
		reason,
		hint: state === "ready" ? "" : endpointHint(reason),
	};
}

/**
 * 计算"手机可用端点"视图（纯函数；真实监听事实/显式配置来自调用方）。
 *
 * 选择顺序（note 1509 §5）：
 *   1. 显式 `publicOrigin`（合法、非回环/通配）；
 *   2. **已真实监听**的 LAN 桥：具体 IP 只发布该 IP；通配 0.0.0.0 才枚举适用 IPv4 网卡；
 *      绑到回环的桥不算手机端点；
 *   3. webserver 实际可对外的监听端点（具体非回环 IP，或通配时枚举 IPv4 网卡）；
 *   4. 否则 `starting`（桥正在启动）或 `unavailable`（稳定 reason）。
 * IPv6-only 监听（host 为 `::`）不捏造 IPv4 候选：返回 ipv6-listener-unsupported。
 *
 * @param {{
 *   configuredOrigin?: string|null,
 *   bridge?: { phase?: string, listening?: boolean, host?: string, port?: number, reason?: string, hint?: string },
 *   webServer?: { host?: string, port?: number },
 *   addresses?: string[],
 * }} [input]
 * @returns {{ state: "ready"|"starting"|"unavailable", source: "configured"|"lan-bridge"|"web-lan"|"none",
 *   origins: string[], reason: string, hint: string }}
 */
export function buildPhoneEndpointView({ configuredOrigin, bridge, webServer, addresses = [] } = {}) {
	const cleanAddresses = [];
	for (const value of Array.isArray(addresses) ? addresses : []) {
		const address = String(value ?? "").trim();
		if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) continue;
		if (isLoopbackHostname(address) || isUnspecifiedHostname(address)) continue;
		if (!cleanAddresses.includes(address)) cleanAddresses.push(address);
	}

	// 1) 显式对外基址：合法、非回环、非通配才认。
	if (typeof configuredOrigin === "string" && configuredOrigin !== "") {
		const hostname = originHostname(configuredOrigin);
		if (hostname !== "" && !isLoopbackHostname(hostname) && !isUnspecifiedHostname(hostname)) {
			return endpointView("ready", "configured", [configuredOrigin], "");
		}
	}

	const bridgeState = bridge && typeof bridge === "object" ? bridge : {};
	const bridgePhase = typeof bridgeState.phase === "string"
		? bridgeState.phase
		: (bridgeState.listening === true ? "listening" : "pending");
	const bridgePort = Number(bridgeState.port);
	const bridgeListening = bridgePhase === "listening" && Number.isInteger(bridgePort) && bridgePort >= 1 && bridgePort <= 65535;

	// 2) 已真实监听的 LAN 桥：只按实际 bind 事实生成。
	if (bridgeListening) {
		const host = String(bridgeState.host ?? "").trim();
		if (!isLoopbackHostname(host)) {
			if (isUnspecifiedHostname(host)) {
				if (host.includes(":")) return endpointView("unavailable", "none", [], "ipv6-listener-unsupported");
				const origins = cleanAddresses.map((address) => `http://${address}:${bridgePort}`);
				return origins.length > 0
					? endpointView("ready", "lan-bridge", origins, "")
					: endpointView("unavailable", "none", [], "address-unavailable");
			}
			if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
				return endpointView("ready", "lan-bridge", [`http://${host}:${bridgePort}`], "");
			}
			// N1：具体 IPv6 监听（非 :: 通配、非回环）同样不能捏造 IPv4 候选。
			if (host.includes(":")) return endpointView("unavailable", "none", [], "ipv6-listener-unsupported");
		}
		// 桥绑在回环上：手机不可达，继续看 webserver 的真实监听面。
	}

	// 3) webserver 实际监听面（桌面版恒回环；web 版可能 0.0.0.0/具体网卡）。
	const web = webServer && typeof webServer === "object" ? webServer : {};
	const webHost = String(web.host ?? "").trim();
	const webPort = Number(web.port);
	const webPortValid = Number.isInteger(webPort) && webPort >= 1 && webPort <= 65535;
	if (webPortValid && webHost !== "" && !isLoopbackHostname(webHost)) {
		if (isUnspecifiedHostname(webHost)) {
			if (webHost.includes(":")) return endpointView("unavailable", "none", [], "ipv6-listener-unsupported");
			const origins = cleanAddresses.map((address) => `http://${address}:${webPort}`);
			return origins.length > 0
				? endpointView("ready", "web-lan", origins, "")
				: endpointView("unavailable", "none", [], "address-unavailable");
		}
		if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(webHost)) {
			return endpointView("ready", "web-lan", [`http://${webHost}:${webPort}`], "");
		}
		// N1：具体 IPv6 监听（如 fe80::1/2001:db8::1）返回稳定 ipv6-listener-unsupported，
		// 而不是落到 loopback-only/form-unknown 等误导性通用原因。
		if (webHost.includes(":")) return endpointView("unavailable", "none", [], "ipv6-listener-unsupported");
	}

	// 4) 都不可达：桥正在启动 → starting；否则稳定 reason（优先反映桥决策原因）。
	if (bridgePhase === "starting" || bridgePhase === "pending") {
		return endpointView("starting", "none", [], "bridge-starting");
	}
	const bridgeReason = typeof bridgeState.reason === "string" && bridgeState.reason !== "" ? bridgeState.reason : "";
	const bridgeHint = typeof bridgeState.hint === "string" ? bridgeState.hint : "";
	// 桥"listening 但绑回环"不是失败，只是手机不可达 → 落到最后的 loopback-only；
	// 真正启动失败时保留桥决策的稳定 reason（listen-error/no-free-port/auth-not-configured…），
	// 便于连接页直接显示可执行原因；没有具体原因才退回 bridge-failed。
	if (bridgePhase === "failed") {
		const reason = bridgeReason !== "" ? bridgeReason : "bridge-failed";
		return { state: "unavailable", source: "none", origins: [], reason, hint: endpointHint(reason, bridgeHint) };
	}
	if (bridgePhase === "disabled") {
		return { state: "unavailable", source: "none", origins: [], reason: "bridge-disabled", hint: endpointHint("bridge-disabled", bridgeHint) };
	}
	if (bridgePhase === "skipped" && bridgeReason !== "") {
		return { state: "unavailable", source: "none", origins: [], reason: bridgeReason, hint: endpointHint(bridgeReason, bridgeHint) };
	}
	return {
		state: "unavailable",
		source: "none",
		origins: [],
		reason: "loopback-only",
		hint: endpointHint("loopback-only"),
	};
}
