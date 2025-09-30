import fs from "fs";
import path from "path";
import axios from "axios";

const CACHE_DIR = path.resolve(process.cwd(), "../cache");
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function getLatestCacheFile(account: string) {
  const files = fs.readdirSync(CACHE_DIR).filter((f) => f.split("-")[0] === String(account));
  if (files.length === 0) return null;

  const latest = files
    .map((f) => {
      const timestamp = Number(f.split("-")[1]?.replace(".json", ""));
      return { file: f, timestamp };
    })
    .filter((f) => !isNaN(f.timestamp))
    .sort((a, b) => b.timestamp - a.timestamp)[0];

  return latest || null;
}

export async function getData({id, account, originPath}: {id: string, account: string, originPath: string}) {
  const now = Date.now();
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  // console.log("id, account, originPath:", id, account, originPath);
  const latestCache = getLatestCacheFile(id);

  // 命中缓存
  if (latestCache && now - latestCache.timestamp < TWO_HOURS) {
    console.log("✅ 使用缓存:", latestCache.file);
    const content = fs.readFileSync(
      path.join(CACHE_DIR, latestCache.file),
      "utf-8"
    );
    return JSON.parse(content);
  }

  // 拉取新数据
  console.log("⏬ 拉取新数据");
  const response = await axios.get(
    `http://localhost:5005/getSrcTreeList?account=${account}&path=${originPath}`
  );
  const data = response.data;

  // 保存缓存
  const cacheFile = path.join(CACHE_DIR, `${id}-${now}.json`);
  fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2), "utf-8");

  // 清理旧缓存
  fs.readdirSync(CACHE_DIR)
    .filter((f) => f.startsWith(id) && f !== path.basename(cacheFile))
    .forEach((f) => fs.unlinkSync(path.join(CACHE_DIR, f)));

  return data;
}