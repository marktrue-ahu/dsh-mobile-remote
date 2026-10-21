// 桌面形态自适应（docs/design/desktop-form-adaptation.md §3）的语义契约：
// 自动开桥的正确性全在「选哪个地址、选哪个端口、坏状态怎么办」上，因此这里把纯决策
// 模块的每条边界钉死——真实 listen / ctx / 诊断接线由接线方另行测试。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	BRIDGE_PORT_CANDIDATES,
	listPrivateIpv4,
	persistBridge,
	rankPrivateIpv4,
	pickPrivateAddress,
	readPersistedBridge,
	selectBridgeEndpoint,
} from "../lib/desktop-form.js";

/** root 无视文件权限位，两个依赖 EACCES 的用例需要跳过（本地/CI 通常非 root）。 */
const asRoot = process.getuid?.() === 0;

const BRIDGE_DIR_PARTS = ["mobile-remote", "lan-bridge"];

/** 建一个隔离 HOME（测试绝不碰真实 ~/.dsh）。 */
async function makeHome() {
	return mkdtemp(join(tmpdir(), "desktop-form-"));
}

async function cleanup(dir) {
	await rm(dir, { recursive: true, force: true });
}

/** 假网卡表：地址 -> 条目；用于私有地址筛选。 */
function nic(address, { family = "IPv4", internal = false } = {}) {
	return { address, family, internal };
}

/** 模拟绑定谓词：occupied 内的端口"被占"，其余可绑；记录调用顺序。 */
function bindProbe(occupied = []) {
	const calls = [];
	const occupiedSet = new Set(occupied);
	const canBind = async (host, port) => {
		calls.push([host, port]);
		return !occupiedSet.has(port);
	};
	return { calls, canBind };
}

const autoHost = () => "192.168.1.20";

test("候选端口固定为 3081..3089（避开 web 宿主 3080，且不可被调用方改写）", () => {
	assert.deepEqual([...BRIDGE_PORT_CANDIDATES], [3081, 3082, 3083, 3084, 3085, 3086, 3087, 3088, 3089]);
	assert.equal(Object.isFrozen(BRIDGE_PORT_CANDIDATES), true);
});

test("私有地址筛选：只保留 RFC1918 IPv4，排除回环/链路本地/公网/IPv6/internal 网卡", () => {
	const interfaces = {
		lo: [nic("127.0.0.1", { internal: true })],
		eth0: [nic("192.168.1.20"), nic("fe80::1", { family: "IPv6" })],
		wlan0: [nic("10.0.0.5")],
		docker0: [nic("172.17.0.1")],
		wan: [nic("203.0.113.7")],
		link: [nic("169.254.10.3")],
		vpn: [nic("10.8.0.2", { internal: true })],
	};
	assert.deepEqual(listPrivateIpv4(interfaces), ["192.168.1.20", "10.0.0.5", "172.17.0.1"]);
});

test("172.16/12 边界：172.16–172.31 计入，172.15/172.32 不计入", () => {
	const interfaces = {
		a: [nic("172.16.0.1")],
		b: [nic("172.31.255.254")],
		c: [nic("172.15.0.1")],
		d: [nic("172.32.0.1")],
	};
	assert.deepEqual(listPrivateIpv4(interfaces), ["172.16.0.1", "172.31.255.254"]);
});

test("internal 网卡即使地址形似私有也不当作局域网地址（不让 VPN/回环冒充）", () => {
	const interfaces = { vpn: [nic("10.8.0.2", { internal: true })], lo: [nic("127.0.0.1", { internal: true })] };
	assert.deepEqual(listPrivateIpv4(interfaces), []);
	assert.equal(pickPrivateAddress(interfaces), null);
});

test("只有回环与公网时无私有地址（自动模式必须据此拒绝开桥，绝不放宽到 0.0.0.0）", () => {
	const interfaces = {
		lo: [nic("127.0.0.1", { internal: true })],
		eth0: [nic("203.0.113.7")],
	};
	assert.deepEqual(listPrivateIpv4(interfaces), []);
	assert.equal(pickPrivateAddress(interfaces), null);
});

test("兼容老内核的数字 family（4）；重复地址去重；畸形/非 IPv4 地址跳过", () => {
	const interfaces = {
		eth0: [
			nic("192.168.1.30", { family: 4 }),
			nic("192.168.1.30"), // 同一地址挂在多个条目：只保留一次
			nic("192.168.1.256"), // 越界
			nic("not-an-ip"), // 畸形
			nic("10.0.0"), // 段数不足
		],
		eth1: [nic("10.1.2.3")],
	};
	assert.deepEqual(listPrivateIpv4(interfaces), ["192.168.1.30", "10.1.2.3"]);
	assert.equal(pickPrivateAddress(interfaces), "192.168.1.30");
});

test("默认读取真实网卡：每一项都必须是私有 IPv4，pick 是 list 中可达性最优的一项（环境无关断言）", () => {
	const list = listPrivateIpv4();
	assert.ok(Array.isArray(list));
	for (const address of list) {
		assert.match(address, /^(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})$/);
	}
	const picked = pickPrivateAddress();
	if (list.length === 0) {
		assert.equal(picked, null);
	} else {
		assert.ok(list.includes(picked), "pick 必须来自 list");
		// 不可达性排序：选出的地址 rank 必须等于 list 中的最小 rank（同 rank 取先出现的）。
		const bestRank = Math.min(...list.map((address) => rankPrivateIpv4(address)));
		assert.equal(rankPrivateIpv4(picked), bestRank);
	}
	assert.deepEqual(listPrivateIpv4({}), []);
});

test("自动模式地址排序：192.168/10 优先于 172.16-31（避免把桥绑到 Docker/WSL 虚拟网卡）", () => {
	const interfaces = {
		"vEthernet (WSL)": [nic("172.17.255.124")],
		eth0: [nic("172.17.0.2")],
		wlan0: [nic("192.168.50.142")],
	};
	assert.equal(pickPrivateAddress(interfaces), "192.168.50.142");
	// 只有 172.16-31 时仍要能用（回退，不拒绝开桥）
	assert.equal(pickPrivateAddress({ docker0: [nic("172.17.0.1")] }), "172.17.0.1");
});

test("虚拟网卡名字优先排除：有物理网卡时选物理网卡（Docker/Hyper-V/WSL/Tailscale 名称）", () => {
	const interfaces = {
		docker0: [nic("10.0.0.9")],
		"vEthernet (Default Switch)": [nic("10.0.0.10")],
		"Hyper-V Virtual": [nic("10.0.0.11")],
		wlan0: [nic("10.0.0.12")],
	};
	assert.equal(pickPrivateAddress(interfaces), "10.0.0.12");
});


test("persistBridge：递归建目录、文件 0600、目录 0700、schema:1 与 ISO 时间戳", async () => {
	const home = await makeHome();
	try {
		const dshHome = join(home, "nested", ".dsh");
		assert.deepEqual(persistBridge({ dshHome, profileKey: "web", port: 3083, host: "192.168.1.20" }), { ok: true });
		const file = join(dshHome, ...BRIDGE_DIR_PARTS, "web.json");
		const fileStat = await stat(file);
		assert.equal(fileStat.mode & 0o777, 0o600);
		const dirStat = await stat(join(dshHome, ...BRIDGE_DIR_PARTS));
		assert.equal(dirStat.mode & 0o777, 0o700);
		const raw = JSON.parse(await readFile(file, "utf8"));
		assert.deepEqual(Object.keys(raw).sort(), ["at", "host", "port", "schema"]);
		assert.equal(raw.schema, 1);
		assert.equal(raw.port, 3083);
		assert.equal(raw.host, "192.168.1.20");
		assert.equal(new Date(raw.at).toISOString(), raw.at); // 必须是可解析的 ISO 时间
	} finally {
		await cleanup(home);
	}
});

test("readPersistedBridge：写后可读且只暴露 {port, host}；未写过返回 null", async () => {
	const home = await makeHome();
	try {
		const dshHome = join(home, ".dsh");
		assert.equal(readPersistedBridge({ dshHome, profileKey: "web" }), null);
		persistBridge({ dshHome, profileKey: "web", port: 3087, host: "10.0.0.5" });
		assert.deepEqual(readPersistedBridge({ dshHome, profileKey: "web" }), { port: 3087, host: "10.0.0.5" });
	} finally {
		await cleanup(home);
	}
});

test("readPersistedBridge：坏 JSON/缺字段/越界端口/未知 schema/越权 profileKey 一律 null（不抛异常）", async () => {
	const home = await makeHome();
	try {
		const dshHome = join(home, ".dsh");
		const dir = join(dshHome, ...BRIDGE_DIR_PARTS);
		await mkdir(dir, { recursive: true });
		const cases = [
			["broken", "{not json"],
			["empty", ""],
			["null", "null"],
			["array", "[]"],
			["no-port", JSON.stringify({ schema: 1, host: "10.0.0.5" })],
			["no-host", JSON.stringify({ schema: 1, port: 3081 })],
			["string-port", JSON.stringify({ schema: 1, port: "3081", host: "10.0.0.5" })],
			["zero-port", JSON.stringify({ schema: 1, port: 0, host: "10.0.0.5" })],
			["range-port", JSON.stringify({ schema: 1, port: 70000, host: "10.0.0.5" })],
			["float-port", JSON.stringify({ schema: 1, port: 3081.5, host: "10.0.0.5" })],
			["empty-host", JSON.stringify({ schema: 1, port: 3081, host: "" })],
			["future-schema", JSON.stringify({ schema: 2, port: 3081, host: "10.0.0.5" })],
			["missing-schema", JSON.stringify({ port: 3081, host: "10.0.0.5" })],
		];
		for (const [profileKey, content] of cases) {
			await writeFile(join(dir, `${profileKey}.json`), content);
			assert.equal(readPersistedBridge({ dshHome, profileKey }), null, profileKey);
		}
		// 路径穿越/在校外：直接判无状态，不去读任意文件
		assert.equal(readPersistedBridge({ dshHome, profileKey: "../escape" }), null);
		assert.equal(readPersistedBridge({ dshHome, profileKey: "a/b" }), null);
		assert.equal(readPersistedBridge({ dshHome, profileKey: ".." }), null);
		assert.equal(readPersistedBridge({}), null);
		assert.equal(readPersistedBridge(), null);
	} finally {
		await cleanup(home);
	}
});

test("readPersistedBridge：状态文件不可读时视为无状态（自愈，不让坏权限阻断启动）", { skip: asRoot ? "root 无视权限位" : false }, async () => {
	const home = await makeHome();
	try {
		const dshHome = join(home, ".dsh");
		persistBridge({ dshHome, profileKey: "web", port: 3081, host: "10.0.0.5" });
		const file = join(dshHome, ...BRIDGE_DIR_PARTS, "web.json");
		await chmod(file, 0o000);
		try {
			assert.equal(readPersistedBridge({ dshHome, profileKey: "web" }), null);
		} finally {
			await chmod(file, 0o600); // 恢复以便清理
		}
	} finally {
		await cleanup(home);
	}
});

test("persistBridge：profileKey 相互隔离，重复写以最后一次为准", async () => {
	const home = await makeHome();
	try {
		const dshHome = join(home, ".dsh");
		persistBridge({ dshHome, profileKey: "web", port: 3081, host: "10.0.0.5" });
		persistBridge({ dshHome, profileKey: "desktop", port: 3082, host: "10.0.0.6" });
		assert.deepEqual(readPersistedBridge({ dshHome, profileKey: "web" }), { port: 3081, host: "10.0.0.5" });
		assert.deepEqual(readPersistedBridge({ dshHome, profileKey: "desktop" }), { port: 3082, host: "10.0.0.6" });
		persistBridge({ dshHome, profileKey: "web", port: 3089, host: "192.168.1.20" });
		assert.deepEqual(readPersistedBridge({ dshHome, profileKey: "web" }), { port: 3089, host: "192.168.1.20" });
	} finally {
		await cleanup(home);
	}
});

test("persistBridge：非法输入返回稳定 reason，且不落任何文件（含路径穿越防护）", async () => {
	const home = await makeHome();
	try {
		const dshHome = join(home, ".dsh");
		const cases = [
			[{ profileKey: "web", port: 3081, host: "10.0.0.5" }, "missing-dsh-home"],
			[{ dshHome: "", profileKey: "web", port: 3081, host: "10.0.0.5" }, "missing-dsh-home"],
			[{ dshHome, profileKey: "../escape", port: 3081, host: "10.0.0.5" }, "bad-profile-key"],
			[{ dshHome, profileKey: "a/b", port: 3081, host: "10.0.0.5" }, "bad-profile-key"],
			[{ dshHome, profileKey: "..", port: 3081, host: "10.0.0.5" }, "bad-profile-key"],
			[{ dshHome, profileKey: "web", port: 0, host: "10.0.0.5" }, "invalid-port"],
			[{ dshHome, profileKey: "web", port: 70000, host: "10.0.0.5" }, "invalid-port"],
			[{ dshHome, profileKey: "web", port: "3081", host: "10.0.0.5" }, "invalid-port"],
			[{ dshHome, profileKey: "web", port: 3081, host: "" }, "invalid-host"],
			[{ dshHome, profileKey: "web", port: 3081 }, "invalid-host"],
		];
		for (const [input, reason] of cases) {
			assert.deepEqual(persistBridge(input), { ok: false, reason }, JSON.stringify(input));
		}
		await assert.rejects(stat(dshHome), { code: "ENOENT" }); // 校验失败必须在 mkdir 之前
	} finally {
		await cleanup(home);
	}
});

test("persistBridge：目录不可写时返回 mkdir-failed（不抛异常、不影响启动）", { skip: asRoot ? "root 无视权限位" : false }, async () => {
	const home = await makeHome();
	try {
		const dshHome = join(home, ".dsh");
		const parent = join(dshHome, "mobile-remote");
		await mkdir(parent, { recursive: true });
		await chmod(parent, 0o500);
		try {
			assert.deepEqual(persistBridge({ dshHome, profileKey: "web", port: 3081, host: "10.0.0.5" }), {
				ok: false,
				reason: "mkdir-failed",
			});
		} finally {
			await chmod(parent, 0o700); // 恢复以便清理
		}
	} finally {
		await cleanup(home);
	}
});

test("persistBridge：原子写（同目录 tmp + rename），无残留临时文件，重写换 inode 而非原地截断", async () => {
	const home = await makeHome();
	try {
		const dshHome = join(home, ".dsh");
		const dir = join(dshHome, ...BRIDGE_DIR_PARTS);
		const file = join(dir, "web.json");
		persistBridge({ dshHome, profileKey: "web", port: 3081, host: "10.0.0.5" });
		const before = await stat(file);
		assert.deepEqual(await readdir(dir), ["web.json"]);
		persistBridge({ dshHome, profileKey: "web", port: 3082, host: "10.0.0.5" });
		const after = await stat(file);
		// 原地截断会复用 inode；rename 发布一定换成新 inode（读侧只会看到旧或完整新状态）
		assert.notEqual(after.ino, before.ino);
		assert.deepEqual(await readdir(dir), ["web.json"]);
		assert.equal(JSON.parse(await readFile(file, "utf8")).port, 3082);
	} finally {
		await cleanup(home);
	}
});

test("闭环：persistBridge 写 → readPersistedBridge 读 → selectBridgeEndpoint 复用 persisted 端口", async () => {
	const home = await makeHome();
	try {
		const dshHome = join(home, ".dsh");
		assert.deepEqual(persistBridge({ dshHome, profileKey: "web", port: 3084, host: "192.168.1.20" }), { ok: true });
		const persisted = readPersistedBridge({ dshHome, profileKey: "web" });
		const { calls, canBind } = bindProbe();
		const result = await selectBridgeEndpoint({ canBind, pickAddress: autoHost, persisted });
		assert.deepEqual(result, { ok: true, host: "192.168.1.20", port: 3084, portSource: "persisted" });
		assert.deepEqual(calls, [["192.168.1.20", 3084]]);
	} finally {
		await cleanup(home);
	}
});

test("selectBridgeEndpoint：显式 host + 显式 port 直接采用，portSource=config", async () => {
	const { calls, canBind } = bindProbe();
	const result = await selectBridgeEndpoint({ explicitHost: "0.0.0.0", explicitPort: 3080, canBind, pickAddress: autoHost });
	assert.deepEqual(result, { ok: true, host: "0.0.0.0", port: 3080, portSource: "config" });
	assert.deepEqual(calls, [["0.0.0.0", 3080]]);
});

test("selectBridgeEndpoint：显式端口被占返回 port-in-use，只试一次、绝不自动换端口", async () => {
	const { calls, canBind } = bindProbe([3080]);
	const result = await selectBridgeEndpoint({ explicitHost: "0.0.0.0", explicitPort: 3080, canBind, pickAddress: autoHost });
	assert.deepEqual(result, { ok: false, reason: "port-in-use" });
	assert.deepEqual(calls, [["0.0.0.0", 3080]]); // 没有去 probe 候选序列
});

test("selectBridgeEndpoint：显式端口非法（0/越界/小数/字符串）返回 invalid-explicit-port 且不探测", async () => {
	for (const explicitPort of [0, 70000, 1.5, "3081"]) {
		const { calls, canBind } = bindProbe();
		const result = await selectBridgeEndpoint({ explicitHost: "0.0.0.0", explicitPort, canBind, pickAddress: autoHost });
		assert.deepEqual(result, { ok: false, reason: "invalid-explicit-port" }, String(explicitPort));
		assert.deepEqual(calls, []);
	}
});

test("selectBridgeEndpoint：自动 host 来自 pickAddress()（只绑私有 IPv4），显式端口仍优先", async () => {
	const { calls, canBind } = bindProbe();
	const result = await selectBridgeEndpoint({ explicitPort: 3090, canBind, pickAddress: autoHost });
	assert.deepEqual(result, { ok: true, host: "192.168.1.20", port: 3090, portSource: "config" });
	assert.deepEqual(calls, [["192.168.1.20", 3090]]);
});

test("selectBridgeEndpoint：显式 host 为空串视为未配置，回退 pickAddress()", async () => {
	const { canBind } = bindProbe();
	const result = await selectBridgeEndpoint({ explicitHost: "", explicitPort: 3080, canBind, pickAddress: autoHost });
	assert.equal(result.host, "192.168.1.20");
});

test("selectBridgeEndpoint：自动 host 无私有地址（含 pickAddress 抛异常）→ no-private-address，不试绑定", async () => {
	const { calls, canBind } = bindProbe();
	const none = await selectBridgeEndpoint({ canBind, pickAddress: () => null });
	assert.deepEqual(none, { ok: false, reason: "no-private-address" });
	const thrown = await selectBridgeEndpoint({ canBind, pickAddress: () => {
		throw new Error("boom");
	} });
	assert.deepEqual(thrown, { ok: false, reason: "no-private-address" });
	assert.deepEqual(calls, []);
});

test("selectBridgeEndpoint：无 host 来源 → no-host；缺 canBind → missing-can-bind（fail-closed）", async () => {
	assert.deepEqual(await selectBridgeEndpoint({ canBind: async () => true }), { ok: false, reason: "no-host" });
	assert.deepEqual(await selectBridgeEndpoint({ pickAddress: autoHost }), { ok: false, reason: "missing-can-bind" });
	assert.deepEqual(await selectBridgeEndpoint({}), { ok: false, reason: "no-host" });
});

test("selectBridgeEndpoint：persisted 端口可绑 → portSource=persisted，候选序列不再探测", async () => {
	const { calls, canBind } = bindProbe();
	const result = await selectBridgeEndpoint({ canBind, pickAddress: autoHost, persisted: { port: 3085, host: "192.168.1.99" } });
	assert.deepEqual(result, { ok: true, host: "192.168.1.20", port: 3085, portSource: "persisted" });
	assert.deepEqual(calls, [["192.168.1.20", 3085]]); // host 始终按本次网卡重选，不用状态文件里的旧值
});

test("selectBridgeEndpoint：persisted 被占 → 按 3081.. 顺序 probe，且不重复探测持久化端口", async () => {
	const { calls, canBind } = bindProbe([3081, 3082]); // persisted=3081 被占，3081 也在候选里
	const result = await selectBridgeEndpoint({ canBind, pickAddress: autoHost, persisted: { port: 3081, host: "192.168.1.20" } });
	assert.deepEqual(result, { ok: true, host: "192.168.1.20", port: 3083, portSource: "probe" });
	assert.deepEqual(calls, [
		["192.168.1.20", 3081],
		["192.168.1.20", 3082],
		["192.168.1.20", 3083],
	]);
});

test("selectBridgeEndpoint：无 persisted 时从候选首个可用端口开始（默认 3081）", async () => {
	const { calls, canBind } = bindProbe();
	const result = await selectBridgeEndpoint({ canBind, pickAddress: autoHost });
	assert.deepEqual(result, { ok: true, host: "192.168.1.20", port: 3081, portSource: "probe" });
	assert.deepEqual(calls, [["192.168.1.20", 3081]]);
});

test("selectBridgeEndpoint：候选全占用 → no-free-port，且不向候选区间外漂移", async () => {
	const { calls, canBind } = bindProbe([...BRIDGE_PORT_CANDIDATES]);
	const result = await selectBridgeEndpoint({ canBind, pickAddress: autoHost });
	assert.deepEqual(result, { ok: false, reason: "no-free-port" });
	assert.deepEqual(
		calls.map(([, port]) => port),
		[...BRIDGE_PORT_CANDIDATES],
	);
});

test("selectBridgeEndpoint：自定义候选按给定顺序探测；空候选序列直接 no-free-port", async () => {
	const custom = bindProbe([4101]);
	const ok = await selectBridgeEndpoint({ candidates: [4101, 4102], canBind: custom.canBind, pickAddress: autoHost });
	assert.deepEqual(ok, { ok: true, host: "192.168.1.20", port: 4102, portSource: "probe" });
	const empty = bindProbe();
	const none = await selectBridgeEndpoint({ candidates: [], canBind: empty.canBind, pickAddress: autoHost });
	assert.deepEqual(none, { ok: false, reason: "no-free-port" });
	assert.deepEqual(empty.calls, []);
});

test("selectBridgeEndpoint：persisted 端口不可信（字符串/越界）时忽略，直接探测候选", async () => {
	for (const port of ["3081", 70000, null]) {
		const { calls, canBind } = bindProbe();
		const result = await selectBridgeEndpoint({ canBind, pickAddress: autoHost, persisted: { port, host: "10.0.0.5" } });
		assert.deepEqual(result, { ok: true, host: "192.168.1.20", port: 3081, portSource: "probe" }, String(port));
		assert.deepEqual(calls, [["192.168.1.20", 3081]]);
	}
});

test("selectBridgeEndpoint：绑定谓词抛异常视为该端口不可用（继续探测 / 显式端口报 port-in-use）", async () => {
	const calls = [];
	let attempts = 0;
	const canBind = async (host, port) => {
		calls.push([host, port]);
		attempts += 1;
		if (attempts === 1) throw new Error("boom");
		return true;
	};
	const probed = await selectBridgeEndpoint({ canBind, pickAddress: autoHost });
	assert.deepEqual(probed, { ok: true, host: "192.168.1.20", port: 3082, portSource: "probe" });
	assert.deepEqual(calls, [
		["192.168.1.20", 3081],
		["192.168.1.20", 3082],
	]);
	const explicit = await selectBridgeEndpoint({
		explicitHost: "10.0.0.5",
		explicitPort: 3080,
		canBind: async () => {
			throw new Error("boom");
		},
	});
	assert.deepEqual(explicit, { ok: false, reason: "port-in-use" });
});

test("selectBridgeEndpoint：日志只走注入回调（回退/全占用可观测），回调抛异常不影响决策", async () => {
	const warnings = [];
	const log = (message) => warnings.push(message);
	const fallback = bindProbe([3081]);
	const result = await selectBridgeEndpoint({
		canBind: fallback.canBind,
		pickAddress: autoHost,
		persisted: { port: 3081, host: "192.168.1.20" },
		log,
	});
	assert.deepEqual(result, { ok: true, host: "192.168.1.20", port: 3082, portSource: "probe" });
	assert.ok(warnings.some((message) => message.includes("3081")));

	warnings.length = 0;
	const allOccupied = bindProbe([...BRIDGE_PORT_CANDIDATES]);
	const none = await selectBridgeEndpoint({ canBind: allOccupied.canBind, pickAddress: autoHost, log });
	assert.deepEqual(none, { ok: false, reason: "no-free-port" });
	assert.ok(warnings.some((message) => message.includes("no-free-port")));

	const stillOk = await selectBridgeEndpoint({
		canBind: fallback.canBind,
		pickAddress: autoHost,
		log: () => {
			throw new Error("logger boom");
		},
	});
	assert.equal(stillOk.ok, true);
});

test("selectBridgeEndpoint：显式 host + 自动端口时仍可复用 persisted（host 用配置）", async () => {
	const { calls, canBind } = bindProbe();
	const result = await selectBridgeEndpoint({
		explicitHost: "127.0.0.1",
		canBind,
		pickAddress: autoHost,
		persisted: { port: 3088, host: "192.168.1.20" },
	});
	assert.deepEqual(result, { ok: true, host: "127.0.0.1", port: 3088, portSource: "persisted" });
	assert.deepEqual(calls, [["127.0.0.1", 3088]]);
});

test("公开函数对 null/undefined 参数不抛异常（失败路径一律返回稳定结果）", async () => {
	assert.deepEqual(persistBridge(null), { ok: false, reason: "missing-dsh-home" });
	assert.deepEqual(persistBridge(undefined), { ok: false, reason: "missing-dsh-home" });
	assert.equal(readPersistedBridge(null), null);
	assert.equal(readPersistedBridge(undefined), null);
	assert.deepEqual(await selectBridgeEndpoint(null), { ok: false, reason: "no-host" });
	assert.deepEqual(await selectBridgeEndpoint(undefined), { ok: false, reason: "no-host" });
	assert.deepEqual(listPrivateIpv4(null), []);
	assert.equal(pickPrivateAddress(null), null);
});

test("模块不向 stdout 写任何内容（日志只经注入回调，不污染宿主输出）", async () => {
	const home = await makeHome();
	try {
		const moduleUrl = new URL("../lib/desktop-form.js", import.meta.url).href;
		const script = `
			import { listPrivateIpv4, pickPrivateAddress, readPersistedBridge, persistBridge, selectBridgeEndpoint } from ${JSON.stringify(moduleUrl)};
			const dshHome = process.env.DSH_HOME;
			persistBridge({ dshHome, profileKey: "web", port: 3081, host: "10.0.0.5" });
			readPersistedBridge({ dshHome, profileKey: "web" });
			readPersistedBridge({ dshHome, profileKey: "../bad" });
			listPrivateIpv4({ eth0: [{ address: "192.168.1.20", family: "IPv4", internal: false }] });
			pickPrivateAddress({ lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }] });
			await selectBridgeEndpoint({ canBind: async () => false, pickAddress: () => "192.168.1.20" });
			await selectBridgeEndpoint({ explicitPort: 3080, canBind: async () => false, pickAddress: () => "192.168.1.20" });
			await selectBridgeEndpoint({ pickAddress: () => null });
		`;
		const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
			env: { ...process.env, DSH_HOME: home },
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		assert.equal(stdout, "");
	} finally {
		await cleanup(home);
	}
});
