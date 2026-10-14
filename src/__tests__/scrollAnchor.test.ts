/**
 * scrollAnchor.ts 单测（滚动模式视口锚点 / 头部占位 / 行下标纯算式）。
 *
 * 回归背景（2026-10-08 真机实证，两处独立缺陷）：
 * ① 头部占位（ListHeaderComponent）在原生里排在 item 之上，而 RN 的
 *    `ListMetricsAggregator.getCellMetrics` 直接采信 getItemLayout 的 offset、
 *    不做头部补偿 ⇒ 所有 y↔行号 换算必须显式带 headerHeight。
 * ② 窗口前插/前删会搬动全部行下标，原生 contentOffset 不会跟着变 ⇒ 需按锚行
 *    位移补 offset。
 *
 * 变异判据（每条都实测会红）：
 * - `lineIndexAtContentY` 若不减 headerHeight：用例「y=90 且 headerH=44」必红
 *   （错值 1，正解 0）—— 这是唯一能区分「减了/没减」的取样点。
 * - `anchorCompensationDelta` 若漏掉头部高度差：用例 (5,5,90,0,44) 必红（错值 0）。
 * - `anchorCompensationDelta` 若恒返 0（死常量）：前插 3 行用例必红（错值 0）。
 *
 * ③ 2026-10-09 新增两条（真机实证的顶栏错章 + 补偿跳动）：
 * - `chapterOwnerIndex` 若退化成恒等（不做 +1）：章界用例 idx=149→150 必红
 *   （错值 149）；若恒返 0（死常量）：章内用例必红。
 * - `clampScrollTarget` 若不钳制（恒返 target）：超 maxScroll 用例 25000→22006 必红；
 *   若恒返 0：正常区间用例必红；`contentHeight<=0` 不钳制用例防「首次投递被吞/
 *   拿旧内容高错误降级」。
 */
import { Line } from '@/reader/geometry';
import {
  anchorCompensationDelta,
  chapterOwnerIndex,
  clampScrollTarget,
  contentYOfLineIndex,
  hasAuthoritativeContentHeight,
  indexOfLineKey,
  lineIndexAtContentY,
  lineKeyOf,
  shouldDeliverCompensation,
  viewportOwnerIndexAtContentY,
} from '@/reader/core/modes/scrollAnchor';

const RH = 90;
const HINT = 44;
const N = 10;

function line(chapterId: string, charStart: number, isTitle = false): Line {
  return {
    index: 0,
    chapterId,
    segmentId: isTitle ? '__title__' : 's1',
    charStart,
    charEnd: charStart + 24,
    isTitle,
  } as Line;
}

/** 长度可变的行序列（含首章标题行），用于锚点位移用例 */
function linesOf(chapters: readonly string[]): Line[] {
  const out: Line[] = [];
  for (const c of chapters) {
    out.push(line(c, 0, true));
    for (let i = 0; i < 3; i++) {
      out.push(line(c, i * 24));
    }
  }
  return out;
}

describe('lineKeyOf / indexOfLineKey', () => {
  it('标题行与正文行键不同源、正文键 = (章, 段, 段内码点)', () => {
    expect(lineKeyOf(line('c1', 48))).toBe('c1#s1#48');
    expect(lineKeyOf(line('c1', 0, true))).toBe('c1#title');
  });

  it('按 key 求下标；不在序列中返回 -1（锚缺失判据）', () => {
    const ls = linesOf(['c2', 'c3']);
    const target = ls[5];
    expect(indexOfLineKey(ls, lineKeyOf(target))).toBe(5);
    expect(indexOfLineKey(ls, lineKeyOf(line('c9', 0)))).toBe(-1);
  });
});

describe('lineIndexAtContentY（必须带头部占位）', () => {
  it('头部占位之内 ⇒ 第 0 行（视口顶落在提示条上不越界）', () => {
    expect(lineIndexAtContentY(0, HINT, RH, N)).toBe(0);
    expect(lineIndexAtContentY(HINT - 1, HINT, RH, N)).toBe(0);
  });

  it('★ 区分「减了 headerHeight / 没减」的取样点：y=90、headerH=44 ⇒ 0', () => {
    // 正解 floor((90-44)/90)=0；漏减 headerH 会得 floor(90/90)=1 ⇒ 本用例红
    expect(lineIndexAtContentY(90, HINT, RH, N)).toBe(0);
    // 边界另一侧：y = HINT + RH ⇒ 1
    expect(lineIndexAtContentY(HINT + RH, HINT, RH, N)).toBe(1);
  });

  it('无头部占位时退化为 floor(y/rowH)', () => {
    expect(lineIndexAtContentY(RH * 3, 0, RH, N)).toBe(3);
  });

  it('越界钳制：超出尾部 ⇒ 末行；空序列 ⇒ 0', () => {
    expect(lineIndexAtContentY(1_000_000, HINT, RH, N)).toBe(N - 1);
    expect(lineIndexAtContentY(500, HINT, RH, 0)).toBe(0);
  });
});

describe('chapterOwnerIndex（章归属行 = 顶行 + 1，对亚像素落点免疫）', () => {
  it('★ 章界：顶行判成上一章末行（149）⇒ 归属必须落到下一章首行（150）', () => {
    // 真机锚定 idx=150（致士章首行），原生回传 y 使 floor 得 149（臣道末行）
    // ⇒ 退化成恒等则顶栏显示「臣道」且永不自愈。本用例是该缺陷的判据。
    expect(chapterOwnerIndex(149, 599)).toBe(150);
    expect(chapterOwnerIndex(150, 599)).toBe(151);
  });

  it('章内：+1 后仍同章（不产生额外提交）', () => {
    expect(chapterOwnerIndex(300, 599)).toBe(301);
    expect(chapterOwnerIndex(0, 599)).toBe(1);
  });

  it('末行钳制：+1 不越界；空序列 ⇒ 0（防恒等变异漏网）', () => {
    expect(chapterOwnerIndex(598, 599)).toBe(598);
    expect(chapterOwnerIndex(5, 0)).toBe(0);
    expect(chapterOwnerIndex(0, 1)).toBe(0);
  });

  it('负顶行被钳到 0（防御性分支：lineIndexAtContentY 本身已把 y<headerH 钳到 0）', () => {
    expect(chapterOwnerIndex(-3, 599)).toBe(0);
  });
});

describe('clampScrollTarget（补偿目标 → 原生实落点）', () => {
  it('★ 超 maxScroll 必须钳制（maxScroll = contentH − viewportH）', () => {
    // 真机实测口径：contentH=22678、viewportH=672（同为 dp）⇒ maxScroll=22006
    // 目标 25000 超出 ⇒ 必须被钳到 22006；不钳制则 offsetRef 记 25000 而实落
    // 22006 ⇒ 偏差永久进入下一次补偿基线（真机表现为「加载完成后跳一下」）
    expect(clampScrollTarget(25000, 22678, 672)).toBe(22006);
    expect(clampScrollTarget(50000, 22678, 672)).toBe(22006);
  });

  it('目标在范围内 ⇒ 原样返回（不误钳）', () => {
    expect(clampScrollTarget(6794, 22678, 672)).toBe(6794);
    expect(clampScrollTarget(0, 22678, 672)).toBe(0);
  });

  it('contentHeight<=0（未收到 onContentSizeChange / 内容高已过期）⇒ 不钳制', () => {
    expect(clampScrollTarget(22006, 0, 672)).toBe(22006);
    expect(clampScrollTarget(-5, 0, 672)).toBe(0);
  });

  it('内容比视口还短（contentH <= viewportH）⇒ maxScroll=0，补偿被吞到 0', () => {
    expect(clampScrollTarget(6794, 500, 672)).toBe(0);
    expect(clampScrollTarget(6794, 672, 672)).toBe(0);
    // 对照：contentH 略大于 viewportH 时 maxScroll 才是正的（防把上例写成恒 0）
    expect(clampScrollTarget(6794, 1000, 672)).toBe(328);
  });
});

describe('viewportOwnerIndexAtContentY（归属行；越界⇒null 不可提交）', () => {
  const RH2 = 45;   // 真机 rowHeight
  const H2 = 44;    // 真机 BOUNDARY_HINT_H
  const N2 = 599;   // 真机跳章后 stitched 长度

  it('★ 机理①亚像素：真实落点 6793.6（探针 Math.round 显示 6794）⇒ 顶行 149，归属必须 150', () => {
    // 真机探针：MOUNT-ANCHOR idx=150 offRef=6794 → 原生回传 y 使 floor 得 149。
    // ★ y 必取**未取整**的真值（探针日志打的是 Math.round 后的 6794，真实略小）：
    //   floor((6794−44)/45) = 150 并不复现；只有 y<6794 才得 149。
    const y = 6793.6;
    expect(lineIndexAtContentY(y, H2, RH2, N2)).toBe(149); // 几何顶行（错章来源）
    expect(viewportOwnerIndexAtContentY(y, H2, RH2, N2)).toBe(150); // 归属行
    // 对照：正好落在 contentYOfLineIndex(150) 上 ⇒ 顶行本就是 150（无误差）
    expect(lineIndexAtContentY(contentYOfLineIndex(150, H2, RH2), H2, RH2, N2)).toBe(150);
  });

  it('★ 机理②越界钳制：y 超出已装数据 ⇒ null（+1 对钳制无效，必须靠 null 挡住）', () => {
    // 装配空窗期：lines 只有 150 行（只含刚并入的上一章），原生 y 仍指向 6794
    const N = 150;
    const y = 6794;
    // 旧链路：lineIndexAtContentY 钳到末行 149 ⇒ 末行属上一章 ⇒ 提交上一章
    expect(lineIndexAtContentY(y, H2, RH2, N)).toBe(N - 1);
    // 修法：越界 ⇒ null（不提交，等数据装齐后由下一次 onScroll 判定）
    expect(viewportOwnerIndexAtContentY(y, H2, RH2, N)).toBeNull();
  });

  it('正常区间：+1 且不越界（章内不产生额外提交）', () => {
    expect(viewportOwnerIndexAtContentY(H2 + 300 * RH2, H2, RH2, N2)).toBe(301);
    expect(viewportOwnerIndexAtContentY(H2, H2, RH2, N2)).toBe(1);
  });

  it('★ 回归：「+1」对越界**无效**（证明必须另有 null 判据，不能只靠 +1）', () => {
    const N = 150;
    const clamped = Math.min(150, N - 1);           // chapterOwnerIndex(idx=N, len=N)
    expect(chapterOwnerIndex(N, N)).toBe(clamped); // +1 后仍等于末行 ⇒ 仍会错章
    expect(viewportOwnerIndexAtContentY(H2 + N * RH2, H2, RH2, N)).toBeNull();
  });

  it('头部占位之内 / 空序列 ⇒ null', () => {
    expect(viewportOwnerIndexAtContentY(0, H2, RH2, N2)).toBeNull();
    expect(viewportOwnerIndexAtContentY(H2 - 1, H2, RH2, N2)).toBeNull();
    expect(viewportOwnerIndexAtContentY(1000, H2, RH2, 0)).toBeNull();
  });
});

describe('contentYOfLineIndex（getItemLayout 同式）', () => {
  it('含头部占位', () => {
    expect(contentYOfLineIndex(0, HINT, RH)).toBe(HINT);
    expect(contentYOfLineIndex(3, HINT, RH)).toBe(HINT + 3 * RH);
    expect(contentYOfLineIndex(2, 0, RH)).toBe(2 * RH);
  });
});

describe('anchorCompensationDelta', () => {
  it('前插章 ⇒ 锚行被下推，补偿量为正（行数 × 行高）', () => {
    const before = linesOf(['c3']);
    const after = linesOf(['c2', 'c3']);
    const key = lineKeyOf(before[2]); // c3 的正文第 2 行
    const pi = indexOfLineKey(before, key);
    const ni = indexOfLineKey(after, key);
    expect(pi).toBe(2);
    expect(ni).toBe(6); // 前插一章 = 标题行 + 3 正文行
    expect(anchorCompensationDelta(pi, ni, RH, HINT, HINT)).toBe(4 * RH);
  });

  it('前删章 ⇒ 锚行被上提，补偿量为负', () => {
    expect(anchorCompensationDelta(6, 2, RH, HINT, HINT)).toBe(-4 * RH);
  });

  it('尾部追加 / 无变化 ⇒ 0', () => {
    expect(anchorCompensationDelta(2, 2, RH, HINT, HINT)).toBe(0);
  });

  it('★ 头部占位显隐也搬动内容：高度差必须计入', () => {
    // 占位从无到有（44）⇒ 内容整体下移 44 ⇒ 必须补 44；漏掉则得 0 ⇒ 本用例红
    expect(anchorCompensationDelta(5, 5, RH, 0, HINT)).toBe(HINT);
    expect(anchorCompensationDelta(5, 7, RH, HINT, 0)).toBe(2 * RH - HINT);
  });

  it('锚行任一侧缺失 ⇒ 0（退化不补偿，防算错方向）', () => {
    expect(anchorCompensationDelta(-1, 6, RH, HINT, HINT)).toBe(0);
    expect(anchorCompensationDelta(6, -1, RH, HINT, HINT)).toBe(0);
  });
});

/**
 * ★ 单向逼近守卫 `shouldDeliverCompensation`（2026-10-12 真机闪烁读数）
 *
 * 测试向量**逐字取自真机日志**（`deliverables/flick-probe-2026-10-12/flick1.log`
 * 与 `flick2.log`），不是构造值：
 *
 * 初载场景（rowH=45 量级，容差取 45）：
 *   APPLY target=26594 from=11244 d=+15350   首投
 *   APPLY target=26594 from=26594 d=0        冗余重投  ← 应拦
 *   JUMP  y=12316（原生首投被丢弃/钳制到中间位）
 *   JUMP  y=26594（复投拽回）
 *
 * 跨章场景（`flick2.log`）实录三轮往返：
 *   +13300 → −12797 → +12797 → +308 → −308
 *
 * ★★ 规则⓪ 的向量来自 `flick2.log` 的**主体**读数（不是往返那一段）：
 * ```
 * 15:20:24.515 DATA  lines 841→1342       ← 数据变了
 * 15:20:25.175 APPLY target=42991 from=29691 d=+13300
 * 15:20:25.200 JUMP  y=30194  d=−12797    ← 25ms 后原生只走到 30194（+503px）
 * 15:20:25.578 JUMP  y=43299              ← 403ms 后才到位
 * ```
 * ⇒ 首投那一刻 `recordedLines=841`（contentSize 描述的还是旧数据）、`currentLines=1342`
 *   ⇒ 目标 42991 此刻不可达 ⇒ 必须**不投**（这一段 403ms 错位窗口就是肉眼看到的闪）。
 *
 * 变异判据（每条都实测会红）：
 * - 若守卫恒返 true（不存在）：「冗余重投」「反向投递」「内容高陈旧」三用例必红。
 * - 若守卫恒返 false（死常量）：「首投（权威）」用例必红（现场读数证明必须放行）。
 * - 若只判①不判②（漏反向）：「反向投递」用例必红。
 * - 若只判②不判①（漏零位移）：「冗余重投」用例必红。
 * - 若漏规则⓪（还原旧行为）：「内容高陈旧」用例必红，且 `hasAuthoritativeContentHeight`
 *   的三条用例同时红。
 */
describe('shouldDeliverCompensation · 单向逼近守卫（消除停手后闪烁）', () => {
  const TOL = 45; // 真机 rowH≈45
  /** 「内容高权威」样本：recordedLines === currentLines（正常投递路径） */
  const FRESH = 1342;

  it('★ 首投必须放行（真机读数：from=11244 → real=26594，内容高权威）', () => {
    expect(shouldDeliverCompensation(11244, 26594, 26594, TOL, FRESH, FRESH)).toBe(true);
  });

  it('★ 冗余重投必须拦下（真机读数：from=26594 real=26594，零位移）', () => {
    // 不拦则多调一次 scrollToOffset，且推进 compRetryRef 计数（真机 15:17:38.384 那条）
    expect(shouldDeliverCompensation(26594, 26594, 26594, TOL, FRESH, FRESH)).toBe(false);
  });

  it('★ 反向投递必须拦下（误差变大 ⇒ 画面先错后对 ⇒ 闪）', () => {
    // 真机跨章读数：当前 30194、意图 42991、实落点 43299
    // 此处构造**误差确实变大**的样本：当前 40000、意图 42991、实落点 30000
    expect(shouldDeliverCompensation(40000, 42991, 30000, TOL, FRESH, FRESH)).toBe(false);
  });

  // ── 规则⓪：内容高权威性（2026-10-12 新增，本轮闪烁主体） ──

  it('★★ 内容高陈旧 ⇒ 首投必须**不投**（真机 403ms 错位窗口的根因行）', () => {
    // 真机逐字：lines 841→1342，contentSize 尚是 841 时的首投
    // 旧行为（ch=0 ⇒ 不钳制 ⇒ 照投 42991）⇒ 原生钳到 30194 ⇒ 403ms 后复投才到位
    expect(shouldDeliverCompensation(29691, 42991, 42991, TOL, 841, 1342)).toBe(false);
  });

  it('★ 内容高陈旧时**连反向投递也不用判**（权威性先于其他两条规则）', () => {
    // 构造一个「规则①②本会放行」的正向样本（11244→26594），
    // 仅把内容高改成陈旧 ⇒ 仍必须拦下，证明拦的是权威性而非恰好命中①②
    expect(shouldDeliverCompensation(11244, 26594, 26594, TOL, 258, 841)).toBe(false);
  });

  it('内容高陈旧但目标恰好已到位 ⇒ 依然不投（不浪费原生调用）', () => {
    expect(shouldDeliverCompensation(1000, 1000, 1000, TOL, 100, 200)).toBe(false);
  });

  it('内容高恢复权威（CS 到达）⇒ 同一目标立即放行（证明不会永久丢目标）', () => {
    const target = 42991;
    const from = 29691;
    // 第一次：内容高陈旧 ⇒ 不投
    expect(shouldDeliverCompensation(from, target, target, TOL, 841, 1342)).toBe(false);
    // onContentSizeChange 到达后：recordedLines 变为 1342 ⇒ 权威 ⇒ 放行
    expect(shouldDeliverCompensation(from, target, target, TOL, 1342, 1342)).toBe(true);
  });

  it('已在容差内 ⇒ 拦（`move <= tolerance`，含等于边界）', () => {
    expect(shouldDeliverCompensation(1000, 2000, 1045, TOL, FRESH, FRESH)).toBe(false); // 45 = TOL
    expect(shouldDeliverCompensation(1000, 2000, 1046, TOL, FRESH, FRESH)).toBe(true); // 46 > TOL 且误差变小
  });

  it('正向逼近 ⇒ 放行（误差严格变小）', () => {
    // 当前 12000、意图 26594、实落 13000 ⇒ 误差 14594 → 13594 变小
    expect(shouldDeliverCompensation(12000, 26594, 13000, TOL, FRESH, FRESH)).toBe(true);
  });

  it('恰好等价（误差不变）⇒ 拦（无收益）', () => {
    // 构造 move>0 且误差不变的样本：当前 1000、意图 2000、实落 2000 ⇒ 误差 0，move=1000
    expect(shouldDeliverCompensation(1000, 2000, 2000, TOL, FRESH, FRESH)).toBe(true);
    expect(shouldDeliverCompensation(3000, 2000, 1000, TOL, FRESH, FRESH)).toBe(true);
  });

  it('容差为 0 时只在完全零位移时拦', () => {
    expect(shouldDeliverCompensation(1000, 2000, 1000, 0, FRESH, FRESH)).toBe(false);
    expect(shouldDeliverCompensation(1000, 2000, 1001, 0, FRESH, FRESH)).toBe(true);
  });

  it('非有限输入 ⇒ 拦（不投递，绝不把 NaN 喂给原生）', () => {
    expect(shouldDeliverCompensation(NaN, 2000, 2000, TOL, FRESH, FRESH)).toBe(false);
    expect(shouldDeliverCompensation(1000, 2000, NaN, TOL, FRESH, FRESH)).toBe(false);
    expect(shouldDeliverCompensation(1000, 2000, Infinity, TOL, FRESH, FRESH)).toBe(false);
  });

  it('负 tolerance 被夹到 0（防负容差把所有投递都拦掉）', () => {
    expect(shouldDeliverCompensation(1000, 2000, 1000, -10, FRESH, FRESH)).toBe(false);
    expect(shouldDeliverCompensation(1000, 2000, 1001, -10, FRESH, FRESH)).toBe(true);
  });
});

/**
 * ★ 内容高权威性闸门 `hasAuthoritativeContentHeight`（2026-10-12 真机闪烁主体）
 *
 * 判据「变异下会红」自证：
 * - 恒返 true（不存在）⇒ 「陈旧」「从未收到」两用例红。
 * - 恒返 false（死常量）⇒ 「权威」用例红。
 * - 漏掉 `Number.isFinite`（`-1` 也能通过）⇒ 「NaN / Infinity」用例红。
 */
describe('hasAuthoritativeContentHeight · 内容高权威性闸门', () => {
  it('★ 权威：recordedLines === currentLines（含相等与 0/0）', () => {
    expect(hasAuthoritativeContentHeight(1342, 1342)).toBe(true);
    expect(hasAuthoritativeContentHeight(0, 0)).toBe(true);
  });

  it('★ 陈旧：数据变高（recorded < current）⇒ 不可信', () => {
    // 真机读数：841→1342，内容高还是 841 时的首投
    expect(hasAuthoritativeContentHeight(841, 1342)).toBe(false);
  });

  it('★ 陈旧：数据变矮（recorded > current）⇒ 同样不可信', () => {
    // 窗口裁剪方向：原生会按真实（更矮的）高度钳一次 ⇒ 停在中间位 ⇒ 一样闪
    expect(hasAuthoritativeContentHeight(1342, 841)).toBe(false);
  });

  it('从未收到过 contentSize（-1）⇒ 不可信', () => {
    expect(hasAuthoritativeContentHeight(-1, 1342)).toBe(false);
    expect(hasAuthoritativeContentHeight(-1, -1)).toBe(false);
  });

  it('非有限 recordedLines ⇒ 不可信（漏 isFinite 就会红）', () => {
    expect(hasAuthoritativeContentHeight(NaN, NaN)).toBe(false);
    expect(hasAuthoritativeContentHeight(Infinity, Infinity)).toBe(false);
  });
});
