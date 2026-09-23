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
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
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
import { charGapFor, getItemLayoutOf, layoutChapter, resolveGeometry, unifiedPinyinFontSizeFor } from '@/reader/geometry';
import { lineAtCharOffset } from '@/reader/position';
import { charOffsetAtY } from '@/reader/position';
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
  const colors: ThemeColors = getColors(theme);

  const innerListRef = useRef<FlatList | null>(null);

  const { width: windowWidth } = useWindowDimensions();
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
  const segments = loaded?.segments ?? EMPTY_SEGMENTS;
  const layout = useMemo(
    () => layoutChapter(activeChapterId, segments, geometry),
    [activeChapterId, segments, geometry],
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

  // 段内码点基准备查：line.charStart（章局）→ 段内 [segStart, segEnd)
  const segmentSpans = useMemo(() => {
    const spans = new Map<string, { start: number; end: number }>();
    let offset = 0;
    for (const seg of segments) {
      const len = Array.from(seg.text).length;
      spans.set(seg.id, { start: offset, end: offset + len });
      offset += len;
    }
    return spans;
  }, [segments]);


  // ── 划线（R2d）：章级装载 + 整段粒度 MVP（精确选区留 selectionRange 后续迭代）──
  const [chapterHighlights, setChapterHighlights] = useState<Highlight[]>([]);
  const addNote = useNoteStore((st) => st.addNote);
  const updateNoteContent = useNoteStore((st) => st.updateNoteContent);
  const removeNote = useNoteStore((st) => st.removeNote);
  const [highlightNoteMap, setHighlightNoteMap] = useState<Map<string, { id: string; content: string }>>(new Map());
  const [highlightSheet, setHighlightSheet] = useState<
    | { mode: 'create'; segmentId: string; text: string }
    | { mode: 'view'; highlight: Highlight }
    | null
  >(null);

  // 章切换 → 重拉本章划线（同步读 db，量小；cancelled 防 StrictMode 竞态写回）
  useEffect(() => {
    if (!bookId || !activeChapterId) {
      setChapterHighlights([]);
      return;
    }
    let cancelled = false;
    const res = StorageService.getHighlights(bookId, activeChapterId);
    const notesRes = StorageService.getNotes(bookId, activeChapterId);
    if (!cancelled) {
      setChapterHighlights(res.success && res.data ? res.data : []);
      const map = new Map<string, { id: string; content: string }>();
      for (const n of notesRes.success && notesRes.data ? notesRes.data : []) {
        if (n.highlightId) {
          map.set(n.highlightId, { id: n.id, content: n.content });
        }
      }
      setHighlightNoteMap(map);
    }
    return () => {
      cancelled = true;
    };
  }, [bookId, activeChapterId]);

  // segmentId → 划线组（renderItem 行级取用）
  const segmentHighlightMap = useMemo(() => {
    const m = new Map<string, Highlight[]>();
    for (const h of chapterHighlights) {
      const arr = m.get(h.segmentId);
      if (arr) {
        arr.push(h);
      } else {
        m.set(h.segmentId, [h]);
      }
    }
    return m;
  }, [chapterHighlights]);

  const handleLongPressChar = useCallback(
    (seg: TextSegment) => () => {
      setHighlightSheet({ mode: 'create', segmentId: seg.id, text: seg.text });
    },
    [],
  );

  const handleViewHighlight = useCallback((h: Highlight) => {
    setHighlightSheet({ mode: 'view', highlight: h });
  }, []);

  const handleCreateHighlight = useCallback(
    (color: HighlightColor, noteText: string) => {
      if (!highlightSheet || highlightSheet.mode !== 'create' || !bookId || !activeChapterId) {
        return;
      }
      const text = highlightSheet.text;
      const h = buildSegmentHighlight(bookId, activeChapterId, highlightSheet.segmentId, text, color);
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
          chapterId: activeChapterId,
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
      setChapterHighlights((prev) => [stored, ...prev]);
      setHighlightSheet(null);
    },
    [highlightSheet, bookId, activeChapterId, addNote],
  );

  /** view 态存笔记：无笔记 → 新建并回写 noteId；有 → 更新内容 */
  const handleNoteSubmit = useCallback(
    (content: string) => {
      if (!highlightSheet || highlightSheet.mode !== 'view' || !bookId || !activeChapterId || !content) {
        return;
      }
      const hl = highlightSheet.highlight;
      const existing = highlightNoteMap.get(hl.id);
      if (existing) {
        updateNoteContent(existing.id, content);
        setHighlightNoteMap((prev) => new Map(prev).set(hl.id, { id: existing.id, content }));
      } else {
        const noteId = addNote({
          bookId,
          chapterId: activeChapterId,
          segmentId: hl.segmentId,
          startOffset: hl.startOffset,
          endOffset: hl.endOffset,
          content,
          highlightId: hl.id,
        });
        if (noteId) {
          StorageService.saveHighlight({ ...hl, noteId });
          setChapterHighlights((prev) => prev.map((x) => (x.id === hl.id ? { ...x, noteId } : x)));
          setHighlightNoteMap((prev) => new Map(prev).set(hl.id, { id: noteId, content }));
        }
      }
      setHighlightSheet(null);
    },
    [highlightSheet, bookId, activeChapterId, highlightNoteMap, addNote, updateNoteContent],
  );

  const handleDeleteHighlight = useCallback(
    (id: string) => {
      // 级联：删笔记再删划线（noteId 回写在划线行上，孤儿笔记防不住这里防）
      const note = highlightNoteMap.get(id);
      if (note) {
        removeNote(note.id);
        setHighlightNoteMap((prev) => {
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
      }
      const res = StorageService.deleteHighlight(id);
      if (res.success) {
        setChapterHighlights((prev) => prev.filter((h) => h.id !== id));
      }
      setHighlightSheet(null);
    },
    [highlightNoteMap, removeNote],
  );

  // ── 续读定位（L2，开环）：路由 charOffset > 持久化 charOffset > segmentId > 章首 ──
  // 路由参数只对「参数所属章」生效：就地切换到其他章后 params 仍是旧章的，
  // 不得把旧章偏移映射进新章 layout（归属保护）。
  const initialLineIndex = useMemo(() => {
    if (layout.lines.length === 0) {
      return 0;
    }
    const clamp = (i: number) => Math.min(Math.max(i, 0), layout.lines.length - 1);
    const routeOwned = params?.chapterId === activeChapterId;
    const routeOffset = routeOwned ? params?.charOffset : undefined;
    if (typeof routeOffset === 'number' && routeOffset >= 0) {
      return clamp(lineAtCharOffset(layout.lines, routeOffset));
    }
    if (
      lastRead &&
      lastRead.bookId === bookId &&
      lastRead.chapterId === activeChapterId &&
      typeof lastRead.charOffset === 'number' &&
      lastRead.charOffset >= 0
    ) {
      return clamp(lineAtCharOffset(layout.lines, lastRead.charOffset));
    }
    const routeSegmentId = routeOwned ? params?.segmentId : undefined;
    if (routeSegmentId) {
      const idx = layout.lines.findIndex((l) => l.segmentId === routeSegmentId);
      if (idx >= 0) {
        return idx;
      }
    }
    return 0;
    // 仅在章内容/定位输入变化时重算（initialScrollIndex 只在挂载时生效，
    // 列表以 key=activeChapterId:switchSeq 强制重挂载，见下）
  }, [layout, bookId, activeChapterId, params]);

  const listKey = `${activeChapterId}:${switchSeq}`;

  // ── 滚动停止 → 位置真值持久化（码点，非像素）──
  const handleScrollEnd = useCallback(
    (e: { nativeEvent: { contentOffset: { y: number } } }) => {
      if (layout.lines.length === 0) {
        return;
      }
      const y = e.nativeEvent.contentOffset.y;
      const pos = charOffsetAtY(layout.lines, geometry, y);
      const line = layout.lines[pos.lineIndex];
      if (!line) {
        return;
      }
      recordProgress(line.segmentId, undefined, line.charStart);
      setSegment(line.segmentId);
    },
    [layout, geometry, recordProgress, setSegment],
  );

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

  // ── 行渲染 ──
  const renderItem = useCallback(
    ({ item }: { item: (typeof layout.lines)[number] }) => {
      const seg = segments.find((s) => s.id === item.segmentId);
      if (!seg) {
        return null;
      }
      const span = segmentSpans.get(item.segmentId);
      const segStart = span?.start ?? 0;
      return (
        <LineRow
          text={seg.text}
          charRange={[item.charStart - segStart, item.charEnd - segStart]}
          rowHeight={geometry.rowHeight}
          fontSize={fontSize}
          lineHeight={lineHeight}
          unifiedPinyinFontSize={unifiedPinyinFontSize}
          pinyinMode={pinyinMode}
          conversionMode={conversionMode}
          workId={activeChapterId}
          bookId={bookId}
          onPressChar={handlePressChar(seg.text)}
          highlights={segmentHighlightMap.get(item.segmentId)}
          onLongPressChar={handleLongPressChar(seg)}
          onPressHighlight={handleViewHighlight}
        />
      );
    },
    [
      segments,
      segmentSpans,
      geometry.rowHeight,
      fontSize,
      lineHeight,
      unifiedPinyinFontSize,
      pinyinMode,
      conversionMode,
      activeChapterId,
      bookId,
      handlePressChar,
      handleLongPressChar,
      segmentHighlightMap,
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

      {/* 正文 */}
      {error ? (
        <View style={styles.center}>
          <Text style={{ color: colors.textSecondary }}>{`加载失败：${error}`}</Text>
        </View>
      ) : !loaded ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : layout.lines.length === 0 ? (
        <View style={styles.center}>
          <Text style={{ color: colors.textSecondary }}>本章暂无正文</Text>
        </View>
      ) : (
        <FlatList
          key={listKey}
          data={layout.lines}
          renderItem={renderItem}
          keyExtractor={(item) => `l${item.index}`}
          getItemLayout={getItemLayout}
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
      )}

      {/* 底栏：章间导航（就地切换中也保持显示，目标装载时按钮沿用 siblings） */}
      {activeChapterId ? (
        <View style={[styles.footer, { backgroundColor: colors.card, borderColor: colors.border }]}>
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
            ? highlightNoteMap.get(highlightSheet.highlight.id)?.content ?? ''
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
  list: {
    flex: 1,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
