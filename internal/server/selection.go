package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"cc-go/internal/sessions"
)

func (a *App) selectionErrorLocked(id, workspace string) error {
	if a.selecting {
		return errors.New("project selection is not available while the host is busy")
	}
	return a.selectionContextErrorLocked(id, workspace)
}

func (a *App) selectionContextErrorLocked(id, workspace string) error {
	view := a.views[id]
	if a.phase != "active" || a.peer == nil {
		return errors.New("plugin host is not ready")
	}
	if id != a.active || workspace != a.state.Workspace || view == nil {
		return errors.New("the active project or conversation changed; reopen the selector")
	}
	if a.activeSessionID != "" || view.Started {
		return errors.New("select a project or branch in a new conversation before sending a message")
	}
	return a.workspaceChangeErrorLocked()
}

func (a *App) beginSelection(id, workspace string) (func(), error) {
	if !a.opMu.TryLock() {
		return nil, errors.New("another plugin operation is in progress")
	}
	a.mu.Lock()
	err := a.selectionErrorLocked(id, workspace)
	if err == nil {
		a.selecting = true
	}
	a.mu.Unlock()
	if err != nil {
		a.opMu.Unlock()
		return nil, err
	}
	return func() {
		a.mu.Lock()
		a.selecting = false
		a.mu.Unlock()
		a.opMu.Unlock()
	}, nil
}

func (a *App) receiveViewMessage(id string, data json.RawMessage) error {
	var message struct {
		Type, Resume string
		Message      struct{ Type string }
		Request      struct{ Type string }
	}
	if err := json.Unmarshal(data, &message); err != nil {
		return err
	}
	a.mu.Lock()
	view, peer := a.views[id], a.peer
	if view == nil || peer == nil {
		a.mu.Unlock()
		return errors.New("plugin view is no longer available")
	}
	user := message.Type == "io_message" && message.Message.Type == "user"
	history := message.Type == "request" && message.Request.Type == "get_session_request"
	if a.selecting && (user || history || message.Type == "launch_claude") {
		a.mu.Unlock()
		return errors.New("project or branch selection is in progress; try again when it finishes")
	}
	if a.phase != "active" && (user || history || message.Type == "launch_claude") {
		a.mu.Unlock()
		return errors.New("plugin host is changing workspaces; try again when it is ready")
	}
	if message.Type == "launch_claude" {
		view.Started = message.Resume != ""
		if message.Resume == "" || sessions.ID.MatchString(message.Resume) {
			a.setViewSessionLocked(id, message.Resume)
		}
	}
	if user || history {
		view.Started = true
	}
	if user {
		view.PendingInput = true
	}
	a.mu.Unlock()
	return peer.Notify("webview.receive", map[string]any{"id": id, "message": data})
}

func selectionGit(ctx context.Context, directory string, args ...string) (string, error) {
	out, err := selectionGitRaw(ctx, directory, args...)
	return strings.TrimSpace(out), err
}

func selectionGitRaw(ctx context.Context, directory string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", directory, "-c", "core.fsmonitor=false"}, args...)...)
	for _, value := range os.Environ() {
		if !strings.HasPrefix(value, "GIT_") {
			cmd.Env = append(cmd.Env, value)
		}
	}
	cmd.Env = append(cmd.Env, "GIT_OPTIONAL_LOCKS=0", "LC_ALL=C")
	out, err := cmd.Output()
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	if err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			return "", fmt.Errorf("git: %s", strings.TrimSpace(string(exit.Stderr)))
		}
		return "", err
	}
	return string(out), nil
}

type BranchOptions struct {
	Current   string   `json:"current"`
	Branches  []string `json:"branches"`
	Dirty     bool     `json:"dirty"`
	Files     int      `json:"files"`
	Untracked int      `json:"untracked"`
}

func readBranchOptions(ctx context.Context, directory string) (BranchOptions, error) {
	options := BranchOptions{Branches: []string{}}
	out, err := selectionGit(ctx, directory, "for-each-ref", "--format=%(refname:strip=2)", "refs/heads/")
	if err != nil {
		return options, err
	}
	options.Current, _ = selectionGit(ctx, directory, "symbolic-ref", "--quiet", "--short", "HEAD")
	if out != "" {
		options.Branches = strings.Split(out, "\n")
	}
	if len(options.Branches) == 0 && options.Current != "" {
		options.Branches = append(options.Branches, options.Current)
	}
	status, err := selectionGitRaw(ctx, directory, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none")
	if err != nil {
		return options, err
	}
	counts := countGitChanges(status)
	options.Files, options.Untracked = counts.Files, counts.Untracked
	options.Dirty = status != ""
	return options, nil
}

func (a *App) branchOptions(ctx context.Context, id, workspace string) (BranchOptions, error) {
	finish, err := a.beginSelection(id, workspace)
	if err != nil {
		return BranchOptions{}, err
	}
	defer finish()
	return readBranchOptions(ctx, workspace)
}

func (a *App) selectProject(ctx context.Context, id, workspace, directory string) error {
	finish, err := a.beginSelection(id, workspace)
	if err != nil {
		return err
	}
	defer finish()
	if directory == "" {
		if a.native.SelectFolder == nil {
			return errors.New("folder selection requires desktop mode")
		}
		directory, err = a.native.SelectFolder()
		if err != nil || directory == "" {
			return err
		}
	}
	full, err := validWorkspace(directory)
	if err != nil {
		return err
	}
	return a.switchWorkspaceLocked(ctx, full)
}

func (a *App) selectBranch(ctx context.Context, id, workspace, branch string) error {
	finish, err := a.beginSelection(id, workspace)
	if err != nil {
		return err
	}
	defer finish()
	options, err := readBranchOptions(ctx, workspace)
	if err != nil {
		return err
	}
	if branch != "" && branch == options.Current {
		return nil
	}
	if options.Dirty {
		return errors.New("uncommitted changes found; commit or stash them yourself before switching branches")
	}
	if _, err = selectionGit(ctx, workspace, "check-ref-format", "--branch", branch); err != nil {
		return errors.New("invalid local branch name")
	}
	found := false
	for _, name := range options.Branches {
		found = found || name == branch
	}
	if !found {
		return errors.New("local branch no longer exists; reopen the selector")
	}
	// Do not run repository-owned checkout hooks from this UI action.
	hooks, err := os.MkdirTemp(a.cfg.DataDir, "empty-git-hooks-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(hooks)
	a.mu.Lock()
	err = a.selectionContextErrorLocked(id, workspace)
	a.mu.Unlock()
	if err != nil {
		return err
	}
	a.stopHost()
	_, switchErr := selectionGit(ctx, workspace, "-c", "core.hooksPath="+hooks, "switch", "--no-guess", branch)
	a.project.mu.Lock()
	a.project.at = time.Time{}
	a.project.mu.Unlock()
	activateErr := a.activate(ctx)
	if activateErr != nil {
		a.fail(activateErr)
	}
	return errors.Join(switchErr, activateErr)
}
