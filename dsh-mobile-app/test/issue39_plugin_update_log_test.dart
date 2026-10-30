import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/plugin_update_log.dart';
import 'package:dsh_mobile_app/plugin_update_status.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  test('only well-shaped server event text is exposed for rendering', () {
    final log = PluginUpdateLog.fromJson({
      'ok': true,
      'opId': 'op-1',
      'phase': 'installing',
      'events': [
        {
          'seq': 2,
          'at': 'now',
          'stage': 'install',
          'stream': 'stdout',
          'text': 'Installing package',
        },
        {
          'seq': 3,
          'stage': 'install',
          'stream': 'stderr',
          'text': 'sanitized warning',
          'raw': 'token=secret',
        },
        {'seq': 'bad', 'text': 'not a valid sequenced line'},
        {'seq': 4, 'text': 42},
      ],
      'firstSeq': 2,
      'lastSeq': 4,
      'truncated': false,
    });
    expect(log.lines.map((line) => line.text), [
      'Installing package',
      'sanitized warning',
    ]);
    expect(log.cursor, 3);
  });

  test('missing opId is accepted for legacy log responses; a present mismatching id is rejected', () {
    final legacy = {
      'phase': 'installing',
      'events': [
        {
          'seq': 1,
          'stage': 'install',
          'stream': 'stdout',
          'text': 'pnpm output',
        },
      ],
    };
    expect(PluginUpdateLog.matchesOperation(legacy, 'op-1'), isTrue);
    expect(PluginUpdateLog.fromJson(legacy).lines.single.text, 'pnpm output');
    expect(
      PluginUpdateLog.matchesOperation({'opId': null, 'events': []}, 'op-1'),
      isTrue,
    );
    expect(
      PluginUpdateLog.matchesOperation({'opId': 'op-1', 'events': []}, 'op-1'),
      isTrue,
    );
    expect(
      PluginUpdateLog.matchesOperation({'opId': 'op-2', 'events': []}, 'op-1'),
      isFalse,
    );
    expect(
      PluginUpdateLog.matchesOperation({'opId': 42, 'events': []}, 'op-1'),
      isFalse,
    );
  });

  test('Settings can discover a desktop-started host transaction for its log panel', () async {
    SharedPreferences.setMockInitialValues({});
    final api = Api()
      ..pluginUpdate = PluginUpdateStatus.fromJson({
        'state': 'restarting',
        'transaction': {
          'opId': 'desktop-op',
          'phase': 'installing',
          'targetVersion': '3.2.2-alpha.2',
          'targetContentSha256': List.filled(64, 'b').join(),
          'targetAppVersion': '3.2.2+27',
          'rolledBack': false,
        },
      });
    final store = AppStore(apiClient: api);
    addTearDown(store.dispose);
    await store.loadPrefs();

    expect(
      store.pluginUpdateJournal,
      isNull,
      reason: 'the phone did not initiate this desktop operation',
    );
    expect(store.lastPluginUpdateOpId, isEmpty);
    expect(store.pluginUpdateLogOpId, 'desktop-op');

    store.lastPluginUpdateOpId = 'old-phone-op';
    expect(
      store.pluginUpdateLogOpId,
      'desktop-op',
      reason: 'the current host operation takes precedence over stale local history',
    );
  });

  test(
    'a fresh host transaction notifies Settings even without a local journal',
    () async {
      SharedPreferences.setMockInitialValues({});
      final api = Api();
      final store = AppStore(apiClient: api);
      addTearDown(store.dispose);
      await store.loadPrefs();
      var notifications = 0;
      store.addListener(() => notifications++);

      api.absorbBootstrap({
        'plugin': {'contentSha256': List.filled(64, 'b').join()},
        'pluginUpdate': {
          'state': 'installing',
          'transaction': {
            'opId': 'desktop-started-op',
            'phase': 'installing',
            'targetVersion': '3.2.2-alpha.2',
            'targetContentSha256': List.filled(64, 'b').join(),
            'targetAppVersion': '3.2.2+27',
            'rolledBack': false,
          },
        },
      });

      expect(store.pluginUpdateJournal, isNull);
      expect(store.pluginUpdateLogOpId, 'desktop-started-op');
      expect(
        notifications,
        greaterThan(0),
        reason: 'Settings must rebuild when a host-started transaction appears',
      );
    },
  );
}
