import { NextRequest, NextResponse } from "next/server";
import { readAccounts } from "@/lib/serverUtils";
import { fs_files } from "@/lib/115";
import type { AccountInfo } from "@/lib/115";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { account, cid = 0 } = body as {
      account?: string;
      cid?: number;
    };

    const accounts = readAccounts() as AccountInfo[];
    const accountName = account ?? accounts.find((a) => a.accountType === "115")?.name;
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

    const data = await fs_files(cid, { accountInfo });
    return NextResponse.json({ code: 200, data: data.data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/115/files]", message);
    return NextResponse.json({ code: 500, message }, { status: 500 });
  }
}
