package server

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"cc-go/internal/host"
)

func selectionFixture(t *testing.T) *App {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node unavailable")
	}
	a := testApp(t)
	a.cfg.Node = node
	a.cfg.Claude = filepath.Join(t.TempDir(), "missing-claude")
	a.cfg.ModulesDir, _ = filepath.Abs("../../node_modules")
	if err := a.prepare(context.Background(), fixtureArchive(t)); err != nil {
		t.Fatal(err)
	}
	if err := a.activate(context.Background()); err != nil {
		t.Fatal(err)
	}
	return a
}

func initSelectionRepo(t *testing.T, directory string) {
	t.Helper()
	for _, args := range [][]string{
		{"init", "-b", "main"},
		{"-c", "user.name=Selection Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture"},
		{"branch", "feature/test"},
	} {
		if out, err := selectionGit(context.Background(), directory, args...); err != nil {
			t.Fatalf("git %v: %s %v", args, out, err)
		}
	}
}

func TestSelectionAdmissionRejectsHistoryBusyStaleAndPendingInput(t *testing.T) {
	a := testApp(t)
	a.phase, a.active, a.peer = "active", "view", &host.Peer{}
	t.Cleanup(func() { a.peer = nil })
	a.views[a.active] = newView(a.active, "New conversation", "token")
	check := func(want bool) {
		t.Helper()
		if got := a.selectionErrorLocked(a.active, a.state.Workspace) == nil; got != want {
			t.Fatalf("selection allowed=%v, want %v", got, want)
		}
	}
	check(true)
	a.activeSessionID = regressionSessionID
	check(false)
	a.activeSessionID = ""
	a.views[a.active].Started = true
	check(false)
	a.views[a.active].Started = false
	a.views["other"] = &View{PendingInput: true}
	check(false)
	delete(a.views, "other")
	a.liveSessions["other"] = LiveSession{Status: "working"}
	check(false)
	a.liveSessions["other"] = LiveSession{Status: "needs_input"}
	check(false)
	delete(a.liveSessions, "other")
	a.selecting = true
	check(false)
	a.selecting = false
	if a.selectionErrorLocked("stale-view", a.state.Workspace) == nil || a.selectionErrorLocked(a.active, t.TempDir()) == nil {
		t.Fatal("stale view/workspace was accepted")
	}
	check(true)
}

func TestLocalBranchOptionsIncludeUnbornAndDetectUntrackedFiles(t *testing.T) {
	directory := t.TempDir()
	ctx := context.Background()
	if _, err := selectionGit(ctx, directory, "init", "-b", "main"); err != nil {
		t.Fatal(err)
	}
	options, err := readBranchOptions(ctx, directory)
	if err != nil || len(options.Branches) != 1 || options.Branches[0] != "main" || options.Current != "main" || options.Dirty {
		t.Fatalf("unborn branch: %+v %v", options, err)
	}
	if err := os.WriteFile(filepath.Join(directory, "untracked.txt"), []byte("keep me"), 0600); err != nil {
		t.Fatal(err)
	}
	options, err = readBranchOptions(ctx, directory)
	if err != nil || !options.Dirty || options.Files != 1 || options.Untracked != 1 {
		t.Fatal("untracked files must block a switch", err)
	}
	if err := os.Mkdir(filepath.Join(directory, "nested"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"one.txt", "two.txt"} {
		if err := os.WriteFile(filepath.Join(directory, "nested", name), []byte("new"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	options, err = readBranchOptions(ctx, directory)
	if err != nil || options.Files != 3 || options.Untracked != 3 {
		t.Fatalf("untracked directories must count files: %+v %v", options, err)
	}
	if _, err := selectionGit(ctx, directory, "add", "untracked.txt"); err != nil {
		t.Fatal(err)
	}
	options, err = readBranchOptions(ctx, directory)
	if err != nil || options.Files != 3 || options.Untracked != 2 {
		t.Fatalf("staged and untracked counts: %+v %v", options, err)
	}
}

func TestBranchCountsPreserveUnstagedStatusPrefix(t *testing.T) {
	directory := t.TempDir()
	initSelectionRepo(t, directory)
	ctx := context.Background()
	filename := filepath.Join(directory, "file.txt")
	if err := os.WriteFile(filename, []byte("original\n"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{
		{"add", "file.txt"},
		{"-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "file"},
	} {
		if _, err := selectionGit(ctx, directory, args...); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filename, []byte("modified\n"), 0600); err != nil {
		t.Fatal(err)
	}
	options, err := readBranchOptions(ctx, directory)
	if err != nil || !options.Dirty || options.Files != 1 || options.Untracked != 0 {
		t.Fatalf("unstaged count: %+v %v", options, err)
	}
}

func TestBranchSwitchSafetyAndHostRestart(t *testing.T) {
	a := selectionFixture(t)
	directory := a.state.Workspace
	initSelectionRepo(t, directory)
	id := a.active
	ctx := context.Background()
	if err := os.WriteFile(filepath.Join(directory, "draft.txt"), []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := a.selectBranch(ctx, id, directory, "feature/test"); err == nil || !strings.Contains(err.Error(), "uncommitted") {
		t.Fatal("dirty switch was not blocked:", err)
	}
	if info := readProject(directory); info.Branch != "main" {
		t.Fatal("dirty working tree was switched")
	}
	if err := os.Remove(filepath.Join(directory, "draft.txt")); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []string{"--detach", "missing", ""} {
		if err := a.selectBranch(ctx, id, directory, invalid); err == nil {
			t.Fatal("invalid/missing branch was accepted:", invalid)
		}
	}
	marker := filepath.Join(t.TempDir(), "hook-ran")
	if runtime.GOOS != "windows" {
		if err := os.WriteFile(filepath.Join(directory, ".git", "hooks", "post-checkout"), []byte("#!/bin/sh\necho ran > '"+marker+"'\n"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := a.selectBranch(ctx, id, directory, "feature/test"); err != nil {
		t.Fatal(err)
	}
	if info := a.project.get(directory); info.Branch != "feature/test" {
		t.Fatalf("wrong branch after restart: %+v", info)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("repository checkout hook was executed")
	}
	worktree := filepath.Join(t.TempDir(), "linked")
	if _, err := selectionGit(ctx, directory, "-c", "core.hooksPath="+t.TempDir(), "worktree", "add", worktree, "main"); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	currentView := a.active
	a.mu.Unlock()
	if err := a.selectBranch(ctx, currentView, directory, "main"); err == nil {
		t.Fatal("must not steal a branch checked out in another worktree")
	}
	if info := readProject(directory); info.Branch != "feature/test" {
		t.Fatal("failed switch changed the branch")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.phase != "active" || a.peer == nil || a.active == id || a.selecting || a.activeSessionID != "" {
		t.Fatal("branch switch did not reopen a clean new conversation")
	}
}

func TestProjectSelectorPreservesSameProjectAndNativeCancellation(t *testing.T) {
	a := selectionFixture(t)
	id, directory := a.active, a.state.Workspace
	ctx := context.Background()
	if err := a.selectProject(ctx, id, directory, directory); err != nil || a.active != id {
		t.Fatal("same project must not restart the host", err)
	}
	a.native.SelectFolder = func() (string, error) { return "", nil }
	if err := a.selectProject(ctx, id, directory, ""); err != nil || a.active != id {
		t.Fatal("cancelled folder picker changed the project", err)
	}
	other := t.TempDir()
	if err := a.selectProject(ctx, id, directory, other); err != nil {
		t.Fatal(err)
	}
	if a.state.Workspace != other || a.active == id || a.activeSessionID != "" {
		t.Fatal("project selection did not start a new conversation in the selected project")
	}
}

func TestIncomingInputAndHistoryLockSelectorsBeforeSDKSessionAssignment(t *testing.T) {
	a := selectionFixture(t)
	id := a.active
	if err := a.receiveViewMessage(id, json.RawMessage(`{"type":"io_message","message":{"type":"user"}}`)); err != nil {
		t.Fatal(err)
	}
	if !a.views[id].Started || !a.views[id].PendingInput || a.selectionErrorLocked(id, a.state.Workspace) == nil {
		t.Fatal("input did not immediately lock project selection")
	}
	// A new blank channel resets the historical marker, but not pending work.
	if err := a.receiveViewMessage(id, json.RawMessage(`{"type":"launch_claude","channelId":"new"}`)); err != nil {
		t.Fatal(err)
	}
	if a.selectionErrorLocked(id, a.state.Workspace) == nil {
		t.Fatal("pending request was lost during new-channel launch")
	}
	a.views[id].PendingInput = false
	if err := a.receiveViewMessage(id, json.RawMessage(`{"type":"request","request":{"type":"get_session_request"}}`)); err != nil {
		t.Fatal(err)
	}
	if a.selectionErrorLocked(id, a.state.Workspace) == nil {
		t.Fatal("history restore was accepted as an empty conversation")
	}
	a.selecting = true
	if err := a.receiveViewMessage(id, json.RawMessage(`{"type":"io_message","message":{"type":"user"}}`)); err == nil {
		t.Fatal("input raced through a project/branch switch")
	}
	a.selecting = false
}

func TestNavigationRejectsConcurrentSelection(t *testing.T) {
	a := testApp(t)
	a.selecting = true
	for _, endpoint := range []string{"new", "open-session", "select", "close", "workspace"} {
		r := httptest.NewRequest("POST", a.ShellURL+"/api/"+endpoint, strings.NewReader(`{}`))
		r.Header.Set("X-Claude-Desktop-Token", a.token)
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, r)
		if w.Code != 409 {
			t.Fatal("navigation was not blocked during switch:", endpoint, w.Code)
		}
	}
}

func TestSelectionAssetsAreServedBeforeDesktopWithoutRemovingHistory(t *testing.T) {
	a := testApp(t)
	for _, path := range []string{"/", "/selection.js"} {
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, httptest.NewRequest("GET", a.ShellURL+path, nil))
		if w.Code != 200 {
			t.Fatal("missing selector asset", path, w.Code)
		}
		body := w.Body.String()
		if path == "/" {
			if !strings.Contains(body, "selection.js") || !strings.Contains(body, "history.js") || strings.Index(body, "selection.js") > strings.Index(body, "desktop.js") {
				t.Fatal("selector load order or history integration changed")
			}
		} else if !strings.Contains(body, "window.goSelection") {
			t.Fatal("selector source not served")
		}
	}
}
