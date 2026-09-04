/**
 * bookFormat 单测：实体解码、HTML 剥标签、Markdown 标题转章节标记、
 * FB2 提取、EPUB（zip → container → OPF → spine → ncx）全链路提取。
 */
import { buildZip, type ZipFileSpec } from '@/test-utils/buildZip';
import { utf8Encode } from '@/test-utils/utf8';
import {
  CHAPTER_MARKER,
  convertBookBytes,
  decodeHtmlEntities,
  docxExtractText,
  epubExtractText,
  fb2ToText,
  htmlToText,
  isStructuredFormat,
  mdToMarkerText,
  odtExtractText,
  zipExtractText,
} from '@/utils/bookFormat';
import { parseTxtBook } from '@/services/UserBookService';

describe('decodeHtmlEntities', () => {
  test('常用命名实体', () => {
    expect(decodeHtmlEntities('&lt;p&gt;&amp;&nbsp;&mdash;&hellip;&ldquo;中&rdquo;')).toBe(
      '<p>&\u00a0\u2014\u2026\u201c中\u201d',
    );
  });

  test('十进制与十六进制数字实体（含 emoji 代理对）', () => {
    expect(decodeHtmlEntities('&#36947;&#x53EF;')).toBe('道可');
    expect(decodeHtmlEntities('&#128214;')).toBe('📖');
  });

  test('未知实体原样保留', () => {
    expect(decodeHtmlEntities('&unknown;')).toBe('&unknown;');
  });
});

describe('htmlToText', () => {
  test('剥 script/style/head 注释，块级边界转行，实体解码', () => {
    const html = [
      '<html><head><title>不要出现</title><style>.x{color:red}</style></head>',
      '<body>',
      '<!-- 注释 -->',
      '<script>var a = 1;</script>',
      '<h1>第一章 起点</h1>',
      '<p>山不在高，有仙则名。</p>',
      '<div>水不在深，<br/>有龙则灵。</div>',
      '</body></html>',
    ].join('');
    const text = htmlToText(html);
    expect(text).not.toContain('script');
    expect(text).not.toContain('.x{');
    expect(text).not.toContain('不要出现');
    expect(text).toContain('第一章 起点');
    expect(text).toContain('山不在高，有仙则名。');
    expect(text).toContain('水不在深，\n有龙则灵。');
  });

  test('无标签纯文本原样返回', () => {
    expect(htmlToText('学而时习之')).toBe('学而时习之');
  });
});

describe('mdToMarkerText', () => {
  test('#/##/### 标题转章节标记', () => {
    const md = ['# 道德经', '上篇。', '## 第一章', '正文一段。', '### 小节', '正文二段。'];
    expect(mdToMarkerText(md.join('\n'))).toBe(
      [
        `${CHAPTER_MARKER}道德经`,
        '上篇。',
        `${CHAPTER_MARKER}第一章`,
        '正文一段。',
        `${CHAPTER_MARKER}小节`,
        '正文二段。',
      ].join('\n'),
    );
  });

  test('围栏代码块内的 # 不转换', () => {
    const md = ['```', '# 这不是标题', '```', '# 这才是标题'];
    const out = mdToMarkerText(md.join('\n'));
    expect(out).toContain('# 这不是标题');
    expect(out).toContain(`${CHAPTER_MARKER}这才是标题`);
  });

  test('四级以下标题不转标记', () => {
    expect(mdToMarkerText('#### 深层小节')).toBe('#### 深层小节');
  });
});

describe('fb2ToText', () => {
  const fb2 = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<FictionBook>',
    '<description>',
    '<title-info><book-title>测试古文</book-title>',
    '<author><first-name>李</first-name><last-name>四</last-name></author>',
    '</title-info>',
    '</description>',
    '<body>',
    '<section><title><p>第一章 明道</p></title>',
    '<p>道可道，非常道。</p><empty-line/><p>名可名，非常名。</p>',
    '</section>',
    '<section><title><p>第二章</p></title>',
    '<p>天下皆知美之为美。</p>',
    '</section>',
    '</body>',
    '<body name="notes"><section><p>注释不应出现</p></section></body>',
    '<binary id="cover.jpg"><![CDATA/base64data]]></binary>',
    '</FictionBook>',
  ].join('');

  test('提取书名与作者', () => {
    const r = fb2ToText(fb2);
    expect(r.title).toBe('测试古文');
    expect(r.author).toBe('李 四');
  });

  test('section 标题转章节标记、p/empty-line 转段落、notes body 与 binary 剔除', () => {
    const r = fb2ToText(fb2);
    expect(r.text).toContain(`${CHAPTER_MARKER}第一章 明道`);
    expect(r.text).toContain('道可道，非常道。');
    expect(r.text).toContain('名可名，非常名。');
    expect(r.text).toContain(`${CHAPTER_MARKER}第二章`);
    expect(r.text).toContain('天下皆知美之为美。');
    expect(r.text).not.toContain('注释不应出现');
    expect(r.text).not.toContain('base64data');
    expect(r.text).not.toContain('<p>');
  });
});

const epubFiles: ZipFileSpec[] = [
    { name: 'mimetype', content: 'application/epub+zip' },
    {
      name: 'META-INF/container.xml',
      content:
        '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      method: 8,
    },
    {
      name: 'OEBPS/content.opf',
      content: [
        '<?xml version="1.0"?>',
        '<package version="2.0" xmlns="http://www.idpf.org/2007/opf">',
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">',
        '<dc:title>测试之书</dc:title><dc:creator>张三</dc:creator>',
        '</metadata>',
        '<manifest>',
        '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
        '<item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>',
        '<item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>',
        '<item id="cover" href="cover.png" media-type="image/png"/>',
        '</manifest>',
        '<spine toc="ncx"><itemref idref="ch1"/><itemref idref="ch2"/></spine>',
        '</package>',
      ].join(''),
      method: 8,
    },
    {
      name: 'OEBPS/toc.ncx',
      content: [
        '<ncx><navMap>',
        '<navPoint><navLabel><text>第一章 起点</text></navLabel><content src="ch1.xhtml"/></navPoint>',
        '<navPoint><navLabel><text>第二章 转折</text></navLabel><content src="text/ch2.xhtml"/></navPoint>',
        '</navMap></ncx>',
      ].join(''),
      method: 8,
    },
    {
      name: 'OEBPS/ch1.xhtml',
      content: '<html><body><h2>第一章 起点</h2><p>山不在高。</p></body></html>',
      method: 8,
    },
    {
      name: 'OEBPS/text/ch2.xhtml',
      content:
        '<html><head><title>备用标题</title></head><body><p>水不在深。</p><br/><p>斯是陋室。</p></body></html>',
      method: 8,
    },
    { name: 'OEBPS/cover.png', content: 'fake-image-bytes', method: 8 },
];

describe('epubExtractText', () => {
  test('按 spine 顺序提取，章节标题取 ncx，回退 h2/<title>；书名作者取自 dc 元数据', () => {
    const r = epubExtractText(buildZip(epubFiles));
    expect(r.title).toBe('测试之书');
    expect(r.author).toBe('张三');
    expect(r.text).toContain(`${CHAPTER_MARKER}第一章 起点`);
    expect(r.text).toContain('山不在高。');
    // ch2 的 ncx 标题优先于 <title> 备用标题
    expect(r.text).toContain(`${CHAPTER_MARKER}第二章 转折`);
    expect(r.text).not.toContain('备用标题');
    expect(r.text).toContain('斯是陋室。');
    expect(r.text).not.toContain('<p>');
    expect(r.text).not.toContain('fake-image-bytes');
  });

  test('损坏 zip 抛出可读错误', () => {
    expect(() => epubExtractText(new Uint8Array([0, 1, 2, 3]))).toThrow('无效的 zip 文件');
  });
});

describe('convertBookBytes 统一入口', () => {
  const enc = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf-8'));

  test('txt 直通（编码检测）', () => {
    expect(convertBookBytes('txt', enc('道可道')).text).toBe('道可道');
  });

  test('md/html/fb2/epub 均视为结构化格式', () => {
    expect(isStructuredFormat('md')).toBe(true);
    expect(isStructuredFormat('xhtml')).toBe(true);
    expect(isStructuredFormat('fb2')).toBe(true);
    expect(isStructuredFormat('epub')).toBe(true);
    expect(isStructuredFormat('txt')).toBe(false);
  });

  test('epub 提取结果可直接被 parseTxtBook 消费（markers 模式）', () => {
    const r = epubExtractText(buildZip(epubFiles));
    const book = parseTxtBook('测试之书.epub', r.text, 'user-test', {
      markers: true,
      title: r.title,
      author: r.author,
      sourceLabel: 'EPUB',
    });
    expect(book.title).toBe('测试之书');
    expect(book.author).toBe('张三');
    expect(book.description).toContain('导入自 EPUB');
    expect(book.chapters.length).toBe(2);
    expect(book.chapters[0].title).toBe('第一章 起点');
    expect(book.chapters[0].segments[0].text).toBe('山不在高。');
    expect(book.chapters[1].title).toBe('第二章 转折');
  });

  test('parseTxtBook 标记行缺标题时补「第N章」', () => {
    const book = parseTxtBook('书.md', ['前言。', `${CHAPTER_MARKER}序`, '内容一。', CHAPTER_MARKER, '内容二。'].join('\n'), 'user-test', { markers: true });
    expect(book.chapters.map((c) => c.title)).toEqual(['开篇', '序', '第2章']);
  });

  test('parseTxtBook 关闭 markers 时标记行按正文处理', () => {
    const book = parseTxtBook('书.txt', `${CHAPTER_MARKER}第一章\n正文。`, 'user-test');
    expect(book.chapters.length).toBe(1);
    expect(book.chapters[0].title).toBe('全文');
  });
});

describe('htmlToText headingMarkers', () => {
  test('开启时 h1-h3 转章节标记，默认关闭', () => {
    const html = '<h1>第一章</h1><p>正文。</p>';
    expect(htmlToText(html)).not.toContain(CHAPTER_MARKER);
    const marked = htmlToText(html, { headingMarkers: true });
    expect(marked).toContain(`${CHAPTER_MARKER}第一章`);
    expect(marked).toContain('正文。');
  });
});

describe('docxExtractText', () => {
  const docxFiles: ZipFileSpec[] = [
    {
      name: 'word/document.xml',
      content: [
        '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
        '<w:body>',
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章 起点</w:t></w:r></w:p>',
        '<w:p><w:r><w:t>山不在高，</w:t><w:br/><w:t>有仙则名。</w:t></w:r></w:p>',
        '<w:p><w:pPr><w:pStyle w:val="2"/></w:pPr><w:r><w:t>第二章</w:t></w:r></w:p>',
        '<w:p><w:r><w:tab/>水不在深。<w:t xml:space="preserve">斯是陋室。</w:t></w:r></w:p>',
        '</w:body></w:document>',
      ].join(''),
      method: 8,
    },
    {
      name: 'docProps/core.xml',
      content:
        '<cp:core-properties><dc:title>测试文档</dc:title><dc:creator>李四</dc:creator></cp:core-properties>',
      method: 8,
    },
  ];

  test('Heading1 与中文 styleId "2" 切章、w:br/w:tab 处理、core.xml 元数据', () => {
    const r = docxExtractText(buildZip(docxFiles));
    expect(r.title).toBe('测试文档');
    expect(r.author).toBe('李四');
    expect(r.text).toContain(`${CHAPTER_MARKER}第一章 起点`);
    expect(r.text).toContain('山不在高，\n有仙则名。');
    expect(r.text).toContain(`${CHAPTER_MARKER}第二章`);
    expect(r.text).toContain('水不在深。斯是陋室。');
    expect(r.text).not.toContain('<w:');
  });

  test('无 document.xml 抛错', () => {
    expect(() => docxExtractText(buildZip([{ name: 'a.txt', content: 'x' }]))).toThrow('DOCX');
  });
});

describe('odtExtractText', () => {
  const odtFiles: ZipFileSpec[] = [
    {
      name: 'content.xml',
      content: [
        '<office:document-content><office:body><office:text>',
        '<text:h text:outline-level="1">第一章 起点</text:h>',
        '<text:p>山不在高。<text:line-break/>有仙则名。</text:p>',
        '<text:h text:outline-level="2">第二章</text:h>',
        '<text:p>水不在深。</text:p>',
        '</office:text></office:body></office:document-content>',
      ].join(''),
      method: 8,
    },
    {
      name: 'meta.xml',
      content:
        '<office:document-meta><office:meta><dc:title>测试表格书</dc:title><dc:creator>王五</dc:creator></office:meta></office:document-meta>',
      method: 8,
    },
  ];

  test('text:h 切章、text:p 提取、meta.xml 元数据', () => {
    const r = odtExtractText(buildZip(odtFiles));
    expect(r.title).toBe('测试表格书');
    expect(r.author).toBe('王五');
    expect(r.text).toContain(`${CHAPTER_MARKER}第一章 起点`);
    expect(r.text).toContain('山不在高。\n有仙则名。');
    expect(r.text).toContain(`${CHAPTER_MARKER}第二章`);
    expect(r.text).toContain('水不在深。');
  });

  test('无 content.xml 抛错', () => {
    expect(() => odtExtractText(buildZip([{ name: 'a.txt', content: 'x' }]))).toThrow('ODT');
  });
});

describe('zipExtractText', () => {
  test('多文本条目按文件名切章（含子目录，跳过 __MACOSX）', () => {
    const zip = buildZip([
      { name: '__MACOSX/._a.txt', content: '垃圾数据' },
      { name: 'books/上卷.txt', content: '上卷内容。' },
      { name: 'books/下卷.txt', content: '下卷内容。' },
      { name: 'cover.png', content: 'fake-image' },
    ]);
    const r = zipExtractText(zip);
    expect(r.text).toContain(`${CHAPTER_MARKER}上卷`);
    expect(r.text).toContain('上卷内容。');
    expect(r.text).toContain(`${CHAPTER_MARKER}下卷`);
    expect(r.text).toContain('下卷内容。');
    expect(r.text).not.toContain('垃圾数据');
  });

  test('内嵌 epub 的 zip 自动按 EPUB 提取', () => {
    const innerEpub = buildZip(epubFiles);
    const outer = buildZip([{ name: 'book.epub', bytes: innerEpub, method: 8 }]);
    const r = zipExtractText(outer);
    expect(r.title).toBe('测试之书');
    expect(r.text).toContain('山不在高。');
  });

  test('无文本条目抛错', () => {
    expect(() =>
      zipExtractText(buildZip([{ name: 'img.png', content: 'x' }])),
    ).toThrow('压缩包内没有可识别的文本文档');
  });
});

describe('convertBookBytes 新格式路由', () => {
  const enc = (s: string): Uint8Array => utf8Encode(s);

  test('docx/odt/zip/mobi/prc/azw/rtf 均视为结构化格式', () => {
    for (const ext of ['docx', 'odt', 'zip', 'mobi', 'prc', 'azw', 'rtf']) {
      expect(isStructuredFormat(ext)).toBe(true);
    }
    expect(isStructuredFormat('txt')).toBe(false);
  });

  test('html 文件启用 h1-h3 切章', () => {
    const r = convertBookBytes('html', enc('<html><body><h2>上篇</h2><p>内容。</p></body></html>'));
    expect(r.text).toContain(`${CHAPTER_MARKER}上篇`);
    expect(r.text).toContain('内容。');
  });

  test('rtf 走解码 + 解析链', () => {
    const r = convertBookBytes('rtf', enc('{\\rtf1\\ansi \\u20013?\\u22269?}'));
    expect(r.text).toBe('中国');
  });
});
