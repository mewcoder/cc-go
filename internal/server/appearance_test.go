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

func TestTranscriptWidthPersistsAndUpdatesAllViews(t *testing.T) {
	a := testApp(t)
	if got := a.snapshot()["transcriptWidth"]; got != "narrow" {
		t.Fatalf("default width = %v", got)
	}
	for _, id := range []string{"active", "background"} {
		a.views[id] = newView(id, id, "test")
	}
	a.active = "active"
	for _, value := range []string{"medium", "wide", "narrow"} {
		w := postAPI(a, "/api/ui", map[string]any{"key": "transcript-width", "value": value})
		if w.Code != http.StatusOK || a.snapshot()["transcriptWidth"] != value {
			t.Fatalf("saving %s: %d %s", value, w.Code, w.Body.String())
		}
		for _, view := range a.views {
			var message map[string]string
			if err := json.Unmarshal(view.messages[len(view.messages)-1].Data, &message); err != nil || message["_claudeHostTranscriptWidth"] != value {
				t.Fatalf("width not broadcast to %s: %v %v", view.ID, message, err)
			}
			if view.Revision != 0 || view.HasDraft {
				t.Fatal("width changes must not reload views or change drafts")
			}
		}
		b, err := os.ReadFile(filepath.Join(a.cfg.DataDir, "desktop.json"))
		var saved DesktopState
		if err != nil || json.Unmarshal(b, &saved) != nil || saved.TranscriptWidth != value {
			t.Fatalf("width not persisted: %s %v", b, err)
		}
	}
	if a.peer != nil {
		t.Fatal("a desktop-only setting must not launch the extension host")
	}
}

func TestTranscriptWidthRestoresAndNormalizesOldState(t *testing.T) {
	for _, value := range []string{"", "invalid", "narrow", "medium", "wide"} {
		t.Run(value, func(t *testing.T) {
			a := testApp(t)
			a.state.TranscriptWidth = value
			if err := a.saveLocked(); err != nil {
				t.Fatal(err)
			}
			restored, err := New(a.cfg)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(restored.Close)
			want := value
			if !validTranscriptWidth(want) {
				want = "narrow"
			}
			if restored.state.TranscriptWidth != want {
				t.Fatalf("restored %q, want %q", restored.state.TranscriptWidth, want)
			}
		})
	}
}

func TestTranscriptWidthRejectsInvalidValuesAndRollsBackFailedSave(t *testing.T) {
	a := testApp(t)
	view := newView("chat", "Chat", "test")
	a.views[view.ID] = view
	for _, value := range []any{nil, 680, true, "full", "", "Wide", map[string]any{"wide": true}} {
		w := postAPI(a, "/api/ui", map[string]any{"key": "transcript-width", "value": value})
		if w.Code != http.StatusBadRequest || a.state.TranscriptWidth != "narrow" || len(view.messages) != 0 {
			t.Fatalf("invalid value accepted: %v %d %s", value, w.Code, w.Body.String())
		}
	}
	a.cfg.DataDir = filepath.Join(t.TempDir(), "missing")
	w := postAPI(a, "/api/ui", map[string]any{"key": "transcript-width", "value": "wide"})
	if w.Code != http.StatusBadRequest || a.state.TranscriptWidth != "narrow" || len(view.messages) != 0 {
		t.Fatal("a failed save must not change or broadcast the width")
	}
}

func TestNewViewBridgeIncludesSavedTranscriptWidth(t *testing.T) {
	a := testApp(t)
	a.state.TranscriptWidth = "wide"
	view := newView("chat", "Chat", "test")
	a.views[view.ID] = view
	r := httptest.NewRequest("GET", a.ViewURL+"/view/chat/test/bridge.js", nil)
	w := httptest.NewRecorder()
	a.ViewHandler().ServeHTTP(w, r)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"transcriptWidth":"wide"`) {
		t.Fatalf("new/reloaded views must inherit the saved width: %d %s", w.Code, w.Body.String())
	}
}
