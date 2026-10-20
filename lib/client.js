// DSH Mobile Remote — 桌面 GUI 客户端模块
// 在 dsh 设置页注册"连接移动端设备"页：显示供手机 App 扫码连接的二维码。
//
// 打包形态：window.__ModuleLoader__.load({ id, factory })（dsh-client-modules 约定）。
// 手写 React.createElement（无 JSX/构建链），依赖由 dsh 客户端运行时提供。
// 数据来源：GET /m/api/qr-config（仅 loopback 可访问，返回地址+口令+下载码数据）。
//
// #35 连接页两个选项卡（设计稿 §5.7）：
//   - 默认「已安装 App」：现有连接二维码（`DSHREMOTE|地址|口令`）+ 地址/口令信息；
//   - 「未安装 App」：下载二维码，内容 = 宿主下发的 `appDownloadUrl`（**不含口令**）；
//     未就绪时显示状态文案，而不是生成指向错误地址的二维码。
// 两种二维码不可混用；浏览器端只消费 qr-config 数据，不自行拼地址、不回显/复制口令到下载码。

window.__ModuleLoader__.load({
	id: "dsh-mobile-remote",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		var react = require("react");
		var jsxRuntime = require("react/jsx-runtime");

		var useState = react.useState;
		var useEffect = react.useEffect;

		/** 所需服务：slots（设置页 slot 注册）。 */
		exports.inject = ["slots"];

		var QR_CONFIG = "/m/api/qr-config";
		var QR_IMAGE = "/m/qr.png";

		var rowStyle = {
			display: "flex",
			alignItems: "center",
			gap: "10px",
			padding: "10px 0",
			borderBottom: "1px solid var(--dsw-alias-divider-strong, rgba(128,128,128,.18))",
			fontSize: "13.5px",
		};
		var btnStyle = {
			marginLeft: "auto",
			flex: "none",
			padding: "4px 12px",
			borderRadius: "8px",
			border: "1px solid var(--dsw-alias-border-strong, rgba(128,128,128,.35))",
			background: "none",
			cursor: "pointer",
			font: "inherit",
			fontSize: "12px",
			color: "inherit",
		};

		function toast(text) {
			var el = document.getElementById("dsh-mr-toast");
			if (!el) {
				el = document.createElement("div");
				el.id = "dsh-mr-toast";
				el.style.cssText =
					"position:fixed;left:50%;bottom:48px;transform:translateX(-50%);" +
					"background:rgba(31,35,41,.92);color:#fff;border-radius:999px;" +
					"padding:8px 16px;font-size:13px;z-index:9999;opacity:0;" +
					"transition:opacity .2s;pointer-events:none;";
				document.body.appendChild(el);
			}
			el.textContent = text;
			el.style.opacity = "1";
			clearTimeout(el._h);
			el._h = setTimeout(function () {
				el.style.opacity = "0";
			}, 1600);
		}

		function fallbackCopy(text) {
			// 非安全上下文（http 局域网 IP）下 Clipboard API 不可用，用 textarea + execCommand 降级
			var ta = document.createElement("textarea");
			ta.value = text;
			ta.style.position = "fixed";
			ta.style.opacity = "0";
			document.body.appendChild(ta);
			ta.select();
			try {
				document.execCommand("copy");
			} catch (_) {
				/* 忽略 */
			}
			ta.remove();
		}

		function copyText(text) {
			var done = function () {
				toast("已复制");
			};
			if (navigator.clipboard && window.isSecureContext) {
				navigator.clipboard.writeText(text).then(
					done,
					function () {
						fallbackCopy(text);
						done();
					}
				);
			} else {
				fallbackCopy(text);
				done();
			}
		}

		/** 复制访问口令：60 秒后自动清空剪贴板（口令是唯一凭据，防其他应用读取；尽力而为）。 */
		function copyToken(token) {
			copyText(token);
			setTimeout(function () {
				try {
					if (navigator.clipboard && window.isSecureContext) {
						navigator.clipboard.readText().then(function (t) {
							if (t === token) navigator.clipboard.writeText("");
						});
					}
				} catch (_) {
					/* 非安全上下文等场景尽力而为 */
				}
			}, 60000);
		}

		/**
		 * 构造二维码载荷：`DSHREMOTE|<电脑地址（含挂载路径）>|<访问口令>`。
		 *
		 * 纯函数（不触碰 DOM/React），导出供回归测试直接调用。
		 *
		 * 为什么需要 withMount 判断（PR #32 / 蔡严庆，2026-10-04）：
		 * qr-config 响应的 urls **已自带挂载路径**——服务端 lib/index.js 的两条分支都拼了
		 * `${basePath}`（LAN 桥 `http://ip:3082/m`、回环 `http://ip:3080/m`）。旧实现在此处
		 * 再拼一次 mount，二维码里就成了 `/m/m`；App 端 `_pathOf()` 把整段路径原样当作请求
		 * 前缀，于是扫码连接一律 404（两种模式都中招，不只 LAN 桥）。
		 * 故：仅当目标 url 自身不含路径时才补 mount。
		 */
		function buildQrPayload(data) {
			var urls = Array.isArray(data && data.urls) ? data.urls : [];
			var mount = String((data && data.basePath) || "/m").replace(/\/+$/, "");
			var primary = urls.find(function (u) {
				return !String(u).includes("127.0.0.1");
			});
			var qrTarget = primary ?? urls[0] ?? "http://127.0.0.1:3080";
			var withMount = function (t) {
				try {
					var p = new URL(t).pathname.replace(/\/+$/, "");
					return p ? t : t + mount;
				} catch (e) {
					return t + mount;
				}
			};
			return "DSHREMOTE|" + withMount(qrTarget) + "|" + String((data && data.token) ?? "");
		}
		exports.buildQrPayload = buildQrPayload;

		/**
		 * 「未安装 App」下载码内容：**直接使用宿主下发的绝对地址**（qr-config.appDownloadUrl）。
		 *
		 * 设计稿 §5.6/§5.7：地址投影由宿主完成，浏览器端不自行拼地址；不是合法 http(s)
		 * 绝对地址一律视为未就绪（返回 null），绝不猜一个地址出来。下载码**不含口令**——
		 * 它与连接码是两种二维码，不可混用。
		 */
		function buildDownloadQrContent(data) {
			var url = typeof (data && data.appDownloadUrl) === "string" ? data.appDownloadUrl.trim() : "";
			if (!/^https?:\/\/[^\s]+$/i.test(url)) return null;
			return url;
		}
		exports.buildDownloadQrContent = buildDownloadQrContent;

		/**
		 * 连接页两个选项卡的渲染模型（纯函数；测试可直接断言，不需要 DOM/React）：
		 *   - defaultTab = "installed"：默认「已安装 App」（连接码含口令，仍是扫码即带口令）；
		 *   - download.ready=true：下载码 payload 就是 appDownloadUrl（不含口令）；
		 *   - download.ready=false：payload/qrSrc 均为 null，前端显示状态文案而非坏二维码。
		 */
		function buildSectionModel(data) {
			var urls = Array.isArray(data && data.urls) ? data.urls : [];
			var mount = String((data && data.basePath) || "/m").replace(/\/+$/, "");
			var token = String((data && data.token) ?? "");
			var artifact = (data && data.appArtifact) || {};
			var connectionPayload = buildQrPayload(data);
			var downloadUrl = buildDownloadQrContent(data);
			var downloadState = typeof artifact.state === "string" && artifact.state !== "" ? artifact.state : "missing";
			var hint = typeof artifact.hint === "string" ? artifact.hint : "";
			var downloadMessage = hint !== ""
				? "暂时无法生成下载二维码：" + hint
				: downloadState === "mismatch"
					? "暂时无法生成下载二维码：安装包与发布清单不一致，请在电脑端重新安装同一次发布的完整插件包。"
					: "暂时无法生成下载二维码：App 安装包尚未就绪，请稍后重试或在电脑诊断页检查 APK 分发状态。";
			return {
				defaultTab: "installed",
				tabs: [
					{ id: "installed", label: "已安装 App" },
					{ id: "download", label: "未安装 App" },
				],
				connection: {
					payload: connectionPayload,
					qrSrc: mount + "/qr.png?text=" + encodeURIComponent(connectionPayload),
					urls: urls,
					token: token,
				},
				download: downloadUrl
					? {
							ready: true,
							state: downloadState,
							url: downloadUrl,
							payload: downloadUrl,
							qrSrc: mount + "/qr.png?text=" + encodeURIComponent(downloadUrl),
							message: "扫码下载 App 安装包；安装完成后切到「已安装 App」重新扫码连接。",
						}
					: {
							ready: false,
							state: downloadState,
							reason: typeof artifact.reason === "string" ? artifact.reason : null,
							url: null,
							payload: null,
							qrSrc: null,
							message: downloadMessage,
						},
			};
		}
		exports.buildSectionModel = buildSectionModel;

		/** 选项卡按钮（内联样式，与设置页现有观感一致）。 */
		function tabButton(tab, active, onSelect) {
			return jsxRuntime.jsx(
				"button",
				{
					style: {
						padding: "6px 14px",
						borderRadius: "999px",
						cursor: "pointer",
						font: "inherit",
						fontSize: "12.5px",
						border: "1px solid " + (active
							? "var(--dsw-alias-brand-primary, #4d6bfe)"
							: "var(--dsw-alias-border-strong, rgba(128,128,128,.35))"),
						background: active ? "var(--dsw-alias-brand-primary, #4d6bfe)" : "none",
						color: active ? "#fff" : "inherit",
					},
					onClick: function () {
						onSelect(tab.id);
					},
					children: tab.label,
				},
				tab.id
			);
		}

		/** 二维码图 + 一行说明（连接码/下载码共用布局，但载荷完全不同）。 */
		function qrBlock(qrSrc, alt, caption) {
			return jsxRuntime.jsx("div", {
				style: { display: "flex", flexDirection: "column", alignItems: "center", gap: "10px", padding: "14px 0" },
				children: [
					jsxRuntime.jsx("img", {
						src: qrSrc,
						alt: alt,
						style: { width: 216, height: 216, borderRadius: "12px", background: "#fff", padding: 8 },
					}),
					jsxRuntime.jsx("div", {
						style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #aaa)" },
						children: caption,
					}),
				],
			});
		}

		/** 「已安装 App」选项卡：连接二维码 + 地址/口令信息（行为与旧版一致）。 */
		function connectionPane(model, data) {
			return jsxRuntime.jsx("div", {
				style: { display: "flex", flexDirection: "column", gap: "6px" },
				children: [
					jsxRuntime.jsx("div", {
						style: { fontSize: "13px", color: "var(--dsw-alias-label-secondary, #888)", lineHeight: "1.6" },
						children: "用手机 DSH Remote App 扫描下方二维码，自动填入电脑地址与访问口令，即可远程发消息、看进度、收通知、审批决策。",
					}),
					data.token
						? null
						: jsxRuntime.jsx("div", {
								style: {
									padding: "10px 12px",
									borderRadius: "8px",
									background: "rgba(229,72,77,.12)",
									border: "1px solid rgba(229,72,77,.4)",
									color: "var(--dsw-alias-text-danger, #e5484d)",
									fontSize: "12.5px",
									lineHeight: "1.6",
								},
								children:
									"⚠️ 访问口令未启用：同一网络内任何设备都能连接并控制 agent，建议立即在 cordis.patch.yml 配置 authToken 后重启。",
							}),
					qrBlock(model.connection.qrSrc, "连接二维码", "打开 App → 扫码连接 → 对准本二维码"),
					jsxRuntime.jsx("div", { style: { fontSize: "13px", fontWeight: 600, margin: "8px 0 2px" }, children: "连接信息" }),
					model.connection.urls.map(function (u) {
						return jsxRuntime.jsx(
							"div",
							{
								style: rowStyle,
								children: [
									jsxRuntime.jsx("span", { style: { wordBreak: "break-all", fontFamily: "monospace", fontSize: "12.5px" }, children: u }),
									jsxRuntime.jsx("button", { style: btnStyle, onClick: function () { copyText(u); }, children: "复制" }),
								],
							},
							u
						);
					}),
					jsxRuntime.jsx("div", {
						style: rowStyle,
						children: [
							jsxRuntime.jsx("span", { children: "访问口令" }),
							jsxRuntime.jsx("span", {
								style: { fontFamily: "monospace", fontSize: "12px", opacity: 0.75 },
								children: model.connection.token
									? model.connection.token.slice(0, 6) + "…" + model.connection.token.slice(-4)
									: "未启用（局域网/内网环境）",
							}),
							model.connection.token
								? jsxRuntime.jsx("button", {
										style: btnStyle,
										onClick: function () { copyToken(model.connection.token); },
										children: "复制",
									})
								: null,
						],
					}),
					jsxRuntime.jsx("div", {
						style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #aaa)", marginTop: "6px" },
						children: "二维码包含访问口令，仅在本机显示；请勿截屏转发。App 与手机浏览器（/m 网页）共用同一连接。",
					}),
				],
			});
		}

		/** 「未安装 App」选项卡：下载二维码（内容 = appDownloadUrl，不含口令）或状态文案。 */
		function downloadPane(model) {
			if (!model.download.ready) {
				return jsxRuntime.jsx("div", {
					style: { display: "flex", flexDirection: "column", gap: "8px", padding: "10px 0 16px" },
					children: [
						jsxRuntime.jsx("div", {
							style: { fontSize: "13px", color: "var(--dsw-alias-label-secondary, #888)", lineHeight: "1.6" },
							children: "还没有安装手机 App？先在手机浏览器下载安装包，安装完成后再扫码连接。",
						}),
						jsxRuntime.jsx("div", {
							style: {
								padding: "10px 12px",
								borderRadius: "8px",
								background: "rgba(230,160,40,.12)",
								border: "1px solid rgba(230,160,40,.4)",
								fontSize: "12.5px",
								lineHeight: "1.6",
							},
							children: model.download.message,
						}),
						jsxRuntime.jsx("div", {
							style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #aaa)" },
							children: "安装包就绪后本页会自动出现下载二维码（刷新页面即可）。",
						}),
					],
				});
			}
			return jsxRuntime.jsx("div", {
				style: { display: "flex", flexDirection: "column", gap: "6px" },
				children: [
					jsxRuntime.jsx("div", {
						style: { fontSize: "13px", color: "var(--dsw-alias-label-secondary, #888)", lineHeight: "1.6" },
						children: "用手机相机或浏览器扫描下方二维码，下载与当前插件配对的 App 安装包。",
					}),
					qrBlock(model.download.qrSrc, "App 下载二维码", "扫码下载 → 安装 App → 回到「已安装 App」扫码连接"),
					jsxRuntime.jsx("div", {
						style: rowStyle,
						children: [
							jsxRuntime.jsx("span", {
								style: { wordBreak: "break-all", fontFamily: "monospace", fontSize: "12.5px" },
								children: model.download.url,
							}),
							jsxRuntime.jsx("button", {
								style: btnStyle,
								onClick: function () { copyText(model.download.url); },
								children: "复制",
							}),
						],
					}),
					jsxRuntime.jsx("div", {
						style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #aaa)", marginTop: "6px" },
						children: "下载二维码只含安装包地址，不含访问口令；连接二维码请切回「已安装 App」查看。",
					}),
				],
			});
		}

		/**
		 * 设置页 section：连接移动端设备（两个选项卡：已安装 App / 未安装 App）。
		 * 挂载后从 /m/api/qr-config 拉取地址、口令与下载码数据。
		 */
		function MobileDeviceSection() {
			var state = useState({ status: "loading", urls: [], token: "" });
			var data = state[0];
			var setData = state[1];
			var tabState = useState("installed");
			var activeTab = tabState[0];
			var setActiveTab = tabState[1];

			useEffect(function () {
				var alive = true;
				fetch(QR_CONFIG, { headers: { accept: "application/json" } })
					.then(function (res) {
						if (!res.ok) throw new Error("HTTP " + res.status);
						return res.json();
					})
					.then(function (body) {
						if (!alive) return;
						var urls = Array.isArray(body.urls) ? body.urls : [];
						// v3.0.0 review：path 从 qr-config 读取（不再硬编码 /m——插件挂载路径可配置）
						// #35：下载码数据同样只从 qr-config 取，不改写/不自行拼地址
						setData({
							status: "ready",
							urls: urls,
							token: String(body.token ?? ""),
							basePath: String(body.path || "/m"),
							appDownloadUrl: typeof body.appDownloadUrl === "string" ? body.appDownloadUrl : null,
							appArtifact: body.appArtifact && typeof body.appArtifact === "object" ? body.appArtifact : null,
						});
					})
					.catch(function (err) {
						if (!alive) return;
						setData({
							status: "error",
							urls: [],
							token: "",
							message: String(err?.message ?? err),
						});
					});
				return function () {
					alive = false;
				};
			}, []);

			if (data.status === "loading") {
				return jsxRuntime.jsx("div", { style: { padding: "20px 0", color: "var(--dsw-alias-label-secondary, #888)" }, children: "加载中…" });
			}
			if (data.status === "error") {
				return jsxRuntime.jsx("div", {
					style: { padding: "20px 0", color: "var(--dsw-alias-text-danger, #e5484d)" },
					children: "无法获取连接信息：" + data.message + "（确认 dsh-mobile-remote 插件已启用，且路径为 /m）",
				});
			}

			var model = buildSectionModel(data);
			var activeIsDownload = activeTab === "download";
			return jsxRuntime.jsx("div", {
				style: { display: "flex", flexDirection: "column", gap: "6px", padding: "4px 0 16px" },
				children: [
					jsxRuntime.jsx("div", {
						style: { display: "flex", gap: "8px", padding: "2px 0 10px" },
						children: model.tabs.map(function (tab) {
							return tabButton(tab, activeTab === tab.id, setActiveTab);
						}),
					}),
					activeIsDownload ? downloadPane(model) : connectionPane(model, data),
				],
			});
		}

		/** 注册设置页 section（id: mobile-device）。 */
		function apply(ctx) {
			ctx.slots.inject("settings.section", function () {
				return ctx.slots.register(
					{
						name: "settings.section",
						id: "mobile-device",
						order: 90,
						label: "连接移动端设备",
					},
					MobileDeviceSection
				);
			});
		}
		exports.apply = apply;

		return module.exports;
	},
});
