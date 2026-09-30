/**
 * 任务根下不进媒体库的暂存区：整理挪进去的「重复文件/」、复制后归档的「归档/」，原来的目录层级留在里面。
 *
 * 这个目录是给人看的暂存区，不算媒体库的一部分：
 *   - 整理不扫它（`buildUnits` 的入参过滤掉，自动整理的触发路径也过滤掉）；
 *   - 本地不镜像它（`matchTask` 当它不属于任何任务：挪进去时本地 strm 删掉，撤销挪回来再生成）；
 *   - 全量同步不给它生成 strm（`loadRemoteEntries` 过滤）。
 *
 * 名字不带点：夸克的列目录接口会把点开头的条目藏起来（建得成、列不出来），用户在网盘里也看不到。
 * 放在 strm/ 下：整理、复制、监控、全量同步四边都用这几个常量，谁也不该为了它们去 import 别人的模块。
 */
export const DUPLICATES_DIR = "重复文件";

/** 相对任务 originPath 的路径在不在重复文件目录里 */
export const underDuplicates = (rel: string): boolean => rel === DUPLICATES_DIR || rel.startsWith(`${DUPLICATES_DIR}/`);

/** 挪进重复文件目录后的路径：原来的目录层级留着 */
export const duplicatePathFor = (srcPath: string): string => `${DUPLICATES_DIR}/${srcPath}`;

/**
 * 「复制到 OpenList」复制成功后归档的落脚点：任务根下的 `归档/`，原来的目录层级留在里面
 * （tv/某剧/S01/E01.mkv → tv/归档/某剧/S01/E01.mkv）。和重复文件目录一样是不进媒体库的暂存区，三处排除都走 isStagingDir
 */
export const ARCHIVE_DIR = "归档";

/** 相对任务 originPath 的路径在不在归档目录里 */
export const underArchive = (rel: string): boolean => rel === ARCHIVE_DIR || rel.startsWith(`${ARCHIVE_DIR}/`);

/** 任务根下不进媒体库的暂存区（重复文件、归档）：整理不扫、本地不镜像、全量同步不生成 strm */
export const isStagingDir = (rel: string): boolean => underDuplicates(rel) || underArchive(rel);
