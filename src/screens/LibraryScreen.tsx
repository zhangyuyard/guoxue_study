/**
 * 书架页（LibraryScreen）
 * 顶部：App 标题 + 导入/搜索/展示方式切换入口；中间：分类标签条
 * （全部/最近/经/史/子/集…，「最近」按最近阅读时间倒序）；
 * 主体：书籍网格（2 列）或列表（1 列）。点击书籍进入阅读器（续读）。
 * 排序：用户导入书籍排在内置经典之前（自己的书优先可见）。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { Book, BookCategory } from '@/types';
import type { T04StackParamList } from '@/screens/types';
import { useLibraryStore } from '@/store/useLibraryStore';
import { useReaderStore } from '@/store/useReaderStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { getColors, PAGE_TITLE_FONT_SIZE } from '@/theme';
import { BookCard } from '@/components/common/BookCard';
import { CategoryTabs, buildCategoryTabs } from '@/components/common/CategoryTabs';
import { UserBookService } from '@/services/UserBookService';
import { BUILTIN_CATALOG } from '@/data/builtinCatalog';

type Props = NativeStackScreenProps<T04StackParamList, 'Library'>;

/** 「最近」分类 key（伪分类：不对应 BookCategory，由阅读记录时间戳驱动） */
const RECENT_CATEGORY_KEY = '__recent__';

/** 「最近」分类最多展示的本数 */
const RECENT_LIST_MAX = 30;

/**
 * 书架排序（纯函数）：用户导入书籍排在内置经典之前（两组内保持原有
 * 顺序不变——内置书保持目录清单顺序、用户书保持注册顺序）。
 */
export function sortBooksUserFirst(books: Book[]): Book[] {
  const isUserBook = (b: Book): boolean => b.id.startsWith('user-');
  return [...books].sort((a, b) => Number(isUserBook(b)) - Number(isUserBook(a)));
}

export default function LibraryScreen({ navigation }: Props): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const theme = useSettingsStore((s) => s.theme);
  const colors = getColors(theme);

  const books = useLibraryStore((s) => s.books);
  const categories = useLibraryStore((s) => s.categories);
  const loading = useLibraryStore((s) => s.loading);
  const error = useLibraryStore((s) => s.error);
  const loadBooks = useLibraryStore((s) => s.loadBooks);
  const libraryLayout = useSettingsStore((s) => s.libraryLayout);
  const setLibraryLayout = useSettingsStore((s) => s.setLibraryLayout);

  /** 当前选中分类 key（'' 表示全部） */
  const [activeCategory, setActiveCategory] = useState('');
  /** 导入进行中 */
  const [importing, setImporting] = useState(false);
  /** 书籍文件夹路径（页脚提示，用户可往里放书自动上架） */
  const booksRoot = useMemo(() => UserBookService.getBooksRootPath(), []);

  useEffect(() => {
    loadBooks();
  }, [loadBooks]);

  /** 最近阅读时间戳（bookId -> epoch ms）：随阅读进展更新，「最近」tab 数据源 */
  const recentBooks = useReaderStore((s) => s.recentBooks);

  /** 「全部 + 最近 + 分类」标签数据（最近紧跟全部之后） */
  const tabs = useMemo(() => {
    const base = buildCategoryTabs(categories.map((c) => ({ key: c.key, label: c.label })));
    return [base[0], { key: RECENT_CATEGORY_KEY, label: '最近' }, ...base.slice(1)];
  }, [categories]);

  /** 「最近」列表：有阅读记录的书按最近阅读时间倒序（上限 30 本） */
  const recentList = useMemo(() => {
    const entries = Object.entries(recentBooks);
    if (entries.length === 0) {
      return [];
    }
    const stamps = new Map(entries);
    return books
      .filter((b) => stamps.has(b.id))
      .sort((a, b) => (stamps.get(b.id) ?? 0) - (stamps.get(a.id) ?? 0))
      .slice(0, RECENT_LIST_MAX);
  }, [books, recentBooks]);

  /** 过滤 + 排序（全部/最近/分类；用户书始终优先） */
  const filtered = useMemo(() => {
    let list: Book[];
    if (activeCategory === RECENT_CATEGORY_KEY) {
      list = recentList;
    } else {
      const sorted = sortBooksUserFirst(books);
      list = activeCategory
        ? sorted.filter((b) => b.category === (activeCategory as BookCategory))
        : sorted;
    }
    return list;
  }, [books, activeCategory, recentList]);

  /** 打开书籍 → 阅读器（BugFix 进度续读：该书有持久化阅读位置时恢复到
   * 上次的章节与段落，无记录或记录越界回落第一章） */
  const openBook = useCallback(
    (book: Book) => {
      if (book.chapters.length === 0) {
        return;
      }
      const last = useReaderStore.getState().lastRead;
      const resume =
        last !== null && last.bookId === book.id
          ? book.chapters.find((c) => c.id === last.chapterId)
          : undefined;
      const chapter = resume ?? book.chapters[0];
      navigation.navigate('Reader', {
        bookId: book.id,
        chapterId: chapter.id,
        segmentId: resume ? last?.segmentId : undefined,
      });
    },
    [navigation],
  );

  /** 导入书籍：选文件（txt/md/html/fb2/epub）→ 复制进书籍文件夹 → 解析上架。
   * 不限文件大小（超大文件解析稍久）。 */
  const handleImport = useCallback(async (): Promise<void> => {
    if (importing) {
      return;
    }
    setImporting(true);
    const res = await UserBookService.importBook();
    setImporting(false);
    if (res.success && res.data) {
      Alert.alert(
        '导入成功',
        `《${res.data.title}》共 ${res.data.chapters.length} 章，已加入书架`,
      );
      loadBooks();
    } else if (res.error && res.error !== '已取消选择文件') {
      Alert.alert('导入失败', res.error);
    }
  }, [importing, loadBooks]);

  /** 长按书籍 → 确认删除（所有书籍均可删，内置书可经「恢复内置书籍」找回） */
  const handleLongPressBook = useCallback(
    (book: Book): void => {
      const isBuiltin = !UserBookService.isUserBook(book.id);
      Alert.alert(
        '删除书籍',
        isBuiltin
          ? `《${book.title}》为内置书籍，删除后可通过书架底部「恢复内置书籍」找回。`
          : `《${book.title}》将从书架移除，书籍文件夹中的源文件一并删除（相关的划线与笔记将不再显示）。`,
        [
          { text: '取消', style: 'cancel' },
          {
            text: '删除',
            style: 'destructive',
            onPress: () => {
              void UserBookService.deleteBook(book.id).then((res) => {
                if (res.success) {
                  loadBooks();
                } else {
                  Alert.alert('删除失败', res.error);
                }
              });
            },
          },
        ],
      );
    },
    [loadBooks],
  );

  /** 恢复被删除的内置书籍（清空抑制记录 + 补写资源文件） */
  const [restoring, setRestoring] = useState(false);
  const handleRestoreBuiltins = useCallback((): void => {
    if (restoring) {
      return;
    }
    setRestoring(true);
    void UserBookService.restoreBuiltinBooks().then((res) => {
      setRestoring(false);
      if (res.success) {
        const restored = res.data ?? 0;
        if (restored < BUILTIN_CATALOG.length) {
          Alert.alert(
            '部分恢复',
            `本次仅恢复 ${restored}/${BUILTIN_CATALOG.length} 部内置书籍（资产复制受阻），重启应用后会自动重试。`,
          );
        }
        loadBooks();
      } else {
        Alert.alert('恢复失败', res.error);
      }
    });
  }, [restoring, loadBooks]);

  /** 空状态/错误状态 */
  if (error) {
    return (
      <View style={[styles.emptyWrap, { paddingTop: insets.top }]}>
        <Text style={[styles.emptyText, { color: colors.textSecondary }]}>{error}</Text>
        <Pressable
          onPress={loadBooks}
          style={[styles.retryBtn, { backgroundColor: colors.primary }]}
        >
          <Text style={styles.retryText}>重试</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* 顶部：标题 + 导入 + 搜索入口 */}
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.text }]}>国学书架</Text>
        <View style={styles.headerBtns}>
          <Pressable
            onPress={() => {
              void handleImport();
            }}
            disabled={importing}
            style={[styles.searchBtn, { backgroundColor: colors.primarySoft }]}
            accessibilityRole="button"
            accessibilityLabel="导入书籍"
          >
            <Text style={[styles.searchBtnText, { color: colors.primary }]}>
              {importing ? '导入中…' : '＋ 导入'}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => navigation.navigate('Search')}
            style={[styles.searchBtn, { backgroundColor: colors.primarySoft }]}
            accessibilityRole="button"
          >
            <Text style={[styles.searchBtnText, { color: colors.primary }]}>🔍 搜索</Text>
          </Pressable>
          {/* 展示方式切换：网格（2 列）⇄ 列表（1 列），随 settings 持久化 */}
          <Pressable
            onPress={() =>
              setLibraryLayout(libraryLayout === 'grid' ? 'list' : 'grid')
            }
            style={[styles.searchBtn, { backgroundColor: colors.primarySoft }]}
            accessibilityRole="button"
            accessibilityLabel={libraryLayout === 'grid' ? '切换为列表展示' : '切换为网格展示'}
          >
            <Text style={[styles.searchBtnText, { color: colors.primary }]}>
              {libraryLayout === 'grid' ? '☰' : '⊞'}
            </Text>
          </Pressable>
        </View>
      </View>

      {/* 分类标签 */}
      <CategoryTabs
        categories={tabs}
        active={activeCategory}
        onChange={setActiveCategory}
      />

      {/* 书籍网格/列表 */}
      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        numColumns={libraryLayout === 'grid' ? 2 : 1}
        key={libraryLayout}
        columnWrapperStyle={libraryLayout === 'grid' ? styles.gridRow : undefined}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => (
          <BookCard
            book={item}
            onPress={() => openBook(item)}
            onLongPress={() => handleLongPressBook(item)}
          />
        )}
        ListEmptyComponent={
          !loading ? (
            <View style={styles.emptyWrap}>
              <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
                暂无书籍
              </Text>
            </View>
          ) : null
        }
        ListFooterComponent={
          <View style={styles.footer}>
            <Pressable
              onPress={handleRestoreBuiltins}
              disabled={restoring}
              accessibilityRole="button"
              accessibilityLabel="恢复内置书籍"
            >
              <Text style={[styles.restoreText, { color: colors.primary }]}>
                {restoring ? '恢复中…' : '恢复内置书籍'}
              </Text>
            </Pressable>
            {(() => {
              // 装载诊断：真机上内置书异常（复制失败/解析失败/扫描中断）时
              // 直接在页脚可见，替代静默吞错
              const diag = UserBookService.getLibrarySyncDiagnostics();
              if (diag.scanInterrupted) {
                return (
                  <Text style={[styles.footerText, { color: colors.accent }]} numberOfLines={3}>
                    诊断：书籍扫描异常中断，本轮内置书注册已保留上次结果
                    {diag.scanInterruptedReason ? `（${diag.scanInterruptedReason}）` : ''}
                  </Text>
                );
              }
              if (diag.builtinParseFailures.length > 0) {
                return (
                  <Text style={[styles.footerText, { color: colors.accent }]} numberOfLines={3}>
                    诊断：内置书装载失败 {diag.builtinParseFailures.length} 部（{diag.builtinParseFailures.join('、')}）
                  </Text>
                );
              }
              if (diag.assetCopyFailures.length > 0) {
                return (
                  <Text style={[styles.footerText, { color: colors.accent }]}>
                    诊断：内置书资产复制失败 {diag.assetCopyFailures.length} 部（已走资产直读兜底，重启自动重试复制）
                  </Text>
                );
              }
              return null;
            })()}
            <Text style={[styles.footerText, { color: colors.pinyin }]}>
              共 {books.length} 本 · 离线可用 · 长按书籍可删除
            </Text>
            <Text style={[styles.footerText, { color: colors.pinyin }]} numberOfLines={2}>
              书籍文件夹：{booksRoot}
            </Text>
            <Text style={[styles.footerText, { color: colors.pinyin }]}>
              将书籍文件放入该文件夹，刷新后自动上架
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
  },
  title: {
    fontSize: PAGE_TITLE_FONT_SIZE,
    fontWeight: '700',
  },
  searchBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
  },
  searchBtnText: {
    fontSize: 14,
    fontWeight: '600',
  },
  headerBtns: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  gridRow: {
    paddingHorizontal: 10,
  },
  listContent: {
    paddingBottom: 20,
  },
  footer: {
    alignItems: 'center',
    paddingVertical: 16,
  },
  footerText: {
    fontSize: 12,
    textAlign: 'center',
    paddingHorizontal: 16,
  },
  restoreText: {
    fontSize: 13,
    fontWeight: '600',
    paddingVertical: 4,
  },
  emptyWrap: {
    alignItems: 'center',
    paddingVertical: 60,
    gap: 16,
  },
  emptyText: {
    fontSize: 15,
  },
  retryBtn: {
    paddingHorizontal: 28,
    paddingVertical: 10,
    borderRadius: 20,
  },
  retryText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
});
