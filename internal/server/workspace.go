package server

import (
	"context"
	"errors"
	"fmt"
	"os"

	"cc-go/internal/sessions"
)

func (a *App) importProjects(paths []string) error {
	projects, err := sessions.Discover(a.cfg.ProjectsDir)
	if err != nil {
		return err
	}
	available := make(map[string]bool, len(projects))
	for _, project := range projects {
		available[project.Path] = true
	}
	for _, path := range paths {
		if !available[path] {
			return errors.New("project is no longer available")
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	previous := a.state.Workspaces
	a.state.Workspaces = append([]string{}, previous...)
	for _, path := range paths {
		a.addWorkspaceLocked(path)
	}
	if err := a.saveLocked(); err != nil {
		a.state.Workspaces = previous
		return err
	}
	return nil
}

func (a *App) switchWorkspace(ctx context.Context, directory string) error {
	full, err := validWorkspace(directory)
	if err != nil {
		return err
	}
	if !a.opMu.TryLock() {
		return errors.New("another plugin operation is in progress")
	}
	defer a.opMu.Unlock()
	return a.switchWorkspaceLocked(ctx, full)
}

func (a *App) switchWorkspaceLocked(ctx context.Context, full string) error {
	var err error
	a.mu.Lock()
	if a.phase != "active" || a.peer == nil {
		a.mu.Unlock()
		return errors.New("plugin host is not ready")
	}
	if a.state.Workspace == full && a.phase == "active" {
		previous := a.state.Workspaces
		a.state.Workspaces = append([]string{}, previous...)
		a.addWorkspaceLocked(full)
		err = a.touchWorkspaceLocked()
		if err != nil {
			a.state.Workspaces = previous
		}
		a.mu.Unlock()
		return err
	}
	if err := a.workspaceChangeErrorLocked(); err != nil {
		a.mu.Unlock()
		return err
	}
	previous, paths := a.state.Workspace, a.state.Workspaces
	a.state.Workspace = full
	a.state.Workspaces = append([]string{}, paths...)
	a.addWorkspaceLocked(full)
	err = a.saveLocked()
	if err != nil {
		a.state.Workspace, a.state.Workspaces = previous, paths
		a.mu.Unlock()
		return err
	}
	// Do not tear down a usable host until its replacement workspace is saved.
	a.phase, a.stopping = "starting", true
	a.mu.Unlock()
	a.stopHost()
	// Activation opens a new conversation. Opening a saved session immediately
	// after this is safe and leaves the fresh tab available alongside it.
	err = a.activate(ctx)
	if err == nil {
		a.mu.Lock()
		err = a.touchWorkspaceLocked()
		a.mu.Unlock()
	}
	if err != nil {
		a.fail(fmt.Errorf("switch workspace: %w", err))
	}
	return err
}

// Empty input means the global New chat action, not permission to reuse a removed project.
func (a *App) chooseChatWorkspace(directory string) (string, error) {
	if directory != "" {
		return validWorkspace(directory)
	}
	a.mu.Lock()
	current := a.state.Workspace
	paths := append([]string{}, a.state.Workspaces...)
	registered := false
	for _, path := range paths {
		registered = registered || path == current
	}
	a.mu.Unlock()
	if registered {
		if full, err := validWorkspace(current); err == nil {
			return full, nil
		}
	}
	for _, path := range paths {
		if full, err := validWorkspace(path); err == nil {
			return full, nil
		}
	}
	directory, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return validWorkspace(directory)
}

// Called with opMu held by /api/start, before a host exists.
func (a *App) activateChosenWorkspace(ctx context.Context) error {
	a.mu.Lock()
	current := a.state.Workspace
	a.mu.Unlock()
	// Restarting an existing host must not restore a removed sidebar entry.
	if _, err := validWorkspace(current); err == nil {
		return a.activate(ctx)
	}
	full, err := a.chooseChatWorkspace("")
	if err != nil || full == "" {
		return err
	}
	a.mu.Lock()
	previous, paths := a.state.Workspace, a.state.Workspaces
	a.state.Workspace = full
	a.state.Workspaces = append([]string{}, paths...)
	a.addWorkspaceLocked(full)
	err = a.saveLocked()
	if err != nil {
		a.state.Workspace, a.state.Workspaces = previous, paths
	}
	a.mu.Unlock()
	if err != nil {
		return err
	}
	return a.activate(ctx)
}
