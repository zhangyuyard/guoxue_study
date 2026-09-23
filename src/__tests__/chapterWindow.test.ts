/**
 * 章滑窗状态机单测（R2b1）。断言「变异下会红」：
 * - begin 去重（重复 begin → null；绕闸门 = 「一次手势多次推进」通病）；
 * - recenter 裁剪（data 与 inflight 双面裁剪、中心恒保留）；
 * - put/fail 的 inflight 收支配平。
 */
import {
  createChapterWindow,
  windowBegin,
  windowFail,
  windowGet,
  windowHas,
  windowIsLoading,
  windowPut,
  windowRecenter,
} from '../reader/chapterWindow';

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
