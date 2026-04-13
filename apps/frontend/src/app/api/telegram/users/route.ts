// Telegram 简单用户管理 API
import { NextRequest, NextResponse } from "next/server";
import { 
  getTelegramUsers, 
  addTelegramUser, 
  removeTelegramUser
} from "@/lib/serverUtils";

// 获取所有用户
export async function GET() {
  try {
    const userIds = getTelegramUsers();
    const users = userIds.map(id => ({ id }));
    return NextResponse.json({ users });
  } catch (error) {
    console.error("Get Telegram users error:", error);
    return NextResponse.json({ 
      error: "Failed to get users", 
      details: error instanceof Error ? error.message : String(error) 
    }, { status: 500 });
  }
}

// 添加用户
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { userId } = body;

    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    const userIdNum = parseInt(userId);
    if (isNaN(userIdNum)) {
      return NextResponse.json({ error: "Invalid userId" }, { status: 400 });
    }

    const success = addTelegramUser(userIdNum);
    
    if (success) {
      return NextResponse.json({ 
        success: true, 
        message: "User added successfully" 
      });
    } else {
      return NextResponse.json({ 
        error: "User already exists" 
      }, { status: 409 });
    }
  } catch (error) {
    console.error("Add Telegram user error:", error);
    return NextResponse.json({ 
      error: "Failed to add user", 
      details: error instanceof Error ? error.message : String(error) 
    }, { status: 500 });
  }
}

// 删除用户
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('userId');

    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    const userIdNum = parseInt(userId);
    if (isNaN(userIdNum)) {
      return NextResponse.json({ error: "Invalid userId" }, { status: 400 });
    }

    const success = removeTelegramUser(userIdNum);
    
    if (success) {
      return NextResponse.json({ 
        success: true, 
        message: "User removed successfully" 
      });
    } else {
      return NextResponse.json({ 
        error: "User not found" 
      }, { status: 404 });
    }
  } catch (error) {
    console.error("Remove Telegram user error:", error);
    return NextResponse.json({ 
      error: "Failed to remove user", 
      details: error instanceof Error ? error.message : String(error) 
    }, { status: 500 });
  }
}
