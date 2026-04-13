import { NextRequest, NextResponse } from "next/server";
import { fs_dir_getid, fs_files } from "@/lib/115";
import { readAccounts, readSettings } from "@/lib/serverUtils";

interface AccountInfo {
  name: string;
  cookie: string;
  accountType?: string;
  url?: string;
  token?: string;
}

interface FileItem {
  n: string; // 文件名
  fid: number; // 文件ID
  cid: number; // 目录ID
  fc?: number; // 文件数量（如果是目录）
  sha?: string; // 文件SHA值，文件夹通常为空或不存在
  [key: string]: unknown; // 允许其他字段
}

interface TreeNode {
  name: string;
  id: number;
  isDir: boolean;
  hasChildren?: boolean; // 标记是否有子目录（不加载子目录内容）
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { account, path = "" } = body;

    if (!account) {
      return NextResponse.json(
        { code: 400, message: "account is required" },
        { status: 400 }
      );
    }

    // 获取账户信息
    const accounts = readAccounts() as AccountInfo[];
    const accountInfo = accounts.find((a) => a.name === account);

    if (!accountInfo) {
      return NextResponse.json(
        { code: 404, message: "account not found" },
        { status: 404 }
      );
    }

    // 只支持115账户
    if ((accountInfo as AccountInfo).accountType !== "115") {
      return NextResponse.json(
        { code: 400, message: "only 115 accounts are supported" },
        { status: 400 }
      );
    }

    const settings = readSettings();
    const reqUA = req.headers.get("user-agent");
    const userAgent = reqUA || settings["user-agent"] || undefined;

    // 获取目录ID
    let cid = 0; // 默认根目录
    if (path) {
      try {
        const dirResp = await fs_dir_getid(path, {
          userAgent,
          accountInfo: accountInfo as AccountInfo,
        });
        cid = dirResp.id;
      } catch (error) {
        console.error(`Error getting directory ID for path ${path}:`, error);
        // 如果路径不存在，返回空数组
        return NextResponse.json({
          code: 200,
          message: "success",
          data: [],
        });
      }
    }
    // 只获取当前目录的直接子目录，不递归
    try {
      const filesResponse = await fs_files(cid, {
        userAgent,
        accountInfo: accountInfo as AccountInfo,
        limit: 1000,
        offset: 0,
      });
      const items: FileItem[] = filesResponse.data || [];
      const nodes: TreeNode[] = [];
      
      // 只返回目录，不返回文件
      // 判断标准：sha字段为空或不存在的是文件夹，有sha值的是文件
      for (const item of items) {
        // 文件夹：sha字段为空、undefined、null或不存在
        const isDirectory = !item.sha || item.sha === '' || item.sha === null;
        
        if (isDirectory) {
          nodes.push({
            name: item.n,
            id: item.cid,
            isDir: true,
            hasChildren: true, // 标记可能有子目录（实际是否有需要展开时才知道）
          });
        }
      }

      return NextResponse.json({
        code: 200,
        message: "success",
        data: nodes,
      });
    } catch (error) {
      console.error(`Error fetching directory list for cid ${cid}:`, error);
      return NextResponse.json({
        code: 200,
        message: "success",
        data: [],
      });
    }
  } catch (error) {
    console.error("[directory/remote/list] Error:", error);
    return NextResponse.json(
      {
        code: 500,
        message: error instanceof Error ? error.message : "internal error",
      },
      { status: 500 }
    );
  }
}
