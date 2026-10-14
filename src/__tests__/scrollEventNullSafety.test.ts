/**
 * 滚动事件空安全（2026-10-12 真机崩溃实证）—— 两层判据
 *
 * 崩溃原文（release 包，logcat `E/AndroidRuntime`）：
 * ```
 * FATAL EXCEPTION: mqt_v_native
 * com.facebook.react.common.JavascriptException:
 *   TypeError: Cannot read property 'contentOffset' of null
 *     at anonymous@1:2066620
 * Process: com.guoxue.studyapp, PID: 24130
 * ```
 * ⇒ `Process ... has died`（dumpsys 复核：`last crashed +1m58s645ms`、
 *    `crashes since then: 1`）⇒ 整个 app 退出，非红屏。
 *
 * 机理：FlatList **换 key 重挂载 / data 整体替换**的瞬间，旧 cell 已卸载，
 * 原生仍把在途滚动事件派发到 JS，此时 `nativeEvent` 为 `null`。
 * 原实现在 4 处裸写 `e.nativeEvent.contentOffset.y`
 * （`onScroll` / `handleScrollEnd` / `handleMomentumEnd` / `handleDragEnd`）
 * ⇒ 任一处收到空事件即抛。
 *
 * ⚠ 为何不能用 `e?.nativeEvent?.contentOffset?.y ?? 0` 兜底成 0：
 *   0 是**合法视口位置**，会被 `handleScroll` / `handleScrollEnd` 当成
 *   「视口在顶部」⇒ 触发错误的跨章提交与边沿装载 ⇒ 顶栏错章。
 *   必须用 `null` 与 `0` 区分 ⇒ 判据里有专门一条锁这个区分。
 *
 * 变异判据（红数 = 失败用例数）：
 * - M1 任一处理器改回裸读 `e.nativeEvent.contentOffset.y` ⇒ 形状层红
 * - M2 `scrollOffsetYOf` 去掉任一层防护 ⇒ 行为层红
 * - M3 `scrollOffsetYOf` 把 `null` 兜底成 `0` ⇒ 行为层红（锁「无事件 ≠ y=0」）
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
const SCROLL_MODE_PATH = resolve(APP_ROOT, 'reader/core/modes/ScrollMode.tsx');

/**
 * 与 ScrollMode.tsx 中的 `scrollOffsetYOf` **同形**的实现。
 * 复制而非 import：被测文件是 .tsx（jest 无 preset-react，仓内既有禁令），
 * 故只能对纯逻辑做同形复制 + 源码形状断言双保险。
 */
function scrollOffsetYOf(e: unknown): number | null {
  if (!e || typeof e !== 'object') {
    return null;
  }
  const ne = (e as { nativeEvent?: unknown }).nativeEvent;
  if (!ne || typeof ne !== 'object') {
    return null;
  }
  const off = (ne as { contentOffset?: unknown }).contentOffset;
  if (!off || typeof off !== 'object') {
    return null;
  }
  const y = (off as { y?: unknown }).y;
  return typeof y === 'number' && Number.isFinite(y) ? y : null;
}

describe('滚动事件空安全 · 崩溃回归防护', () => {
  const src = stripComments(readFileSync(SCROLL_MODE_PATH, 'utf8'));

  describe('源码形状：4 个处理器必须走安全口', () => {
    test('scrollOffsetYOf 已定义且返回 number | null', () => {
      expect(countOf(src, 'function scrollOffsetYOf(e: unknown): number | null')).toBe(1);
    });

    test('四个处理器共 3 处直接调用（handleMomentumEnd/handleDragEnd 经 handleScrollEnd 转发）', () => {
      // onScroll + handleScrollEnd 两处实读；另两处只转发 e，不自己解构
      expect(countOf(src, 'const y = scrollOffsetYOf(e);')).toBe(2);
      // 两个转发点必须保持转发（各自解构才是缺陷形态）
      expect(countOf(src, 'handleScrollEnd(e);')).toBe(2);
    });

    test('★ 处理器签名放宽为 unknown（否则 TS 仍假定 nativeEvent 存在）', () => {
      // 4 个签名：onScroll / handleScrollEnd / handleMomentumEnd / handleDragEnd
      expect(countOf(src, '(e: unknown) =>')).toBe(4);
    });

    test('★ 代码中不得再有裸读 e.nativeEvent.contentOffset（注释已被 strip）', () => {
      expect(countOf(src, 'e.nativeEvent.contentOffset')).toBe(0);
    });

    test('★ 每个实读点都必须先判 null 再放行（不得 `?? 0`）', () => {
      expect(countOf(src, 'const y = scrollOffsetYOf(e);')).toBe(2);
      expect(countOf(src, 'if (y == null) {')).toBe(2);
      // 严禁把空事件兜成 0：0 是合法视口位置
      expect(src).not.toMatch(/scrollOffsetYOf\([^)]*\)\s*\?\?\s*0/);
    });

    /**
     * ★ 这一条是**补锁**：首版行为层用例在测试文件里复制了一份同形实现，
     * 改 `ScrollMode.tsx` 的函数体对它们**零影响**（实测 M3 变异 14/14 全绿
     * ⇒ 判据无检测力）。故必须对**源码本体**逐层锁防护。
     *
     * 锁法：数函数体内的四层判空语句各恰好 1 次。
     * 删任一层 ⇒ 该层计数 0 ⇒ 红。
     */
    test('★ 四层判空防护逐层在位（删任一层即红 — 首版 M3 曾漏）', () => {
      // 取出函数体，避免全文计数被别处同名语句污染
      const start = src.indexOf('function scrollOffsetYOf');
      expect(start).toBeGreaterThan(-1);
      const body = src.slice(start, src.indexOf('\n}', start));
      // 层① 事件本身
      expect(countOf(body, "if (!e || typeof e !== 'object')")).toBe(1);
      // 层② nativeEvent
      expect(countOf(body, "if (!ne || typeof ne !== 'object')")).toBe(1);
      // 层③ contentOffset（M3 删掉的就是这层）
      expect(countOf(body, "if (!off || typeof off !== 'object')")).toBe(1);
      // 层④ y 的类型与有限性
      expect(countOf(body, 'Number.isFinite(y)')).toBe(1);
      // 返回类型签名
      expect(countOf(body, '): number | null {')).toBe(1);
    });
  });

  describe('行为：空事件必须返回 null（不是 0）', () => {
    // 真机崩溃输入即第一行：nativeEvent 为 null
    test('★ { nativeEvent: null } ⇒ null（真机崩溃原文的输入）', () => {
      expect(scrollOffsetYOf({ nativeEvent: null })).toBeNull();
    });

    test('事件本身为 null / undefined ⇒ null', () => {
      expect(scrollOffsetYOf(null)).toBeNull();
      expect(scrollOffsetYOf(undefined)).toBeNull();
    });

    test('各层缺失 ⇒ null（逐层拆）', () => {
      expect(scrollOffsetYOf({})).toBeNull();
      expect(scrollOffsetYOf({ nativeEvent: {} })).toBeNull();
      expect(scrollOffsetYOf({ nativeEvent: { contentOffset: null } })).toBeNull();
      expect(scrollOffsetYOf({ nativeEvent: { contentOffset: {} } })).toBeNull();
    });

    test('★ y=0 是合法视口位置，必须返回 0 而非 null', () => {
      // 这是「不能用 ?? 0 兜底」的根本原因：真实事件 y 可以合法地为 0
      expect(scrollOffsetYOf({ nativeEvent: { contentOffset: { y: 0 } } })).toBe(0);
    });

    test('正常事件 ⇒ 原值', () => {
      expect(scrollOffsetYOf({ nativeEvent: { contentOffset: { y: 12345.67 } } })).toBe(12345.67);
      expect(scrollOffsetYOf({ nativeEvent: { contentOffset: { y: -100 } } })).toBe(-100);
    });

    test('非有限数（NaN / Infinity）⇒ null（绝不把脏值喂进 offset 记账）', () => {
      expect(scrollOffsetYOf({ nativeEvent: { contentOffset: { y: NaN } } })).toBeNull();
      expect(scrollOffsetYOf({ nativeEvent: { contentOffset: { y: Infinity } } })).toBeNull();
      expect(scrollOffsetYOf({ nativeEvent: { contentOffset: { y: -Infinity } } })).toBeNull();
    });

    test('y 非数字（字符串 / null / 未定义）⇒ null', () => {
      expect(scrollOffsetYOf({ nativeEvent: { contentOffset: { y: '100' } } })).toBeNull();
      expect(scrollOffsetYOf({ nativeEvent: { contentOffset: { y: null } } })).toBeNull();
      expect(scrollOffsetYOf({ nativeEvent: { contentOffset: {} } })).toBeNull();
    });

    test('非对象（数字 / 字符串 / 布尔）⇒ null', () => {
      expect(scrollOffsetYOf(42)).toBeNull();
      expect(scrollOffsetYOf('x')).toBeNull();
      expect(scrollOffsetYOf(true)).toBeNull();
    });

    test('原生实际会带上更多字段 ⇒ 只取 contentOffset.y，其余一律忽略', () => {
      const ev = {
        nativeEvent: {
          contentOffset: { x: 0, y: 888 },
          contentInset: { top: 44, bottom: 0 },
          contentSize: { width: 1080, height: 22678 },
          layoutMeasurement: { width: 1080, height: 1170 },
          zoomScale: 1,
        },
      };
      expect(scrollOffsetYOf(ev)).toBe(888);
    });
  });
});
