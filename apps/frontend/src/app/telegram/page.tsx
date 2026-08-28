"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Bot, Settings, MessageSquare, CheckCircle, XCircle, AlertCircle, RefreshCw, Play, Square, Users, ShieldCheck } from "lucide-react";
import { apiErrorBody, apiErrorMessage } from "@/lib/axios";
import { api, type TelegramBotInfo as BotInfo, type TelegramWebhookInfo as WebhookInfo } from "@/lib/api";

interface TelegramConfig {
  botToken?: string;
  chatId?: string;
  webhookUrl?: string;
}

export default function TelegramPage() {
  const [config, setConfig] = useState<TelegramConfig>({});
  const [botInfo, setBotInfo] = useState<BotInfo | null>(null);
  const [webhookInfo, setWebhookInfo] = useState<WebhookInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pollingStatus, setPollingStatus] = useState<{ polling: boolean; message: string } | null>(null);
  // 是否允许 Bot 的"启动"按钮真的跑任务（settings.telegram.allowTaskStart，默认关）
  const [allowTaskStart, setAllowTaskStart] = useState(false);
  const [allowTaskStartSaving, setAllowTaskStartSaving] = useState(false);
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);

  // 加载当前配置
  useEffect(() => {
    loadBotInfo();
    checkPollingStatus();
    loadAllowTaskStart();
  }, []);

  const loadBotInfo = async () => {
    try {
      setLoading(true);
      const status = await api.telegram.bot.get();
      if (status.configured) {
        setBotInfo(status.bot.result);
        setWebhookInfo(status.webhook.result ?? null);
        setConfig({
          botToken: status.botToken || '',
          chatId: status.chatId || '',
          webhookUrl: status.webhook.result?.url || ''
        });
      }
    } catch (error) {
      toast.error(apiErrorMessage(error, "加载 Bot 配置失败"));
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      setLoading(true);
      setError(null);
      setSuccess(null);

      const response = await api.telegram.bot.configure({
        botToken: config.botToken ?? "",
        chatId: config.chatId,
        webhookUrl: config.webhookUrl
      });

      if (response.success) {
        setSuccess('Telegram bot configured successfully!');
        // 直接设置 botInfo，因为后端返回的是完整的 bot 信息
        setBotInfo(response.bot);
        // 更新配置显示
        // 配置接口不回 token/webhook，沿用刚提交的值；随后的 loadBotInfo 会拿到完整信息
        setConfig({
          botToken: config.botToken || '',
          chatId: response.chatId || '',
          webhookUrl: config.webhookUrl || ''
        });
        // 重新加载完整信息以获取 webhook 信息
        await loadBotInfo();
      }
    } catch (error) {
      const { message, details } = apiErrorBody(error);
      const errorMessage = message || 'Failed to configure bot';
      setError(details ? `${errorMessage}: ${details}` : errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    try {
      setLoading(true);
      setError(null);
      setSuccess(null);

      await api.telegram.bot.remove();
      setSuccess('Telegram bot configuration removed successfully!');
      setBotInfo(null);
      setWebhookInfo(null);
      setConfig({});
    } catch (error) {
      setError(apiErrorMessage(error, 'Failed to remove bot configuration'));
    } finally {
      setLoading(false);
    }
  };

  // 检查轮询状态
  const checkPollingStatus = async () => {
    try {
      setPollingStatus(await api.telegram.polling.status());
    } catch (error) {
      toast.error(apiErrorMessage(error, "获取轮询状态失败"));
    }
  };

  const loadAllowTaskStart = async () => {
    try {
      const settings = await api.settings.get();
      setAllowTaskStart(Boolean(settings.telegram?.allowTaskStart));
    } catch (error) {
      toast.error(apiErrorMessage(error, "加载设置失败"));
    }
  };

  // 勾选即保存；PUT 是整组替换，patchGroup 会先把 telegram 组里的其它字段带上
  const toggleAllowTaskStart = async (next: boolean) => {
    setAllowTaskStart(next);
    setAllowTaskStartSaving(true);
    try {
      await api.settings.patchGroup("telegram", { allowTaskStart: next });
      toast.success(next ? "已允许从 Telegram 启动任务" : "已禁止从 Telegram 启动任务");
    } catch (error) {
      setAllowTaskStart(!next);
      toast.error(apiErrorMessage(error, "保存失败"));
    } finally {
      setAllowTaskStartSaving(false);
    }
  };

  // 启动轮询
  const startPolling = async () => {
    try {
      setLoading(true);
      setError(null);
      setSuccess(null);

      const response = await api.telegram.polling.start();
      if (response.success) {
        setSuccess('Polling started successfully!');
        await checkPollingStatus();
      }
    } catch (error) {
      setError(apiErrorMessage(error, 'Failed to start polling'));
    } finally {
      setLoading(false);
    }
  };

  // 停止轮询
  const stopPolling = async () => {
    try {
      setLoading(true);
      setError(null);
      setSuccess(null);

      const response = await api.telegram.polling.stop();
      if (response.success) {
        setSuccess('Polling stopped successfully!');
        await checkPollingStatus();
      }
    } catch (error) {
      setError(apiErrorMessage(error, 'Failed to stop polling'));
    } finally {
      setLoading(false);
    }
  };

  const testBot = async () => {
    if (!config.chatId) {
      setError('Please set a Chat ID first');
      return;
    }

    try {
      setLoading(true);
      setError(null);
      setSuccess(null);

      await api.telegram.send({ message: '🤖 Test message from OpenStrm!', type: 'info' });

      setSuccess('Test message sent successfully!');
    } catch (error) {
      setError(apiErrorMessage(error, 'Failed to send test message'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center space-x-2">
          <Bot className="h-6 w-6" />
          <h1 className="text-3xl font-bold">Telegram Bot Management</h1>
        </div>
        <Button variant="outline" asChild>
          <Link href="/telegram/users">
            <Users className="h-4 w-4 mr-2" />
            管理授权用户
          </Link>
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <XCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {success && (
        <Alert>
          <CheckCircle className="h-4 w-4" />
          <AlertDescription>{success}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        {/* Bot Configuration */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <Settings className="h-5 w-5" />
              <span>Bot Configuration</span>
            </CardTitle>
            <CardDescription>
              Configure your Telegram bot settings
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="botToken">Bot Token</Label>
              <Input
                id="botToken"
                type="password"
                placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
                value={config.botToken || ''}
                onChange={(e) => setConfig({ ...config, botToken: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">已保存的 token 只显示末 4 位；原样提交等于不改，输入新值即替换</p>
              <p className="text-sm text-muted-foreground">
                Get your bot token from @BotFather. Format: 数字:35位字符
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="chatId">Chat ID</Label>
              <Input
                id="chatId"
                placeholder="Enter your chat ID"
                value={config.chatId || ''}
                onChange={(e) => setConfig({ ...config, chatId: e.target.value })}
              />
              <p className="text-sm text-muted-foreground">
                Send a message to your bot and check the webhook logs to get your chat ID
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="webhookUrl">Webhook URL (Optional)</Label>
              <Input
                id="webhookUrl"
                placeholder="https://yourdomain.com/api/telegram/webhook"
                value={config.webhookUrl || ''}
                onChange={(e) => setConfig({ ...config, webhookUrl: e.target.value })}
              />
              <p className="text-sm text-muted-foreground">
                Leave empty to use polling instead of webhook
              </p>
            </div>

            <div className="flex space-x-2">
              <Button onClick={handleSave} disabled={loading || !config.botToken}>
                {loading ? 'Saving...' : 'Save Configuration'}
              </Button>
              {botInfo && (
                <Button variant="outline" onClick={() => setRemoveDialogOpen(true)} disabled={loading}>
                  Remove Configuration
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Bot Status */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <Bot className="h-5 w-5" />
              <span>Bot Status</span>
            </CardTitle>
            <CardDescription>
              Current bot information and status
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {botInfo ? (
              <>
                <div className="flex items-center space-x-2">
                  <Badge variant="outline" className="bg-green-50 text-green-700">
                    <CheckCircle className="h-3 w-3 mr-1" />
                    Connected
                  </Badge>
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between">
                    <span className="text-sm font-medium">Bot Name:</span>
                    <span className="text-sm">{botInfo.first_name}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm font-medium">Username:</span>
                    <span className="text-sm">@{botInfo.username}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm font-medium">Bot ID:</span>
                    <span className="text-sm">{botInfo.id}</span>
                  </div>
                </div>

                <Separator />

                <div className="space-y-2">
                  <h4 className="text-sm font-medium">Capabilities:</h4>
                  <div className="space-y-1">
                    <div className="flex items-center space-x-2">
                      {botInfo.can_join_groups ? (
                        <CheckCircle className="h-3 w-3 text-green-500" />
                      ) : (
                        <XCircle className="h-3 w-3 text-red-500" />
                      )}
                      <span className="text-xs">Can join groups</span>
                    </div>
                    <div className="flex items-center space-x-2">
                      {botInfo.can_read_all_group_messages ? (
                        <CheckCircle className="h-3 w-3 text-green-500" />
                      ) : (
                        <XCircle className="h-3 w-3 text-red-500" />
                      )}
                      <span className="text-xs">Can read all group messages</span>
                    </div>
                    <div className="flex items-center space-x-2">
                      {botInfo.supports_inline_queries ? (
                        <CheckCircle className="h-3 w-3 text-green-500" />
                      ) : (
                        <XCircle className="h-3 w-3 text-red-500" />
                      )}
                      <span className="text-xs">Supports inline queries</span>
                    </div>
                  </div>
                </div>

                <Button onClick={testBot} disabled={loading} className="w-full">
                  <MessageSquare className="h-4 w-4 mr-2" />
                  Send Test Message
                </Button>
              </>
            ) : (
              <div className="text-center py-8">
                <AlertCircle className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground">
                  No bot configured. Please configure your bot first.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Polling Control */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <RefreshCw className="h-5 w-5" />
            <span>Polling Control</span>
          </CardTitle>
          <CardDescription>
            Control the bot&apos;s polling mode for receiving messages
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {pollingStatus && (
            <div className="flex items-center space-x-2">
              <Badge variant={pollingStatus.polling ? "default" : "outline"}>
                {pollingStatus.polling ? "Polling Active" : "Webhook Mode"}
              </Badge>
              <span className="text-sm text-muted-foreground">{pollingStatus.message}</span>
            </div>
          )}

          <div className="flex space-x-2">
            <Button 
              onClick={startPolling} 
              disabled={loading || (pollingStatus?.polling === true)}
              variant="outline"
            >
              <Play className="h-4 w-4 mr-2" />
              Start Polling
            </Button>
            <Button 
              onClick={stopPolling} 
              disabled={loading || (pollingStatus?.polling === false)}
              variant="outline"
            >
              <Square className="h-4 w-4 mr-2" />
              Stop Polling
            </Button>
            <Button 
              onClick={checkPollingStatus} 
              disabled={loading}
              variant="outline"
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh Status
            </Button>
          </div>

          <div className="text-sm text-muted-foreground">
            <p><strong>Polling Mode:</strong> Bot checks for new messages every 5 seconds (reduced frequency to avoid conflicts)</p>
            <p><strong>Webhook Mode:</strong> Telegram sends messages directly to your server</p>
          </div>
        </CardContent>
      </Card>

      {/* Bot 权限 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <ShieldCheck className="h-5 w-5" />
            <span>Bot 权限</span>
          </CardTitle>
          <CardDescription>
            只有授权用户能使用 Bot 命令；是否允许 Bot 直接启动同步任务单独控制
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-start gap-2 rounded-md border p-3 cursor-pointer">
            <Checkbox
              checked={allowTaskStart}
              disabled={allowTaskStartSaving}
              onCheckedChange={(v) => void toggleAllowTaskStart(v === true)}
              className="mt-0.5"
            />
            <span>
              <span className="text-sm font-medium">允许从 Telegram 启动任务</span>
              <span className="block text-xs text-muted-foreground">
                默认关闭。开启后，授权用户点 Bot 消息里的「启动」按钮会真的跑一次同步任务；关闭时按钮只会提示未开启。
              </span>
            </span>
          </label>
          <div className="text-sm text-muted-foreground">
            授权用户列表在
            <Link href="/telegram/users" className="underline mx-1">授权用户</Link>
            页面维护。
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={removeDialogOpen} onOpenChange={setRemoveDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>移除 Bot 配置</AlertDialogTitle>
            <AlertDialogDescription>
              确定要移除 Telegram Bot 配置吗？Bot Token、Chat ID 和 Webhook 设置都会被清掉。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleDelete()}>移除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Webhook Information */}
      {webhookInfo && (
        <Card>
          <CardHeader>
            <CardTitle>Webhook Information</CardTitle>
            <CardDescription>
              Current webhook configuration and status
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-sm font-medium">Webhook URL:</span>
                <span className="text-sm font-mono">{webhookInfo.url || 'Not set'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm font-medium">Pending Updates:</span>
                <Badge variant={webhookInfo.pending_update_count > 0 ? "destructive" : "outline"}>
                  {webhookInfo.pending_update_count}
                </Badge>
              </div>
              {webhookInfo.last_error_message && (
                <div className="space-y-1">
                  <span className="text-sm font-medium text-red-600">Last Error:</span>
                  <p className="text-sm text-red-600">{webhookInfo.last_error_message}</p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
