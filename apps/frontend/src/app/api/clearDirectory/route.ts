import { NextRequest, NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";

export async function POST(req: NextRequest) {
  try {
    const { targetPath } = await req.json();
    
    if (!targetPath) {
      return NextResponse.json({ error: "目标路径不能为空" }, { status: 400 });
    }

    // 构建完整的本地路径
    const localPath = path.join(process.cwd(), "../data", targetPath);
    
    // 检查路径是否存在
    if (!fs.existsSync(localPath)) {
      return NextResponse.json({ error: "目录不存在" }, { status: 404 });
    }

    // 检查路径是否为目录
    const stat = fs.statSync(localPath);
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: "路径不是目录" }, { status: 400 });
    }

    // 清空目录
    const clearDirectory = (dirPath: string) => {
      const files = fs.readdirSync(dirPath);
      
      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const fileStat = fs.statSync(filePath);
        
        if (fileStat.isDirectory()) {
          // 递归删除子目录
          clearDirectory(filePath);
          fs.rmdirSync(filePath);
        } else {
          // 删除文件
          fs.unlinkSync(filePath);
        }
      }
    };

    clearDirectory(localPath);
    
    return NextResponse.json({ 
      message: "目录清空成功",
      clearedPath: targetPath 
    });
    
  } catch (error) {
    console.error("清空目录失败:", error);
    return NextResponse.json({ 
      error: "清空目录失败: " + (error instanceof Error ? error.message : "未知错误") 
    }, { status: 500 });
  }
}
