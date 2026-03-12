# GitHub + Render 部署指南

**编写日期**: 2026-03-06
**适用项目**: Node.js Web 应用（以"比鸡"项目为例）

---

## 一、前置准备

| 准备项 | 说明 |
|--------|------|
| Git | 本地已安装 Git（`git --version` 验证） |
| Node.js | 本地已安装 Node.js（`node -v` 验证） |
| GitHub 账号 | https://github.com 注册 |
| Render 账号 | https://render.com 注册（推荐用 GitHub 账号直接登录） |

---

## 二、项目准备

### 2.1 确保 package.json 正确

```json
{
  "name": "biji-server",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "ws": "^8.16.0"
  }
}
```

关键点：
- `scripts.start` 必须有，Render 默认用它启动
- `dependencies` 必须列全所有依赖

### 2.2 确保代码适配云平台端口

服务端必须使用环境变量端口：

```javascript
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0');
```

- `process.env.PORT` — Render 会自动注入，不能写死端口
- `'0.0.0.0'` — 绑定所有网卡，云平台必须

### 2.3 配置 .gitignore

```
node_modules/
data.json
```

- `node_modules/` — 依赖包不提交，通过 `npm install` 恢复
- `data.json` — 运行时数据不提交

---

## 三、推送到 GitHub

### 3.1 首次推送

```bash
# 进入项目目录
cd E:/biji-server

# 初始化 Git 仓库
git init

# 添加所有文件
git add .

# 提交
git commit -m "feat: 比鸡多人在线对战卡牌游戏 v1.0"

# 在 GitHub 网站上新建仓库（不要勾选初始化 README）
# 然后关联远程仓库（替换为你的地址）
git remote add origin https://github.com/你的用户名/biji-server.git

# 推送
git branch -M main
git push -u origin main
```

### 3.2 后续更新

```bash
git add .
git commit -m "fix: 修复xxx问题"
git push
```

### 3.3 常见问题

**Q: push 时提示输入密码？**
GitHub 已不支持密码认证，需要使用 Personal Access Token (PAT)：
1. GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Generate new token，勾选 `repo` 权限
3. 复制 token，push 时密码栏粘贴 token

**Q: 提示 remote origin already exists？**
```bash
git remote set-url origin https://github.com/你的用户名/biji-server.git
```

**Q: 想同时推送到 Gitee（国内加速）？**
```bash
git remote add gitee https://gitee.com/你的用户名/biji-server.git
git push gitee main
```

---

## 四、Render 部署

### 4.1 创建服务

1. 登录 https://render.com
2. 点击右上角 **New** → **Web Service**
3. 选择 **Build and deploy from a Git repository** → Next
4. 关联 GitHub 账号，选择 `biji-server` 仓库

### 4.2 填写配置

| 配置项 | 值 | 说明 |
|--------|----|------|
| Name | `biji-server` | 服务名称，会出现在域名中 |
| Region | `Singapore` 或 `Oregon` | 选距离用户近的 |
| Branch | `main` | 部署分支 |
| Runtime | `Node` | 自动检测 |
| Build Command | `npm install` | 安装依赖 |
| Start Command | `node server.js` | 启动服务 |
| Instance Type | `Free` | 免费方案 |

### 4.3 点击 Create Web Service

等待 2-5 分钟，构建日志中看到服务启动成功后，即可通过分配的域名访问：

```
https://biji-server.onrender.com
```

### 4.4 自动部署

配置完成后，每次向 GitHub `main` 分支推送代码，Render 会自动拉取并重新部署，无需手动操作。

---

## 五、Render 免费方案须知

| 限制 | 说明 |
|------|------|
| 休眠机制 | 15分钟无访问自动休眠，下次访问冷启动约30-50秒 |
| 运行时长 | 每月 750 小时免费额度（单服务足够） |
| 内存 | 512 MB |
| 带宽 | 100 GB/月 |
| 持久化 | 无磁盘持久化，重新部署后 data.json 会丢失 |

### 重要提醒：数据持久化

Render 免费方案不提供持久磁盘，每次重新部署会重置文件系统。这意味着：
- `data.json`（用户数据、房间数据）在重新部署后会丢失
- 如需持久化，建议：
  - 方案A：接入外部数据库（如 MongoDB Atlas 免费方案）
  - 方案B：使用 Render 的付费磁盘服务
  - 方案C：仅作演示用途，接受数据重置

---

## 六、部署验证清单

部署完成后，逐项验证：

- [ ] 访问首页能正常加载
- [ ] 注册新用户成功
- [ ] 登录已有用户成功
- [ ] 创建房间成功
- [ ] 另一浏览器/设备加入房间成功
- [ ] 准备后游戏正常开始
- [ ] 摆牌和比牌流程正常
- [ ] WebSocket 连接状态显示正常（右上角绿色）

---

## 七、操作速查

```bash
# === 本地开发 ===
cd E:/biji-server
npm install              # 安装依赖
node server.js           # 启动服务
# 访问 http://localhost:3000

# === 代码更新并部署 ===
git add .
git commit -m "描述本次改动"
git push                 # 推送后 Render 自动部署

# === 查看远程仓库地址 ===
git remote -v

# === 查看提交历史 ===
git log --oneline

# === 查看当前状态 ===
git status
```
