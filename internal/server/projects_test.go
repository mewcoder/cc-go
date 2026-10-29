package server

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"cc-go/internal/sessions"
)

func TestImportHistoryProjectsBeforeStarting(t *testing.T) {
	a := testApp(t)
	originalWorkspace, originalPhase := a.state.Workspace, a.phase
	paths := []string{t.TempDir(), t.TempDir()}
	for _, path := range paths {
		directory := filepath.Join(a.cfg.ProjectsDir, sessions.ProjectDirectory(path))
		_ = os.MkdirAll(directory, 0700)
		row, _ := json.Marshal(map[string]string{"cwd": path})
		_ = os.WriteFile(filepath.Join(directory, "11111111-1111-1111-1111-111111111111.jsonl"), row, 0600)
	}
	post := func(route string, args any) *httptest.ResponseRecorder {
		t.Helper()
		body, _ := json.Marshal(args)
		r := httptest.NewRequest("POST", a.ShellURL+"/api/"+route, strings.NewReader(string(body)))
		r.Header.Set("X-Claude-Desktop-Token", a.token)
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, r)
		return w
	}
	w := post("history-projects", map[string]any{})
	var discovered []sessions.Project
	if json.Unmarshal(w.Body.Bytes(), &discovered) != nil || w.Code != 200 || len(discovered) != 2 {
		t.Fatalf("discovery failed: %d %s", w.Code, w.Body.String())
	}
	// An invalid selection must not partially add the valid project.
	w = post("import-projects", map[string]any{"paths": []string{paths[0], t.TempDir()}})
	if w.Code != 400 || len(a.state.Workspaces) != 1 {
		t.Fatalf("invalid import changed sidebar: %d %+v", w.Code, a.state.Workspaces)
	}
	for range 2 {
		w = post("import-projects", map[string]any{"paths": append(paths, paths[0])})
		if w.Code != 200 || len(a.state.Workspaces) != 3 {
			t.Fatalf("import must deduplicate: %d %s %+v", w.Code, w.Body.String(), a.state.Workspaces)
		}
	}
	if a.state.Workspace != originalWorkspace || a.phase != originalPhase || a.peer != nil {
		t.Fatal("import must not switch workspace or activate the plugin")
	}
	if len(a.state.WorkspaceUsedAt) != 0 {
		t.Fatal("import must not count as project usage")
	}
	if len(a.snapshot()["workspaces"].([]map[string]any)) != 3 {
		t.Fatal("imported projects are missing from sidebar")
	}
	reloaded, err := New(a.cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer reloaded.Close()
	if len(reloaded.state.Workspaces) != 3 {
		t.Fatal("imported projects were not persisted")
	}
}

func TestImportProjectsRollsBackOnSaveFailure(t *testing.T) {
	a := testApp(t)
	previous := append([]string(nil), a.state.Workspaces...)
	path := t.TempDir()
	directory := filepath.Join(a.cfg.ProjectsDir, sessions.ProjectDirectory(path))
	_ = os.MkdirAll(directory, 0700)
	row, _ := json.Marshal(map[string]string{"cwd": path})
	_ = os.WriteFile(filepath.Join(directory, "11111111-1111-1111-1111-111111111111.jsonl"), row, 0600)
	a.cfg.DataDir = filepath.Join(t.TempDir(), "missing")
	if err := a.importProjects([]string{path}); err == nil {
		t.Fatal("expected save error")
	}
	if len(a.state.Workspaces) != len(previous) || a.state.Workspaces[0] != previous[0] {
		t.Fatal("failed import changed sidebar")
	}
}

func TestWorkspaceOrderUsesRecentActivityWithoutTouchingOnScan(t *testing.T) {
	a := testApp(t)
	paths := []string{a.state.Workspace, t.TempDir(), t.TempDir(), t.TempDir()}
	a.state.Workspaces = paths
	a.state.WorkspaceUsedAt = map[string]int64{paths[0]: 100, paths[2]: 400}
	for i, updatedAt := range []int64{200, 300, 50, 300} {
		a.sessionCache[paths[i]] = sessionSnapshot{At: time.Now(), Items: []sessions.Session{{ID: regressionSessionID, UpdatedAt: updatedAt, Archived: i == 1}}}
	}
	assertOrder := func(want []string) {
		t.Helper()
		items := a.snapshot()["workspaces"].([]map[string]any)
		for i, path := range want {
			if items[i]["path"] != path {
				t.Fatalf("workspace %d = %v, want %s", i, items[i]["path"], path)
			}
		}
	}
	for range 2 {
		assertOrder([]string{paths[2], paths[1], paths[3], paths[0]})
	}
	if len(a.state.WorkspaceUsedAt) != 2 || a.state.WorkspaceUsedAt[paths[0]] != 100 {
		t.Fatal("snapshot changed usage timestamps")
	}
	if err := a.touchWorkspaceLocked(); err != nil {
		t.Fatal(err)
	}
	assertOrder([]string{paths[0], paths[2], paths[1], paths[3]})
	reloaded, err := New(a.cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer reloaded.Close()
	if reloaded.state.WorkspaceUsedAt[paths[0]] != a.state.WorkspaceUsedAt[paths[0]] {
		t.Fatal("usage timestamp was not persisted")
	}
}

func TestWorkspaceUsageRollsBackOnSaveFailure(t *testing.T) {
	a := testApp(t)
	a.cfg.DataDir = filepath.Join(t.TempDir(), "missing")
	if err := a.touchWorkspaceLocked(); err == nil {
		t.Fatal("expected save error")
	}
	if len(a.state.WorkspaceUsedAt) != 0 {
		t.Fatal("failed save left a usage timestamp")
	}
}
