/**
 * 章变化统一监听 hook。
 *
 * 移植自 @tangfeifan/react-native-reader（MIT License，v0.2.2 src/useReaderChapterChange.ts），
 * 保留原许可与出处；仅类型按本仓习惯内联。行为：第一个可读章只触发 onPrepare，
 * 后续不同可读章触发 onChapterChange；disabled 用于暂停统计（恢复后重建起点）。
 */
import { useEffect, useRef } from 'react';

export interface ChapterChangeEvent {
  chapterId: string;
}

export interface UseChapterChangeOptions {
  chapterId?: string | null;
  readable?: boolean;
  disabled?: boolean;
  onPrepare?: (event: ChapterChangeEvent) => void;
  onChapterChange?: (event: ChapterChangeEvent) => void;
}

type ActiveChapterSnapshot = ChapterChangeEvent;

export const useChapterChange = ({
  chapterId,
  readable = true,
  disabled = false,
  onPrepare,
  onChapterChange,
}: UseChapterChangeOptions): void => {
  const previousChapterRef = useRef<ActiveChapterSnapshot | null>(null);

  useEffect(() => {
    if (disabled) {
      previousChapterRef.current = null;
      return;
    }
    if (!readable || chapterId == null) return;

    const currentChapter: ActiveChapterSnapshot = { chapterId };
    const previousChapter = previousChapterRef.current;
    previousChapterRef.current = currentChapter;

    if (!previousChapter) {
      onPrepare?.(currentChapter);
      return;
    }
    if (previousChapter.chapterId === chapterId) return;

    onChapterChange?.(currentChapter);
  }, [chapterId, disabled, onChapterChange, onPrepare, readable]);
};
