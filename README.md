# CC Go

A Go/MyGo desktop host for the original Anthropic Claude Code VS Code extension (.vsix). The desktop shell reuses the Electron version's UI files. A separate local Node.js process runs the extension and its VS Code API compatibility layer.

This is an unofficial host, not a complete VS Code replacement.

The display name is **CC Go**. Package names, commands and release filenames use `cc-go`. The existing data directory (`~/.cc-go/`), keychain service, macOS bundle identifier and extension URI scheme are unchanged, so the rename does not require moving user data or credentials.

## Project Status

The primary implementation on `main` uses MyGo 0.7.3. It replaces the former Wails desktop shell while preserving the official extension UI and its Node.js host. The repository starts with a fresh MyGo initial commit; the earlier Electron/Wails commits are not retained in the current branch history.

MyGo loads the existing loopback shell and uses its native bridge only for desktop window behavior. Extension pages retain their separate loopback origin and sandboxed iframes; no application services are exposed through MyGo bindings. macOS traffic-light placement uses the framework API instead of custom Objective-C code.

Adopting MyGo as the primary implementation does not mean a stable release or completed cross-platform acceptance. Windows and Linux GUI validation and macOS traffic-light/sidebar visual alignment remain pending; see the packaging notes and boundaries below.

## Runtime Requirements

- **Node.js 22 or newer, installed locally. Node.js is never bundled or downloaded by the app.**
- An Anthropic Claude Code VS Code extension (.vsix) for the current platform. Its bundled Claude runtime is used; a separately installed Claude CLI is not required. Configure authentication/providers as usual in the extension.
- macOS: system WKWebView. Windows: Microsoft Edge WebView2 Runtime. Linux: GTK3 and WebKitGTK 4.1 (for example, Ubuntu 24.04's `libgtk-3-0t64` and `libwebkit2gtk-4.1-0`).

Initialization follows the same flow on macOS, Windows and Linux: check the system/architecture and Node.js, prepare the platform-specific VS Code extension (.vsix), then verify its bundled Claude executable format, architecture and permissions. It does not search for or execute a system Claude CLI, nor tie the extension version to one. If Node is missing or too old, setup stops before downloading anything. The extension itself launches the bundled Claude when starting a conversation; the static initialization check is not a model/API connectivity test.

On first setup, the app downloads the latest stable Anthropic extension for the current platform from Open VSX, verifies its SHA-256 and package identity/version, and caches it. Later launches reuse the saved package offline and check registry metadata once in the background; a failed update check does not block startup. Initialization also offers a manual update check. When a newer stable version is available, the sidebar/initialization offers an explicit update; it does not silently replace a running host. Active conversations or unsent drafts block replacement. The replacement package and bundled runtime are checked before stopping the current host; a failed download keeps the working package. Updates return to setup and wait for **开始使用**. An explicit `--vsix` remains a local package choice and skips the automatic launch-time update check.

The full-window setup dialog shows the product introduction and the three prerequisite steps together. It appears on every launch, including when dependencies and the VS Code extension (.vsix) are already cached. The extension host starts only after clicking **开始使用**. Closing startup setup closes the window without starting the host; reopening the window restores setup. Once chat is running, closing setup returns to chat. Reopen setup later from **View > Initialization**. In browser-only mode, close the browser tab to leave startup setup. Node.js setup offers a recheck only; install or upgrade Node outside the app. Errors are shown directly.

CLI session import is separate from initialization. Click the **Import Claude Code CLI sessions** icon to the right of **Workspace**, next to the add-workspace button, to select multiple existing Claude Code projects. Import adds them to the sidebar without copying or changing transcripts. Projects are sorted alphabetically by full path; already added projects are omitted. Long paths stay on one line and retain the right-hand end, with the complete path available on hover.

Node lookup checks PATH and common stable version-manager locations, including fnm, Volta and Homebrew. A specific runtime can be selected with `--node=/absolute/path/to/node` (or `node.exe` on Windows).

## Development

Install Go 1.27.3+ and Node.js 22+, then:

```sh
npm ci
npm start
npm test
```

Desktop builds default to `CGO_ENABLED=0`; no C compiler or GTK/WebKit development headers are required. On Linux, running the app still requires the system runtime libraries:

```sh
sudo apt-get install libgtk-3-0t64 libwebkit2gtk-4.1-0
```

The existing plain JavaScript frontend does not need Bun, Vite or generated TypeScript bindings.

Browser-only development does not require native desktop build dependencies:

```sh
npm run web -- --workspace=/absolute/project --vsix=/absolute/claude-code.vsix
```

The app uses `~/.cc-go/` for its own state, separate from the Electron host. Original Claude transcripts under `~/.claude/projects/` are read for the sidebar and are not renamed or deleted by desktop metadata actions. The extension/Claude runtime can create transcripts during actual conversations.

**Settings > Transcript width** sets the maximum width of both messages and the input box: **Narrow** (680px, default), **Medium** (860px), or **Wide** (1040px). Columns stay centered and shrink to fit smaller windows. Changes apply to open conversations immediately and are saved in the host's `desktop.json`, not in the extension configuration.

Git information is event-driven and separate from frequent UI-state requests: snapshots only read the last result and never run Git, regardless of cache age. Native filesystem notifications observe tracked/non-ignored working directories (including empty directories), the actual Git directory and shared worktree refs. Ignored dependency directories and Git objects/logs are not recursively watched; tracked files beneath ignored directories remain covered. File events use a one-second debounce and a five-second minimum interval between automatic invalidations, not a periodic status timer. Directory/ignore/index changes reconcile the watch set on the next foreground read; the notification loop never launches Git. Refreshes also happen on first display, project/branch changes, window restore/focus, and when a Claude operation completes, fails or is interrupted. Click the change statistics or choose **View > Refresh Git** (`Cmd/Ctrl+Shift+R`) for a manual refresh. Blurred, hidden/minimized windows, hidden browser documents, setup and Settings defer Git refreshes. Concurrent reads are merged, focus bursts are rate-limited, watcher discovery has a three-second budget, and each status read has a one-second budget. Native watcher failures appear in the branch/change tooltip; focus and manual refresh remain available (network filesystems may not deliver native notifications). Uncommitted file/line statistics are retained. Windows background Git commands suppress console creation.

This follows the event/debounce/foreground approach used in [VS Code's Git repository implementation](https://github.com/microsoft/vscode/blob/main/extensions/git/src/repository.ts), adapted to a single active workspace rather than copying its full source-control model.

The conversation status bar keeps the context icon and token counts without a `Context` text label. Window limits prefer native context-query data, then SDK model-usage metadata; the tooltip identifies the source. If SDK/history metadata is missing, the host makes at most one native context query per observed model after the model is known, with no periodic token-count polling. The CLI resolves model capabilities, mappings, configuration and its own defaults. The host does not treat `CLAUDE_CODE_MAX_CONTEXT_TOKENS` as an unconditional override or guess a universal 200k or 1M limit. Unknown limits remain `—`.

## Background Operation

Windows uses a single integrated 30px titlebar with native minimize/maximize/close controls. The native menu bar is not displayed as a separate row: open File/Edit/View from the top-left Menu button or Alt/F10; menu accelerators remain available. Window-control glyphs follow the selected application theme. macOS retains its integrated traffic lights and system menu bar; both platforms expose the same application actions.

On macOS and Windows, closing the main window hides it instead of quitting. CC Go stays in the macOS menu bar or Windows system tray, keeping the existing window, extension host and running conversations alive. This does not enable launch at login.

The tray uses a separate transparent monochrome mark that follows the system's light/dark appearance. The application, window and Dock icons are unchanged. The right-click menu contains only **Show App** and **Exit**.

- Click the CC Go tray icon to restore the window, or right-click it and choose **Show App**. On macOS, clicking the Dock icon also restores the window.
- Choose **Exit** from the tray menu to exit and stop the background host. The macOS application menu / `Cmd+Q`, or Windows **File > Quit CC Go** / `Ctrl+Q`, also exits.
- Linux keeps close-to-quit behavior because a system tray is not available on every desktop. Browser-only `--web` mode is unchanged; stop its terminal process to exit.

## Packages

Build and package on the target operating system:

```sh
npm run build
```

| Build host | Output under `release/` | Runtime not included |
| --- | --- | --- |
| macOS | `cc-go-VERSION-darwin-ARCH.zip`, containing `CC Go.app` | Node.js, Claude VS Code extension (.vsix) |
| Windows | `cc-go-VERSION-windows-amd64.exe`, a single portable executable | Node.js, WebView2, Claude VS Code extension (.vsix) |
| Linux | `cc-go-VERSION-linux-ARCH.tar.gz`, containing a launcher, binary, icon and desktop entry | Node.js, GTK3/WebKitGTK, Claude VS Code extension (.vsix) |

Every package has a SHA-256 sidecar. Windows embeds its application icon, GUI manifest and version metadata; macOS packages the `.icns` icon. Windows ARM64 can be built with `powershell -NoProfile -File scripts/build.ps1 -Arch arm64`.

On Windows, download and run the `.exe` directly; no ZIP extraction or adjacent `node_modules` directory is needed. The small host-side JavaScript dependencies are embedded in the executable and written alongside the host scripts under `~/.cc-go/runtime/` when starting the extension. This does not bundle or install Node.js, WebView2 or the Claude extension. The `.sha256` file is optional for integrity verification, not required to run.

The embedded dependencies retain their upstream MIT licenses under `runtime/deps/`. After changing the pinned npm dependency versions, run `npm ci` and `./scripts/go.sh generate ./runtime` to refresh the vendored runtime files; tests check them against the installed versions.

On Linux, extract the archive and run its top-level `./cc-go` launcher. The desktop entry is optional; using it requires placing the launcher on PATH and installing the provided icon/desktop entry in the usual user-local directories.

The Go binary can also be cross-compiled with `CGO_ENABLED=0 GOOS=windows GOARCH=amd64 ./scripts/go.sh build -o build/cc-go.exe ./cmd/cc-go` (similarly for Linux or macOS). This builds the executable only, not a complete package, and does not validate the target GUI. macOS signing and app-bundle packaging still require a Mac.

The GitHub Actions workflow builds and tests separately on macOS, Windows and Ubuntu, then uploads packages as workflow artifacts. Adding the workflow does not mean those runners have already executed. Windows and Linux GUI acceptance must be checked on their target OS; a successful cross-compilation alone is not desktop acceptance.

The macOS build uses ad-hoc signing, not Apple notarization. Windows code signing is not configured. Do not assume these experimental packages satisfy managed-device distribution policies.

## Native Smoke Tests

On a logged-in macOS desktop, run these explicitly. They use temporary local pages, do not start the extension host, and do not read or change conversation data:

```sh
CGO_ENABLED=0 CC_GO_TRAY_SMOKE=1 ./scripts/go.sh test -tags=tray_smoke ./internal/desktop
CGO_ENABLED=0 CLAUDE_VSIX_CHROME_SMOKE=1 ./scripts/go.sh test -tags=chrome_smoke ./internal/desktop
CGO_ENABLED=0 CC_GO_SHELL_SMOKE=1 ./scripts/go.sh test -tags=shell_smoke ./internal/desktop
```

The tray smoke test checks close/restore, retained JavaScript state, unminimizing, and explicit quit. The chrome test checks native titlebar insets and sidebar DOM geometry at different sizes; it is not a screenshot-based acceptance test. The shell test loads the actual frontend with a deliberately missing Node executable and checks that setup appears without starting an extension.

A separate macOS preview was checked with the real extension UI: Chinese text paste, sidebar and Settings shortcuts, opening/cancelling the folder chooser, and fullscreen layout. No model prompt was sent. Chinese input-method composition, real streaming conversations, tray-menu clicks, and Windows/Linux GUI behavior remain unverified. A [same-machine shell comparison](docs/mygo-comparison.md) finds a smaller clean MyGo package but no meaningful runtime efficiency improvement in the background setup scenario; active-conversation performance remains unmeasured.

## Boundaries

- Only part of the VS Code API is implemented. Unsupported editor and terminal services fail explicitly.
- The VS Code extension (.vsix) entry runs with local user permissions in Node. Load trusted Anthropic packages only.
- Plugin resources and messages use a separate loopback origin from the desktop control API.
- Downloaded VS Code extension (.vsix) files are checked against Open VSX SHA-256 metadata. This verifies integrity, not a publisher signature.
- The macOS traffic-light/sidebar alignment remains under visual acceptance; native geometry tests alone do not establish that the screenshot matches the requested result.
