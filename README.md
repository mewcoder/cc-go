# CC Go

用 Go / MyGo 运行 Claude Code 官方 VS Code 插件的轻量桌面客户端。

这是非官方宿主，不是 Claude 官方桌面端，也不是完整的 VS Code。当前为 **0.1.0-beta.1**，适合愿意反馈问题的用户。

## 下载与使用

从 [Releases](https://github.com/mewcoder/cc-go/releases) 下载对应版本：

| 系统 | 下载文件 | 使用方式 |
| --- | --- | --- |
| macOS Apple Silicon（M 系列，macOS 13+） | `.dmg` | 打开后，把 `CC Go.app` 拖进“应用程序” |
| Windows x64 | `.exe` | 直接运行，不需要解压 |

目前不发布 Intel Mac、Windows ARM 或 Linux 版本。Mac 仅临时签名、未做 Apple 公证；Windows 未做发行者代码签名，系统可能提示安全警告。`SHA256SUMS` 用于校验下载文件。

首次使用：

1. 安装 [Node.js 22 或更新版本](https://nodejs.org/)。Windows 还需要 [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。
2. 启动 CC Go，等待下载当前平台最新稳定版 Claude VSIX，或手动导入可信的官方 VSIX。
3. 检查通过后，点击“开始使用”，在插件中完成配置。

**不需要另装 Claude CLI**：使用 VSIX 自带的 Claude。再次启动优先使用缓存的插件；初始化页面可以检查和安装插件更新。插件更新与 CC Go 自身的版本分开，桌面程序更新请从 Releases 下载。

## 日常使用

- 左侧管理项目和会话，可以导入已有 Claude Code CLI 会话。
- 关闭窗口后保留后台运行；托盘右键只有 **Show App** 和 **Exit**，选择 Exit 才完全退出。
- Git 状态按文件变化更新，不定时轮询 Git；也可以通过 **View > Refresh Git** 手动刷新。
- 应用数据位于 `~/.cc-go/`；会话读取 `~/.claude/projects/`，桌面端重命名、归档不会改写原始会话文件。

插件和 Claude 以当前用户权限运行，只加载可信的官方插件。Beta 阶段仍可能遇到兼容性问题，操作重要项目时请使用 Git 或其他方式备份。

## 本地开发

需要 Go 1.27.3+ 和 Node.js 22+：

```sh
npm ci
npm test
npm start
npm run build
```

构建结果在 `release/`：Mac ARM64 生成 DMG，Windows x64 生成 EXE，各附 `.sha256`；Mac 同时保留 `build/CC Go.app`。打包使用 Node，不依赖 PowerShell 模块或外部哈希工具。Mac 打包会提前检查系统 `codesign`、`hdiutil`，签名或镜像校验失败就停止。

## 发布

**只有推送 `v*` 标签才自动发布**；推送 `main` 不发版，手动运行 Actions 只构建。

先用 `npm version 0.1.0-beta.2 --no-git-tag-version` 更新版本并提交，再推送对应标签，例如 `v0.1.0-beta.2`。标签必须与 `package.json` 版本一致。

Actions 会测试和构建 Mac ARM64、Windows x64，检查两份产物的 SHA-256，全部上传到草稿后才公开 Release。`beta` 版本标记为预发布；稳定后使用 `0.1.0`。
