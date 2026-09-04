/**
 * 注音 Hook（usePinyin）
 * 封装 PinyinService 调用：按当前设置中的注音模式对文本注音，
 * 内部经 useMemo 缓存 + annotateText 结果缓存，模式切换自动重算。
 */
import { useCallback, useMemo, useState } from 'react';
import type { PinyinAnnotation, PinyinMode } from '@/types';

import { annotateText, type AnnotateTextOptions } from '@/utils/pinyin';
import { useDictStore } from '@/store/useDictStore';
import { useSettingsStore } from '@/store/useSettingsStore';

export interface UsePinyinResult {
  /** 注音结果（off 模式或空文本时为空数组） */
  annotations: PinyinAnnotation[];
  /** 手动触发重新注音（强制跳过 useMemo 缓存） */
  annotate: () => void;
  /** 注音计算是否进行中（服务为同步实现，恒为 false，保留以兼容异步改造） */
  isLoading: boolean;
  /** 最近一次注音错误 */
  error?: string;
}

/**
 * 对文本注音的 Hook。
 * @param text 待注音文本
 * @param modeOverride 覆盖注音模式（默认取 useSettingsStore 的 pinyinMode）
 * @param opts 注音上下文（workId/bookId），用于 canon 语境化通假判定与多音字读音选择
 */
export function usePinyin(
  text: string,
  modeOverride?: PinyinMode,
  opts?: AnnotateTextOptions,
): UsePinyinResult {
  const storeMode = useSettingsStore((s) => s.pinyinMode);
  const mode = modeOverride ?? storeMode;
  // 字典域扩展：多音字读音来源切换后注音结果需要重算（作为缓存盐 + memo 依赖）
  const polyphoneSource = useDictStore((s) => s.polyphoneSource);
  const polyphoneSalt =
    polyphoneSource.type === 'dict' ? `dict:${polyphoneSource.dictId}` : 'builtin';
  const { workId, bookId } = opts ?? {};

  // 手动刷新版本号：bump 后 useMemo 重算
  const [version, setVersion] = useState(0);

  const { annotations, error } = useMemo(() => {
    if (!text || mode === 'off') {
      return { annotations: [] as PinyinAnnotation[], error: undefined as string | undefined };
    }
    const res = annotateText(text, mode, undefined, polyphoneSalt, opts);
    if (res.success && res.data) {
      return { annotations: res.data, error: undefined as string | undefined };
    }
    return { annotations: [] as PinyinAnnotation[], error: res.error ?? '注音失败' };
  }, [text, mode, version, polyphoneSalt, workId, bookId]);

  const annotate = useCallback(() => {
    setVersion((v) => v + 1);
  }, []);

  return { annotations, annotate, isLoading: false, error };
}

export default usePinyin;
