/**
 * zipReader 单测：stored / deflate 条目读取、目录名保留、结构非法抛错。
 */
import { buildZip, type ZipFileSpec } from '@/test-utils/buildZip';
import { listZipEntries, readZipEntry } from '@/utils/zipReader';

describe('listZipEntries + readZipEntry', () => {
  const files: ZipFileSpec[] = [
    { name: 'mimetype', content: 'application/epub+zip' },
    { name: 'META-INF/container.xml', content: '<container><rootfile/></container>', method: 8 },
    { name: 'OEBPS/text/ch1.xhtml', content: '<p>道可道，非常道。</p>', method: 8 },
    { name: 'OEBPS/cover.png', content: 'binary-simulated-content', method: 8 },
  ];

  test('列出全部条目并保留目录名', () => {
    const entries = listZipEntries(buildZip(files));
    expect(entries.map((e) => e.name)).toEqual([
      'mimetype',
      'META-INF/container.xml',
      'OEBPS/text/ch1.xhtml',
      'OEBPS/cover.png',
    ]);
  });

  test('stored 条目原样读出', () => {
    const zip = buildZip(files);
    const entry = listZipEntries(zip).find((e) => e.name === 'mimetype');
    expect(entry).toBeDefined();
    const data = readZipEntry(zip, entry!);
    expect(new TextDecoder().decode(data)).toBe('application/epub+zip');
  });

  test('deflate 条目正确解压', () => {
    const zip = buildZip(files);
    const entries = listZipEntries(zip);
    const container = readZipEntry(zip, entries[1]);
    expect(new TextDecoder().decode(container)).toContain('<rootfile/>');
    const ch1 = readZipEntry(zip, entries[2]);
    expect(new TextDecoder().decode(ch1)).toBe('<p>道可道，非常道。</p>');
  });

  test('size 字段与原始内容一致', () => {
    const zip = buildZip(files);
    const entries = listZipEntries(zip);
    const expectBytes = new TextEncoder().encode('<p>道可道，非常道。</p>').length;
    expect(entries[2].size).toBe(expectBytes);
  });

  test('非 zip 字节流抛错', () => {
    expect(() => listZipEntries(new Uint8Array([1, 2, 3, 4, 5]))).toThrow('无效的 zip 文件');
    expect(() => listZipEntries(new Uint8Array(0))).toThrow('无效的 zip 文件');
  });
});
