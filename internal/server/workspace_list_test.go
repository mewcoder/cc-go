package server

import (
	"net/http"
	"path/filepath"
	"testing"
)

func TestWorkspaceListCollapsePersistsWithoutChangingConversations(t *testing.T) {
	a := testApp(t)
	view := newView("chat", "Chat", "test")
	view.HasDraft = true
	a.views[view.ID] = view
	a.active = view.ID
	if a.snapshot()["workspaceListCollapsed"] != false {
		t.Fatal("workspace list must default to expanded")
	}
	for _, collapsed := range []bool{true, false} {
		w := postAPI(a, "/api/ui", map[string]any{"key": "workspace-list", "collapsed": collapsed})
		if w.Code != http.StatusOK || a.snapshot()["workspaceListCollapsed"] != collapsed {
			t.Fatalf("collapse failed: %d %s", w.Code, w.Body.String())
		}
		if a.active != view.ID || !view.HasDraft || view.Revision != 0 || a.peer != nil {
			t.Fatal("collapsing a section must not affect conversations or launch the host")
		}
		restored, err := New(a.cfg)
		if err != nil {
			t.Fatal(err)
		}
		if restored.state.WorkspaceListCollapsed != collapsed {
			t.Fatal("section state did not survive application restart")
		}
		restored.Close()
	}
	a.cfg.DataDir = filepath.Join(t.TempDir(), "missing")
	w := postAPI(a, "/api/ui", map[string]any{"key": "workspace-list", "collapsed": true})
	if w.Code != http.StatusBadRequest || a.state.WorkspaceListCollapsed {
		t.Fatal("failed save must roll back the section preference")
	}
}
