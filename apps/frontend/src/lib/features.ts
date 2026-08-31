/**
 * 前端功能开关。只隐藏入口，页面和接口都还在：
 * 直接访问 /library、调用对应 API 都不受影响，想恢复入口把开关翻回 true 即可。
 */
export const FEATURES: { libraryEntry: boolean; hdhiveSearch: boolean } = {
  /** 侧栏「影库」入口 */
  libraryEntry: false,
  /** 顶栏「搜索影视资源（TMDB → HDHive）」入口 */
  hdhiveSearch: false,
};
