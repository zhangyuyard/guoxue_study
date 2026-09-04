/**
 * 收藏列表页（BookmarksScreen）
 * 筛选：类型（全部/文章/段落/解析 P1-05）× 标签 chips（P1-13，AND 语义叠加）；时间排序（新→旧）。
 * 解析收藏（paragraph + tag「解析」）在「解析」档下独立查看，该档仅当存在解析收藏时显示。
 * 列表项含类型徽章、来源书名、文本摘要、标签 chips、备注（P1-12）、收藏时间；
 * 支持编辑（标签勾选 + 新增 + 备注）与删除。
 * 点击文章收藏进入阅读器；点击段落收藏定位到对应段落。
 * 导出（P1-11）：头部「导出」按钮 → Markdown / 纯文本写入 exports/collect-*，另支持分享。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { Bookmark, BookmarkType } from '@/types';
import type { T04StackParamList } from '@/screens/types';
import { TextLibraryService } from '@/services/TextLibraryService';
import { ExportService } from '@/services/ExportService';
import {
  buildBookmarksMarkdown,
  buildBookmarksPlainText,
  type BookmarkExportEntry,
} from '@/utils/exporters';
import { ANALYSIS_TAG, filterBookmarks, groupBookmarksByFirstTag, hasAnalysisBookmarks } from '@/utils/filters';
import { useBookmarkStore } from '@/store/useBookmarkStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { getColors, PAGE_TITLE_FONT_SIZE } from '@/theme';

type Props = NativeStackScreenProps<T04StackParamList, 'Bookmarks'>;

/** 类型筛选：'' 全部 / article / paragraph / 'analysis' 解析档（P1-05） */
type TypeFilter = BookmarkType | '' | 'analysis';

/** 分组视图列表行：分组头 或 收藏卡片（P2-09） */
type BookmarkRow =
  | { kind: 'header'; key: string; tag: string; ungrouped: boolean }
  | { kind: 'item'; key: string; bookmark: Bookmark };

/** 编辑弹层状态（null 表示关闭） */
interface EditState {
  id: string;
  /** 弹层内勾选的标签 */
  tags: string[];
  /** 弹层内备注内容 */
  note: string;
}

/** 收藏时间格式化 */
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 类型徽章配置 */
const TYPE_BADGE: Record<BookmarkType, { label: string; bg: string; fg: string }> = {
  article: { label: '文章', bg: 'rgba(139, 94, 60, 0.14)', fg: '#8B5E3C' },
  paragraph: { label: '段落', bg: 'rgba(74, 111, 165, 0.14)', fg: '#4A6FA5' },
};

export default function BookmarksScreen({ navigation }: Props): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const theme = useSettingsStore((s) => s.theme);
  const colors = getColors(theme);

  const bookmarks = useBookmarkStore((s) => s.bookmarks);
  const loadBookmarks = useBookmarkStore((s) => s.loadBookmarks);
  const removeBookmark = useBookmarkStore((s) => s.removeBookmark);
  const updateBookmark = useBookmarkStore((s) => s.updateBookmark);

  /** 当前类型筛选 */
  const [filter, setFilter] = useState<TypeFilter>('');
  /** 当前标签筛选（'' 为全部，P1-13） */
  const [tagFilter, setTagFilter] = useState('');
  /** 编辑弹层状态 */
  const [editing, setEditing] = useState<EditState | null>(null);
  /** 新增标签输入 */
  const [newTag, setNewTag] = useState('');
  /** 导出格式选择弹层 */
  const [exportVisible, setExportVisible] = useState(false);

  /** 分组视图开关（P2-09，持久化于设置 Store：false=平铺 / true=按首标签分组） */
  const groupedView = useSettingsStore((s) => s.bookmarkGroupedView);
  const setBookmarkGroupedView = useSettingsStore((s) => s.setBookmarkGroupedView);

  useEffect(() => {
    loadBookmarks();
  }, [loadBookmarks]);

  /** 书名索引缓存（bookId -> title） */
  const bookTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    const res = TextLibraryService.getBooks();
    if (res.success && res.data) {
      for (const book of res.data) {
        map.set(book.id, book.title);
      }
    }
    return map;
  }, []);

  /** 全部历史标签（来自现有收藏数据，供筛选与编辑 quick-pick） */
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const b of bookmarks) {
      for (const tag of b.tags ?? []) {
        set.add(tag);
      }
    }
    return Array.from(set);
  }, [bookmarks]);

  /** 按类型 + 标签筛选（AND 语义；解析档按 ANALYSIS_TAG 过滤，时间排序由服务保证新→旧） */
  const filtered = useMemo(
    () =>
      filterBookmarks(
        bookmarks,
        filter === 'analysis' ? '' : filter,
        tagFilter,
        filter === 'analysis',
      ),
    [bookmarks, filter, tagFilter],
  );

  /** 是否存在解析收藏（决定「解析」筛选档是否显示，P1-05） */
  const showAnalysisFilter = useMemo(() => hasAnalysisBookmarks(bookmarks), [bookmarks]);

  /**
   * 列表行数据（P2-09）：平铺视图为纯收藏行；
   * 分组视图按首标签插入分组头（组顺序 = 首次出现顺序，组内保持原序）。
   */
  const rows = useMemo<BookmarkRow[]>(() => {
    if (!groupedView) {
      return filtered.map((b) => ({ kind: 'item', key: b.id, bookmark: b }));
    }
    return groupBookmarksByFirstTag(filtered).flatMap((g) => [
      {
        kind: 'header' as const,
        key: `header-${g.tag}`,
        tag: g.tag,
        ungrouped: g.ungrouped,
      },
      ...g.items.map((b) => ({ kind: 'item' as const, key: b.id, bookmark: b })),
    ]);
  }, [filtered, groupedView]);

  /** 删除收藏（二次确认） */
  const confirmDelete = useCallback(
    (bookmark: Bookmark) => {
      Alert.alert('删除收藏', '确定要删除这条收藏吗？', [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => removeBookmark(bookmark.id),
        },
      ]);
    },
    [removeBookmark],
  );

  /** 打开编辑弹层（预填现有标签与备注） */
  const openEdit = useCallback((bookmark: Bookmark) => {
    setEditing({ id: bookmark.id, tags: [...(bookmark.tags ?? [])], note: bookmark.note ?? '' });
    setNewTag('');
  }, []);

  /** 弹层内切换标签勾选 */
  const toggleTag = useCallback((tag: string) => {
    setEditing((prev) => {
      if (!prev) {
        return prev;
      }
      const has = prev.tags.includes(tag);
      return {
        ...prev,
        tags: has ? prev.tags.filter((t) => t !== tag) : [...prev.tags, tag],
      };
    });
  }, []);

  /** 弹层内新增标签（去重） */
  const addTag = useCallback(() => {
    const tag = newTag.trim();
    if (!tag) {
      return;
    }
    setEditing((prev) => {
      if (!prev || prev.tags.includes(tag)) {
        return prev;
      }
      return { ...prev, tags: [...prev.tags, tag] };
    });
    setNewTag('');
  }, [newTag]);

  /** 保存编辑（标签 + 备注） */
  const saveEdit = useCallback(() => {
    if (!editing) {
      return;
    }
    updateBookmark(editing.id, { tags: editing.tags, note: editing.note.trim() });
    setEditing(null);
    setNewTag('');
  }, [editing, updateBookmark]);

  /** 打开收藏 */
  const openBookmark = useCallback(
    (bookmark: Bookmark) => {
      if (!bookmark.bookId) {
        return;
      }
      // 段落收藏：定位到具体段落
      if (bookmark.type === 'paragraph' && bookmark.chapterId && bookmark.segmentId) {
        navigation.navigate('Reader', {
          bookId: bookmark.bookId,
          chapterId: bookmark.chapterId,
          segmentId: bookmark.segmentId,
        });
        return;
      }
      // 文章收藏：跳到该书章节（优先使用收藏时记录的章节，否则第一章）
      if (bookmark.chapterId) {
        navigation.navigate('Reader', {
          bookId: bookmark.bookId,
          chapterId: bookmark.chapterId,
        });
        return;
      }
      const bookRes = TextLibraryService.getBook(bookmark.bookId);
      const firstChapter = bookRes.success && bookRes.data ? bookRes.data.chapters[0] : undefined;
      if (firstChapter) {
        navigation.navigate('Reader', {
          bookId: bookmark.bookId,
          chapterId: firstChapter.id,
        });
      }
    },
    [navigation],
  );

  /** 组装导出条目（按当前筛选结果导出） */
  const buildExportEntries = useCallback(
    (): BookmarkExportEntry[] =>
      filtered.map((b) => ({
        bookTitle: b.bookId ? (bookTitleMap.get(b.bookId) ?? '未知书籍') : '未分组',
        type: b.type,
        text: b.text,
        tags: b.tags ?? [],
        note: b.note,
        time: b.createdAt,
      })),
    [filtered, bookTitleMap],
  );

  /** 导出为文件（md / txt）并提示完整路径 */
  const handleExport = useCallback(
    async (ext: 'md' | 'txt') => {
      const entries = buildExportEntries();
      const content =
        ext === 'md' ? buildBookmarksMarkdown(entries) : buildBookmarksPlainText(entries);
      setExportVisible(false);
      const res = await ExportService.writeExportFile('collect', ext, content);
      if (res.success && res.data) {
        Alert.alert('导出成功', `文件已保存至：\n${res.data}`);
      } else {
        Alert.alert('导出失败', res.error ?? '未知错误');
      }
    },
    [buildExportEntries],
  );

  /** 分享当前筛选收藏（Markdown 内容，超长自动截断注明） */
  const handleShare = useCallback(async () => {
    const content = buildBookmarksMarkdown(buildExportEntries());
    setExportVisible(false);
    const res = await ExportService.shareExportText(content);
    if (!res.success && res.error !== '分享已取消') {
      Alert.alert('分享失败', res.error ?? '未知错误');
    }
  }, [buildExportEntries]);

  const filters: { key: TypeFilter; label: string }[] = [
    { key: '', label: '全部' },
    { key: 'article', label: '文章' },
    { key: 'paragraph', label: '段落' },
    // P1-05：仅当存在 tag=解析 的收藏时显示「解析」档
    ...(showAnalysisFilter ? [{ key: 'analysis' as TypeFilter, label: ANALYSIS_TAG }] : []),
  ];

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={styles.titleRow}>
        <Text style={[styles.title, { color: colors.text }]}>我的收藏</Text>
        <View style={styles.titleActions}>
          {/* 分组视图切换（P2-09）：平铺 ←→ 按标签分组，状态持久化 */}
          <Pressable
            onPress={() => setBookmarkGroupedView(!groupedView)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={groupedView ? '切换为平铺视图' : '切换为分组视图'}
          >
            <Text style={[styles.exportBtn, { color: colors.primary }]}>
              {groupedView ? '平铺' : '分组'}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setExportVisible(true)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="导出收藏"
          >
            <Text style={[styles.exportBtn, { color: colors.primary }]}>导出</Text>
          </Pressable>
        </View>
      </View>

      {/* 类型筛选 */}
      <View style={styles.filterRow}>
        {filters.map((f) => {
          const selected = filter === f.key;
          return (
            <Pressable
              key={f.key || 'all'}
              onPress={() => setFilter(f.key)}
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
                {f.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* 标签筛选 chips（P1-13：全部 + 各标签，与类型筛选 AND 叠加） */}
      {allTags.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
        >
          {['', ...allTags].map((tag) => {
            const selected = tagFilter === tag;
            return (
              <Pressable
                key={tag || 'tag-all'}
                onPress={() => setTagFilter(tag)}
                style={[
                  styles.tagFilterBtn,
                  {
                    backgroundColor: selected ? colors.primary : colors.card,
                    borderColor: selected ? colors.primary : colors.border,
                  },
                ]}
                accessibilityState={{ selected }}
                accessibilityLabel={tag ? `按标签${tag}筛选` : '按全部标签筛选'}
              >
                <Text
                  style={[
                    styles.tagFilterText,
                    { color: selected ? '#FFFFFF' : colors.textSecondary },
                  ]}
                >
                  {tag || '标签'}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}

      <FlatList
        data={rows}
        keyExtractor={(item) => item.key}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => {
          if (item.kind === 'header') {
            return (
              <Text
                style={[styles.groupHeader, { color: colors.textSecondary }]}
                accessibilityRole="header"
              >
                {item.ungrouped ? '未分组' : `# ${item.tag}`}
              </Text>
            );
          }
          const bookmark = item.bookmark;
          const badge = TYPE_BADGE[bookmark.type];
          const bookTitle = bookmark.bookId
            ? (bookTitleMap.get(bookmark.bookId) ?? '未知书籍')
            : '';
          return (
            <Pressable
              onPress={() => openBookmark(bookmark)}
              style={({ pressed }) => [
                styles.itemCard,
                { backgroundColor: colors.card, borderColor: colors.border },
                pressed && styles.pressed,
              ]}
            >
              <View style={styles.itemHeader}>
                <View style={[styles.typeBadge, { backgroundColor: badge.bg }]}>
                  <Text style={[styles.typeBadgeText, { color: badge.fg }]}>{badge.label}</Text>
                </View>
                <Text style={[styles.bookTitle, { color: colors.primary }]}>
                  {bookTitle}
                </Text>
                <Text style={[styles.timeText, { color: colors.pinyin }]}>
                  {formatDate(bookmark.createdAt)}
                </Text>
              </View>

              {bookmark.text ? (
                <Text numberOfLines={3} style={[styles.itemText, { color: colors.text }]}>
                  {bookmark.text}
                </Text>
              ) : (
                <Text style={[styles.itemText, { color: colors.textSecondary }]}>
                  文章收藏
                </Text>
              )}

              {bookmark.tags && bookmark.tags.length > 0 ? (
                <View style={styles.tagsRow}>
                  {bookmark.tags.map((tag) => (
                    <View key={tag} style={[styles.tag, { backgroundColor: colors.primarySoft }]}>
                      <Text style={[styles.tagText, { color: colors.primary }]}>{tag}</Text>
                    </View>
                  ))}
                </View>
              ) : null}

              {bookmark.note ? (
                <Text
                  numberOfLines={2}
                  style={[styles.noteText, { color: colors.textSecondary }]}
                >
                  备注：{bookmark.note}
                </Text>
              ) : null}

              <View style={styles.cardActions}>
                <Pressable onPress={() => openEdit(bookmark)} hitSlop={10}>
                  <Text style={[styles.editText, { color: colors.primary }]}>编辑</Text>
                </Pressable>
                <Pressable onPress={() => confirmDelete(bookmark)} hitSlop={10}>
                  <Text style={[styles.deleteText, { color: colors.pinyin }]}>删除</Text>
                </Pressable>
              </View>
            </Pressable>
          );
        }}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              暂无收藏{filter || tagFilter ? '（当前筛选条件下）' : ''}
            </Text>
            {filter || tagFilter ? (
              <Pressable
                onPress={() => {
                  setFilter('');
                  setTagFilter('');
                }}
                style={[styles.primaryBtn, { backgroundColor: colors.primary }]}
              >
                <Text style={styles.primaryBtnText}>查看全部</Text>
              </Pressable>
            ) : null}
          </View>
        }
      />

      {/* 编辑弹层（P1-12：标签 quick-pick + 新增 + 备注） */}
      <Modal
        visible={editing !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setEditing(null)}
      >
        <Pressable style={styles.editOverlay} onPress={() => setEditing(null)}>
          <Pressable
            style={[styles.editSheet, { backgroundColor: colors.card }]}
            onPress={() => undefined}
          >
            <Text style={[styles.editTitle, { color: colors.text }]}>编辑收藏</Text>

            <Text style={[styles.editLabel, { color: colors.textSecondary }]}>标签</Text>
            {allTags.length > 0 ? (
              <View style={styles.tagPickWrap}>
                {allTags.map((tag) => {
                  const selected = editing?.tags.includes(tag) ?? false;
                  return (
                    <Pressable
                      key={tag}
                      onPress={() => toggleTag(tag)}
                      style={[
                        styles.tagPickChip,
                        {
                          backgroundColor: selected ? colors.primary : colors.background,
                          borderColor: selected ? colors.primary : colors.border,
                        },
                      ]}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      accessibilityLabel={`标签${tag}`}
                    >
                      <Text
                        style={[
                          styles.tagPickText,
                          { color: selected ? '#FFFFFF' : colors.textSecondary },
                        ]}
                      >
                        {tag}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : (
              <Text style={[styles.editLabel, { color: colors.pinyin }]}>暂无历史标签，可在下方新增</Text>
            )}

            <View style={styles.newTagRow}>
              <TextInput
                style={[
                  styles.newTagInput,
                  {
                    color: colors.text,
                    borderColor: colors.border,
                    backgroundColor: colors.background,
                  },
                ]}
                value={newTag}
                onChangeText={setNewTag}
                placeholder="新增标签"
                placeholderTextColor={colors.pinyin}
              />
              <Pressable
                onPress={addTag}
                style={[styles.addTagBtn, { backgroundColor: colors.primarySoft }]}
                accessibilityRole="button"
                accessibilityLabel="添加标签"
              >
                <Text style={[styles.addTagText, { color: colors.primary }]}>添加</Text>
              </Pressable>
            </View>

            <Text style={[styles.editLabel, { color: colors.textSecondary }]}>备注</Text>
            <TextInput
              style={[
                styles.noteInput,
                {
                  color: colors.text,
                  borderColor: colors.border,
                  backgroundColor: colors.background,
                },
              ]}
              value={editing?.note ?? ''}
              onChangeText={(text) =>
                setEditing((prev) => (prev ? { ...prev, note: text } : prev))
              }
              placeholder="为这条收藏写点备注…"
              placeholderTextColor={colors.pinyin}
              multiline
              textAlignVertical="top"
            />

            <View style={styles.editActions}>
              <Pressable onPress={() => setEditing(null)} accessibilityRole="button">
                <Text style={[styles.editCancelText, { color: colors.textSecondary }]}>取消</Text>
              </Pressable>
              <Pressable
                onPress={saveEdit}
                style={[styles.editSaveBtn, { backgroundColor: colors.primarySoft }]}
                accessibilityRole="button"
                accessibilityLabel="保存收藏编辑"
              >
                <Text style={[styles.editSaveText, { color: colors.primary }]}>保存</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* 导出格式选择弹层（P1-11） */}
      <Modal
        visible={exportVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setExportVisible(false)}
      >
        <Pressable style={styles.editOverlay} onPress={() => setExportVisible(false)}>
          <Pressable
            style={[styles.editSheet, { backgroundColor: colors.card }]}
            onPress={() => undefined}
          >
            <Text style={[styles.editTitle, { color: colors.text }]}>导出收藏</Text>
            <Text style={[styles.exportHint, { color: colors.textSecondary }]}>
              将按当前筛选条件导出 {filtered.length} 条收藏
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
              accessibilityLabel="分享收藏内容"
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
  titleActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  groupHeader: {
    fontSize: 13,
    fontWeight: '700',
    marginTop: 6,
    marginBottom: 6,
  },
  filterRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 8,
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
  tagFilterBtn: {
    paddingHorizontal: 14,
    paddingVertical: 5,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  tagFilterText: {
    fontSize: 13,
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
  pressed: {
    opacity: 0.7,
  },
  itemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  typeBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  typeBadgeText: {
    fontSize: 11,
    fontWeight: '600',
  },
  bookTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: '700',
  },
  timeText: {
    fontSize: 11,
  },
  itemText: {
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 8,
  },
  tagsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 8,
  },
  tag: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  tagText: {
    fontSize: 11,
  },
  noteText: {
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 8,
  },
  cardActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 16,
  },
  editText: {
    fontSize: 13,
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
  // 编辑弹层
  editOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  editSheet: {
    width: '88%',
    borderRadius: 14,
    padding: 16,
    gap: 10,
  },
  editTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  editLabel: {
    fontSize: 13,
  },
  tagPickWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  tagPickChip: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  tagPickText: {
    fontSize: 13,
  },
  newTagRow: {
    flexDirection: 'row',
    gap: 8,
  },
  newTagInput: {
    flex: 1,
    height: 38,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 10,
    fontSize: 14,
  },
  addTagBtn: {
    paddingHorizontal: 14,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addTagText: {
    fontSize: 14,
    fontWeight: '600',
  },
  noteInput: {
    height: 90,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: 10,
    fontSize: 14,
  },
  editActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 16,
    marginTop: 4,
  },
  editCancelText: {
    fontSize: 15,
  },
  editSaveBtn: {
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 8,
  },
  editSaveText: {
    fontSize: 15,
    fontWeight: '600',
  },
  // 导出弹层
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
