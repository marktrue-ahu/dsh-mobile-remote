// GitLab #16 P2：bootstrap / SSE hello 的连接代竞态。
//
// 场景：新宿主 bootstrap 在途 → 切到旧宿主并收到旧 hello(false) → 新宿主的
// 迟到 bootstrap 不得把 files.sessionRelative 写回 true；反向同理。另外验证
// 旧 SSE 帧（即使传输层在 cancel 后仍回调）不得跨连接代写入能力位。
import 'dart:async';
import 'dart:convert';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

http.Response _json(Map<String, dynamic> body, [int status = 200]) =>
    http.Response(
      jsonEncode(body),
      status,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

Map<String, dynamic> _bootstrap({required bool sessionRelative}) => {
  'ok': true,
  'server': {'urls': <String>[]},
  'plugin': {'version': '3.3.0'},
  'capabilities': {
    'files': {'version': 1, 'sessionRelative': sessionRelative},
  },
  'agents': <Object>[],
};

class _RaceBackend {
  _RaceBackend({required this.sessionRelative}) {
    api = Api(client: MockClient(_handle))
      ..baseUrl = 'http://new.test'
      ..path = '/m'
      ..token = 'new-token';
  }

  final bool sessionRelative;
  late final Api api;
  Completer<http.Response>? bootstrapGate;
  int bootstrapCalls = 0;

  Future<http.Response> _handle(http.Request request) async {
    final path = request.url.path;
    if (path.endsWith('/api/bootstrap')) {
      bootstrapCalls++;
      final gate = bootstrapGate;
      if (gate != null) return gate.future;
      return _json(_bootstrap(sessionRelative: sessionRelative));
    }
    if (path.endsWith('/api/sessions')) {
      return _json({'ok': true, 'sessions': <Object>[]});
    }
    return _json({'ok': true});
  }
}

Future<void> _until(bool Function() condition) async {
  final sw = Stopwatch()..start();
  while (!condition()) {
    if (sw.elapsed > const Duration(seconds: 3)) {
      fail('等待条件超时');
    }
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
}

class _LeakyStream extends Stream<Map<String, dynamic>> {
  void Function(Map<String, dynamic>)? onData;

  @override
  StreamSubscription<Map<String, dynamic>> listen(
    void Function(Map<String, dynamic>)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) {
    this.onData = onData;
    return _LeakySubscription();
  }

  void emit(Map<String, dynamic> frame) => onData?.call(frame);
}

class _LeakySubscription implements StreamSubscription<Map<String, dynamic>> {
  @override
  Future<void> cancel() async {}

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class _LeakyApi extends Api {
  final leaky = _LeakyStream();

  @override
  Stream<Map<String, dynamic>> eventsRaw() => leaky;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('新宿主 bootstrap 迟到，不得覆盖旧 hello 的 false', () async {
    final backend = _RaceBackend(sessionRelative: true);
    final store = AppStore(apiClient: backend.api);
    addTearDown(store.disposeBridge);
    backend.api.applyCapabilities({
      'files': {'version': 1, 'sessionRelative': true},
    });
    expect(backend.api.sessionRelativeFilesSupported, isTrue);

    backend.bootstrapGate = Completer<http.Response>();
    final refresh = store.refreshAll();
    await _until(() => backend.bootstrapCalls == 1);

    // 等待期间切到旧宿主，并收到旧宿主的 hello（没有 files 能力位）。
    await backend.api.save(base: 'http://old.test', token: 'old-token');
    store.injectFrame({'type': 'hello', 'capabilities': {}});
    expect(backend.api.sessionRelativeFilesSupported, isFalse);

    // 新宿主的 bootstrap 现在才到：必须被连接代守卫拒绝。
    backend.bootstrapGate!.complete(_json(_bootstrap(sessionRelative: true)));
    await refresh;
    expect(backend.api.sessionRelativeFilesSupported, isFalse);
    expect(backend.api.baseUrl, 'http://old.test');
  });

  test('旧宿主 bootstrap 迟到，不得覆盖新 hello 的 true', () async {
    final backend = _RaceBackend(sessionRelative: false);
    final store = AppStore(apiClient: backend.api);
    addTearDown(store.disposeBridge);

    backend.bootstrapGate = Completer<http.Response>();
    final refresh = store.refreshAll();
    await _until(() => backend.bootstrapCalls == 1);
    await backend.api.save(base: 'http://new.test', token: 'new-token');
    store.injectFrame({
      'type': 'hello',
      'capabilities': {
        'files': {'version': 1, 'sessionRelative': true},
      },
    });
    expect(backend.api.sessionRelativeFilesSupported, isTrue);

    backend.bootstrapGate!.complete(_json(_bootstrap(sessionRelative: false)));
    await refresh;
    expect(backend.api.sessionRelativeFilesSupported, isTrue);
  });

  test('旧 SSE 帧跨连接代不写能力位（传输层 cancel 后仍回调）', () async {
    final api = _LeakyApi()
      ..baseUrl = 'http://host.test'
      ..path = '/m'
      ..token = 'token';
    final store = AppStore(apiClient: api);
    addTearDown(store.disposeBridge);

    store.connect();
    api.leaky.emit({
      'type': 'hello',
      'capabilities': {
        'files': {'version': 1, 'sessionRelative': true},
      },
    });
    expect(api.sessionRelativeFilesSupported, isTrue);

    store.disposeBridge();
    expect(api.sessionRelativeFilesSupported, isFalse);
    // 模拟 cancel 后仍到达的旧帧：连接代号已变，必须忽略。
    api.leaky.emit({
      'type': 'hello',
      'capabilities': {
        'files': {'version': 1, 'sessionRelative': true},
      },
    });
    expect(api.sessionRelativeFilesSupported, isFalse);
  });
}
