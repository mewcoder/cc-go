package server

import (
	"context"
	"errors"
	"path/filepath"

	"cc-go/internal/plugin"
)

func (a *App) checkPluginUpdate(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !a.updateMu.TryLock() {
		return nil
	}
	defer a.updateMu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	a.mu.Lock()
	a.checkingUpdate, a.updateError = true, ""
	a.mu.Unlock()
	version, err := plugin.LatestVersion(ctx, plugin.Platform())
	a.mu.Lock()
	a.checkingUpdate = false
	if err != nil {
		a.updateError = err.Error()
	} else {
		a.latestVersion = version
	}
	a.mu.Unlock()
	return err
}

func (a *App) updatePlugin(ctx context.Context) error {
	if !a.opMu.TryLock() {
		return errors.New("another plugin operation is in progress")
	}
	defer a.opMu.Unlock()
	a.mu.Lock()
	if err := a.workspaceChangeErrorLocked(); err != nil {
		a.mu.Unlock()
		return err
	}
	previousPhase, previousStatus, previousLabel := a.phase, a.setupStatus, a.label
	previousStep := a.setupStep
	a.phase, a.stopping, a.pluginSetupOpen = "preparing", true, true
	a.mu.Unlock()
	restore := func(err error) error {
		a.mu.Lock()
		a.phase, a.setupStatus, a.label, a.stopping = previousPhase, previousStatus, previousLabel, false
		a.setupStep = previousStep
		a.updateError = err.Error()
		a.mu.Unlock()
		return err
	}
	download, err := a.downloadVSIX(ctx, "latest")
	if err != nil {
		return restore(err)
	}
	archive := download.Archive
	// Validate the replacement before stopping the current host or changing
	// the saved archive. A failed download/import leaves the working copy intact.
	prepared, err := plugin.Prepare(archive, filepath.Join(a.cfg.DataDir, "extensions"), plugin.Platform(), download.Version)
	if err == nil {
		_, err = plugin.BundledRuntime(prepared.ExtensionPath, plugin.Platform())
	}
	if err != nil {
		return restore(err)
	}
	a.stopHost()
	if err := a.prepare(ctx, archive); err != nil {
		a.fail(err)
		return err
	}
	a.mu.Lock()
	a.latestVersion, a.updateError = a.version, ""
	a.mu.Unlock()
	return nil
}
