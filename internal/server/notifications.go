package server

import (
	"context"
	"encoding/json"
	"errors"
)

type Notification struct {
	ID      string   `json:"id"`
	Type    string   `json:"type"`
	Message string   `json:"message"`
	Detail  string   `json:"detail,omitempty"`
	Actions []string `json:"actions"`
}

type pendingNotification struct {
	Notification
	viewID      string
	result      chan int
	closeNative func()
}

func (a *App) notificationSnapshotLocked() []Notification {
	items := make([]Notification, 0, len(a.notifications))
	for _, item := range a.notifications {
		value := item.Notification
		value.Actions = append([]string{}, value.Actions...)
		items = append(items, value)
	}
	return items
}

func (a *App) finishNotificationLocked(item *pendingNotification, index int) {
	for i, candidate := range a.notifications {
		if candidate != item {
			continue
		}
		a.notifications = append(a.notifications[:i], a.notifications[i+1:]...)
		item.result <- index
		if item.closeNative != nil {
			// Native dispatch may call back into the app on the UI thread.
			go item.closeNative()
		}
		return
	}
}

func (a *App) clearNotificationsLocked(viewID string) {
	for i := len(a.notifications) - 1; i >= 0; i-- {
		item := a.notifications[i]
		if viewID == "" || item.viewID == viewID {
			a.finishNotificationLocked(item, -1)
		}
	}
}

func (a *App) answerNotification(id string, index int) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, item := range a.notifications {
		if item.ID == id {
			if index < -1 || index >= len(item.Actions) {
				return errors.New("invalid notification action")
			}
			a.finishNotificationLocked(item, index)
			return nil
		}
	}
	// A click may race a close or a plugin restart.
	return nil
}

func (a *App) focusNotification(id string) {
	a.mu.Lock()
	var viewID string
	for _, item := range a.notifications {
		if item.ID == id && a.views[item.viewID] != nil {
			viewID = item.viewID
			break
		}
	}
	peer := a.peer
	a.mu.Unlock()
	if viewID != "" && peer != nil {
		_ = peer.Notify("webview.select", map[string]any{"id": viewID})
	}
}

func (a *App) showPluginMessage(ctx context.Context, generation uint64, args json.RawMessage) (any, error) {
	var request struct {
		Type, Message, ViewID string
		Items                 []json.RawMessage
		Options               struct {
			Modal  bool
			Detail string
		}
	}
	if err := json.Unmarshal(args, &request); err != nil {
		return nil, err
	}
	buttons := make([]string, 0, len(request.Items))
	closeIndex := -1
	for i, raw := range request.Items {
		var title string
		if json.Unmarshal(raw, &title) != nil {
			var item struct {
				Title             string
				IsCloseAffordance bool
			}
			if err := json.Unmarshal(raw, &item); err != nil {
				return nil, err
			}
			title = item.Title
			if item.IsCloseAffordance {
				closeIndex = i
			}
		}
		buttons = append(buttons, title)
	}
	a.mu.Lock()
	if generation != a.hostGeneration || a.stopping {
		a.mu.Unlock()
		return nil, nil
	}
	native := a.native
	if request.Options.Modal {
		a.mu.Unlock()
		if native.Message == nil {
			return nil, errors.New("native confirmation requires desktop mode")
		}
		text := request.Message
		if request.Options.Detail != "" {
			text += "\n\n" + request.Options.Detail
		}
		index, err := native.Message(request.Type, text, buttons)
		if index < 0 || index >= len(buttons) {
			index = closeIndex
		}
		if err != nil || index < 0 {
			return nil, err
		}
		return index, nil
	}
	if request.Type != "warning" && request.Type != "error" {
		request.Type = "info"
	}
	item := &pendingNotification{
		Notification: Notification{ID: randomToken(), Type: request.Type, Message: request.Message, Detail: request.Options.Detail, Actions: buttons},
		viewID:       request.ViewID, result: make(chan int, 1),
	}
	if item.viewID != "" && a.views[item.viewID] == nil {
		a.mu.Unlock()
		return nil, nil
	}
	if len(a.notifications) >= 50 {
		a.finishNotificationLocked(a.notifications[0], -1)
	}
	a.notifications = append(a.notifications, item)
	background := a.windowHidden || a.windowUnfocused
	a.mu.Unlock()
	if background && native.Notify != nil {
		go func() {
			closeNative, err := native.Notify(item.ID, item.Type, item.Message, func() { a.focusNotification(item.ID) })
			if err != nil {
				a.Log("warning", "System notification: "+err.Error())
			}
			a.mu.Lock()
			for _, candidate := range a.notifications {
				if candidate == item {
					item.closeNative = closeNative
					a.mu.Unlock()
					return
				}
			}
			a.mu.Unlock()
			if closeNative != nil {
				closeNative()
			}
		}()
	}
	select {
	case index := <-item.result:
		if index >= 0 {
			return index, nil
		}
	case <-ctx.Done():
	case <-a.ctx.Done():
	}
	a.mu.Lock()
	a.finishNotificationLocked(item, -1)
	a.mu.Unlock()
	return nil, nil
}

func (a *App) SetWindowFocused(focused bool) {
	a.mu.Lock()
	changed := a.windowUnfocused == focused
	a.windowUnfocused = !focused
	peer := a.peer
	a.mu.Unlock()
	if changed && peer != nil {
		_ = peer.Notify("window.focus", map[string]bool{"focused": focused})
	}
}
