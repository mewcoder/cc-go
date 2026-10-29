package server

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
)

func TestGitWatchFiltersLockAndMetadataDirectoryTimestampEvents(t *testing.T) {
	for _, tc := range []struct {
		name              string
		op                fsnotify.Op
		metadata, selfGit bool
		ignore            bool
	}{
		{"index.lock", fsnotify.Create, true, false, true},
		{"index.lock", fsnotify.Write, true, false, true},
		{".git", fsnotify.Write, false, true, true},
		{".git", fsnotify.Chmod, false, true, true},
		{".git", fsnotify.Create, false, true, false},
		{".git", fsnotify.Remove, false, true, false},
		{"HEAD", fsnotify.Write, true, false, false},
		{"index", fsnotify.Create, true, false, false},
		{"src", fsnotify.Write, false, false, false},
	} {
		if got := ignoredGitWatchEvent(fsnotify.Event{Name: tc.name, Op: tc.op}, tc.metadata, tc.selfGit); got != tc.ignore {
			t.Errorf("%s/%s: ignored=%v, want %v", tc.name, tc.op, got, tc.ignore)
		}
	}
}

func watchRepository(t *testing.T) (string, func(...string), func(string, string)) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	git := func(args ...string) {
		t.Helper()
		if out, err := gitCommand(t.Context(), root, args...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	write := func(name, text string) {
		t.Helper()
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}
	git("init", "-b", "watch-test")
	return root, git, write
}

func waitWatchRevision(t *testing.T, cache *projectCache, previous uint64) {
	t.Helper()
	deadline := time.Now().Add(9 * time.Second)
	for time.Now().Before(deadline) {
		if cache.revision() > previous {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("native file change did not invalidate Git")
}

func TestGitNativeWatchExternalEditsDebounceCooldownAndIdle(t *testing.T) {
	t.Parallel()
	root, git, write := watchRepository(t)
	write("src/file.txt", "one\n")
	git("add", ".")
	var cache projectCache
	t.Cleanup(cache.close)
	if info := cache.get(root); info.WatchError != "" {
		t.Fatal(info.WatchError)
	}
	before := cache.revision()
	for i := 0; i < 20; i++ {
		write("src/file.txt", strings.Repeat("external\n", i+1))
	}
	waitWatchRevision(t, &cache, before)
	first := time.Now()
	if got := cache.revision(); got != before+1 {
		t.Fatalf("file burst was not merged: %d -> %d", before, got)
	}
	if info := cache.get(root); info.Changes == nil || info.Changes.Added != 20 {
		t.Fatalf("external edit did not update status: %+v", info)
	}
	before = cache.revision()
	write("src/file.txt", "next\n")
	time.Sleep(1500 * time.Millisecond)
	if cache.revision() != before {
		t.Fatal("automatic refresh ignored cooldown")
	}
	waitWatchRevision(t, &cache, before)
	if time.Since(first) < 4500*time.Millisecond {
		t.Fatal("native change invalidations were not rate limited")
	}
	before = cache.revision()
	time.Sleep(5500 * time.Millisecond)
	if cache.revision() != before {
		t.Fatal("idle watcher triggered a periodic refresh")
	}
}

func TestGitWatchDirectoryCoverageAndWorktreeMetadata(t *testing.T) {
	t.Parallel()
	root, git, write := watchRepository(t)
	write(".gitignore", "ignored/\n")
	write("ignored/tracked/file", "tracked\n")
	write("ignored/dependencies/file", "ignored\n")
	write("src/file", "source\n")
	if err := os.MkdirAll(filepath.Join(root, "empty", "nested"), 0700); err != nil {
		t.Fatal(err)
	}
	git("add", ".")
	git("add", "-f", "ignored/tracked/file")
	git("-c", "user.name=Watch Test", "-c", "user.email=watch@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture")
	w, err := newProjectWatcher(func() {})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.close)
	w.sync(t.Context(), root)
	if warning := w.warning(); warning != "" {
		t.Fatal(warning)
	}
	has := func(path string) bool {
		for _, dir := range w.fs.WatchList() {
			if dir == path {
				return true
			}
		}
		return false
	}
	for _, name := range []string{"src", "empty/nested", "ignored/tracked", ".git", ".git/refs/heads", ".git/info"} {
		if !has(filepath.Join(root, filepath.FromSlash(name))) {
			t.Fatalf("missing directory watch: %s", name)
		}
	}
	for _, name := range []string{"ignored/dependencies", ".git/objects", ".git/logs", ".git/hooks"} {
		if has(filepath.Join(root, filepath.FromSlash(name))) {
			t.Fatalf("unnecessary directory watch: %s", name)
		}
	}
	linked := filepath.Join(t.TempDir(), "linked")
	git("worktree", "add", "-b", "linked", linked)
	linked, _ = filepath.EvalSymlinks(linked)
	w.mu.Lock()
	w.dirty = true
	w.mu.Unlock()
	w.sync(t.Context(), linked)
	gitdir, err := os.ReadFile(filepath.Join(linked, ".git"))
	if err != nil {
		t.Fatal(err)
	}
	actual := strings.TrimSpace(strings.TrimPrefix(string(gitdir), "gitdir: "))
	actual, err = filepath.EvalSymlinks(filepath.Clean(actual))
	if err != nil {
		t.Fatal(err)
	}
	if !has(actual) || !has(filepath.Join(root, ".git")) || !has(filepath.Join(root, ".git", "refs", "heads")) {
		t.Fatalf("worktree HEAD/index and common refs must both be watched: gitdir=%q watches=%q", actual, w.fs.WatchList())
	}
	if has(filepath.Join(root, "src")) {
		t.Fatal("workspace switch retained the old worktree watcher")
	}
}

func TestGitWatchNewDirectoriesIgnoreRuleChangesAndIndexLocks(t *testing.T) {
	t.Parallel()
	root, _, write := watchRepository(t)
	write(".gitignore", "ignored/\n")
	write("ignored/nested/file", "ignored\n")
	var cache projectCache
	t.Cleanup(cache.close)
	watcher, err := newProjectWatcher(cache.invalidate)
	if err != nil {
		t.Fatal(err)
	}
	events := make(chan string, 100)
	watcher.mu.Lock()
	watcher.observe = func(event fsnotify.Event, metadata, selfGit, ignored bool) {
		select {
		case events <- fmt.Sprintf("%s %q parentGit=%v selfGit=%v ignored=%v", event.Op, event.Name, metadata, selfGit, ignored):
		default:
		}
	}
	watcher.mu.Unlock()
	cache.watcher, cache.watchPath = watcher, root
	cache.get(root)
	before := cache.revision()
	write(".git/index.lock", "lock")
	time.Sleep(1300 * time.Millisecond)
	if cache.revision() != before {
		var observed []string
		for len(events) > 0 {
			observed = append(observed, <-events)
		}
		t.Fatalf("Git index lock must not trigger status: warning=%s watches=%q events=%q", watcher.warning(), watcher.fs.WatchList(), observed)
	}
	write("new/deep/file", "new\n")
	waitWatchRevision(t, &cache, before)
	cache.get(root)
	before = cache.revision()
	write("new/deep/file", "new\nsecond\n")
	waitWatchRevision(t, &cache, before)
	if info := cache.get(root); info.Changes == nil || info.Changes.Untracked != 2 {
		t.Fatalf("new nested directory was not observed: %+v", info)
	}
	before = cache.revision()
	write(".gitignore", "")
	waitWatchRevision(t, &cache, before)
	cache.get(root)
	before = cache.revision()
	write("ignored/nested/file", "now visible\n")
	waitWatchRevision(t, &cache, before)
	cache.get(root)
	cache.close()
	// Cache shutdown is idempotent and cannot recreate native watches.
	cache.getContext(context.Background(), root, true)
	if cache.watcher != nil {
		t.Fatal("closed cache recreated its file watcher")
	}
}

func TestGitWatchExternalWorktreeBranchAndFilesInNewEmptyDirectories(t *testing.T) {
	t.Parallel()
	_, git, _ := watchRepository(t)
	git("-c", "user.name=Watch Test", "-c", "user.email=watch@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture")
	linked := filepath.Join(t.TempDir(), "linked")
	git("worktree", "add", "-b", "linked", linked)
	linked, _ = filepath.EvalSymlinks(linked)
	var cache projectCache
	t.Cleanup(cache.close)
	cache.get(linked)
	before := cache.revision()
	if out, err := gitCommand(t.Context(), linked, "checkout", "-b", "external-branch").CombinedOutput(); err != nil {
		t.Fatalf("external branch change: %v %s", err, out)
	}
	waitWatchRevision(t, &cache, before)
	if info := cache.get(linked); info.Branch != "external-branch" {
		t.Fatalf("worktree branch did not refresh: %+v", info)
	}
	before = cache.revision()
	empty := filepath.Join(linked, "new", "empty")
	if err := os.MkdirAll(empty, 0700); err != nil {
		t.Fatal(err)
	}
	waitWatchRevision(t, &cache, before)
	cache.get(linked)
	before = cache.revision()
	if err := os.WriteFile(filepath.Join(empty, "later.txt"), []byte("later\n"), 0600); err != nil {
		t.Fatal(err)
	}
	waitWatchRevision(t, &cache, before)
	if info := cache.get(linked); info.Changes == nil || info.Changes.Untracked != 1 || info.Changes.Added != 1 {
		t.Fatalf("file created inside a previously empty directory was missed: %+v", info)
	}
}
