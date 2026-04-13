import { NextRequest, NextResponse } from "next/server";
import { readAccounts, readSettings, readTasks } from "@/lib/serverUtils";
import {
  shareExtractPayload,
  getShareData,
  getShareDirList,
  getShareDownloadUrl,
  receiveToMyDrive,
} from "@/lib/115share";
import type { AccountInfo } from "@/lib/115";
import { fs_files } from "@/lib/115";
import * as path from "path";
import * as fs from "fs";

// 通过 cid 获取完整路径
async function getPathByCid(cid: number, accountInfo: AccountInfo): Promise<string> {
  if (cid === 0) return "/";
  
  const pathParts: string[] = [];
  let currentCid = cid;
  
  // 最多查询 20 层，防止无限循环
  for (let i = 0; i < 20 && currentCid !== 0; i++) {
    try {
      const data = await fs_files(currentCid, { accountInfo, limit: 1 });
      const items = data.data || [];
      if (items.length === 0) break;
      
      const item = items[0];
      pathParts.unshift(item.n);
      currentCid = Number(item.pid) || 0;
    } catch (err) {
      console.error(`Failed to get path for cid ${currentCid}:`, err);
      break;
    }
  }
  
  return "/" + pathParts.join("/");
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      account,
      action,
      url,
      shareCode,
      receiveCode = "",
      cid = 0,
      fileId,
      fileIds,
      toPid = 0,
      limit = 32,
      offset = 0,
    } = body as {
      account?: string;
      action: "parse" | "info" | "list" | "download_url" | "receive";
      url?: string;
      shareCode?: string;
      receiveCode?: string;
      cid?: string;
      fileId?: number | string;
      fileIds?: number | string | (number | string)[];
      toPid?: string;
      limit?: number;
      offset?: number;
    };

    if (!action) {
      return NextResponse.json({ code: 400, message: "action is required" }, { status: 400 });
    }

    if (action === "parse") {
      if (!url) {
        return NextResponse.json({ code: 400, message: "url is required for parse" }, { status: 400 });
      }
      const payload = shareExtractPayload(url);
      return NextResponse.json({ code: 200, data: payload });
    }

    const accounts = readAccounts() as AccountInfo[];
    const accountName = account ?? (accounts.find((a) => a.accountType === "115")?.name);
    if (!accountName) {
      return NextResponse.json(
        { code: 400, message: "account is required and at least one 115 account must exist" },
        { status: 400 }
      );
    }

    const accountInfo = accounts.find((a) => a.name === accountName) as AccountInfo | undefined;
    if (!accountInfo || accountInfo.accountType !== "115") {
      return NextResponse.json({ code: 404, message: "115 account not found" }, { status: 404 });
    }
    if (!accountInfo.cookie) {
      return NextResponse.json({ code: 400, message: "115 account cookie is required" }, { status: 400 });
    }

    const settings = readSettings();
    const userAgent = req.headers.get("user-agent") || (settings["user-agent"] as string) || undefined;
    const opts = { userAgent };

    let sc = shareCode;
    let rc = receiveCode;
    if (url) {
      const p = shareExtractPayload(url);
      sc = p.share_code;
      rc = p.receive_code;
    }
    if (!sc) {
      return NextResponse.json({ code: 400, message: "url or shareCode is required" }, { status: 400 });
    }

    switch (action) {
      case "info": {
        const data = await getShareData(accountInfo, sc, rc, opts);
        return NextResponse.json({ code: 200, data });
      }
      case "list": {
        const list = await getShareDirList(accountInfo, sc, rc, cid, {
          limit,
          offset,
          userAgent: opts.userAgent,
        });
        return NextResponse.json({ code: 200, data: list });
      }
      case "download_url": {
        if (fileId == null) {
          return NextResponse.json({ code: 400, message: "fileId is required for download_url" }, { status: 400 });
        }
        const downloadUrl = await getShareDownloadUrl(accountInfo, sc, rc, fileId, opts);
        return NextResponse.json({ code: 200, data: { url: downloadUrl } });
      }
      case "receive": {
        const ids = fileIds ?? fileId;
        if (ids == null) {
          return NextResponse.json({ code: 400, message: "fileIds or fileId is required for receive" }, { status: 400 });
        }
        const result = await receiveToMyDrive(accountInfo, sc, rc, ids, toPid, opts);
        
        // 保存成功后，直接生成 strm 文件
        if (result && !result.error) {
          try {
            // 获取保存的目标路径
            const targetPath = await getPathByCid(Number(toPid), accountInfo);
            
            // 读取任务配置
            const tasks = readTasks();
            
            // 查找匹配的任务（必须是同一个账户）
            const matchedTask = tasks.find((task: any) => {
              if (task.accountType !== "115" || task.account !== accountName) return false;
              const originPath = task.originPath.startsWith("/") ? task.originPath : "/" + task.originPath;
              return targetPath === originPath || targetPath.startsWith(originPath + "/");
            });

            if (matchedTask) {
              
              const strmPrefix = matchedTask.strmPrefix || "";
              const enablePathEncoding = matchedTask.enablePathEncoding || false;
              const saveDir = path.resolve(process.cwd(), `../data/${matchedTask.targetPath}`);
              if (!fs.existsSync(saveDir)) {
                fs.mkdirSync(saveDir, { recursive: true });
              }
              
              // 获取目标目录下的所有文件
              const fileData = await fs_files(Number(toPid), { accountInfo, limit: 1000 });
              const files = fileData.data || [];
              
              let generatedCount = 0;
              for (const fileItem of files) {
                try {
                  const fileName = fileItem.n;
                  const isDir = fileItem.fc === 0;
                  
                  // 只处理视频文件
                  if (!isDir && /\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|ts)$/i.test(fileName)) {
                    // 计算相对路径
                    const originPath = matchedTask.originPath.startsWith("/") ? matchedTask.originPath : "/" + matchedTask.originPath;
                    const relativePath = targetPath.replace(originPath, "").replace(/^\//, "");
                    const localFilePath = path.join(saveDir, relativePath, fileName);
                    const localDir = path.dirname(localFilePath);
                    
                    if (!fs.existsSync(localDir)) {
                      fs.mkdirSync(localDir, { recursive: true });
                    }
                    
                    // 检查 strm 文件是否已存在
                    const ext = path.extname(fileName);
                    const strmPath = localFilePath.replace(ext, ".strm");
                    
                    if (!fs.existsSync(strmPath)) {
                      // 生成 strm 文件
                      const remoteFilePath = path.join(targetPath, fileName).replace(/\\/g, "/");
                      const fullPath = `${strmPrefix}${remoteFilePath}`;
                      const finalPath = enablePathEncoding ? encodeURI(fullPath) : fullPath;
                      
                      fs.writeFileSync(strmPath, finalPath, "utf8");
                      generatedCount++;
                    }
                  }
                } catch (err) {
                  console.error(`[share/receive] Failed to generate strm for file ${fileItem.n}:`, err);
                }
              }
              
              return NextResponse.json({ 
                code: 200, 
                data: result,
                strmGenerated: true,
                taskId: matchedTask.id,
                generatedCount,
              });
            }
          } catch (err) {
            console.error("[share/receive] Failed to generate strm files:", err);
            // 不影响保存结果，只是记录错误
          }
        }
        
        return NextResponse.json({ code: 200, data: result });
      }
      default:
        return NextResponse.json({ code: 400, message: "invalid action" }, { status: 400 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/115/share]", message);
    return NextResponse.json({ code: 500, message }, { status: 500 });
  }
}
