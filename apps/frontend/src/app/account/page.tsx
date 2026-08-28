"use client";
import { DataTable } from "@/components/data-table";
import { AddAccountDialog } from "./components/AddAccountDialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ColumnDef } from "@tanstack/react-table";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";
import { 
  Edit, 
  Trash2, 
  Plus,
  User,
  Key,
  AlertCircle
} from "lucide-react";

export type Account = {
  accountType: string;
  name: string;
  cookie?: string;      // 115 类型使用
  account?: string;     // openlist 类型使用 (用户名)
  password?: string;    // openlist 类型使用
  url?: string;         // openlist 类型使用
  token?: string;       // openlist 类型的认证令牌
  expiresAt?: number;   // openlist 类型的令牌过期时间
};

export default function AccountPage() {
  const [data, setData] = useState<Account[]>([]);
  // 只有首次加载显示整页转圈；之后的刷新列表留在屏幕上
  const [loaded, setLoaded] = useState(false);
  // 编辑 / 删除弹框放在页面层，由当前操作的那一行驱动，不在每一行里各放一份
  const [editing, setEditing] = useState<Account | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Account | null>(null);

  useEffect(() => {
    fetchAccounts();
  }, []);

  const fetchAccounts = async () => {
    try {
      setData(await api.accounts.list());
    } catch (err) {
      toast.error(apiErrorMessage(err, "获取账户列表失败"));
    } finally {
      setLoaded(true);
    }
  };

  const handleDelete = async (name: string) => {
    try {
      await api.accounts.remove(name);
      toast.success("删除成功");
      fetchAccounts();
    } catch (err) {
      toast.error(apiErrorMessage(err, "删除失败"));
    }
  };

  const columns: ColumnDef<Account>[] = [
    {
      accessorKey: "name",
      header: "账户名称",
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <User className="w-4 h-4 text-gray-500" />
          <span className="font-medium">{row.original.name}</span>
        </div>
      ),
    },
    {
      accessorKey: "accountType",
      header: "账户类型",
      cell: ({ row }) => (
        <Badge variant="outline" className="text-xs">
          {row.original.accountType}
        </Badge>
      ),
    },
    {
      id: "credentials",
      header: "认证信息",
      cell: ({ row }) => {
        const account = row.original;
        
        if (account.accountType === "115") {
          const cookie = account.cookie ?? "";
          const shortCookie = cookie.length > 30 ? cookie.slice(0, 30) + "..." : cookie;
          
          return (
            <div className="flex items-center gap-2">
              <Key className="w-4 h-4 text-gray-500" />
              <code 
                title={cookie} 
                className="text-xs bg-gray-100 px-2 py-1 rounded max-w-xs truncate block"
              >
                {shortCookie}
              </code>
            </div>
          );
        } else if (account.accountType === "openlist") {
          return (
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-xs">
                <User className="w-3 h-3 text-gray-500" />
                <span className="text-gray-600">用户:</span>
                <code className="bg-gray-100 px-1 rounded">{account.account}</code>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <Key className="w-3 h-3 text-gray-500" />
                <span className="text-gray-600">密码:</span>
                <code className="bg-gray-100 px-1 rounded">
                  {"*".repeat(Math.min(account.password?.length ?? 0, 8))}
                </code>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <span className="text-gray-600">URL:</span>
                <code className="bg-gray-100 px-1 rounded text-blue-600">
                  {account.url}
                </code>
              </div>
            </div>
          );
        }
        
        return <span className="text-gray-400">-</span>;
      },
    },
    {
      id: "actions",
      header: "操作",
      cell: ({ row }) => {
        const account = row.original;
        return (
          <div className="flex gap-1">
            <Button 
              variant="ghost" 
              size="sm"
              className="h-8 w-8 p-0"
              title="编辑账户"
              onClick={() => {
                setEditing(account);
                setEditorOpen(true);
              }}
            >
              <Edit className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 text-red-600 hover:text-red-700 hover:bg-red-50"
              title="删除账户"
              onClick={() => setDeleteTarget(account)}
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
        );
      },
    },
  ];

  if (!loaded) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="w-full h-full p-6">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-semibold">账户管理</h1>
          <p className="text-gray-600 mt-1">管理你的网盘账户信息</p>
        </div>
        <AddAccountDialog
          onSuccess={fetchAccounts}
          trigger={
            <Button>
              <Plus className="w-4 h-4 mr-2" />
              新增账户
            </Button>
          }
        />
      </div>
      
      {data.length === 0 ? (
        <div className="text-center py-12 bg-gray-50 rounded-lg">
          <AlertCircle className="mx-auto h-12 w-12 text-gray-400" />
          <h3 className="mt-4 text-lg font-medium text-gray-900">暂无账户</h3>
          <p className="mt-2 text-gray-600">点击上方按钮添加你的第一个账户</p>
        </div>
      ) : (
        <DataTable columns={columns} data={data} getRowId={(a) => a.name} />
      )}

      {/* 编辑弹框：整页一个，编辑哪一行就喂哪一行的数据 */}
      <AddAccountDialog
        account={editing ?? undefined}
        open={editorOpen}
        onOpenChange={setEditorOpen}
        onSuccess={fetchAccounts}
      />

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              你确定要删除账户 &ldquo;{deleteTarget?.name}&rdquo; 吗？此操作无法撤销。
              <br />
              <span className="text-sm text-gray-500 mt-2 block">
                账户类型: {deleteTarget?.accountType}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={() => {
                if (deleteTarget) void handleDelete(deleteTarget.name);
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
