import { NextResponse } from "next/server";
import { getIronSession } from "iron-session";
import { sessionOptions, SessionData } from "@/lib/session";

export async function POST(req: Request) {
  const res = NextResponse.json({ message: "已退出" });
  const session = await getIronSession<SessionData>(req, res, sessionOptions);

  session.destroy();
  return res;
}
