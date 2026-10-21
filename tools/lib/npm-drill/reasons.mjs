// 演练（drill）的稳定 reason 词表。失败输出 `[reason:<code>]` 与 `REASONS:` 行使用同一组词；
// 词表属于 CLI 对外契约的一部分（issue #37「唯一 seam」），改动需同步文档与测试。
export const REASONS = Object.freeze({
	// CLI / 输入
	CLI_INVALID_ARGUMENT: "drill-cli-invalid-argument",
	PHASES_INVALID: "drill-phases-invalid",
	DIST_MISSING: "drill-dist-missing",
	DIST_UNREADABLE: "drill-dist-unreadable",
	DIST_PREFLIGHT_FAILED: "drill-dist-preflight-failed",
	WEB_PREFLIGHT_UNEXPECTED_PASS: "drill-preflight-unexpected-pass",
	PREFLIGHT_REASON_MISMATCH: "drill-preflight-reason-mismatch",
	BUILD_FAILED: "drill-build-failed",
	VERSION_NAMESPACE_INVALID: "drill-version-namespace-invalid",
	// registry
	REGISTRY_NOT_INSTALLED: "drill-registry-not-installed",
	REGISTRY_START_FAILED: "drill-registry-start-failed",
	REGISTRY_NOT_ALIVE: "drill-registry-not-alive",
	REGISTRY_NOT_ALLOWED: "drill-registry-not-allowed",
	REGISTRY_LOW_LIMIT_NOT_READY: "drill-registry-low-limit-not-ready",
	// 产物投影 / 发布
	PROJECTION_FAILED: "drill-projection-failed",
	PUBLISH_FAILED: "drill-publish-failed",
	CARRIER_PUBLISH_FAILED: "drill-carrier-publish-failed",
	PUBLISH_VERSION_MISSING: "drill-publish-version-missing",
	DIST_TAG_MISMATCH: "drill-dist-tag-mismatch",
	REPUBLISH_NOT_REJECTED: "drill-republish-not-rejected",
	SECOND_PAIR_PUBLISH_FAILED: "drill-second-pair-publish-failed",
	// 安装 / 布局
	INSTALL_FAILED: "drill-install-failed",
	PLUGIN_NOT_INSTALLED: "drill-plugin-not-installed",
	CARRIER_ALIAS_MISSING: "drill-carrier-alias-missing",
	CARRIER_IDENTITY_MISMATCH: "drill-carrier-identity-mismatch",
	APK_BYTES_MISMATCH: "drill-apk-bytes-mismatch",
	LOCKFILE_ALIAS_MISSING: "drill-lockfile-alias-missing",
	HOISTED_MAPPING_MISSING: "drill-hoisted-mapping-missing",
	// 发现 / 身份
	CARRIER_NOT_FOUND: "drill-carrier-not-found",
	CARRIER_DISCOVERY_SOURCE_MISMATCH: "drill-carrier-discovery-source-mismatch",
	CARRIER_MANIFEST_APP_MISMATCH: "drill-carrier-manifest-app-mismatch",
	PLUGIN_DIGEST_MISMATCH: "drill-plugin-digest-mismatch",
	// 更新
	UPDATE_FAILED: "drill-update-failed",
	CARRIER_NOT_REPLACED: "drill-carrier-not-replaced",
	// 失败路径
	OPTIONAL_MISSING_DEGRADED_MISMATCH: "drill-optional-missing-degraded-mismatch",
	E413_NOT_REPRODUCED: "drill-e413-not-reproduced",
	// 兜底
	SETUP_FAILED: "drill-setup-failed",
	ASSERTION_FAILED: "drill-assertion-failed",
});

/** 把未知/空 reason 归一为稳定词，避免输出 `undefined`。 */
export function normalizeReason(reason) {
	return typeof reason === "string" && reason.startsWith("drill-") ? reason : REASONS.ASSERTION_FAILED;
}
