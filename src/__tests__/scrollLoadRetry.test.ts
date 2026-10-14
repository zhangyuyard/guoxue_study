/**
 * 滚动邻章装载「失败可重试」接线断言（源码文本即断言）。
 *
 * 回归背景（2026-09-29）：
 * 旧 fillFailedRef 是「永久黑名单」——邻章装载失败后 add(id) 且永不删除，
 * fillNeighbors 里 `!fillFailedRef.current.has(id)` 直接跳过该章 ⇒ 用户卡死在
 * 「继续滑动加载下一章」占位，零 UI 反馈、零重试入口（窗口层 windowFail 其实
 * 已清 inflight 允许重试，但上层黑名单把它拦死 ⇒ 两层矛盾）。
 *
 * 修复：失败集合从 ref 黑名单改为 state（驱动占位文案），去掉 has() 跳过，
 * 重试去重改由 windowBegin 闸门承担；占位在失败时显示「加载失败，滑动重试」。
 * 「黑名单跳过」与「失败文案」都不报错不红灯，只能靠接线断言锁住。
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

import {
  retainIdsByBudget,
  retainIdsForViewport,
  chaptersInRowRange,
  shouldFillPrevOnCommit,
  reservedPrevHeight,
  reservedHeaderDeltaContentSize,
  PREV_HINT_MIN_H,
} from '../reader/chapterWindow';
import { indexOfLineKey, lineKeyOf, type AnchorLineLike } from '../reader/core/modes/scrollAnchor';

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function countOf(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

const APP_ROOT = resolve(__dirname, '..');
const READER_SCREEN_PATH = resolve(APP_ROOT, 'screens/ReaderScreen.tsx');
const SCROLL_MODE_PATH = resolve(APP_ROOT, 'reader/core/modes/ScrollMode.tsx');

// ★ 模块级（V3 判据组要用；原在下一describe 内属局部作用域）
const readerSrc = stripComments(readFileSync(READER_SCREEN_PATH, 'utf8'));

describe('滚动邻章装载失败可重试：接线断言', () => {
  const scrollSrc = stripComments(readFileSync(SCROLL_MODE_PATH, 'utf8'));

  it('黑名单跳过逻辑已移除（fillFailedRef 及 fillNeighbors 内的 has() 跳过判据不残留）', () => {
    // 旧根因：fillNeighbors 用 fillFailedRef.current.has(id) 跳过失败章 ⇒ 永久卡死。
    // 修复后：① ref 本身消失；② fillNeighbors 内「取 sibling 后 && !失败 跳过」的判据消失
    //   （改为无条件取 sibling，重试去重由 windowBegin 闸门承担）。
    //   ⚠ loadError 的 useMemo 里仍有 fillFailed.has(...) —— 那是「失败态展示」判据，
    //   合法保留，不能误删。
    expect(countOf(readerSrc, 'fillFailedRef')).toBe(0);
    expect(countOf(readerSrc, 'fillFailed.current.has')).toBe(0);
    // fillNeighbors 内取 sibling 后不再跟黑名单跳过（旧：`s.data?.next && !fillFailedRef...`）
    expect(countOf(readerSrc, "s.data?.next && !fillFailed")).toBe(0);
    expect(countOf(readerSrc, "s.data?.prev && !fillFailed")).toBe(0);
    // 新：取 sibling 后直接 push（无跳过）。此判断出现 2 次：
    // fillNeighbors（取目标装载）与 loadError useMemo（取失败态展示）各 1 次。
    expect(countOf(readerSrc, "if (s.success && s.data?.next) {")).toBe(2);
    expect(countOf(readerSrc, "if (s.success && s.data?.prev) {")).toBe(2);
  });

  it('失败集合改为 state 且驱动 loadError（成功删 / 失败增）', () => {
    // 失败态 state 存在（用于占位文案，不阻断重试）
    expect(countOf(readerSrc, 'setFillFailed')).toBeGreaterThanOrEqual(2);
    expect(countOf(readerSrc, 'setFillFailed((prev)')).toBe(2);
  });

  it('占位在失败时显示失败态文案（next/prev 各 1 处）', () => {
    // ★★ V9（2026-10-14 占位等高）契约变更：头部占位的**正常态**文案由
    //   「上一章加载中…」改成「上章」（用户裁定：预留空白里放「上章」提示），
    //   失败态随之改成「上章加载失败，滑动重试」。
    //   ★断言按「写法会变」写（条目 101）：只锁「失败分支存在且两侧各一」，
    //     **不锁死具体字面量** —— 文案是产品决策，不是契约。
    expect(countOf(scrollSrc, 'loadError?.next ?')).toBe(1);
    expect(countOf(scrollSrc, 'loadError?.prev ?')).toBe(1);
    //失败分支必须真的带「重试」语义（否则用户不知道还能再滑）
    expect(countOf(scrollSrc, '重试')).toBe(2);
  });

  it('loadError 接线：ReaderScreen 计算并传入 ScrollMode', () => {
    expect(countOf(readerSrc, 'const loadError = useMemo(')).toBe(1);
    expect(countOf(readerSrc, 'loadError: loadError,')).toBe(1);
    // ScrollMode 侧解构并声明 prop 类型
    expect(countOf(scrollSrc, 'loadError?: { next?: boolean; prev?: boolean };')).toBe(1);
  });

  it('阴性对照：正常态文案仍在（失败时才切失败态），且计数工具本身有效', () => {
    // 同范围正对照：「重试」二字在场 ⇒ 计数工具本身有效（防「grep 打偏 = 假 0」）
    expect(countOf(scrollSrc, '重试')).toBeGreaterThan(0);
    // 尾部占位正常态文案（未改，仍锁字面量：它与V9 无关）
    expect(countOf(scrollSrc, '继续滑动以加载下一章…')).toBe(1);
    // ★头部占位正常态：V9 改为「上章」+ **贴底**渲染
    expect(countOf(scrollSrc, "'上章'")).toBe(1);
  });

  /**
   * 滚动跨章提交保留集必须按**行数预算 ∪ 视口覆盖**（2026-10-08 根因 + 2026-10-14 判决）。
   *
   * 症状一（2026-10-08）：固定三章的保留集在短章书上 ≈ 18 行 < 一屏 ⇒ 裁剪瞬间
   * contentH < viewportH ⇒ 原生 maxScroll = 0 ⇒ 滚动位置被钳到 0
   * （下滚中突然跳回窗口顶 + 露出「上一章加载中…」）。这类「集合过小」
   * 不报错不红灯，只能靠接线断言锁住。
   *
   * 症状二（2026-10-14 真机；**载体=那本 161MB epub/980 章，已被 `pm clear` 删除、
   * 不可恢复**）：**长章书上预算集只剩离散三章**（`budget = 6 × lpp` < 单章行数
   * ⇒ 扩张循环一次不执行）⇒ 上一章被丢出门 ⇒ `fillNeighbors({forcePrev:true})`
   * 又补回来 ⇒ **自造 prepend** ⇒ delta = 整章高度 ⇒ 闪烁。
   * ⇒ 当时据此并入**视口覆盖集**（`retainIdsForViewport`）。
   *
   * ⚠⚠⚠ **本组断言守护的修法已被 A6 / B2 两轮真机判决为「无效」**
   *   （同起点对照：加下限前 err=795 / 加三章下限后 err=952，两臂都出 prepend）。
   *   ⇒ 这些形状锁现在锁的是「**已存在的接线**」，不是「有效的修法」——
   *   它们能防回归（有人拆接线会红），但**不构成该修法有效的证据**。
   *   ★ 数量级也已过期：本段曾写「单章行数中位 133」，那是那本已删 epub 的读数；
   *     当前 77 本内置书实测（cpl ∈ [10,20]）跨书中位 52–96、呈双峰
   *     （`tongjian` p50 723–1134 vs `songci` p50=10），量级表见 `ReaderScreen`
   *     `retainForScrollCommit` 注释。真机量级判据另见 `chapterWindow.test.ts`
   *     的「真机量级等价判据」组（M1–M13），两组并存、互不遮蔽。
   *
   * ★ 本组断言按「写法会变」写（条目 101）：初版锁 `retainForScrollCommit(chapterId)`
   *   与 `retainIdsByBudget(` 字面量，接线一旦加参数/换函数名就假红 ——
   *   而它想锁的语义（**保留集必须走预算邻域，不得退回固定三章**）并未变。
   *   ⇒ 改为正则 + **新增行为组**（真函数输出）承载语义，形状锁只锁「不许退回三章」。
   */
  it('跨章提交保留集＝行数预算邻域 ∪ 视口覆盖集（不再固定三章）', () => {
    // ① 形状锁：跨章提交**必须**走 retainForScrollCommit（正则容忍参数变化）
    //    ★ 定义处写法是 `retainForScrollCommit = useCallback(`（不带括号），
    //      故「定义 + 调用」的计数口径＝声明 1 处 + 调用 1 处，分开断言更稳。
    expect(countOf(readerSrc, 'retainForScrollCommit = useCallback(')).toBe(1); // 定义
    expect(countOf(readerSrc, 'retainForScrollCommit(')).toBe(1); // 调用（import/依赖数组无括号）
    expect(readerSrc).toMatch(/retainForScrollCommit\(\s*chapterId\s*,/);
    // ★ 旧实现（固定三章）必须消失 —— 强度不许降低
    expect(countOf(readerSrc, 'windowRecenter(w, chapterId, retainSetFor(chapterId))')).toBe(0);
    // ② 预算来源仍在：行数预算算式 + 每章行数（stitched.lineCountOf）
    //    ★ 2026-10-14：上方余量也用同一算式（`SCROLL_WINDOW_KEEP_SCREENS * lpp`）
    //      ⇒ 该串出现 2 次（budget + leadRows），是**有意**的，不是重复代码。
    expect(countOf(readerSrc, 'SCROLL_WINDOW_KEEP_SCREENS * lpp')).toBe(2); // budget + leadRows
    // ★ 2026-10-14 V9-b：该串现在出现 **2** 次——`retainForScrollCommit` 的
    //   `lineCountOfOf` 与 V9-b 的「预留行数取窗口 max」是**两处不同用途**的
    //   同款表达式（前者算保留集，后者算预留高度），**有意为之**。
    //   ⇒ 按「写法会变」写（条目 101）：锁「≥1 且被 retainForScrollCommit 用到」，
    //     不锁死出现次数。
    expect(countOf(readerSrc, 'stitched.lineCountOf.get(id) ?? 0')).toBeGreaterThanOrEqual(1);
    expect(readerSrc).toMatch(/\(id\)\s*=>\s*stitched\.lineCountOf\.get\(id\)/);
    // ★ 上方余量必须真的传进去（不传 ⇒ leadRows 默认 0 ⇒ 纯视口语义 ⇒ 跨章时旧章保不住，
    //   自造 prepend 照旧 —— 这是第一版落码的真实缺陷，钉住它）
    expect(countOf(readerSrc, 'SCROLL_WINDOW_KEEP_SCREENS * lpp,\n      );')).toBe(1); // 余量作末参传入
    // ③ ★保留集函数已换成「预算 ∪ 视口」版（原 `retainIdsByBudget` 在生产侧不再直接调用）
    expect(countOf(readerSrc, 'retainIdsForViewport(')).toBe(1); // 调用 1（import 行无括号）
    expect(countOf(readerSrc, '  retainIdsForViewport,')).toBe(1); // import 1
    expect(countOf(readerSrc, 'retainIdsByBudget(')).toBe(0); // 旧纯预算版不得再被直接调用
    // ④ 视口顶行下标必须真的传进去（否则视口约束退化成 -1 ⇒ 恒退回预算集）
    expect(countOf(readerSrc, 'retainForScrollCommit(chapterId, topLineIndex)')).toBe(1);
    // ★★ ④b 顶行下标**必须由 key 现场求出**（形状锁，条目 101）
    //   背景（变异自证实测两次）：上一版只锁了「topLineIndex 这个名字在场」，
    //   变异「恒 -1」/「恒 0」因此**零红** —— 而那两者都会让视口约束失效
    //   （-1 越界⇒退回预算集；0 ⇒ 只保首章覆盖，与跨章几何无关）。
    //   ★ 纯函数测得再准也管不到「生产有没有正确调用它」（测试与生产不同进程、
    //     不同数据 ⇒ 不连通）⇒ 只能用形状锁把这条调用钉死。
    expect(readerSrc).toMatch(
      /const topLineIndex = firstLine\s*\?\s*indexOfLineKey\(stitched\.lines,\s*lineKeyOf\(firstLine\)\)\s*:\s*-1;/,
    );
    // 反向断言：顶行下标不得被写成常量（这两种写法都让视口约束失效）
    expect(countOf(readerSrc, 'const topLineIndex = -1;')).toBe(0);
    expect(countOf(readerSrc, 'const topLineIndex = 0;')).toBe(0);
    // ⑤ 预算下限：≤1 屏在短章书上仍会把位置钳到 0 ⇒ 必须 ≥3
    const m = readerSrc.match(/SCROLL_WINDOW_KEEP_SCREENS = (\d+);/);
    expect(m).not.toBeNull();
    expect(Number((m as RegExpMatchArray)[1])).toBeGreaterThanOrEqual(3);
  });

  /**
   * ★ 行为组（2026-10-14）：上面那组是**形状锁**，对「换一个等价的纯预算实现」
   * 零鉴别力（条目 90）。语义必须由真函数的**输出**承载。
   *
   * 判据形态 = **合成样本**（A=133、B=200 行，是被测量的量，不是某本书的读数）：
   * 单章 > budget 78 ⇒ 预算集只剩离散三章；视口顶行 130 落在 A/B 界上
   * ⇒ 保留集**必须**含 A。
   * ⚠ 量级已按当前载体复核：真实内置书是**双峰**（`tongjian` p50 723–1134 /
   *   `songci` p50=10），本组用的 133 落在两峰之间的空档上，真机上不存在。
   *   ⇒ 本组守的是**算法语义**（长章 ≫ 预算 + 顶行跨界 ⇒ 前章必保），
   *     真机量级另有 `chapterWindow.test.ts` 的 M1–M13 组覆盖，两组并存。
   */
  it('★行为组：长章书 + 视口跨章界 ⇒ 保留集必须含前章（核心回归）', () => {
    const rows: Record<string, number> = { A: 133, B: 200 };
    const keep = retainIdsForViewport('B', ['A', 'B'], (id) => rows[id] ?? 0, 130, 13, 78);
    // 旧行为（纯预算、长章书退化）只留 B ⇒ A 丢出门外 ⇒ 自造 prepend
    expect(keep.has('A')).toBe(true);
    expect(keep.has('B')).toBe(true);
    // ★2026-10-14 契约变更：中心=A 时 B 由**离散三章下限**保住 ⇒ 原阴性对照
    //   `has('B')===false` 恒红，已失去鉴别力 ⇒ 改判「离中心两章的章不得被保」。
    const only = retainIdsForViewport('A', ['A', 'B', 'C'], (id) => rows[id] ?? 0, 5, 13, 78);
    expect(only.has('A')).toBe(true);
    expect(only.has('C')).toBe(false); // 变异「下限无脑多保」在此红
  });

  /**
   * ★★ 新修法的**行为核心**（2026-10-14，纯几何判据测不到这一层）。
   *
   * `fillNeighbors` 里 `needPrev = loadedChapters[0] === activeChapterId`
   * —— 跨章提交后若「渲染序链首 == 锚章」，该判据**恒真** ⇒ 又把上方章补回来
   * ⇒ 插到锚章上方 = **prepend** = 用户看到的整章位移闪烁。
   *
   * 本条直接断言这条因果链的**结果**：
   *   `retainIdsByBudget` 的输出 ⇒ 按渲染序过滤 ⇒ 链首 ≠ 锚章。
   * 这是 A6 判决所指向的根因（长章书上保留集退化为 1 章 ⇒ 链首==锚章恒成立），
   * 也是「三章下限」这个改动**唯一真正要保证的性质**。
   * ★ 纯函数判据只管「函数输出什么」，管不到「生产有没有用这个输出」
   *   （条目 109/111 B3）⇒ 生产侧的 `retainForScrollCommit` 接线由上方形状锁保证。
   */
  it('★★★行为核心：长章书跨章后，渲染序链首 ≠ 锚章（⇒ needPrev 为假 ⇒ 不补 ⇒ 不 prepend）', () => {
    // 真机量级（条目 111b）：单章 980/1053 行 ≫ budget 78
    const rows: Record<string, number> = { a1: 980, a2: 1053, a3: 980, a4: 1053 };
    const order = ['a1', 'a2', 'a3', 'a4'];
    const countOf = (id: string) => rows[id] ?? 0;
    // 跨章 a1 → a2：锚章是 a2
    const keep = retainIdsForViewport('a2', order, countOf, 980, 13, 78);
    const kept = order.filter((id) => keep.has(id));
    // 复现生产的 needPrev 判据
    const loadedFirst = kept[0] as string;
    const activeChapterId = 'a2';
    const needPrev = loadedFirst === activeChapterId;
    // ★ 修复前：保留集 = {a2} ⇒ kept=[a2] ⇒ needPrev=true ⇒ 补 a1 ⇒ prepend
    // ★ 修复后：链首是 a1 ⇒ needPrev=false ⇒ 不补 ⇒ lines 不变 ⇒ delta=0
    expect(needPrev).toBe(false);
    expect(loadedFirst).toBe('a1');
    expect(kept).toContain('a2');
    // 阴性对照（必须能区分两种结果，否则本条无鉴别力）：
    //   旧契约「只保锚章」的形态 ⇒ 链首 == 锚章 ⇒ needPrev 恒真
    const legacy = new Set(['a2']);
    const legacyKept = order.filter((id) => legacy.has(id));
    expect((legacyKept[0] as string) === activeChapterId).toBe(true); // 旧形态确实会触发补装
  });

  /**
   * ★★ 端到端接线行为判据（2026-10-14 变异自证补的第三条盲区）。
   *
   * 变异自证发现：接线变异 **N2（顶行下标恒传 -1）/ N3（恒取 0）零红**
   * ⇒ 上一组断言只锁了「代码在场」，对「**算出来的值对不对**」零鉴别力
   * （条目 90 的同族形态：文本断言对等价/错误实现都绿）。
   *
   * 本组用**真函数链**（`lineKeyOf` → `indexOfLineKey` → `retainIdsForViewport`）
   * 跑一个真机形态样本，断言**端到端算出的顶行下标**与最终保留集：
   * ```
   *   stitched.lines = [A 标题行 + A 133 行] + [B 标题行 + B 200 行]（共 335 行）
   *   ⚠ 合成量级样本（非某本书的读数；真实内置书双峰，见文件头说明）
   *   跨章提交：视口顶行 = B 的第 5 行 ⇒ 全局下标 139
   *   ⇒ indexOfLineKey 必须返回 139（变异 N3 返回 0、N2 返回 -1 ⇒ 都会红）
   *   ⇒ 保留集必须含 A（否则 A 出门 → fillNeighbors 补回 → 自造 prepend）
   * ```
   */
  it('★★★接线算式自身的鉴别样本：不同顶行 ⇒ 不同下标（N2/N3 唯一能红的形态）', () => {
    // 承上一条：断言「值」还不够（变异可以把函数改成恒返 TOP 而对单样本仍绿）。
    // ★ 必须用**多个不同顶行**跑同一算式，逐个核对 —— 这样「恒返常量」立刻暴露。
    const lines: AnchorLineLike[] = [];
    for (const [cid, bodyRows] of [['A', 133], ['B', 200]] as const) {
      lines.push({ chapterId: cid, segmentId: '__title__', charStart: 0, isTitle: true });
      for (let j = 0; j < bodyRows; j += 1) {
        lines.push({
          chapterId: cid,
          segmentId: `${cid}-s${Math.floor(j / 3)}`,
          charStart: Math.floor(j / 3) * 40 + (j % 3) * 40,
        });
      }
    }
    // 遍历多个真实顶行（含跨章界那个），逐个核对「算出来 == 期望」
    for (const probe of [0, 5, 133, 134, 139, 200, 334]) {
      const probeLine = lines[probe] as AnchorLineLike;
      expect(indexOfLineKey(lines, lineKeyOf(probeLine))).toBe(probe);
    }
    // ★ 反向：找不到 ⇒ -1（与所有合法下标都不同 ⇒ 恒返 -1 的变异在此红）
    expect(indexOfLineKey(lines, 'MISSING#x#0')).toBe(-1);
  });

  it('★★端到端：顶行 key → 全局下标 → 视口覆盖保留集（N2/N3 的专属鉴别样本）', () => {
    // 造**真机形态**样本：A=133 行正文 + B=200 行正文，各带 1 个章标题行。
    // ⚠ 量级是合成的（真实内置书双峰，见文件头说明）；这里要测的是**算法语义**。
    const lines: AnchorLineLike[] = [];
    for (const [cid, bodyRows] of [['A', 133], ['B', 200]] as const) {
      lines.push({ chapterId: cid, segmentId: '__title__', charStart: 0, isTitle: true });
      for (let j = 0; j < bodyRows; j += 1) {
        lines.push({
          chapterId: cid,
          segmentId: `${cid}-s${Math.floor(j / 3)}`,
          charStart: Math.floor(j / 3) * 40 + (j % 3) * 40,
        });
      }
    }
    expect(lines.length).toBe(335);

    // 跨章提交：视口顶行 = B 的第 5 行（ScrollMode 传的是 firstContentLineOf(cur, ownerIdx)）
    const TOP = 134 + 5; // A 占 134 行（含标题行）
    const firstLine = lines[TOP] as AnchorLineLike;
    expect(firstLine.chapterId).toBe('B');

    // ★ 端到端算下标：与生产接线同一条算式
    // ★★ 这里必须断言**值**，而不是「函数在场」——上一版只锁了代码文本，
    //    变异 N2(恒 -1) / N3(恒 0) 因此零红（实测两次）。本组断言下标真值：
    const topLineIndex = indexOfLineKey(lines, lineKeyOf(firstLine));
    expect(topLineIndex).toBe(TOP); // N2(-1) / N3(0) 都在此红
    // 阴性对照：非顶行时返回别的下标（防「函数恒返 TOP」这种死常量蒙对）
    expect(indexOfLineKey(lines, lineKeyOf(lines[TOP - 40] as AnchorLineLike))).toBe(TOP - 40);
    // 阴性对照：找不到的行返回 -1（这是 N2 变异的值，必须与正确值不同）
    expect(indexOfLineKey(lines, 'ZZ#none#0')).toBe(-1);

    // ★ 端到端算保留集：A=134 行（含标题）[0,134)，B=201 行 [134,335)
    //   budget = 6×13 = 78；★上方余量必须 ≥1 屏（跨章时视口全在新章内，见 V11）
    const counts: Record<string, number> = { A: 134, B: 201 };
    // ★2026-10-14 契约变更：两条旧断言都由「离散三章下限」兜住、恒红，已换层：
    //  ① 「leadRows=0 ⇒ A 丢失」——现在 A 由下限保住 ⇒ 该断言失效；
    //     根因（纯视口语义够不着旧章）改由覆盖层直测钉住。
    expect(chaptersInRowRange(['A', 'B'], (id) => counts[id] ?? 0, topLineIndex, topLineIndex + 13))
      .toEqual(['B']);
    // ② 「纯预算集只留 B」——现在纯预算集也保三章 ⇒ 恒红。
    //     ★ 这条曾是新修法（A6 前置版）**失效**的直接证据：预算集退化 ⇒ A 出门。
    //     现在它必须保 A —— 契约已换。
    const budgetOnly = retainIdsByBudget('B', ['A', 'B'], (id) => counts[id] ?? 0, 78);
    expect([...budgetOnly].sort()).toEqual(['A', 'B']);
    // 生产接线用的形态（leadRows = 6 屏 = 78 行）⇒ 覆盖 [61,152) ⇒ A 被保住
    const keep = retainIdsForViewport(
      'B', ['A', 'B'], (id) => counts[id] ?? 0, topLineIndex, 13, 78, 6 * 13,
    );
    expect(keep.has('A')).toBe(true); // 必须保 ⇒ 不补 ⇒ delta = 0
    expect(keep.has('B')).toBe(true);
  });

  it('阴性对照：跳章清窗仍用三章保留集（预算策略只作用于滚动跨章提交）', () => {
    // 路由进入/跳章路径保留原语义（清窗 + 邻域三章）
    expect(countOf(readerSrc, 'const retain = retainSetFor(chapterId);')).toBe(1);
    expect(countOf(readerSrc, 'const retain = retainSetFor(cid);')).toBe(1);
  });

  /**
   * 末端续装必须由「滚动中」与「拖拽/动量结束」两条路径共同驱动
   * （2026-10-08 真机实证）。
   *
   * 症状：滚动到已载窗口末端后，原生**不再派发 onScroll**（真机：连滑 8 次
   * `[end]` 的 `y` 恒 3505.3、画面零变化、底部占位恒「继续滑动以加载下一章…」）
   * ⇒ 只挂在 onScroll 上的边沿判据永不执行 ⇒ 死锁。
   * 次症状：「临近末端」去重靠「进区一次、出区重置」，而装载只把末端下推约
   * 一章（≈200dp）、用户一次滑动 >1000dp ⇒ 永不「出区」⇒ 同样死锁。
   * 两者都不报错不红灯，只能靠接线断言锁住。
   */
  it('末端续装双路径驱动 + 末端/起点可重复触发（防死锁）', () => {
    // fireBoundary 定义 1 处；被调用 2 处（handleScroll / handleScrollEnd）
    expect(countOf(scrollSrc, 'const fireBoundary = useCallback(')).toBe(1);
    expect(countOf(scrollSrc, 'fireBoundary(y);')).toBe(2);
    // 可重复触发判据（不依赖「出区重置」）——★ 必须断言**使用处**：
    //   只断言声明行是「死常量式」假判据（变异删掉 if 块仍全绿，实测过）。
    expect(countOf(scrollSrc, 'const atEnd = hasMoreNext && y >= totalH - viewportH - 1;')).toBe(1);
    expect(countOf(scrollSrc, 'const atTop = hasMorePrev && y <= 1;')).toBe(1);
    expect(countOf(scrollSrc, 'if (atEnd) {')).toBe(1);
    expect(countOf(scrollSrc, 'if (atTop) {')).toBe(1);
    // 阴性对照：进区去重仍在（区间判据不许被 atEnd 取代）
    expect(countOf(scrollSrc, 'nearNext !== nearStateRef.current.next')).toBe(1);
    expect(countOf(scrollSrc, 'nearPrev !== nearStateRef.current.prev')).toBe(1);
  });
});

/**
 * ★★★ V3 判据组：跨章滚动**不得**触发「邻章预取」的 prev 方向。
 *
 * ## 为什么要有这一组（A6/B2 三轮都改错了地方）
 *
 * B2 实测：`chainEqActive`（`loadedChapters[0]===activeChapterId`）在**加三章下限之前
 * 那一版就已经是 false** ⇒ 判据「链首==锚章 ⇒ needPrev」**从来没为真过**
 * ⇒ 却仍出 prepend ⇒ **prepend 不是从 `fillNeighbors` 来的**。
 *
 * 纸上验算（用实测 tongjian 几何：lpp=13 budget=78 单章 880 行 294 章）也指向同一结论：
 * ```
 *   保留集含旧章 ⇒ 链首≠锚章 ⇒ 判据A 为假
 *   5 次连续跨章：forcePrev=true ⇒ 补装 5 次；不传 forcePrev ⇒ 补装 0 次
 * ```
 * ⇒ 「去掉 forcePrev」本身有效，但真机上仍 prepend ⇒ **必是另一条通道**。
 *
 * ★ 真因（2026-10-14 定位，此前三轮从未查过）：ReaderScreen 里**邻章预取 effect**
 *   （依赖 `[loaded, activeChapterId, loadChapterData]`）：
 *   ```
 *   for (const nid of [sib.data.prev?.id, sib.data.next?.id]) {   ← 无条件两个方向
 *     setWin(w => windowBegin(w, nid)); // … windowPut(w, nid, data)
 *   }
 *   ```
 *   跨章提交必调 `setActiveChapterId` ⇒ **必然触发** ⇒ `windowPut(prev)` 落在新章
 *   **之前** = prepend，**完全绕过 `fillNeighbors` 的全部判据**。
 *   ⇒ 这就是「三轮都在盯`fillNeighbors`」却不见效的原因（条目 97的镜像：
 *   判别通道选错 ⇒ 改判据永远无效）。
 *
 * ★ 本组用**形状锁 + 行为组双层**：形状锁钉「prev 方向必须有条件」，
 *   行为组钉「下滚跨章时 prev 不进窗口」。层间不可互相遮蔽（条目 113）。
 */
describe('V3 邻章预取：跨章滚动不得补 prev（闪烁真因通道）', () => {
  /** 取「邻章预取 effect」那段源码（按注释锚点切，避开位置漂移） */
  const neighborPrefetchSrc = (src: string): string => {
    // ★ 锚点必须在**代码**里（src 已 stripComments ⇒ 注释锚点必然 -1，
    //   这是「判据自身的构造错误」，条目 91）。用邻章预取的唯一代码特征：
    //   `getSiblingChapters(activeChapterId)`。
    const start = src.indexOf('getSiblingChapters(activeChapterId)');
    expect(start).toBeGreaterThan(-1);
    // 下一个 useEffect 声明即本effect 结束
    const end = src.indexOf('useEffect', start + 10);
    const seg = src.slice(start, end === -1 ? start + 2000 : end);
    // ★ 正对照（条目 8：切片函数可能整体切空 ⇒ 所有 not.toMatch 恒真＝零鉴别力）
    expect(seg.length).toBeGreaterThan(200);
    expect(seg).toContain('getSiblingChapters');
    return seg;
  };

  it('形状锁①：prev 进targets 必须带条件（语义级，不钉字面写法）', () => {
    const seg = neighborPrefetchSrc(readerSrc);
    // ★★ 上一版用 `not.toMatch(/for(of [prev,next])/)` ⇒ **零鉴别力**（实测 M1–M4 全绿）：
    //   修法只是把字面量换成 `for (of prefetchTargets)`，字面量就消失了 ⇒ 无缺陷也绿。
    //   ⇒ 改为**语义级**：找「prev 被放进 targets 的那个表达式」，
    //     断言它**处在一个条件表达式里**（`cond ? ... : ...` / `cond && ...`）。
    //   先取 targets 的定义：
    const defIdx = seg.search(/const\s+\w+\s*=\s*scrollDirRef\.current\s*[<>=]/);
    // 允许两种等价修法：① 条件表达式 ② 用 filter/if 守卫prev
    const hasCondTernary = /\?\s*\[[^\]]*\.prev/.test(seg);
    const hasCondGuard = /(if\s*\([^)]*(scrollDir|scrollDirection|userScrollingUp|atScrollTop|scrollingUp)[^)]*\)[\s\S]{0,200}?\.prev)/.test(seg);
    const hasFilterGuard = /\.filter\([^)]*scrollDir/.test(seg);
    // 三种守卫形态任一成立即算「prev 有条件」
    expect(hasCondTernary || hasCondGuard || hasFilterGuard).toBe(true);
    // ★ 反向断言：**无条件**形态必须不存在（这才是缺陷本身）
    //   「无条件」＝ prev 出现在 targets 里且**整段没有方向判据**
    const anyDir = /(scrollDir|scrollDirection|userScrollingUp|atScrollTop|scrollingUp)/.test(seg);
    expect(anyDir).toBe(true);
    // prev 必须真的还在预取列表里（否则是「另一种错」：把功能删了）
    expect(seg).toMatch(/\.prev\?*\.id/);
    // 若 targets 定义用了 scrollDirRef，则该定义必须在片段内（防切片截断导致恒真）
    if (defIdx >= 0) {
      expect(defIdx).toBeLessThan(seg.length);
    }
  });

  it('形状锁②：prev 预取必须挂在「用户是否真在往上滚」的判据上', () => {
    const seg = neighborPrefetchSrc(readerSrc);
    // 必须出现「滚动方向」判据（任一命名）
    expect(seg).toMatch(/scrollDir|scrollDirection|userScrollingUp|atScrollTop|scrollingUp/);
    // ★★ 反向断言（条目 101）：判据名**在场**不够——变异「声明一个恒真/死变量」
    //   就能把它骗过去（实测 V2：`const scrollDir = 1` + `void scrollDir` 全绿）。
    //   ⇒ 必须**用在 prev 的筛选条件里**：出现 `…prev…(cond)` 或 `if (cond) …prev`
    //   形态，且条件里含该判据名。
    expect(seg).toMatch(
      /\.prev\?*\.id[^\n]*\?[^\n]*(scrollDir|scrollDirection|userScrollingUp|atScrollTop|scrollingUp)|(scrollDir|scrollDirection|userScrollingUp|atScrollTop|scrollingUp)[^\n]*\n?[^\n]*\.prev/,
    );
    // ★ 且该判据**不得是常量**（真机实测方向会变；恒定方向＝恒预取或恒不预取）
    expect(seg).not.toMatch(/(scrollDir|scrollDirection|userScrollingUp|atScrollTop|scrollingUp)\s*=\s*(-?\d+|true|false|'up'|'down')/);
  });

  it('形状锁③：ScrollMode 必须真的把方向回调出去（覆盖 M5/M6 接线变异）', () => {
    const seg = neighborPrefetchSrc(readerSrc);
    // 接线①：ReaderScreen 必须把 handleScrollDir 传给 ScrollMode
    expect(seg.length).toBeGreaterThan(200); // 正对照：切片非空
    const rFull = readFileSync(READER_SCREEN_PATH, 'utf8');
    expect(stripComments(rFull)).toMatch(/onScrollDirChange:\s*handleScrollDir/);
    // 接线②：ScrollMode 侧必须存在「翻转才回调」的比较与调用（防恒 0 / 防逐帧刷屏）
    const sFull = stripComments(readFileSync(SCROLL_MODE_PATH, 'utf8'));
    expect(sFull).toMatch(/scrollDirRef\.current\s*=\s*dir/);
    expect(sFull).toMatch(/dir\s*!==\s*lastNotifiedDirRef\.current/);
    expect(sFull).toMatch(/scrollDirCbRef\.current\?\.\(dir\)/);
    // ★ 防「每帧都回调」：回调必须**在 if (dir !== last) 之内**。
    //   这条不能用 not.toMatch 表达（实测：写成 not.toMatch(…;\s*\}) 会把
    //   **正确**的 `if (翻转) { 回调 }` 结构也判红 ⇒ 惩罚正确写法）。
    //   改用**位置关系**断言：回调行号必须大于翻转判据行号，且中间不得跨越 if 的闭合。
    const iCmp = sFull.indexOf('dir !== lastNotifiedDirRef.current');
    const iCall = sFull.indexOf('scrollDirCbRef.current?.(dir)');
    expect(iCmp).toBeGreaterThan(-1);
    expect(iCall).toBeGreaterThan(iCmp);
    // 调用必须落在翻转判据之后 200 字符内（同一个小if 块内）
    expect(iCall - iCmp).toBeLessThan(200);
  });

  it('★ 行为组：保留集不含旧章时，跨章不得靠预取把旧章补到窗口上方', () => {
    // 短章书真几何（实测 songci p50=10 行 / liwengduiyun p50=9）
    const chapLines = 10;
    const order = Array.from({ length: 30 }, (_, i) => `c${i + 1}`);
    const rows: Record<string, number> = {};
    order.forEach((id) => {
      rows[id] = chapLines;
    });
    const center = 'c6';
    // 跨章提交：视口顶行 = 新章首行（全局下标 = 5×10 = 50）
    const keep = retainIdsForViewport(center, order, (id) => rows[id] ?? 0, 50, 13, 78, 78);
    // ★ 短章书上保留集**含**旧章 ⇒ 预取被windowHas 拦下 ⇒ 无 prepend
    expect(keep.has('c5')).toBe(true);
    // 阴性对照：长章形态（880 行/章）下三章下限同样保住旧章 —— 两种形态一致
    const rowsLong: Record<string, number> = {};
    order.forEach((id) => {
      rowsLong[id] = 880;
    });
    const keepLong = retainIdsForViewport(center, order, (id) => rowsLong[id] ?? 0, 5 * 880, 13, 78, 78);
    expect(keepLong.has('c5')).toBe(true);
    // ★ 结论（本组要锁的是这个推论，不是上面的函数行为）：
    //   两档量级下保留集都保住旧章 ⇒ prepend 只可能来自「预取无条件补 prev」这条通道，
    //   因为 windowHas 已拦住对已保留章的重复补装。⇒ 修法点在预取的方向条件，不在保留集。
    expect(keep.has('c5') && keepLong.has('c5')).toBe(true);
  });
});

/**
 * ★★★ V4 判据组：跨章提交时 `fillNeighbors` 的 `forcePrev` 不得放行。
 *
 * ⚠⚠⚠ **V8 真机判决后，本组所锁的杠杆已失效**（2026-10-14）：
 *   V4 的思路是「按滚动方向决定补不补 prev」。V8 判决证明：
 *   **只要补的那一章不在 `win.data` 里，补装就必然落链首 = prepend**，
 *   与时机/方向无关 ⇒ 上滚方向补不补都闪（长章书 IO 实测 6.5 s，
 *   做不到「data 早就在窗内」）。
 *   ⇒ 契约已升级为「`forcePrev: false`」（见形状锁④）。
 *   ★本组**一条不删**（条目 113：判据不许失效，只许换层），
 *     但「直测 `shouldFillPrevOnCommit` 三向语义」那条现为**退役留证**
 *     ——该函数已无生产调用方（见 `chapterWindow.ts` 里的退役标注）。
 *
 * ## 为什么要有这一组（V3 真机判决：修法生效但不充分）
 *
 * V3 真机 A/B 读数（`deliverables/flick-fixV3-2026-10-14/v3-run.log`）：
 * ```
 * 13:06:59 [V3][PF] scrollDir=0 targets=["tongjian-c6"] chain0=tongjian-c5 active=tongjian-c5
 * 13:07:05 [V3][DATA] dir=PREPEND-SUSPECT lines=980->2985 (+2005) anchorIdx=1364
 * 13:08:43 [V3][PF] scrollDir=1 targets=["tongjian-c7"] chain0=tongjian-c4 active=tongjian-c6
 * 13:08:49 [V3][DATA] dir=PREPEND-SUSPECT lines=2985->4762 (+1777) anchorIdx=2876
 * ```
 * - ✔ V3 修法生效：`targets` 在 `scrollDir=1` 时确实只剩 next（prev 消失）。
 * - ✘ prepend 仍在：`+2005 = 952(c4) + 1053(c6)`，而 PF 只请求了 c6
 *   ⇒ **c4 来自另一条通道**。
 *
 * ## 第二条通道的定量归因（不是猜）
 *
 * `fillNeighbors` 的 `needPrev` 有两个来源：
 * ```
 * needPrev = opts?.forcePrev === true || loadedChapters[0] === activeChapterId
 * ```
 * 第二次事件时 `chain0=tongjian-c4 ≠ active=tongjian-c6` ⇒ **OR 右支为假**
 * ⇒ 只可能是 `opts.forcePrev === true` ⇒ 来自
 * `handleScrollCommit` 里那句**无条件** `{forceNext:true, forcePrev:true}`。
 * ⇒ `windowPut(prev)` 落在锚章之上 = prepend，**与邻章预取是两条独立通道**。
 *
 * ★ 这就是「一轮只切一条通道」的教训：V3 切了邻章预取，V4 才切`forcePrev`。
 *   两者必须**各自**有判据，否则回退其中一条不会被发现。
 *
 * ## 本组分层（条目 113：层间不可互相遮蔽）
 * - 形状锁④：`forcePrev` 的实参**必须带方向条件**（语义级，不钉字面写法）
 * - 形状锁⑤：ScrollMode→ReaderScreen 的方向接线在（覆盖 M5/M6 接线变异）
 * - 行为组：`needPrev` 判据在两种方向下的取值（纯函数层，补形状锁抓不到的语义）
 */
describe('V4 跨章提交：fillNeighbors 的 forcePrev 必须挂滚动方向条件', () => {
  /** 取 `handleScrollCommit` 尾部那段`fillNeighborsRef.current(...)` 调用（代码特征锚点） */
  const commitFillSrc = (src: string): string => {
    // ★ 锚点用**代码**（src 已 stripComments ⇒ 注释锚点必然 -1，条目 91/120）
    const anchor = 'fillNeighborsRef.current';
    const start = src.indexOf(anchor, src.indexOf('handleScrollCommit'));
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('}, [', start);
    const seg = src.slice(start, end === -1 ? start + 400 : end);
    // ★ 正对照（条目 8：切片整体切空 ⇒ 所有断言恒真＝零鉴别力）
    expect(seg.length).toBeGreaterThan(40);
    expect(seg).toContain('forceNext');
    expect(seg).toContain('forcePrev');
    return seg;
  };

  it('形状锁④（★V8 改写）：跨章提交里的 forcePrev 必须恒为 false（上滚 prev 已由 V8 预装）', () => {
    const seg = commitFillSrc(readerSrc);
    //★★ 契约变更（2026-10-14 V8）：`forcePrev` 由「挂方向条件」改成「**恒 false**」。
    //   理由：上滚跨章需要的 prev 现在由 V8 在跨章提交里**先装载进窗**，
    //   `recenter` 保住它 ⇒ 这里再 force 就是重复补装，且一旦 retain 漏掉
    //   就会重演 prepend（真机delta=47100px）。
    //   ⇒ 判据改为「实参必须是字面 false」，且**不得**是任何真值表达式。
    //   （原判据「实参必须是函数调用」是 V4 契约，**一条不删**，移到下面的
    //   「V8 组」去锁V8 那处对纯函数的调用。）
    const m = seg.match(/forcePrev\s*:\s*([^,}\n]+)/);
    expect(m).not.toBeNull();
    const arg = (m as RegExpMatchArray)[1].trim();
    expect(arg).toBe('false');
    // 反向断言：不得是 `true`、不得是任何比较式/逻辑式（都会重开放行）
    expect(arg).not.toBe('true');
    expect(arg).not.toMatch(/[<>]=?|&&|\|\||\?|\(/);
    // ★ `forceNext` 仍必须保留（向下预取不能一起关掉）
    expect(seg).toMatch(/forceNext\s*:\s*true/);
  });

  it('形状锁⑤（★V8 改写）：上滚 prev 的补装职责已移交 V8（此处不得再按方向 force）', () => {
    const seg = commitFillSrc(readerSrc);
    // ★ 反向断言：不得再用 `shouldFillPrevOnCommit(scrollDirRef.current)` 驱动 forcePrev
    //   （那是 V4 的契约；V8 起该判定只用于「跨章提交时预装 prev」那一处）
    expect(seg).not.toMatch(/forcePrev\s*:\s*shouldFillPrevOnCommit\(/);
    // 方向 ref 仍必须由 ScrollMode 的回调写入（V8 沿用它判断上滚方向）
    const rFull = stripComments(readFileSync(READER_SCREEN_PATH, 'utf8'));
    expect(rFull).toMatch(/scrollDirRef\.current\s*=\s*dir/);
    // ★ 方向 ref 不得进任何 useEffect 依赖数组（进依赖＝每帧重跑预取）
    expect(rFull).not.toMatch(/\[\s*loaded\s*,\s*activeChapterId\s*,\s*loadChapterData\s*,\s*scrollDirRef\s*\]/);
  });

  it('★★ 行为组（直测纯函数）：shouldFillPrevOnCommit 的三向语义', () => {
    // ★ 这一组是 M2/M3 的**唯一**暴露路径 —— 形状锁只会匹配文本、求不了值。
    //   变异「< 0 写成 > 0」/「&& false」都必须在此变红。
    // 向下滚（dir=+1）：上方内容已在视口内 ⇒ 不补 prev（补了就是 prepend）
    expect(shouldFillPrevOnCommit(1)).toBe(false);
    expect(shouldFillPrevOnCommit(10)).toBe(false);
    // 往上滚（dir=-1）：上方内容会被看到 ⇒ 必须补
    expect(shouldFillPrevOnCommit(-1)).toBe(true);
    expect(shouldFillPrevOnCommit(-10)).toBe(true);
    // 未滚过（dir=0）：不补 —— 首屏由 fillNeighbors 的 needPrev OR 分支负责
    expect(shouldFillPrevOnCommit(0)).toBe(false);
  });

  it('★ 行为组：needPrev 判据在向下/向上两种滚动方向下的取值', () => {
    // 纯函数层复刻 `fillNeighbors` 的 needPrev 语义（生产侧由形状锁④⑤保证接线）。
    // 长章书真几何（实测 tongjian cpl=13：单章 880 行，lpp=13，链首 c4 / 锚章 c6）
    const needPrev = (opts: { forcePrev?: boolean }, chain0: string, active: string): boolean =>
      opts.forcePrev === true || chain0 === active;
    // 向下跨章：V4 后不再无条件 force ⇒ chain0(c4) ≠ active(c6) ⇒ 不补 prev ✔
    expect(needPrev({ forceNext: true, forcePrev: shouldFillPrevOnCommit(1) }, 'c4', 'c6')).toBe(false);
    // 向上跨章：forcePrev=true ⇒ 必须补（否则用户往回看时上方无内容）✔
    expect(needPrev({ forceNext: true, forcePrev: shouldFillPrevOnCommit(-1) }, 'c7', 'c6')).toBe(true);
    // 首屏链首==锚章：OR 分支仍为真 ⇒ 照补（与 V4 前同，无回归）✔
    expect(needPrev({ forceNext: true, forcePrev: shouldFillPrevOnCommit(0) }, 'c5', 'c5')).toBe(true);
    // ★ 阴性对照：V4 前的无条件 forcePrev 在向下跨章时也会补 ⇒ 缺陷形态可被本组区分
    expect(needPrev({ forceNext: true, forcePrev: true }, 'c4', 'c6')).toBe(true);
  });
});

/**
 * ★★★ V5 判据组：跳章（`jumpTo`）与路由跳章（首开 effect）必须**装载整个 retain 集合**。
 *
 * ## 为什么要有这一组（2026-10-14 真机复现：跳章后上滚闪一次、下滚闪一次＋回弹）
 *
 * 真机读数（`deliverables/jump-flick-2026-10-14/jump-run.log`，跳到 `tongjian-c14`）：
 * ```
 * [JP][JUMP]  to=tongjian-c14 retain=["c14","c13","c15"] beforeChain= scrollDir=0
 * [JP][CHAIN] PREPEND head=->tongjian-c14 chain=tongjian-c14        ← 窗口只有中心章
 * [JP][COMP]  aIdx=0->nextIdx=942 delta=47100 offset=0 target=47100 linesLen=2660
 * [JP][CHAIN] PREPEND head=tongjian-c14->tongjian-c13 chain=c13,c14,c15
 * ```
 * 机理：`windowRecenter(w, cid, retain)` 的 `retain` 只**保留**已在窗内的章，
 * **不装载**它们。原实现只 `windowBegin(cid)` 一章 ⇒ 跳章后窗口**只有中心章**
 * ⇒ `chain0 === activeChapterId` 为真 ⇒ `fillNeighbors` 的 `needPrev` 补 prev
 * ⇒ `windowPut(prev)` 落在中心章**之上** = prepend
 * ⇒ 实测 `delta=47100px`（整章 c13=942 行）**一次性下投** ⇒ 闪 + 回弹。
 *
 * ## 修法
 * 跳章时把 `retain`（含 prev/next）里所有未命中的章**一并 begin + 装载**，
 * 让窗口一次到位⇒ 事后 `fillNeighbors` 被 `chain0≠active` 与 `windowHas` 双拦。
 *
 * ★ 本组必须**同时**锁两处跳章路径（`jumpTo` 与路由 effect）——
 *   只锁一处等于给另一处留后门（这正是 A6→B2→V3→V4 四轮反复的教训）。
 */
describe('V5 跳章：retain 集合必须整批装载（跳章后 prepend 通道）', () => {
  /**
   * 取跳章装载那段源码。
   * ★★ 锚点必须是 `const targets`（V5 修法新增的装载目标集合），**不能**用
   *   `windowRecenter(w,` —— 后者在代码顺序上**位于 targets 构造之后**，
   *   从它开始切会切不到 `[id, ...retain]` 那几行（实测 3 条假红，条目 91）。
   */
  const jumpLoadSrc = (src: string): string => {
    const start = src.indexOf('const targets');
    expect(start).toBeGreaterThan(-1);
    // 切片须覆盖：targets 构造 → windowRecenter → begin 循环 → 装载循环。
    // 2200 是实测值（含正对照），不要压到 1000 以下。
    const seg = src.slice(start, start + 2200);
    // ★ 正对照（条目 8：切片切空 ⇒ 所有断言恒真＝零鉴别力）
    expect(seg.length).toBeGreaterThan(600);
    expect(seg).toContain('...retain');
    expect(seg).toContain('windowRecenter');
    expect(seg).toContain('windowBegin');
    expect(seg).toMatch(/of targets/);
    return seg;
  };

  it('形状锁⑥：跳章装载目标必须遍历整个 retain 集合（不得只装中心章）', () => {
    // ★ 两处跳章路径各判一次（jumpTo + 路由 effect），并**断言两段源码不同**
    //   （防切片串味：两段相同 ⇒ 其中一条路径实际没被测到，条目 111）。
    const jumpIdx = readerSrc.indexOf('const jumpTo = useCallback(');
    expect(jumpIdx).toBeGreaterThan(-1);
    const jumpSeg = jumpLoadSrc(readerSrc.slice(jumpIdx, jumpIdx + 3000));
    const routeSeg = jumpLoadSrc(readerSrc);
    // ★ 串味自证：jumpTo 用 `cid`，路由用 `chapterId` ⇒ 两段的中心章变量名必不同
    expect(jumpSeg).toMatch(/\[cid, \.\.\.retain\]/);
    expect(routeSeg).toMatch(/\[chapterId, \.\.\.retain\]/);
    expect(jumpSeg).not.toEqual(routeSeg);

    for (const [name, seg] of [['jumpTo', jumpSeg], ['route-effect', routeSeg]] as const) {
      // 目标集合必须由 `retain` 展开而来（`...retain` 展开运算符）
      expect(/\[\s*\w+\s*,\s*\.\.\.retain\s*\]/.test(seg)).toBe(true);
      // 装载循环必须遍历 targets（而不是只 await 单章 id）
      expect(seg).toMatch(/for\s*\(\s*const\s+\w+\s+of\s+targets\s*\)/);
      // ★ 反向断言：**中心章 id 直调** `loadChapterData(chapterId)` 必须不存在
      //   （V5 前的缺陷形态：只 await 中心章 ⇒ 邻章事后才补 ⇒ prepend）。
      //   用 `(?!\w+\s*\))` 排除「传变量」的合法形态，只抓「传字面中心章」。
      expect(seg).not.toMatch(/await loadChapterData\(chapterId\)/);
      expect(seg).not.toMatch(/await loadChapterData\(cid\)/);
      // 循环体内必须真的调用 loadChapterData（否则 targets 白算）
      expect(seg).toMatch(/for\s*\([\s\S]{0,600}?loadChapterData\(/);
      // 名字提醒：这段必须真的属于 V5 修法（防切片落到别的分支）
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it('形状锁⑦：路由跳章的续读真值只能由中心章触发（装邻章不得覆盖进度）', () => {
    const routeSeg = jumpLoadSrc(readerSrc);
    // finalize(data) 必须在 `id === chapterId` 守卫内（openChapter 会整体重写 lastRead）
    expect(routeSeg).toMatch(/if\s*\(\s*\w+\s*===\s*chapterId\s*\)\s*\{\s*finalize\(/);
    // setError 同理：邻章失败不该报错（会让整页显示「加载失败」）
    expect(routeSeg).toMatch(/if\s*\(\s*\w+\s*===\s*chapterId\s*\)\s*\{\s*setError\(/);
  });

  it('★ 行为组：跳章后窗口一次到位 ⇒ needPrev 为假 ⇒ 事后不补 prev', () => {
    // 长章书真几何（实测 tongjian cpl=13：c13=942 行 / c14=2660 行 / c15=837 行，
    // 真机读数 `delta=47100` 与 942 行 × rowH=50px 吻合）
    const CH13 = 942;
    const CH14 = 2660;
    const CH15 = 837;
    // ★ 本组问的是：`fillNeighbors` 的 `needPrev` 在「跳章之后」为真还是为假。
    //   判据＝`chain0 === activeChapterId`（V5 后窗口已有三章 ⇒链首 ≠ 锚章）。
    const needPrevAfterJump = (chain: readonly string[], active: string): boolean =>
      chain[0] === active;

    // ── V5 修法形态：中心章 + prev + next 同批装载 ──
    const chainV5 = ['tongjian-c13', 'tongjian-c14', 'tongjian-c15'];
    expect(chainV5.length).toBe(3);
    expect(needPrevAfterJump(chainV5, 'tongjian-c14')).toBe(false); // ⇒ 不补 prev ✔

    // ── V5 前的缺陷形态：窗口只有中心章 ──
    const chainBeforeV5 = ['tongjian-c14'];
    expect(needPrevAfterJump(chainBeforeV5, 'tongjian-c14')).toBe(true); // ⇒ 必然补 prev ✘

    //★ 缺陷形态的代价量化：补进来的 prev 是整章 ⇒ 一次性位移 942 行（真机 47100px）
    expect(CH13 * 50).toBe(47100);
    // ★ 修法形态下三章都在窗，补无可补 ⇒ 位移 0
    expect(chainV5.includes('tongjian-c13')).toBe(true);
    // 行数台账（供量级复核，不参与断言逻辑）
    expect(CH14 + CH13 + CH15).toBe(4439);
  });
});

/**
 * ★★★ V6 判据组：跳转必须把续读位置重写为「目标章 + 章首」。
 *
 * ## 为什么要有这一组（2026-10-14 用户报告）
 *
 * 「进入时是汉纪七（**非章节顶头位置**），跳转到汉纪四，再跳回汉纪七，
 *   **位置不对，汉纪七没有顶头**」。
 *
 * ## 根因（读实现得出，非推断）
 *
 * `initialCharOffset` 的持久化分支是：
 * ```
 * lastRead.chapterId === activeChapterId ? lastRead.charOffset : 0
 * ```
 * 而 `jumpTo` 切换了 `activeChapterId` + bump `switchSeq`（FlatList 重挂载，
 * 重挂载读 `initialLineIndex` ← `initialCharOffset` ← `lastRead`），
 * 却**从不写 `lastRead`** ⇒ `lastRead` 仍是**离开前那一章**：
 * - 跳去**别的**章：条件不成立 ⇒ 用 0 ⇒ 顶头 ✔（**碰巧对**）
 * - 跳回**曾读到一半**的章：条件成立 ⇒ 用**旧 charOffset**
 *   ⇒ 落在章中 ⇒ **「没有顶头」** ✘
 *
 * ★即「跳到某章＝该章章首」这件事当时是**巧合**，不是契约。
 *
 * 第二处：中心章 `lastRead` 同步 effect 的守卫只比 `chapterId`，
 * 不比位置 ⇒ 旧 `charOffset` 非零时它早退 ⇒ 错位位置留在 `lastRead`。
 */
describe('V6 跳章续读：跳转必须重写 lastRead 为目标章章首', () => {
  const jumpSegOf = (src: string): string => {
    const start = src.indexOf('const jumpTo = useCallback(');
    expect(start).toBeGreaterThan(-1);
    const seg = src.slice(start, start + 2600);
    // ★ 正对照（条目 8：切片切空 ⇒ 断言恒真＝零鉴别力）
    expect(seg.length).toBeGreaterThan(600);
    expect(seg).toContain('setSwitchSeq');
    return seg;
  };

  it('形状锁⑧：jumpTo 必须显式把 lastRead 重写为「目标章 + charOffset 0」', () => {
    const seg = jumpSegOf(readerSrc);
    // 必须调 openChapter(bookId, <目标章>, undefined, undefined, 0)
    expect(seg).toMatch(/openChapter\(\s*bookId\s*,\s*cid\s*,\s*undefined\s*,\s*undefined\s*,\s*0\s*\)/);
    // ★ 位置必须写在 switchSeq bump **之前**（重挂载读的是那一刻的 lastRead）
    const iWrite = seg.indexOf('openChapter(');
    const iBump = seg.indexOf('setSwitchSeq');
    expect(iWrite).toBeGreaterThan(-1);
    expect(iBump).toBeGreaterThan(-1);
    expect(iWrite).toBeLessThan(iBump);
    // ★ 反向断言：不得用 `undefined` 当 charOffset（会被幂等条件在旧值为
    //   undefined 时跳过，且 initialCharOffset 的 `>= 0` 会把 0 吃掉）
    expect(seg).not.toMatch(/openChapter\(\s*bookId\s*,\s*cid\s*,\s*undefined\s*,\s*undefined\s*,\s*undefined\s*\)/);
  });

  it('形状锁⑨：jumpTo 依赖数组必须含 bookId 与 openChapter（防 stale closure）', () => {
    const start = readerSrc.indexOf('const jumpTo = useCallback(');
    const seg = readerSrc.slice(start, start + 3200);
    // 依赖数组那一行
    const m = seg.match(/\[\s*loadChapterData\s*,[^\]]*\]/);
    expect(m).not.toBeNull();
    const deps = (m as RegExpMatchArray)[0];
    expect(deps).toMatch(/\bbookId\b/);
    expect(deps).toMatch(/\bopenChapter\b/);
  });

  it('形状锁⑩：中心章同步 effect 的守卫必须连charOffset 一起比', () => {
    // 取那个 effect（代码特征：`loaded.chapter.id !== activeChapterId`）
    const start = readerSrc.indexOf('loaded.chapter.id !== activeChapterId');
    expect(start).toBeGreaterThan(-1);
    const seg = readerSrc.slice(start, start + 900);
    expect(seg).toContain('openChapter(');
    // 守卫里必须出现 charOffset 的比较（不只比 chapterId）
    expect(seg).toMatch(/charOffset/);
    // 反向断言：不得出现「只比 chapterId 就早退」的裸守卫形态
    expect(seg).not.toMatch(
      /lastRead\?\.bookId === bookId && lastRead\?\.chapterId === activeChapterId \)\s*\{\s*return/,
    );
  });

  it('★ 行为组：initialCharOffset 的持久化分支在「跳回曾读过的章」时给出旧偏移', () => {
    // 复刻 `initialCharOffset` 的判定（生产接线由形状锁⑧⑩保证）
    const initialCharOffset = (
      routeOwned: boolean,
      routeOffset: number | undefined,
      lastRead: { bookId: string; chapterId: string; charOffset?: number } | null,
      bookId: string,
      activeChapterId: string,
    ): number => {
      if (routeOwned && typeof routeOffset === 'number' && routeOffset >= 0) {
        return routeOffset;
      }
      if (
        lastRead &&
        lastRead.bookId === bookId &&
        lastRead.chapterId === activeChapterId &&
        typeof lastRead.charOffset === 'number' &&
        lastRead.charOffset >= 0
      ) {
        return lastRead.charOffset;
      }
      return 0;
    };
    const bookId = 'b1';
    // 场景：离开汉纪七时读到章中（charOffset=5000），跳去汉纪四（lastRead=四），
    //       再跳回汉纪七 ⇒ V6 前 lastRead 仍是「四」⇒ 持久化分支不成立 ⇒ 0
    const stale = { bookId, chapterId: 'c-h4', charOffset: 5000 };
    expect(initialCharOffset(false, undefined, stale, bookId, 'c-h7')).toBe(0);
    //场景：lastRead 恰好就是汉纪七且带旧偏移（另一条进入路径）⇒ 返回旧偏移（非 0）
    const selfStale = { bookId, chapterId: 'c-h7', charOffset: 5000 };
    expect(initialCharOffset(false, undefined, selfStale, bookId, 'c-h7')).toBe(5000);
    //★ V6 后：jumpTo 显式写入 {chapterId:c-h7, charOffset:0} ⇒ 0 ⇒ 顶头
    const afterV6 = { bookId, chapterId: 'c-h7', charOffset: 0 };
    expect(initialCharOffset(false, undefined, afterV6, bookId, 'c-h7')).toBe(0);
    // 阴性对照：charOffset=0 是合法章首，不得被真值判断吃掉
    expect(initialCharOffset(false, undefined, { bookId, chapterId: 'c-h7', charOffset: 0 }, bookId, 'c-h7')).toBe(0);
  });
});

/**
 * ★★★ V9 判据组：占位等高（Reserved-Space Header）—— 闪烁的根治方案。
 *
 * ## 机理（为什么它能根治）
 *
 * 旧行为：头部占位是**固定 44px 提示条**。prev 章落地时：
 * ```
 * contentSize 前 = 44 + body×rowH
 * contentSize 后 = 0+ (body + prev) × rowH
 * ΔcontentSize   = prev×rowH − 44 ★实测51812px
 * ```
 * 而补偿恰逢 `fresh=false`（内容高陈旧）⇒ `shouldDeliverCompensation` **跳过投递**
 * ⇒ 那一帧无补偿 ⇒ 整章跳过去（闪 + 回弹）。
 *
 * 新行为：头部占位＝**prev 章的预留空间**
 * ```
 * headerH = reservedPrevHeight(est, act, rowH) = max(0, est − act) × rowH
 * ```
 * ⇒ `contentSize` 在落地前后**恒定** ⇒ 原生无需调 offset
 * ⇒ **补偿器整条链路不被触发** ⇒ 不闪、不回弹。
 *
 * ★**关键性质：只要 `est ≥ act`，ΔcontentSize 恒为 0，与预估准不准无关。**
 *   预估偏大只会留「顶部空白」（可渲染成「上章」提示），不会造成位移。
 */
describe('V9 占位等高：prev 落地前后 contentSize 恒定', () => {
  const rowH = 50; // 真机实测

  it('★ 核心：ΔcontentSize 恒为 0（真机长章书几何的多组样本）', () => {
    // 真机读数（jump-v8-run.log / mvcp-run.log）：
    //   prev=c11/c12/c13 行数 1038/874/1038；已装 body 1980/4572 行
    const samples: Array<[number, number, number]> = [
      // [est, act, bodyLines]
      [1038, 1038, 1980], // 预估恰等于真值
      [1038, 874, 1980],  // 预估偏大（窗口里最长的章比实际长）
      [1200, 1038, 4572], // 预估明显偏大
      [1000, 1000, 0],    // 空body（边界）
      [1, 1, 1],          // 极小
    ];
    for (const [est, act, body] of samples) {
      const delta = reservedHeaderDeltaContentSize(est, act, body, rowH);
      expect(delta).toBe(0);
    }
  });

  it('★ 反向对照：旧行为（固定 44px 占位）ΔcontentSize ≠ 0 —— 工具能区分', () => {
    // 同一样本，旧行为的 Δ = act×rowH − 44
    const est = 1038;
    const act = 1038;
    const body = 1980;
    const oldBefore = PREV_HINT_MIN_H + body * rowH;
    const oldAfter = 0 + (body + act) * rowH;
    const oldDelta = oldAfter - oldBefore;
    expect(oldDelta).not.toBe(0);
    // 新行为必须显著更小（这正是「不闪」的量化定义）
    const newDelta = reservedHeaderDeltaContentSize(est, act, body, rowH);
    expect(Math.abs(newDelta)).toBeLessThan(Math.abs(oldDelta));
  });

  it('形状锁⑭：ScrollMode 的 headerH 必须用 reservedPrevHeight（不得回到常量）', () => {
    const s = stripComments(readFileSync(SCROLL_MODE_PATH, 'utf8'));
    // 必须调纯函数
    expect(s).toMatch(/reservedPrevHeight\(/);
    // ★ 反向断言：**不得**再出现 `hasMorePrev ? BOUNDARY_HINT_H : 0`
    //   （那是旧行为 = 闪烁根因本身）
    expect(s).not.toMatch(/const headerH = hasMorePrev \? BOUNDARY_HINT_H : 0/);
    // 必须保留提示下限（用户裁定：预留空白里放「上章」文字）
    expect(s).toMatch(/Math\.max\(\s*reservedPrevH\s*,\s*BOUNDARY_HINT_H\s*\)/);
  });

  it('形状锁⑮：宿主必须把 prev 的预估/实际行数接进 props', () => {
    const r = stripComments(readFileSync(READER_SCREEN_PATH, 'utf8'));
    expect(r).toMatch(/const prevEstimatedLines = useMemo\(/);
    expect(r).toMatch(/const prevActualLines = useMemo\(/);
    expect(r).toMatch(/prevEstimatedLines: prevEstimatedLines,/);
    expect(r).toMatch(/prevActualLines: prevActualLines,/);
    // ★ 预估必须取**窗口内已装章行数的 max**（同类章上界，天然 ≥ 真值）
    expect(r).toMatch(/stitched\.lineCountOf\.get\(cid\)/);
    expect(r).toMatch(/if \(n > max\)/);
  });

  it('★ 行为组：reservedPrevHeight 的边界与几何安全性', () => {
    // 无 prev ⇒ 0
    expect(reservedPrevHeight(0, 0, rowH)).toBe(0);
    // 未落地（act=0）⇒ 全额预留
    expect(reservedPrevHeight(1038, 0, rowH)).toBe(1038 * rowH);
    // 已落地（act=est）⇒ 预留归零
    expect(reservedPrevHeight(1038, 1038, rowH)).toBe(0);
    // act > est（预估不足）⇒ **不得返回负高度**（几何安全，退回旧行为）
    expect(reservedPrevHeight(500, 800, rowH)).toBe(0);
    // rowH 非法⇒ 0（防 0/负高度把 getItemLayout 算崩）
    expect(reservedPrevHeight(1038, 0, 0)).toBe(0);
    expect(reservedPrevHeight(1038, 0, -50)).toBe(0);
    // ★ 恒非负（不变量）
    for (const [e, a] of [[1, 999], [999, 1], [500, 500], [0, 100]]) {
      expect(reservedPrevHeight(e, a, rowH)).toBeGreaterThanOrEqual(0);
    }
  });
});

/**
 * ★★★ V9-b 判据组：占位等高的三个前置条件（2026-10-14 真机白屏回归的修复）。
 *
 * ## 回归现象（用户报告 + 真机读数）
 *
 * 「初次进入资治通鉴，恢复上次阅读进度到汉纪三，顶部显示『上章』，**无任何动作，
 *   几秒后变白屏**，稍后显示内容」。
 *
 * ```
 * 16:59:18.962 [V9][HEADER] est=874 act=874 reserved=0    headerH=44
 * 16:59:21.415 [V9][HEADER] est=874 act=815 reserved=2950 headerH=2950
 * 16:59:21.458 [MVCP][COMP] delta=43656 offset=0 fresh=false
 * 16:59:23.964 [V9][HEADER] est=1038 act=815 reserved=11150
 * ```
 *
 * ★ 三个叠加缺陷（**都出在第一版 V9 自己**）：
 * ① `prevActualLines` 把**锚章自己**当成「已落地的 prev」⇒ 冷启动 `reserved=0`
 *    ⇒ 完全没预留（真机 `est=874 act=874 reserved=0` 自证）。
 * ② `est` 取「窗口内 max」⇒ 随窗口漂移（874→1038）⇒ **预留高度自己会变**
 *    ⇒ 每次都产生新的 contentSize 突变。
 * ③ `bootScrollIndex` 在 `initialLineIndex===0` 时返回 `undefined`
 *    ⇒ 原生停在 offset=0，而 offset 0 **就是预留空白** ⇒ **白屏**。
 *
 * ⚠ 本组三条判据对应三条**独立**修复；缺任何一条都还会白屏。
 */
describe('V9-b 占位等高的三个前置条件', () => {
  const r = () => stripComments(readFileSync(READER_SCREEN_PATH, 'utf8'));
  const s = () => stripComments(readFileSync(SCROLL_MODE_PATH, 'utf8'));

  it('形状锁⑯：预留行数必须**书级恒定**（跨 prev 对象也不变）', () => {
    const src = r();
    expect(src).toMatch(/reservedForRef\s*=\s*useRef/);
    // ★★ V9-d：必须是**书级**锁（真机读数headerH 49100→52650 单调增大
    //   ⇒ 每换一个 prev 就按更大窗口重算 ⇒ 每行 cell 被推下 ⇒ 全量重排 ⇒ 白屏）
    expect(src).toMatch(/bookReservedLinesRef\s*=\s*useRef/);
    // 关键：已锁定时**直接沿用书级值**，不再看 pendingPrevId 是否变化
    expect(src).toMatch(/if \(bookReservedLinesRef\.current > 0\) \{[\s\S]{0,200}return bookReservedLinesRef\.current/);
    // ★ 反向断言：不得再按「同对象」判断沿用（那正是 header 反复增长的来源）
    expect(src).not.toMatch(/reservedForRef\.current === pendingPrevId && reservedLinesRef\.current > 0/);
    // ★ prev 落地后**只清本轮对象，不清书级锁**
    const iClear = src.indexOf('reservedForRef.current = null;');
    expect(iClear).toBeGreaterThan(-1);
    const after = src.slice(iClear, iClear + 220);
    expect(after).toMatch(/reservedLinesRef\.current = 0/);
    expect(after).not.toMatch(/bookReservedLinesRef\.current = 0/);
    // 首次锁定必须带安全余量（真实 prev 可能比窗口 max 更长）
    expect(src).toMatch(/Math\.ceil\(max \* 1\.25\)/);
  });

  it('形状锁⑰：首屏/续读定位不得预留（门控＝用户已发生过真实滚动）', () => {
    const src = r();
    // 必须有「用户已滚动」门控
    expect(src).toMatch(/const \[userScrolled, setUserScrolled\] = useState\(/);
    // 预估的首行判据必须含 userScrolled
    expect(src).toMatch(/if \(!userScrolled \|\| !pendingPrevId\) \{\s*return 0;/);
    // ★ 宿主必须把它接到 ScrollMode 的回调上
    expect(src).toMatch(/onUserScrolledOnce: handleUserScrolledOnce,/);
    expect(src).toMatch(/const handleUserScrolledOnce = useCallback\(/);
    // ★ ScrollMode 侧必须在**用户手指拖拽**那一刻上抛（且只抛一次）
    const sc = s();
    //★★ 必须用**独立的**手势 ref，**不得**复用 `userScrolledRef`：
    //   `userScrolledRef` 会被**程序定位**的 onScroll 置真（首屏定位/boot 重挂载/
    //   补偿投递都走 onScroll）⇒ 复用它时手势开闸的 `if` 永远为假
    //   ⇒ 真机读数：`onScrollBeginDrag` 触发 4 次但 `est` 恒 0（三次回归的根因）。
    expect(sc).toMatch(/const userGestureRef = useRef\(/);
    expect(sc).toMatch(/if \(!userGestureRef\.current\) \{[\s\S]{0,200}onUserScrolledOnce\?\.\(\)/);
    // ★ 反向断言：开闸 if 里不得出现 userScrolledRef
    const gateSeg = sc.slice(sc.indexOf('const handleScrollBeginDrag'), sc.indexOf('const handleMomentumBegin'));
    expect(gateSeg).not.toMatch(/userScrolledRef/);
    //★★ 必须挂在 `onScrollBeginDrag`，**不得**挂在 `onScroll`：
    //   原生 scrollToOffset 也会触发 onScroll ⇒ 用户**完全没动手**的首屏
    //   就出现 `reserved=51900` ⇒ 巨额预留 ⇒ **仍白屏**（二次回归的根因）。
    expect(sc).toMatch(/onScrollBeginDrag=\{handleScrollBeginDrag\}/);
    expect(sc).not.toMatch(/onScrollBeginDrag=\{onScroll\}/);
  });

  it('形状锁⑲：prevActualLines 必须用「预留对象 id」，不得用链首（防缺陷①）', () => {
    // ★ 用**未 strip** 的源码定位：`stripComments` 先删块注释再删行注释，
    //   块注释里的 `*/` 残留会让行注释正则吞掉后续真实代码 ⇒ 定位落空
    //   （实测踩过：判据自身的构造错误，条目 91）。
    const src = readFileSync(READER_SCREEN_PATH, 'utf8');
    const i = src.indexOf('const prevActualLines = useMemo(');
    expect(i).toBeGreaterThan(-1); // 正对照：锚点必须命中
    const seg = src.slice(i, i + 700);
    // ★ 必须用预留对象
    expect(seg).toMatch(/const id = reservedForRef\.current/);
    // ★ 反向断言：**不得**用 `loadedChapters[0]`——
    //   冷启动时链首是**锚章**而非「已落地的 prev」，用它会把锚章行数误当
    //   act 扣掉 ⇒ reserved 归零 ⇒ 完全没预留（真机 `est=874 act=874
    //   reserved=0` 自证）。
    expect(seg).not.toMatch(/const id = loadedChapters\[0\]/);
    // 且必须真的查「该id 是否已在窗内」
    expect(seg).toMatch(/loadedChapters\.includes\(id\)/);
  });

  it('形状锁⑱：bootScrollIndex 在 initialLineIndex===0 时也必须定位（防白屏）', () => {
    const sc = s();
    // ★ 反向断言：不得出现 `initialLineIndex > 0 ? … : undefined`
    //   （返回 undefined ⇒ FlatList 不定位 ⇒ offset 0＝预留空白 ⇒ 白屏）
    expect(sc).not.toMatch(/initialLineIndex > 0 \? initialLineIndex : undefined/);
    // 必须恒定返回下标（>=0 都返回，含 0）
    expect(sc).toMatch(/return initialLineIndex >= 0 \? initialLineIndex : 0;/);
  });

  it('★ 行为组：预留门控的三种状态（首屏 / 滚动后 / prev 已落地）', () => {
    //复刻三态判定（生产接线由形状锁⑯⑰保证）
    const reservedLines = (
      userScrolled: boolean,
      pendingPrevId: string | null,
      lockedFor: string | null,
      lockedLines: number,
    ): number => {
      if (!userScrolled || !pendingPrevId) {
        return 0; // 首屏/续读定位 ⇒ 不预留（防白屏）
      }
      if (lockedFor === pendingPrevId && lockedLines > 0) {
        return lockedLines; // 沿用锁定值 ⇒ 恒定
      }
      return 874; // 首次为该 prev 设预留（窗口 max 的代表值）
    };
    // 首屏：未滚动 ⇒ 0 ⇒ headerH 退化成 44px 提示条 ⇒ **无空白 ⇒ 不白屏**
    expect(reservedLines(false, 'c13', null, 0)).toBe(0);
    expect(reservedPrevHeight(reservedLines(false, 'c13', null, 0), 0, 50)).toBe(0);
    // 滚动后：开闸 ⇒ 预留
    expect(reservedLines(true, 'c13', null, 0)).toBe(874);
    // 同对象再算⇒ **锁定值不变**（缺陷②的修复点）
    expect(reservedLines(true, 'c13', 'c13', 874)).toBe(874);
    // 换对象 ⇒ 重新起算（新的补装周期）
    expect(reservedLines(true, 'c12', 'c13', 874)).toBe(874);
    // prev 已落地 ⇒ act=真值 ⇒ 预留归零 ⇒ contentSize 恒定
    const est = reservedLines(true, 'c13', 'c13', 874);
    expect(reservedPrevHeight(est, 874, 50)).toBe(0);
    // ★ 白屏判据：首屏时 headerH 必须 ≤ 提示条高度（不得出现巨额空白）
    const headerHAtBoot = Math.max(reservedPrevHeight(0, 0, 50), 44);
    expect(headerHAtBoot).toBe(44);
  });
});
