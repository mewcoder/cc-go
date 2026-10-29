package server

import (
	"errors"
	"path/filepath"
)

func (a *App) openWorkspaceFolder(directory string) error {
	if directory == "" {
		return errors.New("workspace is required")
	}
	full, err := validWorkspace(directory)
	if err != nil {
		return err
	}
	a.mu.Lock()
	known := false
	for _, path := range a.state.Workspaces {
		known = known || path == full
	}
	open := a.native.OpenPath
	a.mu.Unlock()
	if !known {
		return errors.New("workspace is not registered")
	}
	if open == nil {
		return errors.New("opening a workspace folder requires desktop mode")
	}
	return open(full)
}

func (a *App) removeWorkspace(directory string) error {
	if directory == "" {
		return errors.New("workspace is required")
	}
	full, err := filepath.Abs(directory)
	if err != nil {
		return err
	}
	if !a.opMu.TryLock() {
		return errors.New("another project operation is in progress")
	}
	defer a.opMu.Unlock()
	a.mu.Lock()
	defer a.mu.Unlock()
	previous := a.state.Workspaces
	remaining := make([]string, 0, len(previous))
	for _, path := range previous {
		if path != full {
			remaining = append(remaining, path)
		}
	}
	if len(remaining) == len(previous) {
		return errors.New("workspace is not registered")
	}
	// Only sidebar membership changes. Keep the host, files, sessions and usage records.
	a.state.Workspaces = remaining
	if err := a.saveLocked(); err != nil {
		a.state.Workspaces = previous
		return err
	}
	return nil
}
