export type RouteMode = "proxy" | "redirect" | "transcode" | "block" | "blockDownload" | "blockPlay";

/**
 * 5D rule array: [routeMode, groupName, sourceType, matcherType, matchTarget]
 */
export type RouteRule = [RouteMode, string, string, string, string | string[] | number];

export type MappingRule = [string, string, string, string?];

export interface CacheConfig {
  routeL1MaxSize: number;
  routeL2MaxSize: number;
  routeL1Ttl: number;
  routeL2Ttl: number;
}

export interface ProxyConfig {
  embyHost: string;
  embyApiKey: string;
  alistAddr: string;
  alistToken: string;
  alistSignEnable: boolean;
  alistSignExpireTime: number;
  mediaMountPath: string[];
  routeRule: RouteRule[];
  mediaPathMapping: MappingRule[];
  alistRawUrlMapping: MappingRule[];
  clientSelfAlistRule: MappingRule[];
  redirectStrmLastLinkRule: MappingRule[];
  redirectCheckEnable: boolean;
  fallbackUseOriginal: boolean;
  cacheConfig: CacheConfig;
}
