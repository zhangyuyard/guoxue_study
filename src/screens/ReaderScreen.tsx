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
import { TextLibraryService } from '@/services/TextLibraryService';
import { UserBookService } from '@/services/UserBookService';
import { useReaderStore } from '@/store/useReaderStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { getColors, type ThemeColors } from '@/theme';
import { charGapFor, getItemLayoutOf, layoutChapter, pinyinRowMetrics, resolveGeometry } from '@/reader/geometry';
import { lineAtCharOffset } from '@/reader/position';
import { charOffsetAtY } from '@/reader/position';
import { annotate, maxPinyinLength } from '@/services/PinyinService';
import type { ReaderRouteParams } from '@/navigation/types';
import type { Chapter, TextSegment } from '@/types';

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

  // ── 章内容加载（内置书同步；用户书先水合）──
  const [loaded, setLoaded] = useState<LoadedChapter | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openChapter = useReaderStore((s) => s.openChapter);
  const recordProgress = useReaderStore((s) => s.recordProgress);
  const setSegment = useReaderStore((s) => s.setSegment);
  const lastRead = useReaderStore((s) => s.lastRead);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setLoaded(null);
    (async () => {
      try {
        // 懒水合入口（内置书与用户书同一 API）：启动只注册元数据壳
        // （segments 空），必须先水合再 getChapter，否则「本章暂无正文」
        const ensure = await UserBookService.ensureBookLoaded(bookId);
        if (!ensure.success) {
          throw new Error(ensure.error ?? '书籍加载失败');
        }
        const chapterRes = TextLibraryService.getChapter(chapterId);
        if (!chapterRes.success || !chapterRes.data) {
          throw new Error(chapterRes.error ?? '章节不存在');
        }
        const chapter = chapterRes.data;
        const bookRes = TextLibraryService.getBook(chapter.bookId);
        const segments = [...chapter.segments].sort((a, b) => a.order - b.order);
        if (cancelled) {
          return;
        }
        setLoaded({
          bookTitle: bookRes.success ? bookRes.data?.title ?? '' : '',
          chapter,
          segments,
        });
        // ★ 续读真值保序：openChapter 不带 charOffset 会把持久化偏移覆盖为空
        // （store 语义：lastRead 整体重写）⇒ 必须把本轮定位用的偏移原样传入，
        // 优先级与 initialLineIndex 一致：路由 charOffset > 同章持久化 charOffset
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
        openChapter(chapter.bookId, chapter.id, params?.segmentId, undefined, restoreOffset);
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message ?? '加载失败');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // jumpSeq 入参：重复跳转同章也要重置 effect（路由浅合并语义）
  }, [bookId, chapterId, jumpSeq]);

  // ── 行化（L1）：段文本按码点切行，行不跨段、章局码点连续 ──
  const segments = loaded?.segments ?? EMPTY_SEGMENTS;
  const layout = useMemo(
    () => layoutChapter(chapterId, segments, geometry),
    [chapterId, segments, geometry],
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
      const res = annotate(seg.text, pinyinMode, { workId: chapterId, bookId });
      if (res.success && res.data) {
        const len = maxPinyinLength(res.data);
        if (len > max) {
          max = len;
        }
      }
    }
    return max;
  }, [segments, pinyinOn, pinyinMode, chapterId, bookId]);
  const unifiedPinyinFontSize = useMemo(() => {
    if (!pinyinOn || chapterMaxPinyinLen < 1) {
      return undefined;
    }
    const pinyinSize = pinyinRowMetrics(fontSize, lineHeight).pinyinSize;
    return Math.max(8, Math.min(pinyinSize, Math.floor(fontSize / chapterMaxPinyinLen)));
  }, [pinyinOn, chapterMaxPinyinLen, fontSize, lineHeight]);

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

  // ── 续读定位（L2，开环）：路由 charOffset > 持久化 charOffset > segmentId > 章首 ──
  const initialLineIndex = useMemo(() => {
    if (layout.lines.length === 0) {
      return 0;
    }
    const clamp = (i: number) => Math.min(Math.max(i, 0), layout.lines.length - 1);
    const routeOffset = params?.charOffset;
    if (typeof routeOffset === 'number' && routeOffset >= 0) {
      return clamp(lineAtCharOffset(layout.lines, routeOffset));
    }
    if (
      lastRead &&
      lastRead.bookId === bookId &&
      lastRead.chapterId === chapterId &&
      typeof lastRead.charOffset === 'number' &&
      lastRead.charOffset >= 0
    ) {
      return clamp(lineAtCharOffset(layout.lines, lastRead.charOffset));
    }
    if (params?.segmentId) {
      const idx = layout.lines.findIndex((l) => l.segmentId === params.segmentId);
      if (idx >= 0) {
        return idx;
      }
    }
    return 0;
    // 仅在章内容/定位输入变化时重算（initialScrollIndex 只在挂载时生效，
    // 列表以 key=chapterId:jumpSeq 强制重挂载，见下）
  }, [layout, bookId, chapterId]);

  const listKey = `${chapterId}:${jumpSeq}`;

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

  // ── 章间导航（R1：按钮式；R2 起为滑窗 + 双向预拼）──
  const siblings = useMemo(() => {
    if (!loaded) {
      return {};
    }
    const res = TextLibraryService.getSiblingChapters(chapterId);
    return res.success ? res.data ?? {} : {};
  }, [loaded, chapterId]);

  const jumpTo = useCallback(
    (cid: string) => {
      navigation?.navigate('Reader', {
        bookId,
        chapterId: cid,
        jumpSeq: Date.now(),
      });
    },
    [bookId, navigation],
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
          workId={chapterId}
          bookId={bookId}
          onPressChar={handlePressChar(seg.text)}
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
      chapterId,
      bookId,
      handlePressChar,
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

      {/* 底栏：章间导航 */}
      {loaded ? (
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
