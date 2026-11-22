// GitLab #152 / ADR 0036：连接档案管理（自包含页面/区块）。
//
// UI 决策（用户 2026-11-22）：连接切换/管理只放设置页；最终由 #155 五 Tab 壳嵌入。
// 本文件不依赖 Drawer/聊天页，也不直接改 settings_screen 的布局；#155 只需挂载
// [ConnectionSettingsSection] 或 push [ConnectionProfilesScreen]。
import 'package:flutter/material.dart';

import '../connection_manager.dart';
import '../connection_profile.dart';
import '../l10n.dart';
import '../store.dart';
import '../theme.dart';

Future<bool> showConnectionProfilesScreen(
  BuildContext context,
  AppStore store,
) async {
  final changed = await Navigator.of(context).push<bool>(
    MaterialPageRoute<bool>(
      builder: (_) => ConnectionProfilesScreen(store: store),
    ),
  );
  return changed == true;
}

/// #155 可直接嵌入「连接」Tab 的自包含区块；当前版本也可从设置页 push 整页。
class ConnectionSettingsSection extends StatelessWidget {
  const ConnectionSettingsSection({super.key, required this.store});

  final AppStore store;

  @override
  Widget build(BuildContext context) {
    final manager = store.connections;
    final active = manager?.active;
    final ink3 = DshColors.ink3(context);
    return Card(
      margin: const EdgeInsets.fromLTRB(16, 8, 16, 8),
      child: ListTile(
        key: const ValueKey('connection-settings-section'),
        leading: Icon(
          Icons.computer,
          color: active == null ? ink3 : DshColors.brand(context),
        ),
        title: Text(
          active?.displayName ?? L10n.t('未连接电脑', 'No computer connected'),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        subtitle: Text(
          active?.primaryBase ?? L10n.t('添加电脑连接', 'Add a computer connection'),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(fontSize: 11.5, color: ink3),
        ),
        trailing: Text(
          L10n.t('管理 ▸', 'Manage ▸'),
          style: TextStyle(fontSize: 12, color: DshColors.brand(context)),
        ),
        onTap: () => showConnectionProfilesScreen(context, store),
      ),
    );
  }
}

class ConnectionProfilesScreen extends StatefulWidget {
  const ConnectionProfilesScreen({super.key, required this.store});

  final AppStore store;

  @override
  State<ConnectionProfilesScreen> createState() => _ConnectionProfilesScreenState();
}

class _ConnectionProfilesScreenState extends State<ConnectionProfilesScreen> {
  String? _switching;
  String? _error;
  bool _changed = false;

  ConnectionManager? get _manager => widget.store.connections;

  Future<void> _switch(ConnectionProfile profile) async {
    final manager = _manager;
    if (manager == null) return;
    if (profile.id == manager.activeProfileId) return;
    setState(() {
      _switching = profile.id;
      _error = null;
    });
    var error = await widget.store.switchProfile(profile.id);
    if (!mounted) return;
    if (error != null &&
        (error.contains('宿主身份已变化') || error.contains('未加密'))) {
      final allowHostChange = error.contains('宿主身份已变化');
      final retry = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: Text(
            allowHostChange
                ? L10n.t('宿主身份变化', 'Host identity changed')
                : L10n.t('允许未加密连接？', 'Allow unencrypted connection?'),
          ),
          content: Text(
            allowHostChange
                ? L10n.t(
                    '档案记录的 hostId 与目标电脑不一致。继续只会在你确认后绑定新身份，不会继承旧缓存。',
                    'The saved hostId differs from the target computer. Continuing binds the new identity only after your confirmation; old cache is not inherited.',
                  )
                : L10n.t(
                    '该地址使用 HTTP，口令会以未加密方式传输。仅在你信任当前网络时继续。',
                    'This address uses HTTP; the access token travels unencrypted. Continue only on a network you trust.',
                  ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: Text(L10n.t('取消', 'Cancel')),
            ),
            FilledButton(
              onPressed: () => Navigator.of(ctx).pop(true),
              child: Text(L10n.t('继续', 'Continue')),
            ),
          ],
        ),
      );
      if (retry != true || !mounted) {
        setState(() {
          _switching = null;
          _error = error;
        });
        return;
      }
      error = await widget.store.switchProfile(
        profile.id,
        allowHostChange: allowHostChange,
        allowInsecure: !allowHostChange,
      );
      if (!mounted) return;
    }
    if (error != null) {
      setState(() {
        _switching = null;
        _error = error;
      });
      return;
    }
    _changed = true;
    if (mounted) Navigator.of(context).pop(true);
  }

  Future<void> _add() async {
    final manager = _manager;
    if (manager == null) return;
    final created = await Navigator.of(context).push<bool>(
      MaterialPageRoute<bool>(
        builder: (_) => ConnectionProfileEditorScreen(
          store: widget.store,
          manager: manager,
        ),
      ),
    );
    if (!mounted) return;
    if (created == true) {
      _changed = true;
      setState(() {});
    }
  }

  Future<void> _rename(ConnectionProfile profile) async {
    final controller = TextEditingController(text: profile.displayName);
    final name = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(L10n.t('重命名连接', 'Rename connection')),
        content: TextField(
          controller: controller,
          autofocus: true,
          decoration: InputDecoration(labelText: L10n.t('名称', 'Name')),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: Text(L10n.t('取消', 'Cancel')),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(controller.text.trim()),
            child: Text(L10n.t('保存', 'Save')),
          ),
        ],
      ),
    );
    controller.dispose();
    if (!mounted || name == null || name.isEmpty) return;
    await _manager!.updateProfile(profile.copyWith(displayName: name));
    if (mounted) setState(() {});
  }

  Future<void> _delete(ConnectionProfile profile) async {
    final manager = _manager!;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(L10n.t('删除连接？', 'Delete connection?')),
        content: Text(
          L10n.t(
            '将删除“${profile.displayName}”的口令与该档案；不影响电脑端。',
            'Deletes the credential and profile for "${profile.displayName}". The computer is unchanged.',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: Text(L10n.t('取消', 'Cancel')),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: Text(L10n.t('删除', 'Delete')),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    try {
      await manager.deleteProfile(profile.id);
      if (mounted) setState(() {});
    } on ConnectionSwitchException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final manager = _manager;
    final ink3 = DshColors.ink3(context);
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop && mounted) Navigator.of(context).pop(_changed);
      },
      child: Scaffold(
        appBar: AppBar(
          title: Text(L10n.t('连接档案', 'Connections')),
        ),
        body: manager == null
            ? const Center(child: Text('连接档案未初始化'))
            : RefreshIndicator(
                onRefresh: () async => setState(() {}),
                child: ListView(
                  padding: const EdgeInsets.only(bottom: 24),
                  children: [
                    Padding(
                      padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
                      child: Text(
                        L10n.t('当前电脑', 'Current computer'),
                        style: TextStyle(fontSize: 11, color: ink3),
                      ),
                    ),
                    if (_error != null)
                      Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 20,
                          vertical: 6,
                        ),
                        child: Text(
                          _error!,
                          key: const ValueKey('connection-switch-error'),
                          style: TextStyle(
                            fontSize: 12,
                            color: DshColors.danger(context),
                          ),
                        ),
                      ),
                    for (final profile in manager.profiles)
                      ListTile(
                        key: ValueKey('connection-profile-${profile.id}'),
                        leading: Icon(
                          profile.id == manager.activeProfileId
                              ? Icons.computer
                              : Icons.computer_outlined,
                          color: profile.id == manager.activeProfileId
                              ? DshColors.brand(context)
                              : ink3,
                        ),
                        title: Text(
                          profile.displayName,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        subtitle: Text(
                          '${profile.primaryBase}'
                          '${profile.tlsPolicy == ProfileTlsPolicy.httpPrivate ? ' · ${L10n.t('未加密', 'unencrypted')}' : ''}',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 11.5, color: ink3),
                        ),
                        trailing: _switching == profile.id
                            ? const SizedBox(
                                width: 18,
                                height: 18,
                                child: CircularProgressIndicator(strokeWidth: 2),
                              )
                            : profile.id == manager.activeProfileId
                            ? Icon(
                                Icons.check,
                                size: 18,
                                color: DshColors.ok(context),
                              )
                            : PopupMenuButton<String>(
                                tooltip: L10n.t('更多', 'More'),
                                enabled: _switching == null,
                                onSelected: (value) {
                                  if (value == 'delete') _delete(profile);
                                  if (value == 'rename') _rename(profile);
                                },
                                itemBuilder: (_) => [
                                  PopupMenuItem(
                                    value: 'rename',
                                    child: Text(L10n.t('重命名', 'Rename')),
                                  ),
                                  PopupMenuItem(
                                    value: 'delete',
                                    child: Text(L10n.t('删除', 'Delete')),
                                  ),
                                ],
                              ),
                        onTap: _switching == null
                            ? () => _switch(profile)
                            : null,
                      ),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                      child: FilledButton.tonalIcon(
                        key: const ValueKey('connection-add'),
                        onPressed: _switching == null ? _add : null,
                        icon: const Icon(Icons.add),
                        label: Text(L10n.t('添加电脑', 'Add computer')),
                      ),
                    ),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(20, 12, 20, 0),
                      child: Text(
                        L10n.t(
                          '同一时刻只连接一台电脑；切换失败会保留当前连接。口令保存在系统安全存储，不写入普通设置。',
                          'One computer is active at a time. A failed switch keeps the current connection. Tokens are stored in the system keystore, not ordinary settings.',
                        ),
                        style: TextStyle(fontSize: 11.5, height: 1.5, color: ink3),
                      ),
                    ),
                  ],
                ),
              ),
      ),
    );
  }
}

class ConnectionProfileEditorScreen extends StatefulWidget {
  const ConnectionProfileEditorScreen({
    super.key,
    required this.store,
    required this.manager,
  });

  final AppStore store;
  final ConnectionManager manager;

  @override
  State<ConnectionProfileEditorScreen> createState() =>
      _ConnectionProfileEditorScreenState();
}

class _ConnectionProfileEditorScreenState
    extends State<ConnectionProfileEditorScreen> {
  final _name = TextEditingController();
  final _base = TextEditingController();
  final _token = TextEditingController();
  bool _allowInsecure = false;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    _base.dispose();
    _token.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final base = _base.text.trim();
    final token = _token.text.trim();
    if (base.isEmpty || token.isEmpty) {
      setState(() => _error = L10n.t('请填写地址和访问口令', 'Enter address and access token'));
      return;
    }
    if (base.startsWith('http://') && !_allowInsecure) {
      setState(() => _error = L10n.t(
        'HTTP 地址必须勾选“允许未加密连接”',
        'HTTP requires allowing an unencrypted connection',
      ));
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.manager.addProfile(
        displayName: _name.text,
        baseUrl: base,
        token: token,
        tlsPolicy: base.startsWith('https://')
            ? ProfileTlsPolicy.https
            : ProfileTlsPolicy.httpPrivate,
        insecureConfirmed: _allowInsecure,
        switchNow: true,
      );
      if (!mounted) return;
      Navigator.of(context).pop(true);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e is ConnectionSwitchException ? e.message : '$e';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final ink3 = DshColors.ink3(context);
    return Scaffold(
      appBar: AppBar(
        title: Text(L10n.t('添加电脑', 'Add computer')),
        actions: [
          TextButton(
            key: const ValueKey('connection-profile-save'),
            onPressed: _busy ? null : _save,
            child: _busy
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : Text(L10n.t('保存', 'Save')),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          TextField(
            controller: _name,
            decoration: InputDecoration(
              labelText: L10n.t('名称（可选）', 'Name (optional)'),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _base,
            keyboardType: TextInputType.url,
            decoration: InputDecoration(
              labelText: L10n.t('地址', 'Address'),
              hintText: 'https://192.168.1.10:3080/m',
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _token,
            obscureText: true,
            decoration: InputDecoration(
              labelText: L10n.t('访问口令', 'Access token'),
            ),
          ),
          if (_base.text.startsWith('http://')) ...[
            const SizedBox(height: 8),
            CheckboxListTile(
              key: const ValueKey('connection-allow-insecure'),
              value: _allowInsecure,
              onChanged: (value) => setState(() => _allowInsecure = value == true),
              title: Text(L10n.t('允许未加密连接', 'Allow unencrypted connection')),
              subtitle: Text(
                L10n.t('口令会以明文经过当前网络', 'The token travels unencrypted on this network'),
                style: TextStyle(fontSize: 11.5, color: ink3),
              ),
            ),
          ],
          if (_error != null) ...[
            const SizedBox(height: 8),
            Text(_error!, style: TextStyle(color: DshColors.danger(context))),
          ],
          const SizedBox(height: 16),
          Text(
            L10n.t(
              '口令保存在系统安全存储（Android Keystore），不写日志、不在二维码回显。',
              'The token is stored in the system keystore; it is never logged or echoed in QR codes.',
            ),
            style: TextStyle(fontSize: 11.5, color: ink3),
          ),
        ],
      ),
    );
  }
}
