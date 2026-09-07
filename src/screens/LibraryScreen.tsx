/**
 * 书架页（LibraryScreen）
 * 顶部：App 标题 + 搜索入口按钮；中间：分类标签条（全部/经/史/子/集）；
 * 主体：书籍卡片 2 列网格。点击书籍进入阅读器（第一章）。
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
import { useSettingsStore } from '@/store/useSettingsStore';
import { getColors, PAGE_TITLE_FONT_SIZE } from '@/theme';
import { BookCard } from '@/components/common/BookCard';
import { CategoryTabs, buildCategoryTabs } from '@/components/common/CategoryTabs';
import { UserBookService } from '@/services/UserBookService';

type Props = NativeStackScreenProps<T04StackParamList, 'Library'>;

export default function LibraryScreen({ navigation }: Props): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const theme = useSettingsStore((s) => s.theme);
  const colors = getColors(theme);

  const books = useLibraryStore((s) => s.books);
  const categories = useLibraryStore((s) => s.categories);
  const loading = useLibraryStore((s) => s.loading);
  const error = useLibraryStore((s) => s.error);
  const loadBooks = useLibraryStore((s) => s.loadBooks);

  /** 当前选中分类 key（'' 表示全部） */
  const [activeCategory, setActiveCategory] = useState('');
  /** 导入进行中 */
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    loadBooks();
  }, [loadBooks]);

  /** 「全部 + 分类」标签数据 */
  const tabs = useMemo(
    () => buildCategoryTabs(categories.map((c) => ({ key: c.key, label: c.label }))),
    [categories],
  );

  /** 按分类过滤 */
  const filtered = useMemo(() => {
    if (!activeCategory) {
      return books;
    }
    return books.filter((b) => b.category === (activeCategory as BookCategory));
  }, [books, activeCategory]);

  /** 打开书籍 → 阅读器（第一章） */
  const openBook = useCallback(
    (book: Book) => {
      const firstChapter = book.chapters[0];
      if (!firstChapter) {
        return;
      }
      navigation.navigate('Reader', {
        bookId: book.id,
        chapterId: firstChapter.id,
      });
    },
    [navigation],
  );

  /** 导入书籍：选文件（txt/md/html/fb2/epub）→ 解析 → 入库 → 刷新书架。
   * 文件超过 8MB 时先弹确认提示（大文件解析耗时较久），经用户同意再继续。 */
  const handleImport = useCallback(async (): Promise<void> => {
    if (importing) {
      return;
    }
    setImporting(true);
    const res = await UserBookService.importBook(undefined, {
      onConfirmLargeFile: (size: number) =>
        new Promise<boolean>((resolve) => {
          Alert.alert(
            '导入大文件',
            `该文件约 ${(size / 1024 / 1024).toFixed(1)}MB，解析可能需要一些时间，是否继续导入？`,
            [
              { text: '取消', style: 'cancel', onPress: () => resolve(false) },
              { text: '继续导入', onPress: () => resolve(true) },
            ],
          );
        }),
    });
    setImporting(false);
    if (res.success && res.data) {
      Alert.alert(
        '导入成功',
        `《${res.data.title}》共 ${res.data.chapters.length} 章，已加入书架`,
      );
      loadBooks();
    } else if (
      res.error &&
      res.error !== '已取消选择文件' &&
      res.error !== '已取消导入大文件'
    ) {
      Alert.alert('导入失败', res.error);
    }
  }, [importing, loadBooks]);

  /** 长按用户书 → 确认删除（内置经典不可删） */
  const handleLongPressBook = useCallback(
    (book: Book): void => {
      if (!UserBookService.isUserBook(book.id)) {
        return;
      }
      Alert.alert(
        '删除书籍',
        `《${book.title}》将从书架移除（相关的划线与笔记将不再显示）。`,
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
        </View>
      </View>

      {/* 分类标签 */}
      <CategoryTabs
        categories={tabs}
        active={activeCategory}
        onChange={setActiveCategory}
      />

      {/* 书籍网格 */}
      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        numColumns={2}
        columnWrapperStyle={styles.gridRow}
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
            <Text style={[styles.footerText, { color: colors.pinyin }]}>
              共 {books.length} 本 · 离线可用 · 长按用户书籍可删除
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
