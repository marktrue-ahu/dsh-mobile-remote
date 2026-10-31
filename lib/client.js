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
	id: "@marktrue/dsh-mobile-remote",
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
		 * 主机名是否为"手机不可用"地址：回环（127/8、localhost、::1、IPv4-mapped）或通配
		 * （0.0.0.0、::）。与 lib/desktop-form.js 的判定保持同一语义（浏览器端不共享模块）。
		 */
		function unusablePhoneHost(hostname) {
			var host = String(hostname || "").toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
			if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
			if (host === "0.0.0.0" || host === "::" || host === "0:0:0:0:0:0:0:0") return true;
			if (host.indexOf("::ffff:") === 0) {
				// IPv4-mapped：点分形式递归；URL 规范化后的十六进制形式（::ffff:7f00:1）解析最后 32 位。
				var mapped = host.slice(7);
				if (mapped.indexOf(".") !== -1) return unusablePhoneHost(mapped);
				var groups = mapped.split(":");
				if (groups.length === 2 && /^[0-9a-f]{1,4}$/.test(groups[0]) && /^[0-9a-f]{1,4}$/.test(groups[1])) {
					var address = ((parseInt(groups[0], 16) << 16) | parseInt(groups[1], 16)) >>> 0;
					return ((address >>> 24) & 0xff) === 127;
				}
				return false;
			}
			if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
			return Number(host.split(".")[0]) === 127;
		}

		/**
		 * 该地址能否放进手机二维码：绝对 http(s) 且主机不是回环/通配；旧宿主下发的不带 scheme
		 * 的裸 authority 只要不是回环/通配仍接受（兼容旧响应）；空/不可解析一律不选。
		 */
		function usablePhoneUrl(value) {
			var text = String(value == null ? "" : value).trim();
			if (text === "") return false;
			try {
				var url = new URL(text);
				if (url.protocol !== "http:" && url.protocol !== "https:") return false;
				return !unusablePhoneHost(url.hostname);
			} catch (e) {
				// 兼容旧响应的裸 authority（如 192.168.1.5:3080）：不以回环/通配开头即可。
				return !/^(?:127\.|localhost(?::|$)|\[?::1\]?|0\.0\.0\.0(?::|$))/i.test(text);
			}
		}

		/**
		 * 构造二维码载荷：`DSHREMOTE|<电脑地址（含挂载路径）>|<访问口令>`。
		 *
		 * 纯函数（不触碰 DOM/React），导出供回归测试直接调用。
		 *
		 * #36 follow-up（issue note 1509 §6）：**没有手机可达候选就返回 null**——
		 * 删除旧实现的 `http://127.0.0.1:3080` 默认回退；服务端 connection.state 非 ready
		 * 时也不构码（不因空列表/环回候选造出指向本机回环的二维码）。
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
			var connection = data && data.connection;
			if (connection && typeof connection === "object" && typeof connection.state === "string" && connection.state !== "ready") {
				return null; // 宿主明确说不可用/启动中：不构码（旧响应无 connection 字段时按 urls 兼容）
			}
			var candidates = urls.filter(usablePhoneUrl);
			// 新旧响应都容忍：connection.origins 是宿主端点视图的权威 JSON，但 qr-config 的 urls
			// 才是带挂载路径的扫码地址；urls 为空时不再回退到任何猜测地址。
			if (candidates.length === 0 && connection && Array.isArray(connection.origins)) {
				candidates = connection.origins.filter(usablePhoneUrl);
			}
			if (candidates.length === 0) return null;
			var qrTarget = candidates[0];
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

		/** 连接信息自动重取上限（与「有界重试、可取消」契约一致：1s × ≤10 次）。 */
		var CONNECTION_POLL_LIMIT = 10;

		/**
		 * 是否应继续自动重取连接信息（纯函数，供组件与测试共用）：
		 * 仅 `connection.state==="starting"` 且次数未耗尽；ready/unavailable/无 connection 都不重取。
		 * 次数耗尽后由 UI 显示"自动重试已停止，请手动刷新"（NEVER 无限轮询）。
		 */
		function shouldAutoRetry(connection, attempts) {
			if (!connection || typeof connection !== "object") return false;
			if (connection.state !== "starting") return false;
			return Number(attempts) < CONNECTION_POLL_LIMIT;
		}
		exports.shouldAutoRetry = shouldAutoRetry;
		exports.CONNECTION_POLL_LIMIT = CONNECTION_POLL_LIMIT;

		/**
		 * 连接页两个选项卡的渲染模型（纯函数；测试可直接断言，不需要 DOM/React）：
		 *   - defaultTab = "installed"：默认「已安装 App」（连接码含口令，仍是扫码即带口令）；
		 *   - connection.ready=false：payload/qrSrc 均为 null，前端显示 reason/hint 与刷新入口，
		 *     **绝不**在空候选时自造回环二维码（#36 note 1509 §6）；
		 *   - download.ready=true：下载码 payload 就是 appDownloadUrl（不含口令）；
		 *   - download.ready=false：payload/qrSrc 均为 null，前端显示状态文案而非坏二维码。
		 */
		function buildSectionModel(data) {
			var urls = Array.isArray(data && data.urls) ? data.urls : [];
			var mount = String((data && data.basePath) || "/m").replace(/\/+$/, "");
			var token = String((data && data.token) ?? "");
			var artifact = (data && data.appArtifact) || {};
			var hostConnection = (data && data.connection) || {};
			var hostDownload = (data && data.download) || {};
			var connectionPayload = buildQrPayload(data);
			var connectionReady = connectionPayload !== null;
			// N5：payload=null 时 state 必须与 ready=false 一致；host 声称 ready 但地址不可用
			// （例如半升级/冲突响应）降级为 unavailable，避免"ready=false 却走 ready 文案"。
			var connectionState = connectionReady
				? "ready"
				: (typeof hostConnection.state === "string" && hostConnection.state === "starting"
					? "starting"
					: "unavailable");
			var connectionReason = connectionReady
				? ""
				: (typeof hostConnection.reason === "string" && hostConnection.reason !== ""
					? hostConnection.reason
					: (urls.length === 0 ? "no-phone-endpoint" : "address-projection-unavailable"));
			var connectionHint = connectionReady
				? ""
				: (typeof hostConnection.hint === "string" && hostConnection.hint !== ""
					? hostConnection.hint
					: "电脑端没有手机可达地址：请确认电脑与手机在同一局域网，且桌面形态已自动开启 LAN 桥；如仍不可用，可在电脑端显式配置 lanBridge.enabled/port 或 publicOrigin。");
			var downloadUrl = buildDownloadQrContent(data);
			// W5/Q3：若宿主显式给出 download 视图且不是 ready，则即使 appDownloadUrl 非空也不显示
			// 下载码（防自相矛盾/半升级响应）；旧响应没有 download 字段时按合法 appDownloadUrl 兜底。
			if (downloadUrl && typeof hostDownload.state === "string" && hostDownload.state !== "" && hostDownload.state !== "ready") {
				downloadUrl = null;
			}
			var downloadState = typeof hostDownload.state === "string" && hostDownload.state !== ""
				? hostDownload.state
				: (typeof artifact.state === "string" && artifact.state !== "" ? artifact.state : "missing");
			var hint = typeof hostDownload.hint === "string" && hostDownload.hint !== ""
				? hostDownload.hint
				: (typeof artifact.hint === "string" ? artifact.hint : "");
			var downloadReason = typeof hostDownload.reason === "string" && hostDownload.reason !== ""
				? hostDownload.reason
				: (typeof artifact.reason === "string" && artifact.reason !== "" ? artifact.reason : null);
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
					ready: connectionReady,
					state: connectionState,
					source: typeof hostConnection.source === "string" ? hostConnection.source : null,
					reason: connectionReason,
					hint: connectionHint,
					payload: connectionPayload,
					qrSrc: connectionReady ? mount + "/qr.png?text=" + encodeURIComponent(connectionPayload) : null,
					urls: urls,
					token: token,
					message: connectionReady
						? ""
						: (connectionState === "starting"
							? "LAN 桥正在启动，连接页会自动重试；也可以点「刷新连接信息」立即重试。"
							: "暂时无法生成连接二维码：" + connectionHint),
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
							reason: downloadReason,
							url: null,
							payload: null,
							qrSrc: null,
							message: downloadMessage,
						},
			};
		}
		exports.buildSectionModel = buildSectionModel;

		/** Normalize the host's authenticated NPM check response for the settings panel. */
		function buildPluginUpdateModel(status) {
			var value = status && typeof status === "object" ? status : {};
			var candidate = value.candidate && typeof value.candidate === "object" ? value.candidate : null;
			var plugin = candidate && candidate.plugin && typeof candidate.plugin === "object" ? candidate.plugin : {};
			var carrier = candidate && candidate.carrier && typeof candidate.carrier === "object" ? candidate.carrier : {};
			var state = String(value.state || "unknown");
			var transaction = value.transaction && typeof value.transaction === "object" ? value.transaction : null;
			var appVersion = String(carrier.appVersion || transaction?.targetAppVersion || "");
			return {
				state: state,
				reason: String(value.reason || ""),
				candidate: candidate,
				hasUpdate: state === "update-available" && Boolean(plugin.version),
				canSelfUpdate: value.canSelfUpdate === true,
				pluginVersion: String(plugin.version || transaction?.targetVersion || ""),
				appVersion: appVersion,
				needsPreparation: state === "update-available" && !appVersion,
				transaction: value.transaction && typeof value.transaction === "object" ? value.transaction : null,
				guidance: value.guidance && typeof value.guidance === "object" ? value.guidance : null,
				checkLog: pluginUpdateCheckLogLines(value),
			};
		}
		exports.buildPluginUpdateModel = buildPluginUpdateModel;

		/** 检查日志投影：只保留有界字符串行，桌面与手机显示同一份脱敏诊断。 */
		function pluginUpdateCheckLogLines(value) {
			var source = value && typeof value === "object" && Array.isArray(value.checkLog) ? value.checkLog : [];
			return source
				.map(function (line) { return String(line == null ? "" : line).trim(); })
				.filter(function (line) { return line !== ""; })
				.slice(-40);
		}
		exports.pluginUpdateCheckLogLines = pluginUpdateCheckLogLines;

		/** 检查不可用的可读原因：区分「npm 客户端缺失」与「registry 不可用」。 */
		function updateCheckReasonText(reason) {
			if (reason === "npm-client-unavailable") return "找不到 npm 客户端（请确认 DSH 进程的 PATH 包含 npm）";
			if (reason === "npm-registry-unavailable") return "无法访问 npm registry（请检查主机 npm 配置与网络）";
			if (reason === "npm-channel-version-missing") return "npm 上没有本机预发布通道对应的 dist-tag（展开检查日志查看查询步骤）";
			if (reason === "npm-plugin-metadata-unavailable") return "读取插件版本元数据失败（展开检查日志查看查询步骤）";
			if (reason === "npm-carrier-metadata-unavailable") return "读取配对载体元数据失败（展开检查日志查看查询步骤）";
			return reason || "registry-unavailable";
		}
		exports.updateCheckReasonText = updateCheckReasonText;

		function apiRoute(basePath, route) {
			var mount = String(basePath || "/m").replace(/\/+$/, "");
			if (!mount || mount === "/") mount = "/m";
			return mount + "/api" + route;
		}

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
		function connectionPane(model, data, onRefresh, retryExhausted) {
			var conn = model.connection;
			var unavailable = conn.ready !== true;
			var refreshRow = jsxRuntime.jsx("div", {
				style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", padding: "2px 0 0" },
				children: [
					jsxRuntime.jsx("button", {
						style: btnStyle,
						onClick: function () { if (onRefresh) onRefresh(); },
						children: "刷新连接信息",
					}),
					jsxRuntime.jsx("span", {
						style: { fontSize: "11.5px", color: "var(--dsw-alias-label-tertiary, #aaa)" },
						children: "二维码为最近一次检查结果；网络/监听变化后请刷新（桥关闭后旧码需刷新撤销）",
					}),
				],
			});
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
					// #36 follow-up：没有真实手机端点时不画二维码（不再用回环地址伪造连接码），
					// 展示稳定 reason/hint 与刷新入口；启动中则由页面有界自动重试。
					unavailable
						? jsxRuntime.jsx("div", {
								style: {
									padding: "12px 14px",
									borderRadius: "8px",
									background: "rgba(230,160,40,.12)",
									border: "1px solid rgba(230,160,40,.4)",
									fontSize: "12.5px",
									lineHeight: "1.7",
								},
								children: [
									jsxRuntime.jsx("div", {
										style: { fontWeight: 600, marginBottom: "4px" },
										children: conn.state === "starting"
											? (retryExhausted ? "正在准备手机连接…（自动重试已停止）" : "正在准备手机连接…（页面会自动重试）")
											: "暂时没有手机可达地址",
									}),
									jsxRuntime.jsx("div", {
										children: conn.state === "starting" && retryExhausted
											? "自动重试已停止，请点「刷新连接信息」手动重试。"
											: (conn.message || conn.hint),
									}),
									jsxRuntime.jsx("div", { style: { opacity: 0.75, marginTop: "4px" }, children: "原因代号：" + (conn.reason || conn.state) }),
									jsxRuntime.jsx("div", {
										style: { marginTop: "8px" },
										children: refreshRow,
									}),
								],
							})
						: jsxRuntime.jsx("div", {
								children: [
									qrBlock(conn.qrSrc, "连接二维码", "打开 App → 扫码连接 → 对准本二维码"),
									refreshRow,
								],
							}),
					jsxRuntime.jsx("div", { style: { fontSize: "13px", fontWeight: 600, margin: "8px 0 2px" }, children: "连接信息" }),
					conn.urls.length === 0
						? jsxRuntime.jsx("div", {
								style: { fontSize: "12.5px", color: "var(--dsw-alias-label-tertiary, #aaa)", padding: "6px 0" },
								children: "暂无手机可达地址（LAN 桥未监听且 webserver 仅回环时会这样显示）。",
							})
						: null,
					conn.urls.map(function (u) {
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
		function downloadPane(model, onRefresh) {
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
							children: "安装包/手机端点就绪后点「刷新连接信息」即可重新检查（无需重开页面）。",
						}),
						jsxRuntime.jsx("button", {
							style: Object.assign({}, btnStyle, { marginLeft: 0 }),
							onClick: function () { if (onRefresh) onRefresh(); },
							children: "刷新连接信息",
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
					// W3-a/T18：下载 tab **ready** 态同样提供刷新入口与"最近一次检查"说明；
					// 与连接 tab 共用同一个安全 refresh handler（重新拉取 qr-config，不自行拼地址）。
					jsxRuntime.jsx("div", {
						style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", padding: "2px 0 0" },
						children: [
							jsxRuntime.jsx("button", {
								style: Object.assign({}, btnStyle, { marginLeft: 0 }),
								onClick: function () { if (onRefresh) onRefresh(); },
								children: "刷新连接信息",
							}),
							jsxRuntime.jsx("span", {
								style: { fontSize: "11.5px", color: "var(--dsw-alias-label-tertiary, #aaa)" },
								children: "下载码为最近一次检查结果；网络/监听变化后请刷新（桥关闭后旧码需刷新撤销）",
							}),
						],
					}),
				],
			});
		}

		function pluginUpdatePane(model, workflow, logs, logExpanded, showAllLogs, checkLogExpanded, actions) {
			var candidate = workflow.candidate || model.candidate || {};
			var plugin = candidate.plugin && typeof candidate.plugin === "object" ? candidate.plugin : {};
			var carrier = candidate.carrier && typeof candidate.carrier === "object" ? candidate.carrier : {};
			var transaction = model.transaction && typeof model.transaction === "object" ? model.transaction : {};
			var pluginVersion = String(workflow.transaction && transaction.targetVersion || plugin.version || model.pluginVersion || "");
			var appVersion = String(workflow.transaction && transaction.targetAppVersion || carrier.appVersion || model.appVersion || "");
			var events = Array.isArray(logs.events) ? logs.events : [];
			var lines = events.map(function (event) {
				var stage = String(event.stage || "update");
				var stream = String(event.stream || "status");
				return stream === "status" ? "[" + stage + "] " + String(event.text || "")
					: "[" + stage + "][" + stream + "] " + String(event.text || "");
			});
			var visibleLines = lines;
			if (!showAllLogs && lines.length > 12) {
				visibleLines = lines.slice(0, 4).concat(["… 中间 " + (lines.length - 12) + " 行已折叠 …"], lines.slice(-8));
			}
			var working = ["preparing", "submitting", "running"].includes(workflow.status);
			var statusText = model.state === "loading" ? "正在检查 NPM 更新…"
				: model.state === "update-available" ? "发现插件更新候选"
				: model.state === "up-to-date" || model.state === "local-ahead" ? "当前插件已是最新"
				: model.state === "disabled" ? "NPM 自动更新已关闭"
				: model.state === "unavailable" ? "检查暂不可用：" + updateCheckReasonText(model.reason)
				: "等待检查";
			var operationTarget = workflow.transaction && (pluginVersion || appVersion)
				? jsxRuntime.jsx("div", { style: { fontSize: "12px", lineHeight: "1.6" }, children: "操作目标：插件 v" + (pluginVersion || "未知") + (appVersion ? " · App build " + appVersion : "") })
				: null;
			var actionButton = model.hasUpdate && model.canSelfUpdate && !["preparing", "submitting", "running", "confirming"].includes(workflow.status)
				? jsxRuntime.jsx("button", {
						style: Object.assign({}, btnStyle, { marginLeft: 0 }),
						disabled: working,
						onClick: actions.onBegin,
						children: model.needsPreparation ? "准备更新" : "更新插件",
					})
				: null;
			var confirmBox = workflow.status === "confirming"
				? jsxRuntime.jsx("div", {
						style: { padding: "10px", borderRadius: "8px", border: "1px solid var(--dsw-alias-brand-primary, #4d6bfe)", background: "rgba(77,107,254,.08)" },
						children: [
							jsxRuntime.jsx("div", { style: { fontWeight: 600, marginBottom: "4px" }, children: "请确认安装目标" }),
							jsxRuntime.jsx("div", { style: { fontSize: "12.5px", lineHeight: "1.6" }, children: "插件 v" + pluginVersion + (appVersion ? " · App build " + appVersion : "") }),
							jsxRuntime.jsx("div", { style: { fontSize: "12px", margin: "4px 0 8px", color: "var(--dsw-alias-label-secondary, #888)" }, children: "确认后电脑端会使用主机 npm 配置安装，并重启 DSH；连接短暂中断属正常。" }),
							jsxRuntime.jsx("div", { style: { display: "flex", gap: "8px" }, children: [
								jsxRuntime.jsx("button", { style: Object.assign({}, btnStyle, { marginLeft: 0 }), onClick: actions.onCancel, children: "取消" }),
								jsxRuntime.jsx("button", { style: Object.assign({}, btnStyle, { marginLeft: 0, borderColor: "var(--dsw-alias-brand-primary, #4d6bfe)" }), onClick: actions.onConfirm, children: "确认并安装" }),
							] }),
						],
					})
				: null;
			var checkLog = Array.isArray(model.checkLog) ? model.checkLog.slice(-40) : [];
			var checkLogPanel = checkLog.length
				? jsxRuntime.jsx("div", { style: { marginTop: "4px", display: "flex", flexDirection: "column", gap: "8px" }, children: [
					jsxRuntime.jsx("button", { style: Object.assign({}, btnStyle, { marginLeft: 0, alignSelf: "flex-start" }), "aria-expanded": !!checkLogExpanded, onClick: actions.onToggleCheckLog,
						children: (checkLogExpanded ? "收起" : "查看") + "检查详情（" + checkLog.length + " 行）" }),
					checkLogExpanded ? jsxRuntime.jsx("div", { style: { border: "1px solid var(--dsw-alias-divider-strong, rgba(128,128,128,.2))", borderRadius: "8px", overflow: "hidden" }, children: checkLog.map(function (line, index) {
						if (line.charAt(0) === "$") {
							return jsxRuntime.jsx("div", { style: { display: "flex", alignItems: "center", gap: "8px", padding: "6px 10px", background: "rgba(0,0,0,.05)", fontFamily: "monospace", fontSize: "11.5px" }, children: [
								jsxRuntime.jsx("span", { style: { color: "#1f9d55", lineHeight: 1 }, children: "●" }),
								jsxRuntime.jsx("span", { style: { flex: 1, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }, children: line }),
								jsxRuntime.jsx("button", { style: Object.assign({}, btnStyle, { marginLeft: 0, padding: "1px 8px", fontSize: "11px" }), onClick: actions.onCopyCheckLog, children: "复制" }),
							] }, "check-log-cmd-" + index);
						}
						var note = line.charAt(0) === "#";
						return jsxRuntime.jsx("div", { style: { padding: "2px 10px", fontFamily: "monospace", fontSize: "11px", lineHeight: "1.55", whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: note ? "var(--dsw-alias-label-tertiary, #9aa0a6)" : "inherit" }, children: line }, "check-log-line-" + index);
					}) }) : null,
				] })
				: null;
			var logPanel = workflow.transaction || events.length
				? jsxRuntime.jsx("div", { style: { marginTop: "8px" }, children: [
					jsxRuntime.jsx("button", { style: Object.assign({}, btnStyle, { marginLeft: 0 }), "aria-expanded": !!logExpanded, onClick: actions.onToggleLogs,
						children: (logExpanded ? "收起" : "查看") + "安装详情（" + events.length + " 行）" }),
					logExpanded ? jsxRuntime.jsx("div", { style: { marginTop: "8px", borderRadius: "8px", background: "rgba(0,0,0,.16)", padding: "8px" }, children: [
						jsxRuntime.jsx("pre", { style: { margin: 0, maxHeight: "220px", overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: "11px", lineHeight: "1.5", fontFamily: "monospace" }, children: visibleLines.length ? visibleLines.join("\n") : "等待 pnpm 输出…" }),
						lines.length > 12 ? jsxRuntime.jsx("button", { style: Object.assign({}, btnStyle, { marginLeft: 0, marginTop: "6px" }), onClick: actions.onToggleAllLogs, children: showAllLogs ? "折叠中间日志" : "展开全部日志" }) : null,
					] }) : null,
				] })
				: null;
			return jsxRuntime.jsx("div", {
				style: { marginTop: "14px", padding: "12px", borderRadius: "10px", border: "1px solid var(--dsw-alias-divider-strong, rgba(128,128,128,.2))", display: "flex", flexDirection: "column", gap: "8px" },
				children: [
					jsxRuntime.jsx("div", { style: { fontSize: "14px", fontWeight: 650 }, children: "电脑端插件更新" }),
					jsxRuntime.jsx("div", { style: { fontSize: "12.5px", color: "var(--dsw-alias-label-secondary, #888)" }, children: statusText }),
					model.hasUpdate ? jsxRuntime.jsx("div", { style: { fontSize: "12.5px", lineHeight: "1.6" }, children: "插件 v" + pluginVersion + (appVersion ? " · App build " + appVersion : " · App build 将在准备后核验") }) : null,
					operationTarget,
					model.hasUpdate && !model.canSelfUpdate ? jsxRuntime.jsx("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary, #888)" }, children: model.guidance?.summary || "当前安装形态需要按电脑端指引更新。" }) : null,
					workflow.status === "preparing" ? jsxRuntime.jsx("div", { style: { fontSize: "12px" }, children: "正在从主机 NPM 源准备并校验 carrier；profile 尚未修改…" }) : null,
					workflow.status === "submitting" ? jsxRuntime.jsx("div", { style: { fontSize: "12px" }, children: "正在提交安装事务…" }) : null,
					workflow.status === "running" ? jsxRuntime.jsx("div", { style: { fontSize: "12px" }, children: "pnpm 安装/重启进行中；输出会保留并可在重连后继续查看。" }) : null,
					workflow.message ? jsxRuntime.jsx("div", { style: { fontSize: "12px", color: workflow.status === "failed" ? "var(--dsw-alias-text-danger, #e5484d)" : "inherit" }, children: workflow.message }) : null,
					checkLogPanel,
					actionButton,
					confirmBox,
					jsxRuntime.jsx("button", { style: Object.assign({}, btnStyle, { marginLeft: 0, alignSelf: "flex-start" }), disabled: model.state === "loading", onClick: actions.onCheck, children: model.state === "loading" ? "检查中…" : "手动检查更新" }),
					logPanel,
				],
			});
		}

		/**
		 * 设置页 section：连接移动端设备（两个选项卡：已安装 App / 未安装 App）。
		 * 挂载后从 /m/api/qr-config 拉取地址、口令与下载码数据。
		 *
		 * #36 follow-up（note 1509 §6）：桥启动是异步的——
		 *   - connection.state==="starting" 时每秒重取一次，最多 10 次（≤10s）后停止并保留手动刷新；
		 *   - 新请求会取消旧请求结果（alive/代次），组件卸载时停止计时器，不留后台轮询；
		 *   - 成功不依赖重新打开页面：刷新拿到 ready 后立即换码。
		 */
		function MobileDeviceSection() {
			var state = useState({ status: "loading", urls: [], token: "" });
			var data = state[0];
			var setData = state[1];
			var tabState = useState("installed");
			var activeTab = tabState[0];
			var setActiveTab = tabState[1];
			var refreshState = useState(0);
			var refreshTick = refreshState[0];
			var setRefreshTick = refreshState[1];
			var updateCheckState = useState({ state: "loading", reason: "not-checked", hasUpdate: false, canSelfUpdate: false, candidate: null });
			var updateStatus = updateCheckState[0];
			var setUpdateStatus = updateCheckState[1];
			var updateTickState = useState(0);
			var updateTick = updateTickState[0];
			var setUpdateTick = updateTickState[1];
			var workflowState = useState({ status: "idle", opId: "", prepareId: "", candidate: null, transaction: false, message: "" });
			var workflow = workflowState[0];
			var setWorkflow = workflowState[1];
			var logsState = useState({ events: [], lastSeq: 0, firstSeq: 0, truncated: false });
			var logs = logsState[0];
			var setLogs = logsState[1];
			var logExpandedState = useState(false);
			var logExpanded = logExpandedState[0];
			var setLogExpanded = logExpandedState[1];
			var showAllLogsState = useState(false);
			var showAllLogs = showAllLogsState[0];
			var setShowAllLogs = showAllLogsState[1];
			// 检查日志展开状态与复制：桌面端与手机端使用同一份宿主 checkLog。
			var checkLogExpandedState = useState(false);
			var checkLogExpanded = checkLogExpandedState[0];
			var setCheckLogExpanded = checkLogExpandedState[1];
			var requestGeneration = 0;

			var toggleCheckLog = function () {
				setCheckLogExpanded(function (previous) { return !previous; });
			};
			var copyCheckLog = function () {
				var lines = pluginUpdateCheckLogLines(updateStatus);
				if (!lines.length) return;
				var text = lines.join("\n");
				try {
					if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
						navigator.clipboard.writeText(text);
					}
				} catch (_) { /* 复制失败不影响日志展示 */ }
			};

			useEffect(function () {
				var alive = true;
				var timer = null;
				var attempts = 0;
				var generation = ++requestGeneration;
				var stillCurrent = function () {
					return alive && generation === requestGeneration;
				};
				var load = function () {
					fetch(QR_CONFIG, { headers: { accept: "application/json" } })
						.then(function (res) {
							if (!res.ok) throw new Error("HTTP " + res.status);
							return res.json();
						})
						.then(function (body) {
							if (!stillCurrent()) return;
							var urls = Array.isArray(body.urls) ? body.urls : [];
							// v3.0.0 review：path 从 qr-config 读取（不再硬编码 /m——插件挂载路径可配置）
							// #35：下载码数据同样只从 qr-config 取，不改写/不自行拼地址
							// #36 follow-up：connection/download 是端点可用性的权威视图（旧响应可能没有）。
							var retry = shouldAutoRetry(body.connection, attempts);
							setData({
								status: "ready",
								urls: urls,
								token: String(body.token ?? ""),
								basePath: String(body.path || "/m"),
								appDownloadUrl: typeof body.appDownloadUrl === "string" ? body.appDownloadUrl : null,
								appArtifact: body.appArtifact && typeof body.appArtifact === "object" ? body.appArtifact : null,
								connection: body.connection && typeof body.connection === "object" ? body.connection : null,
								download: body.download && typeof body.download === "object" ? body.download : null,
								localUrl: typeof body.localUrl === "string" ? body.localUrl : "",
								retryExhausted: Boolean(body.connection && body.connection.state === "starting" && !retry),
							});
							// 桥启动中：每秒重取，最多 CONNECTION_POLL_LIMIT 次后停止（避免无限后台轮询；
							// 之后 UI 明确提示"自动重试已停止，请手动刷新"）。
							if (retry) {
								attempts += 1;
								timer = setTimeout(load, 1000);
							}
						})
						.catch(function (err) {
							if (!stillCurrent()) return;
							setData({
								status: "error",
								urls: [],
								token: "",
								message: String(err?.message ?? err),
							});
						});
				};
				load();
				return function () {
					alive = false;
					if (timer) clearTimeout(timer);
				};
			}, [refreshTick]);

			// Automatically check the host's NPM candidate when the connection token becomes available.
			useEffect(function () {
				if (data.status !== "ready" || !data.token) {
					if (data.status === "ready") setUpdateStatus({ state: "unavailable", reason: "auth-token-unavailable", hasUpdate: false, canSelfUpdate: false, candidate: null });
					return;
				}
				var alive = true;
				setUpdateStatus(function (previous) { return Object.assign({}, previous, { state: "loading", reason: "checking" }); });
				fetch(apiRoute(data.basePath, "/plugin-update/check"), {
					method: "GET",
					headers: { accept: "application/json", "x-mobile-token": data.token },
				})
					.then(function (res) { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
					.then(function (body) {
						if (!alive) return;
						var model = buildPluginUpdateModel(body.pluginUpdate);
					setUpdateStatus(model);
					var tx = model.transaction;
					if (tx && tx.opId) {
						var terminal = ["settled", "rolled-back", "failed"].includes(String(tx.phase));
						setWorkflow(function (previous) {
							if (previous.opId === tx.opId && previous.transaction) return previous;
						return { status: terminal ? (tx.phase === "settled" ? "done" : "failed") : "running",
							opId: tx.opId, prepareId: "", candidate: model.candidate, transaction: true,
							message: terminal ? (tx.phase === "settled" ? "最近一次插件更新已完成。" : "最近一次插件更新结束：" + tx.phase) : "接续电脑端正在进行的插件更新。" };
						});
					}
					})
					.catch(function (err) {
						if (alive) setUpdateStatus({ state: "unavailable", reason: String(err?.message ?? "update-check-failed"), hasUpdate: false, canSelfUpdate: false, candidate: null });
					});
				return function () { alive = false; };
			}, [data.status, data.basePath, data.token, updateTick]);

			var refresh = function () {
				setRefreshTick(function (n) { return n + 1; });
			};
			var checkPluginUpdate = function () { setUpdateTick(function (n) { return n + 1; }); };
			var makeOperationId = function () {
				if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
				return "web-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
			};
			var postUpdateJson = function (route, payload) {
				return fetch(apiRoute(data.basePath, route), {
					method: "POST",
					headers: { accept: "application/json", "content-type": "application/json", "x-mobile-token": data.token },
					body: JSON.stringify(payload),
				}).then(function (res) {
					return res.json().catch(function () { return {}; }).then(function (body) {
						if (!res.ok) {
						var error = new Error(String(body.error || ("HTTP " + res.status)));
						error.code = String(body.error || ("http-" + res.status));
						error.status = res.status;
						error.body = body;
						throw error;
					}
					return body;
					});
				});
			};
			var beginPluginUpdate = function () {
				var candidate = updateStatus.candidate;
				if (!updateStatus.hasUpdate || !candidate) return;
				var opId = makeOperationId();
				setLogs({ events: [], lastSeq: 0, firstSeq: 0, truncated: false });
				setWorkflow({ status: updateStatus.needsPreparation ? "preparing" : "confirming", opId: opId,
					prepareId: "", candidate: candidate, transaction: false, message: "" });
				if (!updateStatus.needsPreparation) return;
				postUpdateJson("/plugin-update/prepare", { opId: opId })
					.then(function (body) {
						if (body.action === "prepared" && body.candidate && body.prepareId) {
						var preparedModel = buildPluginUpdateModel({ state: "update-available", canSelfUpdate: true,
							candidate: body.candidate, transaction: updateStatus.transaction });
						setUpdateStatus(preparedModel);
						setWorkflow({ status: "confirming", opId: opId, prepareId: body.prepareId,
							candidate: body.candidate, transaction: false, message: "Carrier 已验证，请确认实际 App build 后继续。" });
					} else if (body.action === "confirmation-required") {
						setWorkflow({ status: "confirming", opId: opId, prepareId: "", candidate: body.candidate || candidate,
							transaction: false, message: "请确认更新目标后继续。" });
					} else {
						setWorkflow({ status: "failed", opId: opId, prepareId: "", candidate: candidate, transaction: false,
							message: "无法准备更新：" + String(body.error || body.action || "no-update-candidate") });
					}
					})
					.catch(function (err) {
						var tx = err.body && err.body.transaction && typeof err.body.transaction === "object" ? err.body.transaction : null;
						if (tx && typeof tx.opId === "string" && tx.opId) {
							setLogs({ events: [], lastSeq: 0, firstSeq: 0, truncated: false });
						setUpdateStatus(buildPluginUpdateModel({ state: "up-to-date", canSelfUpdate: false, candidate: null, transaction: tx }));
						setWorkflow({ status: "running", opId: tx.opId, prepareId: "", candidate: null,
							transaction: true, message: "电脑端已有另一客户端启动的更新，接续查看同一事务日志。" });
						setLogExpanded(true);
						checkPluginUpdate();
						return;
						}
						setWorkflow({ status: "failed", opId: opId, prepareId: "", candidate: candidate, transaction: false,
							message: "Carrier 预检失败：" + String(err.code || "npm-preparation-failed") });
					});
			};
			var confirmPluginUpdate = function () {
				if (!workflow.opId || !workflow.candidate) return;
				var plugin = workflow.candidate.plugin || {};
				var payload = { opId: workflow.opId, targetVersion: String(plugin.version || "") };
				if (workflow.prepareId) payload.prepareId = workflow.prepareId;
				setWorkflow(function (previous) { return Object.assign({}, previous, { status: "submitting", message: "正在提交电脑端安装事务…" }); });
				postUpdateJson("/plugin-update", payload)
					.then(function (body) {
						if (body.action === "accepted") {
						setWorkflow(function (previous) { return Object.assign({}, previous, { status: "running", transaction: true, message: "安装/重启进行中；日志会在重连后继续显示。" }); });
						setLogExpanded(true);
						checkPluginUpdate();
					} else if (body.action === "prepare-required") {
						setWorkflow(function (previous) { return Object.assign({}, previous, { status: "failed", transaction: false, message: "更新目标需要重新准备；请再次点击准备更新。" }); });
						checkPluginUpdate();
					} else if (body.action === "none") {
						setWorkflow(function (previous) { return Object.assign({}, previous, { status: "idle", transaction: false, message: "检查后未发现可安装的新版本。" }); });
						checkPluginUpdate();
					} else {
						setWorkflow(function (previous) { return Object.assign({}, previous, { status: "failed", transaction: false, message: "更新未接受：" + String(body.error || body.action || "unknown") }); });
					}
					})
					.catch(function (err) {
						var tx = err.body && err.body.transaction && typeof err.body.transaction === "object" ? err.body.transaction : null;
						if (tx && typeof tx.opId === "string" && tx.opId) {
							var terminal = ["settled", "rolled-back", "failed"].includes(String(tx.phase));
							setLogs({ events: [], lastSeq: 0, firstSeq: 0, truncated: false });
							setUpdateStatus(buildPluginUpdateModel({ state: "up-to-date", canSelfUpdate: false, candidate: null, transaction: tx }));
							setWorkflow({ status: terminal ? (tx.phase === "settled" ? "done" : "failed") : "running",
								opId: tx.opId, prepareId: "", candidate: null, transaction: true,
								message: "电脑端已有另一客户端启动的更新，接续查看同一事务日志。" });
							setLogExpanded(true);
							checkPluginUpdate();
							return;
						}
						setWorkflow(function (previous) { return Object.assign({}, previous, { status: "failed", transaction: false, message: "更新请求失败：" + String(err.code || "request-failed") }); });
						if (err.code === "update-busy") checkPluginUpdate();
					});
			};
			var cancelPluginUpdateConfirm = function () {
				setWorkflow({ status: "idle", opId: "", prepareId: "", candidate: null, transaction: false, message: "" });
			};

			useEffect(function () {
				if (data.status !== "ready" || !data.token || !workflow.opId || !workflow.transaction) return;
				var alive = true;
				var timer = null;
				var cursor = 0;
				var poll = function () {
					var route = apiRoute(data.basePath, "/plugin-update/log") + "?opId=" + encodeURIComponent(workflow.opId) + "&afterSeq=" + cursor;
					fetch(route, { method: "GET", headers: { accept: "application/json", "x-mobile-token": data.token } })
						.then(function (res) { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
						.then(function (body) {
							if (!alive) return;
						var events = Array.isArray(body.events) ? body.events : [];
						if (Number.isSafeInteger(body.lastSeq)) cursor = Math.max(cursor, body.lastSeq);
						if (events.length) {
							setLogs(function (previous) {
								var bySeq = new Map((previous.events || []).map(function (event) { return [event.seq, event]; }));
								events.forEach(function (event) { bySeq.set(event.seq, event); });
								var merged = Array.from(bySeq.values()).sort(function (a, b) { return a.seq - b.seq; }).slice(-400);
								return { events: merged, lastSeq: cursor, firstSeq: body.firstSeq || previous.firstSeq || 0, truncated: Boolean(body.truncated) };
							});
						}
						if (["settled", "rolled-back", "failed"].includes(String(body.phase))) {
							setWorkflow(function (previous) { return Object.assign({}, previous, { status: body.phase === "settled" ? "done" : "failed", message: body.phase === "settled" ? "电脑端插件更新完成。" : "电脑端插件更新结束：" + body.phase }); });
							return;
						}
						timer = setTimeout(poll, 1000);
					})
						.catch(function () { if (alive) timer = setTimeout(poll, 1500); });
				};
				poll();
				return function () { alive = false; if (timer) clearTimeout(timer); };
			}, [data.status, data.basePath, data.token, workflow.opId, workflow.transaction]);

			var toggleLog = function () { setLogExpanded(function (open) { return !open; }); };
			var toggleAllLogs = function () { setShowAllLogs(function (open) { return !open; }); };

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
					activeIsDownload ? downloadPane(model, refresh) : connectionPane(model, data, refresh, data.retryExhausted === true),
					pluginUpdatePane(updateStatus, workflow, logs, logExpanded, showAllLogs, checkLogExpanded, {
						onCheck: checkPluginUpdate,
						onBegin: beginPluginUpdate,
						onConfirm: confirmPluginUpdate,
						onCancel: cancelPluginUpdateConfirm,
						onToggleLogs: toggleLog,
						onToggleAllLogs: toggleAllLogs,
						onToggleCheckLog: toggleCheckLog,
						onCopyCheckLog: copyCheckLog,
					}),
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
