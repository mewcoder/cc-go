package server

import (
	"context"
	"errors"
	"time"

	"cc-go/internal/sessions"
)

func (a *App) newConversation(ctx context.Context, directory string) error {
	if !a.opMu.TryLock() {
		return errors.New("another plugin operation is in progress")
	}
	defer a.opMu.Unlock()
	a.mu.Lock()
	ready := a.phase == "active" && a.peer != nil
	a.mu.Unlock()
	if !ready {
		return errors.New("plugin host is not ready")
	}
	full, err := a.chooseChatWorkspace(directory)
	if err != nil || full == "" {
		return err
	}
	a.mu.Lock()
	switching := full != a.state.Workspace
	a.mu.Unlock()
	if err := a.switchWorkspaceLocked(ctx, full); err != nil {
		return err
	}
	// Activation already opens a blank conversation in a different workspace.
	if switching {
		return nil
	}
	a.mu.Lock()
	peer := a.peer
	a.mu.Unlock()
	if peer == nil {
		return errors.New("plugin host is not ready")
	}
	// The plugin's newConversation command retains old channels in the same page.
	if _, err := peer.Call(ctx, "command", map[string]any{"command": "claude-vscode.editor.open"}); err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.touchWorkspaceLocked()
}

func (a *App) openConversation(ctx context.Context, directory, id string) error {
	if !sessions.ID.MatchString(id) {
		return errors.New("invalid session ID")
	}
	if !a.opMu.TryLock() {
		return errors.New("another plugin operation is in progress")
	}
	defer a.opMu.Unlock()
	if directory != "" {
		full, err := validWorkspace(directory)
		if err != nil {
			return err
		}
		if err := a.switchWorkspaceLocked(ctx, full); err != nil {
			return err
		}
	}
	a.mu.Lock()
	peer, ready := a.peer, a.phase == "active"
	var viewID string
	for _, view := range a.views {
		if view.SessionID == id {
			viewID = view.ID
			if viewID == a.active {
				break
			}
		}
	}
	a.mu.Unlock()
	if peer == nil || !ready {
		return errors.New("plugin host is not ready")
	}
	if _, err := peer.Call(ctx, "conversation.open", map[string]any{"sessionId": id, "viewId": viewID}); err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.peer != peer || a.views[a.active] == nil {
		return errors.New("plugin conversation is no longer available")
	}
	a.setViewSessionLocked(a.active, id)
	return a.touchWorkspaceLocked()
}

func (a *App) changeView(id string, close bool) error {
	if !a.opMu.TryLock() {
		return errors.New("another plugin operation is in progress")
	}
	defer a.opMu.Unlock()
	a.mu.Lock()
	view, peer := a.views[id], a.peer
	var err error
	if close && view != nil && view.HasDraft {
		err = errors.New("send or clear the unsent draft before closing this conversation")
	}
	a.mu.Unlock()
	if err != nil {
		return err
	}
	if view == nil || peer == nil {
		return errors.New("view not found")
	}
	method := "webview.select"
	if close {
		method = "webview.close"
	}
	// The resulting host event is authoritative for focus and session identity.
	return peer.Notify(method, map[string]any{"id": id})
}

func (a *App) runningConversationErrorLocked() error {
	for _, view := range a.views {
		if view.PendingInput {
			return errors.New("wait for running conversations to finish before switching projects or branches")
		}
	}
	for _, session := range a.liveSessions {
		if session.Status == "working" || session.Status == "needs_input" {
			return errors.New("wait for running conversations to finish before switching projects or branches")
		}
	}
	return nil
}

func (a *App) workspaceChangeErrorLocked() error {
	if err := a.runningConversationErrorLocked(); err != nil {
		return err
	}
	for _, view := range a.views {
		if view.HasDraft {
			return errors.New("send or clear unsent drafts before switching projects, branches or reloading the plugin")
		}
	}
	return nil
}

func (a *App) setViewDraft(id string, draft *bool) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	view := a.views[id]
	if view == nil || draft == nil {
		return errors.New("a current view and draft state are required")
	}
	view.HasDraft = *draft
	return nil
}

func (a *App) focusViewLocked(id string) {
	if view := a.views[id]; view != nil {
		a.active, a.activeSessionID = id, view.SessionID
		a.markActiveReadLocked()
	}
}

func (a *App) setViewSessionLocked(id, sessionID string) {
	if view := a.views[id]; view != nil {
		view.SessionID = sessionID
		if a.active == id {
			a.activeSessionID = sessionID
			a.markActiveReadLocked()
		}
	}
}

func (a *App) markActiveReadLocked() {
	if a.activeSessionID == "" {
		return
	}
	key := sessions.Key(a.state.Workspace, a.activeSessionID)
	meta := a.state.Metadata[key]
	meta.ReadAt = time.Now().UnixMilli()
	a.state.Metadata[key] = meta
}
