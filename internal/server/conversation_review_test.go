package server

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

func TestAllWorkspaceEntryPointsPreserveRunningConversations(t *testing.T) {
	for _, route := range []string{"/api/workspace", "/api/open-session", "/api/new"} {
		for _, status := range []string{"working", "needs_input", "pending"} {
			t.Run(route+"/"+status, func(t *testing.T) {
				a := testApp(t)
				prepareChatFixture(t, a)
				if err := a.activate(context.Background()); err != nil {
					t.Fatal(err)
				}
				a.mu.Lock()
				workspace, peer, active := a.state.Workspace, a.peer, a.active
				if status == "pending" {
					a.views[active].PendingInput = true
				} else {
					a.liveSessions["run"] = LiveSession{Status: status, Workspace: workspace}
				}
				a.mu.Unlock()
				other := t.TempDir()
				w := postAPI(a, route, map[string]any{"path": other, "workspace": other, "id": regressionSessionID})
				if w.Code != 400 || !strings.Contains(w.Body.String(), "running conversations") {
					t.Fatalf("unsafe workspace action: %d %s", w.Code, w.Body.String())
				}
				a.mu.Lock()
				defer a.mu.Unlock()
				if a.state.Workspace != workspace || a.peer != peer || a.active != active || a.phase != "active" {
					t.Fatal("rejected action changed the workspace or running host")
				}
			})
		}
	}
}

func TestConversationActionsRespectOperationLock(t *testing.T) {
	a := testApp(t)
	prepareChatFixture(t, a)
	if err := a.activate(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, route := range []string{"/api/new", "/api/open-session", "/api/select", "/api/close"} {
		t.Run(route, func(t *testing.T) {
			a.mu.Lock()
			active := a.active
			a.mu.Unlock()
			id := active
			if route == "/api/open-session" {
				id = regressionSessionID
			}
			a.opMu.Lock()
			w := postAPI(a, route, map[string]any{"id": id})
			a.opMu.Unlock()
			if w.Code != 400 || !strings.Contains(w.Body.String(), "in progress") {
				t.Fatalf("operation was not serialized: %d %s", w.Code, w.Body.String())
			}
		})
	}
}

func TestViewSelectionKeepsSessionIdentityAndMetricsWithEachView(t *testing.T) {
	a := testApp(t)
	const second = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
	event := func(method string, value any) {
		data, _ := json.Marshal(value)
		a.hostEvent(a.hostGeneration, method, data)
	}
	event("webview.create", map[string]any{"id": "one", "resourceToken": "one"})
	event("host.selection", map[string]any{"id": "one", "sessionId": regressionSessionID})
	tokens := 100.0
	event("host.metrics", map[string]any{"id": "one", "sessionId": regressionSessionID, "metrics": SessionMetrics{ContextTokens: &tokens}})
	event("webview.create", map[string]any{"id": "two", "resourceToken": "two"})
	if got := a.snapshot()["activeSessionId"]; got != "" {
		t.Fatalf("blank view inherited the previous session: %v", got)
	}
	if got := a.snapshot()["sessionMetrics"].(SessionMetrics); got.ContextTokens != nil {
		t.Fatal("blank view inherited another view's context usage")
	}
	event("webview.focus", map[string]any{"id": "one"})
	if got := a.snapshot()["activeSessionId"]; got != regressionSessionID {
		t.Fatalf("focus did not restore the original session: %v", got)
	}
	event("host.selection", map[string]any{"id": "two", "sessionId": second})
	if got := a.snapshot()["activeSessionId"]; got != regressionSessionID {
		t.Fatal("inactive view overwrote the current session")
	}
	event("webview.focus", map[string]any{"id": "two"})
	if got := a.snapshot()["activeSessionId"]; got != second {
		t.Fatalf("inactive session identity was lost: %v", got)
	}
	event("webview.dispose", map[string]any{"id": "two"})
	if a.activeSessionID != "" {
		t.Fatal("disposed view left stale HUD/session identity")
	}
}

func TestEmptyHistoryImportPreservesExplicitlyEmptySidebar(t *testing.T) {
	a := testApp(t)
	if err := a.removeWorkspace(a.state.Workspace); err != nil {
		t.Fatal(err)
	}
	if err := a.importProjects([]string{}); err != nil {
		t.Fatal(err)
	}
	reloaded, err := New(a.cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer reloaded.Close()
	if reloaded.state.Workspaces == nil || len(reloaded.state.Workspaces) != 0 {
		t.Fatal("empty import restored a removed project on restart")
	}
}

func TestWorkspaceSaveFailureKeepsCurrentHostAndMembership(t *testing.T) {
	a := testApp(t)
	prepareChatFixture(t, a)
	if err := a.activate(context.Background()); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	workspace, peer, active := a.state.Workspace, a.peer, a.active
	view := a.views[active]
	a.cfg.DataDir = filepath.Join(t.TempDir(), "missing")
	a.mu.Unlock()
	if err := a.switchWorkspace(context.Background(), t.TempDir()); err == nil {
		t.Fatal("expected save failure")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.state.Workspace != workspace || len(a.state.Workspaces) != 1 || a.state.Workspaces[0] != workspace || a.peer != peer || a.active != active || a.phase != "active" || a.stopping {
		t.Fatal("failed save tore down the existing host or changed in-memory state")
	}
	select {
	case <-view.done:
		t.Fatal("failed save closed the existing view")
	default:
	}
}

func TestHiddenDraftBlocksHostReplacementButAllowsSameProjectNewChat(t *testing.T) {
	a := testApp(t)
	prepareChatFixture(t, a)
	if err := a.activate(context.Background()); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	workspace, peer, draftID := a.state.Workspace, a.peer, a.active
	a.mu.Unlock()
	if err := a.newConversation(context.Background(), workspace); err != nil {
		t.Fatal(err)
	}
	if w := postAPI(a, "/api/view-draft", map[string]any{"id": draftID, "draft": true}); w.Code != 200 {
		t.Fatalf("draft update: %d %s", w.Code, w.Body.String())
	}
	if a.snapshot()["canSelectProject"] != false {
		t.Fatal("selector ignored a draft in a background view")
	}
	a.mu.Lock()
	active := a.active
	a.mu.Unlock()
	other := t.TempDir()
	for _, route := range []string{"/api/workspace", "/api/open-session", "/api/new", "/api/select-project", "/api/select-branch", "/api/retry", "/api/import", "/api/close"} {
		id := active
		if route == "/api/open-session" {
			id = regressionSessionID
		} else if route == "/api/close" {
			id = draftID
		}
		target := other
		if route == "/api/select-project" || route == "/api/select-branch" {
			target = workspace
		}
		w := postAPI(a, route, map[string]any{"id": id, "path": other, "workspace": target, "branch": "other"})
		if w.Code != 400 || !strings.Contains(w.Body.String(), "draft") {
			t.Fatalf("%s discarded an unsent draft: %d %s", route, w.Code, w.Body.String())
		}
	}
	if err := a.newConversation(context.Background(), workspace); err != nil {
		t.Fatal("same-project new chat should retain drafts in existing views:", err)
	}
	a.mu.Lock()
	if a.peer != peer || a.state.Workspace != workspace || !a.views[draftID].HasDraft {
		t.Fatal("draft guard changed the workspace, host or background draft")
	}
	a.mu.Unlock()
	if w := postAPI(a, "/api/view-draft", map[string]any{"id": draftID, "draft": false}); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if a.snapshot()["canSelectProject"] != true {
		t.Fatal("clearing the draft did not unlock project selection")
	}
	for _, args := range []map[string]any{{"id": draftID}, {"id": "stale", "draft": false}} {
		if w := postAPI(a, "/api/view-draft", args); w.Code != 400 {
			t.Fatalf("invalid draft state accepted: %d", w.Code)
		}
	}
}
