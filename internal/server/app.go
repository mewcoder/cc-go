package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"cc-go/internal/host"
	"cc-go/internal/plugin"
	"cc-go/internal/sessions"
	runtimefiles "cc-go/runtime"

	"github.com/zalando/go-keyring"
)

type Config struct {
	DataDir, Workspace, VSIX, Node, ModulesDir, ProjectsDir string
	DevAssets                                               string
	VSCodeExtensionsDirs                                    []string
}

type Native struct {
	ShowMenu      func()
	SetTheme      func(string)
	CloseWindow   func()
	OpenURL       func(string) error
	OpenPath      func(string) error
	ReadClipboard func() (string, error)
	Copy          func(string) error
	SelectFolder  func() (string, error)
	SelectVSIX    func() (string, error)
	SelectNode    func() (string, error)
	Message       func(string, string, []string) (int, error)
}

type DesktopState struct {
	Workspace        string                       `json:"workspace"`
	Workspaces       []string                     `json:"workspaces"`
	WorkspaceUsedAt  map[string]int64             `json:"workspaceUsedAt,omitempty"`
	Theme            string                       `json:"theme"`
	Metadata         map[string]sessions.Metadata `json:"metadata"`
	Archive          string                       `json:"archive,omitempty"`
	ArchiveSource    string                       `json:"archiveSource,omitempty"`
	Claude           string                       `json:"claude,omitempty"` // Legacy state only; never used for runtime discovery.
	Node             string                       `json:"node,omitempty"`
	SetupComplete    bool                         `json:"setupComplete,omitempty"`
	SidebarWidth     int                          `json:"sidebarWidth"`
	SidebarCollapsed bool                         `json:"sidebarCollapsed"`
	TranscriptWidth  string                       `json:"transcriptWidth"`
}

type LiveSession struct {
	ViewID      string `json:"viewId"`
	Workspace   string `json:"workspace"`
	ID          string `json:"id"`
	Status      string `json:"status"`
	CompletedAt int64  `json:"completedAt"`
}

type SessionMetrics struct {
	Model               string   `json:"model,omitempty"`
	ContextTokens       *float64 `json:"contextTokens,omitempty"`
	ContextWindow       *float64 `json:"contextWindow,omitempty"`
	ContextWindowSource string   `json:"contextWindowSource,omitempty"`
	InputTokens         *float64 `json:"inputTokens,omitempty"`
	OutputTokens        *float64 `json:"outputTokens,omitempty"`
	CacheReadTokens     *float64 `json:"cacheReadTokens,omitempty"`
	CacheWriteTokens    *float64 `json:"cacheWriteTokens,omitempty"`
}

type App struct {
	cfg             Config
	mu              sync.Mutex
	opMu            sync.Mutex
	state           DesktopState
	phase           string
	label           string
	errorText       string
	logs            []string
	views           map[string]*View
	active          string
	peer            *host.Peer
	hostGeneration  uint64
	prepared        *plugin.Prepared
	version         string
	stopping        bool
	selecting       bool
	logsOpen        bool
	settingsOpen    bool
	pluginSetupOpen bool
	windowHidden    bool
	activeSessionID string
	setupStatus     string
	download        plugin.DownloadProgress
	downloadAt      time.Time
	downloadCancel  context.CancelCauseFunc
	runtimePath     string
	latestVersion   string
	checkingUpdate  bool
	updateError     string
	setupSaveError  string
	updateMu        sync.Mutex
	nodeVersion     string
	nodePath        string
	nodeError       string
	setupStep       int
	liveSessions    map[string]LiveSession
	metrics         map[string]SessionMetrics
	project         projectCache
	native          Native
	token           string
	ShellURL        string
	ViewURL         string
	shell           *http.Server
	view            *http.Server
	logFile         *os.File
	ctx             context.Context
	cancel          context.CancelFunc
	startDone       chan struct{}
	closeOnce       sync.Once

	sessionMu    sync.Mutex
	sessionCache map[string]sessionSnapshot
}

type sessionSnapshot struct {
	At    time.Time
	Items []sessions.Session
}

func randomToken() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func New(cfg Config) (*App, error) {
	var err error
	if cfg.VSCodeExtensionsDirs == nil {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		cfg.VSCodeExtensionsDirs = plugin.VSCodeExtensionDirectories(home, os.Getenv("VSCODE_PORTABLE"))
	}
	if cfg.DevAssets != "" {
		cfg.DevAssets, err = filepath.Abs(cfg.DevAssets)
		if err != nil {
			return nil, err
		}
		if _, err := os.Stat(filepath.Join(cfg.DevAssets, "shell.html")); err != nil {
			return nil, fmt.Errorf("development web assets: %w", err)
		}
	}
	cfg.DataDir, err = filepath.Abs(cfg.DataDir)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(cfg.DataDir, 0700); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	a := &App{cfg: cfg, ctx: ctx, cancel: cancel, token: randomToken(), phase: "starting", label: "Preparing Claude Code", pluginSetupOpen: true, views: make(map[string]*View), startDone: make(chan struct{}), sessionCache: make(map[string]sessionSnapshot)}
	a.liveSessions = make(map[string]LiveSession)
	a.metrics = make(map[string]SessionMetrics)
	a.state = DesktopState{Theme: "dark", SidebarWidth: 248, Metadata: make(map[string]sessions.Metadata)}
	b, err := os.ReadFile(filepath.Join(cfg.DataDir, "desktop.json"))
	if err == nil {
		if err := json.Unmarshal(b, &a.state); err != nil {
			cancel()
			return nil, fmt.Errorf("invalid desktop.json (not overwritten): %w", err)
		}
	} else if !os.IsNotExist(err) {
		cancel()
		return nil, err
	}
	if a.state.Metadata == nil {
		a.state.Metadata = make(map[string]sessions.Metadata)
	}
	a.pluginSetupOpen = !a.state.SetupComplete
	if a.state.SidebarWidth < 180 || a.state.SidebarWidth > 420 {
		a.state.SidebarWidth = 248
	}
	if !validTranscriptWidth(a.state.TranscriptWidth) {
		a.state.TranscriptWidth = "narrow"
	}
	if cfg.Node == "" {
		a.cfg.Node = a.state.Node
	}
	previousWorkspace := a.state.Workspace
	if cfg.Workspace != "" {
		a.state.Workspace = cfg.Workspace
	}
	if a.state.Workspace == "" {
		a.state.Workspace, _ = os.UserHomeDir()
	}
	workspace, err := validWorkspace(a.state.Workspace)
	workspaceExists := err == nil
	if err != nil {
		if cfg.Workspace != "" {
			cancel()
			return nil, err
		}
		// Activation will automatically replace an unavailable remembered path.
		workspace, err = filepath.Abs(a.state.Workspace)
		if err != nil {
			cancel()
			return nil, err
		}
	}
	a.state.Workspace = workspace
	// An empty saved list can be intentional: Remove hides the active project too.
	if workspaceExists && (a.state.Workspaces == nil || workspace != previousWorkspace) {
		a.addWorkspaceLocked(workspace)
	}
	if a.state.Theme != "light" {
		a.state.Theme = "dark"
	}
	a.logFile, err = os.OpenFile(filepath.Join(cfg.DataDir, "host.log"), os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		cancel()
		return nil, err
	}
	return a, nil
}

func validWorkspace(directory string) (string, error) {
	full, err := filepath.Abs(directory)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(full)
	if err != nil || !info.IsDir() {
		return "", errors.New("workspace must be an existing directory")
	}
	return full, nil
}

func (a *App) SetNative(native Native) {
	a.mu.Lock()
	a.native = native
	theme := a.state.Theme
	a.mu.Unlock()
	if native.SetTheme != nil {
		native.SetTheme(theme)
	}
}

func (a *App) Start() error {
	shellListener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	viewListener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		shellListener.Close()
		return err
	}
	a.ShellURL = "http://" + shellListener.Addr().String()
	a.ViewURL = "http://" + viewListener.Addr().String()
	a.shell = &http.Server{Handler: a.Handler(), ReadHeaderTimeout: 5 * time.Second}
	a.view = &http.Server{Handler: a.ViewHandler(), ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = a.shell.Serve(shellListener) }()
	go func() { _ = a.view.Serve(viewListener) }()
	go func() {
		defer close(a.startDone)
		a.opMu.Lock()
		defer a.opMu.Unlock()
		if err := a.prepare(a.ctx, a.cfg.VSIX); err != nil {
			if a.ctx.Err() == nil {
				a.fail(err)
			}
		} else {
			a.mu.Lock()
			completed := a.state.SetupComplete
			a.mu.Unlock()
			if completed {
				if err := a.activateChosenWorkspace(a.ctx); err != nil {
					if a.ctx.Err() == nil {
						a.fail(err)
					}
					return
				}
			}
			if completed && a.cfg.VSIX == "" {
				go func() { _ = a.checkPluginUpdate(a.ctx) }()
			}
		}
	}()
	return nil
}

func (a *App) addWorkspaceLocked(workspace string) {
	for _, p := range a.state.Workspaces {
		if p == workspace {
			return
		}
	}
	a.state.Workspaces = append(a.state.Workspaces, workspace)
}

func (a *App) touchWorkspaceLocked() error {
	if a.state.WorkspaceUsedAt == nil {
		a.state.WorkspaceUsedAt = make(map[string]int64)
	}
	path := a.state.Workspace
	previous, existed := a.state.WorkspaceUsedAt[path]
	a.state.WorkspaceUsedAt[path] = time.Now().UnixMilli()
	if err := a.saveLocked(); err != nil {
		if existed {
			a.state.WorkspaceUsedAt[path] = previous
		} else {
			delete(a.state.WorkspaceUsedAt, path)
		}
		return err
	}
	return nil
}

func (a *App) saveLocked() error {
	b, err := json.MarshalIndent(a.state, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(a.cfg.DataDir, ".desktop-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	_, err = f.Write(b)
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err := os.Rename(f.Name(), filepath.Join(a.cfg.DataDir, "desktop.json")); err != nil {
		return err
	}
	a.setupSaveError = ""
	return nil
}

func (a *App) Log(level, text string) {
	line := time.Now().UTC().Format(time.RFC3339) + " [" + level + "] " + text
	if len(line) > 8000 {
		line = line[:8000]
	}
	a.mu.Lock()
	a.logs = append(a.logs, line)
	if len(a.logs) > 200 {
		a.logs = a.logs[len(a.logs)-200:]
	}
	if a.logFile != nil {
		_, _ = fmt.Fprintln(a.logFile, line)
	}
	a.mu.Unlock()
	log.Print(line)
}

type logWriter struct{ a *App }

func (w logWriter) Write(b []byte) (int, error) {
	w.a.Log("plugin", strings.TrimSpace(string(b)))
	return len(b), nil
}

func (a *App) fail(err error) {
	a.mu.Lock()
	a.failLocked(err)
	a.mu.Unlock()
	a.Log("error", err.Error())
}

func (a *App) failLocked(err error) {
	a.phase, a.errorText = "error", err.Error()
	a.pluginSetupOpen, a.settingsOpen = true, false
	if a.setupStatus != "needs-node" {
		a.setupStatus = "error"
	}
	if a.prepared == nil || a.setupStatus == "needs-node" {
		a.phase = "setup"
	}
	if errors.Is(err, errDownloadCancelled) {
		a.setupStatus, a.errorText = "cancelled", ""
	}
}

func (a *App) prepare(ctx context.Context, archive string) error {
	a.mu.Lock()
	rememberedArchive := archive == "" && a.state.Archive != ""
	archiveSource := ""
	if rememberedArchive {
		archiveSource = a.state.ArchiveSource
	}
	a.phase, a.label, a.errorText = "preparing", "Checking Node.js", ""
	if !a.state.SetupComplete {
		a.pluginSetupOpen = true
	}
	a.prepared, a.version, a.runtimePath = nil, "", ""
	a.setupStatus, a.setupStep, a.nodeError, a.nodeVersion, a.nodePath = "detecting-node", 0, "", "", ""
	a.download = plugin.DownloadProgress{}
	explicitNode := a.cfg.Node
	if archive == "" {
		archive = a.state.Archive
	}
	a.mu.Unlock()
	home, _ := os.UserHomeDir()
	node, err := host.CheckNode(ctx, explicitNode, home)
	if err != nil {
		a.mu.Lock()
		a.setupStatus, a.nodeError = "needs-node", err.Error()
		a.mu.Unlock()
		return err
	}
	a.mu.Lock()
	a.nodeVersion, a.nodePath = node.Version, node.Executable
	a.setupStatus, a.setupStep, a.label = "extracting", 1, "Preparing Claude Code extension"
	a.mu.Unlock()
	if rememberedArchive {
		if _, err := os.Stat(archive); os.IsNotExist(err) {
			archive = ""
			archiveSource = ""
		}
	}
	expectedVersion := ""
	var prepared *plugin.Prepared
	if archive == "" {
		a.mu.Lock()
		a.setupStatus, a.label = "checking-installed", "Checking installed VS Code extension"
		a.mu.Unlock()
		installed, err := plugin.ReuseInstalled(ctx, a.cfg.VSCodeExtensionsDirs, filepath.Join(a.cfg.DataDir, "vsix"), filepath.Join(a.cfg.DataDir, "extensions"), plugin.Platform())
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil {
			a.Log("warning", "Could not reuse installed VS Code extension; falling back to download: "+err.Error())
		}
		archive, prepared = installed.Archive, installed.Prepared
		if prepared != nil {
			archiveSource = "vscode"
			a.Log("info", "Reusing installed VS Code extension: Claude Code "+fmt.Sprint(prepared.PackageJSON["version"]))
		}
	}
	if archive == "" {
		download, err := a.downloadVSIX(ctx, "latest")
		if err != nil {
			return err
		}
		archive, expectedVersion = download.Archive, download.Version
	}
	a.Log("info", "Preparing VS Code extension (.vsix): "+archive)
	a.mu.Lock()
	a.setupStatus, a.setupStep = "extracting", 1
	a.mu.Unlock()
	if prepared == nil {
		prepared, err = plugin.Prepare(archive, filepath.Join(a.cfg.DataDir, "extensions"), plugin.Platform(), expectedVersion)
		if err != nil {
			return err
		}
	}
	a.mu.Lock()
	a.version = fmt.Sprint(prepared.PackageJSON["version"])
	a.setupStatus, a.setupStep, a.label = "checking-runtime", 1, "Checking bundled Claude runtime"
	a.mu.Unlock()
	runtimePath, err := plugin.BundledRuntime(prepared.ExtensionPath, plugin.Platform())
	if err != nil {
		return err
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	a.mu.Lock()
	a.prepared, a.runtimePath = prepared, runtimePath
	a.state.Archive, _ = filepath.Abs(archive)
	a.state.ArchiveSource = archiveSource
	err = a.saveLocked()
	if err == nil {
		a.phase, a.label, a.setupStatus = "setup", "Ready to start", "ready"
	}
	a.mu.Unlock()
	return err
}

func (a *App) reloadPlugin(ctx context.Context, archive string) error {
	if !a.opMu.TryLock() {
		return errors.New("another plugin operation is in progress")
	}
	defer a.opMu.Unlock()
	a.mu.Lock()
	err := a.workspaceChangeErrorLocked()
	if err == nil {
		// Close input admission under the same lock as the idle/draft check.
		a.phase, a.stopping = "preparing", true
	}
	a.mu.Unlock()
	if err != nil {
		return err
	}
	a.stopHost()
	if err := a.prepare(ctx, archive); err != nil {
		a.fail(err)
		return err
	}
	return nil
}

func (a *App) downloadVSIX(ctx context.Context, version string) (plugin.Downloaded, error) {
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	a.mu.Lock()
	a.label = "Downloading latest Claude Code VS Code extension (.vsix)"
	a.setupStatus, a.setupStep = "downloading", 1
	a.download = plugin.DownloadProgress{}
	a.downloadCancel = cancel
	a.downloadAt = time.Now()
	a.mu.Unlock()
	result, err := plugin.Download(ctx, filepath.Join(a.cfg.DataDir, "vsix"), version, plugin.Platform(), func(progress plugin.DownloadProgress) {
		a.mu.Lock()
		a.download = progress
		a.downloadAt = time.Now()
		a.mu.Unlock()
	})
	a.mu.Lock()
	cause := context.Cause(ctx)
	a.downloadCancel = nil
	a.mu.Unlock()
	if cause != nil {
		return plugin.Downloaded{}, cause
	}
	return result, err
}

var errDownloadCancelled = errors.New("plugin download cancelled")

func (a *App) cancelDownload() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.downloadCancel != nil {
		a.setupStatus = "cancelling"
		a.downloadCancel(errDownloadCancelled)
	}
}

func (a *App) runtimeScript() (string, error) {
	return runtimefiles.Prepare(filepath.Join(a.cfg.DataDir, "runtime"))
}

func (a *App) activate(ctx context.Context) (err error) {
	defer func() {
		if err != nil {
			a.stopHost()
		}
	}()
	a.mu.Lock()
	prepared, workspace := a.prepared, a.state.Workspace
	explicitNode := a.nodePath
	if explicitNode == "" {
		explicitNode = a.cfg.Node
	}
	a.phase, a.label, a.errorText = "activating", "Starting Node plugin host", ""
	a.stopping = false
	a.hostGeneration++
	generation := a.hostGeneration
	a.mu.Unlock()
	if prepared == nil {
		return errors.New("no prepared extension")
	}
	script, err := a.runtimeScript()
	if err != nil {
		return err
	}
	home, _ := os.UserHomeDir()
	node, err := host.FindNode(explicitNode, home)
	if err != nil {
		return err
	}
	env := os.Environ()
	// The module search path is controlled by this app, not by the VSIX or workspace.
	if a.cfg.ModulesDir != "" {
		env = append(env, "NODE_PATH="+a.cfg.ModulesDir)
	}
	p, err := host.Start(node, script, workspace, env, a.hostCall, func(method string, args json.RawMessage) {
		a.hostEvent(generation, method, args)
	}, logWriter{a})
	if err != nil {
		return err
	}
	a.mu.Lock()
	if a.hostGeneration != generation {
		a.mu.Unlock()
		p.Close()
		return errors.New("plugin host exited during initialization")
	}
	a.peer = p
	a.mu.Unlock()
	deadline, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	if err := p.Ready(deadline); err != nil {
		return err
	}
	_, err = p.Call(deadline, "activate", map[string]any{
		"extensionPath": prepared.ExtensionPath, "packageJSON": prepared.PackageJSON,
		"workspacePath": workspace, "storageRoot": a.cfg.DataDir,
		"machineId": a.machineID(), "language": "en", "webviewOrigin": a.ViewURL,
	})
	if err != nil {
		return err
	}
	a.mu.Lock()
	if a.hostGeneration != generation || a.peer != p {
		a.mu.Unlock()
		return errors.New("plugin host disconnected during activation")
	}
	a.phase, a.label = "active", "Claude Code "+a.version
	a.setupStatus = "idle"
	a.mu.Unlock()
	a.Log("info", "Activated Claude Code "+a.version+" in "+workspace)
	_, err = p.Call(deadline, "command", map[string]any{"command": "claude-vscode.editor.open"})
	if err == nil {
		var saveErr error
		a.mu.Lock()
		if !a.state.SetupComplete {
			a.state.SetupComplete = true
			saveErr = a.saveLocked()
			if saveErr != nil {
				a.setupSaveError = saveErr.Error()
			}
		}
		// Show a failed save immediately without taking the usable host offline.
		a.pluginSetupOpen = a.setupSaveError != ""
		a.mu.Unlock()
		if saveErr != nil {
			// Keep the usable host; any later successful state save persists SetupComplete
			// and clears the nonfatal warning.
			a.Log("warning", "Claude Code is active, but setup completion could not be saved: "+saveErr.Error())
		}
	}
	return err
}

func (a *App) machineID() string {
	file := filepath.Join(a.cfg.DataDir, "identity")
	if b, err := os.ReadFile(file); err == nil && len(b) > 0 {
		return string(b)
	}
	id := randomToken()
	_ = os.WriteFile(file, []byte(id), 0600)
	return id
}

func (a *App) stopHost() {
	a.mu.Lock()
	a.stopping = true
	p := a.detachHostLocked()
	a.mu.Unlock()
	if p != nil {
		p.Close()
	}
}

func (a *App) detachHostLocked() *host.Peer {
	p := a.peer
	a.peer = nil
	// Ignore late events from this process after a replacement host is started.
	a.hostGeneration++
	for _, v := range a.views {
		v.close()
	}
	for key, status := range a.liveSessions {
		if status.Status == "working" || status.Status == "needs_input" {
			status.Status = "interrupted"
			a.liveSessions[key] = status
		}
	}
	a.views = make(map[string]*View)
	a.metrics = make(map[string]SessionMetrics)
	a.active = ""
	a.activeSessionID = ""
	a.settingsOpen = false
	return p
}

func (a *App) Close() {
	a.closeOnce.Do(func() {
		a.cancel()
		a.project.close()
		a.updateMu.Lock()
		a.updateMu.Unlock()
		a.opMu.Lock()
		defer a.opMu.Unlock()
		a.stopHost()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if a.shell != nil {
			_ = a.shell.Shutdown(ctx)
		}
		if a.view != nil {
			_ = a.view.Shutdown(ctx)
			_ = a.view.Close()
		}
		a.mu.Lock()
		if a.logFile != nil {
			_ = a.logFile.Close()
			a.logFile = nil
		}
		a.mu.Unlock()
	})
}

func (a *App) hostEvent(generation uint64, method string, args json.RawMessage) {
	var v struct {
		ID, Title, HTML, ResourceToken, Message, Text, Level, Stack string
		LocalResourceRoots                                          []string
		SessionID                                                   string
		Sessions                                                    []LiveSession
		Metrics                                                     SessionMetrics
	}
	_ = json.Unmarshal(args, &v)
	a.mu.Lock()
	if generation != a.hostGeneration || a.stopping {
		a.mu.Unlock()
		return
	}
	var exitedPeer *host.Peer
	switch method {
	case "host.metrics":
		if a.views[v.ID] != nil && sessions.ID.MatchString(v.SessionID) {
			a.metrics[sessions.Key(a.state.Workspace, v.SessionID)] = v.Metrics
		}
	case "host.sessions":
		projectChanged := false
		for _, status := range v.Sessions {
			if view := a.views[status.ViewID]; view != nil {
				view.PendingInput = false
			}
			key := sessions.Key(status.Workspace, status.ID)
			previous := a.liveSessions[key]
			terminal := status.Status == "completed" || status.Status == "error" || status.Status == "interrupted"
			if status.Workspace == a.state.Workspace && terminal && (previous.Status != status.Status || previous.CompletedAt != status.CompletedAt) {
				projectChanged = true
			}
			a.liveSessions[key] = status
			if status.ViewID == a.active && status.ID == a.activeSessionID && status.Status == "completed" {
				a.markActiveReadLocked()
			}
		}
		if projectChanged {
			a.project.invalidate()
		}
	case "host.selection":
		if sessions.ID.MatchString(v.SessionID) {
			a.setViewSessionLocked(v.ID, v.SessionID)
		}
	case "logs.show":
		a.logsOpen = true
	case "logs.hide":
		a.logsOpen = false
	case "webview.create":
		a.views[v.ID] = newView(v.ID, v.Title, v.ResourceToken)
		a.focusViewLocked(v.ID)
	case "webview.options":
		if view := a.views[v.ID]; view != nil {
			view.Roots = append([]string(nil), v.LocalResourceRoots...)
		}
	case "webview.html":
		if view := a.views[v.ID]; view != nil {
			view.HTML = v.HTML
			view.Revision++
		}
	case "webview.focus":
		a.focusViewLocked(v.ID)
	case "webview.title":
		if view := a.views[v.ID]; view != nil {
			view.Title = v.Title
		}
	case "webview.dispose":
		if view := a.views[v.ID]; view != nil {
			view.close()
		}
		delete(a.views, v.ID)
		if a.active == v.ID {
			a.active, a.activeSessionID = "", ""
		}
	case "host.status":
		if v.Message != "" {
			a.label = v.Message
		}
	case "host.exit":
		exitedPeer = a.detachHostLocked()
		a.failLocked(errors.New(v.Message))
	}
	a.mu.Unlock()
	if exitedPeer != nil {
		exitedPeer.Close()
	}
	switch method {
	case "host.exit":
		a.Log("error", v.Message)
	case "host.error":
		a.Log("error", v.Message+"\n"+v.Stack)
	case "host.log":
		a.Log(v.Level, v.Text)
	}
}

func (a *App) hostCall(ctx context.Context, method string, args json.RawMessage) (any, error) {
	var v struct {
		ID, Key, Value, Text, URI, Type, Message string
		Items                                    []json.RawMessage
		MessageData                              json.RawMessage `json:"-"`
	}
	_ = json.Unmarshal(args, &v)
	a.mu.Lock()
	native := a.native
	a.mu.Unlock()
	switch method {
	case "webview.post":
		var payload struct {
			ID      string
			Message json.RawMessage
		}
		if err := json.Unmarshal(args, &payload); err != nil {
			return false, err
		}
		a.mu.Lock()
		view := a.views[payload.ID]
		a.mu.Unlock()
		if view == nil {
			return false, nil
		}
		return true, view.post(payload.Message)
	case "external.open":
		return true, openExternal(native, v.URI)
	case "clipboard.read":
		if native.ReadClipboard != nil {
			return native.ReadClipboard()
		}
	case "clipboard.write":
		if native.Copy != nil {
			return nil, native.Copy(v.Text)
		}
	case "dialog.message":
		var buttons []string
		for _, item := range v.Items {
			var title string
			if json.Unmarshal(item, &title) != nil {
				var obj struct{ Title string }
				_ = json.Unmarshal(item, &obj)
				title = obj.Title
			}
			buttons = append(buttons, title)
		}
		if len(buttons) == 0 {
			a.Log(v.Type, v.Message)
			return nil, nil
		}
		if native.Message != nil {
			idx, err := native.Message(v.Type, v.Message, buttons)
			if err != nil || idx < 0 || idx >= len(v.Items) {
				return nil, err
			}
			return v.Items[idx], nil
		}
		return nil, errors.New("native confirmation requires desktop mode")
	case "secrets.get":
		value, err := keyring.Get("claude-vsix-go", v.Key)
		if errors.Is(err, keyring.ErrNotFound) {
			return nil, nil
		}
		return value, err
	case "secrets.store":
		return nil, keyring.Set("claude-vsix-go", v.Key, v.Value)
	case "secrets.delete":
		err := keyring.Delete("claude-vsix-go", v.Key)
		if errors.Is(err, keyring.ErrNotFound) {
			err = nil
		}
		return nil, err
	}
	return nil, fmt.Errorf("unsupported host capability: %s", method)
}

var _ io.Writer = logWriter{}
