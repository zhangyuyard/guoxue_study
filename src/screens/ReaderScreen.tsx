/**
 * 阅读器主页面（ReaderScreen）— R1：单章可读（几何层驱动）
 *
 * 架构：docs/reader-architecture-2026-09-22.md（L1 行化几何 / L2 位置模型 /
 * L3b 行级渲染器）。
 *
 * 旧实现教训（本文件遵守的红线）：
 * - 行高恒定常量（L1），`getItemLayout` 为无表纯算式 ⇒ 定位开环，
 *   禁 `onLayout`/估算/MVCP 参与定位（INV-G4）；
 * - 滚动位置持久化 = 章内码点偏移（charOffset，与排版无关的位置真值），
 *   禁像素比例作真值；
 * - 注音数据就绪与否不改变行数与行高（U7，PinyinText 已删降级换结构支）；
 * - 一次只动一个变量：本轮只做单章 + 章间按钮导航，跨章滑窗/分片在 R2。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import LineRow from '@/components/reader/LineRow';
import { ReaderCore } from '@/reader/core';
import CharActionMenu from '@/components/reader/CharActionMenu';
import ChapterTocSheet from '@/components/reader/ChapterTocSheet';
import HighlightActionSheet from '@/components/reader/HighlightActionSheet';
import { TextLibraryService } from '@/services/TextLibraryService';
import { StorageService } from '@/services/StorageService';
import { UserBookService } from '@/services/UserBookService';
import { useReaderStore } from '@/store/useReaderStore';
import { useNoteStore } from '@/store/useNoteStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useDictStore } from '@/store/useDictStore';
import { getColors, type ThemeColors } from '@/theme';
import { cellAdvanceFor, charGapFor, layoutChapter, resolveGeometry, unifiedPinyinFontSizeFor, type Line } from '@/reader/geometry';
import { resolveContentLayout } from '@/reader/contentLayout';
import { lineAtCharOffset } from '@/reader/position';
import {
  buildStitchedLines,
  orderedRenderChapters,
} from '@/reader/stitch';
import { buildSegmentHighlight } from '@/reader/highlightFactory';
import { buildTocItems } from '@/reader/toc';
import { currentPolyphoneSalt, polyphoneSaltOf } from '@/hooks/usePinyin';
import { annotateText, prewarmPinyinCache } from '@/utils/pinyin';
import { createChapterMaxPinyinLenStore } from '@/reader/pinyinLenCache';
import {
  createChapterWindow,
  retainIdsForViewport,
  windowBegin,
  windowFail,
  windowGet,
  windowHas,
  windowIsLoading,
  windowPut,
  windowRecenter,
  type ChapterWindow,
} from '@/reader/chapterWindow';
import { indexOfLineKey, lineKeyOf } from '@/reader/core/modes/scrollAnchor';
import type { ReaderRouteParams } from '@/navigation/types';
import type { Chapter, Highlight, HighlightColor, TextSegment } from '@/types';

/** ReaderScreen 所需的最小导航能力（RootStack 注入或阅读 Tab 手动构造均可满足） */
interface ReaderScreenProps {
  route?: { params?: ReaderRouteParams };
  navigation?: {
    goBack: () => void;
    navigate: {
      (name: 'Reader', params: ReaderRouteParams): void;
      (name: 'DictLookup', params: { headword?: string }): void;
    };
  };
}

interface LoadedChapter {
  bookTitle: string;
  chapter: Chapter;
  /** 按 order 升序的正文段 */
  segments: TextSegment[];
}

/**
 * 版心（左右边距 + 水平居中）：
 * - margin = 用户在「我的-阅读设置」里选的左右边距（下限）；
 * - contentWidth = 版心宽（= 窗宽 − 2×margin；行化 containerWidth 与渲染容器宽的唯一来源，
 *   二者必须同值，否则行化切出的末字被容器裁掉 = 丢字）；
 * - left/right = 版心壳偏移（left + right ≡ 2×margin；差值 2×shift 把整字数文字块摆到正中）。
 * 见 reader/contentLayout.ts。
 */

function ReaderScreen({ route, navigation }: ReaderScreenProps): React.JSX.Element {
  const params = route?.params;
  const bookId = params?.bookId ?? '';
  const chapterId = params?.chapterId ?? '';
  const jumpSeq = params?.jumpSeq ?? 0;

  const theme = useSettingsStore((s) => s.theme);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const lineHeight = useSettingsStore((s) => s.lineHeight);
  const pinyinMode = useSettingsStore((s) => s.pinyinMode);
  const conversionMode = useSettingsStore((s) => s.conversionMode);
  const readerMode = useSettingsStore((s) => s.readerMode);
  /** 正文左右边距（用户自定义，全局层；clamp 在 store 与 resolveContentLayout 双保险） */
  const pageMarginSetting = useSettingsStore((s) => s.pageMargin);
  const colors: ThemeColors = getColors(theme);

  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const pinyinOn = pinyinMode !== 'off';
  // 多音字读音来源 → 注音缓存盐（与 `usePinyin`／`prewarmChapter` 同源；来源切换后
  // 章级缓存 key 随之改变 ⇒ 自动失效，不会留下旧读音下的字号）
  const polyphoneSource = useDictStore((s) => s.polyphoneSource);
  const polyphoneSalt = polyphoneSaltOf(polyphoneSource);
  // 字距 → 单格步进（cellAdvanceFor 唯一真源，与几何层同源）
  const charGap = charGapFor(pinyinMode, fontSize);
  const cellAdvance = cellAdvanceFor(fontSize, charGap);
  // 版心：左右边距由用户设定；文字列按整字数栅格居中（宽屏下版心不超上限、两侧留白均分）
  const content = useMemo(
    () => resolveContentLayout(windowWidth, pageMarginSetting, cellAdvance),
    [windowWidth, pageMarginSetting, cellAdvance],
  );
  const containerWidth = content.contentWidth;

  // ── 几何（L1）：档位 + 容器宽 → 行几何；字距与渲染器同源（charGapFor）──
  const geometry = useMemo(
    () =>
      resolveGeometry({
        fontSize,
        lineHeight,
        pinyinEnabled: pinyinOn,
        containerWidth,
        charGap,
      }),
    [fontSize, lineHeight, pinyinOn, containerWidth, charGap],
  );

  // ── 章滑窗状态（R2b2）：窗缓存全部章数据；activeChapterId = 当前中心章 ──
  const [win, setWin] = useState<ChapterWindow<LoadedChapter>>(() => createChapterWindow());
  const [activeChapterId, setActiveChapterId] = useState<string>(chapterId);
  const [error, setError] = useState<string | null>(null);
  /** 就地切换序号：切换章时递增，驱动 FlatList 重挂载（initialScrollIndex 重算） */
  const [switchSeq, setSwitchSeq] = useState(0);
  /** 当前中心章 ref（异步装载回写的陈旧判定用，避免闭包过期） */
  const centerRef = useRef<string>(chapterId);
  // 路由 chapterId 变化（书架重进/路由跳章）时同步中心
  useEffect(() => {
    if (chapterId && chapterId !== centerRef.current) {
      centerRef.current = chapterId;
      setActiveChapterId(chapterId);
    }
  }, [chapterId]);

  const openChapter = useReaderStore((s) => s.openChapter);
  const recordProgress = useReaderStore((s) => s.recordProgress);
  const setSegment = useReaderStore((s) => s.setSegment);
  const lastRead = useReaderStore((s) => s.lastRead);

  /** 窗镜像（latest-ref 模式）：装载判定在 updater 外做，避免 StrictMode 双调副作用 */
  const winRef = useRef<ChapterWindow<LoadedChapter>>(win);
  winRef.current = win;

  /** 装载单章：水合（懒加载壳）→ 取章 → 排序。内置书与用户书同一 API。 */
  const loadChapterData = useCallback(
    async (cid: string): Promise<LoadedChapter> => {
      // 【首开提速】走「首章优先快速水合」而非 ensureBookLoaded（整本解析完
      // 才 resolve）。真机实证（2026-10-08）：ensureBookLoaded 的耗时与书体
      // 字节强线性（≈1.5 s/MB），《资治通鉴》9.47MB ⇒ 首屏 15.8–16.2s；而
      // meta 快路径只按章切片读目标章（meta.chapters[i].s/e 字节区间），
      // 其余章以空壳占位并由后台分批填充。
      const ensure = await UserBookService.ensureBookReady(bookId, {
        priorityChapterId: cid,
      });
      if (!ensure.success) {
        throw new Error(ensure.error ?? '书籍加载失败');
      }
      let chapterRes = TextLibraryService.getChapter(cid);
      if (!chapterRes.success || !chapterRes.data) {
        throw new Error(chapterRes.error ?? '章节不存在');
      }
      // 空壳章兜底：首开只装配了目标章，若用户跳到尚未被后台填充到的章，
      // segments 为空 ⇒ 触发「按需整章直读」（语义全有或全无）后重取一次。
      if (chapterRes.data.segments.length === 0) {
        const filled = await UserBookService.degradeChapterToWholeRead(
          bookId,
          cid,
        );
        if (filled) {
          chapterRes = TextLibraryService.getChapter(cid);
        }
        if (
          !chapterRes.success ||
          !chapterRes.data ||
          chapterRes.data.segments.length === 0
        ) {
          throw new Error('章节正文加载失败');
        }
      }
      const chapter = chapterRes.data;
      const bookRes = TextLibraryService.getBook(chapter.bookId);
      const segments = [...chapter.segments].sort((a, b) => a.order - b.order);
      return {
        bookTitle: bookRes.success ? bookRes.data?.title ?? '' : '',
        chapter,
        segments,
      };
    },
    [bookId],
  );

  /** R2b3 预拼：章装载后分批预热注音缓存（与渲染侧同参 ⇒ 首渲染命中） */
  const prewarmChapter = useCallback(
    (data: LoadedChapter, cid: string) => {
      if (!pinyinOn) {
        return;
      }
      void prewarmPinyinCache(
        data.segments.map((s) => s.text),
        pinyinMode,
        currentPolyphoneSalt(),
        { workId: cid, bookId },
      );
    },
    [pinyinOn, pinyinMode, bookId],
  );

  /** 指定章的滑窗保留集：中心 ∪ 前后邻章（跳章清窗语义的裁剪白名单） */
  const retainSetFor = useCallback((cid: string): Set<string> => {    const set = new Set<string>([cid]);
    const sib = TextLibraryService.getSiblingChapters(cid);
    if (sib.success && sib.data) {
      if (sib.data.prev) {
        set.add(sib.data.prev.id);
      }
      if (sib.data.next) {
        set.add(sib.data.next.id);
      }
    }
    return set;
  }, []);

  /** 派生当前章：窗中中心章数据（就地切换时目标未就绪 → null → 渲染 spinner） */
  const loaded = useMemo(
    () => (activeChapterId ? windowGet(win, activeChapterId) ?? null : null),
    [win, activeChapterId],
  );

  // ── 进入 / 路由跳章：recenter（清窗+陈旧丢弃）→ 命中缓存就地切，否则装载 ──
  useEffect(() => {
    if (!chapterId) {
      return;
    }
    let cancelled = false;
    setError(null);
    centerRef.current = chapterId;
    setActiveChapterId(chapterId);
    setSwitchSeq((s) => s + 1); // 路由进入/跳转也驱动列表重挂载（initialScrollIndex 重算）
    const retain = retainSetFor(chapterId);
    const before = winRef.current;
    const cached = windowGet(before, chapterId);
    const needLoad = !cached && !windowIsLoading(before, chapterId);
    setWin((w) => {
      const rw = windowRecenter(w, chapterId, retain);
      // updater 幂等：StrictMode 双调下 begin 结果一致（recenter 只裁剪不新增）
      return needLoad ? (windowBegin(rw, chapterId) ?? rw) : rw;
    });
    // ★ 续读真值保序：openChapter 不带 charOffset 会把持久化偏移覆盖为空
    // （store 语义：lastRead 整体重写）⇒ 必须把本轮定位用的偏移原样传入，
    // 优先级与 initialLineIndex 一致：路由 charOffset > 同章持久化 charOffset
    const finalize = (data: LoadedChapter) => {
      const routeOffset = params?.charOffset;
      const restoreOffset =
        typeof routeOffset === 'number' && routeOffset >= 0
          ? routeOffset
          : lastRead &&
              lastRead.bookId === bookId &&
              lastRead.chapterId === chapterId &&
              typeof lastRead.charOffset === 'number' &&
              lastRead.charOffset >= 0
            ? lastRead.charOffset
            : undefined;
      openChapter(data.chapter.bookId, data.chapter.id, params?.segmentId, undefined, restoreOffset);
    };
    if (cached) {
      finalize(cached);
    } else if (needLoad) {
      void (async () => {
        try {
          const data = await loadChapterData(chapterId);
          if (cancelled) {
            return;
          }
          setWin((w) => windowPut(w, chapterId, data));
          finalize(data);
          prewarmChapter(data, chapterId);
        } catch (e) {
          if (cancelled) {
            return;
          }
          setWin((w) => windowFail(w, chapterId));
          setError((e as Error).message ?? '加载失败');
        }
      })();
    }
    return () => {
      cancelled = true;
    };
    // jumpSeq 入参：重复跳转同章也要重置 effect（路由浅合并语义）
  }, [bookId, chapterId, jumpSeq]);

  // ── 邻章预取（R2b2）：中心就绪后后台装载 prev/next；begin 闸门去重 ──
  useEffect(() => {
    if (!loaded || !activeChapterId) {
      return;
    }
    const sib = TextLibraryService.getSiblingChapters(activeChapterId);
    if (!sib.success || !sib.data) {
      return;
    }
    for (const nid of [sib.data.prev?.id, sib.data.next?.id]) {
      if (!nid) {
        continue;
      }
      const before = winRef.current;
      if (windowHas(before, nid) || windowIsLoading(before, nid)) {
        continue;
      }
      setWin((w) => windowBegin(w, nid) ?? w);
      void (async () => {
        try {
          const data = await loadChapterData(nid);
          setWin((w) => windowPut(w, nid, data));
          prewarmChapter(data, nid);
        } catch {
          setWin((w) => windowFail(w, nid));
        }
      })();
    }
  }, [loaded, activeChapterId, loadChapterData]);

  // ── 中心章 lastRead 同步（R2b2）：就地切换不产生滚动事件，若不在此
  // 同步，杀进程重开会恢复到切换前的旧章（真机实测复现）。与 R1 路由
  // 跳章语义一致：跳到新中心 = lastRead 重写为新章（charOffset 空 = 章首）；
  // 之后的滚动停止仍由 recordProgress 以码点真值覆盖。
  useEffect(() => {
    if (!loaded || loaded.chapter.id !== activeChapterId || !bookId) {
      return;
    }
    if (lastRead?.bookId === bookId && lastRead?.chapterId === activeChapterId) {
      return;
    }
    openChapter(bookId, activeChapterId, undefined, undefined, undefined);
  }, [loaded, activeChapterId, bookId, lastRead, openChapter]);

  // ── 行化（L1）：段文本按码点切行，行不跨段、章局码点连续 ──
  // 跨章拼接（R3-stitch）：先建「窗内每章段」映射，锚章段用于现有单章逻辑/分页
  const segmentsByChapter = useMemo(() => {
    const m = new Map<string, TextSegment[]>();
    for (const [cid, data] of win.data) {
      m.set(cid, data.segments);
    }
    return m;
  }, [win]);
  const segments = segmentsByChapter.get(activeChapterId) ?? EMPTY_SEGMENTS;
  // 章 id → 标题（拼接标题行渲染用；避免 renderItem 闭包持旧 win）
  const chapterTitleByChapter = useMemo(() => {
    const m = new Map<string, string>();
    for (const [cid, d] of win.data) {
      m.set(cid, d.chapter.title ?? '');
    }
    return m;
  }, [win]);
  const layout = useMemo(
    () => layoutChapter(activeChapterId, segments, geometry),
    [activeChapterId, segments, geometry],
  );

  // ── 跨章拼接（scroll 模式）：窗内每章独立 layout + 拼接全局行序列 ──
  // layoutOfMap：章 id → 该章 layout（与 anchor 的 `layout` 同源，几何一致）
  const layoutOfMap = useMemo(() => {
    const m = new Map<string, { lines: Line[]; totalHeight: number }>();
    for (const [cid, data] of win.data) {
      m.set(cid, layoutChapter(cid, data.segments, geometry));
    }
    return m;
    // layoutChapter 返回类型含 lines/totalHeight，取子集即可
  }, [win, geometry]);
  // 渲染序 = 含锚章的最长已装载连续章链（锚章缺失则空）
  const loadedChapters = useMemo(
    () => orderedRenderChapters(new Set(win.data.keys()), activeChapterId, (id) => {
      const res = TextLibraryService.getSiblingChapters(id);
      return res.success && res.data ? res.data : {};
    }),
    [win, activeChapterId],
  );
  const stitched = useMemo(
    () =>
      buildStitchedLines(
        loadedChapters,
        (id) => layoutOfMap.get(id),
        // scroll 模式：章界插标题行（取窗内该章 title）；page 模式不插（翻页头另渲染）。
        // ① 首段含章名；② 首段自带章首标题形状（EPUB TOC 常为粗粒度「序/卷名」，
        //    真实章名在正文首段）——都不另插，防「序」类错标题泛滥。
        readerMode === 'scroll'
          ? (id) => {
              const data = win.data.get(id);
              if (!data) {
                return undefined;
              }
              const t = data.chapter.title?.trim();
              const first = data.segments[0]?.text?.trim();
              if (
                t &&
                first &&
                (first === t || first.includes(t) || t.includes(first) || firstSegmentIsHeading(first))
              ) {
                return undefined;
              }
              return data.chapter.title;
            }
          : undefined,
      ),
    [loadedChapters, layoutOfMap, readerMode, win],
  );

  // ── 拼音字号全章统一（架构 §7.2 观感统一）：按章内最长拼音算一次，
  // 全章同一值，消除逐字自适应造成的同行大小/字重不齐（24px 档 gé=12px 混 yǒu=8px）。
  // 仅缩字形不改拼音槽高 ⇒ 行高恒等（INV-G1）不受影响；U7 不破坏：
  // 几何（行高/行数）不依赖此值，注音缺失时行仍按 rowHeight 渲染。
  /**
   * 章级「最长拼音长度」缓存（§7.2 统一拼音字号）。
   * ★ 2026-10-09 真机根因修复（⑫ 装配空窗）：原实现直接调 `PinyinService.annotate`
   *   （**无结果缓存**），且每次 `segmentsByChapter` 变更即对**全部已载章**全量重算
   *   ⇒ 单次同步块 9.2~38s、JS 线程占用 99%、换章时正文区长时间空白。
   *   现：按章内容签名缓存 + 走带 LRU 的 `annotateText`（与 `prewarmChapter`／
   *   `PinyinText` 同参 ⇒ 预热后即命中）。完整根因与判据见 `@/reader/pinyinLenCache`。
   */
  const pinyinLenStore = useMemo(
    () =>
      createChapterMaxPinyinLenStore(
        (text, mode, salt, opts) => annotateText(text, mode, undefined, salt, opts),
        bookId,
      ),
    [bookId],
  );
  const chapterMaxPinyinLenOf = useCallback(
    (cid: string, segs: readonly TextSegment[]): number =>
      pinyinLenStore.of(cid, segs, pinyinMode, polyphoneSalt),
    [pinyinLenStore, pinyinMode, polyphoneSalt],
  );

  // 段内码点基准备查（跨章）：章 id → 段 id → [segStart, segEnd)
  const segmentSpanByChapter = useMemo(() => {
    const m = new Map<string, Map<string, { start: number; end: number }>>();
    for (const [cid, segs] of segmentsByChapter) {
      const inner = new Map<string, { start: number; end: number }>();
      let offset = 0;
      for (const seg of segs) {
        const len = Array.from(seg.text).length;
        inner.set(seg.id, { start: offset, end: offset + len });
        offset += len;
      }
      m.set(cid, inner);
    }
    return m;
  }, [segmentsByChapter]);


  // 跨章统一拼音字号：按章算（邻章最长拼音可能异于锚章，避免溢出 1em 格）
  // ★ 2026-10-09：改经 `chapterMaxPinyinLenOf`（带 LRU + 章级签名缓存）。
  //   原实现内联 `PinyinService.annotate` ⇒ 每次 segmentsByChapter 变更都对全部
  //   已载章全量重算（无缓存）⇒ ⑫ 装配空窗根因之一。
  const unifiedPinyinFontSizeByChapter = useMemo(() => {
    const m = new Map<string, number | undefined>();
    for (const [cid, segs] of segmentsByChapter) {
      if (!pinyinOn) {
        m.set(cid, undefined);
        continue;
      }
      const max = chapterMaxPinyinLenOf(cid, segs);
      m.set(cid, max < 1 ? undefined : unifiedPinyinFontSizeFor(fontSize, max));
    }
    return m;
  }, [segmentsByChapter, pinyinOn, fontSize, chapterMaxPinyinLenOf]);

  // 锚章的统一拼音字号直接取自同一映射（原实现另跑一遍全章注音 ⇒ 成本翻倍）
  const unifiedPinyinFontSize = pinyinOn
    ? unifiedPinyinFontSizeByChapter.get(activeChapterId)
    : undefined;

  // ── 划线（R2d，跨章）：为所有可见章装载划线/笔记（拼接场景下邻章也显高亮）──
  const addNote = useNoteStore((st) => st.addNote);
  const updateNoteContent = useNoteStore((st) => st.updateNoteContent);
  const removeNote = useNoteStore((st) => st.removeNote);
  const [highlightsByChapter, setHighlightsByChapter] = useState<Map<string, Highlight[]>>(new Map());
  const [notesByChapter, setNotesByChapter] = useState<Map<string, Map<string, { id: string; content: string }>>>(new Map());
  const [highlightSheet, setHighlightSheet] = useState<
    | { mode: 'create'; chapterId: string; segmentId: string; text: string }
    | { mode: 'view'; highlight: Highlight }
    | null
  >(null);

  // 可见章集合变化 → 补拉缺失章的划线/笔记（同步读 db；hlRef 防重拉；cancelled 防 StrictMode 竞态）
  const hlRef = useRef(highlightsByChapter);
  hlRef.current = highlightsByChapter;
  const loadedChaptersKey = loadedChapters.join('|');
  useEffect(() => {
    if (!bookId) {
      return;
    }
    let cancelled = false;
    for (const cid of loadedChapters) {
      if (hlRef.current.has(cid)) {
        continue;
      }
      const res = StorageService.getHighlights(bookId, cid);
      const notesRes = StorageService.getNotes(bookId, cid);
      if (cancelled) {
        return;
      }
      const arr = res.success && res.data ? res.data : [];
      setHighlightsByChapter((prev) => (prev.has(cid) ? prev : new Map(prev).set(cid, arr)));
      const map = new Map<string, { id: string; content: string }>();
      for (const n of notesRes.success && notesRes.data ? notesRes.data : []) {
        if (n.highlightId) {
          map.set(n.highlightId, { id: n.id, content: n.content });
        }
      }
      setNotesByChapter((prev) => (prev.has(cid) ? prev : new Map(prev).set(cid, map)));
    }
    return () => {
      cancelled = true;
    };
  }, [bookId, loadedChaptersKey]);

  // 章 id → 段 id → 划线组（renderItem 行级取用；跨章按 line.chapterId 查）
  const segmentHighlightByChapter = useMemo(() => {
    const m = new Map<string, Map<string, Highlight[]>>();
    for (const [cid, arr] of highlightsByChapter) {
      const inner = new Map<string, Highlight[]>();
      for (const h of arr) {
        const list = inner.get(h.segmentId);
        if (list) {
          list.push(h);
        } else {
          inner.set(h.segmentId, [h]);
        }
      }
      m.set(cid, inner);
    }
    return m;
  }, [highlightsByChapter]);

  /**
   * 长按动作菜单状态（2026-10-08 用户裁定）。
   * ★ 长按是**唯一**的显式文字入口：点击已不再触发任何动作（滚动模式的
   *   单击翻屏与全模式的点字查字典两个入口都取消）。故这里一次承载
   *   「查字典 / 划线本段 / 朗读本段」，以免「新建划线」失去入口
   *   （选区 UI 已在 2026-09-22 清理中整体移除，长按原先是它的唯一入口）。
   */
  const [charMenu, setCharMenu] = useState<
    { chapterId: string; segmentId: string; char: string; text: string } | null
  >(null);
  const closeCharMenu = useCallback(() => setCharMenu(null), []);

  const handleLongPressChar = useCallback(
    (seg: TextSegment, chapterId: string) => (index: number) => {
      const ch = Array.from(seg.text)[index];
      if (!ch) {
        return;
      }
      setCharMenu({ chapterId, segmentId: seg.id, char: ch, text: seg.text });
    },
    [],
  );

  const handleCharMenuLookup = useCallback(() => {
    if (!charMenu) {
      return;
    }
    setCharMenu(null);
    navigation?.navigate('DictLookup', { headword: charMenu.char });
  }, [charMenu, navigation]);

  const handleCharMenuHighlight = useCallback(() => {
    if (!charMenu) {
      return;
    }
    setCharMenu(null);
    setHighlightSheet({
      mode: 'create',
      chapterId: charMenu.chapterId,
      segmentId: charMenu.segmentId,
      text: charMenu.text,
    });
  }, [charMenu]);

  /**
   * 点按已有划线 → 查看/编辑面板。
   * ★ 划线是**显式视觉目标**（上屏有底色），点它属于「指哪打哪」，保留点按语义；
   *   被取消的是「点正文空白/无标记的字也有动作」那类隐式触发。
   * 第二参 `pageX` 已无消费方（分区问询随单击翻屏一并删除），签名保留以兼容
   * `PinyinText.onPressHighlight` 的透传契约（该签名被 `readerFreeSelection.test.ts`
   * 逐字冻结，禁改）。
   */
  const handleViewHighlight = useCallback((h: Highlight) => {
    setHighlightSheet({ mode: 'view', highlight: h });
  }, []);

  const handleCreateHighlight = useCallback(
    (color: HighlightColor, noteText: string) => {
      if (!highlightSheet || highlightSheet.mode !== 'create' || !bookId) {
        return;
      }
      const cid = highlightSheet.chapterId;
      const text = highlightSheet.text;
      const h = buildSegmentHighlight(bookId, cid, highlightSheet.segmentId, text, color);
      const res = StorageService.saveHighlight(h);
      if (!res.success) {
        setError(res.error ?? '保存划线失败');
        setHighlightSheet(null);
        return;
      }
      let stored = h;
      if (noteText) {
        const noteId = addNote({
          bookId,
          chapterId: cid,
          segmentId: highlightSheet.segmentId,
          startOffset: 0,
          endOffset: h.endOffset,
          content: noteText,
          highlightId: h.id,
        });
        if (noteId) {
          // 回写 noteId：INSERT OR REPLACE 全字段覆盖（划线-笔记双向可查）
          stored = { ...h, noteId };
          StorageService.saveHighlight(stored);
        }
      }
      setHighlightsByChapter((prev) => {
        const next = new Map(prev);
        const arr = next.get(cid) ?? [];
        next.set(cid, [stored, ...arr]);
        return next;
      });
      setHighlightSheet(null);
    },
    [highlightSheet, bookId, addNote],
  );

  /** view 态存笔记：无笔记 → 新建并回写 noteId；有 → 更新内容（按划线所属章） */
  const handleNoteSubmit = useCallback(
    (content: string) => {
      if (!highlightSheet || highlightSheet.mode !== 'view' || !bookId || !content) {
        return;
      }
      const hl = highlightSheet.highlight;
      const cid = hl.chapterId;
      const existing = notesByChapter.get(cid)?.get(hl.id);
      if (existing) {
        updateNoteContent(existing.id, content);
        setNotesByChapter((prev) => {
          const next = new Map(prev);
          const m = new Map(next.get(cid));
          m.set(hl.id, { id: existing.id, content });
          next.set(cid, m);
          return next;
        });
      } else {
        const noteId = addNote({
          bookId,
          chapterId: cid,
          segmentId: hl.segmentId,
          startOffset: hl.startOffset,
          endOffset: hl.endOffset,
          content,
          highlightId: hl.id,
        });
        if (noteId) {
          StorageService.saveHighlight({ ...hl, noteId });
          setHighlightsByChapter((prev) => {
            const next = new Map(prev);
            const arr = next.get(cid) ?? [];
            next.set(cid, arr.map((x) => (x.id === hl.id ? { ...x, noteId } : x)));
            return next;
          });
          setNotesByChapter((prev) => {
            const next = new Map(prev);
            const m = new Map(next.get(cid));
            m.set(hl.id, { id: noteId, content });
            next.set(cid, m);
            return next;
          });
        }
      }
      setHighlightSheet(null);
    },
    [highlightSheet, bookId, notesByChapter, addNote, updateNoteContent],
  );

  const handleDeleteHighlight = useCallback(
    (id: string) => {
      // 级联：删笔记再删划线（按划线所属章定位，跨章安全）
      let cid: string | undefined;
      highlightsByChapter.forEach((arr, c) => {
        if (arr.some((h) => h.id === id)) {
          cid = c;
        }
      });
      const note = cid ? notesByChapter.get(cid)?.get(id) : undefined;
      if (note) {
        removeNote(note.id);
        setNotesByChapter((prev) => {
          const next = new Map(prev);
          const m = new Map(next.get(cid!));
          m.delete(id);
          next.set(cid!, m);
          return next;
        });
      }
      const res = StorageService.deleteHighlight(id);
      if (res.success && cid) {
        setHighlightsByChapter((prev) => {
          const next = new Map(prev);
          const arr = next.get(cid!) ?? [];
          next.set(cid!, arr.filter((h) => h.id !== id));
          return next;
        });
      }
      setHighlightSheet(null);
    },
    [highlightsByChapter, notesByChapter, removeNote],
  );

  // ── 翻页（page 模式）：章分页 + 左右热区；scroll 模式零改动 ──
  const [viewportHMeasured, setViewportH] = useState(0);
  // Android「onLayout 仅在布局变化时派发」：二次挂载同尺寸 View 不再回调
  // ⇒ viewportHMeasured 恒 0、翻页死。兜底 = 窗高 − 顶栏(52) − 底栏(39)
  // （52/39 为本轮真机实测稳定值）；onLayout 真值到达时覆盖兜底。
  const viewportH = viewportHMeasured || Math.round(windowHeight) - 52 - 39;

  /**
   * 滚动跨章提交的保留集：**行数预算邻域 ∪ 视口实际覆盖的章**（而非固定三章）。
   *
   * ★ 2026-10-08 真机根因（探针实证）：短章书（道德经 ~6 行/章）下固定三章
   *   ≈ 18 行 < 一屏（~22 行）⇒ 裁剪瞬间 `contentH < viewportH` ⇒ 原生
   *   `maxScroll = 0` ⇒ 滚动位置被**原生**钳到 0（表现为：下滚中突然跳回窗口
   *   顶部、章节栏回跳、并露出「上一章加载中…」占位）。该瞬间补偿算式本身
   *   是对的（锚行 62→7、delta=-1595、记账 target=252），坏的是「内容比视口高」
   *   这一几何前提 ⇒ 保留集必须按行数预算取。
   * 几何未就绪（行高/视口为 0）或中心不在已载链内时，退回三章策略。
   *
   * ★★ 2026-10-14 真机判决：**视口覆盖集这一修法无效**（A/B 同起点对照，两臂都出 prepend）。
   *
   * ⚠⚠ **本段曾按「已修好」写，现按「已判决无效」重写（2026-10-14 清理旧结论时改）。
   * 旧文字里的读数来自**已丢失的载体**（161MB epub / 980 章 / 单章行数中位 133），
   * 且把「视口覆盖」当成有效修法 —— **该结论已被同日的 A6 / B2 两轮真机 A/B 推翻**，
   * 下面「实测读数」一段是那两轮的原始记录，保留只为可追溯，**不要再当依据引用**。
   *
   * ## 当时实测到的事实（仍成立的部分）
   *
   * 闪烁 100% 来自 prepend，append 的 delta 恒 0：
   * ```
   *   append  ⇒ anchorIdx 不变 ⇒ delta = 0
   *   prepend  ⇒ delta = 整章高度（数百行 / 数万 px）
   * ```
   * prepend 的链条（**这一段仍是当前源码事实**）：
   * ```
   *   跨章 A → B ⇒ windowRecenter(win, B, retain) ⇒ A 若不在 retain 里就出门
   *     └─ handleScrollCommit 里 fillNeighborsRef.current({forceNext:true, forcePrev:true})
   *        ← ★★ 无条件 forcePrev ⇒ A 被补回，插在 B 上方 = prepend
   * ```
   *
   * ★★ **真因是上面那个无条件 `forcePrev`**，不是「保留集退化」：
   *   B2 实测 `chainEqActive = (loadedChapters[0] === activeChapterId)` 在**加下限之前
   *   那一版就已经是 false**（那一版 `keep=2`，覆盖集已保住前章）⇒
   * 「链首==锚章 ⇒ needPrev 恒真」这条根因**在本载体上从来没成立过**。
   *   同一份分析里我曾同时写「不靠 forcePrev 也会补」和「forcePrev 是正常预取」两句
   *   自相矛盾的话，**真机读数站在前者的反面**。
   *
   * ## 当前内置书载体的真实量级（2026-10-14 全量离线实测，取代旧 epub 读数）
   *
   * 量法：取设备上 77 本内置书正文（`Android/data/<pkg>/files/guoxue-books/builtin/`
   * 共 3441 章），按**运行时同一口径**算行数 —— `@@CH@@` 行切章 → `toParagraphs`
   * → 每段 `ceil(码点/charsPerLine)` → scroll 模式 +1 标题行。
   * `charsPerLine` 是运行期量（`floor(containerWidth/cellAdvance)`），
   * 故按 cpl ∈ [10,20] 给**区间**而非单值：
   *
   * | 量 | 旧读数（已丢失的 epub 载体，单本书） | 当前实测（77 本 / 3441 章） |
   * |---|---|---|
   * | 单章行数中位 | 133 | 跨书中位 **52–96**（随 cpl 20→10） |
   * | 单章 > budget(78) 的书 | 该书 97.7% | **44–55 / 77** |
   * | 长章书 | 未分类 | `tongjian` p50 **723–1134**，`>78` 恒 **100%** |
   * | 短章书（< 一屏 22 行） | 道德经「每章约 6 行」 | **11 / 77**（`guanzi` p50=1、`songci` p50=10、`daodejing` p50=7 …） |
   *
   * ⇒ 旧读数「单章行数中位 133」**只对那一本书成立**，不是本仓的量级常数。
   * ⇒ 真实图景是**双峰**：短章书（p50 ≤ 16）与长章书（p50 ≥ 723）之间几乎没有书。
   * ⇒ 因此「预算恒失效」「预算是根因」这类判断**不能跨载体搬运**：
   *    在长章书成立（tongjian 单章 ≫ budget ⇒ 扩张循环不执行），
   *    在短章书**必须**靠预算（否则 contentH < viewportH ⇒ 原生 maxScroll=0）。
   *
   * ⚠ 上表只描述**行数量级**，不构成「视口覆盖修法有效」的依据 ——
   *   那一版已由 A6/B2 判决无效，**下一版方向见 `deliverables/flick-fixB2-2026-10-14/README.md`**。
   * ⚠ 别再引「单章行数中位 133」和「161MB epub / 980 章」：载体已被 `pm clear` 删除，
   *   `/sdcard` 无源文件，**不可恢复**，换载体后那些数字不再可测。
   *
   * @param topLineIndex 视口顶行在拼接序列中的全局下标。由 `handleScrollCommit` 的
   *        `firstLine`（ScrollMode 传的是 `firstContentLineOf(cur, ownerIdx)`，即视口顶行
   *        归属行）现场算出 ⇒ **无需新增任何跨文件回调**。
   *        ★ 找不到（-1）时该函数退回纯预算集，不猜（见 `retainIdsForViewport` 的不变式 3）。
   */
  const retainForScrollCommit = useCallback(
    (cid: string, topLineIndex: number): Set<string> => {
      const rowH = geometry.rowHeight;
      const lpp = Math.max(1, Math.floor(viewportH / Math.max(1, rowH)));
      const budget = SCROLL_WINDOW_KEEP_SCREENS * lpp;
      if (!(budget > 0) || !loadedChapters.includes(cid)) {
        return retainSetFor(cid);
      }
      // ★★ 上方余量必须 ≥1 屏（2026-10-14 同日自纠）：跨章提交那一刻视口**全在新章内**
      //   （ownerLine 已切到新章 ⇒ topLineIndex = 新章首行）⇒ 纯视口语义与旧章不相交
      //   ⇒ 旧章不被保留 ⇒ 立刻被 fillNeighbors 补回 ⇒ **自造 prepend 照旧**。
      //   余量 1 屏 ⇒ 覆盖区 [top−lpp, top+lpp) 跨过界 ⇒ 旧章被保留。
      //   ⚠⚠ 2026-10-14 B2 判决：余量从 1 屏加到 6 屏**实测无改善**
      //     （同起点对照 A 臂 err=795 / B 臂 err=952，均出 prepend）。
      //     ⇒ 余量大小**不是**这里的杠杆；杠杆在 `handleScrollCommit` 的无条件 `forcePrev`。
      //     ⇒ 现值只是「不引入新量纲」的占位，**不要再靠调它治病**，也不要凭感觉上调。
      return retainIdsForViewport(
        cid,
        loadedChapters,
        (id) => stitched.lineCountOf.get(id) ?? 0,
        topLineIndex,
        lpp,
        budget,
        SCROLL_WINDOW_KEEP_SCREENS * lpp,
      );
    },
    [geometry.rowHeight, viewportH, loadedChapters, stitched, retainSetFor],
  );

  // ── 填满视口 + 前瞻装载（R3-stitch 补强）：
  // 短章书 stitched 总高 < 视口 ⇒ 无可滚距离、handleScrollEnd 不触发 ⇒ 邻章永不装载 ⇒ 末章后空白断档；
  // 长章书在接近章界前把下一章 body 预载进窗，避免边界空白。
  // 触发：①win/stitched 变更（初始填满）；②每次滚动停止（临近链尾/链首续装）。
  // ★ begin 必须基于 winRef 同步算好再 setWin：React 状态 updater 不保证同步执行，
  //   「updater 里置旗标、setWin 后立刻读」恒 false ⇒ 只 begin 不装载 ⇒
  //   章卡死 inflight、prewarm 也被 isLoading 闸门跳过（真机复测实录）。
  // 邻章装载失败集合（state，驱动占位 UI 显示「加载失败」）。★ 语义与旧版不同：
  // 旧 fillFailedRef 是「永久黑名单」（失败后 has() 跳过 ⇒ 用户永久卡死、零反馈）；
  // 现只作「失败态展示」，不阻断重试——重试去重仍由 windowBegin 闸门保证
  // （失败已 windowFail 清 inflight ⇒ 下次滚动到边沿可重新 windowBegin）。
  const [fillFailed, setFillFailed] = useState<ReadonlySet<string>>(new Set());
  const fillNeighbors = useCallback(
    (opts?: { forceNext?: boolean; forcePrev?: boolean }) => {
    if (readerMode !== 'scroll' || !geometry.rowHeight || !viewportH) {
      return;
    }
    const rowH = geometry.rowHeight;
    const totalH = stitched.lines.length * rowH;
    // 需求：①总量不足 2 屏（初始填满）②距链尾不足 1 屏（前瞻，画布模式由 onNearBoundary
    //   上抛 force——画布内部知道滚动位置）③链首==锚章（上方无章可看时装 1 个 prev；
    //   按「链首==锚章」判而非滚动位置——否则 prepend+补偿恒把锚章顶回视口顶 ⇒ 无限向前装载整本书）
    const needNext = opts?.forceNext === true || totalH < viewportH * 2;
    const needPrev = opts?.forcePrev === true || loadedChapters[0] === activeChapterId;
    if (!needNext && !needPrev) {
      return;
    }
    const targets: string[] = [];
    const last = loadedChapters[loadedChapters.length - 1];
    const first = loadedChapters[0];
    if (needNext && last) {
      const s = TextLibraryService.getSiblingChapters(last);
      if (s.success && s.data?.next) {
        targets.push(s.data.next.id);
      }
    }
    if (needPrev && first) {
      const s = TextLibraryService.getSiblingChapters(first);
      if (s.success && s.data?.prev) {
        targets.push(s.data.prev.id);
      }
    }
    if (targets.length === 0) {
      return;
    }
    let nw = winRef.current;
    const toLoad: string[] = [];
    for (const id of targets) {
      if (windowHas(nw, id) || windowIsLoading(nw, id)) {
        continue;
      }
      const b = windowBegin(nw, id);
      if (b) {
        nw = b;
        toLoad.push(id);
      }
    }
    if (toLoad.length === 0) {
      return;
    }
    setWin(nw);
    void (async () => {
      for (const id of toLoad) {
        try {
          const data = await loadChapterData(id);
          setFillFailed((prev) => {
            if (!prev.has(id)) {
              return prev;
            }
            const s = new Set(prev);
            s.delete(id);
            return s;
          });
          setWin((w) => windowPut(w, id, data));
          prewarmChapter(data, id);
        } catch {
          setFillFailed((prev) => {
            if (prev.has(id)) {
              return prev;
            }
            const s = new Set(prev);
            s.add(id);
            return s;
          });
          setWin((w) => windowFail(w, id));
        }
      }
    })();
  }, [readerMode, geometry.rowHeight, viewportH, stitched, loadedChapters, activeChapterId, loadChapterData, prewarmChapter]);
  useEffect(() => {
    fillNeighbors();
  }, [fillNeighbors]);

  // ── 原生 FlatList 滚动模式（stitched.lines 平铺行流直接作 data）──
  // 书级边界：窗口首/末章的相邻章存在性
  const hasMorePrev = useMemo(() => {
    const first = loadedChapters[0];
    if (!first) return false;
    const s = TextLibraryService.getSiblingChapters(first);
    return s.success && !!s.data?.prev;
  }, [loadedChapters]);
  const hasMoreNext = useMemo(() => {
    const last = loadedChapters[loadedChapters.length - 1];
    if (!last) return false;
    const s = TextLibraryService.getSiblingChapters(last);
    return s.success && !!s.data?.next;
  }, [loadedChapters]);
  // 边沿邻章装载失败态（驱动 ScrollMode 占位显示「加载失败，滑动重试」）：
  // next=true 表示窗口末章的 next 章已尝试且失败；prev 同理。失败不阻断重试
  // （下次滚动到边沿会重新 windowBegin），仅改变占位文案。
  const loadError = useMemo(() => {
    const last = loadedChapters[loadedChapters.length - 1];
    const first = loadedChapters[0];
    let next = false;
    let prev = false;
    if (last) {
      const s = TextLibraryService.getSiblingChapters(last);
      if (s.success && s.data?.next) {
        next = fillFailed.has(s.data.next.id);
      }
    }
    if (first) {
      const s = TextLibraryService.getSiblingChapters(first);
      if (s.success && s.data?.prev) {
        prev = fillFailed.has(s.data.prev.id);
      }
    }
    return { next, prev };
  }, [loadedChapters, fillFailed]);
  const handleScrollCommit = useCallback(
    (chapterId: string, firstLine: Line | undefined) => {
      if (!firstLine) {
        return;
      }
      if (chapterId !== activeChapterId) {
        // 跨章提交：切 store 章（记精确码点真值）+ 滑窗锚点跟随 + 裁窗。
        // ★ 裁窗本身不做滚动补偿——补偿由 ScrollMode 按「视口顶行锚点」的
        //   下标位移统一补（scrollAnchor.ts / 2026-10-08 真机修复 ③）：
        //   裁窗/前插/前删都表现为 lines 数组的行下标位移，一个算式全覆盖。
        // ★★ 2026-10-14：`firstLine` 就是**视口顶行**（ScrollMode 传的
        //   `firstContentLineOf(cur, ownerIdx)`），现场求出其全局下标交给
        //   `retainForScrollCommit` —— 保留集并入视口覆盖集 ⇒ 上一章不出门
        //   ⇒ 不补装 ⇒ prepend 消失 ⇒ delta = 0。找不到（-1）时该函数
        //   退回纯预算集（等于原行为），不猜。
        const topLineIndex = firstLine ? indexOfLineKey(stitched.lines, lineKeyOf(firstLine)) : -1;
        openChapter(bookId, chapterId, firstLine.segmentId, undefined, firstLine.charStart);
        centerRef.current = chapterId;
        setActiveChapterId(chapterId);
        setWin((w) => windowRecenter(w, chapterId, retainForScrollCommit(chapterId, topLineIndex)));
      }
      recordProgress(firstLine.segmentId, undefined, firstLine.charStart);
      setSegment(firstLine.segmentId);
      // 跨章即预载邻章（fillNeighbors 幂等，「链首==锚章」保护在普通路径生效，
      // force 仅触发一次装载尝试）
      fillNeighborsRef.current({ forceNext: true, forcePrev: true });
    },
    [
      activeChapterId,
      bookId,
      openChapter,
      recordProgress,
      setSegment,
      retainForScrollCommit,
      // ★ 2026-10-14：`stitched.lines` 用于现场求顶行下标。漏了它 ⇒ stale closure
      //   ⇒ 顶行下标按**旧数据**算（新 prepend 后下标已位移）⇒ 视口覆盖判定偏移。
      //   代价：跨章提交时本函数身份随 stitched 变化（stitched 只在 win/geometry 变时变，
      //   非每帧）⇒ 重建频率可接受。
      stitched.lines,
    ],
  );

  // 热区 bottom 让位底栏：热区 absolute 于 listWrap，若压到 footer 两端按钮，
  // 章间导航被透明层吞 tap（真机实证：footer 按钮在热区 bounds 内全程无响应）
  const [footerH, setFooterH] = useState(0);
  const footerHEff = footerH || 39;

  // ── 续读定位（L2，开环）：路由 charOffset > 持久化 charOffset > segmentId > 章首 ──
  // scroll 模式：定位落在「拼接序列」中锚章首行 + 章内行下标；page 模式：章内行下标。
  // 路由参数只对「参数所属章」生效（归属保护，见上）。
  const initialCharOffset = useMemo(() => {
    const routeOwned = params?.chapterId === activeChapterId;
    const routeOffset = routeOwned ? params?.charOffset : undefined;
    if (typeof routeOffset === 'number' && routeOffset >= 0) {
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
  }, [params, activeChapterId, bookId, lastRead]);

  const initialLineIndex = useMemo(() => {
    if (layout.lines.length === 0) {
      return 0;
    }
    const within = lineAtCharOffset(layout.lines, initialCharOffset);
    let withinIdx = within < 0 ? 0 : within;
    // 章内行下标兜底：路由 segmentId（无 charOffset 时）
    if (withinIdx === 0) {
      const routeOwned = params?.chapterId === activeChapterId;
      const routeSegmentId = routeOwned ? params?.segmentId : undefined;
      if (routeSegmentId) {
        const idx = layout.lines.findIndex((l) => l.segmentId === routeSegmentId);
        if (idx >= 0) {
          withinIdx = idx;
        }
      }
    }
    const clampWithin = Math.min(Math.max(withinIdx, 0), layout.lines.length - 1);
    if (readerMode === 'scroll' && stitched.lines.length > 0) {
      const first = stitched.firstLineOf.get(activeChapterId) ?? 0;
      return first + clampWithin;
    }
    return clampWithin;
    // initialScrollIndex 只在挂载时生效；滚动模式锚点滑动不重挂载（listKey 见下），
    // 跨章连续性由 ScrollMode 的锚点补偿保障（该补偿在 ScrollMode 内，不在此）。
  }, [layout, initialCharOffset, readerMode, stitched, activeChapterId, params]);

  // scroll 模式锚点滑动不重挂载：listKey 不含 activeChapterId（保持 data 原地更新，
  // 视觉位置由 ScrollMode 的锚点补偿维持）；其余模式跳章/切模式走 switchSeq 触发重挂载。
  // ★ 2026-10-08 修正：原注释写「补偿 effect 维持」，但那时的补偿**并不存在**
  //   （stitch.compensationDelta 生产零消费）⇒ 真机表现为打开非首章整体偏一个整屏、
  //   上滚跨章倒退两点几章。现由 ScrollMode 按视口顶行锚点补偿。
  const listKey = readerMode === 'scroll' ? `scroll:${switchSeq}` : `${readerMode}:${activeChapterId}:${switchSeq}`;

  // flip 模式（cover/slide/none）挂载定位页号：章内行下标 → 页号（与 FlipMode 内
  // paginateChapter 同式：linesPerPage = floor(viewportH / rowHeight)）
  const flipInitialPage = useMemo(() => {
    const rowH = Math.max(1, geometry.rowHeight);
    const linesPerPage = Math.max(1, Math.floor(viewportH / rowH));
    return Math.floor((initialLineIndex > 0 ? initialLineIndex : 0) / linesPerPage);
  }, [initialLineIndex, viewportH, geometry.rowHeight]);

  // scroll 模式章内进度（ScrollMode onLineChange：滚动静止后上报，码点真值）
  const handleScrollLineChange = useCallback(
    (line: Line | undefined) => {
      if (!line) {
        return;
      }
      recordProgress(line.segmentId, undefined, line.charStart);
      setSegment(line.segmentId);
    },
    [recordProgress, setSegment],
  );

  // 边沿前瞻（ScrollMode onNearBoundary）：临近窗口已载边沿 → 续装邻章
  const fillNeighborsRef = useRef(fillNeighbors);
  fillNeighborsRef.current = fillNeighbors;
  const handleNearBoundary = useCallback((dir: 'prev' | 'next') => {
    fillNeighborsRef.current(dir === 'next' ? { forceNext: true } : { forcePrev: true });
  }, []);

  // ── 查字入口：已改挂长按菜单（见 handleCharMenuLookup）──
  // 2026-10-08（用户裁定）：点字不再查字典。原「点按汉字 → DictLookup」链路
  // （handlePressChar + ScrollMode.charTapIntercept 分区问询）整体删除 ——
  // 二者是同一根因（给「点」赋动作语义），留着任何一个都会让点按仍起作用。
  // 「点」在连读场景里的本义是重新定位视线，误触率高于收益。

  // 列命中 → 语义分流已下沉到 renderItem 的 LineRow.onPressChar（原生 FlatList 版）。

  // ── 章间导航（R2b2：滑窗就地切换，不再路由重导航）──
  const siblings = useMemo(() => {
    if (!activeChapterId) {
      return {};
    }
    const res = TextLibraryService.getSiblingChapters(activeChapterId);
    return res.success ? res.data ?? {} : {};
  }, [activeChapterId]);

  /**
   * 就地切换章：命中窗缓存零加载直切；未命中 recenter（清窗+陈旧丢弃）后
   * 经 begin 闸门装载。目标未就绪期间渲染 spinner（不清屏旧章内容由
   * loaded=null 分支统一处理），预取命中时用户无感。
   */
  const jumpTo = useCallback(
    (cid: string) => {
      if (!cid || cid === centerRef.current) {
        return;
      }
      const retain = retainSetFor(cid);
      centerRef.current = cid;
      setActiveChapterId(cid);
      setSwitchSeq((s) => s + 1);
      // 装载判定用合并前窗：recenter 只裁剪不新增，begin 判定结果与合并后一致
      const before = winRef.current;
      const needLoad = !windowHas(before, cid) && !windowIsLoading(before, cid);
      setWin((w) => {
        const rw = windowRecenter(w, cid, retain);
        return needLoad ? (windowBegin(rw, cid) ?? rw) : rw;
      });
      if (needLoad) {
        void (async () => {
          try {
            const data = await loadChapterData(cid);
            setWin((w) => windowPut(w, cid, data));
            prewarmChapter(data, cid);
          } catch {
            setWin((w) => windowFail(w, cid));
          }
        })();
      }
    },
    [loadChapterData, retainSetFor, prewarmChapter],
  );

  // ── 目录（TOC，2026-10-08）：顶栏点章节名 → 目录弹层 → 点章名跳章 ──
  // 数据源 = **书体章列表**（TextLibraryService.getBook），不是当前滑动窗口：
  // 内置书启动即注册「目录元数据」（chapters 含 id/title/order、segments 空）
  // ⇒ 目录**不需要水合正文**，打开目录不触发任何 IO 与大对象分配。
  const [tocVisible, setTocVisible] = useState(false);
  const tocItems = useMemo(() => {
    if (!bookId) {
      return [];
    }
    const res = TextLibraryService.getBook(bookId);
    return res.success && res.data ? buildTocItems(res.data.chapters) : [];
  }, [bookId]);
  /** 目录弹层高度：0.7 窗高，下限 320（矮屏下若只剩两三行，长书等于不可用） */
  const tocHeight = Math.max(320, Math.round(windowHeight * 0.7));
  const openToc = useCallback(() => setTocVisible(true), []);
  const closeToc = useCallback(() => setTocVisible(false), []);

  /**
   * 目录点章 → 就地跳章。★ 复用 `jumpTo`（与底栏上一章/下一章、翻页边界同一
   * 路径），不另造一套：它会 bump `switchSeq` ⇒ `listKey` 变化 ⇒ 三种模式都按
   * 「目标章首行」重挂载（`initialLineIndex` 在无 route charOffset/lastRead 时
   * 落 0）⇒ 落到章首。点当前章时 `jumpTo` 自身早退（`cid === centerRef.current`），
   * 只关窗、不产生无谓重挂载。
   */
  const handleTocSelect = useCallback(
    (cid: string) => {
      setTocVisible(false);
      jumpTo(cid);
    },
    [jumpTo],
  );

  // flip 模式边界 → 章间导航（react-native-reader onBoundaryPrev/Next 语义）
  const handleFlipBoundaryPrev = useCallback(() => {
    if (siblings.prev) {
      jumpTo(siblings.prev.id);
    }
  }, [siblings.prev, jumpTo]);
  const handleFlipBoundaryNext = useCallback(() => {
    if (siblings.next) {
      jumpTo(siblings.next.id);
    }
  }, [siblings.next, jumpTo]);

  // ── 行渲染（跨章：按 line.chapterId 取本篇章段/跨度/高亮/拼音字号）──
  const renderItem = useCallback(
    ({ item }: { item: Line }) => {
      // 拼接章标题行：独立于正文 seg，走标题样式（连读章界分隔）
      if (item.isTitle) {
        const title = chapterTitleByChapter.get(item.chapterId) ?? '';
        return (
          <View style={[styles.stitchTitleRow, { height: geometry.rowHeight }]}>
            <Text style={[styles.stitchTitleText, { color: colors.text }]} numberOfLines={1} allowFontScaling={false}>
              {title}
            </Text>
          </View>
        );
      }
      const seg = segmentsByChapter.get(item.chapterId)?.find((s) => s.id === item.segmentId);
      if (!seg) {
        return null;
      }
      const span = segmentSpanByChapter.get(item.chapterId)?.get(item.segmentId);
      const segStart = span?.start ?? 0;
      // ★ 刻意**不传** onPressChar（2026-10-08 用户裁定）：LineRow/PinyinText 上
      //   该 prop 是可选出口，不传 ⇒ 未划线字的点按不产生任何动作。
      //   点按仍保留两处语义：①已划线字 → onPressHighlight（查看/编辑面板）
      //   ②长按 → onLongPressChar（动作菜单）。禁「顺手补上」查字回调——
      //   那会让「点」重新带上动作语义，本次改动即失效。
      return (
        <LineRow
          text={seg.text}
          charRange={[item.charStart - segStart, item.charEnd - segStart]}
          rowHeight={geometry.rowHeight}
          fontSize={fontSize}
          lineHeight={lineHeight}
          unifiedPinyinFontSize={unifiedPinyinFontSizeByChapter.get(item.chapterId) ?? unifiedPinyinFontSize}
          pinyinMode={pinyinMode}
          conversionMode={conversionMode}
          workId={item.chapterId}
          bookId={bookId}
          highlights={segmentHighlightByChapter.get(item.chapterId)?.get(item.segmentId)}
          onLongPressChar={handleLongPressChar(seg, item.chapterId)}
          onPressHighlight={handleViewHighlight}
        />
      );
    },
    [
      segmentsByChapter,
      segmentSpanByChapter,
      chapterTitleByChapter,
      geometry.rowHeight,
      fontSize,
      lineHeight,
      unifiedPinyinFontSizeByChapter,
      unifiedPinyinFontSize,
      pinyinMode,
      conversionMode,
      bookId,
      handleLongPressChar,
      segmentHighlightByChapter,
      handleViewHighlight,
    ],
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* 顶栏 */}
      <View style={[styles.header, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Pressable hitSlop={8} onPress={() => navigation?.goBack()} accessibilityLabel="返回">
          <Text style={[styles.backText, { color: colors.primary }]} allowFontScaling={false}>
            ‹ 返回
          </Text>
        </Pressable>
        <View style={styles.headerTitles}>
          <Text style={[styles.bookTitle, { color: colors.textSecondary }]} numberOfLines={1} allowFontScaling={false}>
            {loaded?.bookTitle ?? ''}
          </Text>
          {/* 点章节名 → 目录弹层（2026-10-08）。加 hitSlop：标题仅 15pt，
              字号档位调小后点击目标会窄到难以命中 */}
          <Pressable
            hitSlop={10}
            onPress={openToc}
            accessibilityRole="button"
            accessibilityLabel={`打开目录：${loaded?.chapter.title ?? ''}`}
          >
            <Text style={[styles.chapterTitle, { color: colors.text }]} numberOfLines={1} allowFontScaling={false}>
              {loaded?.chapter.title ?? ''}
            </Text>
          </Pressable>
        </View>
        <View style={styles.headerSpacer} />
      </View>

      {/* 正文：listWrap 包裹（onLayout 量视口高）。★ 2026-10-08：原先压在这里的
          左右 30% 透明热区已删除（兄弟覆盖层吞滚动手势），点按分区随之取消。 */}
      {error ? (
        <View style={styles.center}>
          <Text style={{ color: colors.textSecondary }}>{`加载失败：${error}`}</Text>
        </View>
      ) : !loaded ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : (readerMode === 'scroll' ? stitched.lines.length === 0 : layout.lines.length === 0) ? (
        <View style={styles.center}>
          <Text style={{ color: colors.textSecondary }}>本章暂无正文</Text>
        </View>
      ) : (
        <View
          style={styles.listWrap}
          onLayout={(e) => setViewportH(e.nativeEvent.layout.height)}
        >
        {/* ReaderCore：容器/模式路由（分层对齐 @tangfeifan/react-native-reader） */}
        <ReaderCore
          mode={readerMode}
          chapterId={activeChapterId}
          scroll={{
            listKey: listKey,
            lines: stitched.lines,
            hasMorePrev: hasMorePrev,
            hasMoreNext: hasMoreNext,
            initialChapterId: activeChapterId,
            initialLineIndex: initialLineIndex,
            geometry: geometry,
            viewportH: viewportH,
            contentInsets: { left: content.left, right: content.right },
            renderLine: (line) => renderItem({ item: line }),
            onChapterCommit: handleScrollCommit,
            onLineChange: handleScrollLineChange,
            onNearBoundary: handleNearBoundary,
            loadError: loadError,
          }}
          page={{
            layout: layout,
            geometry: geometry,
            viewportH: viewportH,
            contentInsets: { left: content.left, right: content.right },
            footerInset: footerHEff,
            renderItem: (line) => renderItem({ item: line }),
            initialLineIndex: initialLineIndex,
            listKey: listKey,
            onProgressCommit: (line) => {
              recordProgress(line.segmentId, undefined, line.charStart);
              setSegment(line.segmentId);
            },
          }}
          flip={{
            layout: layout,
            geometry: geometry,
            viewportH: viewportH,
            viewportW: windowWidth,
            contentInsets: { left: content.left, right: content.right },
            footerInset: footerHEff,
            pageBackgroundColor: colors.background,
            renderItem: (line) => renderItem({ item: line }),
            initialPage: flipInitialPage,
            listKey: listKey,
            onProgressCommit: (line) => {
              recordProgress(line.segmentId, undefined, line.charStart);
              setSegment(line.segmentId);
            },
            onBoundaryPrev: handleFlipBoundaryPrev,
            onBoundaryNext: handleFlipBoundaryNext,
          }}
        />
        </View>
      )}

      {/* 底栏：章间导航 */}
      {activeChapterId ? (
        <View
          style={[styles.footer, { backgroundColor: colors.card, borderColor: colors.border, elevation: 10 }]}
          onLayout={(e) => setFooterH(e.nativeEvent.layout.height)}
        >
          <Pressable
            hitSlop={8}
            disabled={!siblings.prev}
            onPress={() => siblings.prev && jumpTo(siblings.prev.id)}
          >
            <Text
              style={[styles.navText, { color: siblings.prev ? colors.primary : colors.textSecondary }]}
              numberOfLines={1}
              allowFontScaling={false}
            >
              {siblings.prev ? `‹ ${siblings.prev.title}` : '已是第一章'}
            </Text>
          </Pressable>
          <Pressable
            hitSlop={8}
            disabled={!siblings.next}
            onPress={() => siblings.next && jumpTo(siblings.next.id)}
          >
            <Text
              style={[styles.navText, styles.navNext, { color: siblings.next ? colors.primary : colors.textSecondary }]}
              numberOfLines={1}
              allowFontScaling={false}
            >
              {siblings.next ? `${siblings.next.title} ›` : '已是最后一章'}
            </Text>
          </Pressable>
        </View>
      ) : null}
      <HighlightActionSheet
        visible={highlightSheet !== null}
        onClose={() => setHighlightSheet(null)}
        mode={highlightSheet?.mode ?? 'create'}
        text={
          highlightSheet
            ? highlightSheet.mode === 'view'
              ? highlightSheet.highlight.text
              : highlightSheet.text
            : ''
        }
        highlight={highlightSheet?.mode === 'view' ? highlightSheet.highlight : undefined}
        note={
          highlightSheet?.mode === 'view'
            ? notesByChapter.get(highlightSheet.highlight.chapterId)?.get(highlightSheet.highlight.id)?.content ?? ''
            : ''
        }
        onCreate={handleCreateHighlight}
        onNoteSubmit={handleNoteSubmit}
        onDelete={handleDeleteHighlight}
      />
      {/* 长按动作菜单（点击已无动作 ⇒ 长按是唯一入口，见 handleLongPressChar） */}
      <CharActionMenu
        visible={charMenu !== null}
        onClose={closeCharMenu}
        char={charMenu?.char ?? ''}
        text={charMenu?.text ?? ''}
        onLookup={handleCharMenuLookup}
        onHighlight={handleCharMenuHighlight}
      />
      {/* 目录弹层：由顶栏章节名唤起（openToc） */}
      <ChapterTocSheet
        visible={tocVisible}
        onClose={closeToc}
        items={tocItems}
        currentChapterId={activeChapterId}
        onSelect={handleTocSelect}
        height={tocHeight}
      />
    </View>
  );
}

const EMPTY_SEGMENTS: TextSegment[] = [];

/** 章首标题形状（EPUB TOC 标题粗粒度时以正文自带章名为准） */
const HEADING_RE = /^\s*(第\s*[0-9一二两三四五六七八九十百千零〇]+\s*[章回节卷篇话则场折]|序章?|楔子|前言|序言|引言|后记|後記|番外|尾声|終章|终章|附录|附錄|导语|導讀|导读|题记|題記|说明)/;

/**
 * 滚动模式「跨章提交」保留窗口的行数预算（单位：屏）。
 * ★ 不可下调到 1：短章书下保留行数若 ≤ 一屏，裁剪后 contentH < viewportH
 *   ⇒ 原生 maxScroll = 0 ⇒ 滚动位置被钳到 0（2026-10-08 真机根因）。
 */
const SCROLL_WINDOW_KEEP_SCREENS = 6;
/** 首段是否自带章首标题：短行 + 常见章首形状 ⇒ 不另插（可能粗粒度的）TOC 标题行 */
function firstSegmentIsHeading(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= 30 && HEADING_RE.test(t);
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  list: {
    flex: 1,
  },
  listWrap: {
    flex: 1,
  },
  // 拼接章标题行（scroll 模式章界分隔；高=rowHeight 保 INV-G1 固定行高不变式）
  stitchTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  stitchTitleText: {
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backText: {
    fontSize: 16,
  },
  headerTitles: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  bookTitle: {
    fontSize: 12,
  },
  chapterTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  headerSpacer: {
    width: 44,
  },
  // ★ 2026-10-08 删除 tapZoneL/tapZoneR（左右 30% 透明翻页热区）：
  //   ① 滚动模式的热区已于 10-08 上午先行删除（兄弟覆盖层吞滚动手势）；
  //   ② 本批取消「点击翻页」后，两个样式对象在**全文件零引用** —— 留着会让
  //      下一个人以为还存在点按分区。真正承接翻页的是 PageMode 内部的
  //      Pressable（逐页模式的既有语义，未改动）。
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // 底栏挂壳级纵排（见 JSX 注）：container 被长章 FlatList 撑出屏的实证下，
  // 纵排兄弟是唯一恒贴屏底的结构；正文尾部 paddingBottom=footerH 让位。
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  navText: {
    fontSize: 14,
    maxWidth: 150,
  },
  navNext: {
    textAlign: 'right',
  },
});

export default ReaderScreen;
