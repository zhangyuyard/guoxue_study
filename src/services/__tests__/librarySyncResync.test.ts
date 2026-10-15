import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * ★★★ 书架扫描的「补扫」判据组（修「导入大书成功但书架不显示，重启才显示」）。
 *
 * ## 真机判决（`imp-run.log`）
 * ```
 * 17:31:40.787 [PERF][library-sync] registerBuiltinMeta=7ms
 * 17:31:41.029 join in-flight sync        ← 导入完成后 loadBooks() 触发
 * 17:31:41.040 [PERF][library-sync] done folder=1 builtin=77 +261ms
 * ```
 * ★`folder=1` ⇒ 那一轮扫描只看到 **1** 本用户书（应为 2）⇒ 刚导入的那本不在结果里。
 *
 * ## 机制
 * `loadBooks` → `loadAndRegisterAll()`；而该函数有去重：
 * ```js
 * if (librarySyncInFlight) return librarySyncInFlight;   // ★直接返回旧 promise
 * ```
 * 导入大书耗时数秒 ⇒ 期间已有一轮扫描在飞 ⇒ 导入完成后的那次调用
 * **join 旧扫描** ⇒ 拿不到新书 ⇒ 书架不刷新；重启后是全量扫描 ⇒ 能看到。
 * ⇒★**「去重」把新数据吞了**：必须在在飞结束后**补跑一轮**。
 *
 * ## 防打转
 * 补跑自身产生的新请求**不再触发补跑**（`suppressResyncOnce`），
 * 否则「在飞→结束→补跑→在飞→…」会变成连续扫描打转。
 */
describe('书架扫描：去重后必须补跑一轮', () => {
  const SERVICE = resolve(__dirname, '../UserBookService.ts');
  const src = () => readFileSync(SERVICE, 'utf8');   // ★不 stripComments（含 file:// 陷阱）

  it('形状锁㊳：去重分支必须登记「待补扫」而不是只 join', () => {
    const s = src();
    const i = s.indexOf('export function loadAndRegisterAll()');
    expect(i).toBeGreaterThan(-1);
    const seg = s.slice(i, i + 1200);
    expect(seg).toMatch(/if \(librarySyncInFlight\)/);
    // ★核心：必须登记 pending
    expect(seg).toMatch(/librarySyncResyncPending = true/);
    // ★无条件登记 pending（防打转靠**时间节流**，不靠「补跑自身不登记」——
    //   那个方案无效：补跑走「不在飞」分支会把闸复位）
    expect(seg).toMatch(/librarySyncResyncPending = true/);
  });

  it('形状锁㊴：在飞结束处必须补跑一轮', () => {
    const s = src();
    const i = s.indexOf('export function loadAndRegisterAll()');
    const seg = s.slice(i, i + 2000);
    expect(seg).toMatch(/librarySyncInFlight = loadAndRegisterAllInternal\(\)\.finally\(/);
    expect(seg).toMatch(/if \(librarySyncResyncPending\)/);
    // ★时间节流（防连续扫描打转）
    expect(seg).toMatch(/RESYNC_THROTTLE_MS/);
    expect(seg).toMatch(/lastResyncAt = now/);
    expect(seg).toMatch(/void loadAndRegisterAll\(\)/);
    // ★不得残留失效的「闸」方案
    expect(seg).not.toMatch(/suppressResyncOnce/);
  });

  it('★ 行为组：补扫状态机（并发 / 补跑 / 打转防护）', () => {
    // 复刻修复后的去重 + 补跑状态机（接线由形状锁㊳㊴ 保证）
    let inFlight = false;
    let pending = false;
    let lastResync = -1e9;   // 上次补跑时刻
    const THROTTLE = 1500;
    let clock = 0;
    const starts: number[] = [];
    let scanId = 0;
    const call = () => {
      if (inFlight) {
        pending = true;                    // ★无条件登记
        return 'join';
      }
      inFlight = true;
      const id = ++scanId;
      starts.push(id);
      return 'start';
    };
    const settle = () => {
      inFlight = false;
      if (pending) {
        pending = false;
        if (clock - lastResync < THROTTLE) return;  // ★节流窗口内跳过
        lastResync = clock;
        call();// 补跑
      }
    };

    // ① 并发：第二个请求 join + 登记 pending
    expect(call()).toBe('start');
    expect(call()).toBe('join');
    expect(call()).toBe('join');
    expect(pending).toBe(true);
    // ② 在飞结束 ⇒ 补跑一轮
    clock = 10000;
    settle();
    expect(starts.length).toBe(2);
    // ③ 补跑期间到达的请求 join 并置 pending；**节流窗口内**不再补跑（防打转）
    expect(call()).toBe('join');
    expect(pending).toBe(true);
    settle();                 // 仍在 1500ms 窗口内 ⇒ 跳过
    expect(starts.length).toBe(2);
    // ④ 过了节流窗口 + 又有新请求 ⇒ 允许再补跑
    //    ★注意：③ 里节流跳过的同时 `pending` **已被清**（生产同语义：
    //    「跳过就不补，下一次正常扫描自然会带上」）⇒ ④ 必须**重新**置 pending。
    clock += 2000;                // 10000 → 12000，已过 1500ms 窗口
    inFlight = true;              // 模拟又有一轮在飞
    expect(call()).toBe('join'); // ★新请求置 pending
    settle();                     // 过窗口 ⇒ 补跑
    expect(starts.length).toBe(3);
    // ⑤ 无并发时正常单轮
    inFlight = false; pending = false; clock += 5000;
    expect(call()).toBe('start');
    settle();
    expect(starts.length).toBe(4);
  });
});
