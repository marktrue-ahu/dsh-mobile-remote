// 跨平台子进程调用辅助（issue #39 Windows 修复）。
//
// Windows 上 npm/pnpm 是 `npm.cmd`/`pnpm.cmd`：Node 在 `shell: false` 下用 CreateProcess
// 无法解析 `.cmd`（只会自动补 `.exe`），直接 spawn 裸命令名会 ENOENT。因此在 win32 上
// 必须经 shell 调用，并对含空白的参数（典型是 profile/临时目录路径）做 cmd 引用。
//
// 本模块保持零依赖，避免 npm-update-source ↔ plugin-self-update 的循环引用。

/** 仅 Windows 需要 `shell: true`；POSIX 保持直接 spawn（更可控、无 shell 注入面）。 */
export function shellOptions(platform = process.platform) {
	return platform === "win32" ? { shell: true } : {};
}

/** Windows shell 下给含空白/元字符的参数加引号；POSIX 原样返回。 */
export function quoteShellArgument(value, platform = process.platform) {
	const text = String(value ?? "");
	if (platform !== "win32" || text === "") return text;
	if (!/[\s"&|<>^]/.test(text)) return text;
	return `"${text.replace(/"/g, '""')}"`;
}
