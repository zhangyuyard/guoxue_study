import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * ★★★ RB3 判据组：**JS 阻塞后的 offset 回退必须被检测并补投**。
 *
 * ## 真机判决（`rb3-run.log`，一次 prepend 的完整读数）
 * ```
 * 08:16:50.091 [RB][DELTA]  delta=0                    ← 锚点下标没变 ⇒ delta=0 是**正确**的
 * 08:16:50.095 [RB2][CS]    contentSize 121894 → 169494（+47600px）
 * 08:16:50.095 [PERF][jank] jsBlocked=2468ms           ★★ JS 阻塞 2.47 秒
 * 08:16:50.095 [RB2][DROP]  dropped=715px dt=2468ms     ★★ 回退时长 == 阻塞时长
 * ```
 *
 * ## 机理（★**不是**「锚点算错」）
 * JS 阻塞期间 `VirtualizedList` 状态冻结而原生 `ScrollView` 继续派发滚动；
 * 阻塞结束时 FlatList 用**冻结前的旧 offset** 覆盖原生位置 ⇒ 丢掉 715px。
 * ⇒ `delta=0` 是对的，补偿按定义不会投；
 * ★这是**另一种丢失（JS/原生状态失同步）**，必须**独立检测 + 补投**。
 * ⇒ ★顺带否掉「改锚点算法（`prevAnchorRef`）」那条路——调研阶段就否了，没落码。
 *
 * ## ★★ 补投必须**延两帧**
 * v1（立即投）读数（`rb4-run.log`）：
 * ```
 * 08:32:12.265 [RB3][RESTORE] 回退 178px ⇒ 投 38998
 * 08:32:12.265 [RB2][CS]      offsetRef=38328      ★★ 立刻被覆盖
 * 08:32:12.265 [PERF][jank]   jsBlocked=2426ms     ★★ JS 还在阻塞
 * ```
 * ⇒ 立即投的 `scrollToOffset` 排在 FlatList 重渲染**之后** ⇒ 白投。
 */
describe('RB3 JS 阻塞后的 offset 回退补投', () => {
  const SCROLL = resolve(__dirname, '../reader/core/modes/ScrollMode.tsx');
  const src = () => readFileSync(SCROLL, 'utf8');   // ★不 stripComments（含 file:// 陷阱）

  it('形状锁㊶：必须记录「data 变化前的 offset」作基准', () => {
    const s = src();
    expect(s).toMatch(/const offsetBeforeDataChangeRef = useRef<number \| null>\(null\)/);
    // ★基准必须在「lines/headerH 变化」的那段 effect 里写
    const i = s.indexOf('offsetBeforeDataChangeRef.current = offsetRef.current ?? 0;');
    expect(i).toBeGreaterThan(-1);
    const seg = s.slice(Math.max(0, i - 300), i + 200);
    expect(seg).toMatch(/prevLinesRef\.current = lines/);
  });

  it('形状锁㊷：回退检测 + **延两帧**补投（★立即投已证无效）', () => {
    const s = src();
    const i = s.indexOf('[RB3][RESTORE]');
    expect(i).toBeGreaterThan(-1);
    const seg = s.slice(i, i + 2600);
    // ★阈值常量必须存在
    expect(s).toMatch(/RB3_DROP_THRESHOLD_PX/);
    // ★必须是 requestAnimationFrame **两次**（延两帧）
    const raf = seg.match(/requestAnimationFrame/g);
    expect(raf === null ? 0 : raf.length).toBeGreaterThanOrEqual(2);
    // ★补投前要复核「仍处于回退」⇒ 避免重复投
    expect(seg).toMatch(/before - cur <= RB3_DROP_THRESHOLD_PX/);
    expect(seg).toMatch(/scrollToOffset\(\{ offset: before, animated: false \}\)/);
  });

  it('★ 行为组：回退检测 + 补投状态机（含「立即投无效」的语义）', () => {
    const TH = 40;
    // 复刻修复后的判定
    const detect = (baseline: number | null, y: number): number | null => {
      if (baseline === null) return null;
      const back = baseline - y;
      return back > TH ? back : null;
    };
    // ① 无基准（未发生 data 变化）⇒ 不动作
    expect(detect(null, 38000)).toBeNull();
    // ② 回退超过阈值 ⇒ 检出
    expect(detect(38998, 38116)).toBe(882);
    // ③ 未回退 / 回退很小 ⇒ 不动作（避免与正常动量抖动打架）
    expect(detect(38998, 39000)).toBeNull();
    expect(detect(38998, 38990)).toBeNull();      // 8px < 40
    // ④ 补投后 offset 对齐 ⇒ 再判定为「无需补」
    expect(detect(38998, 38998)).toBeNull();
    // ★⑤ 延两帧才投：立即投会被覆盖（真机 rb4 读数），故补投必须发生在帧回调里
    //   （jest 环境无 rAF ⇒ 用可手动推进的队列模拟「帧」）
    const order: string[] = [];
    const rafQueue: Array<() => void> = [];
    (globalThis as unknown as { requestAnimationFrame: (cb: () => void) => number })
      .requestAnimationFrame = (cb) => rafQueue.push(cb);
    const flushFrame = () => {
      const batch = rafQueue.splice(0, rafQueue.length);
      for (const cb of batch) cb();
    };
    // 复刻修复后的「延两帧补投」
    const scheduleRestore = (baseline: number, cur: () => number) => {
      order.push('detect');
      requestAnimationFrame(() => {
        order.push('frame1');
        requestAnimationFrame(() => {
          if (baseline - cur() <= TH) return;
          order.push('frame2-apply');
        });
      });
    };
    let now = 38116;              // JS 阻塞结束后的实际 offset（丢了 882）
    scheduleRestore(38998, () => now);
    // ★立即时**只做了检测**，尚未补投（这正是 v1 失败的地方）
    expect(order).toEqual(['detect']);
    flushFrame();
    expect(order).toEqual(['detect', 'frame1']);
    flushFrame();
    expect(order).toEqual(['detect', 'frame1', 'frame2-apply']);
    // ★补投后 offset 对齐 ⇒ 再判定无需补
    now = 38998;
    expect(detect(38998, now)).toBeNull();
  });
});
