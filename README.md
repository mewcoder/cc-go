# CC Go

用 Go / MyGo 运行 Claude Code 官方 VS Code 插件的轻量桌面客户端。

这是非官方宿主，不是 Claude 官方桌面端，也不是完整的 VS Code。项目仍在测试阶段，适合愿意反馈问题的用户。

## 下载与使用

从 [Releases](https://github.com/mewcoder/cc-go/releases) 下载对应版本：

| 系统 | 下载文件 | 使用方式 |
| --- | --- | --- |
| macOS Apple Silicon（M 系列，macOS 13+） | `.dmg` | 打开后，把 `CC Go.app` 拖进“应用程序” |
| Windows x64 | `.exe` | 直接运行，不需要解压 |

目前不发布 Intel Mac、Windows ARM 或 Linux 版本。Mac 仅临时签名、未做 Apple 公证；Windows 未做发行者代码签名，系统可能提示安全警告。`SHA256SUMS` 用于校验下载文件。

首次使用：

1. 安装 [Node.js 22 或更新版本](https://nodejs.org/)。Windows 还需要 [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。
2. 启动 CC Go，优先复用 VS Code 已安装的稳定版 Claude 插件；没有可用的本地插件时下载当前平台最新稳定版，也可以手动导入可信的官方 VSIX。
3. 检查通过后，点击 **Start**，在插件中完成配置。

**不需要另装 Claude CLI**：使用 VSIX 自带的 Claude。首次初始化后，再次启动直接进入应用；在菜单的 Plugin Updates 中检查和安装插件更新。插件更新与 CC Go 自身的版本分开，桌面程序更新请从 Releases 下载。

本地复用会检查标准 VS Code、Insiders 及 `VSCODE_PORTABLE` 数据目录中的插件，校验身份、平台和内置运行时后导入 CC Go 自己的副本，不修改 VS Code 的安装。之后继续使用已保存的副本，不受 VS Code 升级或卸载影响；显式指定的 `--vsix` 优先。

## 日常使用

- 左侧管理项目和会话，可以导入已有 Claude Code CLI 会话。
- 关闭窗口后保留后台运行；托盘右键只有 **Show App** 和 **Exit**，选择 Exit 才完全退出。
- Git 状态按文件变化更新，不定时轮询 Git；也可以通过 **View > Refresh Git** 手动刷新。

## 开发预览

运行 `npm run dev`，打开终端输出的本地地址。修改 `web/` 后刷新页面即可，不必打包；修改 Go 后重启命令。预览沿用现有数据，请勿与桌面程序同时运行。
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
