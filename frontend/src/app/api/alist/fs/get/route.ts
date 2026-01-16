import { NextRequest, NextResponse } from "next/server";
import { get_id_to_path, getDownloadUrlWeb } from "@/lib/115";
import { readAccounts, readSettings } from "@/lib/serverUtils";

// 兼容 alist 的 /api/fs/get 接口
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { path } = body;

    if (!path) {
      return NextResponse.json({ code: 400, message: "path is required" }, { status: 400 });
    }

    // 路径格式: /115/{accountName}/xxx/xxx.mkv
    const pathParts = path.split("/").filter(Boolean);
    if (pathParts.length < 2 || pathParts[0] !== "115") {
      return NextResponse.json({ code: 400, message: "invalid path format, expected /115/{account}/..." }, { status: 400 });
    }

    const accountName = pathParts[1];
    const realPath = "/" + pathParts.slice(2).join("/");

    // 获取账户信息
    const accounts = readAccounts();
    const account = accounts.find((a: { name: string; accountType?: string }) => 
      a.name === accountName && a.accountType === "115"
    );
    
    if (!account) {
      return NextResponse.json({ code: 404, message: `account not found: ${accountName}` }, { status: 404 });
    }

    const settings = readSettings();
    const userAgent = settings["user-agent"] || undefined;

    // 获取 pickcode
    const pickcode = await get_id_to_path({
      path: realPath,
      userAgent,
      accountInfo: account,
    });

    if (!pickcode) {
      return NextResponse.json({ code: 404, message: "file not found" }, { status: 404 });
    }

    // 获取下载直链
    const rawUrl = await getDownloadUrlWeb(pickcode, {
      userAgent,
      accountInfo: account,
    });

    if (!rawUrl) {
      return NextResponse.json({ code: 500, message: "failed to get download url" }, { status: 500 });
    }

    // 返回 alist 格式响应
    return NextResponse.json({
      code: 200,
      message: "success",
      data: {
        raw_url: rawUrl,
        name: pathParts[pathParts.length - 1],
        provider: "115",
      },
    });
  } catch (error) {
    console.error("[alist-compat] Error:", error);
    return NextResponse.json({
      code: 500,
      message: error instanceof Error ? error.message : "internal error",
    }, { status: 500 });
  }
}
