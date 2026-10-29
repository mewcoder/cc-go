package server

import (
	"path/filepath"
	"sort"
	"time"

	"cc-go/internal/plugin"
	"cc-go/internal/sessions"
)

func (a *App) snapshot() map[string]any {
	a.mu.Lock()
	workspace, theme := a.state.Workspace, a.state.Theme
	paths := append([]string(nil), a.state.Workspaces...)
	usedAt := make(map[string]int64, len(paths))
	for _, path := range paths {
		usedAt[path] = a.state.WorkspaceUsedAt[path]
	}
	metadata := make(map[string]sessions.Metadata, len(a.state.Metadata))
	for k, v := range a.state.Metadata {
		metadata[k] = v
	}
	live := make(map[string]LiveSession, len(a.liveSessions))
	for key, value := range a.liveSessions {
		live[key] = value
	}
	views := make([]map[string]any, 0, len(a.views))
	for _, view := range a.views {
		views = append(views, map[string]any{
			"id": view.ID, "title": view.Title, "active": view.ID == a.active,
			"url":      a.ViewURL + "/view/" + view.ID + "/" + view.Token + "/index.html",
			"revision": view.Revision, "ready": view.HTML != "",
		})
	}
	sort.Slice(views, func(i, j int) bool { return views[i]["id"].(string) < views[j]["id"].(string) })
	activeView := a.views[a.active]
	key := sessions.Key(workspace, a.activeSessionID)
	result := map[string]any{
		"phase": a.phase, "label": a.label, "error": a.errorText,
		"workspace": workspace, "theme": theme, "version": a.version,
		"windowVisible": !a.windowHidden,
		"nativeMenu":    a.native.ShowMenu != nil,
		"views":         views, "logs": append([]string{}, a.logs...), "dataDir": a.cfg.DataDir,
		"logsOpen": a.logsOpen, "settingsOpen": a.settingsOpen, "pluginSetupOpen": a.pluginSetupOpen,
		"setupCanStart": a.prepared != nil && (a.setupStatus == "ready" || a.phase == "active"),
		"sidebarWidth":  a.state.SidebarWidth, "sidebarCollapsed": a.state.SidebarCollapsed,
		"transcriptWidth":  a.state.TranscriptWidth,
		"activeSessionId":  a.activeSessionID,
		"canSelectProject": a.selectionErrorLocked(a.active, workspace) == nil,
		"sessionMetrics":   a.metrics[key],
		"viewLoading":      a.phase == "active" && (activeView == nil || activeView.HTML == ""),
		"extension":        map[string]any{"id": "Anthropic.claude-code", "version": a.version},
		"pluginSetup":      map[string]any{"status": a.setupStatus, "step": a.setupStep, "nodeVersion": a.nodeVersion, "nodePath": a.nodePath, "nodeError": a.nodeError, "runtimePath": a.runtimePath, "runtimeReady": a.runtimePath != "", "readyVersion": a.version, "latestVersion": a.latestVersion, "checkingUpdate": a.checkingUpdate, "updateAvailable": plugin.NewerVersion(a.latestVersion, a.version), "updateError": a.updateError, "platform": plugin.Platform(), "directory": filepath.Join(a.cfg.DataDir, "vsix"), "error": a.errorText},
	}
	if a.phase == "preparing" {
		result["phase"] = "setup"
	}
	a.mu.Unlock()
	result["project"] = a.project.cached(workspace)
	result["projectRevision"] = a.project.revision()

	a.sessionMu.Lock()
	workspaces := make([]map[string]any, 0, len(paths))
	archived := make([]map[string]any, 0)
	for _, p := range paths {
		cached := a.sessionCache[p]
		if time.Since(cached.At) > 4*time.Second {
			cached = sessionSnapshot{At: time.Now(), Items: sessions.List(a.cfg.ProjectsDir, p, metadata)}
			a.sessionCache[p] = cached
		}
		items := make([]sessions.Session, len(cached.Items))
		copy(items, cached.Items)
		for i := range items {
			meta := metadata[sessions.Key(p, items[i].ID)]
			usedAt[p] = max(usedAt[p], items[i].UpdatedAt, meta.ReadAt)
			if meta.Title != "" {
				items[i].Title = meta.Title
			}
			items[i].Archived = meta.Archived
		}
		visible := make([]map[string]any, 0)
		for _, item := range items {
			value := map[string]any{"id": item.ID, "title": item.Title, "updatedAt": item.UpdatedAt, "archived": item.Archived, "active": p == workspace && item.ID == result["activeSessionId"], "workspace": p, "workspaceName": filepath.Base(p)}
			status := live[sessions.Key(p, item.ID)]
			value["status"] = status.Status
			value["completionUnread"] = status.Status == "completed" && status.CompletedAt > metadata[sessions.Key(p, item.ID)].ReadAt && value["active"] != true
			if item.Archived {
				archived = append(archived, value)
			} else {
				visible = append(visible, value)
			}
		}
		workspaces = append(workspaces, map[string]any{"path": p, "name": filepath.Base(p), "active": p == workspace, "sessions": visible})
	}
	a.sessionMu.Unlock()
	sort.SliceStable(workspaces, func(i, j int) bool {
		return usedAt[workspaces[i]["path"].(string)] > usedAt[workspaces[j]["path"].(string)]
	})
	result["workspaces"] = workspaces
	result["archivedSessions"] = archived
	return result
}
