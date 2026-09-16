/**
 * 「挪进重复文件目录」的落脚点：任务根下的 `重复文件/`，原来的目录层级留在里面。
 *
 * 这个目录是给人看的暂存区，不算媒体库的一部分：
 *   - 整理不扫它（`buildUnits` 的入参过滤掉，自动整理的触发路径也过滤掉）；
 *   - 本地不镜像它（`matchTask` 当它不属于任何任务：挪进去时本地 strm 删掉，撤销挪回来再生成）；
 *   - 全量同步不给它生成 strm（`loadRemoteEntries` 过滤）。
 *
 * 名字不带点：夸克的列目录接口会把点开头的条目藏起来（建得成、列不出来），用户在网盘里也看不到。
 * 独立一个文件是为了让监控 / 同步那边也能引用，不用去 import 整理的规划模块（会绕回来成环）。
 */
export const DUPLICATES_DIR = "重复文件";

/** 相对任务 originPath 的路径在不在重复文件目录里 */
export const underDuplicates = (rel: string): boolean => rel === DUPLICATES_DIR || rel.startsWith(`${DUPLICATES_DIR}/`);

/** 挪进重复文件目录后的路径：原来的目录层级留着 */
export const duplicatePathFor = (srcPath: string): string => `${DUPLICATES_DIR}/${srcPath}`;
