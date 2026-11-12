// issue #90：斜杠输入识别（纯函数，DSH 兼容）。
//
// 触发规则（对齐 DSH）：
// - `/` 出现在开头，或空白/标点之后才触发；前面是字母/数字/下划线（词内）不触发；
// - `//`、`https:/` 等 URL/路径斜杠豁免；
// - 光标向左扫到最近空白/标点得到 query；
// - 开头（leading）展示「命令 + 技能」；行内（inline）只展示技能。

/// 菜单允许的来源范围。
enum SlashMenuScope {
  /// 输入框开头：命令 + 技能。
  leading,

  /// 行内（空白/标点后）：仅技能。
  inline,
}

/// 当前光标处 `/` token。（[start] 指向 `/`，[query] 为 `/` 后的已输入部分。）
class SlashToken {
  final int start;
  final int end;
  final String query;
  final SlashMenuScope scope;

  const SlashToken({
    required this.start,
    required this.end,
    required this.query,
    required this.scope,
  });

  @override
  String toString() =>
      'SlashToken(start: $start, end: $end, query: "$query", scope: $scope)';
}

/// 已发消息文本中的斜杠 token（供用户气泡高亮；不做目录匹配）。
class SlashTextToken {
  final int start;
  final int end;
  final String name;
  final SlashMenuScope scope;

  const SlashTextToken({
    required this.start,
    required this.end,
    required this.name,
    required this.scope,
  });
}

const _tokenChar = r'[A-Za-z0-9_-]';
final RegExp _tokenCharRe = RegExp(_tokenChar);
final RegExp _nameRe = RegExp('^$_tokenChar*\$');

bool _isWordChar(String ch) => ch.isNotEmpty && _tokenCharRe.hasMatch(ch);

bool _isWhitespaceOrPunctuation(String ch) {
  if (ch.isEmpty) return false;
  if (ch.trim().isEmpty) return true;
  // 与 DSH 一致：常见句读/括号等算边界；字母、数字、下划线不算。
  return !_isWordChar(ch) && ch != '_';
}

/// 判断 [slashIndex] 处的 `/` 是否满足 DSH 触发边界（不含 URL 豁免）。
bool _isSlashBoundary(String text, int slashIndex) {
  if (slashIndex <= 0) return true;
  final prev = text[slashIndex - 1];
  if (!_isWhitespaceOrPunctuation(prev)) return false;
  // `//`：前一个字符仍是 `/` 视为双斜杠（URL/路径），豁免。
  if (prev == '/') return false;
  // `https:/`、`x:/`：冒号前的 scheme 是 ASCII 字母/数字/+.- → 视为 URL/协议。
  // `https:/`、`x:/`：冒号后的斜杠按 URL/协议豁免（DSH 行为）。
  if (prev == ':') return false;
  return true;
}

/// 当前光标处的 `/` token；无触发返回 null。
///
/// [cursor] 省略时取文本末尾。光标可以停在 token 中间（query 取 `/` 到光标）。
SlashToken? slashTokenAt(String text, [int? cursor]) {
  final at = (cursor ?? text.length).clamp(0, text.length);
  var slash = -1;
  for (var i = at - 1; i >= 0; i--) {
    final ch = text[i];
    if (ch == '/') {
      slash = i;
      break;
    }
    if (!_isWordChar(ch)) break; // 最近分隔符不是 `/`：当前不在斜杠 token 内
  }
  if (slash < 0) return null;
  if (!_isSlashBoundary(text, slash)) return null;
  final query = text.substring(slash + 1, at);
  if (!_nameRe.hasMatch(query)) return null;
  return SlashToken(
    start: slash,
    end: at,
    query: query,
    scope: slash == 0 ? SlashMenuScope.leading : SlashMenuScope.inline,
  );
}

/// 提取文本中所有可高亮的斜杠 token（DSH 边界 + 词尾空白/结束 + URL/词内豁免）。
///
/// 只做语法识别，是否命中命令/技能目录由调用方决定。
List<SlashTextToken> slashTextTokens(String text) {
  final tokens = <SlashTextToken>[];
  var i = 0;
  while (i < text.length) {
    if (text[i] != '/') {
      i++;
      continue;
    }
    if (!_isSlashBoundary(text, i)) {
      i++;
      continue;
    }
    var j = i + 1;
    while (j < text.length && _isWordChar(text[j])) {
      j++;
    }
    final name = text.substring(i + 1, j);
    if (name.isEmpty) {
      i = j + 1;
      continue;
    }
    // token 之后必须是空白/结束（DSH 词边界）；`/tmp/foo`、`x/name` 不成立。
    if (j < text.length &&
        (text[j] == '/' || !_isWhitespaceOrPunctuation(text[j]))) {
      i = j;
      continue;
    }
    tokens.add(SlashTextToken(
      start: i,
      end: j,
      name: name,
      scope: i == 0 ? SlashMenuScope.leading : SlashMenuScope.inline,
    ));
    i = j;
  }
  return tokens;
}

/// 菜单项过滤：名称/描述大小写不敏感子串匹配。
bool slashItemMatches(String query, String name, String? description) {
  final q = query.trim().toLowerCase();
  if (q.isEmpty) return true;
  return name.toLowerCase().contains(q) ||
      (description ?? '').toLowerCase().contains(q);
}
