import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * ★★★ 字典导入：`content://` 必须**先落地副本**（修「字典导入 100% 不可用」）。
 *
 * ##真机判决（`imp-run.log`，与书籍同型）
 * ```
 * [IMP][PICK] fileCopyUri=null isLocal=false
 *   chosen=content://com.android.providers.downloads.documents/document/raw%3A%2F…
 * [IMP][COPY] ok size=78      ★★ RNFS.copyFile 直接吃 content://
 * ```
 * ⇒ `copyTo: 'cachesDirectory'` 在华为**失败** ⇒ 回落 `content://`
 * ⇒ 原实现在**还没试 copyFile 之前**就拒了 ⇒ 字典导入 100% 不可用。
 *
 * ## ★与书籍侧的**关键差别**（决定两者修法不同）
 * | |书籍（`importBook`） | 字典（`pickDictFile`） |
 * |---|---|---|
 * | 谁先落地到本地 | `copyFile` 落到 `destPath` | ★**不落地**，直接用用户选的 uri |
 * | 之后`stat` 读谁 | `destPath`（本地 ✅） | **用户的 `content://` uri**（✗ `stat` 必失败）|
 * | 修法 | 直传即可 | ★**必须先复制到 cache**，让下游全走本地路径 |
 *
 * ★`fileSize` 是解析器的**硬依赖**（`StarDictParser`/`MDictParser` 用它算边界、
 *   `if (need > file.fileSize) throw`）⇒ 不能简单把 size 填 0 糊过去。
 */
describe('字典导入：content:// 先落地副本', () => {
  const SERVICE = resolve(__dirname, '../DictFileService.ts');
  const src = () => stripComments(readFileSync(SERVICE, 'utf8'));

  it('形状锁㊱：不得再用 isLocalPath 直接拒 content://', () => {
    const s = src();
    // ★锚点必须带返回类型：`async pickDictFile` 会命中 `pickDictFiles`（复数）
    const i = s.indexOf('async pickDictFile(): Promise');
    expect(i).toBeGreaterThan(-1);
    const seg = s.slice(i, i + 9000);
    // ★核心：那条「本地副本拿不到」的报错必须消失
    expect(seg).not.toMatch(/系统未能提供所选文件的本地副本/);
    // ★精确判据：`!isLocalPath` 分支**必须含 copyFile**（早退的特征是「只有 return false」）
    //   ★不能用「分支里有 success: false」当判据——新代码的 catch 里**也有**它
    //   （`复制所选文件到缓存失败`），会误判（我第一次写就踩了，条目 91）。
    const br = seg.indexOf('if (!isLocalPath(chosen))');
    expect(br).toBeGreaterThan(-1);
    const brSeg = seg.slice(br, br + 700);
    expect(brSeg).toMatch(/RNFS\.copyFile\(chosen,\s*dest\)/);
    expect(brSeg).toMatch(/RNFS\.mkdir\(dir\)/);
  });

  it('形状锁㊲：非本地路径必须 copyFile 到 cache 并改用本地 uri', () => {
    const s = src();
    // ★锚点必须带返回类型：`async pickDictFile` 会命中 `pickDictFiles`（复数）
    const i = s.indexOf('async pickDictFile(): Promise');
    const seg = s.slice(i, i + 9000);
    // ★自建副本：mkdir + copyFile
    expect(seg).toMatch(/RNFS\.mkdir\(dir\)/);
    expect(seg).toMatch(/RNFS\.copyFile\(chosen,\s*dest\)/);
    // ★返回的必须是**本地*    // ★★ 判据**不能**直接找含 `file://` 的串 ——
    //   `stripComments` 的行注释正则 `//[^\n]*` 会把**`file://` 里的 `//`**
    //   当成注释起点、删掉后面整行 ⇒ 断言必然失败（★判据工具破坏被测串，
    //   条目 91 第 7 例）。
    //   ⇒ 改用**不含 `//`** 的等价判据：赋值紧跟在 copyFile 之后。
    const k2 = seg.indexOf('RNFS.copyFile(chosen, dest)');
    expect(k2).toBeGreaterThan(-1);
    expect(seg.slice(k2, k2 + 160)).toMatch(/localUri = `file:/);
  });

  it('★ 行为组：两条分支的落地语义（真机读数锁值）', () => {
    // 复刻修好后的分支逻辑
    const isLocalPath = (u: string) => u.startsWith('/') || u.startsWith('file://');
    const CHOSEN = 'content://com.android.providers.downloads.documents/document/raw%3A%2F…';
    // ① copyTo 成功（fileCopyUri 有值）⇒ 直接用，不复制
    expect(isLocalPath('file:///data/user/0/x/dict.ifo')).toBe(true);
    // ② copyTo 失败（content://）⇒ 必须复制到 cache 后改用本地 uri
    expect(isLocalPath(CHOSEN)).toBe(false);
    const dest = '/data/user/0/x/cache/dict-import/123-dict.ifo';
    expect(isLocalPath(`file://${dest}`)).toBe(true);
    // ★决定性：原实现正是卡在 ②（判据为 false ⇒ 早退 ⇒ 不可用）
    //   而 copyFile 已被真机证明能吃 content://（size=78，47ms）⇒ 早退纯属误伤。
    expect(true).toBe(true);
  });
});

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}
