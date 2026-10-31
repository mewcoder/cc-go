package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"cc-go/internal/sessions"
)

func TestSidebarOptionsPersistRestoreAndSnapshot(t *testing.T) {
	a := testApp(t)
	if got := a.snapshot()["sidebarOptions"].(SidebarOptions); got.Display != "grouped" || got.Sort != "updated" {
		t.Fatalf("unexpected defaults: %+v", got)
	}
	want := SidebarOptions{Display: "merged", Sort: "created", Order: []string{`["/one","a"]`, `["/two","a"]`}, ProjectOrder: []string{"/two", "/one"}}
	w := postAPI(a, "/api/ui", map[string]any{"key": "sidebar-options", "value": want})
	if w.Code != http.StatusOK || !reflect.DeepEqual(a.snapshot()["sidebarOptions"], want) {
		t.Fatalf("saving preferences: %d %s", w.Code, w.Body.String())
	}
	b, err := os.ReadFile(filepath.Join(a.cfg.DataDir, "desktop.json"))
	var saved DesktopState
	if err != nil || json.Unmarshal(b, &saved) != nil || !reflect.DeepEqual(saved.SidebarOptions, want) {
		t.Fatalf("preferences not persisted: %s %v", b, err)
	}
	restored, err := New(a.cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(restored.Close)
	if !reflect.DeepEqual(restored.state.SidebarOptions, want) {
		t.Fatalf("preferences not restored: %+v", restored.state.SidebarOptions)
	}
	snapshot := a.snapshot()["sidebarOptions"].(SidebarOptions)
	snapshot.Order[0] = "changed"
	snapshot.ProjectOrder[0] = "changed"
	if a.state.SidebarOptions.Order[0] != want.Order[0] {
		t.Fatal("snapshot must not alias stored order")
	}
	if a.state.SidebarOptions.ProjectOrder[0] != want.ProjectOrder[0] {
		t.Fatal("snapshot must not alias stored project order")
	}
	if a.peer != nil {
		t.Fatal("sidebar preferences must not activate the plugin")
	}
}

func TestSidebarSnapshotIncludesCreationTime(t *testing.T) {
	a := testApp(t)
	a.sessionCache[a.state.Workspace] = sessionSnapshot{At: time.Now(), Items: []sessions.Session{
		{ID: "chat", Title: "Chat", CreatedAt: 1000, UpdatedAt: 2000},
	}}
	workspace := a.snapshot()["workspaces"].([]map[string]any)[0]
	chat := workspace["sessions"].([]map[string]any)[0]
	if chat["createdAt"] != int64(1000) || chat["updatedAt"] != int64(2000) {
		t.Fatalf("snapshot lost session timestamps: %+v", chat)
	}
}

func TestSidebarOptionsRejectInvalidValuesAndRollbackSave(t *testing.T) {
	a := testApp(t)
	previous := a.state.SidebarOptions
	for _, value := range []any{nil, "merged", true,
		SidebarOptions{Display: "unknown", Sort: "manual"},
		SidebarOptions{Display: "merged", Sort: "unknown"},
		SidebarOptions{Display: "merged", Sort: "manual", Order: []string{"x", "x"}},
		SidebarOptions{Display: "merged", Sort: "manual", Order: []string{""}},
		SidebarOptions{Display: "grouped", Sort: "updated", ProjectOrder: []string{"/one", "/one"}},
		SidebarOptions{Display: "grouped", Sort: "updated", ProjectOrder: []string{""}},
		SidebarOptions{Display: "merged", Sort: "manual", Order: []string{strings.Repeat("x", 8193)}},
	} {
		w := postAPI(a, "/api/ui", map[string]any{"key": "sidebar-options", "value": value})
		if w.Code != http.StatusBadRequest || !reflect.DeepEqual(a.state.SidebarOptions, previous) {
			t.Fatalf("invalid value accepted: %v %d", value, w.Code)
		}
	}
	a.cfg.DataDir = filepath.Join(t.TempDir(), "missing")
	w := postAPI(a, "/api/ui", map[string]any{"key": "sidebar-options", "value": SidebarOptions{Display: "merged", Sort: "manual"}})
	if w.Code != http.StatusBadRequest || !reflect.DeepEqual(a.state.SidebarOptions, previous) {
		t.Fatal("failed preference save must roll back")
	}
}

func TestSidebarListScriptIsIncludedAndServed(t *testing.T) {
	a := testApp(t)
	for file, expected := range map[string]string{"shell.html": `src="sidebar-list.js"`, "sidebar-list.js": "goSidebarList"} {
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, httptest.NewRequest("GET", a.ShellURL+"/"+file, nil))
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), expected) {
			t.Fatalf("missing %s: %d", file, w.Code)
		}
	}
}
