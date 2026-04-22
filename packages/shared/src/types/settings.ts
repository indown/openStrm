export type AppSettings = {
  "user-agent"?: string;
  internalToken?: string;
  strmExtensions?: string[];
  downloadExtensions?: string[];
  linkMaxPerSecond?: number;
  linkMaxConcurrent?: number;
  downloadMaxConcurrent?: number;
  mediaMountPath?: string[];
  emby?: {
    url?: string;
    apiKey?: string;
  };
  telegram?: {
    botToken?: string;
    chatId?: string;
    webhookUrl?: string;
    allowedUsers?: number[];
  };
  tmdb?: {
    apiKey?: string;
    language?: string;
  };
} & Record<string, unknown>;
