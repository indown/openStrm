import { NextRequest, NextResponse } from "next/server";
import { readAccounts, readSettings } from "@/lib/serverUtils";
import {
  shareExtractPayload,
  getShareData,
  getShareDirList,
  getShareDownloadUrl,
  receiveToMyDrive,
} from "@/lib/115share";
import type { AccountInfo } from "@/lib/115";

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
      toPid?: number;
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
        const result = await receiveToMyDrive(accountInfo, sc, rc, ids, Number(toPid), opts);
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
