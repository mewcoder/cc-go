package server

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// Watch directories containing tracked/non-ignored files, not dependency trees
// or Git objects. fsnotify uses native notifications on macOS, Windows and Linux.
type projectWatcher struct {
	fs       *fsnotify.Watcher
	stop     chan struct{}
	done     chan struct{}
	mu       sync.Mutex
	dirty    bool
	err      error
	metadata map[string]bool
}

func newProjectWatcher(invalidate func()) (*projectWatcher, error) {
	fs, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	w := &projectWatcher{fs: fs, stop: make(chan struct{}), done: make(chan struct{}), dirty: true}
	go w.run(invalidate)
	return w, nil
}

func (w *projectWatcher) close() {
	close(w.stop)
	_ = w.fs.Close()
	<-w.done
}

func (w *projectWatcher) run(invalidate func()) {
	defer close(w.done)
	var timer *time.Timer
	var tick <-chan time.Time
	var last time.Time
	defer func() {
		if timer != nil {
			timer.Stop()
		}
	}()
	schedule := func() {
		delay := time.Second
		if remaining := time.Until(last.Add(5 * time.Second)); remaining > delay {
			delay = remaining
		}
		if timer != nil {
			timer.Reset(delay)
		} else {
			timer = time.NewTimer(delay)
		}
		tick = timer.C
	}
	for {
		select {
		case <-w.stop:
			return
		case event, ok := <-w.fs.Events:
			if !ok {
				return
			}
			w.mu.Lock()
			metadata := w.metadata[filepath.Dir(event.Name)]
			metadataDirectory, watchedDirectory := w.metadata[event.Name]
			w.mu.Unlock()
			if ignoredGitWatchEvent(event, metadata, metadataDirectory) {
				continue
			}
			if !event.Has(fsnotify.Write) && !event.Has(fsnotify.Create) && !event.Has(fsnotify.Remove) && !event.Has(fsnotify.Rename) && !event.Has(fsnotify.Chmod) {
				continue
			}
			// Reconcile new/deleted directories only on the next foreground read.
			// The notification loop itself never launches a Git subprocess.
			name := filepath.Base(event.Name)
			info, _ := os.Lstat(event.Name)
			if watchedDirectory || info != nil && info.IsDir() || name == ".gitignore" || name == ".git" || metadata && (name == "index" || name == "exclude") {
				w.mu.Lock()
				w.dirty = true
				w.mu.Unlock()
			}
			schedule()
		case err, ok := <-w.fs.Errors:
			if !ok {
				return
			}
			w.mu.Lock()
			w.err, w.dirty = err, true
			w.mu.Unlock()
			schedule()
		case <-tick:
			tick = nil
			last = time.Now()
			invalidate()
		}
	}
}

func ignoredGitWatchEvent(event fsnotify.Event, metadata, metadataDirectory bool) bool {
	if metadata && (strings.HasSuffix(event.Name, ".lock") || strings.HasPrefix(filepath.Base(event.Name), ".watchman-cookie-")) {
		return true
	}
	// Windows also reports the .git directory's own timestamp when a lock is
	// created inside it. Actual child events carry the meaningful change.
	return metadataDirectory && event.Op&(fsnotify.Create|fsnotify.Remove|fsnotify.Rename) == 0
}

func (w *projectWatcher) sync(ctx context.Context, directory string) {
	w.mu.Lock()
	if !w.dirty {
		w.mu.Unlock()
		return
	}
	w.dirty = false
	w.mu.Unlock()
	if canonical, err := filepath.EvalSymlinks(directory); err == nil {
		directory = canonical
	}

	dirs := map[string]bool{directory: false}
	git := func(args ...string) (string, error) {
		out, err := gitCommand(ctx, directory, args...).Output()
		return strings.TrimSuffix(string(out), "\n"), err
	}
	var syncErr error
	root, err := git("rev-parse", "--show-toplevel")
	if ctx.Err() != nil {
		syncErr = ctx.Err()
	}
	if err == nil {
		root = filepath.Clean(root)
		dirs[root] = false
		// Run at the repository root so opening a subdirectory still observes
		// repository-wide changes and tracked files beneath ignored directories.
		out, err := gitCommand(ctx, root, "ls-files", "--cached", "--others", "--exclude-standard", "-z").Output()
		if err != nil {
			syncErr = err
		} else {
			for _, name := range strings.Split(string(out), "\x00") {
				if name == "" {
					continue
				}
				for dir := filepath.Dir(filepath.Join(root, name)); dir != root && dir != filepath.Dir(dir); dir = filepath.Dir(dir) {
					dirs[dir] = false
				}
			}
			// ls-files omits empty directories. Observe those too, or a file
			// created later inside an empty directory would never generate an
			// event on its watched parent. Ignore checks are batched, not one
			// subprocess per directory, and tracked ignored paths remain watched.
			if err := addEmptyWatchDirectories(ctx, root, dirs); err != nil {
				syncErr = err
			}
		}
		for _, args := range [][]string{{"rev-parse", "--absolute-git-dir"}, {"rev-parse", "--path-format=absolute", "--git-common-dir"}} {
			gitdir, err := git(args...)
			if err != nil {
				syncErr = err
				continue
			}
			gitdir = filepath.Clean(gitdir)
			if canonical, err := filepath.EvalSymlinks(gitdir); err == nil {
				gitdir = canonical
			}
			dirs[gitdir] = true
			dirs[filepath.Join(gitdir, "info")] = true
			// Worktrees have their own HEAD/index, but share refs/packed-refs.
			walkErr := filepath.WalkDir(filepath.Join(gitdir, "refs"), func(path string, entry os.DirEntry, err error) error {
				if ctx.Err() != nil {
					return ctx.Err()
				}
				if err == nil && entry.IsDir() {
					dirs[path] = true
				}
				if os.IsNotExist(err) {
					return nil
				}
				return err
			})
			if walkErr != nil {
				syncErr = walkErr
			}
		}
	}
	current := make(map[string]bool)
	for _, dir := range w.fs.WatchList() {
		current[dir] = true
	}
	for dir := range dirs {
		if current[dir] {
			continue
		}
		info, err := os.Lstat(dir)
		if dir != directory && (os.IsNotExist(err) || err == nil && !info.IsDir()) {
			continue
		}
		if err == nil {
			err = w.fs.Add(dir)
		}
		if err != nil {
			syncErr = fmt.Errorf("watch %s: %w", dir, err)
		}
	}
	for dir := range current {
		if _, keep := dirs[dir]; !keep && syncErr == nil {
			_ = w.fs.Remove(dir)
		}
	}
	w.mu.Lock()
	w.metadata = dirs
	if syncErr != nil {
		w.err, w.dirty = syncErr, true
	} else {
		w.err = nil
	}
	w.mu.Unlock()
}

func addEmptyWatchDirectories(ctx context.Context, root string, dirs map[string]bool) error {
	queue := make([]string, 0, len(dirs))
	for dir := range dirs {
		queue = append(queue, dir)
	}
	for len(queue) > 0 {
		var candidates []string
		for _, dir := range queue {
			if err := ctx.Err(); err != nil {
				return err
			}
			entries, err := os.ReadDir(dir)
			if os.IsNotExist(err) {
				continue
			}
			if err != nil {
				return err
			}
			for _, entry := range entries {
				path := filepath.Join(dir, entry.Name())
				if _, exists := dirs[path]; exists || !entry.IsDir() || entry.Name() == ".git" {
					continue
				}
				candidates = append(candidates, path)
			}
		}
		if len(candidates) == 0 {
			break
		}
		cmd := gitCommand(ctx, root, "check-ignore", "--stdin", "-z")
		cmd.Stdin = strings.NewReader(strings.Join(candidates, "\x00") + "\x00")
		out, err := cmd.Output()
		if err != nil {
			if cmd.ProcessState == nil || cmd.ProcessState.ExitCode() != 1 {
				return fmt.Errorf("watch ignore rules: %w", err)
			}
		}
		ignored := make(map[string]bool)
		for _, path := range bytes.Split(out, []byte{0}) {
			ignored[string(path)] = true
		}
		queue = nil
		for _, path := range candidates {
			if !ignored[path] {
				dirs[path] = false
				queue = append(queue, path)
			}
		}
	}
	return nil
}

func (w *projectWatcher) warning() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.err != nil {
		return "Automatic Git refresh is incomplete: " + w.err.Error() + ". Use View > Refresh Git."
	}
	return ""
}
