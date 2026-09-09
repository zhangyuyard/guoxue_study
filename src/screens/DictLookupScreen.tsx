/**
 * 查字页（DictLookupScreen）
 * 搜索框（前缀联想 searchPrefix）→ 字头大字 + 拼音多音条 + 部首笔画 +
 * 各启用字典分节释义（DictEntryCard）+ 相关词（word-dict.json 前缀匹配）。
 * 引擎未就绪时展示初始化失败态（App 启动 init 降级不阻塞其他功能）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CommonActions } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { AppStackParamList } from '@/navigation/types';
import type { DictLookupResult } from '@/types/dict';
import wordDictData from '@/data/word-dict.json';
import { DictEngine } from '@/services/dict/DictEngine';
import DictEntryCard from '@/components/dict/DictEntryCard';
import PolyphoneReadingsBar from '@/components/dict/PolyphoneReadingsBar';
import { useDictStore } from '@/store/useDictStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { getColors } from '@/theme';

type Props = NativeStackScreenProps<AppStackParamList, 'DictLookup'>;

/** 联想防抖间隔 */
const SUGGEST_DEBOUNCE_MS = 200;
/** 相关词最多展示数 */
const MAX_RELATED_WORDS = 8;

interface WordItem {
  word: string;
  meaning: string;
}

const WORDS = wordDictData.words as unknown as WordItem[];

export default function DictLookupScreen({ route, navigation }: Props): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const theme = useSettingsStore((s) => s.theme);
  const colors = getColors(theme);
  const defaultDictId = useDictStore((s) => s.defaultDictId);

  const [query, setQuery] = useState(route.params?.headword ?? '');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [result, setResult] = useState<DictLookupResult | null>(null);
  const [notFound, setNotFound] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 前缀联想（防抖） */
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    const text = query.trim();
    if (!text) {
      setSuggestions([]);
      return;
    }
    debounceRef.current = setTimeout(() => {
      const res = DictEngine.searchPrefix(text, 10);
      if (res.success && res.data) {
        setSuggestions(res.data.filter((s) => s !== text));
      } else {
        setSuggestions([]);
      }
    }, SUGGEST_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [query]);

  /** 执行查询 */
  const doLookup = useCallback((headword: string): void => {
    const target = headword.trim();
    if (!target) {
      return;
    }
    setSuggestions([]);
    const res = DictEngine.lookup(target);
    if (res.success && res.data) {
      setResult(res.data);
      setNotFound(res.data.results.every((r) => r.entry === null));
    } else {
      setResult(null);
      setNotFound(true);
    }
  }, []);

  /** 路由携带字头（阅读器「在字典中查看」跳转） */
  useEffect(() => {
    const headword = route.params?.headword;
    if (headword) {
      setQuery(headword);
      doLookup(headword);
    }
  }, [route.params?.headword, doLookup]);

  /** 单字时相关词（word-dict.json 前缀匹配） */
  const relatedWords = useMemo(() => {
    if (!result || Array.from(result.headword).length !== 1) {
      return [];
    }
    return WORDS.filter((w) => w.word.startsWith(result.headword)).slice(0, MAX_RELATED_WORDS);
  }, [result]);

  const firstHit = result?.results.find((r) => r.entry !== null)?.entry ?? null;
  const engineReady = DictEngine.isReady();

  const handleWordTap = (word: string): void => {
    setQuery(word);
    doLookup(word);
  };

  /**
   * 打开字典管理页（管理入口按钮）。
   * DictLookup 挂载于两处，DictManage 亦然（同构注册，路由检测自动适配）：
   *   1. 「我的」Tab 的 ProfileStack —— 两个 navigator 均注册了 DictManage，
   *      直接 navigate（返回回 ProfileStack 的查字页/我的页）；
   *   2. RootStack 级（阅读器解析面板「在字典中查看」直达）—— RootStack 同样
   *      注册了 DictManage，直接 navigate 压栈（返回逐级回退到查字页 → 阅读器）。
   *      （历史实现兜底走 Main→Profile→ProfileStack→DictManage，DictManage 压进
   *      「我的」Tab 的栈，返回落在设置页——「返回不回查字页」的根因，已废弃。）
   * 兼容性说明：路由检测基于当前 navigator 的 routeNames（结构无关），
   * 嵌套兜底分支保留为防御性代码（当前两个挂载点均已注册 DictManage，不会触达）。
   */
  const openDictManage = useCallback((): void => {
    const state = navigation.getState();
    if (state.routeNames.includes('DictManage')) {
      navigation.navigate('DictManage');
      return;
    }
    navigation.dispatch(
      CommonActions.navigate({
        name: 'Main',
        params: { screen: 'Profile', params: { screen: 'DictManage' } },
      }),
    );
  }, [navigation]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* 搜索区 */}
      <View style={[styles.searchWrap, { paddingTop: insets.top + 8, borderColor: colors.border }]}>
        <View style={[styles.searchBox, { backgroundColor: colors.inputBackground }]}>
          <Text style={styles.searchIcon}>🔍</Text>
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            value={query}
            onChangeText={setQuery}
            placeholder="输入要查的字或词…"
            placeholderTextColor={colors.pinyin}
            returnKeyType="search"
            autoFocus={!route.params?.headword}
            onSubmitEditing={() => doLookup(query)}
          />
          {query.length > 0 ? (
            <Pressable onPress={() => { setQuery(''); setResult(null); setNotFound(false); setSuggestions([]); }} hitSlop={8} accessibilityRole="button" accessibilityLabel="清空搜索">
              <Text style={[styles.clearButton, { color: colors.textSecondary }]}>✕</Text>
            </Pressable>
          ) : null}
        </View>
        {suggestions.length > 0 ? (
          <View style={[styles.suggestionBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {suggestions.map((s) => (
              <Pressable
                key={s}
                style={({ pressed }) => [styles.suggestionItem, pressed && styles.pressed]}
                onPress={() => handleWordTap(s)}
              >
                <Text style={[styles.suggestionText, { color: colors.text }]}>{s}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>

      {/* 结果区 */}
      <ScrollView
        style={styles.resultScroll}
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        keyboardShouldPersistTaps="handled"
      >
        {!engineReady ? (
          <View style={styles.centerBox}>
            <Text style={[styles.hintTitle, { color: colors.textSecondary }]}>字典引擎未就绪</Text>
            <Text style={[styles.hintDesc, { color: colors.textSecondary }]}>
              原生字典正在初始化，请稍候重试；如持续失败请重启应用
            </Text>
          </View>
        ) : !result ? (
          <View style={styles.centerBox}>
            <Text style={styles.emptyIcon}>📕</Text>
            <Text style={[styles.hintTitle, { color: colors.text }]}>查字词典</Text>
            <Text style={[styles.hintDesc, { color: colors.textSecondary }]}>
              支持繁简/异体字头自动归一化，多字典对照释义
            </Text>
          </View>
        ) : (
          <View style={styles.resultWrap}>
            {/* 字头大字 + 拼音 */}
            <View style={styles.headwordWrap}>
              <Text style={[styles.headword, { color: colors.text }]}>{result.headword}</Text>
              <View style={styles.headMeta}>
                <Text style={[styles.pinyin, { color: colors.pinyin }]}>
                  {firstHit?.pinyin || '—'}
                </Text>
                {result.charInfo ? (
                  <Text style={[styles.charMeta, { color: colors.textSecondary }]}>
                    {[
                      result.charInfo.radical ? `部首 ${result.charInfo.radical}` : '',
                      result.charInfo.strokes ? `${result.charInfo.strokes} 画` : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                ) : null}
              </View>
            </View>

            {/* 多音字读音条 */}
            <PolyphoneReadingsBar char={result.headword} />

            {/* 异体 / 通假 */}
            {result.charInfo &&
            (result.charInfo.yiti.length > 0 || result.charInfo.tongjia) ? (
              <View style={[styles.charInfoBox, { backgroundColor: colors.card }]}>
                {result.charInfo.yiti.length > 0 ? (
                  <Text style={[styles.charInfoText, { color: colors.textSecondary }]}>
                    异体字：{result.charInfo.yiti.join('、')}
                  </Text>
                ) : null}
                {result.charInfo.tongjia ? (
                  <Text style={[styles.charInfoText, { color: colors.textSecondary }]}>
                    通假：通「{result.charInfo.tongjia.original}」（{result.charInfo.tongjia.note}）
                  </Text>
                ) : null}
              </View>
            ) : null}

            {/* 各字典分节 */}
            {result.results.map((r) => (
              <DictEntryCard
                key={r.dict.id}
                dict={r.dict}
                entry={r.entry}
                isDefault={defaultDictId === r.dict.id}
              />
            ))}

            {notFound ? (
              <View style={[styles.notFoundBox, { borderColor: colors.border }]}>
                <Text style={[styles.hintTitle, { color: colors.text }]}>未收录</Text>
                <Text style={[styles.hintDesc, { color: colors.textSecondary }]}>
                  「{result.headword}」在当前启用字典中未收录，可在管理页调整启用字典或导入新字典
                </Text>
              </View>
            ) : null}

            {/* 相关词 */}
            {relatedWords.length > 0 ? (
              <View style={styles.relatedWrap}>
                <Text style={[styles.relatedTitle, { color: colors.text }]}>相关词</Text>
                <View style={styles.relatedRow}>
                  {relatedWords.map((w) => (
                    <Pressable
                      key={w.word}
                      style={[styles.relatedChip, { backgroundColor: colors.primarySoft }]}
                      onPress={() => handleWordTap(w.word)}
                      accessibilityRole="button"
                      accessibilityLabel={`查看词语 ${w.word}`}
                    >
                      <Text style={[styles.relatedChipText, { color: colors.primary }]}>{w.word}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ) : null}

            {/* 管理入口 */}
            <Pressable
              style={({ pressed }) => [
                styles.manageButton,
                { borderColor: colors.primary },
                pressed && styles.pressed,
              ]}
              onPress={openDictManage}
              accessibilityRole="button"
              accessibilityLabel="管理字典"
            >
              <Text style={[styles.manageButtonText, { color: colors.primary }]}>管理字典 / 导入新字典</Text>
            </Pressable>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  searchWrap: {
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    paddingHorizontal: 10,
    gap: 8,
  },
  searchIcon: {
    fontSize: 14,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 10,
  },
  clearButton: {
    fontSize: 14,
    padding: 4,
  },
  suggestionBox: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 4,
  },
  suggestionItem: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  suggestionText: {
    fontSize: 14,
  },
  resultScroll: {
    flex: 1,
  },
  resultWrap: {
    padding: 16,
    gap: 12,
  },
  headwordWrap: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 14,
  },
  headword: {
    fontSize: 56,
    lineHeight: 64,
    fontWeight: '700',
  },
  headMeta: {
    flex: 1,
    gap: 2,
    paddingBottom: 8,
  },
  pinyin: {
    fontSize: 16,
  },
  charMeta: {
    fontSize: 13,
  },
  charInfoBox: {
    borderRadius: 10,
    padding: 10,
    gap: 4,
  },
  charInfoText: {
    fontSize: 13,
    lineHeight: 20,
  },
  notFoundBox: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    gap: 6,
    alignItems: 'center',
  },
  relatedWrap: {
    marginTop: 4,
    gap: 8,
  },
  relatedTitle: {
    fontSize: 14,
    fontWeight: '700',
  },
  relatedRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  relatedChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
  },
  relatedChipText: {
    fontSize: 13,
  },
  manageButton: {
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: 4,
  },
  manageButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  centerBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 64,
    gap: 8,
  },
  emptyIcon: {
    fontSize: 44,
  },
  hintTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  hintDesc: {
    fontSize: 13,
    textAlign: 'center',
    paddingHorizontal: 24,
    lineHeight: 19,
  },
  pressed: {
    opacity: 0.7,
  },
});
