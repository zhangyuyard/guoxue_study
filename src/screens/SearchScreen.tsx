/**
 * 全文搜索页（SearchScreen）
 * 搜索框（防抖 300ms，经 useSearch Hook）；历史标签区（横向滚动 Tag）；
 * 分组结果列表（按书名分组的 SectionList）；关键词高亮；点击结果跳转阅读器对应段落。
 */
import React, { useCallback, useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { SearchResult } from '@/types';
import type { T04StackParamList } from '@/screens/types';
import { useSearch } from '@/hooks/useSearch';
import { useSettingsStore } from '@/store/useSettingsStore';
import { BOOK_DYNASTIES, BOOK_GENRES, type BookGenre } from '@/data/bookMeta';
import {
  anyFilterActive,
  filterSearchResults,
  type SearchScope,
} from '@/utils/searchFilter';
import { getColors, PAGE_TITLE_FONT_SIZE } from '@/theme';

type Props = NativeStackScreenProps<T04StackParamList, 'Search'>;

/** 关键词范围档位（P2-10）：全部 / 仅书名 / 仅正文 */
const SEARCH_SCOPES: { value: SearchScope; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'title', label: '仅书名' },
  { value: 'content', label: '仅正文' },
];

/** 段落文本关键词高亮渲染（命中处黄色底） */
function HighlightedText({
  text,
  keyword,
  highlightColor,
  baseColor,
}: {
  text: string;
  keyword: string;
  highlightColor: string;
  baseColor: string;
}): React.JSX.Element {
  const kw = keyword.trim();
  if (!kw) {
    return <Text style={[styles.resultText, { color: baseColor }]}>{text}</Text>;
  }
  const parts = text.split(kw);
  return (
    <Text style={[styles.resultText, { color: baseColor }]}>
      {parts.map((part, idx) => (
        <Text key={idx}>
          {part}
          {idx < parts.length - 1 ? (
            <Text style={[styles.highlight, { backgroundColor: highlightColor }]}>
              {kw}
            </Text>
          ) : null}
        </Text>
      ))}
    </Text>
  );
}

export default function SearchScreen({ navigation }: Props): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const theme = useSettingsStore((s) => s.theme);
  const colors = getColors(theme);

  const { query, setQuery, groupedResults, history, clearHistory, isSearching, search } =
    useSearch();

  // ---------- 高级筛选（P2-10，页面态，不持久化） ----------
  /** 关键词范围：全部 / 仅书名 / 仅正文（默认全部，向后兼容） */
  const [scope, setScope] = useState<SearchScope>('all');
  /** 选中的朝代（多选，空 = 不限） */
  const [dynastySel, setDynastySel] = useState<string[]>([]);
  /** 选中的体裁（多选，空 = 不限） */
  const [genreSel, setGenreSel] = useState<BookGenre[]>([]);

  /** 切换朝代 chip 选中态 */
  const toggleDynasty = useCallback((dynasty: string) => {
    setDynastySel((prev) =>
      prev.includes(dynasty) ? prev.filter((d) => d !== dynasty) : [...prev, dynasty],
    );
  }, []);

  /** 切换体裁 chip 选中态 */
  const toggleGenre = useCallback((genre: BookGenre) => {
    setGenreSel((prev) =>
      prev.includes(genre) ? prev.filter((g) => g !== genre) : [...prev, genre],
    );
  }, []);

  /** 筛选是否生效中（空态文案区分用） */
  const filtersActive = anyFilterActive({ dynasties: dynastySel, genres: genreSel, scope });

  /**
   * 筛选后的分组结果：在按书分组结构上逐组过滤（筛选与关键词 AND 叠加），
   * 过滤后为空的书整组移除。
   */
  const filteredSections = useMemo(
    () =>
      groupedResults
        .map((group) => ({
          ...group,
          results: filterSearchResults(group.results, {
            dynasties: dynastySel,
            genres: genreSel,
            scope,
            keyword: query,
          }),
        }))
        .filter((group) => group.results.length > 0),
    [groupedResults, dynastySel, genreSel, scope, query],
  );

  const sections = filteredSections.map((group) => ({
    title: group.bookTitle,
    data: group.results,
  }));

  /** 点击历史标签 → 立即搜索 */
  const searchHistoryTag = useCallback(
    (kw: string) => {
      search(kw);
    },
    [search],
  );

  /** 点击结果 → 阅读器定位到段落 */
  const openResult = useCallback(
    (item: SearchResult) => {
      navigation.navigate('Reader', {
        bookId: item.bookId,
        chapterId: item.chapterId,
        segmentId: item.segmentId,
      });
    },
    [navigation],
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* 顶部标题 */}
      <Text style={[styles.title, { color: colors.text }]}>全文搜索</Text>

      {/* 搜索框 */}
      <View style={[styles.searchBar, { backgroundColor: colors.inputBackground }]}>
        <Text style={styles.searchIcon}>🔍</Text>
        <TextInput
          style={[styles.searchInput, { color: colors.text }]}
          value={query}
          onChangeText={setQuery}
          placeholder="输入关键词，如「子曰」「道可道」"
          placeholderTextColor={colors.pinyin}
          autoCorrect={false}
          returnKeyType="search"
        />
        {query ? (
          <Pressable onPress={() => setQuery('')} hitSlop={8}>
            <Text style={[styles.clearText, { color: colors.pinyin }]}>✕</Text>
          </Pressable>
        ) : null}
      </View>

      {/* 历史标签区 */}
      {history.length > 0 ? (
        <View style={styles.historyRow}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.historyTags}
          >
            <Text style={[styles.historyLabel, { color: colors.pinyin }]}>历史：</Text>
            {history.map((kw) => (
              <Pressable
                key={kw}
                onPress={() => searchHistoryTag(kw)}
                style={[styles.historyTag, { backgroundColor: colors.primarySoft }]}
              >
                <Text style={[styles.historyTagText, { color: colors.primary }]}>{kw}</Text>
              </Pressable>
            ))}
            <Pressable onPress={clearHistory} hitSlop={8} style={styles.historyClear}>
              <Text style={[styles.historyClearText, { color: colors.pinyin }]}>清空</Text>
            </Pressable>
          </ScrollView>
        </View>
      ) : null}

      {/* 高级筛选（P2-10）：关键词范围 + 朝代 / 体裁 chips，与关键词 AND 叠加 */}
      <View style={styles.filterArea}>
        {/* 关键词范围：三段式分段按钮 */}
        <View style={[styles.scopeRow, { borderColor: colors.border }]}>
          {SEARCH_SCOPES.map((item) => {
            const active = item.value === scope;
            return (
              <Pressable
                key={item.value}
                style={[
                  styles.scopeBtn,
                  active ? { backgroundColor: colors.primarySoft } : null,
                ]}
                onPress={() => setScope(item.value)}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
              >
                <Text
                  style={[
                    styles.scopeText,
                    { color: active ? colors.primary : colors.textSecondary },
                  ]}
                >
                  {item.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {/* 朝代 chips（多选） */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRow}
        >
          {BOOK_DYNASTIES.map((dynasty) => {
            const active = dynastySel.includes(dynasty);
            return (
              <Pressable
                key={dynasty}
                onPress={() => toggleDynasty(dynasty)}
                style={[
                  styles.chip,
                  { borderColor: colors.border },
                  active ? { backgroundColor: colors.primarySoft, borderColor: colors.primary } : null,
                ]}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
              >
                <Text
                  style={[
                    styles.chipText,
                    { color: active ? colors.primary : colors.textSecondary },
                  ]}
                >
                  {dynasty}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
        {/* 体裁 chips（多选） */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRow}
        >
          {BOOK_GENRES.map((genre) => {
            const active = genreSel.includes(genre);
            return (
              <Pressable
                key={genre}
                onPress={() => toggleGenre(genre)}
                style={[
                  styles.chip,
                  { borderColor: colors.border },
                  active ? { backgroundColor: colors.primarySoft, borderColor: colors.primary } : null,
                ]}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
              >
                <Text
                  style={[
                    styles.chipText,
                    { color: active ? colors.primary : colors.textSecondary },
                  ]}
                >
                  {genre}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {/* 搜索结果 */}
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.segmentId}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.listContent}
        renderSectionHeader={({ section }) => (
          <View style={[styles.sectionHeader, { backgroundColor: colors.background }]}>
            <Text style={[styles.sectionTitle, { color: colors.primary }]}>
              《{section.title}》
            </Text>
          </View>
        )}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => openResult(item)}
            style={({ pressed }) => [
              styles.resultCard,
              { backgroundColor: colors.card, borderColor: colors.border },
              pressed && styles.pressed,
            ]}
          >
            <HighlightedText
              text={item.text}
              keyword={query}
              highlightColor="#FFE75C"
              baseColor={colors.text}
            />
            <View style={styles.metaRow}>
              <Text style={[styles.chapterText, { color: colors.textSecondary }]}>
                {item.chapterTitle}
              </Text>
              <Text style={[styles.matchText, { color: colors.pinyin }]}>
                命中 {item.matchCount} 处
              </Text>
            </View>
          </Pressable>
        )}
        ListEmptyComponent={
          query.trim() ? (
            <View style={styles.emptyWrap}>
              <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
                {isSearching ? '正在搜索…' : '未找到相关段落'}
              </Text>
              {!isSearching ? (
                <Text style={[styles.emptyHint, { color: colors.pinyin }]}>
                  {filtersActive ? '当前筛选条件下无结果，试试放宽筛选' : '换个关键词试试'}
                </Text>
              ) : null}
            </View>
          ) : (
            <View style={styles.emptyWrap}>
              <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
                输入关键词，检索全部经典
              </Text>
            </View>
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  title: {
    fontSize: PAGE_TITLE_FONT_SIZE,
    fontWeight: '700',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 8,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    paddingHorizontal: 12,
    borderRadius: 22,
  },
  searchIcon: {
    fontSize: 14,
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    paddingVertical: 10,
    fontSize: 15,
  },
  clearText: {
    fontSize: 15,
    paddingHorizontal: 4,
  },
  historyRow: {
    marginTop: 10,
  },
  historyTags: {
    paddingHorizontal: 16,
    alignItems: 'center',
    gap: 8,
  },
  historyLabel: {
    fontSize: 12,
  },
  historyTag: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 14,
  },
  historyTagText: {
    fontSize: 13,
    fontWeight: '500',
  },
  historyClear: {
    paddingHorizontal: 4,
  },
  historyClearText: {
    fontSize: 12,
  },
  // 高级筛选（P2-10）
  filterArea: {
    marginTop: 10,
    gap: 8,
  },
  scopeRow: {
    flexDirection: 'row',
    marginHorizontal: 16,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  scopeBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 7,
  },
  scopeText: {
    fontSize: 13,
    fontWeight: '500',
  },
  chipRow: {
    paddingHorizontal: 16,
    alignItems: 'center',
    gap: 8,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipText: {
    fontSize: 13,
    fontWeight: '500',
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  sectionHeader: {
    paddingTop: 14,
    paddingBottom: 6,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
  },
  resultCard: {
    padding: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 8,
  },
  pressed: {
    opacity: 0.7,
  },
  resultText: {
    fontSize: 15,
    lineHeight: 22,
  },
  highlight: {
    color: '#333333',
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
  },
  chapterText: {
    fontSize: 12,
  },
  matchText: {
    fontSize: 12,
  },
  emptyWrap: {
    alignItems: 'center',
    paddingVertical: 60,
    gap: 8,
  },
  emptyText: {
    fontSize: 15,
  },
  emptyHint: {
    fontSize: 13,
  },
});
