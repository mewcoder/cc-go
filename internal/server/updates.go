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
	previousPrepared, previousRuntime, previousVersion := a.prepared, a.runtimePath, a.version
	previousArchive, previousSource := a.state.Archive, a.state.ArchiveSource
	autoApply := a.state.SetupComplete
	background := previousPhase == "active" && !a.pluginSetupOpen
	a.pluginUpdating = background
	a.phase, a.stopping = "preparing", true
	a.errorText = ""
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		a.pluginUpdating = false
		a.mu.Unlock()
	}()
	restore := func(err error) error {
		a.mu.Lock()
		a.phase, a.setupStatus, a.label, a.stopping = previousPhase, previousStatus, previousLabel, false
		a.setupStep = previousStep
		a.pluginSetupOpen = !background
		a.updateError = err.Error()
		if errors.Is(err, errDownloadCancelled) {
			a.setupStatus, a.updateError = "cancelled", ""
		}
		a.mu.Unlock()
		return err
	}
	download, err := a.downloadVSIX(ctx, "latest")
	if err != nil {
		return restore(err)
	}
	archive := download.Archive
	a.mu.Lock()
	a.setupStatus, a.setupStep = "extracting", 1
	a.mu.Unlock()
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
	// Keep the last usable installation until its replacement has activated.
	rollback := func(err error) error {
		a.stopHost()
		a.mu.Lock()
		a.prepared, a.runtimePath, a.version = previousPrepared, previousRuntime, previousVersion
		a.state.Archive, a.state.ArchiveSource = previousArchive, previousSource
		a.phase, a.setupStatus, a.label, a.stopping = previousPhase, previousStatus, previousLabel, false
		a.setupStep, a.errorText = previousStep, ""
		saveErr := a.saveLocked()
		a.mu.Unlock()
		var restartErr error
		if previousPhase == "active" {
			restartErr = a.activateChosenWorkspace(a.ctx)
			if restartErr != nil {
				a.fail(restartErr)
			}
		}
		err = errors.Join(err, saveErr, restartErr)
		a.mu.Lock()
		a.updateError = err.Error()
		a.pluginSetupOpen = !background || a.phase != "active" || a.setupSaveError != ""
		a.mu.Unlock()
		return err
	}
	if err := a.prepare(ctx, archive); err != nil {
		return rollback(err)
	}
	if autoApply {
		if err := a.activateChosenWorkspace(ctx); err != nil {
			return rollback(err)
		}
	}
	a.mu.Lock()
	a.latestVersion, a.updateError = a.version, ""
	a.mu.Unlock()
	if autoApply {
		a.cleanupPluginCache()
	}
	return nil
}

func (a *App) cleanupPluginCache() {
	a.mu.Lock()
	if a.phase != "active" || a.prepared == nil || a.setupSaveError != "" || a.cfg.VSIX != "" {
		a.mu.Unlock()
		return
	}
	archive, extensionPath := a.state.Archive, a.prepared.ExtensionPath
	a.mu.Unlock()
	if err := plugin.CleanupCache(a.cfg.DataDir, archive, extensionPath); err != nil {
		// Cleanup failure must not take a successfully updated host offline.
		a.Log("warning", "Could not clean old plugin caches: "+err.Error())
	}
}
