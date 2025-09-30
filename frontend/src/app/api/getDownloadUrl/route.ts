import { NextResponse } from "next/server";
import { from, mergeMap, Observable, Subject, delay } from "rxjs";
import { downloadTasks, DownloadProgress } from "@/lib/downloadTaskManager";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import * as fs from "fs";
import * as path from "path";
import { getLocalTree } from "@/lib/serverUtils";


export async function GET() {
  const response = await axios.get("http://localhost:5005/getSrcTreeList");
  return NextResponse.json({ message: "success" });
}
export async function POST(req: Request) {
  const body = await req.json();
  return NextResponse.json({ received: body });
}
