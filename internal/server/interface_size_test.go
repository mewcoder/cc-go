package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInterfaceSizePersistsAndUpdatesAllViews(t *testing.T) {
	a := testApp(t)
	if got := a.snapshot()["interfaceSize"]; got != "small" {
		t.Fatalf("default interface size = %v", got)
	}
	for _, id := range []string{"active", "background"} {
		a.views[id] = newView(id, id, "test")
	}
	a.active = "active"
	for _, value := range []string{"small", "large", "medium"} {
		w := postAPI(a, "/api/ui", map[string]any{"key": "interface-size", "value": value})
		if w.Code != http.StatusOK || a.snapshot()["interfaceSize"] != value {
			t.Fatalf("saving %s: %d %s", value, w.Code, w.Body.String())
		}
		for _, view := range a.views {
			var message map[string]string
			if err := json.Unmarshal(view.messages[len(view.messages)-1].Data, &message); err != nil || message["_claudeHostInterfaceSize"] != value {
				t.Fatalf("interface size not broadcast to %s: %v %v", view.ID, message, err)
			}
			if view.Revision != 0 || view.HasDraft {
				t.Fatal("interface size changes must not reload views or change drafts")
			}
		}
		b, err := os.ReadFile(filepath.Join(a.cfg.DataDir, "desktop.json"))
		var saved DesktopState
		if err != nil || json.Unmarshal(b, &saved) != nil || saved.InterfaceSize != value {
			t.Fatalf("interface size not persisted: %s %v", b, err)
		}
	}
	if a.peer != nil {
		t.Fatal("a desktop-only setting must not launch the extension host")
	}
}

func TestInterfaceSizeRestoresAndNormalizesOldState(t *testing.T) {
	for _, value := range []string{"", "invalid", "small", "medium", "large"} {
		t.Run(value, func(t *testing.T) {
			a := testApp(t)
			a.state.InterfaceSize = value
			if err := a.saveLocked(); err != nil {
				t.Fatal(err)
			}
			restored, err := New(a.cfg)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(restored.Close)
			want := value
			if !validInterfaceSize(want) {
				want = "small"
			}
			if restored.state.InterfaceSize != want {
				t.Fatalf("restored %q, want %q", restored.state.InterfaceSize, want)
			}
		})
	}
}

func TestInterfaceSizeMigratesPreviousChatFontSizeWithoutEnlargingDefault(t *testing.T) {
	for _, tc := range []struct {
		name, preset, want string
		legacy             int
	}{
		{name: "unset", want: "small"},
		{name: "old default", legacy: 13, want: "small"},
		{name: "smaller font", legacy: 10, want: "small"},
		{name: "medium font", legacy: 15, want: "medium"},
		{name: "larger font", legacy: 18, want: "large"},
		{name: "invalid font", legacy: 25, want: "small"},
		{name: "explicit preset", preset: "medium", legacy: 13, want: "medium"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := testApp(t)
			a.state.InterfaceSize = tc.preset
			a.state.LegacyChatFontSize = tc.legacy
			if err := a.saveLocked(); err != nil {
				t.Fatal(err)
			}
			restored, err := New(a.cfg)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(restored.Close)
			if restored.state.InterfaceSize != tc.want || restored.state.LegacyChatFontSize != 0 {
				t.Fatalf("migrated size = %s, legacy = %d", restored.state.InterfaceSize, restored.state.LegacyChatFontSize)
			}
		})
	}
}

func TestInterfaceSizeRejectsInvalidValuesAndRollsBackFailedSave(t *testing.T) {
	a := testApp(t)
	view := newView("chat", "Chat", "test")
	a.views[view.ID] = view
	for _, value := range []any{nil, 0, 13, 14.5, true, "16", "", "Large", map[string]any{"size": "large"}} {
		w := postAPI(a, "/api/ui", map[string]any{"key": "interface-size", "value": value})
		if w.Code != http.StatusBadRequest || a.state.InterfaceSize != "small" || len(view.messages) != 0 {
			t.Fatalf("invalid value accepted: %v %d %s", value, w.Code, w.Body.String())
		}
	}
	a.cfg.DataDir = filepath.Join(t.TempDir(), "missing")
	w := postAPI(a, "/api/ui", map[string]any{"key": "interface-size", "value": "large"})
	if w.Code != http.StatusBadRequest || a.state.InterfaceSize != "small" || len(view.messages) != 0 {
		t.Fatal("a failed save must not change or broadcast the interface size")
	}
}

func TestNewViewBridgeIncludesSavedInterfaceSize(t *testing.T) {
	a := testApp(t)
	a.state.InterfaceSize = "large"
	a.views["chat"] = newView("chat", "Chat", "test")
	w := httptest.NewRecorder()
	a.ViewHandler().ServeHTTP(w, httptest.NewRequest("GET", a.ViewURL+"/view/chat/test/bridge.js", nil))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"interfaceSize":"large"`) {
		t.Fatalf("new/reloaded views must inherit the saved size: %d %s", w.Code, w.Body.String())
	}
}

func TestInterfaceSizeControlIsServedAndIncludedInShell(t *testing.T) {
	a := testApp(t)
	for resource, content := range map[string]string{"shell.html": `src="settings-interface-size.js"`, "settings-interface-size.js": "goInterfaceSizeControl"} {
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, httptest.NewRequest("GET", a.ShellURL+"/"+resource, nil))
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), content) {
			t.Fatalf("interface size control missing from %s: %d %s", resource, w.Code, w.Body.String())
		}
	}
}
