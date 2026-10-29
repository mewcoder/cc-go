package server

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type ProjectInfo struct {
	Path       string      `json:"path"`
	Name       string      `json:"name"`
	Branch     string      `json:"branch"`
	GitStatus  string      `json:"gitStatus"`
	Changes    *GitChanges `json:"changes,omitempty"`
	WatchError string      `json:"watchError,omitempty"`
}

type GitChanges struct {
	Files     int `json:"files"`
	Untracked int `json:"untracked"`
	Added     int `json:"added"`
	Deleted   int `json:"deleted"`
	Binary    int `json:"binary"`
}

type projectCache struct {
	mu         sync.Mutex
	refreshMu  sync.Mutex
	at         time.Time
	info       ProjectInfo
	generation uint64
	read       func(context.Context, string) ProjectInfo
	watcher    *projectWatcher // Owned by refreshMu, including shutdown.
	watchPath  string
	closed     bool
}

func (c *projectCache) get(directory string) ProjectInfo {
	return c.getContext(context.Background(), directory, false)
}

func (c *projectCache) cached(directory string) ProjectInfo {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.info.Path == directory {
		return c.info
	}
	return ProjectInfo{Path: directory, Name: filepath.Base(directory), GitStatus: "unknown"}
}

func (c *projectCache) invalidate() {
	c.mu.Lock()
	c.at = time.Time{}
	c.generation++
	c.mu.Unlock()
}

func (c *projectCache) getContext(ctx context.Context, directory string, force bool) ProjectInfo {
	requested := time.Now()
	c.refreshMu.Lock()
	defer c.refreshMu.Unlock()
	if c.closed || ctx.Err() != nil {
		return c.cached(directory)
	}
	var watchError string
	if c.read == nil {
		if c.watcher != nil && c.watchPath != directory {
			c.watcher.close()
			c.watcher = nil
		}
		if c.watcher == nil {
			var err error
			c.watcher, err = newProjectWatcher(c.invalidate)
			c.watchPath = directory
			if err != nil {
				watchError = "Automatic Git refresh unavailable: " + err.Error() + ". Use View > Refresh Git."
			}
		}
		if c.watcher != nil {
			probe, cancel := context.WithTimeout(ctx, 3*time.Second)
			c.watcher.sync(probe, directory)
			cancel()
			watchError = c.watcher.warning()
		}
	}
	c.mu.Lock()
	// A foreground/focus refresh may bypass the cache, but not create a
	// process storm. Requests queued behind the same read share its result.
	age := time.Since(c.at)
	if c.info.Path == directory && !c.at.IsZero() && (c.at.After(requested) || age < 2*time.Second || !force) {
		info := c.info
		c.mu.Unlock()
		return info
	}
	generation := c.generation
	c.mu.Unlock()
	if ctx.Err() != nil {
		return c.cached(directory)
	}
	probe, cancel := context.WithTimeout(ctx, time.Second)
	read := c.read
	if read == nil {
		read = readProjectContext
	}
	info := read(probe, directory)
	info.WatchError = watchError
	cancel()
	c.mu.Lock()
	defer c.mu.Unlock()
	if generation != c.generation || ctx.Err() != nil {
		return ProjectInfo{Path: directory, Name: filepath.Base(directory), GitStatus: "unknown"}
	}
	c.info = info
	c.at = time.Now()
	return c.info
}

func (c *projectCache) close() {
	c.refreshMu.Lock()
	defer c.refreshMu.Unlock()
	c.closed = true
	if c.watcher != nil {
		c.watcher.close()
		c.watcher = nil
	}
}

func (c *projectCache) revision() uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.generation
}

func (a *App) projectInfo(ctx context.Context, workspace string, force bool) *ProjectInfo {
	a.mu.Lock()
	allowed := a.phase == "active" && !a.pluginSetupOpen && !a.settingsOpen && !a.windowHidden && workspace == a.state.Workspace
	a.mu.Unlock()
	if !allowed {
		return nil
	}
	info := a.project.getContext(ctx, workspace, force)
	return &info
}

// SetWindowVisible is shared by the desktop lifecycle on every platform.
// Webviews do not consistently report document.hidden when a window is hidden.
func (a *App) SetWindowVisible(visible bool) {
	a.mu.Lock()
	changed := a.windowHidden == visible
	a.windowHidden = !visible
	a.mu.Unlock()
	if changed && visible {
		a.project.invalidate()
	}
}

func readProject(directory string) ProjectInfo {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	return readProjectContext(ctx, directory)
}

func readProjectContext(ctx context.Context, directory string) ProjectInfo {
	info := ProjectInfo{Path: directory, Name: filepath.Base(directory), GitStatus: "unknown"}
	git := func(args ...string) (string, error) {
		cmd := gitCommand(ctx, directory, args...)
		out, err := cmd.Output()
		return string(out), err
	}
	if branch, err := git("symbolic-ref", "--quiet", "--short", "HEAD"); err == nil && branch != "" {
		info.Branch, info.GitStatus = strings.TrimSpace(branch), "branch"
	} else if hash, err := git("rev-parse", "--short", "HEAD"); err == nil && hash != "" {
		info.Branch, info.GitStatus = strings.TrimSpace(hash), "detached"
	} else if _, err := git("rev-parse", "--is-inside-work-tree"); err != nil {
		if exit, ok := err.(*exec.ExitError); ok && strings.Contains(string(exit.Stderr), "not a git repository") {
			info.GitStatus = "none"
		}
	}
	if info.GitStatus == "branch" || info.GitStatus == "detached" {
		info.Changes = readGitChanges(ctx, git)
	}
	return info
}

type gitFileStatus struct{ code, path string }

func gitStatusEntries(status string) []gitFileStatus {
	var files []gitFileStatus
	entries := strings.Split(status, "\x00")
	for i := 0; i < len(entries); i++ {
		entry := entries[i]
		if len(entry) < 4 {
			continue
		}
		files = append(files, gitFileStatus{code: entry[:2], path: entry[3:]})
		// Porcelain -z renames/copies include a second, unprefixed pathname.
		if strings.ContainsAny(entry[:2], "RC") {
			i++
		}
	}
	return files
}

func countGitChanges(status string) *GitChanges {
	changes := &GitChanges{}
	for _, entry := range gitStatusEntries(status) {
		changes.Files++
		if entry.code == "??" {
			changes.Untracked++
		}
	}
	return changes
}

func readGitChanges(ctx context.Context, git func(...string) (string, error)) *GitChanges {
	status, err := git("status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none")
	if err != nil {
		return nil
	}
	changes := countGitChanges(status)
	if changes.Files > changes.Untracked && readTrackedChanges(git, changes) == nil {
		return nil
	}
	if changes.Untracked > 0 && addUntrackedChanges(ctx, git, status, changes) != nil {
		return nil
	}
	return changes
}

func readTrackedChanges(git func(...string) (string, error), changes *GitChanges) *GitChanges {
	base := "HEAD"
	if _, err := git("rev-parse", "--verify", "HEAD"); err != nil {
		// An unborn branch compares against the empty tree (also works with SHA-256 repositories).
		empty, err := git("hash-object", "-t", "tree", "--stdin")
		if err != nil {
			return nil
		}
		base = strings.TrimSpace(empty)
	}
	diff, err := git("diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", base, "--")
	if err != nil {
		return nil
	}
	records := strings.Split(diff, "\x00")
	for i := 0; i < len(records); i++ {
		if records[i] == "" {
			continue
		}
		parts := strings.SplitN(records[i], "\t", 3)
		if len(parts) != 3 {
			return nil
		}
		if parts[0] == "-" && parts[1] == "-" {
			changes.Binary++
		} else {
			added, errA := strconv.Atoi(parts[0])
			deleted, errD := strconv.Atoi(parts[1])
			if errA != nil || errD != nil || added < 0 || deleted < 0 {
				return nil
			}
			changes.Added += added
			changes.Deleted += deleted
		}
		if parts[2] == "" {
			i += 2
		}
	}
	return changes
}

func addUntrackedChanges(ctx context.Context, git func(...string) (string, error), status string, changes *GitChanges) error {
	root, err := git("rev-parse", "--show-toplevel")
	if err != nil {
		return err
	}
	root = strings.TrimSuffix(root, "\n")
	var paths []string
	for _, entry := range gitStatusEntries(status) {
		if entry.code == "??" {
			paths = append(paths, entry.path)
		}
	}
	args := append([]string{"-C", root, "check-attr", "-z", "diff", "--"}, paths...)
	attributes, err := git(args...)
	if err != nil {
		return err
	}
	attrs := make(map[string]string)
	parts := strings.Split(attributes, "\x00")
	for i := 0; i+2 < len(parts); i += 3 {
		attrs[parts[i]] = parts[i+2]
	}
	for _, name := range paths {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !filepath.IsLocal(name) {
			return fmt.Errorf("invalid Git path")
		}
		lines, binary, err := countNewFileLines(ctx, filepath.Join(root, filepath.FromSlash(name)), attrs[name])
		if err != nil {
			return err
		}
		if binary {
			changes.Binary++
		} else {
			changes.Added += lines
		}
	}
	return nil
}

func countNewFileLines(ctx context.Context, filename, diffAttribute string) (int, bool, error) {
	info, err := os.Lstat(filename)
	if err != nil {
		return 0, false, err
	}
	// Git stores the symlink target itself, never the contents of the linked file.
	if info.Mode()&os.ModeSymlink != 0 {
		target, err := os.Readlink(filename)
		lines := strings.Count(target, "\n")
		if len(target) > 0 && target[len(target)-1] != '\n' {
			lines++
		}
		return lines, false, err
	}
	// Git reports an embedded, untracked repository as one opaque directory entry.
	if info.IsDir() {
		return 0, false, nil
	}
	if !info.Mode().IsRegular() {
		return 0, false, fmt.Errorf("not a regular file")
	}
	if diffAttribute == "unset" {
		return 0, true, nil
	}
	file, err := os.Open(filename)
	if err != nil {
		return 0, false, err
	}
	defer file.Close()
	buffer := make([]byte, 64*1024)
	lines, seen := 0, 0
	var last byte
	for {
		if err := ctx.Err(); err != nil {
			return 0, false, err
		}
		n, err := file.Read(buffer)
		if n > 0 {
			// Match Git's NUL-byte heuristic in the first 8000 bytes; `diff` forces text.
			probe := min(n, max(0, 8000-seen))
			if diffAttribute != "set" && bytes.IndexByte(buffer[:probe], 0) >= 0 {
				return 0, true, nil
			}
			lines += bytes.Count(buffer[:n], []byte{'\n'})
			seen += n
			last = buffer[n-1]
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return 0, false, err
		}
	}
	if seen > 0 && last != '\n' {
		lines++
	}
	after, err := file.Stat()
	if err != nil {
		return 0, false, err
	}
	if !os.SameFile(info, after) || info.Size() != int64(seen) || !info.ModTime().Equal(after.ModTime()) {
		return 0, false, fmt.Errorf("file changed while counting lines")
	}
	return lines, false, nil
}
