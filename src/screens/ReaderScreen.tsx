/**
 * 阅读器主页面（ReaderScreen）— R1：单章可读（几何层驱动）
 *
 * 架构：docs/reader-architecture-2026-09-22.md（L1 行化几何 / L2 位置模型 /
 * L3b 行级渲染器）；行为对齐 docs/reader-legado-alignment-2026-09-23.md。
 *
 * 旧实现教训（本文件遵守的红线）：
 * - 行高恒定常量（L1），`getItemLayout` 为无表纯算式 ⇒ 定位开环，
 *   禁 `onLayout`/估算/MVCP 参与定位（INV-G4）；
 * - 滚动位置持久化 = 章内码点偏移（charOffset，与排版无关的位置真值），
 *   禁像素比例作真值；
 * - 注音数据就绪与否不改变行数与行高（U7，PinyinText 已删降级换结构支）；
 * - 一次只动一个变量：本轮只做单章 + 章间按钮导航，跨章滑窗/分片在 R2。
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import LineRow from '@/components/reader/LineRow';
import HighlightActionSheet from '@/components/reader/HighlightActionSheet';
import { TextLibraryService } from '@/services/TextLibraryService';
import { StorageService } from '@/services/StorageService';
import { UserBookService } from '@/services/UserBookService';
import { useReaderStore } from '@/store/useReaderStore';
import { useNoteStore } from '@/store/useNoteStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { getColors, type ThemeColors } from '@/theme';
import { charGapFor, getItemLayoutOf, layoutChapter, resolveGeometry, unifiedPinyinFontSizeFor, type Line } from '@/reader/geometry';
import { lineAtCharOffset, lineAtY } from '@/reader/position';
import { charOffsetAtY } from '@/reader/position';
import { offsetOfPage, pageAtOffset, paginateChapter } from '@/reader/pagination';
import {
  buildStitchedLines,
  compensationDelta,
  orderedRenderChapters,
} from '@/reader/stitch';
import { buildSegmentHighlight } from '@/reader/highlightFactory';
import { annotate, maxPinyinLength } from '@/services/PinyinService';
import { currentPolyphoneSalt } from '@/hooks/usePinyin';
import { prewarmPinyinCache } from '@/utils/pinyin';
import {
  createChapterWindow,
  windowBegin,
  windowFail,
  windowGet,
  windowHas,
  windowIsLoading,
  windowPut,
  windowRecenter,
  type ChapterWindow,
} from '@/reader/chapterWindow';
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

/** 页边距：注音模式收窄边距给行宽让位（用户裁定 T1=C1）；off 模式常规边距 */
const PAGE_MARGIN_PINYIN = 12;
const PAGE_MARGIN_PLAIN = 20;

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
  const colors: ThemeColors = getColors(theme);

  const innerListRef = useRef<FlatList | null>(null);

  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const pinyinOn = pinyinMode !== 'off';
  const pageMargin = pinyinOn ? PAGE_MARGIN_PINYIN : PAGE_MARGIN_PLAIN;
  const containerWidth = Math.max(0, windowWidth - pageMargin * 2);

  // ── 几何（L1）：档位 + 容器宽 → 行几何；字距与渲染器同源（charGapFor）──
  const geometry = useMemo(
    () =>
      resolveGeometry({
        fontSize,
        lineHeight,
        pinyinEnabled: pinyinOn,
        containerWidth,
        charGap: charGapFor(pinyinMode, fontSize),
      }),
    [fontSize, lineHeight, pinyinOn, pinyinMode, containerWidth],
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
      const ensure = await UserBookService.ensureBookLoaded(bookId);
      if (!ensure.success) {
        throw new Error(ensure.error ?? '书籍加载失败');
      }
      const chapterRes = TextLibraryService.getChapter(cid);
      if (!chapterRes.success || !chapterRes.data) {
        throw new Error(chapterRes.error ?? '章节不存在');
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
    () => buildStitchedLines(loadedChapters, (id) => layoutOfMap.get(id)),
    [loadedChapters, layoutOfMap],
  );
  const getItemLayout = useMemo(() => getItemLayoutOf(geometry), [geometry]);

  // ── 拼音字号全章统一（架构 §7.2 观感统一）：按章内最长拼音算一次，
  // 全章同一值，消除逐字自适应造成的同行大小/字重不齐（24px 档 gé=12px 混 yǒu=8px）。
  // 仅缩字形不改拼音槽高 ⇒ 行高恒等（INV-G1）不受影响；U7 不破坏：
  // 几何（行高/行数）不依赖此值，注音缺失时行仍按 rowHeight 渲染。
  const chapterMaxPinyinLen = useMemo(() => {
    if (!pinyinOn) {
      return 0;
    }
    let max = 0;
    for (const seg of segments) {
      const res = annotate(seg.text, pinyinMode, { workId: activeChapterId, bookId });
      if (res.success && res.data) {
        const len = maxPinyinLength(res.data);
        if (len > max) {
          max = len;
        }
      }
    }
    return max;
  }, [segments, pinyinOn, pinyinMode, activeChapterId, bookId]);
  const unifiedPinyinFontSize = useMemo(() => {
    if (!pinyinOn || chapterMaxPinyinLen < 1) {
      return undefined;
    }
    return unifiedPinyinFontSizeFor(fontSize, chapterMaxPinyinLen);
  }, [pinyinOn, chapterMaxPinyinLen, fontSize]);

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
  const unifiedPinyinFontSizeByChapter = useMemo(() => {
    const m = new Map<string, number | undefined>();
    for (const [cid, segs] of segmentsByChapter) {
      if (!pinyinOn) {
        m.set(cid, undefined);
        continue;
      }
      let max = 0;
      for (const seg of segs) {
        const res = annotate(seg.text, pinyinMode, { workId: cid, bookId });
        if (res.success && res.data) {
          const len = maxPinyinLength(res.data);
          if (len > max) {
            max = len;
          }
        }
      }
      m.set(cid, max < 1 ? undefined : unifiedPinyinFontSizeFor(fontSize, max));
    }
    return m;
  }, [segmentsByChapter, pinyinOn, pinyinMode, bookId, fontSize]);

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

  const handleLongPressChar = useCallback(
    (seg: TextSegment, chapterId: string) => () => {
      setHighlightSheet({ mode: 'create', chapterId, segmentId: seg.id, text: seg.text });
    },
    [],
  );

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

  // ── R3-2 翻页（page 模式）：章分页 + 左右热区；scroll 模式零改动 ──
  const [viewportHMeasured, setViewportH] = useState(0);
  // Android「onLayout 仅在布局变化时派发」：二次挂载同尺寸 View 不再回调
  // ⇒ viewportHMeasured 恒 0、翻页死。兜底 = 窗高 − 顶栏(52) − 底栏(39)
  // （52/39 为本轮真机实测稳定值）；onLayout 真值到达时覆盖兜底。
  const viewportH = viewportHMeasured || Math.round(windowHeight) - 52 - 39;
  // 热区 bottom 让位底栏：热区 absolute 于 listWrap，若压到 footer 两端按钮，
  // 章间导航被透明层吞 tap（真机实证：footer 按钮在热区 bounds 内全程无响应）
  const [footerH, setFooterH] = useState(0);
  const footerHEff = footerH || 39;
  const pagination = useMemo(
    () => paginateChapter(layout, geometry, viewportH),
    [layout, geometry, viewportH],
  );
  const curPageRef = useRef(0);

  const flipPage = useCallback(
    (dir: 1 | -1) => {
      if (pagination.pageCount === 0) {
        return;
      }
      const next = Math.min(Math.max(curPageRef.current + dir, 0), pagination.pageCount - 1);
      innerListRef.current?.scrollToOffset({ offset: offsetOfPage(pagination, next), animated: true });
      curPageRef.current = next;
    },
    [pagination],
  );

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
    // 跨章连续性由补偿 effect 维持。
  }, [layout, initialCharOffset, readerMode, stitched, activeChapterId, params]);

  // scroll 模式锚点滑动不重挂载：listKey 不含 activeChapterId（保持 data 原地更新，
  // 视觉位置由补偿 effect 维持）；跳章/切模式仍走 switchSeq 触发重挂载。
  const listKey = readerMode === 'scroll' ? `scroll:${switchSeq}` : `page:${activeChapterId}:${switchSeq}`;

  // 滚动位置实时记录（补偿 effect 用，避免依赖事件对象）
  const scrollYRef = useRef(0);
  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollYRef.current = e.nativeEvent.contentOffset.y;
  }, []);

  // ── 滚动停止 → 位置真值持久化（码点，非像素）──
  // page 模式：章内；scroll 模式：拼接序列，跨入邻章则切 store 章 + 记真值 + 滑窗锚点跟随。
  const handleScrollEnd = useCallback(
    (e: { nativeEvent: { contentOffset: { y: number } } }) => {
      const y = e.nativeEvent.contentOffset.y;
      if (readerMode === 'page') {
        if (layout.lines.length === 0) {
          return;
        }
        const pos = charOffsetAtY(layout.lines, geometry, y);
        const line = layout.lines[pos.lineIndex];
        if (!line) {
          return;
        }
        recordProgress(line.segmentId, undefined, line.charStart);
        setSegment(line.segmentId);
        // R3 互切：滚动位置 → 页号单源同步（翻页落点由同一 offset 系推导）
        if (pagination.pageCount > 0) {
          curPageRef.current = pageAtOffset(pagination, y);
        }
        return;
      }
      // scroll 模式：拼接列表
      const lines = stitched.lines;
      if (lines.length === 0) {
        return;
      }
      const centerIdx = Math.min(Math.max(lineAtY(geometry, y + viewportH / 2), 0), lines.length - 1);
      const line = lines[centerIdx];
      if (!line) {
        return;
      }
      const chId = line.chapterId;
      if (chId === activeChapterId) {
        recordProgress(line.segmentId, undefined, line.charStart);
      } else {
        // 跨入邻章：切 store 章（记精确码点真值）+ 滑窗锚点跟随（载其邻章、弃远端）
        openChapter(bookId, chId, line.segmentId, undefined, line.charStart);
        centerRef.current = chId;
        setActiveChapterId(chId);
        const retain = retainSetFor(chId);
        setWin((w) => windowRecenter(w, chId, retain));
      }
      setSegment(line.segmentId);
    },
    [readerMode, layout, geometry, pagination, stitched, viewportH, activeChapterId, bookId, openChapter, recordProgress, setSegment, retainSetFor],
  );

  // ── 跨章拼接滚动补偿（scroll 模式专属）──
  // 渲染序变化（前插/前删邻章）导致锚章首行全局下标位移；补偿量 = 位移 × rowHeight，
  // 经 scrollToOffset 维持视觉位置无缝。行数缓存跨「章被丢弃」保留（前删补偿正确）。
  const prevOrderRef = useRef<string[]>([]);
  const remountKeyRef = useRef<string>(`${readerMode}:${switchSeq}`);
  const lineCountCacheRef = useRef<Map<string, number>>(new Map());
  useLayoutEffect(() => {
    for (const [cid, n] of stitched.lineCountOf) {
      lineCountCacheRef.current.set(cid, n);
    }
    if (readerMode !== 'scroll') {
      prevOrderRef.current = loadedChapters;
      return;
    }
    const remountKey = `${readerMode}:${switchSeq}`;
    if (remountKeyRef.current !== remountKey) {
      remountKeyRef.current = remountKey;
      prevOrderRef.current = loadedChapters;
      return; // 跳章/切模式/重挂载：initialScrollIndex 已定位，不补偿
    }
    const prev = prevOrderRef.current;
    const next = loadedChapters;
    if (prev.length > 0 && next.length > 0) {
      const d = compensationDelta(prev, next, lineCountCacheRef.current, activeChapterId, geometry.rowHeight);
      if (d !== 0) {
        innerListRef.current?.scrollToOffset({ offset: scrollYRef.current + d, animated: false });
      }
    }
    prevOrderRef.current = next;
  }, [loadedChapters, readerMode, switchSeq, geometry.rowHeight, stitched, activeChapterId]);

  // ── 查字入口：点按汉字 → DictLookup ──
  const handlePressChar = useCallback(
    (segText: string) => (index: number) => {
      const ch = Array.from(segText)[index];
      if (ch) {
        navigation?.navigate('DictLookup', { headword: ch });
      }
    },
    [navigation],
  );

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

  // ── 行渲染（跨章：按 line.chapterId 取本篇章段/跨度/高亮/拼音字号）──
  const renderItem = useCallback(
    ({ item }: { item: Line }) => {
      const seg = segmentsByChapter.get(item.chapterId)?.find((s) => s.id === item.segmentId);
      if (!seg) {
        return null;
      }
      const span = segmentSpanByChapter.get(item.chapterId)?.get(item.segmentId);
      const segStart = span?.start ?? 0;
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
          onPressChar={handlePressChar(seg.text)}
          highlights={segmentHighlightByChapter.get(item.chapterId)?.get(item.segmentId)}
          onLongPressChar={handleLongPressChar(seg, item.chapterId)}
          onPressHighlight={handleViewHighlight}
        />
      );
    },
    [
      segmentsByChapter,
      segmentSpanByChapter,
      geometry.rowHeight,
      fontSize,
      lineHeight,
      unifiedPinyinFontSizeByChapter,
      unifiedPinyinFontSize,
      pinyinMode,
      conversionMode,
      bookId,
      handlePressChar,
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
          <Text style={[styles.chapterTitle, { color: colors.text }]} numberOfLines={1} allowFontScaling={false}>
            {loaded?.chapter.title ?? ''}
          </Text>
        </View>
        <View style={styles.headerSpacer} />
      </View>

      {/* 正文：listWrap 包裹（onLayout + 热区载体）。注意：tap 分发按 z 序，
          热区 zIndex:10 会压过无 zIndex 的纵排 footer——footer 需 zIndex:20。 */}
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
        <FlatList
          key={listKey}
          data={readerMode === 'scroll' ? stitched.lines : layout.lines}
          renderItem={renderItem}
          keyExtractor={(item) => `${item.chapterId}#${item.index}`}
          getItemLayout={getItemLayout}
          onScroll={handleScroll}
          initialScrollIndex={initialLineIndex > 0 ? initialLineIndex : undefined}
          onScrollToIndexFailed={(info) => {
            // getItemLayout 纯算式下理论不触发；兜底 = 开环 offset 直写
            innerListRef.current?.scrollToOffset({ offset: info.index * geometry.rowHeight, animated: false });
          }}
          onMomentumScrollEnd={handleScrollEnd}
          onScrollEndDrag={handleScrollEnd}
          scrollEventThrottle={16}
          initialNumToRender={24}
          maxToRenderPerBatch={24}
          windowSize={9}
          contentContainerStyle={{ paddingHorizontal: pageMargin }}
          style={styles.list}
          ref={innerListRef}
        />
        {readerMode === 'page' && pagination.pageCount > 0 ? (
          <>
            {/* 翻页热区（R3-2 MVP）：左右 30% 翻页、中间 40% 保留点字查词/长按划线。
                legado 同款取舍；手势仿真翻页（覆盖动画）为 R3 后续步。 */}
            <Pressable
              style={[styles.tapZoneL, { bottom: footerHEff }]}
              accessibilityLabel="上一页"
              onPress={() => flipPage(-1)}
            />
            <Pressable
              style={[styles.tapZoneR, { bottom: footerHEff }]}
              accessibilityLabel="下一页"
              onPress={() => flipPage(1)}
            />
          </>
        ) : null}
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
    </View>
  );
}

const EMPTY_SEGMENTS: TextSegment[] = [];

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
  // 翻页热区（page 模式）：左右 30% 透明层，absolute 相对 container，
  // top/bottom 运行时让位 headerH/footerH
  tapZoneL: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: '30%',
    zIndex: 10,
  },
  tapZoneR: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: '30%',
    zIndex: 10,
  },
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
