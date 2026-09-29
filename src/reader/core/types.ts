/**
 * 阅读器核心统一类型（分层架构）。
 *
 * 分层思想对齐 @tangfeifan/react-native-reader（MIT，v0.2.2）：
 * 容器（模式路由+章边界上抛）/ 渲染模式（可插拔组件）/ 页帧纯渲染。
 * 差异声明：该库为纯文本行渲染（无逐字命中）；我们保留拼音逐字交互
 * （renderLine 注入行渲染）与自研排版（layout/stitch），仅借鉴其分层与
 * 受控/边界语义，非代码复制。
 */

/** 阅读模式（参考库 FlipMode 思想；仅 scroll / page 两种，均原生 FlatList，无 Skia 依赖） */
export type ReaderMode = 'scroll' | 'page';

/** 章边界请求方向（库 onBoundaryPrev/onBoundaryNext 语义）：渲染模式触达窗口边沿时上抛 */
export type BoundaryDirection = 'prev' | 'next';
