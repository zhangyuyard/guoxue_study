/**
 * 笔记列表页（NotesListScreen）
 * 筛选：按书名（全部/具体书籍）+ 时间范围（全部/今天/本周/本月，P1-10）+ 按时间排序（默认新→旧）。
 * 列表项：笔记内容摘要、关联划线文本（如有）、来源（书名-章节）、更新时间；支持删除。
 * 导出（P1-11）：头部「导出」按钮 → 选择 Markdown / 纯文本，写入
 * DocumentDirectoryPath/exports/notes-YYYYMMDD-HHmm.{md,txt}，成功提示完整路径；
 * 另提供「分享内容」走系统分享面板。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { Note } from '@/types';
import type { T04StackParamList } from '@/screens/types';
import { TextLibraryService } from '@/services/TextLibraryService';
import { StorageService } from '@/services/StorageService';
import { ExportService } from '@/services/ExportService';
import {
  buildNotesMarkdown,
  buildNotesPlainText,
  type NoteExportEntry,
} from '@/utils/exporters';
import {
  filterByTimeRange,
  TIME_RANGE_OPTIONS,
  type TimeRange,
} from '@/utils/filters';
import { useNoteStore } from '@/store/useNoteStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { getColors, PAGE_TITLE_FONT_SIZE } from '@/theme';

type Props = NativeStackScreenProps<T04StackParamList, 'NotesList'>;

/** 更新时间格式化 */
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function NotesListScreen(_props: Props): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const theme = useSettingsStore((s) => s.theme);
  const colors = getColors(theme);

  const notes = useNoteStore((s) => s.notes);
  const loadNotes = useNoteStore((s) => s.loadNotes);
  const removeNote = useNoteStore((s) => s.removeNote);

  /** 当前选中书籍（'' 表示全部） */
  const [selectedBookId, setSelectedBookId] = useState('');
  /** 时间范围筛选（P1-10，默认全部） */
  const [timeRange, setTimeRange] = useState<TimeRange>('all');
  /** 导出格式选择弹层 */
  const [exportVisible, setExportVisible] = useState(false);

  /** 书籍列表（供筛选） */
  const books = useMemo(() => {
    const res = TextLibraryService.getBooks();
    return res.success && res.data ? res.data : [];
  }, []);

  /** 书名索引 */
  const bookTitleMap = useMemo(
    () => new Map(books.map((b) => [b.id, b.title])),
    [books],
  );

  /** 章节标题索引 */
  const chapterTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const book of books) {
      for (const chapter of book.chapters) {
        map.set(chapter.id, chapter.title);
      }
    }
    return map;
  }, [books]);

  /** 划线文本索引（highlightId -> text） */
  const highlightTextMap = useMemo(() => {
    const map = new Map<string, string>();
    const res = StorageService.getHighlights();
    if (res.success && res.data) {
      for (const h of res.data) {
        map.set(h.id, h.text);
      }
    }
    return map;
  }, []);

  /** 关联划线文本（有 highlightId 用高亮文本，否则用笔记偏移截取原文） */
  const relatedText = useCallback(
    (note: Note): string | null => {
      if (note.highlightId) {
        const text = highlightTextMap.get(note.highlightId);
        if (text) {
          return text;
        }
      }
      const segRes = TextLibraryService.getSegment(note.segmentId);
      if (segRes.success && segRes.data) {
        const { text } = segRes.data;
        const s = Math.max(0, note.startOffset);
        const e = Math.min(text.length, note.endOffset);
        if (e > s) {
          return text.slice(s, e);
        }
        return text;
      }
      return null;
    },
    [highlightTextMap],
  );

  /** 切换书籍筛选 */
  const changeBook = useCallback(
    (bookId: string) => {
      setSelectedBookId(bookId);
      loadNotes(bookId || undefined);
    },
    [loadNotes],
  );

  useEffect(() => {
    loadNotes();
  }, [loadNotes]);

  /** 时间范围过滤（与书名筛选叠加：书名由服务层过滤，时间在此客户端过滤） */
  const visibleNotes = useMemo(
    () => filterByTimeRange(notes, (n) => n.updatedAt, timeRange),
    [notes, timeRange],
  );

  /** 组装导出条目（按当前筛选结果导出） */
  const buildExportEntries = useCallback(
    (): NoteExportEntry[] =>
      visibleNotes.map((note) => ({
        bookTitle: note.bookId ? (bookTitleMap.get(note.bookId) ?? '未知书籍') : '未知书籍',
        chapterTitle: note.chapterId ? chapterTitleMap.get(note.chapterId) : undefined,
        quote: relatedText(note) ?? undefined,
        content: note.content,
        time: note.updatedAt,
      })),
    [visibleNotes, bookTitleMap, chapterTitleMap, relatedText],
  );

  /** 导出为文件（md / txt）并提示完整路径 */
  const handleExport = useCallback(
    async (ext: 'md' | 'txt') => {
      const entries = buildExportEntries();
      const content =
        ext === 'md' ? buildNotesMarkdown(entries) : buildNotesPlainText(entries);
      setExportVisible(false);
      const res = await ExportService.writeExportFile('notes', ext, content);
      if (res.success && res.data) {
        Alert.alert('导出成功', `文件已保存至：\n${res.data}`);
      } else {
        Alert.alert('导出失败', res.error ?? '未知错误');
      }
    },
    [buildExportEntries],
  );

  /** 分享当前筛选笔记（Markdown 内容，超长自动截断注明） */
  const handleShare = useCallback(async () => {
    const content = buildNotesMarkdown(buildExportEntries());
    setExportVisible(false);
    const res = await ExportService.shareExportText(content);
    if (!res.success && res.error !== '分享已取消') {
      Alert.alert('分享失败', res.error ?? '未知错误');
    }
  }, [buildExportEntries]);

  /** 删除笔记（二次确认） */
  const confirmDelete = useCallback(
    (note: Note) => {
      Alert.alert('删除笔记', '确定要删除这条笔记吗？', [
        { text: '取消', style: 'cancel' },
        { text: '删除', style: 'destructive', onPress: () => removeNote(note.id) },
      ]);
    },
    [removeNote],
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={styles.titleRow}>
        <Text style={[styles.title, { color: colors.text }]}>我的笔记</Text>
        <Pressable
          onPress={() => setExportVisible(true)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="导出笔记"
        >
          <Text style={[styles.exportBtn, { color: colors.primary }]}>导出</Text>
        </Pressable>
      </View>

      {/* 按书名筛选 */}
      <FlatList
        horizontal
        data={[{ id: '', title: '全部' }, ...books.map((b) => ({ id: b.id, title: b.title }))]}
        keyExtractor={(item) => item.id || 'all'}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterContent}
        style={styles.filterList}
        renderItem={({ item }) => {
          const selected = selectedBookId === item.id;
          return (
            <Pressable
              onPress={() => changeBook(item.id)}
              style={[
                styles.filterBtn,
                { backgroundColor: selected ? colors.primary : colors.card },
              ]}
              accessibilityState={{ selected }}
            >
              <Text
                style={[
                  styles.filterText,
                  { color: selected ? '#FFFFFF' : colors.textSecondary },
                ]}
              >
                {item.title}
              </Text>
            </Pressable>
          );
        }}
      />

      {/* 按时间范围筛选（P1-10） */}
      <FlatList
        horizontal
        data={TIME_RANGE_OPTIONS}
        keyExtractor={(item) => item.key}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterContent}
        style={styles.filterList}
        renderItem={({ item }) => {
          const selected = timeRange === item.key;
          return (
            <Pressable
              onPress={() => setTimeRange(item.key)}
              style={[
                styles.filterBtn,
                { backgroundColor: selected ? colors.primary : colors.card },
              ]}
              accessibilityState={{ selected }}
              accessibilityLabel={`按${item.label}筛选`}
            >
              <Text
                style={[
                  styles.filterText,
                  { color: selected ? '#FFFFFF' : colors.textSecondary },
                ]}
              >
                {item.label}
              </Text>
            </Pressable>
          );
        }}
      />

      <View style={styles.sortHintRow}>
        <Text style={[styles.sortHint, { color: colors.pinyin }]}>按更新时间排序（新→旧）</Text>
      </View>

      <FlatList
        data={visibleNotes}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => {
          const bookTitle = item.bookId ? (bookTitleMap.get(item.bookId) ?? '未知书籍') : '';
          const chapterTitle = item.chapterId
            ? (chapterTitleMap.get(item.chapterId) ?? '')
            : '';
          const related = relatedText(item);
          return (
            <View
              style={[
                styles.itemCard,
                { backgroundColor: colors.card, borderColor: colors.border },
              ]}
            >
              <View style={styles.itemHeader}>
                <Text style={[styles.sourceText, { color: colors.primary }]}>
                  {bookTitle}
                  {chapterTitle ? ` · ${chapterTitle}` : ''}
                </Text>
                <Text style={[styles.timeText, { color: colors.pinyin }]}>
                  {formatDate(item.updatedAt)}
                </Text>
              </View>

              {related ? (
                <Text
                  style={[
                    styles.relatedText,
                    { backgroundColor: colors.primarySoft, color: colors.textSecondary },
                  ]}
                >
                  划线：{related}
                </Text>
              ) : null}

              <Text style={[styles.noteText, { color: colors.text }]}>{item.content}</Text>

              <Pressable
                onPress={() => confirmDelete(item)}
                hitSlop={10}
                style={styles.deleteBtn}
              >
                <Text style={[styles.deleteText, { color: colors.pinyin }]}>删除</Text>
              </Pressable>
            </View>
          );
        }}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              暂无笔记{selectedBookId || timeRange !== 'all' ? '（当前筛选条件下）' : ''}
            </Text>
            {selectedBookId || timeRange !== 'all' ? (
              <Pressable
                onPress={() => {
                  changeBook('');
                  setTimeRange('all');
                }}
                style={[styles.primaryBtn, { backgroundColor: colors.primary }]}
              >
                <Text style={styles.primaryBtnText}>查看全部</Text>
              </Pressable>
            ) : null}
          </View>
        }
      />

      {/* 导出格式选择弹层（P1-11） */}
      <Modal
        visible={exportVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setExportVisible(false)}
      >
        <Pressable style={styles.exportOverlay} onPress={() => setExportVisible(false)}>
          <Pressable
            style={[styles.exportSheet, { backgroundColor: colors.card }]}
            onPress={() => undefined}
          >
            <Text style={[styles.exportTitle, { color: colors.text }]}>导出笔记</Text>
            <Text style={[styles.exportHint, { color: colors.textSecondary }]}>
              将按当前筛选条件导出 {visibleNotes.length} 条笔记
            </Text>
            <View style={styles.exportActions}>
              <Pressable
                style={[styles.exportFormatBtn, { borderColor: colors.border }]}
                onPress={() => handleExport('md')}
                accessibilityRole="button"
                accessibilityLabel="导出为 Markdown"
              >
                <Text style={[styles.exportFormatText, { color: colors.text }]}>
                  Markdown（.md）
                </Text>
              </Pressable>
              <Pressable
                style={[styles.exportFormatBtn, { borderColor: colors.border }]}
                onPress={() => handleExport('txt')}
                accessibilityRole="button"
                accessibilityLabel="导出为纯文本"
              >
                <Text style={[styles.exportFormatText, { color: colors.text }]}>
                  纯文本（.txt）
                </Text>
              </Pressable>
            </View>
            <Pressable
              onPress={handleShare}
              accessibilityRole="button"
              accessibilityLabel="分享笔记内容"
            >
              <Text style={[styles.shareText, { color: colors.primary }]}>分享内容…</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingRight: 16,
  },
  title: {
    fontSize: PAGE_TITLE_FONT_SIZE,
    fontWeight: '700',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 8,
  },
  exportBtn: {
    fontSize: 15,
    fontWeight: '600',
  },
  filterList: {
    flexGrow: 0,
  },
  filterContent: {
    paddingHorizontal: 16,
    gap: 8,
  },
  filterBtn: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 16,
  },
  filterText: {
    fontSize: 13,
    fontWeight: '600',
  },
  sortHintRow: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
  },
  sortHint: {
    fontSize: 12,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  itemCard: {
    padding: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 10,
  },
  itemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
    gap: 8,
  },
  sourceText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
  },
  timeText: {
    fontSize: 11,
  },
  relatedText: {
    fontSize: 13,
    lineHeight: 19,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    marginBottom: 8,
  },
  noteText: {
    fontSize: 15,
    lineHeight: 22,
  },
  deleteBtn: {
    alignSelf: 'flex-end',
    marginTop: 8,
  },
  deleteText: {
    fontSize: 13,
  },
  emptyWrap: {
    alignItems: 'center',
    paddingVertical: 60,
    gap: 16,
  },
  emptyText: {
    fontSize: 15,
  },
  primaryBtn: {
    paddingHorizontal: 28,
    paddingVertical: 10,
    borderRadius: 20,
  },
  primaryBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  // 导出弹层
  exportOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  exportSheet: {
    width: '84%',
    borderRadius: 14,
    padding: 16,
    gap: 12,
  },
  exportTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  exportHint: {
    fontSize: 13,
  },
  exportActions: {
    flexDirection: 'row',
    gap: 10,
  },
  exportFormatBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  exportFormatText: {
    fontSize: 14,
  },
  shareText: {
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
});
