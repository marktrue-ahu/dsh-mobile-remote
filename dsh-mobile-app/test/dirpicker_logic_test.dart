// v3.1.1(issue #5) 逻辑单测：WSL/Linux（/）与 Windows（\）的目录选择路径拼接与分隔符推断。
// 回归场景（GitHub issue #5）：旧实现在根 `/` 下选 home 拼成 `/\home`，
// 服务端 readdir 找不到目录 → 报错 → WSL 端无法选择路径。
import 'package:flutter_test/flutter_test.dart';
import 'package:dsh_mobile_app/screens/sheets.dart';

void main() {
  group('joinDirPath（按服务端分隔符拼接子目录路径）', () {
    test(r'WSL/Linux：根 / 下进入 home → /home（回归：不再拼成 /\home）', () {
      expect(joinDirPath('/', 'home', '/'), '/home');
      expect(joinDirPath('/home', 'user', '/'), '/home/user');
      expect(joinDirPath('/home/user/', 'docs', '/'), '/home/user/docs');
    });

    test(r'Windows：盘符带尾 \ 时直接拼接，普通路径用 \ 连接', () {
      expect(joinDirPath(r'C:\', 'Users', r'\'), r'C:\Users');
      expect(joinDirPath(r'C:\Users', 'dev', r'\'), r'C:\Users\dev');
    });

    test('根视图（current 为空）直接以根项为当前路径', () {
      expect(joinDirPath('', r'C:\', r'\'), r'C:\');
      expect(joinDirPath('', '/', '/'), '/');
    });
  });

  group('dirSepOf（分隔符推断，兼容旧版插件未返回 sep 字段）', () {
    test('服务端返回的 sep 优先', () {
      expect(dirSepOf(const ['C:\\', 'D:\\'], r'\'), r'\');
      expect(dirSepOf(const ['/'], '/'), '/');
    });

    test(r'旧版插件无 sep：按根视图推断（POSIX 根含 / → /；Windows 盘符 → \）', () {
      expect(dirSepOf(const ['/'], null), '/');
      expect(dirSepOf(const ['C:\\', 'D:\\'], null), r'\');
    });

    test('根列表为空时按 Windows 习惯兜底', () {
      expect(dirSepOf(const [], null), r'\');
    });
  });
}
