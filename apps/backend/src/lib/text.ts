/**
 * 看不见的字符：零宽空格 / 零宽连接符、BOM、软连字符、方向控制符这类（Unicode 的 Default_Ignorable_Code_Point）。
 * 分享和网盘上的文件名常被夹进这些字符来躲关键词过滤，肉眼看不出来，却会把 `S01E36` 拆坏、让标题搜不到。
 * 只在识别名字时去掉；网盘上的真实名字不动。
 */
const RE_INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu;

export function stripInvisible(s: string): string {
  return s.replace(RE_INVISIBLE, "");
}
