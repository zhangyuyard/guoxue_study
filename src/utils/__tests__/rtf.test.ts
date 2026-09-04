/**
 * rtfToText 单测：控制字/分组/代码页字节/Unicode/目的地跳过。
 */
import { rtfToText } from '@/utils/rtf';

describe('rtfToText', () => {
  test('基本文本与 \\par 换行', () => {
    const rtf = '{\\rtf1\\ansi Hello\\par World\\par}';
    expect(rtfToText(rtf).text).toBe('Hello\nWorld');
  });

  test('转义符号 \\\\、\\{、\\}、\\~', () => {
    const rtf = '{\\rtf1 a\\\\b\\{c\\}d\\~e}';
    // \~ 输出 nbsp，经 normalizeTail 折叠为普通空格（与 html 链路一致）
    expect(rtfToText(rtf).text).toBe('a\\b{c}d e');
  });

  test('\\uN Unicode（含回退字符跳过）', () => {
    // 中=20013 国=22269；? 是 ASCII 回退字符，\uc 默认 1 → 跳过
    const rtf = '{\\rtf1\\ansi\\uc1 \\u20013?\\u22269?}';
    expect(rtfToText(rtf).text).toBe('中国');
  });

  test('\\uN 负参数（UTF-16 有符号）', () => {
    const _rtf = '{\\rtf1\\ansi\\uc1 \\u-69?\\u-24362?}';
    // -69 + 65536 = 65467? 不对——-69+65536 = 65467 是「龙」? 直接验证合法 BMP：「书」=0x4E66=20070 → 负表示 20070-65536=-45466
    expect(rtfToText('{\\rtf1\\ansi\\uc1 \\u-45466?}').text).toBe('书');
  });

  test("代码页 936 的 \\'hh 字节按 GBK 解码", () => {
    // 人 GBK = C8 CB
    const rtf = "{\\rtf1\\ansi\\ansicpg936 \\par \\'c8\\'cb}";
    expect(rtfToText(rtf).text).toBe('人');
  });

  test('fonttbl/colortbl 等目的地组内容不进入正文', () => {
    const rtf = [
      '{\\rtf1\\ansi\\deff0',
      '{\\fonttbl{\\f0 Times New Roman;}{\\f1 SimSun;}}',
      '{\\colortbl;\\red255\\green0\\blue0;}',
      '{\\stylesheet{\\s1 样式表;}}',
      '\\f0\\fs24 正文开始\\par 正文结束}',
    ].join('');
    const text = rtfToText(rtf).text;
    expect(text).not.toContain('Times');
    expect(text).not.toContain('SimSun');
    expect(text).not.toContain('red255');
    expect(text).not.toContain('样式表');
    expect(text).toContain('正文开始');
    expect(text).toContain('正文结束');
  });

  test('\\pict 组内容跳过（含裸十六进制数据）', () => {
    const rtf = '{\\rtf1\\ansi{\\pict\\pngblip89504e470d0a}图前\\par 图后}';
    const text = rtfToText(rtf).text;
    expect(text).not.toContain('89504e47');
    expect(text).toContain('图前');
    expect(text).toContain('图后');
  });

  test('\\tab 与 \\cell', () => {
    const rtf = '{\\rtf1 甲\\tab 乙\\cell 丙}';
    expect(rtfToText(rtf).text).toBe('甲 乙\n丙');
  });

  test('常用符号控制字', () => {
    const rtf = '{\\rtf1 a\\emdash b\\ldblquote引\\rdblquote}';
    expect(rtfToText(rtf).text).toBe('a\u2014b\u201c引\u201d');
  });

  test('分组退出后 \\ansicpg / \\uc 状态恢复', () => {
    const rtf = "{\\rtf1\\ansicpg936 {\\ansicpg1252 \\'41}\\par \\'c8\\'cb}";
    // 组内 1252 → 'A'（latin1 0x41）；退出组恢复 936 → 人
    expect(rtfToText(rtf).text).toBe('A\n人');
  });

  test('裸 CR/LF 忽略、空产出安全', () => {
    expect(rtfToText('{\\rtf1\r\n正文}').text).toBe('正文');
    expect(rtfToText('').text).toBe('');
  });
});
