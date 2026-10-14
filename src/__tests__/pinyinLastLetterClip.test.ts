/**
 * 拼音「末字母被裁」回归锁（2026-10-12 真机 A/B）。
 *
 * ★ 缺陷（用户报：《大学》传三章「前王」的「王」只显示 wan）
 *   注音槽 `styles.pinyin` 是**定宽 1em**（＝`fontSize`）+ `numberOfLines={1}`
 *   + `ellipsizeMode="clip"`。Android `StaticLayout` 在「串宽 > 槽宽」时把尾字母
 *   **换到第 2 行**，而 `maxLines=1` 只保留第 1 行 ⇒ 末字母（多为 `g`/`n` 这类
 *   降部收尾）被丢弃：a11y 仍报全文 `wáng`，像素只有 `wàn`（真机实测
 *   墨迹 45px@823..867，格宽 57px，**两端都有空白** ⇒ 非右边界裁剪）。
 *
 * ★ 两次失败的假设（别再重走）
 *   ① 去掉 `styles.pinyin.width` ⇒ a11y bounds 45→56px 但**像素一字未变**（45px）
 *      ⇒ 只改布局不改装绘，无效。
 *   ② 去掉 `numberOfLines={1}` ⇒ 像素同样**一字未变** ⇒ 裁剪不在 JS 声明层，
 *      而在原生按行盒宽度断行的行为里。
 *
 * ★ 采用的修法（唯一实测生效）
 *   `adjustsFontSizeToFit` + `minimumFontScale`：字形**自动缩到槽内**，
 *   永不丢内容，且不触碰槽高 ⇒ 行高仍恒定（架构 §7.2 / INV-G1 不破）。
 *
 * 本测试锁「拼音 Text 必须带自动缩字属性」，并在注释中记录真机判据。
 * 纯静态断言（读源码文本）：Jest 环境无 RN 渲染，无法真跑原生断行行为；
 * 真机判据＝「墨迹两端留白且缺末字母」，A 包恒成立、修复包恒消失。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', 'components', 'reader', 'PinyinText.tsx');

describe('拼音末字母被裁回归（真机 A/B：wáng→wàn）', () => {
  const src = readFileSync(SRC, 'utf-8');

  /**
   * 取「拼音 Text」元素的属性区。
   * ⚠ 不能用 `indexOf('ellipsizeMode="clip"')`：通假字「通」圆标（:236 附近）
   * 也带 `numberOfLines={1}`，会先命中那一处。锚点必须用 `styles.pinyin`。
   */
  const pinIdx = src.indexOf('styles.pinyin');
  const attrs = src.slice(pinIdx, src.indexOf('>', pinIdx));

  it('拼音 Text 必须开 adjustsFontSizeToFit（否则宽拼音丢末字母）', () => {
    expect(pinIdx).toBeGreaterThan(-1);
    expect(attrs).toContain('adjustsFontSizeToFit');
    // 自动缩字必须有下限，否则极端长拼音被缩到不可读
    expect(attrs).toMatch(/minimumFontScale=\{[\d.]+\}/);
  });

  it('minimumFontScale 必须给出可读下限（≥0.5，避免缩到看不清）', () => {
    const m = src.match(/minimumFontScale=\{([\d.]+)\}/);
    expect(m).not.toBeNull();
    const scale = Number(m?.[1]);
    expect(scale).toBeGreaterThanOrEqual(0.5);
    expect(scale).toBeLessThan(1);
  });

  it('修复不应改动拼音槽高与定宽（行高恒定 ⇒ INV-G1 不破）', () => {
    // styles.pinyin 仍须保留 height / lineHeight / width（几何层 cellWidth 同源）
    const seg = src.slice(src.indexOf('pinyin: {'), src.indexOf('run: {'));
    expect(seg).toContain('lineHeight: pinyinLineHeight');
    expect(seg).toContain('height: pinyinLineHeight');
    expect(seg).toContain('width: fontSize');
    // cell 仍定宽 1em（折行点是「文本 + 档位」的纯函数，架构 §7.2 第 1 条）
    const cell = src.slice(src.indexOf('cell: {'), src.indexOf('pinyin: {'));
    expect(cell).toContain('width: fontSize');
  });
});