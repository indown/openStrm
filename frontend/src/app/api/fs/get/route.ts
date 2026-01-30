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

    // URL 解码路径（兼容编码后的路径，包括账户名）
    const decodedPath = decodeURIComponent(path);
    console.log("[alist-compat] Decoded path:", decodedPath);

    // 获取所有 115 账户
    const accounts = readAccounts();
    const accounts115 = accounts.filter((a: { accountType?: string }) => a.accountType === "115");
    
    if (accounts115.length === 0) {
      console.log("[alist-compat] No 115 account found");
      return NextResponse.json({ code: 404, message: "no 115 account configured" }, { status: 404 });
    }

    // 根据路径判断使用哪个账户（路径中包含账户名）
    // 例如路径：/root/webdav/115/my115/tv/xxx.mkv，匹配账户名 my115
    let account = accounts115.find((a: { name?: string }) => {
      if (!a.name) return false;
      // 检查路径中是否包含 /账户名/ 的格式
      return decodedPath.includes(`/${a.name}/`);
    });

    // 处理后的网盘路径（去掉前缀部分）
    let actualPath = decodedPath;

    // 如果没有匹配到，使用第一个 115 账户
    if (!account) {
      account = accounts115[0];
      console.log("[alist-compat] No account matched in path, using first account:", account.name);
    } else {
      console.log("[alist-compat] Matched account from path:", account.name);
      // 从路径中提取实际的网盘路径（去掉 /账户名/ 之前的部分）
      // 例如 /root/webdav/115/my115/tv/xxx.mkv -> tv/xxx.mkv
      const accountNamePattern = `/${account.name}/`;
      const idx = decodedPath.indexOf(accountNamePattern);
      if (idx !== -1) {
        actualPath = decodedPath.substring(idx + accountNamePattern.length);
        console.log("[alist-compat] Extracted actual path:", actualPath);
      }
    }

    const settings = readSettings();
    // 优先使用请求头的 UA，否则用配置的
    const reqUA = req.headers.get("user-agent");
    const userAgent = reqUA || settings["user-agent"] || undefined;

    console.log("[alist-compat] Using UA:", userAgent);

    // 获取 pickcode（使用处理后的实际网盘路径）
    const pickcode = await get_id_to_path({
      path: actualPath,
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
    const fileName = decodedPath.split("/").pop() || "";
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
