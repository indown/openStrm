import { NextRequest, NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";

const accountFile = path.resolve(process.cwd(), "../config/account.json");

function readAccounts() {
  if (!fs.existsSync(accountFile)) {
    fs.writeFileSync(accountFile, "[]", "utf-8");
  }
  return JSON.parse(fs.readFileSync(accountFile, "utf-8"));
}

function writeAccounts(data: any) {
  fs.writeFileSync(accountFile, JSON.stringify(data, null, 2), "utf-8");
}

// GET: 获取所有账号
export async function GET() {
  const accounts = readAccounts();
  return NextResponse.json(accounts);
}

// POST: 新建账号（基于 name 唯一）
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { accountType, name } = body;

  if (!accountType || !name) {
    return NextResponse.json(
      { error: "accountType and name are required" },
      { status: 400 }
    );
  }

  // 根据账户类型验证必需字段
  if (accountType === "115") {
    const { cookie } = body;
    if (!cookie) {
      return NextResponse.json(
        { error: "cookie is required for 115 accounts" },
        { status: 400 }
      );
    }
  } else if (accountType === "openlist") {
    const { account, password, url } = body;
    if (!account || !password || !url) {
      return NextResponse.json(
        { error: "account, password, and url are required for openlist accounts" },
        { status: 400 }
      );
    }
  }

  const accounts = readAccounts();
  if (accounts.find((a: any) => a.name === name)) {
    return NextResponse.json({ error: "Account name already exists" }, { status: 400 });
  }

  // 创建新账户，只包含提供的字段
  const newAccount = { accountType, name, ...body };
  delete newAccount.accountType; // 避免重复
  delete newAccount.name; // 避免重复
  const finalAccount = { accountType, name, ...newAccount };
  
  accounts.push(finalAccount);
  writeAccounts(accounts);

  return NextResponse.json(finalAccount, { status: 201 });
}

// PUT: 更新账号（基于 name）
export async function PUT(req: NextRequest) {
  const body = await req.json();
  const { name, accountType } = body;

  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  // 根据账户类型验证必需字段（如果提供了 accountType）
  if (accountType) {
    if (accountType === "115") {
      const { cookie } = body;
      if (!cookie) {
        return NextResponse.json(
          { error: "cookie is required for 115 accounts" },
          { status: 400 }
        );
      }
    } else if (accountType === "openlist") {
      const { account, password, url } = body;
      if (!account || !password || !url) {
        return NextResponse.json(
          { error: "account, password, and url are required for openlist accounts" },
          { status: 400 }
        );
      }
    }
  }

  const accounts = readAccounts();
  const idx = accounts.findIndex((a: any) => a.name === name);

  if (idx === -1) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  accounts[idx] = { ...accounts[idx], ...body };
  writeAccounts(accounts);

  return NextResponse.json(accounts[idx]);
}

// DELETE: 删除账号（基于 name）
export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const name = searchParams.get("name");

  if (!name) {
    return NextResponse.json({ error: "Missing name" }, { status: 400 });
  }

  const accounts = readAccounts();
  const newAccounts = accounts.filter((a: any) => a.name !== name);

  if (newAccounts.length === accounts.length) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  writeAccounts(newAccounts);
  return NextResponse.json({ message: "Account deleted" });
}
