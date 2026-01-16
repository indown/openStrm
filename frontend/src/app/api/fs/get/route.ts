import { NextRequest, NextResponse } from "next/server";
import { get_id_to_path, getDownloadUrlWeb } from "@/lib/115";
import { readAccounts, readSettings } from "@/lib/serverUtils";

// 兼容 alist 的 /api/fs/get 接口
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { path } = body;

    console.log("[alist-compat] Request path:", path);

    if (!path) {
      return NextResponse.json({ code: 400, message: "path is required" }, { status: 400 });
    }

    // 获取第一个 115 账户
    const accounts = readAccounts();
    const account = accounts.find((a: { accountType?: string }) => a.accountType === "115");
    
    if (!account) {
      console.log("[alist-compat] No 115 account found");
      return NextResponse.json({ code: 404, message: "no 115 account configured" }, { status: 404 });
    }

    console.log("[alist-compat] Using account:", account.name);

    const settings = readSettings();
    // 优先使用请求头的 UA，否则用配置的
    const reqUA = req.headers.get("user-agent");
    const userAgent = reqUA || settings["user-agent"] || undefined;

    console.log("[alist-compat] Using UA:", userAgent);

    // 获取 pickcode
    const pickcode = await get_id_to_path({
      path: path,
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
    const fileName = path.split("/").pop() || "";
    return NextResponse.json({
      code: 200,
      message: "success",
      data: {
        raw_url: rawUrl,
        name: fileName,
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
