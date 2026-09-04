/**
 * UserBookService 解析层测试（纯函数部分）
 * 锁定 txt → Book 的核心规则：章节切分、开篇归档、无标题切部分、
 * 超长段落切分、UTF-8 解码容错。db/文件选择层依赖原生模块（不在单测覆盖内）。
 */
import {
  decodeUtf8,
  makeUserBookId,
  parseTxtBook,
} from '@/services/UserBookService';

describe('decodeUtf8', () => {
  const enc = (s: string): Uint8Array => {
    // 用 Node Buffer 辅助生成（仅测试环境使用）
    return new Uint8Array(Buffer.from(s, 'utf-8'));
  };

  test('基本中文解码', () => {
    expect(decodeUtf8(enc('道可道，非常道。'))).toBe('道可道，非常道。');
  });

  test('emoji（四字节 UTF-8 → 代理对）', () => {
    expect(decodeUtf8(enc('读📖书'))).toBe('读📖书');
  });

  test('被块边界切断的多字节序列以 U+FFFD 兜底（服务实现为先拼后解，实际不截断）', () => {
    // 模拟分块：奇位置切断后手动拼接 bytes 再解码（服务实现为先拼后解）
    const bytes = enc('学而时习之，不亦说乎');
    // 5 字节 = 「学」(3B) + 「而」的前 2B → 截断出 2 个替换符（前导位 + 游离续字节）
    expect(decodeUtf8(bytes.subarray(0, 5))).toBe('学\ufffd\ufffd');
    // 完整拼接后解码无损
    expect(decodeUtf8(bytes)).toBe('学而时习之，不亦说乎');
  });

  test('非法序列以 U+FFFD 替代而非抛错', () => {
    const out = decodeUtf8(new Uint8Array([0xe4, 0xb8, 0x41]));
    expect(out).toContain('\ufffd');
  });
});

describe('makeUserBookId', () => {
  test('ID 以 user- 前缀且不重复', () => {
    const a = makeUserBookId();
    const b = makeUserBookId();
    expect(a.startsWith('user-')).toBe(true);
    expect(b.startsWith('user-')).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe('parseTxtBook（章节切分）', () => {
  test('「第X章」标题切章；标题前正文归开篇', () => {
    const text = [
      '这是开篇引言。',
      '',
      '第一章 初现',
      '第一段内容。',
      '第二段内容。',
      '',
      '第二章 转折',
      '另一段内容。',
    ].join('\n');
    const book = parseTxtBook('测试之书.txt', text, 'user-test1');

    expect(book.id).toBe('user-test1');
    expect(book.title).toBe('测试之书');
    expect(book.category).toBe('user');
    expect(book.chapters).toHaveLength(3);
    expect(book.chapters[0].title).toBe('开篇');
    expect(book.chapters[1].title).toBe('第一章 初现');
    expect(book.chapters[1].segments.map((s) => s.text)).toEqual([
      '第一段内容。',
      '第二段内容。',
    ]);
    expect(book.chapters[2].title).toBe('第二章 转折');
    // 章节/段落 id 与 bookId 关联
    expect(book.chapters[1].id).toBe('user-test1-c2');
    expect(book.chapters[1].segments[0].id).toBe('user-test1-c2-s1');
  });

  test('「第X回」标题同样识别（章回体）', () => {
    const text = '第一回 甄士隐梦幻识通灵\n内容甲。\n\n第二回 贾夫人仙逝扬州城\n内容乙。';
    const book = parseTxtBook('红楼梦.txt', text, 'user-test2');
    expect(book.chapters.map((c) => c.title)).toEqual([
      '第一回 甄士隐梦幻识通灵',
      '第二回 贾夫人仙逝扬州城',
    ]);
  });

  test('无章节标记且段落少 → 整本一章「全文」', () => {
    const text = Array.from({ length: 10 }, (_, i) => `段落${i}。`).join('\n\n');
    const book = parseTxtBook('随笔.txt', text, 'user-test3');
    expect(book.chapters).toHaveLength(1);
    expect(book.chapters[0].title).toBe('全文');
    expect(book.chapters[0].segments).toHaveLength(10);
  });

  test('无章节标记且段落多 → 按 60 段切「部分」', () => {
    const text = Array.from({ length: 130 }, (_, i) => `段落${i}。`).join('\n\n');
    const book = parseTxtBook('长文.txt', text, 'user-test4');
    expect(book.chapters.map((c) => c.title)).toEqual([
      '第1部分',
      '第2部分',
      '第3部分',
    ]);
    expect(book.chapters[0].segments).toHaveLength(60);
    expect(book.chapters[1].segments).toHaveLength(60);
    expect(book.chapters[2].segments).toHaveLength(10);
  });

  test('超长段落按 2500 码点切分', () => {
    const longText = '道'.repeat(6000);
    const book = parseTxtBook('单段.txt', longText, 'user-test5');
    expect(book.chapters[0].segments.map((s) => s.text.length)).toEqual([
      2500, 2500, 1000,
    ]);
  });

  test('空内容 → 0 章（导入流程会拒绝）', () => {
    const book = parseTxtBook('空.txt', '   \n\n  ', 'user-test6');
    expect(book.chapters).toHaveLength(0);
  });

  test('正文中的短行不会误判为章节（需行首「第X+单位」）', () => {
    const text = '第一天我们出发了。\n内容继续。\n\n第二天到达。\n内容继续。';
    const book = parseTxtBook('日记.txt', text, 'user-test7');
    // 「第一天…」后接内容不在行首独立成题（整行不是标题形态）→ 无章节标记
    expect(book.chapters).toHaveLength(1);
    expect(book.chapters[0].title).toBe('全文');
  });

  test('英文章节：Chapter N 阿拉伯数字切章（含副标题）', () => {
    const text = [
      'Once upon a time there was a preface.',
      '',
      'Chapter 1 The Beginning',
      'It was a dark night.',
      '',
      'Chapter 2: The Turn',
      'Something happened.',
      '',
      'Chapter 23',
      'The end.',
    ].join('\n');
    const book = parseTxtBook('great-book.txt', text, 'user-test8');
    expect(book.chapters.map((c) => c.title)).toEqual([
      '开篇',
      'Chapter 1 The Beginning',
      'Chapter 2: The Turn',
      'Chapter 23',
    ]);
    expect(book.chapters[1].segments.map((s) => s.text)).toEqual(['It was a dark night.']);
  });

  test('英文章节：罗马数字与 CHAPTER 全大写', () => {
    const text = 'CHAPTER I\nOne.\n\nCHAPTER IV\nFour.\n\nchapter xii\nTwelve.';
    const book = parseTxtBook('roman.txt', text, 'user-test9');
    expect(book.chapters.map((c) => c.title)).toEqual(['CHAPTER I', 'CHAPTER IV', 'chapter xii']);
  });

  test('英文 Book/Part + 序数词切章；普通句子不误判', () => {
    const text = [
      'Book One',
      'Body one.',
      '',
      'Part Twelve',
      'Body two.',
      '',
      'part one of my life story was long and winding road',
      'Body three.',
    ].join('\n');
    const book = parseTxtBook('parts.txt', text, 'user-test10');
    // 普通长句（副标题超长）不误判，归入当前章节正文
    expect(book.chapters.map((c) => c.title)).toEqual(['Book One', 'Part Twelve']);
    expect(book.chapters[1].segments.map((s) => s.text)).toEqual([
      'Body two.',
      'part one of my life story was long and winding road\nBody three.',
    ]);
  });

  test('英文章节：序数词 Thirteen+（Chapter Thirteen / Chapter Twentieth）切章', () => {
    const text = [
      'Chapter Thirteen',
      'Body thirteen.',
      '',
      'Chapter Eighteenth: The Reveal',
      'Body eighteen.',
      '',
      'Chapter Twentieth',
      'Body twenty.',
    ].join('\n');
    const book = parseTxtBook('ordinals.txt', text, 'user-test11');
    expect(book.chapters.map((c) => c.title)).toEqual([
      'Chapter Thirteen',
      'Chapter Eighteenth: The Reveal',
      'Chapter Twentieth',
    ]);
    expect(book.chapters[2].segments.map((s) => s.text)).toEqual(['Body twenty.']);
  });
});
