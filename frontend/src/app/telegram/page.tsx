"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { Bot, Settings, Users, MessageSquare, CheckCircle, XCircle, AlertCircle, RefreshCw, Play, Square } from "lucide-react";
import axiosInstance from "@/lib/axios";

interface TelegramConfig {
  botToken?: string;
  chatId?: string;
  webhookUrl?: string;
}

interface BotInfo {
  id: number;
  is_bot: boolean;
  first_name: string;
  username: string;
  can_join_groups: boolean;
  can_read_all_group_messages: boolean;
  supports_inline_queries: boolean;
}

interface WebhookInfo {
  url: string;
  has_custom_certificate: boolean;
  pending_update_count: number;
  last_error_date?: number;
  last_error_message?: string;
  max_connections?: number;
  allowed_updates?: string[];
}

export default function TelegramPage() {
  const [config, setConfig] = useState<TelegramConfig>({});
  const [botInfo, setBotInfo] = useState<BotInfo | null>(null);
  const [webhookInfo, setWebhookInfo] = useState<WebhookInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pollingStatus, setPollingStatus] = useState<{ polling: boolean; message: string } | null>(null);

  // 加载当前配置
  useEffect(() => {
    loadBotInfo();
    checkPollingStatus();
  }, []);

  const loadBotInfo = async () => {
    try {
      setLoading(true);
      const response = await axiosInstance.get('/api/telegram/bot');
      if (response.data.configured) {
        setBotInfo(response.data.bot.result);
        setWebhookInfo(response.data.webhook.result);
        setConfig({
          botToken: response.data.botToken || '',
          chatId: response.data.chatId || '',
          webhookUrl: response.data.webhook.result?.url || ''
        });
      }
    } catch (error) {
      console.error('Failed to load bot info:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      setLoading(true);
      setError(null);
      setSuccess(null);

      const response = await axiosInstance.post('/api/telegram/bot', {
        botToken: config.botToken,
        chatId: config.chatId,
        webhookUrl: config.webhookUrl
      });

      if (response.data.success) {
        setSuccess('Telegram bot configured successfully!');
        // 直接设置 botInfo，因为后端返回的是完整的 bot 信息
        setBotInfo(response.data.bot);
        // 更新配置显示
        setConfig({
          botToken: response.data.botToken || '',
          chatId: response.data.chatId || '',
          webhookUrl: response.data.webhook?.result?.url || ''
        });
        // 重新加载完整信息以获取 webhook 信息
        await loadBotInfo();
      }
    } catch (error: any) {
      const errorMessage = error.response?.data?.error || 'Failed to configure bot';
      const errorDetails = error.response?.data?.details || '';
      setError(errorDetails ? `${errorMessage}: ${errorDetails}` : errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Are you sure you want to remove the Telegram bot configuration?')) {
      return;
    }

    try {
      setLoading(true);
      setError(null);
      setSuccess(null);

      await axiosInstance.delete('/api/telegram/bot');
      setSuccess('Telegram bot configuration removed successfully!');
      setBotInfo(null);
      setWebhookInfo(null);
      setConfig({});
    } catch (error: any) {
      setError(error.response?.data?.error || 'Failed to remove bot configuration');
    } finally {
      setLoading(false);
    }
  };

  // 检查轮询状态
  const checkPollingStatus = async () => {
    try {
      const response = await axiosInstance.get('/api/telegram/polling');
      setPollingStatus(response.data);
    } catch (error) {
      console.error('Failed to check polling status:', error);
    }
  };

  // 启动轮询
  const startPolling = async () => {
    try {
      setLoading(true);
      setError(null);
      setSuccess(null);

      const response = await axiosInstance.post('/api/telegram/polling');
      
      if (response.data.success) {
        setSuccess('Polling started successfully!');
        await checkPollingStatus();
      }
    } catch (error: any) {
      setError(error.response?.data?.error || 'Failed to start polling');
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

      const response = await axiosInstance.delete('/api/telegram/polling');
      
      if (response.data.success) {
        setSuccess('Polling stopped successfully!');
        await checkPollingStatus();
      }
    } catch (error: any) {
      setError(error.response?.data?.error || 'Failed to stop polling');
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

      await axiosInstance.post('/api/telegram/send', {
        message: '🤖 Test message from FreeStrm!',
        type: 'info'
      });

      setSuccess('Test message sent successfully!');
    } catch (error: any) {
      setError(error.response?.data?.error || 'Failed to send test message');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center space-x-2">
        <Bot className="h-6 w-6" />
        <h1 className="text-3xl font-bold">Telegram Bot Management</h1>
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
                <Button variant="outline" onClick={handleDelete} disabled={loading}>
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
            Control the bot's polling mode for receiving messages
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
