import { NextRequest, NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";

interface TreeNode {
  name: string;
  id: string; // 使用路径作为ID
  isDir: boolean;
  hasChildren?: boolean;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { basePath = "" } = body;

    // 基础路径是 data 目录
    const dataDir = path.resolve(process.cwd(), "../data");
    const targetPath = basePath
      ? path.join(dataDir, basePath)
      : dataDir;

    // 安全检查：确保路径在 data 目录内
    const normalizedTarget = path.normalize(targetPath);
    const normalizedDataDir = path.normalize(dataDir);
    if (!normalizedTarget.startsWith(normalizedDataDir)) {
      return NextResponse.json(
        { code: 400, message: "Invalid path" },
        { status: 400 }
      );
    }

    // 检查目录是否存在
    if (!fs.existsSync(targetPath)) {
      return NextResponse.json({
        code: 200,
        message: "success",
        data: [],
      });
    }

    const stat = fs.statSync(targetPath);
    if (!stat.isDirectory()) {
      return NextResponse.json({
        code: 200,
        message: "success",
        data: [],
      });
    }

    // 读取目录内容
    const items = fs.readdirSync(targetPath);
    const nodes: TreeNode[] = [];

    for (const item of items) {
      const itemPath = path.join(targetPath, item);
      try {
        const itemStat = fs.statSync(itemPath);
        if (itemStat.isDirectory()) {
          // 检查是否有子目录
          let hasChildren = false;
          try {
            const subItems = fs.readdirSync(itemPath);
            hasChildren = subItems.some((subItem) => {
              const subItemPath = path.join(itemPath, subItem);
              try {
                return fs.statSync(subItemPath).isDirectory();
              } catch {
                return false;
              }
            });
          } catch {
            // 忽略错误
          }

          // 计算相对路径作为ID
          const relativePath = basePath
            ? `${basePath}/${item}`
            : item;

          nodes.push({
            name: item,
            id: relativePath,
            isDir: true,
            hasChildren,
          });
        }
      } catch (error) {
        // 忽略无法访问的文件/目录
        console.error(`Error reading ${itemPath}:`, error);
      }
    }

    // 按名称排序
    nodes.sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({
      code: 200,
      message: "success",
      data: nodes,
    });
  } catch (error) {
    console.error("[directory/local/list] Error:", error);
    return NextResponse.json(
      {
        code: 500,
        message: error instanceof Error ? error.message : "internal error",
      },
      { status: 500 }
    );
  }
}
