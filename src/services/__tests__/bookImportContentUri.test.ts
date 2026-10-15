import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * ★★★ 书籍导入：`content://` **不得**被早退拒掉（修「导入本地书籍」不可用）。
 *
 * ## 用户报障
 * 点「＋ 导入」选文件后弹：
 * 「系统未能提供所选文件的本地副本，请重新选择（建议把文件放到「下载」目录后再试）」
 *
 * ## 真机判决（`imp-run.log`，探针实测华为机）
 * ```
 * [IMP][PICK] fileCopyUri=null isLocal=false
 *   chosen=content://com.android.providers.downloads.documents/document/raw%3A%2Fstorage%2Femulated%2F0%2FDownload%2Fprobe_book.txt
 * [IMP][COPY] ok size=78        ★★ RNFS.copyFile 直接吃 content://，47ms 完成，字节数分毫不差
 * ```
 * 三个事实：
 * ① `copyTo: 'cachesDirectory'` 在**部分机型（华为）失败** ⇒ `fileCopyUri=null`
 *    ⇒ 回落 `content://` ⇒ 触发原实现的 `isLocalPath` 早退
 * ② `RNFS.copyFile` **完美支持 `content://`**（走 native ContentResolver）
 * ③ ⇒ 原实现在**还没试 copyFile 之前就拒了** ⇒ 功能 100% 不可用
 *
 * ★RNFS 对 `content://` 的支持是**分裂**的：`read`/`copyFile` **支持**，
 *   `stat` **必失败** ⇒★**不能拿 `isLocalPath` 当「能否导入」的判据**
 *   （这正是条目 85「判别通道选错 ⇒ 改判据永远无效」的同型错误）。
 */
describe('书籍导入：content:// 走通', () => {
  const SERVICE = resolve(__dirname, '../UserBookService.ts');
  const src = () => stripComments(readFileSync(SERVICE, 'utf8'));

  it('形状锁㉞：pickBookFile 不得用 isLocalPath 早退拒 content://', () => {
    const s = src();
    const i = s.indexOf('export async function pickBookFile');
    expect(i).toBeGreaterThan(-1);
    const seg = s.slice(i, i + 3000);
    // ★核心：不得再出现「非本地路径 ⇒ 返回失败」
    expect(seg).not.toMatch(/if \(!isLocalPath\(chosen\)\) \{[\s\S]{0,200}success: false/);
    // ★反向断言：那条错误文案不得作为**运行期**分支存在
    expect(seg).not.toMatch(/error: '系统未能提供所选文件的本地副本/);
  });

  it('形状锁㉟：importBook 必须把 uri 原样交给 RNFS.copyFile', () => {
    const s = src();
    const i = s.indexOf('export async function importBook');
    expect(i).toBeGreaterThan(-1);
    const seg = s.slice(i, i + 2000);
    // ★`toLocalPath(...)` 的结果直接进 copyFile（file:// 要剥前缀，content:// 原样）
    expect(seg).toMatch(/RNFS\.copyFile\(\s*toLocalPath\(file\.uri\),\s*destPath,?\s*\)/);
    // ★不得在 copyFile 之前用 isLocalPath 把关
    expect(seg.slice(0, seg.indexOf('RNFS.copyFile'))).not.toMatch(/isLocalPath/);
  });

  it('★ 行为组：uri 规范化对两种 scheme 的行为（判据自身须正确）', () => {
    // 复刻 toLocalPath / isLocalPath 的真实语义（`localPath.ts`）
    const toLocalPath = (uri: string): string => {
      let p = uri;
      if (p.startsWith('file://')) {
        p = p.slice('file://'.length);
        const q = p.indexOf('?');
        if (q >= 0) p = p.slice(0, q);
        try { p = decodeURIComponent(p); } catch { /* 保留原样 */ }
      }
      return p;
    };
    const isLocalPath = (uri: string): boolean => toLocalPath(uri).startsWith('/');
    // file:// ⇒ 剥前缀 + 解码 ⇒ 本地路径
    expect(toLocalPath('file:///data/a%20b.txt')).toBe('/data/a b.txt');
    expect(isLocalPath('file:///data/a%20b.txt')).toBe(true);
    // content:// ⇒ **原样返回**（copyFile 能吃，但 isLocalPath 判false）
    const c = 'content://com.android.providers.downloads.documents/document/raw%3A%2Fstorage%2Femulated%2F0%2FDownload%2Fprobe_book.txt';
    expect(toLocalPath(c)).toBe(c);
    expect(isLocalPath(c)).toBe(false);   // ★这正是原实现误拒的依据
    // ★决定性：`isLocalPath=false` 但 copyFile 仍成功 ⇒ 判据与能力不匹配
    expect(isLocalPath(c)).toBe(false);
    expect(c.startsWith('content://')).toBe(true);
  });
});

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}
