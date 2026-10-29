package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"cc-go/internal/host"
	"cc-go/internal/sessions"
)

func TestOpenWorkspaceFolderUsesNativePathWithoutSwitchingOrRestarting(t *testing.T) {
	a := testApp(t)
	directory := filepath.Join(t.TempDir(), "project with spaces;literal")
	if err := os.Mkdir(directory, 0700); err != nil {
		t.Fatal(err)
	}
	a.state.Workspaces = append(a.state.Workspaces, directory)
	a.phase, a.selecting, a.activeSessionID = "active", true, "keep-session"
	a.liveSessions["running"] = LiveSession{Status: "working"}
	workspace := a.state.Workspace
	var opened string
	a.SetNative(Native{OpenPath: func(path string) error { opened = path; return nil }})
	body, _ := json.Marshal(map[string]string{"path": directory})
	r := httptest.NewRequest("POST", a.ShellURL+"/api/open-workspace-folder", strings.NewReader(string(body)))
	r.Header.Set("X-Claude-Desktop-Token", a.token)
	w := httptest.NewRecorder()
	a.Handler().ServeHTTP(w, r)
	if w.Code != 200 || opened != directory {
		t.Fatalf("open folder: %d %s %q", w.Code, w.Body.String(), opened)
	}
	if a.state.Workspace != workspace || a.activeSessionID != "keep-session" || a.liveSessions["running"].Status != "working" {
		t.Fatal("opening Finder changed the conversation")
	}
}

func TestRemoveActiveWorkspaceKeepsRunningChatFilesHistoryAndUsage(t *testing.T) {
	a := testApp(t)
	directory := a.state.Workspace
	a.phase, a.activeSessionID = "active", regressionSessionID
	a.liveSessions["running"] = LiveSession{Status: "working", Workspace: directory}
	a.state.WorkspaceUsedAt = map[string]int64{directory: 123}
	key := sessions.Key(directory, regressionSessionID)
	a.state.Metadata[key] = sessions.Metadata{Title: "Kept title", Archived: true}
	filename := filepath.Join(directory, "keep.txt")
	if err := os.WriteFile(filename, []byte("source must stay"), 0600); err != nil {
		t.Fatal(err)
	}
	historyDir := filepath.Join(a.cfg.ProjectsDir, sessions.ProjectDirectory(directory))
	if err := os.MkdirAll(historyDir, 0700); err != nil {
		t.Fatal(err)
	}
	history := filepath.Join(historyDir, regressionSessionID+".jsonl")
	if err := os.WriteFile(history, []byte("saved history"), 0600); err != nil {
		t.Fatal(err)
	}
	w := postAPI(a, "/api/remove-workspace", map[string]any{"path": directory})
	if w.Code != 200 {
		t.Fatalf("remove: %d %s", w.Code, w.Body.String())
	}
	if len(a.state.Workspaces) != 0 || a.state.Workspaces == nil {
		t.Fatal("last project must persist as an explicit empty sidebar")
	}
	if a.state.Workspace != directory || a.activeSessionID != regressionSessionID || a.phase != "active" || a.liveSessions["running"].Status != "working" {
		t.Fatal("removing sidebar membership interrupted the active conversation")
	}
	for path, want := range map[string]string{filename: "source must stay", history: "saved history"} {
		if data, err := os.ReadFile(path); err != nil || string(data) != want {
			t.Fatalf("changed %s: %v", path, err)
		}
	}
	if a.state.Metadata[key].Title != "Kept title" || !a.state.Metadata[key].Archived || a.state.WorkspaceUsedAt[directory] != 123 {
		t.Fatal("Remove changed session metadata or project usage")
	}
	reloaded, err := New(a.cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer reloaded.Close()
	if len(reloaded.state.Workspaces) != 0 {
		t.Fatal("removed active project reappeared after restart")
	}
	if reloaded.state.Metadata[key].Title != "Kept title" || reloaded.state.WorkspaceUsedAt[directory] != 123 {
		t.Fatal("metadata was not retained on disk")
	}
	config := a.cfg
	config.Workspace = t.TempDir()
	other, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if len(other.state.Workspaces) != 1 || other.state.Workspaces[0] != config.Workspace {
		t.Fatal("an explicitly different startup project must still be added")
	}
}

func TestRemoveWorkspaceHandlesStaleFoldersAndSaveFailure(t *testing.T) {
	a := testApp(t)
	missing := filepath.Join(t.TempDir(), "already-missing")
	a.state.Workspaces = append(a.state.Workspaces, missing)
	if err := a.removeWorkspace(missing); err != nil {
		t.Fatal("stale folders must still be removable:", err)
	}
	if err := a.removeWorkspace(""); err == nil {
		t.Fatal("accepted missing path")
	}
	if err := a.removeWorkspace(t.TempDir()); err == nil {
		t.Fatal("accepted unregistered project")
	}
	a.opMu.Lock()
	if err := a.removeWorkspace(a.state.Workspace); err == nil {
		t.Fatal("Remove raced another project operation")
	}
	a.opMu.Unlock()
	a.cfg.DataDir = filepath.Join(t.TempDir(), "missing")
	if err := a.removeWorkspace(a.state.Workspace); err == nil {
		t.Fatal("expected save error")
	}
	if len(a.state.Workspaces) != 1 || a.state.Workspaces[0] != a.state.Workspace {
		t.Fatal("failed save changed sidebar membership")
	}
}

func TestExplicitlyReaddingActiveWorkspaceKeepsHostAndRecordsUsage(t *testing.T) {
	a := testApp(t)
	if err := a.removeWorkspace(a.state.Workspace); err != nil {
		t.Fatal(err)
	}
	a.phase, a.peer, a.activeSessionID = "active", &host.Peer{}, regressionSessionID
	t.Cleanup(func() { a.peer = nil })
	peer := a.peer
	if err := a.switchWorkspace(context.Background(), a.state.Workspace); err != nil {
		t.Fatal(err)
	}
	if len(a.state.Workspaces) != 1 || a.peer != peer || a.activeSessionID != regressionSessionID || a.state.WorkspaceUsedAt[a.state.Workspace] == 0 {
		t.Fatal("re-adding active project restarted the host or lost usage tracking")
	}
	reloaded, err := New(a.cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer reloaded.Close()
	if len(reloaded.state.Workspaces) != 1 {
		t.Fatal("re-added membership was not persisted")
	}
	if err := a.removeWorkspace(a.state.Workspace); err != nil {
		t.Fatal(err)
	}
	a.cfg.DataDir = filepath.Join(t.TempDir(), "missing")
	if err := a.switchWorkspace(context.Background(), a.state.Workspace); err == nil {
		t.Fatal("expected failed re-add save")
	}
	if len(a.state.Workspaces) != 0 || a.peer != peer {
		t.Fatal("failed re-add changed sidebar or host")
	}
}

func TestOpenWorkspaceFolderRejectsInvalidPathsAndSurfacesNativeErrors(t *testing.T) {
	a := testApp(t)
	calls := 0
	a.SetNative(Native{OpenPath: func(string) error { calls++; return nil }})
	for _, path := range []string{"", t.TempDir(), filepath.Join(t.TempDir(), "missing")} {
		if err := a.openWorkspaceFolder(path); err == nil {
			t.Fatalf("accepted invalid or unregistered path %q", path)
		}
	}
	file := filepath.Join(t.TempDir(), "not-a-folder.txt")
	if err := os.WriteFile(file, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	a.state.Workspaces = append(a.state.Workspaces, file)
	if err := a.openWorkspaceFolder(file); err == nil || calls != 0 {
		t.Fatal("opened a file rather than a project directory")
	}
	a.SetNative(Native{})
	if err := a.openWorkspaceFolder(a.state.Workspace); err == nil {
		t.Fatal("headless opening should report desktop mode required")
	}
	want := errors.New("file manager unavailable")
	a.SetNative(Native{OpenPath: func(string) error { return want }})
	if err := a.openWorkspaceFolder(a.state.Workspace); !errors.Is(err, want) {
		t.Fatalf("lost native error: %v", err)
	}
}

func TestWorkspaceMenuAssetIsServedAfterDesktop(t *testing.T) {
	a := testApp(t)
	for _, path := range []string{"/", "/workspace-menu.js"} {
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, httptest.NewRequest("GET", a.ShellURL+path, nil))
		if w.Code != 200 {
			t.Fatalf("missing asset %s: %d", path, w.Code)
		}
		if path == "/" {
			html := w.Body.String()
			if !strings.Contains(html, `src="workspace-menu.js" defer`) || strings.Index(html, "desktop.js") > strings.Index(html, "workspace-menu.js") || !strings.Contains(html, "history.js") {
				t.Fatal("workspace menu load order broke existing shell assets")
			}
		}
	}
}
