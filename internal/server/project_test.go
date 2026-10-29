package server

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"cc-go/internal/sessions"
)

func readTestProject(t *testing.T, directory string) ProjectInfo {
	t.Helper()
	// Verify Git results independently of the UI's short, best-effort polling budget.
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	return readProjectContext(ctx, directory)
}

func TestProjectGitBranchDetachedAndNonRepository(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git unavailable")
	}
	directory := t.TempDir()
	if info := readTestProject(t, directory); info.GitStatus != "none" || info.Path != directory || info.Name != filepath.Base(directory) {
		t.Fatalf("non-repository: %+v", info)
	}
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", directory}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	git("init", "-b", "hud-test")
	if info := readTestProject(t, directory); info.GitStatus != "branch" || info.Branch != "hud-test" {
		t.Fatalf("unborn branch: %+v", info)
	}
	git("-c", "user.name=HUD Test", "-c", "user.email=hud@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture")
	git("checkout", "--detach")
	if info := readTestProject(t, directory); info.GitStatus != "detached" || len(info.Branch) < 7 {
		t.Fatalf("detached: %+v", info)
	}
	git("checkout", "-b", "feature/hud")
	worktree := filepath.Join(t.TempDir(), "worktree")
	git("worktree", "add", "-b", "linked-hud", worktree)
	// Git environment from an embedding process must not point the HUD at another repository.
	t.Setenv("GIT_DIR", filepath.Join(directory, ".git"))
	if info := readTestProject(t, worktree); info.GitStatus != "branch" || info.Branch != "linked-hud" {
		t.Fatalf("linked worktree: %+v", info)
	}
}

func TestProjectCacheChangesWorkspaceAndRefreshesBranch(t *testing.T) {
	var cache projectCache
	first, second := t.TempDir(), t.TempDir()
	if cache.get(first).Path != first || cache.get(second).Path != second {
		t.Fatal("project cache reused a different workspace")
	}
	cache.info.Branch = "stale"
	cache.info.GitStatus = "branch"
	cache.at = cache.at.Add(-4 * time.Second)
	if info := cache.get(second); info.Path != second || info.Branch != "" {
		t.Fatal("cache did not refresh")
	}
}

func TestProjectGitChanges(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git unavailable")
	}
	directory := t.TempDir()
	hooks := t.TempDir()
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", directory, "-c", "core.hooksPath=" + hooks, "-c", "core.autocrlf=false"}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	write := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(directory, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	check := func(want GitChanges) {
		t.Helper()
		info := readTestProject(t, directory)
		if info.Changes == nil || !reflect.DeepEqual(*info.Changes, want) {
			t.Fatalf("changes: %+v, want %+v", info.Changes, want)
		}
	}
	git("init", "-b", "main")
	check(GitChanges{})
	write("initial.txt", "one\ntwo\n")
	check(GitChanges{Files: 1, Untracked: 1, Added: 2})
	git("add", "initial.txt")
	check(GitChanges{Files: 1, Added: 2})
	git("-c", "user.name=HUD Test", "-c", "user.email=hud@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "initial")
	check(GitChanges{})
	write("initial.txt", "one\nreplaced\nthird\n")
	git("add", "initial.txt")
	write("initial.txt", "one\nreplaced\nthird\nfourth\n")
	write("new\tname\n.txt", "untracked lines\ncounted too\n")
	write(".gitignore", "ignored.txt\n")
	write("ignored.txt", "ignored\n")
	check(GitChanges{Files: 3, Untracked: 2, Added: 6, Deleted: 1})
	git("add", "initial.txt", ".gitignore")
	git("-c", "user.name=HUD Test", "-c", "user.email=hud@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "updated")
	git("mv", "initial.txt", "renamed\tfile\n.txt")
	check(GitChanges{Files: 2, Untracked: 1, Added: 2})
	write("renamed\tfile\n.txt", "one\nreplaced\nthird\nfourth\nfifth\n")
	check(GitChanges{Files: 2, Untracked: 1, Added: 3})
	write("binary.dat", "\x00binary old")
	git("add", "binary.dat")
	git("-c", "user.name=HUD Test", "-c", "user.email=hud@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "binary and rename")
	write("binary.dat", "\x00binary new")
	check(GitChanges{Files: 3, Untracked: 1, Added: 3, Binary: 1})
	git("checkout", "--detach")
	check(GitChanges{Files: 3, Untracked: 1, Added: 3, Binary: 1})
}

func TestGitChangesFailureIsUnknown(t *testing.T) {
	got := readGitChanges(context.Background(), func(...string) (string, error) { return "", os.ErrPermission })
	if got != nil {
		t.Fatal("failed git status must not appear clean")
	}
}

func TestUntrackedTextBinaryAttributesAndSubdirectory(t *testing.T) {
	directory := t.TempDir()
	initSelectionRepo(t, directory)
	files := map[string]string{
		".gitattributes": "*.bin -diff\n*.forced diff\n",
		"empty.txt":      "",
		"crlf.txt":       "one\r\ntwo",
		"long.txt":       strings.Repeat("a", 100000) + "\nlast line",
		"binary.dat":     "\x00binary\nnot lines\n",
		"looks-text.bin": "one\ntwo\n",
		"nul.forced":     "one\x00\nsecond",
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(directory, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	want := GitChanges{Files: 7, Untracked: 7, Added: 8, Binary: 2}
	embedded := filepath.Join(directory, "embedded")
	if err := os.Mkdir(embedded, 0700); err != nil {
		t.Fatal(err)
	}
	initSelectionRepo(t, embedded)
	if err := os.WriteFile(filepath.Join(embedded, "inside.txt"), []byte(strings.Repeat("not our repository\n", 100)), 0600); err != nil {
		t.Fatal(err)
	}
	want.Files++
	want.Untracked++
	target := filepath.Join(t.TempDir(), "outside.txt")
	if err := os.WriteFile(target, []byte(strings.Repeat("outside\n", 100)), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(directory, "link")); err == nil {
		want.Files++
		want.Untracked++
		want.Added++
	}
	subdir := filepath.Join(directory, "nested")
	if err := os.Mkdir(subdir, 0700); err != nil {
		t.Fatal(err)
	}
	indexPath := filepath.Join(directory, ".git", "index")
	before, err := os.ReadFile(indexPath)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	for _, cwd := range []string{directory, subdir} {
		info := readTestProject(t, cwd)
		if info.Changes == nil || !reflect.DeepEqual(*info.Changes, want) {
			t.Fatalf("changes from %s: %+v, want %+v", cwd, info.Changes, want)
		}
	}
	after, err := os.ReadFile(indexPath)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("HUD changed the Git index")
	}
}

func TestNewFileLineCountCancellationAndGitBinaryProbe(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "file.txt")
	content := strings.Repeat("a", 8000) + "\x00\nlast"
	if err := os.WriteFile(filename, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	lines, binary, err := countNewFileLines(context.Background(), filename, "unspecified")
	if err != nil || binary || lines != 2 {
		t.Fatalf("NUL after Git probe: lines=%d binary=%v err=%v", lines, binary, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := countNewFileLines(ctx, filename, "unspecified"); err != context.Canceled {
		t.Fatalf("cancellation: %v", err)
	}
}

func TestCancelledProjectReadDoesNotReportCleanGitState(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	directory := t.TempDir()
	info := readProjectContext(ctx, directory)
	if info.Path != directory || info.GitStatus != "unknown" || info.Changes != nil {
		t.Fatalf("cancelled Git read appeared complete: %+v", info)
	}
}

func TestSessionMetricsSnapshotIsScopedAndDropsStaleHostEvents(t *testing.T) {
	a := testApp(t)
	a.views["view"] = newView("view", "Chat", "token")
	a.active = "view"
	a.activeSessionID = regressionSessionID
	emit := func(generation uint64, view, id string, input float64) {
		t.Helper()
		b, _ := json.Marshal(map[string]any{"id": view, "sessionId": id, "metrics": map[string]any{"inputTokens": input, "outputTokens": 0}})
		a.hostEvent(generation, "host.metrics", b)
	}
	emit(a.hostGeneration, "view", regressionSessionID, 123)
	m := a.snapshot()["sessionMetrics"].(SessionMetrics)
	if m.InputTokens == nil || *m.InputTokens != 123 || m.OutputTokens == nil || *m.OutputTokens != 0 || m.ContextWindow != nil {
		t.Fatalf("missing and zero counters: %+v", m)
	}
	emit(a.hostGeneration+1, "view", regressionSessionID, 999)
	emit(a.hostGeneration, "disposed", regressionSessionID, 999)
	if *a.metrics[sessions.Key(a.state.Workspace, regressionSessionID)].InputTokens != 123 {
		t.Fatal("stale or disposed host event overwrote usage")
	}
	a.activeSessionID = "another-session"
	if a.snapshot()["sessionMetrics"].(SessionMetrics).InputTokens != nil {
		t.Fatal("usage leaked to another conversation")
	}
	a.activeSessionID = regressionSessionID
	a.state.Workspace = t.TempDir()
	if a.snapshot()["sessionMetrics"].(SessionMetrics).InputTokens != nil {
		t.Fatal("usage leaked to another workspace")
	}
	a.detachHostLocked()
	if len(a.metrics) != 0 {
		t.Fatal("host restart retained stale usage")
	}
}

func TestMetricsTravelThroughRealNodeHostToSnapshot(t *testing.T) {
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
	// Only replace the extracted test fixture, never an installed Anthropic extension.
	source := `const vscode = require('vscode');
exports.activate = context => {
  context.subscriptions.push(vscode.commands.registerCommand('claude-vscode.editor.open', () => {
    const panel = vscode.window.createWebviewPanel('claude', 'Metrics fixture', 1, {enableScripts:true});
    panel.webview.html = '<html><body>Metrics fixture</body></html>';
    panel.webview.onDidReceiveMessage(async message => {
      if (message.request?.type === 'get_context_usage') {
        await panel.webview.postMessage({type:'from-extension', message:{type:'response', requestId:message.requestId,
          response:{type:'get_context_usage_response', usage:{model:'model-a', totalTokens:1400, rawMaxTokens:200000}}}});
        return;
      }
      if (message.type !== 'launch_claude') return;
      for (const entry of [
        {type:'system', subtype:'init', session_id:message.resume, model:'model-a'},
        {type:'assistant', message:{model:'model-a', usage:{input_tokens:100, output_tokens:20, cache_read_input_tokens:800, cache_creation_input_tokens:100}}},
        {type:'result', subtype:'success'}
      ]) await panel.webview.postMessage({type:'from-extension', message:{type:'io_message', channelId:message.channelId, message:entry}});
    });
  }));
};`
	if err := os.WriteFile(filepath.Join(a.prepared.ExtensionPath, "extension.cjs"), []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
	if err := a.activate(context.Background()); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	peer, view := a.peer, a.active
	a.mu.Unlock()
	for _, message := range []any{
		map[string]any{"type": "launch_claude", "channelId": "channel", "resume": regressionSessionID},
		map[string]any{"type": "request", "requestId": "selection", "request": map[string]any{"type": "update_session_state", "sessionId": regressionSessionID, "state": "idle", "idConfirmed": true}},
	} {
		if err := peer.Notify("webview.receive", map[string]any{"id": view, "message": message}); err != nil {
			t.Fatal(err)
		}
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		m := a.snapshot()["sessionMetrics"].(SessionMetrics)
		if m.ContextWindow != nil && m.ContextTokens != nil && *m.ContextTokens == 1400 && *m.ContextWindow == 200000 {
			if m.ContextWindowSource != "native" {
				t.Fatalf("incorrect window provenance: %+v", m)
			}
			if *m.CacheReadTokens != 800 || *m.InputTokens != 100 || *m.OutputTokens != 20 {
				t.Fatalf("incorrect usage: %+v", m)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("metrics did not reach the state API through the real Node protocol")
}
