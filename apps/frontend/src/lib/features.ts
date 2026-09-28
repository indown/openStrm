/**
 * 前端功能开关。只隐藏入口，接口都还在：想恢复入口把开关翻回 true 即可。
 */
export const FEATURES: { hdhiveSearch: boolean } = {
  /** 顶栏「搜索影视资源（TMDB → HDHive）」入口，连同设置页的 HDHive 一节（只有这个入口用得到它） */
  hdhiveSearch: false,
};
