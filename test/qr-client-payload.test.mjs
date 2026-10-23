// 回归（#35 连接页双选项卡）：lib/client.js 的下载二维码载荷与选项卡模型
//
// 缺陷背景：连接页只有「已安装 App」一种二维码；真机验收要求补上「未安装 App」下载码。
// 契约（设计稿 §5.6/§5.7）：
//   - 下载码内容 = 宿主 `/api/qr-config` 下发的 `appDownloadUrl`（手机可达的绝对地址）；
//   - 浏览器端**不自行拼地址**、不把口令放进下载码/URL（两种二维码不可混用）；
//   - 未就绪（appDownloadUrl=null / 非 http(s)）时显示状态文案，而不是坏二维码。
//
// lib/client.js 是浏览器形态且只在**函数体内**触碰 document/navigator/fetch，
// 因此可在 vm 里加载并取出 exports（与 test/qr-payload.test.mjs 同款加载器）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));

function loadClientExports() {
	const source = readFileSync(join(here, "..", "lib", "client.js"), "utf8");
	let loaded = null;
	const sandbox = {
		// vm 上下文不提供 WHATWG URL（Node 全局才有），buildQrPayload/buildSectionModel 依赖它
		URL,
		window: {
			__ModuleLoader__: {
				load(mod) {
					loaded = mod;
				},
			},
		},
	};
	vm.createContext(sandbox);
	vm.runInContext(source, sandbox, { filename: "lib/client.js" });
	assert.ok(loaded, "client.js 应通过 window.__ModuleLoader__.load 注册模块");
	const requireStub = (name) => {
		if (name === "react") return { useState: () => [null, () => {}], useEffect: () => {} };
		if (name === "react/jsx-runtime") return { jsx: () => ({}), jsxs: () => ({}), Fragment: "Fragment" };
		throw new Error(`未预期的依赖：${name}`);
	};
	return loaded.factory(requireStub);
}

const client = loadClientExports();
const { CONNECTION_POLL_LIMIT, buildDownloadQrContent, buildSectionModel, shouldAutoRetry } = client;

const DOWNLOAD_URL = "http://192.168.1.5:3082/m/api/update/apk";

/** 一份"已就绪"的 qr-config 响应（值全部来自服务端；前端只消费）。 */
function readyData(over = {}) {
	return {
		urls: ["http://192.168.1.5:3082/m", "http://127.0.0.1:3080/m"],
		token: "SECRET-TOKEN-0123456789abcdef",
		basePath: "/m",
		appDownloadUrl: DOWNLOAD_URL,
		appArtifact: { state: "ok", releaseId: "a".repeat(64), source: "carrier-store" },
		...over,
	};
}

test("下载码内容 = 宿主下发的 appDownloadUrl；浏览器不拼接、不改写", () => {
	assert.equal(buildDownloadQrContent(readyData()), DOWNLOAD_URL);
	// 前后空白由宿主地址本身决定的服务端值，前端只 trim 防御；不追加挂载路径/查询参数。
	assert.equal(buildDownloadQrContent({ appDownloadUrl: `  ${DOWNLOAD_URL}  ` }), DOWNLOAD_URL);
	// 服务端未就绪 → null（绝不从 urls 猜一个地址）。
	assert.equal(buildDownloadQrContent(readyData({ appDownloadUrl: null })), null);
	assert.equal(buildDownloadQrContent(readyData({ appDownloadUrl: "" })), null);
	assert.equal(buildDownloadQrContent({ urls: ["http://192.168.1.5:3082/m"] }), null);
	// 非 http(s) 绝对地址视为未就绪（不生成指向错误协议的二维码）。
	assert.equal(buildDownloadQrContent({ appDownloadUrl: "/m/api/update/apk" }), null);
	assert.equal(buildDownloadQrContent({ appDownloadUrl: "ftp://192.168.1.5/m/api/update/apk" }), null);
	assert.equal(buildDownloadQrContent({ appDownloadUrl: "javascript:alert(1)" }), null);
	assert.equal(buildDownloadQrContent(null), null);
});

test("两个选项卡：默认「已安装 App」，标签与 id 固定", () => {
	const model = buildSectionModel(readyData());
	assert.equal(model.defaultTab, "installed");
	// 注意：模型来自 vm 沙箱，数组/对象原型属于沙箱 realm；先落到本 realm 再 deepEqual。
	const tabs = [...model.tabs].map((tab) => ({ id: tab.id, label: tab.label }));
	assert.deepEqual(tabs, [
		{ id: "installed", label: "已安装 App" },
		{ id: "download", label: "未安装 App" },
	]);
});

test("已安装 App：连接码仍含口令；下载码不含口令（两种二维码不混用）", () => {
	const data = readyData();
	const model = buildSectionModel(data);

	// 连接码 = DSHREMOTE|地址|口令（既有契约不变）。
	assert.equal(model.connection.payload, `DSHREMOTE|http://192.168.1.5:3082/m|${data.token}`);
	assert.equal(model.connection.qrSrc, "/m/qr.png?text=" + encodeURIComponent(model.connection.payload));
	assert.ok(model.connection.payload.includes(data.token), "连接码按既有本机展示规则携带口令");

	// 下载码 = 纯绝对地址，不含口令；与连接码不同。
	assert.equal(model.download.ready, true);
	assert.equal(model.download.payload, DOWNLOAD_URL);
	assert.ok(!model.download.payload.includes(data.token), "下载码不得包含口令");
	assert.ok(!model.download.qrSrc.includes(data.token), "下载二维码图片请求不得携带口令");
	assert.equal(model.download.qrSrc, "/m/qr.png?text=" + encodeURIComponent(DOWNLOAD_URL));
	assert.notEqual(model.download.payload, model.connection.payload);
	assert.notEqual(model.download.qrSrc, model.connection.qrSrc);
});

test("未安装 App 未就绪：不给二维码，只给状态文案（复用 appArtifact.hint）", () => {
	const model = buildSectionModel(
		readyData({
			appDownloadUrl: null,
			appArtifact: {
				state: "missing",
				reason: "carrier-not-installed",
				hint: "随包 App 载体未安装：请用完整发布包重新安装插件",
			},
		}),
	);
	assert.equal(model.download.ready, false);
	assert.equal(model.download.qrSrc, null, "未就绪时不得生成二维码图片地址");
	assert.equal(model.download.payload, null);
	assert.equal(model.download.url, null);
	assert.equal(model.download.state, "missing");
	assert.equal(model.download.reason, "carrier-not-installed");
	assert.ok(model.download.message.includes("随包 App 载体未安装"), model.download.message);
	assert.ok(!model.download.message.includes("SECRET-TOKEN"), "状态文案不得泄露口令");
});

test("未安装 App 未就绪：mismatch 无 hint 时给稳定兜底文案", () => {
	const model = buildSectionModel(
		readyData({
			appDownloadUrl: null,
			appArtifact: { state: "mismatch", reason: "app-size-mismatch" },
		}),
	);
	assert.equal(model.download.ready, false);
	assert.equal(model.download.qrSrc, null);
	assert.equal(model.download.state, "mismatch");
	assert.equal(model.download.reason, "app-size-mismatch");
	assert.match(model.download.message, /不一致|不能提供服务/);
});

test("自定义挂载路径：两个选项卡的 qr.png 都使用 qr-config 下发的 path", () => {
	const model = buildSectionModel(
		readyData({
			basePath: "/remote",
			urls: ["http://10.0.0.7:3080/remote"],
			appDownloadUrl: "http://10.0.0.7:3080/remote/api/update/apk",
		}),
	);
	assert.equal(model.connection.qrSrc.startsWith("/remote/qr.png?text="), true);
	assert.equal(model.download.qrSrc.startsWith("/remote/qr.png?text="), true);
	assert.ok(model.download.qrSrc.includes(encodeURIComponent("http://10.0.0.7:3080/remote/api/update/apk")));
});

test("#36 follow-up：无可达端点时连接码/二维码为 null，显示 reason/hint 而不是坏码", () => {
	const data = readyData({
		urls: [],
		appDownloadUrl: null,
		connection: { state: "unavailable", source: "none", origins: [], reason: "loopback-only", hint: "电脑端 webserver 只监听回环地址且 LAN 桥未监听。" },
		download: { state: "missing", reason: "address-projection-unavailable", hint: "电脑端没有手机可达端点。" },
	});
	const model = buildSectionModel(data);
	assert.equal(model.connection.ready, false);
	assert.equal(model.connection.state, "unavailable");
	assert.equal(model.connection.reason, "loopback-only");
	assert.equal(model.connection.payload, null, "不得回退 127.0.0.1:3080 构码");
	assert.equal(model.connection.qrSrc, null, "不得生成指向回环的二维码图片地址");
	assert.ok(model.connection.message.includes("回环"), model.connection.message);
	const tabs = [...model.tabs].map((tab) => ({ id: tab.id, label: tab.label }));
	assert.deepEqual(tabs, [
		{ id: "installed", label: "已安装 App" },
		{ id: "download", label: "未安装 App" },
	]);
});

test("#36 follow-up：桥启动中 → connection.state=starting，文案提示自动重试（有界）", () => {
	const model = buildSectionModel(
		readyData({
			urls: [],
			connection: { state: "starting", source: "none", origins: [], reason: "bridge-starting", hint: "" },
		}),
	);
	assert.equal(model.connection.ready, false);
	assert.equal(model.connection.state, "starting");
	assert.equal(model.connection.payload, null);
	assert.equal(model.connection.qrSrc, null);
	assert.match(model.connection.message, /启动|重试/);
});

test("#36 follow-up：旧响应（无 connection 字段）但 urls 只有回环 → 同样不构码", () => {
	const model = buildSectionModel({
		urls: ["http://127.0.0.1:3080/m"],
		token: "SECRET",
		basePath: "/m",
		appDownloadUrl: null,
	});
	assert.equal(model.connection.ready, false);
	assert.equal(model.connection.payload, null);
	assert.equal(model.connection.qrSrc, null);
});

test("#36 follow-up：服务端 download 视图优先于 appArtifact（address-projection-unavailable）", () => {
	const model = buildSectionModel(
		readyData({
			appDownloadUrl: null,
			appArtifact: { state: "ok", releaseId: "a".repeat(64) },
			download: { state: "missing", reason: "address-projection-unavailable", hint: "电脑端没有手机可达端点（LAN 桥未监听且 webserver 仅回环）。" },
		}),
	);
	assert.equal(model.download.ready, false);
	assert.equal(model.download.state, "missing");
	assert.equal(model.download.reason, "address-projection-unavailable");
	assert.ok(model.download.message.includes("没有手机可达端点"), model.download.message);
});

test("地址投影只信服务端：缺 appDownloadUrl 时不从 urls 自行拼下载地址", () => {
	const model = buildSectionModel(readyData({ appDownloadUrl: undefined }));
	assert.equal(model.download.ready, false);
	assert.equal(model.download.payload, null);
	assert.equal(model.download.qrSrc, null);
	// 连接码仍正常（它只依赖既有 urls/token 契约）。
	assert.ok(model.connection.payload.startsWith("DSHREMOTE|"));
});

// ── T16（task-21）复核修复：W3/W5/N3/N5/Q3 ───────────────────────────────

test("N5：payload=null 时 state 必须与 ready=false 一致（host 声称 ready 也不得沿用）", () => {
	const model = buildSectionModel({
		urls: [],
		token: "t",
		basePath: "/m",
		connection: { state: "ready", reason: "", hint: "" },
		appDownloadUrl: null,
	});
	assert.equal(model.connection.ready, false);
	assert.equal(model.connection.payload, null);
	assert.equal(model.connection.state, "unavailable", "地址不可用时 state 不得为 ready");
});

test("Q3/W5：服务端 download 视图非 ready 时，即使 appDownloadUrl 非空也不显示下载码（冲突响应防御）", () => {
	for (const state of ["missing", "mismatch"]) {
		const model = buildSectionModel(
			readyData({ download: { state, reason: "some-stable-reason", hint: "hint" } }),
		);
		assert.equal(model.download.ready, false, state);
		assert.equal(model.download.qrSrc, null, state);
		assert.equal(model.download.payload, null, state);
	}
	// 旧响应（无 download 字段）仍按合法 appDownloadUrl 兜底。
	const legacy = buildSectionModel(readyData({ download: undefined }));
	assert.equal(legacy.download.ready, true);
});

test("W5/N3：自动重取有界（1s × ≤10），ready/unavailable/无 connection 不重取", () => {
	assert.equal(CONNECTION_POLL_LIMIT, 10);
	for (let attempts = 0; attempts < CONNECTION_POLL_LIMIT; attempts += 1) {
		assert.equal(shouldAutoRetry({ state: "starting" }, attempts), true, `attempts=${attempts}`);
	}
	assert.equal(shouldAutoRetry({ state: "starting" }, CONNECTION_POLL_LIMIT), false, "耗尽后必须停止自动重试");
	assert.equal(shouldAutoRetry({ state: "ready" }, 0), false);
	assert.equal(shouldAutoRetry({ state: "unavailable" }, 0), false);
	assert.equal(shouldAutoRetry(null, 0), false);
	assert.equal(shouldAutoRetry(undefined, 0), false);
});

test("W3/W5：pending→ready 状态迁移后二维码随新响应更新（无 stale 旧码）", () => {
	const pending = buildSectionModel(
		readyData({
			urls: [],
			appDownloadUrl: null,
			connection: { state: "starting", source: "none", origins: [], reason: "bridge-starting", hint: "" },
		}),
	);
	assert.equal(pending.connection.ready, false);
	assert.equal(pending.connection.qrSrc, null);
	assert.equal(pending.connection.state, "starting");

	const ready = buildSectionModel(
		readyData({
			urls: ["http://192.168.1.5:3082/m"],
			appDownloadUrl: null,
			connection: { state: "ready", source: "lan-bridge", origins: ["http://192.168.1.5:3082"], reason: "", hint: "" },
		}),
	);
	assert.equal(ready.connection.ready, true);
	assert.equal(ready.connection.qrSrc, "/m/qr.png?text=" + encodeURIComponent(ready.connection.payload));
	assert.ok(ready.connection.payload.includes("192.168.1.5:3082"), "应使用新响应的端点，不保留旧码");
});

test("B1：控制连接因认证不可用，但端点/下载就绪 → 连接码 null、下载码仍可用（下载独立于 auth）", () => {
	const data = readyData({
		urls: ["https://remote.example.com/m"],
		token: "",
		basePath: "/m",
		appDownloadUrl: "https://remote.example.com/m/api/update/apk",
		appArtifact: { state: "ok" },
		connection: {
			state: "unavailable",
			source: "configured",
			origins: ["https://remote.example.com"],
			reason: "auth-token-unavailable",
			hint: "访问口令未配置且自动生成失败",
		},
		download: { state: "ready", reason: "", hint: "" },
	});
	const model = buildSectionModel(data);
	assert.equal(model.connection.ready, false);
	assert.equal(model.connection.state, "unavailable");
	assert.equal(model.connection.payload, null, "控制连接需要认证：不得生成连接码");
	assert.equal(model.connection.qrSrc, null);
	assert.equal(model.download.ready, true, "匿名下载码不受控制连接 auth 影响");
	assert.equal(model.download.payload, "https://remote.example.com/m/api/update/apk");
	assert.ok(!model.download.qrSrc.includes("auth-token-unavailable"));
});

// ── W3-a（T17/task-24）：下载 tab ready → unavailable 刷新迁移 ───────────────

test("W3-a：下载 tab ready→unavailable 刷新迁移清空旧下载二维码/链接，原因可见且连接状态独立", () => {
	// 刷新前：下载码 ready（QR 与链接都存在）。
	const before = buildSectionModel(readyData());
	assert.equal(before.download.ready, true);
	assert.ok(before.download.qrSrc);
	assert.ok(before.download.url);

	// 刷新后（桥关闭/端点变化）：服务端返回 endpoint unavailable + appDownloadUrl=null + download 原因。
	const after = buildSectionModel({
		urls: [],
		token: "SECRET-TOKEN-0123456789abcdef",
		basePath: "/m",
		appDownloadUrl: null,
		appArtifact: { state: "ok" },
		connection: { state: "unavailable", source: "none", origins: [], reason: "loopback-only", hint: "电脑端 webserver 只监听回环地址且 LAN 桥未监听。" },
		download: { state: "missing", reason: "address-projection-unavailable", hint: "电脑端没有手机可达端点。" },
	});
	assert.equal(after.download.ready, false);
	assert.equal(after.download.qrSrc, null, "旧下载二维码必须被撤销");
	assert.equal(after.download.url, null);
	assert.equal(after.download.payload, null);
	assert.equal(after.download.reason, "address-projection-unavailable");
	assert.ok(after.download.message.includes("没有手机可达端点"), after.download.message);

	// 连接状态与下载状态独立：下载 ready 时连接仍可以是不可用（B1 语义），反之亦然。
	assert.equal(after.connection.ready, false);
	assert.equal(after.connection.qrSrc, null);
	const downloadOnly = buildSectionModel(readyData({
		connection: { state: "unavailable", source: "configured", origins: [], reason: "auth-token-unavailable", hint: "口令不可用" },
	}));
	assert.equal(downloadOnly.connection.ready, false);
	assert.equal(downloadOnly.download.ready, true, "控制连接不可用不得误伤下载码");
	assert.ok(!downloadOnly.download.qrSrc.includes("auth-token-unavailable"));
});
