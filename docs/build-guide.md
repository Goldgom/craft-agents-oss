# Craft Agents 编译指南（Build Guide）

本文档介绍如何编译 Craft Agents 的各端产物：**Windows / macOS / Linux 客户端** 与 **服务器端**。
除特别注明外，命令均从仓库根目录执行。

## 全量编译与统一产物目录

使用根目录的编排脚本可以一次构建 Windows、Linux、Android，以及 Linux/Windows/macOS
无头服务，并将结果统一放入 `dist/` 的对应子目录：

```bash
bun run build:all
# 仅构建指定目标，发布 APK 使用 --release
bun run build:all win linux android --release
```

目标名称为 `win`、`linux`、`android`、`linux-headless`、`win-headless`、`mac-headless`。
桌面包必须在对应的构建环境中执行（Linux 桌面包在 Linux/WSL，Windows 包在 Windows）；
无头服务支持交叉下载目标运行时。当前主机无法构建的目标会自动跳过；已开始的构建若发生实际错误则立即停止。

---

## 一、环境准备（所有平台通用）

| 依赖       | 版本要求                           | 说明                                  |
| ---------- | ---------------------------------- | ------------------------------------- |
| Bun        | 1.3.x                              | 包管理器与构建运行时                  |
| Node.js    | ≥ 18                              | `npm pack` 和 electron-builder 需要 |
| npm        | 随 Node.js 安装                    | 跨架构下载 Claude Agent SDK 时使用    |
| Git        | 任意                               | 拉取源码                              |
| Linux 工具 | `curl`、`unzip`、`sha256sum` | Linux 客户端脚本下载和校验运行时      |

在 Ubuntu/Debian 上可先安装 Linux 客户端脚本需要的系统工具：

```bash
sudo apt update
sudo apt install -y ca-certificates curl git unzip coreutils
```

确认 Bun、Node.js 和 npm 已在 `PATH` 中：

```bash
bun --version
node --version
npm --version
```

```bash
# 1. 克隆仓库
git clone <repo-url> craft-agents-oss
cd craft-agents-oss

# 2. 首次安装依赖。如果 Bun 提示阻止了原生安装脚本，先执行第 3 步。
bun install

# 3. 允许 ripgrep 的安装脚本运行，再安装一次使二进制完成安装
bun pm trust @vscode/ripgrep
bun install
```

> 编译过程会联网下载：Bun 运行时（约 30 MB，带 SHA256 校验）、Electron 二进制、
> Claude Agent SDK 原生二进制（约 250 MB）。请保持网络畅通。
>
> ⚠️ Windows 的编译脚本会**强制结束本机的 node / npm / electron 进程**（避免文件占用），
> 编译前请先退出正在运行的开发实例。

---

## 二、Windows 客户端（NSIS 安装包）

### 命令

```powershell
# 在仓库根目录执行；脚本会自行构建 WhatsApp Worker
powershell -ExecutionPolicy Bypass -File apps/electron/scripts/build-win.ps1

# 也可以使用 Electron 工作区脚本
cd apps/electron
bun run dist:win
```

`dist:win` 实际执行 `scripts/build-win.ps1`，完整流程：

1. 结束残留的 node/npm/electron 进程，清理旧产物；
2. 下载固定版本 Bun（`bun-v1.3.9`，SHA256 校验）到 `apps/electron/vendor/bun/`；
3. 将 Claude Agent SDK 核心 + **win32-x64** 原生二进制（约 253 MB）暂存为
   `claude-agent-sdk-binary` 别名，并复制 `@vscode/ripgrep`；
4. esbuild 编译主进程 / preload，vite 编译渲染层，拷贝内置资源；
5. 用 electron-builder 打包 NSIS 安装包（带 EBUSY 重试逻辑）。

### 产物

```
apps/electron/release/
├── Craft-Agents-x64.exe          # NSIS 安装包
└── Craft-Agents-x64.msi          # MSI 安装包（适合企业部署）
```

- 配置位于 `apps/electron/electron-builder.yml` 的 `win:` / `nsis:` 段。
- 默认**不做代码签名**。如需签名，设置 `CSC_LINK`（证书路径）与 `CSC_KEY_PASSWORD` 环境变量后重新打包。
- 若安装包提示未知发布者，属于未签名正常现象（Windows SmartScreen 提示“仍要运行”即可）。

### 常见问题

| 现象                                     | 处理                                                          |
| ---------------------------------------- | ------------------------------------------------------------- |
| `ERROR: SDK core not found`            | 先在仓库根目录执行`bun install`                             |
| `ERROR: @vscode/ripgrep not installed` | `bun pm trust @vscode/ripgrep` 后重装                       |
| EBUSY / 文件被占用                       | 脚本已内置 3 次重试；确认杀毒软件未锁定`vendor/bun/bun.exe` |
| 杀毒软件拖慢或误报                       | 把`apps/electron/release`、`vendor` 加入扫描排除项        |

---

## 三、macOS 客户端（DMG + ZIP）

> 必须在 **macOS** 上编译（DMG 打包与签名/公证依赖 Apple 工具链）。

### 命令

```bash
cd apps/electron
bash scripts/build-dmg.sh arm64     # Apple Silicon
bash scripts/build-dmg.sh x64       # Intel
```

### 产物

```
apps/electron/release/
├── Craft-Agents-arm64.dmg
└── Craft-Agents-arm64.zip
```

### 签名与公证（发布必需）

在仓库根目录 `.env` 中配置后重新运行：

```bash
APPLE_SIGNING_IDENTITY="Developer ID Application: ..."
APPLE_ID="you@example.com"
APPLE_TEAM_ID="XXXXXXXXXX"
APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
```

### 上传发布通道（可选）

```bash
bash scripts/build-dmg.sh arm64 --upload --latest
```

- `--upload` 上传到 S3；`--latest` 同步 `electron/latest` 清单；
- 需配置 `S3_VERSIONS_BUCKET_*` 环境变量。

---

## 四、Linux 客户端（AppImage）

当前 Linux 桌面包的打包配置只声明了 **x64**。请使用 x64 Linux 主机或 x64 WSL2；
ARM64 Linux 目前不是受支持的发布目标。使用 WSL2 时，建议把仓库 clone 到 WSL 的 Linux
文件系统（例如 `~/src`），不要直接使用 Windows 的 `/mnt/c/...` 工作区。

### 全新拉取后的完整步骤

```bash
# 在仓库根目录执行
git clone <repo-url> craft-agents-oss
cd craft-agents-oss

# 安装系统依赖（Ubuntu/Debian；其他发行版安装同名工具）
sudo apt update
sudo apt install -y ca-certificates curl git unzip coreutils

# 安装并确认 Bun 1.3.x、Node.js 18+ 和 npm 后执行
bun install
bun pm trust @vscode/ripgrep
bun install

# 构建 x64 AppImage
bash apps/electron/scripts/build-linux.sh x64
```

构建脚本会清理旧的打包暂存目录，并完成依赖安装、下载并校验固定版本 Bun、准备
Claude Agent SDK 原生二进制和 ripgrep、下载 uv、构建 Electron 资源，最后调用
electron-builder 生成 AppImage。因此不需要先手动执行 `bun run electron:build`。

首次构建需要访问 npm registry、GitHub 和 Electron 下载源，至少需要约 300 MB 的下载空间，
并需要足够的磁盘空间解压依赖和打包文件。

### 产物

```
apps/electron/release/
└── Craft-Agents-x64.AppImage
```

- 构建必须在 Linux 环境执行。Windows 原生 PowerShell 不能直接生成 Linux AppImage；
  可使用 Linux 主机、WSL2 或 Linux CI。
- 如果 WSL2 工作区中的脚本因 Windows 换行符报 `syntax error near unexpected token`，
  先执行 `sed -i 's/\r$//' apps/electron/scripts/build-linux.sh`，然后重新运行构建。
- 运行 AppImage 时，如果系统提示缺少 FUSE，在 Ubuntu 22.04 安装 `libfuse2`，
  在 Ubuntu 24.04 安装 `libfuse2t64`：

  ```bash
  # Ubuntu 22.04
  sudo apt install -y libfuse2
  # Ubuntu 24.04 使用：sudo apt install -y libfuse2t64
  ```
- 发布上传需要 S3 凭据：

  ```bash
  bash apps/electron/scripts/build-linux.sh x64 --upload --latest
  ```

### Linux 构建常见错误

| 现象                                                             | 处理                                                  |
| ---------------------------------------------------------------- | ----------------------------------------------------- |
| `sha256sum: command not found` 或 `unzip: command not found` | 安装上面的 Linux 系统依赖                             |
| `SDK core not found`                                           | 在仓库根目录执行`bun install`                       |
| `@vscode/ripgrep` 或 `bin/rg` 不存在                         | 执行`bun pm trust @vscode/ripgrep && bun install`   |
| `Could not resolve "ssh2"`                                  | 确认使用包含 `ssh2` 的最新代码，并在仓库根目录执行 `bun install`；不要在 `apps/electron/scripts` 中执行 `npm install` |
| `claude-agent-sdk-linux-x64` 下载失败                          | 检查 npm registry 和 GitHub 网络连接后重新运行        |
| AppImage 启动时报 FUSE 错误                                      | 安装对应 Ubuntu 版本的`libfuse2` 或 `libfuse2t64` |

---

## 五、服务器端编译（Server）

服务器是**无头**进程，支持 `darwin`、`linux` 与 `win32`。

### 方式 A：原生构建（推荐给 Linux / macOS 部署）

```bash
# 在仓库根目录执行
bun run scripts/build-server.ts --platform=linux --arch=x64 --compress
bun run scripts/build-server.ts --platform=linux --arch=arm64 --compress
bun run scripts/build-server.ts --platform=darwin --arch=arm64 --compress
bun run scripts/build-server.ts --platform=win32 --arch=x64 --compress
```

参数说明：

| 参数                | 取值                               | 说明                        |
| ------------------- | ---------------------------------- | --------------------------- |
| `--platform`      | `darwin` / `linux` / `win32` | 目标平台（默认当前平台）    |
| `--arch`          | `x64` / `arm64`                | 目标架构（默认当前架构）    |
| `--compress`      | 布尔                               | 构建完成后打包为`.tar.gz` |
| `--skip-download` | 布尔                               | 复用已有 Bun/uv 二进制      |

快捷命令（等价封装）：

```bash
bun run server:build:linux-x64
bun run server:build:linux-arm64
bun run server:build:darwin-arm64
bun run server:build:darwin-x64
```

### 产物

```
dist/server/                                # 服务器完整目录（含 bin/craft-server、vendor/bun、resources）
craft-server-<version>-linux-x64.tar.gz     # 压缩产物（与 dist/server 同级）
```

部署到目标机后：

```bash
tar -xzf craft-server-<version>-linux-x64.tar.gz -C /opt/craft-server
cd /opt/craft-server && bash install.sh     # 会生成 systemd 服务 craft-server
# 或直接前台运行：
./bin/craft-server
```

### 方式 B：Docker 镜像（推荐，跨平台一致）

```bash
# 构建镜像
docker buildx build -f Dockerfile.server -t craft-agent-server .

# 运行
docker run --rm -p 9100:9100 \
  --user $(id -u):$(id -g) \
  -e HOME=/home/craftagents \
  -e CRAFT_SERVER_TOKEN=<secret> \
  craft-agent-server

# 带 TLS + 挂载配置运行
docker run --rm -p 9100:9100 \
  --user $(id -u):$(id -g) \
  -e HOME=/home/craftagents \
  -e CRAFT_SERVER_TOKEN=<secret> \
  -e CRAFT_RPC_TLS_CERT=/certs/cert.pem \
  -e CRAFT_RPC_TLS_KEY=/certs/key.pem \
  -v /path/to/certs:/certs:ro \
  -v ~/.craft-agent:/home/craftagents/.craft-agent \
  craft-agent-server
```

> `Dockerfile.server` 内部要求 `bunfig.toml` 存在（hoisted linker），镜像构建已自动处理。

### 方式 C：源码安装

```bash
bash scripts/install-server.sh    # 自动装依赖、生成服务器 token、打印运行命令
```

### 网络问题：服务器访问 GitHub 慢 / 卡住

服务器构建需要从 GitHub 下载两个运行时（Bun、uv），网络差的服务器经常卡在这一步。三种解法，按需选择：

**1. HTTP 代理（最简单）**

curl 会自动读取代理环境变量，构建前设置即可：

```bash
export https_proxy=http://127.0.0.1:7890
export http_proxy=http://127.0.0.1:7890
bun run server:build:linux-x64
```

**2. GitHub 镜像（无需代理）**

脚本已支持镜像前缀环境变量 `CRAFT_GITHUB_MIRROR`（规则：前缀 + 原始 URL）：

```bash
export CRAFT_GITHUB_MIRROR=https://ghproxy.net/
bun run server:build:linux-x64
```

可替换为其他可用镜像前缀，如 `https://ghfast.top/`、`https://mirror.ghproxy.com/`。

**3. 离线预置（服务器完全没有外网）**

在一台能联网的机器上下载这两个文件，解压后 `scp` 到服务器对应路径：

| 运行时 | 下载地址                                                                                        | 解压后放到                                   |
| ------ | ----------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Bun    | `https://github.com/oven-sh/bun/releases/download/bun-v1.3.9/bun-linux-x64-baseline.zip`      | `apps/electron/vendor/bun/bun`             |
| uv     | `https://github.com/astral-sh/uv/releases/download/0.10.6/uv-x86_64-unknown-linux-gnu.tar.gz` | `apps/electron/resources/bin/linux-x64/uv` |

```bash
# 服务器上预置完成后执行（跳过 GitHub 下载）
bun run scripts/build-server.ts --platform=linux --arch=x64 --compress --skip-download
```

> 提示：即使跳过 GitHub 下载，`bun install` 仍需要能访问 npm registry
> （可配置 npm 国内镜像：`bun config set registry https://registry.npmmirror.com`）。

---

## 六、产物与版本速查

| 目标             | 命令                                                                               | 产物                                                               |
| ---------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Windows 客户端   | `cd apps/electron && bun run dist:win`                                           | `apps/electron/release/Craft-Agents-x64.exe`                     |
| macOS 客户端     | `cd apps/electron && bash scripts/build-dmg.sh <arm64\|x64>`                      | `apps/electron/release/Craft-Agents-<arch>.dmg/.zip`             |
| Linux 客户端     | `bash apps/electron/scripts/build-linux.sh x64`                                  | `apps/electron/release/Craft-Agents-x64.AppImage`                |
| 服务器（原生）   | `bun run scripts/build-server.ts --platform=<platform> --arch=<arch> --compress` | `dist/server/` + `craft-server-<ver>-<platform>-<arch>.tar.gz` |
| 服务器（Docker） | `docker buildx build -f Dockerfile.server -t craft-agent-server .`               | 容器镜像                                                           |

版本号取自 `apps/electron/package.json`（当前 `1.0.0-community.2`），产物命名统一为
`Craft-Agents-<arch>.<ext>` / `craft-server-<version>-<platform>-<arch>.tar.gz`。

---

## 七、注意事项

1. **编译即破坏开发环境**：Windows 脚本会杀掉 node/electron 进程并清理
   `apps/electron/{vendor,node_modules/@anthropic-ai,packages,release}`，编译后如需继续开发请重新运行 `bun run electron:dev`。
2. **macOS 签名**：未签名的 DMG 在用户机器上会被 Gatekeeper 拦截，正式分发必须配置
   Apple Developer ID 并完成公证。
3. **自动更新**：`electron-builder.yml` 的 `publish.url` 指向
   `https://thecraftagents.com/electron/latest`，electron-updater 依据生成的
   `latest.yml` / `latest-mac.yml` 检查更新；自建分发时需把 `release/` 下的清单文件一起上传。
4. **跨系统数据迁移**：编译好的客户端内置“数据导出/导入”功能
   （设置 → App → 数据），导出为 ZIP 后可在任意平台导入，路径会自动重映射。
5. **多平台发布流程**：正式发布建议按“各平台原生环境编译 → 上传产物与更新清单 →
   install-app.ps1 / install-app.sh 拉取安装”的顺序执行。
6. **Pi 后端依赖 pi-agent-server**：服务器产物中必须包含
   `resources/pi-agent-server/index.js`（构建脚本自动组装）。若启动后测试
   DeepSeek / GitHub Copilot 等 Pi 系连接报 “piServerPath not configured”，
   说明该文件缺失——用新版构建脚本重新编译，或把仓库中
   `packages/pi-agent-server/dist/index.js` 复制到服务器安装目录的
   `resources/pi-agent-server/index.js`。
