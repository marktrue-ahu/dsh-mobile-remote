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
const { buildDownloadQrContent, buildSectionModel } = client;

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

test("地址投影只信服务端：缺 appDownloadUrl 时不从 urls 自行拼下载地址", () => {
	const model = buildSectionModel(readyData({ appDownloadUrl: undefined }));
	assert.equal(model.download.ready, false);
	assert.equal(model.download.payload, null);
	assert.equal(model.download.qrSrc, null);
	// 连接码仍正常（它只依赖既有 urls/token 契约）。
	assert.ok(model.connection.payload.startsWith("DSHREMOTE|"));
});
