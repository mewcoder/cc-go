package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
	"unicode/utf16"

	"cc-go/internal/sessions"
	webfiles "cc-go/web"
)

func (a *App) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Both the native shell and browser mode use the exact loopback host.
		u, _ := url.Parse(a.ShellURL)
		if u == nil || r.Host != u.Host {
			http.Error(w, "Forbidden host", 403)
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cache-Control", "no-store")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			if !equalToken(r.Header.Get("X-Claude-Desktop-Token"), a.token) {
				http.Error(w, "Forbidden", 403)
				return
			}
			a.api(w, r)
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" {
			http.Error(w, "Method not allowed", 405)
			return
		}
		filename := strings.TrimPrefix(r.URL.Path, "/")
		if filename == "host-config.js" {
			platform := runtime.GOOS
			if platform == "windows" {
				platform = "win32"
			}
			a.mu.Lock()
			config := map[string]any{"token": a.token, "platform": platform, "native": a.native.SelectFolder != nil}
			a.mu.Unlock()
			b, _ := json.Marshal(config)
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
			_, _ = fmt.Fprintf(w, "window.__goDesktopConfig = %s;", b)
			return
		}
		if filename == "" || filename == "index.html" {
			filename = "shell.html"
		}
		allowed := map[string]bool{"shell.html": true, "shell.js": true, "shell.css": true, "theme.css": true, "theme-light.css": true, "desktop.js": true, "history.js": true, "setup.js": true, "hud.js": true, "selection.js": true, "workspace-menu.js": true, "host.css": true, "scrollbars.css": true}
		if !allowed[filename] {
			http.NotFound(w, r)
			return
		}
		b, err := webfiles.Files.ReadFile(filename)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		switch {
		case filename == "shell.html":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			html := strings.Replace(string(b), "frame-src 'none'", "frame-src "+a.ViewURL+"; connect-src 'self'", 1)
			html = strings.Replace(html, `<script src="shell.js"`, `<link rel="stylesheet" href="host.css"><link rel="stylesheet" href="scrollbars.css"><script src="host-config.js"></script><script src="hud.js"></script><script src="selection.js"></script><script src="desktop.js"></script><script src="workspace-menu.js" defer></script><script src="history.js" defer></script><script src="setup.js" defer></script><script src="shell.js"`, 1)
			b = []byte(html)
		case strings.HasSuffix(filename, ".js"):
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		case strings.HasSuffix(filename, ".css"):
			w.Header().Set("Content-Type", "text/css; charset=utf-8")
		}
		if r.Method != "HEAD" {
			_, _ = w.Write(b)
		}
	})
}

func (a *App) api(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.URL.Path == "/api/state" && r.Method == "GET" {
		_ = json.NewEncoder(w).Encode(a.snapshot())
		return
	}
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", 405)
		return
	}
	var args struct {
		Path, ID, Workspace, Theme, Key, Branch string
		Paths                                   []string
		Title                                   *string
		Archived                                *bool
		Value                                   json.RawMessage
		Open                                    bool
		Width                                   *int
		Collapsed                               *bool
		Persist                                 bool
		Draft                                   *bool
		Force                                   bool
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&args); err != nil {
		http.Error(w, "Invalid request", 400)
		return
	}
	var result any = map[string]bool{"ok": true}
	var err error
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	a.mu.Lock()
	peer, native := a.peer, a.native
	selecting := a.selecting
	a.mu.Unlock()
	if selecting {
		switch r.URL.Path {
		case "/api/new", "/api/open-session", "/api/select", "/api/close", "/api/workspace":
			http.Error(w, "project or branch selection is in progress", http.StatusConflict)
			return
		}
	}
	switch r.URL.Path {
	case "/api/project":
		result = a.projectInfo(ctx, args.Workspace, args.Force)
	case "/api/view-draft":
		err = a.setViewDraft(args.ID, args.Draft)
	case "/api/open-workspace-folder":
		err = a.openWorkspaceFolder(args.Path)
	case "/api/remove-workspace":
		err = a.removeWorkspace(args.Path)
	case "/api/branches":
		result, err = a.branchOptions(ctx, args.ID, args.Workspace)
	case "/api/select-project":
		err = a.selectProject(ctx, args.ID, args.Workspace, args.Path)
	case "/api/select-branch":
		err = a.selectBranch(ctx, args.ID, args.Workspace, args.Branch)
	case "/api/history-projects":
		result, err = sessions.Discover(a.cfg.ProjectsDir)
	case "/api/import-projects":
		err = a.importProjects(args.Paths)
	case "/api/start":
		if !a.opMu.TryLock() {
			err = errors.New("another plugin operation is in progress")
			break
		}
		a.mu.Lock()
		ready := a.prepared != nil && a.setupStatus == "ready"
		if a.phase == "active" && a.peer != nil {
			a.pluginSetupOpen = false
			a.settingsOpen = false
			a.mu.Unlock()
		} else {
			a.mu.Unlock()
			if !ready {
				err = errors.New("complete setup before starting")
			} else {
				err = a.activateChosenWorkspace(ctx)
				if err != nil {
					a.fail(err)
				}
			}
		}
		a.opMu.Unlock()
	case "/api/ui":
		closeWindow := false
		a.mu.Lock()
		switch args.Key {
		case "logs":
			a.logsOpen = args.Open
		case "settings":
			a.settingsOpen = args.Open
		case "setup":
			if !args.Open && a.phase != "active" {
				// There is no usable chat behind startup setup. Keep it intact on reopen.
				if native.CloseWindow == nil {
					err = errors.New("close this browser tab to leave setup, or click Start to continue")
				} else {
					closeWindow = true
				}
			} else {
				a.pluginSetupOpen = args.Open
				if args.Open {
					a.settingsOpen = false
				}
			}
		case "sidebar":
			if args.Width != nil {
				a.state.SidebarWidth = min(420, max(180, *args.Width))
			}
			if args.Collapsed != nil {
				a.state.SidebarCollapsed = *args.Collapsed
			}
			if args.Persist {
				err = a.saveLocked()
			}
		case "transcript-width":
			var value string
			if json.Unmarshal(args.Value, &value) != nil || !validTranscriptWidth(value) {
				err = errors.New("invalid transcript width")
				break
			}
			previous := a.state.TranscriptWidth
			a.state.TranscriptWidth = value
			if err = a.saveLocked(); err != nil {
				a.state.TranscriptWidth = previous
				break
			}
			message, _ := json.Marshal(map[string]string{"_claudeHostTranscriptWidth": value})
			for _, view := range a.views {
				_ = view.post(message)
			}
		default:
			err = errors.New("unknown desktop UI state")
		}
		a.mu.Unlock()
		if closeWindow {
			native.CloseWindow()
		}
	case "/api/native":
		switch args.Key {
		case "menu":
			if native.ShowMenu == nil {
				err = errors.New("application menu requires desktop mode")
			} else {
				native.ShowMenu()
			}
		case "folder":
			if native.OpenPath == nil {
				err = errors.New("native folder opening requires desktop mode")
			} else {
				directory := filepath.Join(a.cfg.DataDir, "vsix")
				err = os.MkdirAll(directory, 0700)
				if err == nil {
					err = native.OpenPath(directory)
				}
			}
		case "download":
			err = openExternal(native, "https://open-vsx.org/extension/Anthropic/claude-code")
		case "download-node":
			err = openExternal(native, "https://nodejs.org/en/download")
		case "select-node":
			if native.SelectNode == nil {
				err = errors.New("native file selection requires desktop mode")
				break
			}
			args.Path, err = native.SelectNode()
			if err == nil && args.Path != "" {
				if !a.opMu.TryLock() {
					err = errors.New("another plugin operation is in progress")
					break
				}
				a.mu.Lock()
				a.cfg.Node, a.state.Node = args.Path, args.Path
				err = a.saveLocked()
				a.mu.Unlock()
				a.opMu.Unlock()
			}
		default:
			err = errors.New("unknown native action")
		}
	case "/api/new":
		err = a.newConversation(ctx, args.Workspace)
	case "/api/open-session":
		err = a.openConversation(ctx, args.Workspace, args.ID)
	case "/api/workspace":
		if args.Path == "" && native.SelectFolder != nil {
			args.Path, err = native.SelectFolder()
		}
		if err == nil && args.Path != "" {
			err = a.switchWorkspace(ctx, args.Path)
		}
	case "/api/import":
		if args.Path == "" && native.SelectVSIX != nil {
			args.Path, err = native.SelectVSIX()
		}
		if err == nil && args.Path != "" {
			err = a.reloadPlugin(ctx, args.Path)
		}
	case "/api/update-check":
		err = a.checkPluginUpdate(ctx)
	case "/api/update-plugin":
		err = a.updatePlugin(ctx)
	case "/api/retry":
		err = a.reloadPlugin(ctx, a.cfg.VSIX)
	case "/api/select", "/api/close":
		err = a.changeView(args.ID, r.URL.Path == "/api/close")
	case "/api/theme":
		if args.Theme != "light" && args.Theme != "dark" {
			err = errors.New("invalid theme")
			break
		}
		a.mu.Lock()
		a.state.Theme = args.Theme
		err = a.saveLocked()
		for _, v := range a.views {
			message, _ := json.Marshal(map[string]string{"_claudeHostTheme": args.Theme})
			_ = v.post(message)
		}
		a.mu.Unlock()
		if err == nil && native.SetTheme != nil {
			native.SetTheme(args.Theme)
		}
	case "/api/session-meta":
		// HTML maxlength counts UTF-16 code units, not Unicode code points.
		if !sessions.ID.MatchString(args.ID) || args.Title != nil && len(utf16.Encode([]rune(*args.Title))) > 200 {
			err = errors.New("invalid session metadata")
			break
		}
		a.mu.Lock()
		known := false
		for _, p := range a.state.Workspaces {
			known = known || p == args.Workspace
		}
		if !known {
			err = errors.New("workspace is not registered")
		} else {
			key := sessions.Key(args.Workspace, args.ID)
			meta := a.state.Metadata[key]
			if args.Title != nil {
				meta.Title = strings.TrimSpace(*args.Title)
			}
			if args.Archived != nil {
				meta.Archived = *args.Archived
			}
			a.state.Metadata[key] = meta
			err = a.saveLocked()
		}
		a.mu.Unlock()
		a.sessionMu.Lock()
		delete(a.sessionCache, args.Workspace)
		a.sessionMu.Unlock()
	case "/api/settings", "/api/settings-update":
		if peer == nil {
			err = errors.New("plugin host is not ready")
			break
		}
		method := "settings.get"
		if r.URL.Path == "/api/settings-update" {
			method = "settings.update"
		}
		result, err = peer.Call(ctx, method, map[string]any{"key": args.Key, "value": args.Value})
	default:
		http.NotFound(w, r)
		return
	}
	if err != nil {
		w.WriteHeader(400)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	_ = json.NewEncoder(w).Encode(result)
}
