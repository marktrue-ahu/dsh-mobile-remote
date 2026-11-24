// issue #175 P1/P2：安装源「记住上次选择」的共享逻辑（**唯一实现**）。
//
// 为什么单独成文件：P1 的安装源选择页与 P2 的手动 spec 安装页都需要同一套语义——
// 上次选了哪个源、失效怎么回退、手动地址什么时候才记。两处各写一份必然漂移，
// 而「记住上次选择」的用户可见行为必须一致。
//
// 边界（与 #153/#175 P1 一致，未扩张）：
//   - 偏好只存 **App 本地**（`AppStore.pluginInstallSource` /
//     `pluginManualRegistryUrl`），不写电脑端 profile、`package.json`、`.npmrc`。
//   - 选源只影响**本次解析**，不持久化到电脑端。
//   - 「手动」本身不进枚举记忆；手动 URL 只有用户显式勾选「记住此地址」才存。
import 'package:flutter/foundation.dart';

import '../l10n.dart';
import '../plugin_inventory.dart';
import '../store.dart';

/// 安装源选择的哨兵值：不单独选中某个枚举源，沿用宿主自己的解析顺序。
const pluginInstallSourceHost = 'host';

/// 安装源选择的哨兵值：本次使用手输的 http(s) URL。
const pluginInstallSourceManual = 'manual';

/// 一次安装源选择的**纯逻辑**状态（无 UI、无异步 I/O 之外的行为）。
///
/// 用法：`restore()` 拿初始 key；`validate(list)` 在宿主源列表回来后校验；
/// `remember(key)` / `syncManualMemory()` 把用户选择镜像到本机偏好。
class PluginInstallSourceMemory {
  /// 当前选中的 key：`host` / `manual` / 某个 registry 的 URL。
  String selectedKey;

  /// 手输的 URL（仅 `manual` 时有意义）。
  String manualUrl;

  /// 是否已恢复过（`restore` 只跑一次：晚到的列表不该覆盖用户已做的选择）。
  bool restored = false;

  PluginInstallSourceMemory({
    this.selectedKey = pluginInstallSourceHost,
    this.manualUrl = '',
  });

  /// 从本机偏好恢复初始值（**只做字面恢复**，有效性校验交给 [validate]）。
  ///
  /// 显式记住的手动地址优先于枚举记忆：它是用户明确勾选的「记住此地址」，
  /// 语义上比「上次在列表里点了哪一项」更强。
  void restore(AppStore store) {
    if (restored) return;
    restored = true;
    final manual = store.pluginManualRegistryUrl;
    if (manual.isNotEmpty) {
      manualUrl = manual;
      selectedKey = pluginInstallSourceManual;
      return;
    }
    final saved = store.pluginInstallSource;
    if (saved.isNotEmpty) selectedKey = saved;
  }

  /// 校验存下的选择在当前宿主列表里仍有效；无效则回退 [pluginInstallSourceHost]。
  ///
  /// `host` 恒有效；`manual` 只要有地址就仍可用；其余必须是列表里真实存在的 URL。
  ///
  /// 特别注意**列表里第一个源**：UI 把它渲染成「宿主配置渠道」（不可单独选中，
  /// 因为 `registry: null` 与「请求配置的首选源」在宿主解析顺序里等效）。因此存值
  /// 恰为首个源的 URL 时归一成 `host`——否则页面上不会有一行是选中态。
  String validate(PluginRegistryList list) {
    final key = selectedKey;
    if (key == pluginInstallSourceHost) return key;
    if (key == pluginInstallSourceManual) {
      return manualUrl.trim().isEmpty ? pluginInstallSourceHost : key;
    }
    final first = list.registries.isEmpty ? null : list.registries.first.url;
    if (first != null && first == key) return pluginInstallSourceHost;
    for (final entry in list.registries) {
      if (entry.url == key) return key;
    }
    return pluginInstallSourceHost;
  }

  /// 记住枚举选择（**切换时立即保存**，不等点安装；取消安装也不该丢）。
  ///
  /// 「手动」本身不进记忆：手动地址是自由文本，默认不留存（可能含内网主机）。
  /// 只有用户勾了「记住此地址」才单独存进 manual 字段（见 [syncManualMemory]）。
  Future<void> remember(AppStore? store, String key) async {
    if (store == null) return;
    if (key == pluginInstallSourceManual) return;
    await store.setPluginInstallSource(key);
  }

  /// 把手动 URL 的**勾选状态 + 输入内容**镜像到本机偏好。
  ///
  /// 规则刻意做得可预期，避免「清空输入后下次又冒出旧地址」这类幽灵值：
  ///   - 未勾选 → 清掉；
  ///   - 勾选且地址通过客户端预校验 → 存该地址；
  ///   - 勾选但地址为空/非法 → 清掉（不保存一个用不了的值）。
  Future<void> syncManualMemory(AppStore? store, bool remember) async {
    if (store == null) return;
    if (!remember) {
      await store.setPluginManualRegistryUrl('');
      return;
    }
    final url = manualUrl.trim();
    if (pluginManualUrlError(url).isNotEmpty) {
      await store.setPluginManualRegistryUrl('');
      return;
    }
    await store.setPluginManualRegistryUrl(url);
  }

  /// 当前选择对应的 `registry` 参数（`null` = 用宿主自己的解析顺序）。
  String? registryFor(PluginRegistryList? list) {
    if (selectedKey == pluginInstallSourceManual) {
      final url = manualUrl.trim();
      return url.isEmpty ? null : url;
    }
    if (selectedKey == pluginInstallSourceHost) return null;
    if (list != null) {
      for (final entry in list.registries) {
        if (entry.url == selectedKey) return entry.url;
      }
    }
    return null;
  }

  /// 当前选择的展示名（选源摘要用）。
  String labelFor(PluginRegistryList? list) {
    if (selectedKey == pluginInstallSourceManual) return manualUrl.trim();
    if (selectedKey == pluginInstallSourceHost) {
      return L10n.t('宿主配置渠道', 'Configured by the desktop');
    }
    if (list != null) {
      for (final entry in list.registries) {
        if (entry.url == selectedKey) return entry.displayLabel;
      }
    }
    return L10n.t('宿主配置渠道', 'Configured by the desktop');
  }
}

/// 手动安装源 URL 的客户端预校验。
///
/// 与宿主 `validateRegistryUrl` **同类判据**（App 只做即时反馈；权威判定仍在宿主，
/// 不因为客户端通过就跳过服务端 400）。返回空串表示通过，否则返回可读原因。
String pluginManualUrlError(String raw) {
  final value = raw.trim();
  if (value.isEmpty) return L10n.t('请输入安装源地址', 'Enter a registry URL');
  if (value.length > 2048) {
    return L10n.t('地址过长', 'The address is too long');
  }
  if (RegExp(r'\s').hasMatch(value)) {
    return L10n.t('地址不能包含空格', 'The address must not contain spaces');
  }
  final uri = Uri.tryParse(value);
  if (uri == null) {
    return L10n.t('地址无效', 'Invalid address');
  }
  // 先判协议：`file:`/`data:`/`git+ssh:` 的 host 可能为空，
  // 若先判 host 会给出“地址无效”而掩盖真正原因（与宿主 detail 类别一致）。
  if (uri.scheme != 'http' && uri.scheme != 'https') {
    return L10n.t(
      '只接受 http(s) 地址',
      'Only http(s) addresses are accepted',
    );
  }
  if (uri.host.isEmpty) {
    return L10n.t('地址无效', 'Invalid address');
  }
  if (uri.userInfo.isNotEmpty) {
    return L10n.t(
      '地址不能包含凭据（用户名/密码）',
      'The address must not contain credentials',
    );
  }
  if (uri.hasQuery) {
    return L10n.t('地址不能包含查询参数', 'The address must not contain a query');
  }
  if (uri.hasFragment) {
    return L10n.t('地址不能包含片段', 'The address must not contain a fragment');
  }
  return '';
}

/// 只在调试构建里打印安装源 key 的断言辅助（**绝不打印 URL 原文**，可能含内网主机）。
@visibleForTesting
String debugInstallSourceKey(String key) =>
    key == pluginInstallSourceManual ? '(manual)' : key;
