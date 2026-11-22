// GitLab #152 / ADR 0036：连接档案管理页面。
//
// UI 决策（用户 2026-11-22）：连接入口移到首页 Drawer「首页」上方；设置页不再
// 保留连接卡/Tab。本页面由 Drawer 入口 push，添加/编辑共用下方编辑器。
import 'package:flutter/material.dart';

import '../connection_manager.dart';
import '../connection_profile.dart';
import '../l10n.dart';
import '../store.dart';
import '../scan_screen.dart';
import '../theme.dart';
import '../toast.dart';

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
  bool _retryingCredentials = false;
  String? _credentialRetryError;

  ConnectionManager? get _manager => widget.store.connections;

  Future<void> _retryCredentials() async {
    final msgr = ScaffoldMessenger.of(context);
    setState(() {
      _retryingCredentials = true;
      _credentialRetryError = null;
    });
    final error = await widget.store.retryConnectionLoad();
    if (!mounted) return;
    setState(() {
      _retryingCredentials = false;
      _credentialRetryError = error;
    });
    if (error == null) {
      showToastAt(msgr, L10n.t('已恢复连接', 'Connection recovered'));
    }
  }

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

  Future<void> _edit(ConnectionProfile profile) async {
    final changed = await Navigator.of(context).push<bool>(
      MaterialPageRoute<bool>(
        builder: (_) => ConnectionProfileEditorScreen(
          store: widget.store,
          manager: _manager!,
          profile: profile,
        ),
      ),
    );
    if (!mounted) return;
    if (changed == true) {
      _changed = true;
      setState(() {});
    }
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
      // 切换提交中禁止离开：probe/commit 没有取消令牌，离开会让后台继续激活新宿主。
      canPop: _switching == null,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop || !mounted) return;
        if (_switching != null) {
          showToast(
            context,
            L10n.t('正在切换电脑，请等待完成后再返回', 'Switching computers; wait for it to finish'),
          );
          return;
        }
        Navigator.of(context).pop(_changed);
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
                    if (manager.connectionStateError.isNotEmpty ||
                        _credentialRetryError != null)
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                        child: Container(
                          key: const ValueKey('connection-credential-error'),
                          padding: const EdgeInsets.all(12),
                          decoration: BoxDecoration(
                            color: DshColors.brandSoft(context),
                            borderRadius: BorderRadius.circular(12),
                            border: Border.all(color: DshColors.line(context)),
                          ),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Icon(
                                    Icons.warning_amber_rounded,
                                    size: 18,
                                    color: DshColors.warn(context),
                                  ),
                                  const SizedBox(width: 8),
                                  Expanded(
                                    child: Text(
                                      L10n.t(
                                        '连接凭据需要恢复：${manager.connectionStateError}',
                                        'Connection credential needs recovery: ${manager.connectionStateError}',
                                      ),
                                      key: const ValueKey(
                                        'connection-credential-reason',
                                      ),
                                      style: const TextStyle(
                                        fontSize: 12,
                                        height: 1.5,
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 6),
                              Text(
                                L10n.t(
                                  '旧凭据仍保留；重试不会删除。',
                                  'The old credential is kept; retry never deletes it.',
                                ),
                                style: TextStyle(fontSize: 11, color: ink3),
                              ),
                              if (_credentialRetryError != null) ...[
                                const SizedBox(height: 6),
                                Text(
                                  L10n.t(
                                    '重试失败：$_credentialRetryError',
                                    'Retry failed: $_credentialRetryError',
                                  ),
                                  key: const ValueKey(
                                    'connection-credential-retry-error',
                                  ),
                                  style: TextStyle(
                                    fontSize: 11.5,
                                    color: DshColors.danger(context),
                                  ),
                                ),
                              ],
                              const SizedBox(height: 8),
                              OutlinedButton(
                                key: const ValueKey(
                                  'connection-retry-credentials',
                                ),
                                onPressed: _retryingCredentials
                                    ? null
                                    : _retryCredentials,
                                child: _retryingCredentials
                                    ? const SizedBox(
                                        width: 16,
                                        height: 16,
                                        child: CircularProgressIndicator(
                                          strokeWidth: 2,
                                        ),
                                      )
                                    : Text(
                                        L10n.t(
                                          '重试恢复凭据',
                                          'Retry credential recovery',
                                        ),
                                      ),
                              ),
                            ],
                          ),
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
                                  if (value == 'edit') _edit(profile);
                                },
                                itemBuilder: (_) => [
                                  PopupMenuItem(
                                    value: 'edit',
                                    child: Text(
                                      L10n.t('编辑名称/地址/口令', 'Edit name/address/token'),
                                    ),
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
                    if (manager.profiles.isEmpty)
                      Padding(
                        padding: const EdgeInsets.fromLTRB(20, 8, 20, 0),
                        child: Text(
                          L10n.t(
                            '还没有连接电脑，点击下方添加',
                            'No computer connected yet. Add one below.',
                          ),
                          key: const ValueKey('connection-empty'),
                          style: TextStyle(fontSize: 12, color: ink3),
                        ),
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
    this.profile,
  });

  final AppStore store;
  final ConnectionManager manager;

  /// 非空表示编辑现有档案；空表示添加。
  final ConnectionProfile? profile;

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
  String? _nameError;
  String? _baseError;
  String? _tokenError;

  bool get _editing => widget.profile != null;

  @override
  void initState() {
    super.initState();
    final profile = widget.profile;
    if (profile != null) {
      _name.text = profile.displayName;
      // 自定义挂载必须随编辑框往返；只改名称/口令不能把 /mobile-remote 覆盖成 /m。
      _base.text = profile.path == '/m' || profile.path.isEmpty
          ? profile.primaryBase
          : '${profile.primaryBase}${profile.path}';
      _allowInsecure = profile.insecureConfirmed;
    }
    _base.addListener(_onEndpointChanged);
  }

  /// 与 store/Api 归一一致：没写 scheme 时按 http 处理，再去尾斜杠。
  String get _normalizedBase {
    var base = _base.text.trim();
    if (base.isEmpty) return '';
    if (!base.startsWith('http://') && !base.startsWith('https://')) {
      base = 'http://$base';
    }
    return base.replaceAll(RegExp(r'/+$'), '');
  }

  bool get _showInsecure => _normalizedBase.startsWith('http://');

  void _onEndpointChanged() {
    if (!mounted) return;
    setState(() {
      _baseError = null;
    });
  }

  @override
  void dispose() {
    _base.removeListener(_onEndpointChanged);
    _name.dispose();
    _base.dispose();
    _token.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final name = _name.text.trim();
    final base = _normalizedBase;
    final token = _token.text.trim();
    var nameError = _validateName(name);
    String? baseError;
    String? tokenError;
    if (base.isEmpty) {
      baseError = L10n.t('请填写电脑地址', 'Enter the computer address');
    } else {
      try {
        ConnectionManager.validateEndpoint(
          base,
          insecureConfirmed: _allowInsecure,
          allowInsecure: _allowInsecure,
        );
      } on ConnectionSwitchException catch (e) {
        baseError = e.message;
      }
    }
    if (!_editing && token.isEmpty) {
      tokenError = L10n.t('请填写访问口令', 'Enter the access token');
    }
    if (nameError != null || baseError != null || tokenError != null) {
      setState(() {
        _nameError = nameError;
        _baseError = baseError;
        _tokenError = tokenError;
        _error = null;
      });
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
      _nameError = null;
      _baseError = null;
      _tokenError = null;
    });
    try {
      final error = _editing
          ? await widget.store.editAndSwitchProfile(
              widget.profile!,
              baseUrl: base,
              token: token.isEmpty ? null : token,
              displayName: name,
              allowInsecure: _allowInsecure,
            )
          : await widget.store.addAndSwitchProfile(
              displayName: name,
              baseUrl: base,
              token: token,
              allowInsecure: _allowInsecure,
            );
      if (!mounted) return;
      if (error != null) {
        setState(() {
          _busy = false;
          _error = error;
        });
        return;
      }
      Navigator.of(context).pop(true);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e is ConnectionSwitchException ? e.message : '$e';
      });
    }
  }

  /// 主机名称：非空、去首尾空白、最多 32 个字符、不能与其他档案重名。
  String? _validateName(String name) {
    if (name.isEmpty) {
      return L10n.t('请填写主机名称', 'Enter a computer name');
    }
    if (name.runes.length > 32) {
      return L10n.t('主机名称最多 32 个字符', 'Computer name must be at most 32 characters');
    }
    final lower = name.toLowerCase();
    final duplicate = widget.manager.profiles.any(
      (p) => p.id != widget.profile?.id && p.displayName.trim().toLowerCase() == lower,
    );
    if (duplicate) {
      return L10n.t('该主机名称已存在，请换一个名称', 'That computer name already exists');
    }
    return null;
  }

  Future<void> _scan() async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ScanScreen(
          onScanned: (base, token) {
            _base.text = base;
            _token.text = token;
            if (_name.text.trim().isEmpty) {
              final host = Uri.tryParse(base)?.host ?? '';
              if (host.isNotEmpty) _name.text = host;
            }
            if (mounted) Navigator.of(context).pop();
          },
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final ink3 = DshColors.ink3(context);
    return PopScope(
      canPop: !_busy,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop || !mounted) return;
        if (_busy) {
          showToast(
            context,
            L10n.t('正在保存连接，请等待完成后再返回', 'Saving connection; wait for it to finish'),
          );
        }
      },
      child: Scaffold(
      appBar: AppBar(
        title: Text(_editing ? L10n.t('编辑电脑', 'Edit computer') : L10n.t('添加电脑', 'Add computer')),
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
            key: const ValueKey('connection-profile-name'),
            controller: _name,
            textInputAction: TextInputAction.next,
            onChanged: (_) {
              if (_nameError != null) setState(() => _nameError = null);
            },
            decoration: InputDecoration(
              labelText: L10n.t('主机名称', 'Computer name'),
              hintText: L10n.t('例如：家里电脑', 'e.g. Home PC'),
              errorText: _nameError,
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            key: const ValueKey('connection-profile-base'),
            controller: _base,
            keyboardType: TextInputType.url,
            textInputAction: TextInputAction.next,
            decoration: InputDecoration(
              labelText: L10n.t('电脑地址', 'Computer address'),
              hintText: 'https://192.168.1.10:3080/m',
              errorText: _baseError,
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            key: const ValueKey('connection-profile-token'),
            controller: _token,
            obscureText: true,
            onChanged: (_) {
              if (_tokenError != null) setState(() => _tokenError = null);
            },
            decoration: InputDecoration(
              labelText: L10n.t('访问口令', 'Access token'),
              hintText: _editing
                  ? L10n.t('留空则不修改已保存口令', 'Leave blank to keep the saved token')
                  : null,
              errorText: _tokenError,
            ),
          ),
          if (!_editing) ...[
            const SizedBox(height: 8),
            OutlinedButton.icon(
              key: const ValueKey('connection-profile-scan'),
              onPressed: _busy ? null : _scan,
              icon: const Icon(Icons.qr_code_scanner),
              label: Text(L10n.t('扫码添加', 'Scan to add')),
            ),
          ],
          if (_showInsecure) ...[
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
      ),
    );
  }
}
