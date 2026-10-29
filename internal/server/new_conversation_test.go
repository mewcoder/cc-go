package server

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"cc-go/internal/host"
)

func prepareChatFixture(t *testing.T, a *App) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node unavailable")
	}
	a.cfg.Node = node
	a.cfg.Claude = filepath.Join(t.TempDir(), "missing-claude")
	a.cfg.ModulesDir, _ = filepath.Abs("../../node_modules")
	if err := a.prepare(context.Background(), fixtureArchive(t)); err != nil {
		t.Fatal(err)
	}
	source := `const vscode = require('vscode');
exports.activate = context => {
  for (const name of ['claude-vscode.editor.open', 'claude-vscode.newConversation']) {
    context.subscriptions.push(vscode.commands.registerCommand(name, () => {
      const panel = vscode.window.createWebviewPanel('claude', 'New chat fixture', 1, {enableScripts:true});
      panel.webview.html = '<html><body>New chat fixture</body></html>';
    }));
  }
};`
	if err := os.WriteFile(filepath.Join(a.prepared.ExtensionPath, "extension.cjs"), []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestGlobalChatWorkspaceAutomaticallyResolvesWithoutPicker(t *testing.T) {
	a := testApp(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	a.SetNative(Native{SelectFolder: func() (string, error) { t.Fatal("global chat opened a folder picker"); return "", nil }})
	current, other := a.state.Workspace, t.TempDir()
	missing := filepath.Join(t.TempDir(), "missing")
	for _, tc := range []struct {
		name    string
		current string
		paths   []string
		want    string
	}{
		{"current before other projects", current, []string{other, current}, current},
		{"removed current", current, []string{other}, other},
		{"missing current", missing, []string{missing, other}, other},
		{"empty list", current, []string{}, home},
		{"all unavailable", missing, []string{missing}, home},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a.state.Workspace, a.state.Workspaces = tc.current, tc.paths
			got, err := a.chooseChatWorkspace("")
			if err != nil || got != tc.want {
				t.Fatalf("got %q, %v; want %q", got, err, tc.want)
			}
		})
	}
	if got, err := a.chooseChatWorkspace(other); err != nil || got != other {
		t.Fatalf("explicit project: %q %v", got, err)
	}
	if _, err := a.chooseChatWorkspace(missing); err == nil {
		t.Fatal("invalid explicit project accepted")
	}
}

func TestGlobalNewChatCreatesViewAndKeepsWorkingSessionInSameWorkspace(t *testing.T) {
	a := testApp(t)
	prepareChatFixture(t, a)
	if err := a.activate(context.Background()); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	workspace, peer, previousView := a.state.Workspace, a.peer, a.active
	a.liveSessions["running"] = LiveSession{Status: "working", Workspace: workspace}
	a.mu.Unlock()
	w := postAPI(a, "/api/new", map[string]any{})
	if w.Code != 200 {
		t.Fatalf("new chat: %d %s", w.Code, w.Body.String())
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.state.Workspace != workspace || a.peer != peer || a.active == previousView || a.liveSessions["running"].Status != "working" || a.state.WorkspaceUsedAt[workspace] == 0 {
		t.Fatal("new chat did not create a view while retaining the current host and running session")
	}
}

func TestGlobalNewChatDoesNotSwitchAwayFromBusyHost(t *testing.T) {
	for _, status := range []string{"working", "needs_input", "pending"} {
		t.Run(status, func(t *testing.T) {
			a := testApp(t)
			workspace := a.state.Workspace
			a.state.Workspaces = []string{t.TempDir()}
			a.phase, a.peer = "active", &host.Peer{}
			t.Cleanup(func() { a.peer = nil })
			if status == "pending" {
				a.views["view"] = newView("view", "New chat", "token")
				a.views["view"].PendingInput = true
			} else {
				a.liveSessions["running"] = LiveSession{Status: status}
			}
			if err := a.newConversation(context.Background(), ""); err == nil || !strings.Contains(err.Error(), "running conversations") {
				t.Fatalf("unsafe switch: %v", err)
			}
			if a.state.Workspace != workspace {
				t.Fatal("busy host changed workspace")
			}
		})
	}
}

func TestGlobalNewChatAutomaticallySwitchesToRegisteredProject(t *testing.T) {
	a := testApp(t)
	prepareChatFixture(t, a)
	if err := a.activate(context.Background()); err != nil {
		t.Fatal(err)
	}
	other := t.TempDir()
	a.mu.Lock()
	a.state.Workspaces = []string{other}
	a.mu.Unlock()
	w := postAPI(a, "/api/new", map[string]any{})
	if w.Code != 200 {
		t.Fatalf("new chat fallback: %d %s", w.Code, w.Body.String())
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.state.Workspace != other || a.phase != "active" || a.active == "" || len(a.state.Workspaces) != 1 {
		t.Fatal("automatic fallback did not open a new chat in the remaining project")
	}
	if len(a.views) != 1 {
		t.Fatalf("workspace switch opened %d blank views instead of one", len(a.views))
	}
}

func TestStartupKeepsRemovedWorkspaceHidden(t *testing.T) {
	a := testApp(t)
	prepareChatFixture(t, a)
	a.state.Workspaces = []string{}
	if err := a.activateChosenWorkspace(context.Background()); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.state.Workspaces) != 0 {
		t.Fatal("activation restored removed project")
	}
}

func TestStartupAutomaticallyReplacesMissingRememberedWorkspace(t *testing.T) {
	a := testApp(t)
	other := t.TempDir()
	a.state.Workspace = filepath.Join(t.TempDir(), "missing")
	a.state.Workspaces = []string{a.state.Workspace, other}
	if err := a.saveLocked(); err != nil {
		t.Fatal(err)
	}
	cfg := a.cfg
	cfg.Workspace = ""
	reloaded, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reloaded.Close)
	prepareChatFixture(t, reloaded)
	if err := reloaded.activateChosenWorkspace(context.Background()); err != nil {
		t.Fatal(err)
	}
	reloaded.mu.Lock()
	defer reloaded.mu.Unlock()
	if reloaded.state.Workspace != other {
		t.Fatalf("activated %q instead of available project", reloaded.state.Workspace)
	}
	cfg.Workspace = a.state.Workspace
	if invalid, err := New(cfg); err == nil {
		invalid.Close()
		t.Fatal("invalid explicit startup project accepted")
	}
}
