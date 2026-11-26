// issue #175 P3：插件市场（索引管理 + 搜索 + 从市场安装）。
//
// 边界（与 docs/04-security.md 同步）：
//   - **索引是电脑端配置**：保存前必须显式确认「修改电脑端」；本页是唯一会写
//     电脑端配置的市场入口。
//   - **SSRF**：搜索的 `url` **只能**来自已配置索引列表（本页不接受用户手输 URL）。
//     这不是 App 侧才有的限制——宿主同样会拒绝未配置的 URL；App 不提供绕过入口。
//   - **不自己拼安装 spec**：安装目标由宿主 `marketInstallTarget()` 算好放在
//     `versions[].install.spec`，这里原样交给 P2 的 install 流程。
//   - **不做 build scripts 授权**（同 P2）：装到带脚本的包只提示去电脑端。
//   - 首版不做 `readEntryDetail` 完整详情页（见交付说明）。
import 'dart:async';

import 'package:flutter/material.dart';

import '../api.dart';
import '../l10n.dart';
import '../plugin_inventory.dart';
import '../store.dart';
import '../theme.dart';
import 'plugin_management_widgets.dart';
import 'plugin_spec_install_screen.dart' show PluginSpecInstallScreen;

/// 市场页的依赖（默认走真实 API；测试注入 fake）。
class PluginMarketActions {
  final Future<PluginMarketIndexes> Function() loadIndexes;
  final Future<PluginMarketIndexes> Function(List<String> urls)? saveIndexes;
  final Future<PluginMarketPage> Function(
    String url, {
    int offset,
    int limit,
    String text,
    String category,
  })? search;

  /// 从市场条目安装：`spec` 由宿主给出，这里只透传。
  final Future<PluginOperation> Function(String spec, String? registry)?
  installBySpec;

  /// P2 已有的预校验（可选；用于安装页的预校验步骤）。
  final Future<PluginSpecInspection> Function(String spec, String? registry)?
  inspectSpec;

  final Future<PluginRegistryList> Function()? registries;
  final Future<PluginOperation> Function(String opId)? poll;
  final Future<String> Function(String opId)? cancel;

  const PluginMarketActions({
    required this.loadIndexes,
    this.saveIndexes,
    this.search,
    this.installBySpec,
    this.inspectSpec,
    this.registries,
    this.poll,
    this.cancel,
  });

  factory PluginMarketActions.fromApi(Api api) => PluginMarketActions(
    loadIndexes: api.pluginMarketIndexes,
    saveIndexes: api.pluginMarketSetIndexes,
    search: (url, {offset = 0, limit = 20, text = '', category = ''}) =>
        api.pluginMarketSearch(url, offset: offset, limit: limit, text: text, category: category),
    installBySpec: (spec, registry) =>
        api.pluginInstallBySpec(spec, registry: registry),
    inspectSpec: (spec, registry) =>
        api.pluginInspectSpec(spec, registry: registry),
    registries: api.pluginRegistries,
    poll: api.pluginOperation,
    cancel: api.pluginCancelOperation,
  );

  bool get canWrite => saveIndexes != null;
  bool get canSearch => search != null;
  bool get canInstall => installBySpec != null;
}

/// 市场页：顶部索引选择 + 搜索框 + 结果列表；「管理索引」进独立页。
class PluginMarketScreen extends StatefulWidget {
  final PluginMarketActions actions;
  final AppStore? store;

  const PluginMarketScreen({
    super.key,
    required this.actions,
    this.store,
  });

  @override
  State<PluginMarketScreen> createState() => _PluginMarketScreenState();
}

class _PluginMarketScreenState extends State<PluginMarketScreen> {
  PluginMarketIndexes? _indexes;
  bool _loadingIndexes = true;
  String? _indexesError;

  /// 当前搜索的索引（必须来自 `_indexes.indexes`，**绝不**接受自由输入）。
  String _selectedUrl = '';

  final _searchController = TextEditingController();
  String _text = '';
  /// 分类筛选（空 = 全部）。取值来自**已见过**的条目 category，不写死枚举——
  /// 分类词汇属于索引文档，App 不重算（与 #153「分类事实来自宿主」一致）。
  String _category = '';

  /// 本次会话里见过的分类（随每次搜索结果累积）。
  /// 不能只看当前页：切换筛选后页面会被清空，chips 会跟着消失。
  final Set<String> _knownCategories = {};

  PluginMarketPage? _page;
  bool _loadingPage = false;
  String? _pageError;
  bool _loadingMore = false;

  @override
  void initState() {
    super.initState();
    _loadIndexes();
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  Future<void> _loadIndexes() async {
    setState(() {
      _loadingIndexes = true;
      _indexesError = null;
    });
    try {
      final indexes = await widget.actions.loadIndexes();
      if (!mounted) return;
      setState(() {
        _indexes = indexes;
        _loadingIndexes = false;
        // 默认选第一个**可用**的索引；全都不可用则留空（页面显示错误态）。
        final firstUsable = indexes.indexes.where((row) => row.usable).toList();
        if (_selectedUrl.isEmpty && firstUsable.isNotEmpty) {
          _selectedUrl = firstUsable.first.url;
        }
      });
      if (_selectedUrl.isNotEmpty) await _search(reset: true);
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loadingIndexes = false;
        _indexesError = L10n.t('读取市场索引失败', 'Could not read market indexes');
      });
    }
  }

  Future<void> _search({bool reset = false}) async {
    final search = widget.actions.search;
    if (search == null || _selectedUrl.isEmpty) return;
    final offset = reset ? 0 : (_page?.nextOffset ?? 0);
    if (reset) {
      setState(() {
        _loadingPage = true;
        _pageError = null;
      });
    } else {
      setState(() => _loadingMore = true);
    }
    try {
      final page = await search(
        _selectedUrl,
        offset: offset,
        limit: 20,
        text: _text,
        category: _category,
      );
      if (!mounted) return;
      setState(() {
        _loadingPage = false;
        _loadingMore = false;
        for (final entry in page.entries) {
          if (entry.category.isNotEmpty) _knownCategories.add(entry.category);
        }
        _page = reset || _page == null
            ? page
            : PluginMarketPage(
                url: page.url,
                title: page.title,
                description: page.description,
                fetchedAt: page.fetchedAt,
                total: page.total,
                nextOffset: page.nextOffset,
                entries: [..._page!.entries, ...page.entries],
              );
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _loadingPage = false;
        _loadingMore = false;
        _pageError = _marketErrorText(e.body?['error'] as String?);
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loadingPage = false;
        _loadingMore = false;
        _pageError = L10n.t('搜索失败，请重试', 'Search failed; retry');
      });
    }
  }

  String _marketErrorText(String? code) => switch (code) {
    'unknown-index' => L10n.t(
      '这个索引不在电脑端的已配置列表里（可能已被移除）。',
      'This index is not in the desktop configured list (it may have been removed).',
    ),
    'index-invalid' => L10n.t('索引地址无效。', 'The index address is invalid.'),
    'index-unusable' => L10n.t(
      '该索引当前不可用（电脑端显示无法解析）。',
      'This index is currently unusable (the desktop reports an error).',
    ),
    'invalid-query' => L10n.t('搜索参数无效。', 'Invalid search parameters.'),
    // #178：超时与 HTTP 失败分开——用户能做的应对不同（等一下重试 vs 查地址/网络）。
    'index-fetch-timeout' => L10n.t(
      '索引抓取超时，请稍后重试。若经常超时，可在电脑端调大插件市场的 fetchTimeoutMs。',
      'Fetching the index timed out; retry later. If this keeps happening, raise the desktop '
          'plugin market fetchTimeoutMs.',
    ),
    'index-fetch-failed' => L10n.t(
      '电脑端抓取该索引失败，请检查电脑端网络或索引地址。',
      'The desktop could not fetch this index; check its network or the index address.',
    ),
    'index-invalid-document' => L10n.t(
      '该索引的内容格式无效（不是有效的插件市场索引）。',
      'This index document is invalid (not a valid plugin market index).',
    ),
    _ => L10n.t('搜索失败，请重试', 'Search failed; retry'),
  };

  Future<void> _openIndexManager() async {
    final indexes = _indexes;
    if (indexes == null || !indexes.supported) return;
    final changed = await Navigator.of(context).push<bool>(
      MaterialPageRoute<bool>(
        builder: (_) => PluginMarketIndexScreen(
          initial: indexes,
          save: widget.actions.saveIndexes,
        ),
      ),
    );
    if (changed == true) {
      // 索引变了：当前选择可能已失效，重读并按新列表重选。
      setState(() => _selectedUrl = '');
      await _loadIndexes();
    }
  }

  Future<void> _openInstall(PluginMarketEntry entry) async {
    final installBySpec = widget.actions.installBySpec;
    if (installBySpec == null) return;
    final target = entry.defaultTarget;
    if (target == null) return;
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => PluginSpecInstallScreen(
          store: widget.store,
          // 预校验直接返回「已接受」：宿主市场条目已经给了确定的安装目标，
          // 再校验一次只会多一次网络往返；安装仍由宿主 installBundle 完整校验。
          inspect: (spec, {registry}) async => PluginSpecInspection(
            supported: true,
            status: 'accepted',
            kind: target.spec.startsWith('git+') ? 'git' : 'registry',
            name: entry.name,
            version: target.version,
            description: entry.description,
            bundle: null,
            registry: target.registry,
          ),
          initialInspection: PluginSpecInspection(
            supported: true,
            status: 'accepted',
            kind: target.spec.startsWith('git+') ? 'git' : 'registry',
            name: entry.name,
            version: target.version,
            description: entry.description,
            bundle: null,
            registry: target.registry,
          ),
          initialSpec: target.spec,
          // 市场条目自带「装哪个源」（宿主 marketInstallTarget 给出）：锁定它，
          // 避免用户改源后装到另一个源上的同名包。
          lockedRegistry: target.registry.isEmpty ? null : target.registry,
          onInstall: (spec, {registry}) => installBySpec(spec, registry),
          loadRegistries: widget.actions.registries,
          poll: widget.actions.poll,
          cancel: widget.actions.cancel,
        ),
      ),
    );
    if (!mounted) return;
    // 装完刷新当前页（安装状态变了）。
    await _search(reset: true);
  }

  @override
  Widget build(BuildContext context) {
    final indexes = _indexes;
    return Scaffold(
      appBar: AppBar(
        title: Text(
          L10n.t('插件市场', 'Plugin market'),
          style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
        ),
        actions: [
          if (indexes != null && indexes.supported)
            IconButton(
              key: const ValueKey('market-manage-indexes'),
              tooltip: L10n.t('管理索引', 'Manage indexes'),
              icon: const Icon(Icons.tune),
              onPressed: _loadingIndexes ? null : _openIndexManager,
            ),
          IconButton(
            key: const ValueKey('market-refresh'),
            tooltip: L10n.t('刷新', 'Refresh'),
            icon: _loadingIndexes
                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.refresh),
            onPressed: _loadingIndexes ? null : _loadIndexes,
          ),
        ],
      ),
      body: SafeArea(child: _body(context)),
    );
  }

  Widget _body(BuildContext context) {
    if (_loadingIndexes && _indexes == null) {
      return const Center(child: SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2)));
    }
    final indexes = _indexes;
    if (_indexesError != null) {
      return _centered(context, Icons.error_outline, DshColors.danger(context), _indexesError!, retry: _loadIndexes);
    }
    if (indexes == null || !indexes.supported) {
      return _centered(
        context,
        Icons.storefront_outlined,
        DshColors.ink2(context),
        L10n.t(
          '当前电脑端不支持插件市场（未安装或版本过旧）。',
          'This desktop does not support the plugin market (missing or too old).',
        ),
      );
    }
    final usable = indexes.indexes.where((row) => row.usable).toList();
    if (usable.isEmpty) {
      return _centered(
        context,
        Icons.playlist_remove,
        DshColors.ink2(context),
        indexes.indexes.isEmpty
            ? L10n.t('还没有配置任何市场索引。', 'No market index is configured.')
            : L10n.t('所有已配置索引都不可用。', 'Every configured index is unusable.'),
        retry: _loadIndexes,
        action: indexes.writable
            ? (L10n.t('管理索引', 'Manage indexes'), _openIndexManager)
            : null,
      );
    }
    return RefreshIndicator(
      onRefresh: () => _search(reset: true),
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
        children: [
          _indexPicker(context, indexes, usable),
          const SizedBox(height: 10),
          _searchBar(context),
          const SizedBox(height: 10),
          ..._categoryChips(context),
          if (_pageError != null) _notice(context, Icons.warning_amber_outlined, _pageError!),
          if (_loadingPage)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 24),
              child: Center(child: SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2))),
            )
          else if (_page != null) ..._results(context, _page!),
        ],
      ),
    );
  }

  List<Widget> _results(BuildContext context, PluginMarketPage page) {
    if (page.entries.isEmpty) {
      return [
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 28),
          child: Column(
            children: [
              Icon(Icons.search_off, size: 26, color: DshColors.ink2(context)),
              const SizedBox(height: 8),
              Text(
                _text.isEmpty
                    ? L10n.t('这个索引没有插件。', 'This index lists no plugins.')
                    : L10n.t('没有匹配的插件。', 'No matching plugins.'),
                style: TextStyle(fontSize: 12.5, color: DshColors.ink3(context)),
              ),
            ],
          ),
        ),
      ];
    }
    return [
      Row(
        children: [
          Text(
            L10n.t('共 ${page.total} 个', '${page.total} total'),
            style: TextStyle(fontSize: 11.5, color: DshColors.ink3(context)),
          ),
        ],
      ),
      const SizedBox(height: 4),
      for (final entry in page.entries) _entryRow(context, entry),
      if (page.hasMore)
        Padding(
          padding: const EdgeInsets.only(top: 10),
          child: OutlinedButton(
            key: const ValueKey('market-load-more'),
            onPressed: _loadingMore ? null : () => _search(reset: false),
            child: _loadingMore
                ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                : Text(L10n.t('加载更多', 'Load more')),
          ),
        ),
    ];
  }

  Widget _indexPicker(BuildContext context, PluginMarketIndexes indexes, List<PluginMarketIndex> usable) {
    if (usable.length == 1) {
      return Row(
        children: [
          Icon(Icons.source_outlined, size: 15, color: DshColors.ink3(context)),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              usable.first.displayLabel,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 11.5, color: DshColors.ink3(context)),
            ),
          ),
        ],
      );
    }
    return Wrap(
      spacing: 6,
      runSpacing: 6,
      children: [
        for (final row in usable)
          ChoiceChip(
            key: ValueKey('market-index-${row.url}'),
            label: Text(row.displayLabel, style: const TextStyle(fontSize: 11.5)),
            selected: _selectedUrl == row.url,
            onSelected: (_) {
              setState(() {
                _selectedUrl = row.url;
                _page = null;
              });
              unawaited(_search(reset: true));
            },
          ),
      ],
    );
  }

  /// 分类筛选 chips：取值来自**当前已返回条目**的 category（不写死枚举）。
  ///
  /// 只有出现 2 个以上不同分类时才渲染——否则一个 chip 只是噪声。
  List<Widget> _categoryChips(BuildContext context) {
    // 用累积集合而不是当前页：切筛选会清空 `_page`，否则 chips 会闪没。
    if (_knownCategories.length < 2) return const [];
    final ordered = _knownCategories.toList()..sort();
    return [
      Wrap(
        spacing: 6,
        runSpacing: 6,
        children: [
          ChoiceChip(
            key: const ValueKey('market-category-all'),
            label: Text(L10n.t('全部', 'All'), style: const TextStyle(fontSize: 11.5)),
            selected: _category.isEmpty,
            onSelected: (_) => _selectCategory(''),
          ),
          for (final category in ordered)
            ChoiceChip(
              key: ValueKey('market-category-$category'),
              label: Text(
                PluginCategory(kind: category, label: category).displayLabel,
                style: const TextStyle(fontSize: 11.5),
              ),
              selected: _category == category,
              onSelected: (_) => _selectCategory(category),
            ),
        ],
      ),
      const SizedBox(height: 8),
    ];
  }

  void _selectCategory(String category) {
    setState(() {
      _category = category;
      _page = null;
    });
    unawaited(_search(reset: true));
  }

  Widget _searchBar(BuildContext context) {
    return TextField(
      key: const ValueKey('market-search'),
      controller: _searchController,
      decoration: InputDecoration(
        isDense: true,
        hintText: L10n.t('搜索插件', 'Search plugins'),
        border: const OutlineInputBorder(),
        prefixIcon: const Icon(Icons.search, size: 18),
        suffixIcon: _searchController.text.isEmpty
            ? null
            : IconButton(
                tooltip: L10n.t('清除搜索', 'Clear search'),
                icon: const Icon(Icons.close, size: 16),
                onPressed: () => setState(() {
                  _searchController.clear();
                  _text = '';
                  _page = null;
                }),
              ),
      ),
      onSubmitted: (value) {
        setState(() {
          _text = value.trim();
          _page = null;
        });
        unawaited(_search(reset: true));
      },
      onChanged: (value) => setState(() {}),
    );
  }

  Widget _entryRow(BuildContext context, PluginMarketEntry entry) {
    final compact =
        MediaQuery.sizeOf(context).width <= 340 ||
        MediaQuery.textScalerOf(context).scale(1) >= 1.4;
    final target = entry.defaultTarget;
    final statusLabel = switch (entry.installationStatus) {
      'installed' => L10n.t('已安装', 'Installed'),
      'update-available' => L10n.t('可更新', 'Update available'),
      'different-version' => L10n.t('已装其他版本', 'Other version installed'),
      'provided' => L10n.t('随安装提供', 'Provided by the app'),
      _ => L10n.t('未安装', 'Not installed'),
    };
    final statusColor = switch (entry.installationStatus) {
      'installed' => DshColors.ok(context),
      'update-available' => DshColors.brand(context),
      'different-version' => DshColors.warn(context),
      _ => DshColors.ink3(context),
    };
    return Container(
      key: ValueKey('market-entry-${entry.name}'),
      constraints: const BoxConstraints(minHeight: 64),
      padding: const EdgeInsets.symmetric(vertical: 9),
      decoration: BoxDecoration(border: Border(bottom: BorderSide(color: DshColors.line(context)))),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 34,
            height: 34,
            decoration: BoxDecoration(color: DshColors.brandSoft(context), borderRadius: BorderRadius.circular(9)),
            child: Icon(Icons.extension_outlined, size: 18, color: DshColors.brand(context)),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  entry.displayName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: 2),
                Text(
                  entry.description.isEmpty ? entry.name : entry.description,
                  maxLines: compact ? 2 : 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 11.5, height: 1.35, color: DshColors.ink3(context)),
                ),
                const SizedBox(height: 3),
                Wrap(
                  spacing: 6,
                  runSpacing: 3,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    if (target != null)
                      Text(
                        'v${target.version}',
                        style: TextStyle(fontSize: 11, fontFamily: 'monospace', color: DshColors.ink2(context)),
                      ),
                    if (entry.category.isNotEmpty)
                      PluginCategoryTag(category: PluginCategory(kind: entry.category, label: entry.category)),
                    Text(statusLabel, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: statusColor)),
                    if (!compact && entry.installedVersion.isNotEmpty)
                      Text(
                        L10n.t('已装 v${entry.installedVersion}', 'installed v${entry.installedVersion}'),
                        style: TextStyle(fontSize: 10.5, color: DshColors.ink3(context)),
                      ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(width: 6),
          if (!widget.actions.canInstall || target == null)
            const SizedBox.shrink()
          else
            TextButton(
              key: ValueKey('market-install-${entry.name}'),
              style: TextButton.styleFrom(minimumSize: const Size(44, 44)),
              onPressed: () => _openInstall(entry),
              child: Text(
                entry.installed
                    ? L10n.t('重装', 'Reinstall')
                    : entry.hasUpdate
                    ? L10n.t('升级', 'Update')
                    : L10n.t('安装', 'Install'),
              ),
            ),
        ],
      ),
    );
  }

  Widget _notice(BuildContext context, IconData icon, String text) => Container(
    margin: const EdgeInsets.only(bottom: 8),
    padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
    decoration: BoxDecoration(
      color: DshColors.surface(context),
      borderRadius: BorderRadius.circular(8),
      border: Border.all(color: DshColors.line(context)),
    ),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 15, color: DshColors.warn(context)),
        const SizedBox(width: 6),
        Expanded(child: Text(text, style: TextStyle(fontSize: 12, height: 1.45, color: DshColors.ink2(context)))),
      ],
    ),
  );

  Widget _centered(
    BuildContext context,
    IconData icon,
    Color color,
    String text, {
    VoidCallback? retry,
    (String, Future<void> Function())? action,
  }) => Center(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 30, color: color),
          const SizedBox(height: 8),
          Text(text, textAlign: TextAlign.center, style: TextStyle(fontSize: 12.5, height: 1.45, color: DshColors.ink2(context))),
          const SizedBox(height: 10),
          if (action != null)
            FilledButton(
              key: const ValueKey('market-empty-manage'),
              onPressed: () => unawaited(action.$2()),
              child: Text(action.$1),
            )
          else if (retry != null)
            OutlinedButton(onPressed: retry, child: Text(L10n.t('重试', 'Retry'))),
        ],
      ),
    ),
  );
}

/// 索引管理页：列出 url/title/error，支持增删改；保存前显式确认「修改电脑端」。
class PluginMarketIndexScreen extends StatefulWidget {
  final PluginMarketIndexes initial;
  final Future<PluginMarketIndexes> Function(List<String> urls)? save;

  const PluginMarketIndexScreen({super.key, required this.initial, this.save});

  @override
  State<PluginMarketIndexScreen> createState() => _PluginMarketIndexScreenState();
}

class _PluginMarketIndexScreenState extends State<PluginMarketIndexScreen> {
  /// 编辑器里的一组 URL（与 `initial` 分离，便于取消时不落盘）。
  late List<TextEditingController> _controllers;

  /// 进入页面时的原始配置（保留用于「新增/删除」以外的差异说明；当前仅作记录）。
  late List<PluginMarketIndex> _original;
  bool _saving = false;
  String? _error;

  /// 有未保存改动（用于返回时提示；不阻止返回）。
  bool _dirty = false;

  bool get _writable => widget.save != null && widget.initial.writable;

  @override
  void initState() {
    super.initState();
    _original = widget.initial.indexes;
    _controllers = [for (final row in _original) TextEditingController(text: row.url)];
  }

  @override
  void dispose() {
    for (final controller in _controllers) {
      controller.dispose();
    }
    super.dispose();
  }

  /// 客户端**即时**校验（只做形态；权威判定在宿主）。
  ///
  /// 刻意与 registry 的校验分开：索引 URL 常带路径，**不补尾斜杠**。
  String _validate(String raw) {
    final value = raw.trim();
    if (value.isEmpty) return L10n.t('不能为空', 'Cannot be empty');
    if (value.length > 2048) return L10n.t('地址过长', 'Too long');
    if (RegExp(r'[\u0000-\u001f\u007f]').hasMatch(value)) {
      return L10n.t('含控制字符', 'Contains control characters');
    }
    if (RegExp(r'\s').hasMatch(value)) return L10n.t('不能含空格', 'No spaces allowed');
    final uri = Uri.tryParse(value);
    if (uri == null) return L10n.t('地址无效', 'Invalid address');
    if (uri.scheme != 'http' && uri.scheme != 'https') {
      return L10n.t('只接受 http(s)', 'Only http(s)');
    }
    if (uri.host.isEmpty) return L10n.t('地址无效', 'Invalid address');
    if (uri.userInfo.isNotEmpty) return L10n.t('不能含凭据', 'No credentials');
    if (uri.hasFragment) return L10n.t('不能含片段', 'No fragment');
    if (uri.hasQuery) return L10n.t('不能含查询参数', 'No query string');
    return '';
  }

  List<String> get _urls =>
      [for (final controller in _controllers) controller.text.trim()];

  bool get _allValid => _urls.every((url) => _validate(url).isEmpty);

  void _addRow() {
    setState(() {
      _controllers.add(TextEditingController());
      _dirty = true;
    });
  }

  void _removeRow(int index) {
    setState(() {
      _controllers.removeAt(index).dispose();
      _dirty = true;
    });
  }

  Future<void> _save() async {
    final save = widget.save;
    if (save == null) return;
    if (!_allValid) {
      setState(() => _error = L10n.t('请先修正无效的索引地址。', 'Fix the invalid index addresses first.'));
      return;
    }
    final urls = _urls;
    setState(() => _error = null);
    // **显式确认**：这是写电脑端配置。
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(L10n.t('修改电脑端的插件市场索引？', 'Change the desktop plugin market indexes?'), style: const TextStyle(fontSize: 16)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              L10n.t(
                '这会修改电脑端的插件市场索引配置（共 ${urls.length} 条），不只是这台手机。\n'
                    '保存后电脑端的插件页也会用这套索引。',
                'This changes the desktop plugin market index configuration (${urls.length} entries), '
                    'not just this phone. The desktop plugin page uses the same indexes afterwards.',
              ),
              style: const TextStyle(fontSize: 13, height: 1.5),
            ),
            const SizedBox(height: 10),
            Text(
              L10n.t(
                '只有这里列出的地址会被用来搜索；未列出的地址会被拒绝（防止任意 URL 抓取）。',
                'Only the addresses listed here can be searched; any other address is refused '
                    '(to prevent arbitrary URL fetching).',
              ),
              style: TextStyle(fontSize: 12, height: 1.4, color: DshColors.ink3(context)),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: Text(L10n.t('取消', 'Cancel')),
          ),
          FilledButton(
            key: const ValueKey('market-index-save-confirm'),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text(L10n.t('保存到电脑端', 'Save to desktop')),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    setState(() => _saving = true);
    try {
      await save(urls);
      if (!mounted) return;
      setState(() {
        _saving = false;
        _dirty = false;
      });
      Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      if (!mounted) return;
      final detail = e.body?['detail'] as String?;
      final index = e.body?['index'];
      setState(() {
        _saving = false;
        _error = _saveErrorText(e.body?['error'] as String?, detail, index);
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = L10n.t('保存失败，请重试', 'Save failed; retry');
      });
    }
  }

  String _saveErrorText(String? code, String? detail, Object? index) {
    final where = index is num ? L10n.t('第 ${index.toInt() + 1} 条', 'entry ${index.toInt() + 1}') : '';
    final reason = switch (detail) {
      'too-long' => L10n.t('地址过长', 'address too long'),
      'control-char' => L10n.t('含控制字符', 'control characters'),
      'unsupported-protocol' => L10n.t('只接受 http(s)', 'only http(s)'),
      'has-credentials' => L10n.t('不能含凭据', 'credentials not allowed'),
      'has-fragment' => L10n.t('不能含片段', 'fragment not allowed'),
      'has-query' => L10n.t('不能含查询参数', 'query not allowed'),
      'too-many' => L10n.t('最多 8 条索引', 'at most 8 indexes'),
      'not-array' => L10n.t('数据格式无效', 'invalid payload'),
      'empty' => L10n.t('不能为空', 'empty'),
      'whitespace' => L10n.t('不能含空格', 'whitespace'),
      'unparsable' => L10n.t('地址无效', 'invalid address'),
      _ => L10n.t('地址无效', 'invalid address'),
    };
    return switch (code) {
      'index-invalid' => L10n.t(
        '索引$where无效：$reason',
        'Invalid index${where.isEmpty ? '' : ' ($where)'}: $reason',
      ),
      'settings-write-unavailable' => L10n.t(
        '电脑端当前不允许写入市场索引（缺少 settings 或 profile 条目）。',
        'The desktop cannot write market indexes right now (no settings or profile entry).',
      ),
      'plugin-market-unavailable' => L10n.t(
        '电脑端不支持插件市场。',
        'The desktop does not support the plugin market.',
      ),
      _ => L10n.t('保存失败，请重试', 'Save failed; retry'),
    };
  }

  /// 离开前提醒：有未保存改动时给一次确认（避免误退丢编辑）。
  Future<void> _confirmLeave() async {
    if (!_dirty || _saving) {
      if (mounted) Navigator.of(context).pop(false);
      return;
    }
    final leave = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(L10n.t('放弃未保存的修改？', 'Discard unsaved changes?'), style: const TextStyle(fontSize: 16)),
        content: Text(
          L10n.t('索引改动尚未保存到电脑端。', 'The index changes are not saved to the desktop yet.'),
          style: const TextStyle(fontSize: 13, height: 1.5),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: Text(L10n.t('继续编辑', 'Keep editing')),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text(L10n.t('放弃', 'Discard')),
          ),
        ],
      ),
    );
    if (leave == true && mounted) Navigator.of(context).pop(false);
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: !_dirty || _saving,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        unawaited(_confirmLeave());
      },
      child: Scaffold(
      appBar: AppBar(
        title: Text(
          L10n.t('市场索引', 'Market indexes'),
          style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
        ),
        actions: [
          if (_writable)
            TextButton(
              key: const ValueKey('market-index-save'),
              onPressed: _saving ? null : _save,
              child: _saving
                  ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                  : Text(L10n.t('保存', 'Save')),
            ),
        ],
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 24),
          children: [
            _banner(context),
            const SizedBox(height: 12),
            if (_error != null) ...[
              _errorBox(context, _error!),
              const SizedBox(height: 10),
            ],
            for (var i = 0; i < _controllers.length; i++) _row(context, i),
            if (_writable) ...[
              const SizedBox(height: 6),
              OutlinedButton.icon(
                key: const ValueKey('market-index-add'),
                onPressed: _saving ? null : _addRow,
                icon: const Icon(Icons.add, size: 16),
                label: Text(L10n.t('添加索引', 'Add index')),
              ),
            ],
            const SizedBox(height: 16),
            Text(
              L10n.t(
                '索引地址必须带完整路径（如 https://example.com/index.json）；'
                    '不接受凭据、查询参数与片段。',
                'An index address needs its full path (e.g. https://example.com/index.json); '
                    'credentials, query strings and fragments are refused.',
              ),
              style: TextStyle(fontSize: 11, height: 1.45, color: DshColors.ink3(context)),
            ),
            // issue #178：只读展示当前抓取超时；改值只能在电脑端。
            if (widget.initial.fetchTimeoutLabel.isNotEmpty) ...[
              const SizedBox(height: 8),
              Text(
                L10n.t(
                  '电脑端当前抓取超时：${widget.initial.fetchTimeoutLabel}（只读，需在电脑端调整）。',
                  'Desktop fetch timeout: ${widget.initial.fetchTimeoutLabel} (read-only; change it on the desktop).',
                ),
                style: TextStyle(fontSize: 11, height: 1.45, color: DshColors.ink3(context)),
              ),
            ],
          ],
        ),
      ),
      ),
    );
  }

  Widget _banner(BuildContext context) {
    if (!_writable) {
      return Container(
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
        decoration: BoxDecoration(
          color: DshColors.surface(context),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: DshColors.line(context)),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(Icons.lock_outline, size: 16, color: DshColors.ink3(context)),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                L10n.t('当前电脑端不允许修改市场索引（只读）。', 'This desktop does not allow changing market indexes (read-only).'),
                style: TextStyle(fontSize: 12, height: 1.4, color: DshColors.ink2(context)),
              ),
            ),
          ],
        ),
      );
    }
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: DshColors.brandSoft(context),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: DshColors.line(context)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.warning_amber_outlined, size: 16, color: DshColors.warn(context)),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              L10n.t(
                '这里的修改会写入电脑端的插件市场配置，不只是这台手机。',
                'Changes here are written to the desktop plugin market configuration, not just this phone.',
              ),
              style: TextStyle(fontSize: 12, height: 1.4, color: DshColors.ink2(context)),
            ),
          ),
        ],
      ),
    );
  }

  Widget _errorBox(BuildContext context, String text) => Container(
    padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
    decoration: BoxDecoration(
      color: DshColors.surface(context),
      borderRadius: BorderRadius.circular(8),
      border: Border.all(color: DshColors.danger(context).withValues(alpha: 0.45)),
    ),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(Icons.error_outline, size: 15, color: DshColors.danger(context)),
        const SizedBox(width: 6),
        Expanded(child: Text(text, style: TextStyle(fontSize: 12, height: 1.45, color: DshColors.ink2(context)))),
      ],
    ),
  );

  Widget _row(BuildContext context, int index) {
    final error = _validate(_controllers[index].text);
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: TextField(
              key: ValueKey('market-index-url-$index'),
              controller: _controllers[index],
              enabled: _writable && !_saving,
              autocorrect: false,
              enableSuggestions: false,
              decoration: InputDecoration(
                isDense: true,
                border: const OutlineInputBorder(),
                hintText: 'https://example.com/index.json',
                errorText: _writable && _controllers[index].text.isNotEmpty && error.isNotEmpty ? error : null,
              ),
              onChanged: (_) => setState(() => _dirty = true),
            ),
          ),
          if (_writable)
            IconButton(
              key: ValueKey('market-index-remove-$index'),
              tooltip: L10n.t('删除', 'Remove'),
              icon: const Icon(Icons.delete_outline, size: 18),
              onPressed: _saving ? null : () => _removeRow(index),
            ),
        ],
      ),
    );
  }
}
