# OpenStrm

一个开源的 **Strm 生成工具**。

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
  -v $(pwd)/data:/app/data \
  -v $(pwd)/config:/app/config \
  indown/openstrm:latest
```
### 生产环境部署

```bash
# 使用生产环境配置
docker-compose -f docker-compose.prod.yml up -d
```

## 🔧 配置说明

### 数据目录

- `./data/`: 存储应用数据
- `./config/`: 存储配置文件
