# Wails / MyGo Comparison

Measured on 2026-10-29 (Asia/Shanghai).

## Scope

This compares the former Wails baseline at `098501c328c0db73ac584ba3b97af6230b29e8ed` (Wails 3.0.0) with the MyGo 0.7.3 working tree measured before its promotion to `main`. It is a desktop-shell comparison, **not a full-conversation benchmark**. The Wails revision is a historical measurement identifier, not the current `main` or a commit retained in the new branch history.

The runtime fixture uses the real Go server, shell HTML/CSS/JavaScript, native window, menus and tray. It deliberately selects a nonexistent Node executable and a new empty data/workspace directory. No extension host, Claude CLI, VSIX, transcripts or model requests are involved.

All final samples reported `document.visibilityState = hidden` at readiness. Accordingly, these are **background setup/idle-shell results**, not foreground painting, input latency, chat streaming, or active-conversation memory measurements.

## Results

Median of five runs per variant. MB is decimal (1,000,000 bytes). Negative deltas mean a lower value for MyGo.

| Metric | Wails | MyGo | MyGo delta |
| --- | ---: | ---: | ---: |
| Executable | 12.37 MB | 10.68 MB | -13.7% |
| Clean app bundle | 13.79 MB | 12.10 MB | -12.3% |
| Release ZIP | 6.52 MB | 5.96 MB | -8.5% |
| Setup DOM ready | 533.21 ms | 528.34 ms | -0.9% |
| Idle host physical footprint | 44.60 MB | 44.88 MB | +0.6% |
| Idle host + WebKit physical footprint | 120.11 MB | 119.89 MB | -0.2% |
| Idle CPU, host + WebKit | 0.020 % of one core | 0.023 % of one core | +11.6% |

Observed ranges:

- wails: DOM ready 471-577 ms; host + WebKit 118.83-120.35 MB; CPU 0.015-0.021% of one core.
- mygo: DOM ready 486-591 ms; host + WebKit 118.66-120.35 MB; CPU 0.018-0.025% of one core.

The startup ranges overlap. The memory difference is small, and both idle CPU values are near zero. This sample does not establish a meaningful runtime efficiency win for either framework. The clean-package size reduction is the clearest quantitative improvement.

## Method

- Machine: Apple M1 Pro, 16 GiB RAM, macOS 27.0.1 (26A434).
- Both variants compile with Go 1.27.3, `-trimpath`, and `-ldflags='-s -w'`. Wails uses `-tags=production`, cgo enabled; MyGo uses cgo disabled. The shared toolchain reduces a version confound; the original Wails module declares Go 1.26.8.
- Production app bundles are built in fresh directories with each variant's existing packaging scripts, the same icon and the same Node modules. Node itself and the VSIX are not bundled. Benchmark instrumentation is removed before producing these size measurements.
- Instrumented benchmark executables are separate from the production packages. Only copied source under `test-artifacts/` is instrumented; the desktop implementation under test is unchanged.
- Runtime order: Wails, MyGo, MyGo, Wails, Wails, MyGo, MyGo, Wails, Wails, MyGo. Only one benchmark app runs at a time; unrelated existing apps remain running.
- Startup starts before process spawn and ends when the shell's native desktop adapter exists, the real setup dialog is open and contains the Node.js prerequisite text, and a loopback readiness message reaches the backend. This is DOM readiness, **not a screenshot or a first-paint measurement**.
- OS caches are not flushed. These are repeated-launch results, not cold-boot results.
- Memory is macOS `proc_pid_rusage` physical footprint, not RSS. For each run, wait five seconds after readiness, then take four samples two seconds apart and use their median. The total includes the host plus newly created WebKit XPC processes with the same responsible process. Every final run attributes three WebKit processes.
- CPU is the change in user + system CPU time over the approximately six-second sampling interval, expressed as a percentage of one core. The observation window is short and values this small should not be ranked meaningfully.

## Measurement Correction

The first probe waited for two `requestAnimationFrame` callbacks after DOM readiness. It timed out on background pages. Diagnostic logs showed **both Wails and MyGo reached DOM-ready with `visibilityState=hidden` but did not receive the animation callbacks**. Background WebKit can suspend animation frames. Those attempts are excluded from the final startup/resource results and are not counted as application startup failures. The final probe measures DOM readiness explicitly.

The earlier 23 MB MyGo app estimate was from a reused build directory. It still contains an unused `Contents/MacOS/claude-vsix-go` executable (11,674,896 bytes) from before the executable rename. Fresh bundles do not contain that file. The size table therefore uses clean build directories, not the reused app bundle.

## Engineering Tradeoffs

| Area | Assessment |
| --- | --- |
| macOS/Linux build dependencies | MyGo removes the C compiler / native development-header requirement for the Go binary. GTK/WebKitGTK runtime dependencies on Linux remain. |
| Cross-compilation | MyGo binaries were built with cgo disabled for macOS Intel and Windows/Linux amd64 + arm64, in addition to the native macOS arm64 package. These are compile checks, not target-OS GUI acceptance. |
| Window maintenance | MyGo's `TrafficLightPosition` replaces the app's custom Objective-C red/yellow/green button adjustment. |
| Official extension compatibility | The Go server, Node extension host and extension HTML UI remain. MyGo is not a replacement for the VS Code API compatibility layer. |
| Rendering | Both variants use WKWebView on macOS. Native-UI/no-WebView claims do not apply to this app's existing extension UI. |
| Packaging/updater features | The current migration retains the app's own packaging scripts. MyGo's CLI packaging and updater are not integrated and are not claimed as delivered benefits. |
| Toolchain | MyGo raises the declared Go requirement from 1.26.8 to 1.27.3. |
| Acceptance | MyGo unit tests, native lifecycle/chrome/shell smoke tests and selected real-extension UI interactions pass. Chinese IME composition, actual streaming conversations, tray-menu clicks, and Windows/Linux GUI acceptance remain pending. |

## Decision

After reviewing the comparison and trying the app, the user selected MyGo as the primary implementation on `main` on 2026-10-29 and requested a fresh Git history. MyGo offers smaller clean packages and a simpler native build/maintenance path, but these measurements do not justify calling it substantially faster or more memory-efficient. The remaining real-conversation and target-platform acceptance gaps still apply.

## Local Evidence

Raw measurements, source metadata, build logs and the measurement harness are under `test-artifacts/mygo-comparison/` (Git-ignored). `raw-dom.json`, `summary-dom.json`, `sizes.json`, and `source.json` define the final dataset. `runs-dom/*/stdout.log` preserves readiness and visibility diagnostics. Earlier RAF experiments are retained separately for audit, not pooled into the final dataset.
