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
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";

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
