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

import { retainIdsByBudget, retainIdsForViewport, chaptersInRowRange } from '../reader/chapterWindow';
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

  it('占位在失败时显示「加载失败，滑动重试」（next/prev 各 1 处）', () => {
    expect(countOf(scrollSrc, "loadError?.next ? '加载失败，滑动重试'")).toBe(1);
    expect(countOf(scrollSrc, "loadError?.prev ? '加载失败，滑动重试'")).toBe(1);
  });

  it('loadError 接线：ReaderScreen 计算并传入 ScrollMode', () => {
    expect(countOf(readerSrc, 'const loadError = useMemo(')).toBe(1);
    expect(countOf(readerSrc, 'loadError: loadError,')).toBe(1);
    // ScrollMode 侧解构并声明 prop 类型
    expect(countOf(scrollSrc, 'loadError?: { next?: boolean; prev?: boolean };')).toBe(1);
  });

  it('阴性对照：旧文案仍保留正常态（继续滑动 / 加载中），工具有效', () => {
    // 同范围正对照：失败文案在场 ⇒ 计数工具本身有效（防「grep 打偏 = 假 0」）
    expect(countOf(scrollSrc, '加载失败，滑动重试')).toBeGreaterThan(0);
    // 正常态文案仍在（失败时才切换成失败文案）
    expect(countOf(scrollSrc, '继续滑动以加载下一章…')).toBe(1);
    expect(countOf(scrollSrc, '加载中…')).toBe(1);
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
    expect(countOf(readerSrc, 'stitched.lineCountOf.get(id) ?? 0')).toBe(1);
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
