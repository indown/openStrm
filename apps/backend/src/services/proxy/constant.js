// 如果使用拆分配置,请注意填写 config 下使用到的配置文件

import { readAppSettings } from "../../db/repositories/settings.js";
import commonConfig from "./config/constant-common.js";
import mountConfig from "./config/constant-mount.js";
import proConfig from "./config/constant-pro.js";
import symlinkConfig from "./config/constant-symlink.js";
import strmConfig from "./config/constant-strm.js";
import transcodeConfig from "./config/constant-transcode.js";
import extConfig from "./config/constant-ext.js";
import nginxConfig from "./config/constant-nginx.js";

let cached = null;
function ensureLoaded() {
  if (cached) return cached;
  const s = readAppSettings() || {};
  cached = {
    embyHost: (s.emby && s.emby.url) || "http://172.17.0.1:8096",
    embyApiKey: (s.emby && s.emby.apiKey) || "",
    mediaMountPath:
      Array.isArray(s.mediaMountPath) && s.mediaMountPath.length > 0
        ? s.mediaMountPath
        : ["/root/webdav/115"],
  };
  return cached;
}

// for js_set
function getEmbyHost(r) {
  return ensureLoaded().embyHost;
}
function getTranscodeEnable(r) {
  return transcodeConfig.transcodeConfig.enable;
}
function getTranscodeType(r) {
  return transcodeConfig.transcodeConfig.type;
}
function getImageCachePolicy(r) {
  return extConfig.imageCachePolicy;
}

function getUsersItemsLatestFilterEnable(r) {
  return extConfig.itemHiddenRule.some(rule => !rule[2] || rule[2] == 0 || rule[2] == 4);
}

export default {
  get embyHost() { return ensureLoaded().embyHost; },
  get embyApiKey() { return ensureLoaded().embyApiKey; },
  get mediaMountPath() { return ensureLoaded().mediaMountPath; },
  strHead: commonConfig.strHead,

  alistAddr: mountConfig.alistAddr,
  alistToken: mountConfig.alistToken,
  alistSignEnable: mountConfig.alistSignEnable,
  alistSignExpireTime: mountConfig.alistSignExpireTime,
  alistPublicAddr: mountConfig.alistPublicAddr,
  clientSelfAlistRule: mountConfig.clientSelfAlistRule,
  redirectCheckEnable: mountConfig.redirectCheckEnable,
  fallbackUseOriginal: mountConfig.fallbackUseOriginal,

  redirectConfig: proConfig.redirectConfig,
  routeCacheConfig: proConfig.routeCacheConfig,
  routeRule: proConfig.routeRule,
  mediaPathMapping: proConfig.mediaPathMapping,
  alistRawUrlMapping: proConfig.alistRawUrlMapping,

  symlinkRule: symlinkConfig.symlinkRule,
  redirectStrmLastLinkRule: strmConfig.redirectStrmLastLinkRule,
  transcodeConfig: transcodeConfig.transcodeConfig,

  embyNotificationsAdmin: extConfig.embyNotificationsAdmin,
  embyRedirectSendMessage: extConfig.embyRedirectSendMessage,
  itemHiddenRule: extConfig.itemHiddenRule,
  streamConfig: extConfig.streamConfig,
  searchConfig: extConfig.searchConfig,
  webCookie115: extConfig.webCookie115,
  directHlsConfig: extConfig.directHlsConfig,
  playbackInfoConfig: extConfig.playbackInfoConfig,

  getEmbyHost,
  getTranscodeEnable,
  getTranscodeType,
  getImageCachePolicy,
  getUsersItemsLatestFilterEnable,

  nginxConfig: nginxConfig.nginxConfig,
  getDisableDocs: nginxConfig.getDisableDocs,
}
