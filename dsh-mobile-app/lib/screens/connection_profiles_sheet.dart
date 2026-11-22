// GitLab #152 / ADR 0036：Drawer 顶部「当前电脑」切换 sheet + 档案编辑。
import 'package:flutter/material.dart';

import '../connection_manager.dart';
import '../connection_profile.dart';
import '../l10n.dart';
import '../store.dart';
import '../theme.dart';

Future<bool> showConnectionProfilesSheet(
  BuildContext context,
  AppStore store, {
  bool fromChat = false,
  String? chatTitle,
  bool hasDraft = false,
}) async {
  final changed = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Theme.of(context).scaffoldBackgroundColor,
    builder: (_) => _ConnectionProfilesSheet(
      store: store,
      fromChat: fromChat,
      chatTitle: chatTitle,
      hasDraft: hasDraft,
    ),
  );
  return changed == true;
}

class _ConnectionProfilesSheet extends StatefulWidget {
  const _ConnectionProfilesSheet({
    required this.store,
    required this.fromChat,
    this.chatTitle,
    this.hasDraft = false,
  });

  final AppStore store;
  final bool fromChat;
  final String? chatTitle;
  final bool hasDraft;

  @override
  State<_ConnectionProfilesSheet> createState() => _ConnectionProfilesSheetState();
}

class _ConnectionProfilesSheetState extends State<_ConnectionProfilesSheet> {
  String? _switching;
  String? _error;

  ConnectionManager? get _manager => widget.store.connections;

  Future<void> _switch(ConnectionProfile profile) async {
    final manager = _manager;
    if (manager == null) return;
    if (profile.id == manager.activeProfileId) {
      Navigator.of(context).pop(false);
      return;
    }
    if (widget.fromChat) {
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: Text(L10n.t('切换电脑？', 'Switch computer?')),
          content: Text(
            L10n.t(
              '切换后将关闭当前对话（${widget.chatTitle ?? '当前会话'}），并重新加载新电脑的会话与审批。\n'
              '未发送的草稿会保留在旧电脑的档案中；切换回来仍可继续。'
              '${widget.hasDraft ? '\n当前输入尚未发送。' : ''}',
              'Switching closes the current conversation (${widget.chatTitle ?? 'current session'}) and reloads sessions/approvals from the new computer.\n'
              'Unsent drafts stay with the old computer profile; you can continue after switching back.'
              '${widget.hasDraft ? '\nThe current input has not been sent.' : ''}',
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: Text(L10n.t('取消', 'Cancel')),
            ),
            FilledButton(
              key: const ValueKey('connection-switch-confirm'),
              onPressed: () => Navigator.of(ctx).pop(true),
              child: Text(L10n.t('切换并关闭对话', 'Switch and close')),
            ),
          ],
        ),
      );
      if (confirmed != true || !mounted) return;
    }
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
    Navigator.of(context).pop(true);
  }

  Future<void> _add() async {
    final created = await Navigator.of(context).push<bool>(
      MaterialPageRoute<bool>(
        builder: (_) => ConnectionProfileEditorScreen(
          store: widget.store,
          manager: _manager!,
        ),
      ),
    );
    if (!mounted) return;
    if (created == true) Navigator.of(context).pop(true);
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
    if (manager == null) {
      return const SafeArea(child: Center(child: Text('连接档案未初始化')));
    }
    final ink3 = DshColors.ink3(context);
    final profiles = manager.profiles;
    final activeId = manager.activeProfileId;
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 16, 12, 8),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          L10n.t('当前电脑', 'Current computer'),
                          style: TextStyle(fontSize: 11, color: ink3),
                        ),
                        Text(
                          manager.active?.displayName ?? L10n.t('未连接', 'Not connected'),
                          key: const ValueKey('connection-current-name'),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    tooltip: L10n.t('关闭', 'Close'),
                    onPressed: () => Navigator.of(context).pop(false),
                    icon: const Icon(Icons.close, size: 20),
                  ),
                ],
              ),
            ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 6),
                child: Text(
                  _error!,
                  key: const ValueKey('connection-switch-error'),
                  style: TextStyle(fontSize: 12, color: DshColors.danger(context)),
                ),
              ),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: [
                  for (final profile in profiles)
                    ListTile(
                      key: ValueKey('connection-profile-${profile.id}'),
                      leading: Icon(
                        profile.id == activeId
                            ? Icons.computer
                            : Icons.computer_outlined,
                        color: profile.id == activeId ? DshColors.brand(context) : ink3,
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
                          : profile.id == activeId
                          ? Icon(Icons.check, size: 18, color: DshColors.ok(context))
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
                      onTap: _switching == null ? () => _switch(profile) : null,
                    ),
                  ListTile(
                    key: const ValueKey('connection-add'),
                    leading: const Icon(Icons.add),
                    title: Text(L10n.t('添加电脑', 'Add computer')),
                    onTap: _switching == null ? _add : null,
                  ),
                ],
              ),
            ),
          ],
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
