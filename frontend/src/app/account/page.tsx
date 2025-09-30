"use client";
import { DataTable } from "@/components/data-table";
import { AddAccountDialog } from "./components/AddAccountDialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ColumnDef } from "@tanstack/react-table";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import axios from "axios";
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
  const [isLoading, setIsLoading] = useState(true);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState<string | null>(null);

  useEffect(() => {
    fetchAccounts();
  }, []);

  const fetchAccounts = async () => {
    try {
      setIsLoading(true);
      const res = await axios.get("/api/account");
      setData(res.data);
    } catch {
      toast.error("获取账户列表失败");
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async (name: string) => {
    try {
      await axios.delete(`/api/account?name=${name}`);
      toast.success("删除成功");
      fetchAccounts();
    } catch {
      toast.error("删除失败");
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
            <AddAccountDialog
              account={account}
              trigger={
                <Button 
                  variant="ghost" 
                  size="sm"
                  className="h-8 w-8 p-0"
                  title="编辑账户"
                >
                  <Edit className="w-4 h-4" />
                </Button>
              }
              onSuccess={fetchAccounts}
            />
            <Dialog 
              open={deleteDialogOpen === account.name} 
              onOpenChange={(open) => setDeleteDialogOpen(open ? account.name : null)}
            >
              <DialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 text-red-600 hover:text-red-700 hover:bg-red-50"
                  title="删除账户"
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-[425px]">
                <DialogHeader>
                  <DialogTitle>确认删除</DialogTitle>
                  <DialogDescription>
                    你确定要删除账户 &ldquo;{account.name}&rdquo; 吗？此操作无法撤销。
                    <br />
                    <span className="text-sm text-gray-500 mt-2 block">
                      账户类型: {account.accountType}
                    </span>
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter className="gap-2">
                  <Button 
                    variant="outline"
                    onClick={() => setDeleteDialogOpen(null)}
                  >
                    取消
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => {
                      handleDelete(account.name);
                      setDeleteDialogOpen(null);
                    }}
                  >
                    删除
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        );
      },
    },
  ];

  if (isLoading) {
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
        <DataTable columns={columns} data={data} />
      )}
    </div>
  );
}
