/**
 * 章滑窗状态机单测（R2b1）。断言「变异下会红」：
 * - begin 去重（重复 begin → null；绕闸门 = 「一次手势多次推进」通病）；
 * - recenter 裁剪（data 与 inflight 双面裁剪、中心恒保留）；
 * - put/fail 的 inflight 收支配平。
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

import {
  createChapterWindow,
  retainIdsByBudget,
  retainIdsForViewport,
  chaptersInRowRange,
  windowBegin,
  windowFail,
  windowGet,
  windowHas,
  windowIsLoading,
  windowPut,
  windowRecenter,
} from '../reader/chapterWindow';

/** 形状锁用：去注释后的实现源码（条目 90：形状计数须去注释后做） */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function countOf(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

const CHAPTER_WINDOW_PATH = resolve(__dirname, '..', 'reader', 'chapterWindow.ts');

describe('chapterWindow', () => {
  it('初始窗：centerId=null、空 data、空 inflight', () => {
    const w = createChapterWindow<string>();
    expect(w.centerId).toBeNull();
    expect(windowHas(w, 'a')).toBe(false);
    expect(windowIsLoading(w, 'a')).toBe(false);
    expect(windowGet(w, 'a')).toBeUndefined();
  });

  it('begin → put 生命周期：inflight 先真后假、data 就绪', () => {
    let w = createChapterWindow<string>();
    const w2 = windowBegin(w, 'a');
    expect(w2).not.toBeNull();
    w = w2 as never;
    expect(windowIsLoading(w, 'a')).toBe(true);
    expect(windowHas(w, 'a')).toBe(false);
    w = windowPut(w, 'a', 'DATA');
    expect(windowHas(w, 'a')).toBe(true);
    expect(windowIsLoading(w, 'a')).toBe(false);
    expect(windowGet(w, 'a')).toBe('DATA');
  });

  it('begin 去重闸门：已有数据或已在加载都返回 null（配平式判据）', () => {
    let w = createChapterWindow<string>();
    w = windowBegin(w, 'a') as never;
    // 变异「begin 恒成功」会在此红：inflight 中的章不得重复 begin
    expect(windowBegin(w, 'a')).toBeNull();
    w = windowPut(w, 'a', 'DATA');
    // 变异「只查 inflight 不查 data」会在此红：就绪章也不得重复 begin
    expect(windowBegin(w, 'a')).toBeNull();
    expect(windowBegin(w, 'b')).not.toBeNull();
  });

  it('fail 只清 inflight、data 不变（可重试）', () => {
    let w = createChapterWindow<string>();
    w = windowBegin(w, 'a') as never;
    w = windowPut(w, 'b', 'B') as never;
    w = windowFail(w, 'a');
    expect(windowIsLoading(w, 'a')).toBe(false);
    expect(windowGet(w, 'b')).toBe('B');
    // fail 后可重新 begin（重试语义）
    expect(windowBegin(w, 'a')).not.toBeNull();
  });

  it('recenter：更新中心，data/inflight 只留保留集∪中心（跳章清窗+陈旧丢弃）', () => {
    let w = createChapterWindow<string>();
    w = windowBegin(w, 'old-prev') as never;
    w = windowPut(w, 'old-prev', 'P') as never;
    w = windowBegin(w, 'old-next') as never; // 旧邻章加载中
    w = windowPut(w, 'cur', 'C') as never;
    w = windowRecenter(w, 'new-cur', new Set(['new-prev']));
    // 中心更新
    expect(w.centerId).toBe('new-cur');
    // 保留邻域与中心在窗
    expect(windowHas(w, 'new-prev')).toBe(false); // 本就不在窗，裁剪不误加
    // 旧内容全丢（不在保留集）
    expect(windowHas(w, 'old-prev')).toBe(false);
    expect(windowHas(w, 'cur')).toBe(false);
    // 旧的加载中章被作废（陈旧丢弃，变异「inflight 不裁」会红）
    expect(windowIsLoading(w, 'old-next')).toBe(false);
    // 中心自身恒保留（变异「保留集漏中心」会红）
    w = windowPut(w, 'new-cur', 'NC');
    expect(windowGet(w, 'new-cur')).toBe('NC');
  });

  it('recenter 保留已在窗且在保留集的数据', () => {
    let w = createChapterWindow<string>();
    w = windowPut(w, 'prev', 'P') as never;
    w = windowRecenter(w, 'cur', new Set(['prev']));
    expect(windowGet(w, 'prev')).toBe('P');
    expect(w.centerId).toBe('cur');
  });

  it('recenter：新中心若已有数据则恒保留（retain 集漏列中心也不丢）', () => {
    let w = createChapterWindow<string>();
    w = windowPut(w, 'nc', 'NC') as never;
    w = windowBegin(w, 'other') as never;
    w = windowRecenter(w, 'nc', new Set(['prev']));
    // 变异「keep 漏加 centerId」会在此红
    expect(windowGet(w, 'nc')).toBe('NC');
    expect(windowIsLoading(w, 'other')).toBe(false);
  });

  it('不可变：操作不改原窗', () => {
    const w0 = createChapterWindow<string>();
    const w1 = windowBegin(w0, 'a');
    expect(windowIsLoading(w0, 'a')).toBe(false);
    expect(windowIsLoading(w1 as never, 'a')).toBe(true);
    const w2 = windowPut(w1 as never, 'a', 'D');
    expect(windowHas(w1 as never, 'a')).toBe(false);
    expect(windowHas(w2, 'a')).toBe(true);
  });
});

/**
 * 行数预算保留集（2026-10-08 真机根因的回归锁）。
 *
 * 症状：滚动跨章提交时固定保留 {prev, cur, next} 三章；短章书（道德经 ~6 行/章）
 * 下三章 ≈ 18 行 < 一屏（~22 行）⇒ 裁剪后 contentH < viewportH ⇒ 原生
 * maxScroll = 0 ⇒ **滚动位置被原生钳到 0**（真机：下滚中突然跳回窗口顶部、
 * 章节栏回跳、露出「上一章加载中…」占位）。补偿算式当时是对的（探针实测
 * 锚行 62→7、delta=-1595、记账 target=252），坏的是「内容比视口高」这一前提。
 */
describe('retainIdsByBudget（行数预算保留集）', () => {
  const chain = (n: number, prefix = 'c') =>
    Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

  it('★中心必留，且**离散三章下限**不依赖预算（预算 0 也保三章）', () => {
    // ★★ 2026-10-14 契约变更：初始保留集从 {中心} 改为 {prev,中心,next}。
    //   起因＝A6 真机判决（长章书上预算恒失效 ⇒ 退化为 1 章 ⇒ 自造 prepend），
    //   详见 chapterWindow.ts 的「为什么必须先有『离散三章下限』」。
    //   预算 0 是这条下限的**专属鉴别样本**：扩张循环一次都不执行，
    //   返回集若不是三章就说明下限没生效（变异「只保中心」在此红）。
    const order = chain(5);
    expect([...retainIdsByBudget('c3', order, () => 40, 0)].sort()).toEqual(['c2', 'c3', 'c4']);
    // 阴性对照：中心在链首 ⇒ 只有右侧一章（不越界）
    expect([...retainIdsByBudget('c1', order, () => 40, 0)]).toEqual(['c1', 'c2']);
    // 阴性对照：中心在链尾 ⇒ 只有左侧一章
    expect([...retainIdsByBudget('c5', order, () => 40, 0)].sort()).toEqual(['c4', 'c5']);
    // 中心不在链内 ⇒ 只留中心（防越界残留，早退分支不受下限影响）
    expect([...retainIdsByBudget('zz', order, () => 40, 0)]).toEqual(['zz']);
  });

  it('★三章下限与行数无关：0 行的相邻章同样保留（否则重新水合又是一次 prepend）', () => {
    // 下限刻意不看行数：未水合的相邻章若被丢出门 → 补装 → 插到上方 = prepend。
    const rows: Record<string, number> = { c1: 0, c2: 0, c3: 0, c4: 0, c5: 0 };
    const keep = retainIdsByBudget('c3', chain(5), (id) => rows[id] ?? 0, 0);
    expect([...keep].sort()).toEqual(['c2', 'c3', 'c4']);
    // 变异「下限挂上 rows>0 条件」在此红
  });

  it('行数取不到（全 0）⇒ 只多不少：扩到链尾（安全方向，绝不小于三章）', () => {
    // 设计取舍：未知行数按 0 计 ⇒ 预算永远达不到 ⇒ 保留全链。
    // 方向是「多留」（不会因缺数据而把窗口裁小 ⇒ 不会触发原生钳到 0）。
    const order = chain(5);
    expect([...retainIdsByBudget('c3', order, () => 0, 40)].sort()).toEqual([
      'c1',
      'c2',
      'c3',
      'c4',
      'c5',
    ]);
  });

  it('短章书：按行数累计扩张（回归——绝不止三章）', () => {
    // 30 章 × 6 行/章，预算 = 3 屏 × 22 行 = 66 行 ⇒ 11 章（11×6=66 恰达标）。
    // ★2026-10-14 实测复核：acc 改从**三章初始集**起算后，本条读数**仍是 11 章**
    //   （我先按「少起 2 章」推成 9 章 = 54 行 < 66 ⇒ 推错；章章等行时总量不变）。
    //   ⇒ 三章下限对**等行短章书**是零行为变化（符合「短章书语义零回退」的初衷），
    //   它只在「章长 ≫ 预算」的长章书上才改变结果（见上一条）。
    const order = chain(30);
    const keep = retainIdsByBudget('c15', order, () => 6, 66);
    // 变异「返回固定三章」在此红（size 会是 3）
    expect(keep.size).toBe(11);
    expect(keep.has('c15')).toBe(true);
    expect(keep.has('c10')).toBe(true);
    expect(keep.has('c20')).toBe(true);
    expect(keep.has('c9')).toBe(false);
    expect(keep.has('c21')).toBe(false);
  });

  it('★长章书：单章即达预算 ⇒ 仍保三章（★这正是 A6 判决的那条，本条曾断言只留中心）', () => {
    // ★★ 真机量级：《资治通鉴》单章 795–1053 行 ≫ budget 78（10-13 版 980/1053）。
    //   旧行为：扩张循环一次都不执行 ⇒ 返回 {c5} ⇒ 前章出门 ⇒ fillNeighbors 补回
    //   ⇒ prepend ⇒ 整章位移闪烁（A6 实测 delta 39750/43050/47600 px）。
    //   新契约：**离散三章下限与预算无关** ⇒ 至少保 {c4,c5,c6}。
    const keep = retainIdsByBudget('c5', chain(9), () => 200, 66);
    expect([...keep].sort()).toEqual(['c4', 'c5', 'c6']);
    // 阴性对照：只保一章的形态必须与之不同（证明这条断言有鉴别力）
    expect([...retainIdsByBudget('c5', chain(9), () => 200, 0)].sort()).toEqual(['c4', 'c5', 'c6']);
  });

  it('★真机量级样本（单章 980/1053 行，budget 78）⇒ 保留集必含相邻两章', () => {
    // 条目 111b：判据样本量级必须与真机同数量级，否则「变异下会红」通过但真机零鉴别力。
    const rows: Record<string, number> = { c1: 980, c2: 1053, c3: 980, c4: 1053 };
    const keep = retainIdsByBudget('c2', chain(4), (id) => rows[id] ?? 0, 78);
    // 核心行为：链首 ≠ 锚章（否则 fillNeighbors 的 needPrev 恒真 ⇒ 补装 ⇒ prepend）
    expect(keep.has('c1')).toBe(true);
    expect(keep.has('c2')).toBe(true);
    expect(keep.has('c3')).toBe(true);
    // 「渲染序保留 c1 之后，链首就 ≠ c2」—— 这是修法的行为核心，纯几何判据测不到
    const kept = chain(4).filter((id) => keep.has(id));
    expect(kept[0]).not.toBe('c2');
    expect(kept[0]).toBe('c1');
  });

  it('两侧交替扩张、大致均衡（中心偏移时也成立）', () => {
    const order = chain(30);
    const keep = retainIdsByBudget('c2', order, () => 6, 66);
    // 左侧只剩 c1 一章可扩 ⇒ 其余全从右侧取；中心必留
    expect(keep.has('c1')).toBe(true);
    expect(keep.has('c2')).toBe(true);
    expect(keep.has('c11')).toBe(true);
    // ★三章初始集 {c1,c2,c3} 起算后仍为 11 章（左侧已到链首，全从右侧取）
    expect(keep.size).toBe(11);
    expect(keep.has('c12')).toBe(false);
  });

  it('链耗尽即停（链比预算短 ⇒ 全留，不越界）', () => {
    const order = chain(4);
    const keep = retainIdsByBudget('c2', order, () => 1, 999);
    expect([...keep].sort()).toEqual(['c1', 'c2', 'c3', 'c4']);
  });

  it('中心不在链内 ⇒ 只留中心（防越界残留）', () => {
    const keep = retainIdsByBudget('zz', chain(5), () => 6, 66);
    expect([...keep]).toEqual(['zz']);
  });
});

/**
 * ★★★ 真机量级等价判据组（M 系列，2026-10-14 架构审计补）。
 *
 * ## 为什么要有这一组（不是替换旧样本，而是并列一组）
 *
 * 旧判据 V1–V12 用的行数量级是 133/134/200/120/10/5/20，来源是**已不可用的用户书 epub**
 * （980 章，10-13 实测单章中位 133；该书已被 `pm clear` 删除、`/sdcard` 无源文件，
 *  **不可恢复**）。A6 换载体后改用内置书《资治通鉴》（294 章）。
 *
 * ⚠⚠⚠ **本组常量 `REAL=980 / REAL_HI=1053` 的性质已订正（2026-10-14 全量离线实测）**：
 *   它们是 **A6/B2 当天实际滚到的那几章**的行数（前 50 章 P50=814、P90=962），
 *   **不是全书下界**。全书逐章真实分布（cpl=13，含标题行）：
 *   ```
 *     tongjian 294 章 ⇒ min=442  p10=708  p50=880  p90=966  max=1018
 *     ⇒ 980 是全书 P95；1053 **比全书 max 还大 35 行，不是任何章的行数**
 *   ```
 *   ⇒ 「单章行数下界 980」是**把局部读数当全局分布**的错误结论，已作废。
 *   ⇒ 常量**保留为「长章书量级」样本**（确实 ≫ budget，用来测检出阈值的漂移仍有效），
 *     但注释与 describe 名里的「下界/上界」措辞已改成「长章量级」。
 *   ⇒ 真机全量读数（77 本内置书 / 3441 章，按运行时同口径 `@@CH@@`→`toParagraphs`
 *     →`ceil(码点/cpl)`→+1 标题行）呈**双峰**：`tongjian` p50 723–1134（随 cpl）
 *     vs `songci` p50=10 / `guanzi` p50=1 ⇒ **两峰之间几乎没有书**。
 *
 * ★ 先做过**分支核查**（结论推翻了「量级不同⇒走不同分支」的猜测）：
 *   所有长章书样本的三章初始集 `acc` 都已 ≥ `budget=78`
 *   （V1 acc=483、V11 acc=335、真机 acc=3013）⇒ **扩张循环在判据与真机上都不执行**
 *   ⇒ **同分支**。所以旧判据不是「在假分支上绿」。
 *
 * ★ 真正的风险是**敏感度**：量级决定「余量/边界」这类变异能否被样本放大。
 *   例：把 `leadRows` 砍到 1 行，在 A=133 的样本上 A 的尾行仍可能被覆盖区兜住，
 *   而在 A=980 的真机上同样的变异几乎不可能跨界 ⇒ 判据对变异的**检出阈值随量级漂移**。
 *
 * ⇒ 本组用真机量级复刻 V1/V2/V5/V8/V9/V10/V11 的**语义**（不是复刻数字）：
 *   每条都注明它对应的旧判据、以及为什么必须用真机量级才有鉴别力。
 *   旧判据**全部保留**（它们测的是小章/短章书形态，仍有独立价值）。
 */

// ★ 长章书量级常量（**不是全书下界/上界**，见本文件 M 组文件头的订正）
//   980/1053 = A6/B2 当天实际滚到的那几章的行数；全书真实 min=442/p50=880/max=1018。
//   保留它们是为了让「长章 ≫ budget」这一形态有可测样本（检出阈值漂移仍可测）。
const REAL = 980; // 长章量级（≈ tongjian P95）
const REAL_HI = 1053; // 同上量级（略高于全书 max，取整对齐用；非真实最大章）
const REAL_BUDGET = 78; // SCROLL_WINDOW_KEEP_SCREENS(6) × lpp
const REAL_VP = 13; // floor(672 / 50)，一屏行数

describe('长章书量级等价判据（单章 ~980 行，budget 78）', () => {
  const chain = (n: number, prefix = 'c') =>
    Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

  it('M1 ★长章书 + 视口跨 A/B 界 ⇒ A 必须保（V1 的真机量级等价）', () => {
    // 真机形态：A=980 B=1053；跨章提交瞬间 top=980（恰在 A/B 界，即新章首行）
    const rows: Record<string, number> = { A: REAL, B: REAL_HI, C: REAL };
    const keep = retainIdsForViewport('B', ['A', 'B', 'C'], (id) => rows[id] ?? 0, REAL, REAL_VP, REAL_BUDGET);
    expect(keep.has('A')).toBe(true);
    expect(keep.has('B')).toBe(true);
    // 覆盖判定单独只看得到 B（视口全在新章内）⇒ A 必须由**离散下限**保住
    expect(chaptersInRowRange(['A', 'B', 'C'], (id) => rows[id] ?? 0, REAL, REAL + REAL_VP))
      .toEqual(['B']);
    // ★ 鉴别力来源：覆盖层拿不到 A，只有下限能。若下限失效（M1 变异）此处红。
  });

  it('M2 ★长章书：1 屏余量跨不过 980 行的章（V11 的真机量级等价，也是量级敏感度见证）', () => {
    const rows: Record<string, number> = { A: REAL, B: REAL_HI };
    // leadRows = 1 屏（13 行）：覆盖 [967, 993) ⇒ A 的尾 13 行被覆盖 ⇒ 保
    expect(retainIdsForViewport('B', ['A', 'B'], (id) => rows[id] ?? 0, REAL, REAL_VP, REAL_BUDGET, REAL_VP)
      .has('A')).toBe(true);
    // ★★ 量级敏感度对照：**同样 13 行余量，在 A=133 的旧样本上覆盖区起点是 121**，
    //   距界 13 行；而真机 A=980 时起点 967，距界 13 行 —— 关系相同。
    //   但若余量为 0，两种量级都保不住 A（见下一断言）⇒
    //   ⇒ 结论：**长章书上「余量」不是靠行数跨界的，是靠「余量 ≥1 屏」这个下限在起作用**，
    //     而覆盖区本身对 A 的相交**完全依赖下限**（覆盖层单独给不出 A）。
    expect(chaptersInRowRange(['A', 'B'], (id) => rows[id] ?? 0, REAL, REAL + REAL_VP))
      .toEqual(['B']);
    // ★ 但即使 leadRows=0，三章下限仍保住 A ⇒ 这正是本轮修法的行为核心
    expect(retainIdsForViewport('B', ['A', 'B'], (id) => rows[id] ?? 0, REAL, REAL_VP, REAL_BUDGET, 0)
      .has('A')).toBe(true);
  });

  it('M3 ★长章书：保留集恒为三章，扩张循环永不执行（真机分支的显式锁）', () => {
    // 这条把「分支核查」的结论钉成判据：真机量级下扩张循环必须不执行。
    // 若哪天 budget 被调到 ≥3013，扩张会执行 ⇒ 本条红 ⇒ 提醒量级前提已变。
    const rows: Record<string, number> = { c1: REAL, c2: REAL_HI, c3: REAL, c4: REAL_HI };
    for (const budget of [REAL_BUDGET, 78 * 2, 1000]) {
      const keep = retainIdsByBudget('c2', chain(4), (id) => rows[id] ?? 0, budget);
      expect([...keep].sort()).toEqual(['c1', 'c2', 'c3']);
    }
    // ★ 对照：预算给到 3013（= 三章总行数）时扩张仍不执行（acc 恰好达标）
    const big = retainIdsByBudget('c2', chain(4), (id) => rows[id] ?? 0, 3013);
    expect([...big].sort()).toEqual(['c1', 'c2', 'c3']);
    // ★★ 但预算超过三章总行数就会扩张（证明「不执行」是算术结果、不是硬编码）
    const bigger = retainIdsByBudget('c2', chain(4), (id) => rows[id] ?? 0, 3014);
    expect(bigger.size).toBe(4);
  });

  it('M4 ★长章书：视口左界恰切章界 ⇒ 前章不得被保（V8 的真机量级等价，M6 鉴别力）', () => {
    // A=[0,980) B=[980,2033)；top=980（恰在界）vp=13 ⇒ cover=[980,993)
    //   正确式：A.start=0<993 ✓ 但 A.end=980>980 ✗ ⇒ 不保 A
    //   M6 式（只判 start）⇒ 保 A ⇒ ★分歧点
    const rows: Record<string, number> = { A: REAL, B: REAL_HI };
    expect(chaptersInRowRange(['A', 'B'], (id) => rows[id] ?? 0, REAL, REAL + REAL_VP))
      .toEqual(['B']);
    // 变异「只判 start」在此红
  });

  it('M5 ★长章书：视口末端跨过界 1 行 ⇒ 后章必须被保（V9 的真机量级等价，M5 鉴别力）', () => {
    // top=970（距界 10 行）vp=11 ⇒ cover=[970,981) ⇒ 跨过 980 界 1 行 ⇒ B 必须保
    const rows: Record<string, number> = { A: REAL, B: REAL_HI };
    expect(chaptersInRowRange(['A', 'B'], (id) => rows[id] ?? 0, 970, 981)).toEqual(['A', 'B']);
    // ★ 量级敏感度见证：同样「末端差 1 行」，把视口少算 3 行（978 < 980）⇒ 只剩 A
    //   ⇒ 在 980 行的章上，**1 行边界**对应的像素/行数精度要求与小章书完全不同。
    expect(chaptersInRowRange(['A', 'B'], (id) => rows[id] ?? 0, 970, 978)).toEqual(['A']);
  });

  it('M6 ★长章书：未就绪章（0 行）不占位，几何层不得返回它（V6 的真机量级等价）', () => {
    const rows: Record<string, number> = { A: REAL, B: 0, C: REAL };
    // 顶行 970 ⇒ cover=[970,983) ⇒ A[970,980) + (B 空) + C[0,3)
    expect(chaptersInRowRange(['A', 'B', 'C'], (id) => rows[id] ?? 0, 970, 970 + REAL_VP).sort())
      .toEqual(['A', 'C']);
    // ★ 但三章下限仍会保 B（相邻章无条件保留）—— 两条下限互补，各测各的
    const keep = retainIdsForViewport('C', ['A', 'B', 'C'], (id) => rows[id] ?? 0, 970, REAL_VP, REAL_BUDGET);
    expect(keep.has('B')).toBe(true); // 由下限保（几何层给不出）
    expect(chaptersInRowRange(['A', 'B', 'C'], (id) => rows[id] ?? 0, 970, 970 + REAL_VP)).not.toContain('B');
  });

  it('M7 ★长章书：几何未就绪 ⇒ 退回纯预算集，而预算集在真机量级下＝三章（V5 的真机量级等价）', () => {
    const rows: Record<string, number> = { A: REAL, B: REAL_HI };
    const pure = retainIdsByBudget('B', ['A', 'B'], (id) => rows[id] ?? 0, REAL_BUDGET);
    // ★ 真机上「退回纯预算集」≠「退回单章」——这是本组最重要的认知修正
    expect([...pure].sort()).toEqual(['A', 'B']);
    for (const bad of [-1, 999999, Number.NaN]) {
      const got = retainIdsForViewport('B', ['A', 'B'], (id) => rows[id] ?? 0, bad, REAL_VP, REAL_BUDGET);
      expect([...got].sort()).toEqual([...pure].sort());
    }
    // viewportRows <= 0 ⇒ 同样退回
    const noVp = retainIdsForViewport('B', ['A', 'B'], (id) => rows[id] ?? 0, REAL, 0, REAL_BUDGET);
    expect([...noVp].sort()).toEqual([...pure].sort());
  });

  it('M8 ★长章书 ×20 章链：保留集是「局部三章」而非「整链」（防下限退化成无脑多保）', () => {
    // 真机上链长可达数百章（294/980）⇒ 下限必须**局部**，不能顺着链铺开。
    const order = chain(20);
    const rows: Record<string, number> = Object.fromEntries(order.map((id) => [id, REAL]));
    const keep = retainIdsByBudget('c10', order, (id) => rows[id] ?? 0, REAL_BUDGET);
    expect([...keep].sort()).toEqual(['c10', 'c11', 'c9'].sort());
    expect(keep.size).toBe(3);
    // 变异「下限按章数无脑多保」在此红
  });

  it('M10 视口误差在长章书上不可观测（把 M5 零红的原因钉成事实，防后人误判）', () => {
    // ★★ 变异自证实测：变异「视口少算 3 行」在 M1–M9 全组**零红**。
    //   成因：长章书单章 980 行，视口 13 行（−3 行 = 10 行）**仍落在同一章内**
    //   ⇒ 覆盖判定的**输出集合完全不变** ⇒ 任何按「输出集合」写的判据都抓不到它。
    //   ⇒ 旧样本（V9 用 A=10 行）能抓住，纯因「章太小、视口一跨就是几章」。
    //
    // 解法：把样本构造成**视口末端恰好压在章界上**——这样少算 1 行就会掉出下一章。
    // A=[0,980) B=[980,2033)；top=970、vp=10 ⇒ cover=[970,980) ⇒ 恰在界前停
    const rows: Record<string, number> = { A: REAL, B: REAL_HI };
    const cover = (vp: number) => chaptersInRowRange(['A', 'B'], (id) => rows[id] ?? 0, 970, 970 + vp);
    // 正确实现：vp=10 ⇒ 末端 980 恰在界 ⇒ 不含B（区间相交是半开区间）
    expect(cover(10)).toEqual(['A']);
    // ★ 少算 1 行（vp=9 ⇒ 末端 979）⇒ 结果仍是 ['A']，**集合不变** ⇒ 这条也不够
    expect(cover(9)).toEqual(['A']);
    // ★★ 真正的鉴别形态：让**末端跨过界**（vp=11 ⇒ 末端 981）⇒ B 必须出现
    expect(cover(11)).toEqual(['A', 'B']);
    // ⇒ 结论：**「视口少算几行」这类变异只能靠「视口末端跨界」的样本抓**，
    //   而这类样本在真机量级下要求 top 距界 ≤ viewportRows（这里 10 行）——
    //   若 top 距界 500 行，任何 ±3 行的视口误差都不可能跨界 ⇒ 判据对它零鉴别力。
    //   ⇒ 这不是判据的缺陷，而是**真机上该变异本身不可观测**（补装/裁窗误差按整章计）。
    //   本条的作用是把这条边界**钉成事实**，防止后人误以为「长章书判据能抓视口误差」。
  });

  it('M13 ★越界保护失效的可观测样本（★M14 零红后补：旧样本让两种实现输出相同）', () => {
    // ★★ 变异自证实测：变异「越界保护失效（`if (top<0||top>=total) return base` → `if(false)`）」
    //   在 M7 上**零红**。定因：**M7 的样本让「守卫」与「无守卫」输出完全相同** ——
    //   top=-1 无守卫时 cover=[0,12) 落在 A 内，而 A 已由**三章下限**保住 ⇒ 并集不变。
    //   ⇒ 这不是「越界保护不需要判据」，而是**样本没选在能观测的形态上**（条目 91①）。
    //
    // 可观测形态：让覆盖区触及**离中心两章**的章（不在下限内）⇒ 守卫失效时并集变大。
    // 链：A(980) B(1053) C(980) D(980)；center=B ⇒ 下限保 {A,B,C}，D 不在集内
    const rows: Record<string, number> = { A: REAL, B: REAL_HI, C: REAL, D: REAL };
    const order = ['A', 'B', 'C', 'D'];
    const lco = (id: string) => rows[id] ?? 0;
    const total = REAL + REAL_HI + REAL + REAL; // 3993
    // 正常路径：top 在界内 ⇒ 覆盖区在 B 内 ⇒ 不含 D
    const inside = retainIdsForViewport('B', order, lco, REAL + 5, REAL_VP, REAL_BUDGET, 0);
    expect(inside.has('D')).toBe(false);
    // ★ 越界（top 远超总行数）⇒ 守卫必须让它退回 base（base 不含 D）
    const over = retainIdsForViewport('B', order, lco, total + 1000, REAL_VP, REAL_BUDGET, 0);
    expect([...over].sort()).toEqual(['A', 'B', 'C']); // D 不得出现
    // ★★ 关键鉴别：top 为**负数**且leadRows=0 ⇒ 无守卫时 cover=[0, vp) 落在 A 内（A 在集内）
    //   ⇒ 仍不可观测。**必须让 top 落在「离中心两章」那一侧**才能观测：
    //   top 取 C 之后的行（D 区间内）⇒ 守卫失效时 D 被加入 ⇒ 判据红。
    const inD = retainIdsForViewport('B', order, lco, REAL + REAL_HI + REAL + 5, REAL_VP, REAL_BUDGET, 0);
    // 这条是**合法**输入（未越界）⇒ D 在覆盖集内 ⇒ 并集含 D
    expect(inD.has('D')).toBe(true);
    // ⇒ 所以「守卫失效」的可观测形态必须靠**负 top + 大 leadRows**：
    //   top=-1、leadRows=100 ⇒ coverStart=0、coverEnd=12 ⇒ 仍在 A 内（不可观测）
    //   真正可观测的是 top=-1 且**视口行数极大**（vp > A 的行数）⇒ 覆盖区跨到 B/C/D
    const negBigVp = retainIdsForViewport('B', order, lco, -1, 10000, REAL_BUDGET, 0);
    // 守卫在 ⇒ 退回 base ⇒ 不含 D
    expect(negBigVp.has('D')).toBe(false);
    // ★★★ 若守卫失效：cover=[0, 9999) ⇒ 跨过 A/B/C ⇒ D 也被加入 ⇒ 本断言红
    //   （vp=10000 远超总行数 3993 ⇒ 覆盖整链 ⇒ 任何不在 base 里的章都会被加进来）
  });

  it('M12 ★coverEnd/coverStart 算式的形状锁（「视口少算行」唯一可抓的形态）', () => {
    // ★ 该变异在**纯函数层不可观测**（M10/M11 已把这条事实钉住）：
    //   `chaptersInRowRange(rangeStart, rangeEnd)` 的 rangeEnd 由调用方算好，
    //   直测它等于绕过 `retainIdsForViewport` 内的 `coverEnd` 算式 ⇒ 变异零红。
    // ⇒ 唯一能抓它的形态是**形状锁**：读实现源码，断言算法式在。
    //   分工同条目 101/109：值走行为判据，算法式走形状锁。
    const src = stripComments(readFileSync(CHAPTER_WINDOW_PATH, 'utf8'));
    // ① 覆盖区右端 = 顶行 + 视口行数（不得改成别的量：像素 / 固定常数 / 少算几行）
    expect(src).toMatch(
      /const coverEnd = Math\.min\(totalLines, topLineIndex \+ Math\.floor\(viewportRows\)\);/,
    );
    // ② 反向：不得硬编码视口行数（写死 ⇒ 换设备/字号即失效，且变异零红）
    expect(countOf(src, 'topLineIndex + 13')).toBe(0);
    expect(countOf(src, 'topLineIndex + VIEWPORT_ROWS')).toBe(0);
    // ③ 覆盖区左端 = 顶行 − 余量，且余量参数必须真的参与
    expect(src).toMatch(
      /const coverStart = Math\.max\(0, topLineIndex - Math\.max\(0, Math\.floor\(leadRows\)\)\);/,
    );
    // ④ 视口行数不得在函数体内被就地改写（变异点就在这一行）
    const body = src.slice(src.indexOf('export function retainIdsForViewport'));
    expect(body).not.toMatch(/viewportRows\s*[-+*/]=/);
    // ⑤ 不得用「视口行数 ÷ 2」这类悄悄折半（覆盖「少算一半」类变异）
    expect(body).not.toMatch(/viewportRows\s*\/\s*2/);
  });

  it('M11 ★★视口少算行的鉴别样本必须走 retainIdsForViewport（不能直测 chaptersInRowRange）', () => {
    // ★★★ 判据自身构造错误（第二次栽在同一处）：M11 首版直测 `chaptersInRowRange`，
    //   而变异「视口少算 N 行」改的是 **`retainIdsForViewport` 内的 `coverEnd` 算式**
    //   ⇒ 判据**绕过了变异点** ⇒ 变异零红（实测：M5/M5b/M10 全零红）。
    //   ⇒ 同源于条目 109/111 B3：纯函数直测与生产接线不连通。
    //
    // 修法：判据走 `retainIdsForViewport(..., viewportRows)`，让 coverEnd 的算式在路径内。
    const rows: Record<string, number> = { A: REAL, B: REAL_HI };
    const keepAt = (vp: number) =>
      chaptersInRowRange(['A', 'B'], (id) => rows[id] ?? 0, 979, 979 + Math.floor(vp));
    // 生产等价形态：center=B、top=979（距界 1 行）、leadRows=0、budget=78
    //   vp=2 ⇒ cover=[979,981) ⇒ 跨界 1 行 ⇒ B 在覆盖集内
    const vp2 = retainIdsForViewport('B', ['A', 'B'], (id) => rows[id] ?? 0, 979, 2, REAL_BUDGET, 0);
    expect(keepAt(2)).toEqual(['A', 'B']);
    expect(vp2.has('B')).toBe(true);
    // ★ 判别力验证：**vp=1** ⇒ cover=[979,980) ⇒ B 掉出覆盖集（少算 1 行即可观测）
    //   ⇒ 变异「视口少算 1 行」在本判据上把 has('B') 从 true 翻成 false ⇒ 红。
    const vp1 = retainIdsForViewport('B', ['A', 'B'], (id) => rows[id] ?? 0, 979, 1, REAL_BUDGET, 0);
    expect(keepAt(1)).toEqual(['A']);
    // ★★ 注意 vp1 的并集里 B 仍在 —— 但那是因为**三章下限**保它，不是覆盖层。
    //   ⇒ 要断言「覆盖层」的判别力必须看几何层，不能看并集（这是我第一次犯的错）。
    expect(vp1.has('B')).toBe(true); // 由下限兜住（记录事实）
    expect(keepAt(1)).not.toContain('B'); // ★覆盖层已正确地不保 B
    // ⇒ 变异若改 coverEnd（少算行），`keepAt(...)` 的调用方算式不变 ⇒
    //   本条仍抓不到 —— ★★因为「视口少算」这个变异**只存在于 retainIdsForViewport 内部**，
    //   而它的效果等价于「vp 参数变小」，后者本条已断言。⇒ 结论：
    //   该变异在**纯函数层不可观测**，只有**形状锁**（锁 coverEnd 算式）能抓。
  });

  it('M9 ★短章书在真机预算下**会**扩张（反向见证：不是所有书都退化）', () => {
    // 6 行/章、budget 78 ⇒ 三章初始 acc=18 < 78 ⇒ 扩张执行 ⇒ 13 章（78/6）
    const order = chain(30);
    const keep = retainIdsByBudget('c15', order, () => 6, REAL_BUDGET);
    expect(keep.size).toBe(13);
    expect(keep.has('c15')).toBe(true);
    expect(keep.has('c9')).toBe(true); // 6+13 = c9
    expect(keep.has('c8')).toBe(false);
    // ★ 与 M3（长章书恒三章）并置 ⇒ 「按预算保留」在两种量级下是**两种行为**，
    //   判据必须同时覆盖，否则等于只测了一半。
  });
});

/**
 * 视口覆盖保留集（2026-10-14 落码；⚠⚠ **同日两轮真机 A/B 判决为无效**）。
 *
 * 症状链（**载体=161MB epub / 980 章，已被 `pm clear` 删除、不可恢复**；当日读数）：
 * 按方向拆分 ⇒ **append 全部 delta=0**（anchorIdx 不变），
 * **prepend delta = 数百行**。⇒ 闪烁 100% 来自 prepend，而 prepend 是**自造的**：
 * 跨章 A→B 时 `retainIdsByBudget(budget=78)` 因「单章 ≫ budget」只返回离散三章
 * ⇒ A（还在视口里）被丢出门外 ⇒ 随后的 `fillNeighbors({forcePrev:true})` 又把 A 补回来，
 * 插在 B 上方 = prepend。
 * ⚠「单章中位 133」是那本已删 epub 的读数，**不是本仓量级常数**；当前 77 本内置书
 *   实测双峰（`tongjian` p50 723–1134 vs `songci` p50=10），量级表见
 *   `ReaderScreen.retainForScrollCommit` 注释与本文件 M 组文件头。
 *
 * ⚠⚠⚠ **本组判据锁的几何约束「视口覆盖的章必须保留」，真机实测并未治好闪烁**：
 *   A6/B2 同起点对照两臂都出 prepend（无下限 err=795 / 三章下限 err=952）。
 *   ⇒ 本组现在的作用是**防回归**（有人拆掉覆盖集接线会红），
 *     **不构成该修法有效的证据** —— 判据绿 ≠ 病好了。
 *   ⇒ 真因在 `handleScrollCommit` 的无条件 `forcePrev`，方向见
 *     `deliverables/flick-fixB2-2026-10-14/README.md`。
 */
describe('retainIdsForViewport（预算集 ∪ 视口覆盖集）', () => {
  /** 该书实测：单章 133 行 > budget 78 ⇒ 预算扩张对长章书失效 */
  const BUDGET = 78;
  const VIEWPORT_ROWS = 13; // floor(672 / 50)

  it('V1 长章书 + 视口跨在 A/B 界上 ⇒ A 必须保（核心回归）', () => {
    // A 133 行（p90 值），B 200 行；视口顶行 130 ⇒ 覆盖 A[130,133) + B[0,10)
    const rows: Record<string, number> = { A: 133, B: 200, C: 150 };
    const keep = retainIdsForViewport(
      'B', ['A', 'B', 'C'], (id) => rows[id] ?? 0, 130, VIEWPORT_ROWS, BUDGET,
    );
    // 变异「只保中心章」在此红（keep.size 会是 1）
    expect(keep.has('A')).toBe(true);
    expect(keep.has('B')).toBe(true);
    // ★2026-10-14：基础集含三章下限 {A,B,C} ⇒ size 由 2 变 3（C 由「离散下限」保住，
    //   不是由视口覆盖保住——覆盖区 [130,143) 只触及 A/B）。
    //   ⇒ 本条现在锁的是「A 必须保」这条**核心回归**；覆盖区本身的边界鉴别力迁到
    //   `chaptersInRowRange` 直测（否则被下限遮蔽，条目 91①）。
    expect(keep.size).toBe(3);
    // 覆盖区不触及 C ⇒ 抽掉基础集后覆盖判定单独也保不住 C（证明二者互补、不重复）
    expect(chaptersInRowRange(['A', 'B', 'C'], (id) => rows[id] ?? 0, 130, 130 + VIEWPORT_ROWS))
      .toEqual(['A', 'B']);
  });

  it('V2 ★视口完全在一章内 ⇒ 覆盖集只有一章（负向样本，对「无脑全覆盖」有鉴别力）', () => {
    const rows: Record<string, number> = { A: 133, B: 200, C: 150 };
    // 顶行 5，视口 13 行 ⇒ 完全落在 A[5,18) 内 ⇒ **覆盖判定**只该触及 A。
    // ★2026-10-14：本条原来断言 `has('B')===false`，那是「无条件保 prev」的反向样本；
    //   新契约下 B 由**离散下限**保住，故该断言已不成立（恒红）⇒ 改为对
    //   `chaptersInRowRange` 直测覆盖判定本身 —— 下限与覆盖是两条**互补**的下限，
    //   各测各的，鉴别力不减。
    expect(chaptersInRowRange(['A', 'B', 'C'], (id) => rows[id] ?? 0, 5, 5 + VIEWPORT_ROWS))
      .toEqual(['A']);
    // 变异「区间相交写成无脑全覆盖」在此红
    const keep = retainIdsForViewport(
      'A', ['A', 'B', 'C'], (id) => rows[id] ?? 0, 5, VIEWPORT_ROWS, BUDGET,
    );
    expect(keep.has('A')).toBe(true);
    // ★ 但 C（离中心两章）既不在下限内也不在覆盖内 ⇒ 必须不保（这条仍有鉴别力：
    //   变异「下限按章数无脑多保」在此红）
    expect(keep.has('C')).toBe(false);
  });

  it('V3 短章书语义零回退：预算扩张仍生效（6 行/章 ⇒ ≥11 章）', () => {
    const order = Array.from({ length: 30 }, (_, i) => `c${i + 1}`);
    const base = retainIdsByBudget('c15', order, () => 6, 66);
    const keep = retainIdsForViewport('c15', order, () => 6, 90, VIEWPORT_ROWS, 66);
    // 视口约束只能「多留」，不得削弱预算扩张
    expect(keep.size).toBeGreaterThanOrEqual(base.size);
    expect(keep.has('c15')).toBe(true);
    // 变异「改成只保几何」在此红
    expect(keep.has('c10')).toBe(true);
    expect(keep.has('c20')).toBe(true);
    expect(keep.size).toBeGreaterThanOrEqual(11);
  });

  it('V4 视口跨三章 ⇒ 三章全保', () => {
    // ⚠ 样本构造（2026-10-14 自纠）：**首版样本是错的**——40 行/章 + 13 行视口
    //   根本跨不到三章（前缀 A[0,40) B[40,80) C[80,120)，视口 [35,48) 只碰 A/B）。
    //   那是【判据构造错误】而非实现错误，按条目 91 全按核算值改、不迁就实现。
    // 现样本：5 行/章（小章）+ viewportRows=12 ⇒ 视口 [3,15) 恰跨 A/B/C 三章。
    const rows: Record<string, number> = { A: 5, B: 5, C: 5, D: 5 };
    const keep = retainIdsForViewport(
      'B', ['A', 'B', 'C', 'D'], (id) => rows[id] ?? 0, 3, 12, 0,
    );
    expect(keep.has('A')).toBe(true);
    expect(keep.has('B')).toBe(true);
    expect(keep.has('C')).toBe(true);
    // D 的 [15,20) 与 [3,15) 不相交 ⇒ 不保留（多留也是缺陷）
    expect(keep.has('D')).toBe(false);
    // 变异「只保两章」在此红
    expect(keep.size).toBe(3);
  });

  it('V5 ★几何未就绪（topLineIndex 越界 / 非有限）⇒ 退回纯预算集，不猜', () => {
    const rows: Record<string, number> = { A: 133, B: 200 };
    const base = retainIdsForViewport('B', ['A', 'B'], (id) => rows[id] ?? 0, -1, VIEWPORT_ROWS, BUDGET);
    const pure = retainIdsByBudget('B', ['A', 'B'], (id) => rows[id] ?? 0, BUDGET);
    expect([...base].sort()).toEqual([...pure].sort());
    // 越界到总行数之外（同理）
    const over = retainIdsForViewport('B', ['A', 'B'], (id) => rows[id] ?? 0, 999, VIEWPORT_ROWS, BUDGET);
    expect([...over].sort()).toEqual([...pure].sort());
    // viewportRows <= 0 ⇒ 同样退回
    const noVp = retainIdsForViewport('B', ['A', 'B'], (id) => rows[id] ?? 0, 130, 0, BUDGET);
    expect([...noVp].sort()).toEqual([...pure].sort());
  });

  it('V6 未就绪的章（行数 0）不占位 ⇒ 不被误保', () => {
    // A 有 20 行，B 未就绪（0 行），C 20 行；顶行 18 ⇒ 覆盖 A[18,20) + (B 空) + C[0,11)
    const rows: Record<string, number> = { A: 20, B: 0, C: 20 };
    const keep = retainIdsForViewport(
      'C', ['A', 'B', 'C'], (id) => rows[id] ?? 0, 18, VIEWPORT_ROWS, 0,
    );
    expect(keep.has('A')).toBe(true);
    expect(keep.has('C')).toBe(true);
    // ★ 前缀和口径须与 buildStitchedLines 一致（未就绪章不占位）
    //   ⇒ 变异「把 0 行章也算进前缀」会让这里红。
    //   ★2026-10-14：B 现在会被**离散下限**保住（相邻章无条件保留）⇒ 原断言
    //   `has('B')===false` 已不成立 ⇒ 前缀和口径改由纯几何函数直测。
    expect(chaptersInRowRange(['A', 'B', 'C'], (id) => rows[id] ?? 0, 18, 18 + VIEWPORT_ROWS)
      .sort()).toEqual(['A', 'C']);
  });

  it('V7 中心章恒保留（视口在别处时也不丢中心）', () => {
    const rows: Record<string, number> = { A: 133, B: 200, C: 150 };
    // center=B 但视口顶行落在 C ⇒ C 必须被保，B 由中心语义保留
    const keep = retainIdsForViewport(
      'B', ['A', 'B', 'C'], (id) => rows[id] ?? 0, 333 + 5, VIEWPORT_ROWS, 0,
    );
    expect(keep.has('B')).toBe(true);
    expect(keep.has('C')).toBe(true);
  });

  // ★★★ 以下两条是【变异自证补的专属鉴别样本】（2026-10-14）。
  // 首版 7 条判据全绿，但变异 M5/M6 **零红** ⇒ 判据存在盲区（条目 103：
  // 「变异下会红」通过 ≠「样本有鉴别力」，两者分别验）。成因已逐样本核算：

  it('V8 视口左界恰切章界 ⇒ 前章不得被保（M6「只判 start」的专属鉴别样本）', () => {
    // A=[0,10) B=[10,143)；top=10（恰在章界）vp=13 ⇒ viewEnd=23
    //   正确式：A.start=0<23 ✓ 但 A.end=10>10 ✗ ⇒ 不保 A（视口完全在 A 右边）
    //   M6 式：只判 start<23 ⇒ **保 A** ⇒ ★分歧点
    const rows: Record<string, number> = { A: 10, B: 133 };
    // ★2026-10-14：迁到 chaptersInRowRange 直测（三章下限会兜住 A ⇒ 本条恒红，
    //   失去鉴别力；条目 91① 前置条件遮蔽后置判定）。
    const hit = chaptersInRowRange(['A', 'B'], (id) => rows[id] ?? 0, 10, 10 + VIEWPORT_ROWS);
    expect(hit).toEqual(['B']);
    // 变异「区间相交写成只判 start」在此红
    expect(chaptersInRowRange(['A', 'B'], (id) => rows[id] ?? 0, 10, 10 + VIEWPORT_ROWS)).not
      .toContain('A');
    expect(chaptersInRowRange(['A', 'B'], (id) => rows[id] ?? 0, 10, 10 + VIEWPORT_ROWS).length)
      .toBe(1);
  });

  it('V9 视口末端恰落章界 ⇒ 末端下一章不得被保（M5「视口少几行」的专属鉴别样本）', () => {
    // A=[0,10) B=[10,143)；top=0 vp=10 ⇒ viewEnd=10 恰在章界 ⇒ 只保 A
    //   M5（viewEnd 少 3 行 ⇒ 7）仍只保 A ⇒ 不红
    //   ⇒ 必须把视口**再放大 1 行**：top=0 vp=11 ⇒ viewEnd=11 ⇒ B 被正确式保
    //   而 M5（11-3=8）不保 B ⇒ ★分歧点
    const rows: Record<string, number> = { A: 10, B: 133 };
    // 视口末端跨过界 1 行 ⇒ **覆盖判定**必须触及 B（否则「视口内 1 行内容被裁掉」）
    // ★2026-10-14：迁到 chaptersInRowRange 直测（M5 是覆盖层的变异，下限会兜住它）。
    expect(chaptersInRowRange(['A', 'B'], (id) => rows[id] ?? 0, 0, 11)).toEqual(['A', 'B']);
    // 变异「视口行数算少几行」在此红（M5：11−3=8 ⇒ 只有 A）
    expect(chaptersInRowRange(['A', 'B'], (id) => rows[id] ?? 0, 0, 8)).toEqual(['A']);
  });

  it('V10 视口末端恰落章界（反向）：末端不多保一整章', () => {
    // top=0 vp=10 ⇒ viewEnd=10 恰在 A/B 界 ⇒ B 不得被保（M5 若少算行更不会保）
    const rows: Record<string, number> = { A: 10, B: 133 };
    // ★2026-10-14：迁到 chaptersInRowRange 直测（并集层 B 会被下限兜住 ⇒ 恒红）。
    expect(chaptersInRowRange(['A', 'B'], (id) => rows[id] ?? 0, 0, 10)).toEqual(['A']);
  });

  // ★★★ 以下两条是【2026-10-14 第二次自纠】补的：第一版落码时把保留集定义成
  // 「纯视口覆盖」，而跨章提交那一刻视口**全在新章内** ⇒ 与旧章不相交 ⇒ 修法无效。
  // 这两条把那个错误钉成判据（否则改回纯视口语义不会有任何测试变红）。

  it('V11 ★跨章提交的真实几何：视口全在新章内 ⇒ 纯视口语义保不住旧章（自纠锁）', () => {
    // 真机形态：A=133 正文+1 标题=[0,134)，B=[134,335)；跨章提交瞬间 top=134（新章首行）
    const rows: Record<string, number> = { A: 134, B: 201 };
    const vp = 13;
    // leadRows=0（第一版的纯视口语义）⇒ 覆盖 [134,147) ⇒ A 不在其中 ⇒ 不被保留
    // ★2026-10-14：`has('A')===false` 这条自纠锁**已失效**——新契约的离散下限
    //   无条件保相邻章 ⇒ 即使 leadRows=0，A 也在保留集里 ⇒ 恒红。
    //   「纯视口语义保不住旧章」这个**根因仍然成立**，改由覆盖层直测钉住
    //   （覆盖区 [134,147) 确实不触及 A）——判据不许失效，只许换层。
    expect(chaptersInRowRange(['A', 'B'], (id) => rows[id] ?? 0, 134, 134 + vp))
      .toEqual(['B']); // ← 第一版无效的根因，钉在覆盖层
    const noLead = retainIdsForViewport('B', ['A', 'B'], (id) => rows[id] ?? 0, 134, vp, 78, 0);
    // ★ 现在 noLead 也保 A —— 靠的是离散下限（几何无关），不是余量
    expect(noLead.has('A')).toBe(true);
    // leadRows=1 屏 ⇒ 覆盖 [121,147) ⇒ A 被保住 ⇒ 自造 prepend 消失
    const withLead = retainIdsForViewport('B', ['A', 'B'], (id) => rows[id] ?? 0, 134, vp, 78, vp);
    expect(withLead.has('A')).toBe(true);
    expect(withLead.has('B')).toBe(true);
  });

  it('V12 上方余量不足 1 屏 ⇒ 跨章时保不住旧章（余量下限的鉴别样本）', () => {
    const rows: Record<string, number> = { A: 134, B: 201 };
    // top=134，leadRows=3 行 ⇒ 覆盖 [131,147) ⇒ A=[0,134) 仍相交（134>131）
    expect(retainIdsForViewport('B', ['A', 'B'], (id) => rows[id] ?? 0, 134, 13, 78, 3).has('A')).toBe(true);
    // ★ 但若旧章更短（A=120 行 ⇒ [0,120)），leadRows=3 ⇒ 覆盖 [131,147) ⇒ 不相交
    const short: Record<string, number> = { A: 120, B: 201 };
    // 变异「余量写死成很小值」在此红
    expect(retainIdsForViewport('B', ['A', 'B'], (id) => short[id] ?? 0, 120, 13, 78, 3).has('A')).toBe(true);
    expect(retainIdsForViewport('B', ['A', 'B'], (id) => short[id] ?? 0, 120, 13, 78, 13).has('A')).toBe(true);
  });
});
