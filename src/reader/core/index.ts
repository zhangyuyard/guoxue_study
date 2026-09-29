/** 阅读器核心（分层架构）公共出口 */
export { ReaderCore, type ReaderCoreProps } from './ReaderCore';
export { ScrollMode, type ScrollModeProps } from './modes/ScrollMode';
export { PageMode, type PageModeProps } from './modes/PageMode';
export { useChapterChange } from './useChapterChange';
export type { ReaderMode, BoundaryDirection } from './types';
