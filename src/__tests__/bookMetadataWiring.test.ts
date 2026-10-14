/**
 * 结构化格式（epub/odt/fb2…）内嵌元数据必须贯通到书架书名/作者
 * —— 接线断言（源码文本即断言，剥离注释后计数）。
 *
 * 回归背景（2026-10-12 真机实证）：
 * `convertBookBytes` 已从 EPUB 的 OPF `dc:title` / `dc:creator` 解析出书名与作者
 * （`src/utils/bookFormat.ts:183-184`），但 `parseBookFile` 拿到 `converted` 后
 * **只取 `.text`**，把 `title` / `author` 整个丢掉；它构造的 `parseOpts` 也没带这两个字段
 * ⇒ `finishParsedBook`（`UserBookService.ts:4063-4064`）的 `opts?.title` 恒 undefined
 * ⇒ 回落 `fallbackTitle`（**文件名去掉扩展名**）与 `佚名`。
 *
 * 实录样本：`大奉打更人.epub` 的 `OEBPS/content.opf` 明确含
 * `<dc:title>大奉打更人</dc:title>` 与 `<dc:creator>卖报小郎君</dc:creator>`，
 * 书架却显示 `dafeng` + `佚名`。
 *
 * 为何是接线断言而非行为断言：`parseBookFile` / `finishParsedBook` 均为模块私有
 * （无导出），jest 无 preset-react 亦无法跑 .tsx，故按仓内既有做法
 * （`scrollLoadRetry.test.ts` 同法）锁源码形状。
 *
 * ★ 判据有效性：见本文件末尾「变异自证」——任一环节退化为「不传」即红。
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function countOf(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

const APP_ROOT = resolve(__dirname, '..');
const USER_BOOK_SERVICE_PATH = resolve(APP_ROOT, 'services/UserBookService.ts');
const BOOK_FORMAT_PATH = resolve(APP_ROOT, 'utils/bookFormat.ts');

describe('结构化格式内嵌元数据 → 书架书名/作者：贯通断言', () => {
  const svcSrc = stripComments(readFileSync(USER_BOOK_SERVICE_PATH, 'utf8'));

  test('bookFormat: EPUB 从 OPF 取 dc:title / dc:creator（本判据的上游前提）', () => {
    const fmtSrc = stripComments(readFileSync(BOOK_FORMAT_PATH, 'utf8'));
    expect(countOf(fmtSrc, "tagText(opf, 'dc:title')")).toBe(1);
    expect(countOf(fmtSrc, "tagText(opf, 'dc:creator')")).toBe(1);
  });

  test('parseBookFile: 读取 converted 的 title/author（不得只取 .text）', () => {
    // ★ 核心判据：只取 .text 就会让这两个赋值消失
    expect(countOf(svcSrc, 'metaTitle = converted.title')).toBe(1);
    expect(countOf(svcSrc, 'metaAuthor = converted.author')).toBe(1);
  });

  test('parseBookFile: parseOpts 携带 title/author 下传给 finishParsedBook', () => {
    // ★ 核心判据：解析出来但不传，等于没修
    expect(countOf(svcSrc, 'title: metaTitle')).toBe(1);
    expect(countOf(svcSrc, 'author: metaAuthor')).toBe(1);
  });

  test('finishParsedBook: 元数据优先、文件名仅作回落（`||` 兜底不可省）', () => {
    // 书名：opts?.title?.trim() || fallbackTitle
    expect(countOf(svcSrc, "opts?.title?.trim() || fallbackTitle")).toBe(1);
    // 作者：opts?.author?.trim() || '佚名'
    expect(countOf(svcSrc, "opts?.author?.trim() || '佚名'")).toBe(1);
    // fallbackTitle 必须来自文件名（无元数据时的唯一来源）
    expect(countOf(svcSrc, 'fileName.replace(')).toBeGreaterThanOrEqual(1);
  });

  test('ParseTxtBookOptions 早已声明 title/author（字段本就存在，只是一直没人填）', () => {
    // ⚠ 不可用注释文本做断言：stripComments 已把注释剥掉 ⇒ 恒 0（首版即踩）
    // ⇒ 锁字段声明本身
    expect(countOf(svcSrc, 'export interface ParseTxtBookOptions')).toBe(1);
    expect(countOf(svcSrc, 'title?: string')).toBeGreaterThanOrEqual(1);
    expect(countOf(svcSrc, 'author?: string')).toBeGreaterThanOrEqual(1);
  });

  test('不得用 `?? \'\'` 给 title/author 兜底（空串会被 `||` 当假值，语义混淆）', () => {
    // ⚠ 记忆铁律：守卫禁由 `x ?? ''` 供值（恒假 / 掩盖缺失）
    expect(svcSrc).not.toMatch(/title:\s*metaTitle\s*\?\?/);
    expect(svcSrc).not.toMatch(/author:\s*metaAuthor\s*\?\?/);
  });

  test('内置书仍由 spec 覆盖元数据（spec 优先级最高，本改动不得破坏它）', () => {
    // 实测两处：parseBookFile 内（:4278）与另一条内置水合路径（:4314）
    // 首版写 toBe(1) 实测 2 ⇒ 按实测改，不迁就断言
    expect(countOf(svcSrc, 'book.title = spec.title')).toBe(2);
    expect(countOf(svcSrc, 'book.author = spec.author')).toBe(2);
  });
});
