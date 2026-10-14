/**
 * 章级「最长拼音长度」缓存（纯逻辑，无 React 依赖 ⇒ 可 jest 直测）。
 *
 * 用途：阅读器「统一拼音字号」需要**按章**取「章内最长拼音的码点数」作为输入
 * （架构 §7.2：逐字自适应字号会造成同行拼音大小/字重不齐）。该输入只能由
 * 「对全章每一段做一次注音」得到，是一次 O(章内段数) 的同步计算。
 *
 * ★ 为什么必须缓存（2026-10-09 真机根因，⑫ 装配空窗）
 *   原实现把这段计算**内联在渲染 memo 里**，且依赖数组含 `segmentsByChapter`
 *   ⇒ 填充循环每追加一章就遍历**全部已载章的全部段**重算一次；且直接调用
 *   `PinyinService.annotate`（**无结果缓存**）⇒ 即使内容没变也全量重算。
 *   实测 3 章 ≈ 465 段 × ~19ms ≈ 9s 的**单次同步块**：JS 线程占用率 99%、
 *   一次 9.2~38s 无 yield（`[PERF][jank] jsBlocked=`），表现为换章/开书时正文区
 *   长时间空白且三个占位分支全被穿过（`lines.length > 0` 故不显示占位）。
 *   单变量对照（同脚本同判据）：注音关闭时该路径整体跳过 ⇒ 空窗 0/6 轮；
 *   注音开启 ⇒ 6 轮中 4 轮进入空窗（3 轮窗内恢复：12.0 / 16.5 / 3.2 s）。
 *
 * 本模块给出两条互不替代的护栏：
 *   ① **章内容签名**：签名不变 ⇒ 连遍历都不做（填充循环重复追加旧章不再重算）；
 *   ② **同参注音**：调用方注入的 `annotate` 必须与 `prewarmPinyinCache`／`PinyinText`
 *      同参（同 cacheSalt、同 workId/bookId）⇒ 章装载预热后此处即为 LRU 命中。
 *
 * 诊断口径：`computedSegments()` 累计**实际执行了注音调用**的段数（命中缓存不增加），
 * 是「缓存是否真的生效」的唯一判据——不要用耗时判据（墙钟会被无关 JS 工作撑大）。
 */
import { maxPinyinLength } from '@/services/PinyinService';
import type { PinyinAnnotation, PinyinMode, TextSegment } from '@/types';

/** 注音函数签名（注入以便单测；生产传 `annotateText`） */
export type ChapterAnnotateFn = (
  text: string,
  mode: PinyinMode,
  cacheSalt: string,
  opts: { workId: string; bookId?: string },
) => { success: boolean; data?: PinyinAnnotation[]; error?: string };

/**
 * 章内容签名（段数 | 码元总长 | 首段 id | 末段 id）。
 * O(段数) 的整数累加，**不触发任何注音计算**；段 id 参与 ⇒ 同长度换文亦可识别。
 */
export function chapterSegSignature(segs: readonly TextSegment[]): string {
  let total = 0;
  for (const s of segs) {
    total += s.text.length;
  }
  return `${segs.length}|${total}|${segs[0]?.id ?? ''}|${segs[segs.length - 1]?.id ?? ''}`;
}

export interface ChapterMaxPinyinLenStore {
  /** 取章内最长拼音长度；同章同签名命中缓存（0 次注音调用） */
  of(cid: string, segs: readonly TextSegment[], mode: PinyinMode, salt: string): number;
  /** 累计实际执行注音调用的段数（缓存命中的段不计入） */
  computedSegments(): number;
  clear(): void;
}

/**
 * 建章级缓存。**一个 store 服务一本书**（调用方按 bookId 各建一个）；键含
 * 章 id / 注音模式 / 多音字来源盐 —— 任一变化即失效，不会把「旧模式或旧读音来源
 * 下的字号」带进新场景。
 * ★ 跨书隔离靠「一 store 一书」，**不靠键里的 bookId**：bookId 是构造参数、在单个
 *   store 内为常量，写进键里既冗余又无法被单测检出（本仓已踩：变异「键去掉 bookId」
 *   不变红）。故显式不放入键，隔离改由单测锁定（两个 store 各自必须各算一遍）。
 */
export function createChapterMaxPinyinLenStore(
  annotate: ChapterAnnotateFn,
  bookId?: string,
): ChapterMaxPinyinLenStore {
  const cache = new Map<string, { sig: string; max: number }>();
  let computed = 0;

  return {
    of(cid, segs, mode, salt) {
      // 键不含 bookId：bookId 由**构造参数**固定，调用方按书各建一个 store
      // （ReaderScreen 以 useMemo([bookId]) 建）⇒ 写进键里是冗余分量、也测不出。
      // 跨书隔离由「一 store 一书」保证，并有单测锁住（见 pinyinLenCache.test.ts）。
      const key = `${cid}::${mode}::${salt}`;
      const sig = chapterSegSignature(segs);
      const hit = cache.get(key);
      if (hit !== undefined && hit.sig === sig) {
        return hit.max;
      }
      let max = 0;
      for (const seg of segs) {
        computed += 1;
        const res = annotate(seg.text, mode, salt, { workId: cid, bookId });
        if (res.success && res.data) {
          const len = maxPinyinLength(res.data);
          if (len > max) {
            max = len;
          }
        }
      }
      cache.set(key, { sig, max });
      return max;
    },
    computedSegments() {
      return computed;
    },
    clear() {
      cache.clear();
      computed = 0;
    },
  };
}
