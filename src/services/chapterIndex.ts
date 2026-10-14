/**
 * 章级索引工具：从段 id 反解章 id（纯函数，无副作用）。
 *
 * 存在的理由（2026-10-12「章节改偏移量」B 档 · 步骤 3）：
 * 原 `TextLibraryService.buildIndexes` 在注册/水合/淘汰时**全量遍历全书
 * `chapter.segments`** 建 `Map<segmentId, TextSegment>`。这是「整本书正文
 * 必须全量在内存」的根源之一：即便调用方只想读**一个**段（`getSegment`），
 * 索引本身也要求全书段落先物化。
 *
 * 段 id 生成规则（全仓唯一口径，`createChapterBuilder` 与资产解析一致）：
 *   segmentId = `${chapterId}-s${段序号}`，chapterId = `${bookId}-c${章序}`
 * ⇒ 反解只需从**末尾**剥掉 `-s<数字>`。
 *
 * ⚠ 为什么必须锚定末尾且用贪婪 `.*`：
 *   bookId 自身可能含 `-s<数字>` 形态的子串（如 `user-s3-c1`），
 *   非贪婪或非锚定匹配会剥错层 ⇒ 拿到不存在的章 id ⇒ 段查找静默失败。
 *   故正则为 `/^(.*)-s\d+$/`（`.*` 贪婪 + `$` 锚定 ⇒ 命中**最后一个** `-s<数字>`）。
 */

/**
 * 从段 id 反解所属章 id；格式不合法时返回 `null`。
 *
 * 返回 `null` 而不抛错：调用方（`getSegment`）的对外契约是「找不到 ⇒
 * `ServiceResult.success === false`」，格式非法与「章不存在」应同口径。
 */
export function chapterIdOfSegment(segmentId: string): string | null {
  if (typeof segmentId !== 'string' || segmentId.length === 0) {
    return null;
  }
  const m = /^(.*)-s\d+$/.exec(segmentId);
  if (!m) {
    return null;
  }
  const chapterId = m[1];
  // `-s1` 剥出空串 ⇒ 无效（章 id 不可能为空）
  return chapterId.length > 0 ? chapterId : null;
}
