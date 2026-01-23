<div align="center">
  <img src="https://raw.githubusercontent.com/indown/openStrm/refs/heads/main/frontend/public/logo.png" alt="OpenStrm Logo" width="200" height="200">
</div>

# OpenStrm

**🎉 更新通知（v0.3.0）**：项目从 v0.3.0 开始支持 Emby 302 115 了，大家开始享用吧！

> 推荐：如果使用 115 302 的话，建议将 115 账号命名和 OpenList 或 CD 内命名一致，这样可以保证找不到地址的时候可以正确回源。
>
> **前置配置**：
> 1. 请在项目内配置好 Emby 的地址以及 API Key
> 2. 新建同步任务时开启 302 开关

---

**重要通知（必读）**：由于 Next.js 的重大漏洞 https://nextjs.org/blog/CVE-2025-66478 ，请务必将项目更新到最新版 v0.2.5。请立即停止使用 v0.2.4 及以下版本，以免造成安全风险。

一个开源的 **Strm 生成工具**。不完全使用指南：[文档地址](https://www.yuque.com/aitiaodetuzi/ueexc2/ynkwg2flhsvf233c)

## ✨ 为什么做这个软件

希望此项目能帮助大家更简单创建的自己strm库。  

该项目的目标是：**开放、简洁、可改造**。  

本项目参考或依赖以下项目： 
- [p115client](https://github.com/ChenyangGao/p115client/)
- [Alist](https://github.com/alist-org/alist)  
- [Openlist](https://github.com/OpenListTeam/OpenList)  
- [embyExternalUrl](https://github.com/bpking1/embyExternalUrl)  
- [rclone](https://github.com/rclone/rclone)  

## 🚀 特性

- 开源自由
- 支持批量生成 `.strm` 文件
- 支持自定义前缀（方便配合媒体服务器使用）
- 基于115目录树生成
- 支持账号级限流和重试逻辑
- 轻量，无额外依赖，易于二次开发

## 📦 安装 & 使用

### 使用 Docker (推荐)

```bash
# 使用 Docker Compose
git clone https://github.com/indown/OpenStrm.git
cd OpenStrm
docker-compose up -d
```

### 手动构建

```bash
# 克隆项目
git clone https://github.com/indown/OpenStrm.git
cd OpenStrm

# 安装依赖
cd frontend
npm install

# 启动服务
npm run dev
```

### Docker 镜像

项目支持多架构构建 (linux/amd64, linux/arm64)：

```bash
# 拉取最新镜像
docker pull indown/openstrm:latest

# 运行容器
docker run -d \
  --name openstrm \
  -p 3000:3000 \
  -p 8091:8091 \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/config:/app/config \
  -v $(pwd)/emby2Alist/nginx/log:/var/log/nginx \
  indown/openstrm:latest
```

**端口说明**：
- `3000`: 前端管理界面
- `8091`: Emby 302 代理端口（Emby 客户端使用此端口连接）

**目录挂载说明**：
- `./data`: 存储应用数据
- `./config`: 存储配置文件
- `./emby2Alist/nginx/log`: Nginx 日志目录

### 生产环境部署

```bash
# 使用生产环境配置
docker-compose -f docker-compose.prod.yml up -d
```

## 🔧 配置说明

### 默认登录信息

首次启动后，使用以下默认账号登录：

```json
{
    "username": "admin",
    "password": "admin"
}
```

⚠️ **安全提示**: 请在生产环境中及时修改默认密码！  
📝 **修改方法**: 编辑 `config/config.json` 文件中的 `username` 和 `password` 字段。

### 数据目录

- `./data/`: 存储应用数据
- `./config/`: 存储配置文件

**配置项说明**:
- `user-agent`: 用于115 API请求的User-Agent字符串，可以根据需要修改
- `strmExtensions`: 需要转换为.strm文件的扩展名数组，默认为[".mp4", ".mkv", ".avi", ".iso", ".mov", ".rmvb", ".webm", ".flv", ".m3u8", ".mp3", ".flac", ".ogg", ".m4a", ".wav", ".opus", ".wma"]，会自动转换为小写
- `downloadExtensions`: 需要直接下载的文件扩展名数组，默认为[".srt", ".ass", ".sub", ".nfo", ".jpg", ".png"]，会自动转换为小写
- `emby.url`: Emby媒体服务器地址
- `emby.apiKey`: Emby API密钥

## 📄 许可证

本项目采用 [MIT License](LICENSE) 许可证。

## 💬 交流群组

欢迎加入我们的 Telegram 群组进行交流讨论：

[![Telegram Group](https://img.shields.io/badge/Telegram-OpenStrm%20Group-blue?style=for-the-badge&logo=telegram)](https://t.me/OpenStrmGroup)

## 🤝 贡献

欢迎提交 Issue 和 Pull Request 来改进这个项目。

## ⚠️ 免责声明

本项目仅供学习和研究使用。请确保你遵守相关的法律法规和服务条款。
