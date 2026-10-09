# GitCode 自动二进制发布

GitHub Actions 在各平台的原生构建机上生成安装包，再通过 GitCode OpenAPI 发布到
`Goldgom/token-bird`。工作流：`.github/workflows/gitcode-release.yml`。

## 首次配置

在 GitHub 仓库 `Goldgom/craft-agents-oss` 的 **Settings → Secrets and variables → Actions** 中：

- 添加 Secret `GITCODE_TOKEN`：使用对目标 GitCode 仓库具有 Release 创建、附件上传和更新权限的个人访问令牌。
- 如需更换发布仓库，添加 Variable `GITCODE_REPOSITORY`，格式为 `owner/repo`；默认 `Goldgom/token-bird`。
  同时修改客户端 `apps/electron/src/main/gitcode-release.ts` 的默认仓库，确保客户端能找到发布版本。
- 确保 GitHub Actions 已启用，提交本工作流到 GitHub，并将同一源码提交推送到 GitCode。

发布凭据只传入预检查和发布步骤，通过环境变量读取，不放进构建环境、云服务器配置或安装包。

## 触发发布

先将根目录和 `apps/electron/package.json` 的 `version` 更新为同一版本，提交并推送源码到两个远程。
创建对应标签，先推送 GitCode，再推送 GitHub：

```powershell
git tag v26.10.9
git push gitcode main
git push origin main
git push gitcode refs/tags/v26.10.9
git push origin refs/tags/v26.10.9
```

支持 `v26.10.9` 和 `26.10.9` 两种正式版本标签格式，标签去掉 `v` 后必须与包版本完全一致。
后续版本请使用新的标签，不复用已经正式发布的标签。

也可在 GitHub **Actions → Publish binaries to GitCode → Run workflow** 中输入已有标签。
选用包含本工作流的分支，输入的版本标签也必须包含工作流所需的发布脚本。
手动触发同样构建标签对应的源码，不使用所选分支的最新代码。

## 发布内容

| 平台 | 架构 | 文件 |
| --- | --- | --- |
| Windows | x64 | `TokenBird-x64.exe`，可选 MSI，`latest.yml`，blockmap |
| macOS | Intel x64、Apple Silicon arm64 | 两种架构各自的 DMG、ZIP、blockmap，合并后的 `latest-mac.yml` |
| Linux | x64 | `TokenBird-x64.AppImage`，`latest-linux.yml` |
| 全部 | — | `SHA256SUMS.txt` |

构建产物在 GitHub Actions 保存 7 天，GitCode Release 保留正式下载文件。
任意平台构建失败时不会启动发布。发布前验证更新清单的版本、SHA-512 和文件大小；上传后重新下载附件，验证 SHA-256 和大小。

GitCode 标签必须存在且与构建提交一致。首次创建 Release 时状态为 `pre`；所有附件上传并验证后更新为 `latest`。
上传失败时优先选择 **Re-run failed jobs**，复用原有构建产物重新运行发布任务。
已存在的附件必须与本次上传完全一致；如果重新构建产生了不同字节，请恢复原构建产物，
或手动清理尚未正式发布的失败 Release 后重试。已正式发布的 Release 不被自动修改，旧版本也不会覆盖更高版本的 `latest`。

Windows 客户端从 GitCode 获取更新，需要同一 Release 中同时存在 `latest.yml` 和 `TokenBird-x64.exe`。
macOS/Linux 当前客户端仍使用 `electron-builder.yml` 中配置的通用更新源；本工作流提供 GitCode 下载和更新清单，
如需切换其客户端更新源，可另外接入 GitCode Release 检查。

## 签名

本工作流默认生成未签名安装包，不配置 Apple 公证。Windows 可能显示 SmartScreen 提示；macOS 可能被 Gatekeeper 拦截。
正式签名分发需要另行配置 Windows 签名证书、Apple Developer ID 与公证流程。

## 本地预检查

无需令牌即可检查版本：

```powershell
bun run release:gitcode --check-version --tag v26.10.9
```

将 Actions 中四份构建产物解压到 `dist/release-input/{win-x64,mac-x64,mac-arm64,linux-x64}`，可离线验证清单并合并校验值：

```powershell
bun run release:gitcode --tag v26.10.9 --input dist/release-input --dry-run
```

实际上传通过环境变量 `GITCODE_TOKEN` 传入令牌，去掉 `--dry-run`。
发布脚本只选择安装包、blockmap 和更新清单，不上传打包调试文件或本地部署配置。

接口依据：

- [创建 Release](https://docs.gitcode.com/docs/apis/post-api-v-5-repos-owner-repo-releases)
- [获取附件上传地址](https://docs.gitcode.com/docs/apis/get-api-v-5-repos-owner-repo-releases-tag-upload-url)
- [更新 Release](https://docs.gitcode.com/docs/apis/patch-api-v-5-repos-owner-repo-releases-tag)
