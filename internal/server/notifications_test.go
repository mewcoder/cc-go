package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type messageResult struct {
	value any
	err   error
}

func pluginMessage(a *App, ctx context.Context, args string) <-chan messageResult {
	result := make(chan messageResult, 1)
	go func() {
		value, err := a.hostCall(ctx, "dialog.message", json.RawMessage(args))
		result <- messageResult{value, err}
	}()
	return result
}

func waitNotification(t *testing.T, a *App) Notification {
	t.Helper()
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for {
		items := a.snapshot()["notifications"].([]Notification)
		if len(items) > 0 {
			return items[0]
		}
		select {
		case <-deadline.C:
			t.Fatal("notification did not arrive")
		case <-tick.C:
		}
	}
}

func awaitMessage(t *testing.T, result <-chan messageResult) any {
	t.Helper()
	select {
	case result := <-result:
		if result.err != nil {
			t.Fatal(result.err)
		}
		return result.value
	case <-time.After(3 * time.Second):
		t.Fatal("message did not resolve")
		return nil
	}
}

func TestOrdinaryPluginMessagesAreNonModalAndReturnSelectedIndex(t *testing.T) {
	a := testApp(t)
	a.native.Message = func(string, string, []string) (int, error) {
		t.Error("ordinary messages must not show a blocking dialog")
		return -1, nil
	}
	result := pluginMessage(a, context.Background(), `{"type":"warning","message":"Waiting","items":[{"title":"View"}]}`)
	item := waitNotification(t, a)
	if item.Type != "warning" || item.Message != "Waiting" || len(item.Actions) != 1 || item.Actions[0] != "View" {
		t.Fatalf("wrong notification: %+v", item)
	}
	if w := postAPI(a, "/api/notification-action", map[string]any{"id": item.ID}); w.Code != http.StatusBadRequest {
		t.Fatal("missing action was accepted")
	}
	if w := postAPI(a, "/api/notification-action", map[string]any{"id": item.ID, "action": 1}); w.Code != http.StatusBadRequest {
		t.Fatal("unknown button was accepted")
	}
	select {
	case <-result:
		t.Fatal("invalid responses resolved the message")
	default:
	}
	if w := postAPI(a, "/api/notification-action", map[string]any{"id": item.ID, "action": 0}); w.Code != http.StatusOK {
		t.Fatal(w.Body.String())
	}
	if value := awaitMessage(t, result); value != 0 {
		t.Fatalf("selected action = %v", value)
	}
	if len(a.snapshot()["notifications"].([]Notification)) != 0 {
		t.Fatal("answered notification remained visible")
	}
}

func TestExplicitModalMessagesRetainDetailsAndCloseAffordance(t *testing.T) {
	a := testApp(t)
	a.native.Message = func(kind, message string, buttons []string) (int, error) {
		if kind != "info" || message != "Confirm\n\nDetails" || len(buttons) != 2 || buttons[1] != "Cancel" {
			t.Errorf("wrong modal content: %q %q %v", kind, message, buttons)
		}
		return -1, nil
	}
	result := pluginMessage(a, context.Background(), `{"type":"info","message":"Confirm","options":{"modal":true,"detail":"Details"},"items":["Allow",{"title":"Cancel","isCloseAffordance":true}]}`)
	if value := awaitMessage(t, result); value != 1 {
		t.Fatalf("close affordance = %v", value)
	}
	if len(a.snapshot()["notifications"].([]Notification)) != 0 {
		t.Fatal("modal message also created a toast")
	}
}

func TestPluginMessagesWithoutButtonsAndCancelledRequestsAreCleanedUp(t *testing.T) {
	a := testApp(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := pluginMessage(a, ctx, `{"type":"error","message":"No buttons"}`)
	item := waitNotification(t, a)
	if item.Type != "error" || len(item.Actions) != 0 {
		t.Fatalf("wrong message: %+v", item)
	}
	cancel()
	if value := awaitMessage(t, result); value != nil {
		t.Fatalf("cancelled message returned an action: %v", value)
	}
	if len(a.snapshot()["notifications"].([]Notification)) != 0 {
		t.Fatal("cancelled notification survived")
	}
}

func TestBackgroundSystemNotificationFailureRetainsPluginActions(t *testing.T) {
	a := testApp(t)
	shown := make(chan string, 1)
	a.native.Notify = func(id, kind, message string, click func()) (func(), error) {
		shown <- id
		return nil, errors.New("notifications denied")
	}
	a.SetWindowFocused(false)
	result := pluginMessage(a, context.Background(), `{"type":"info","message":"Waiting","items":["View"]}`)
	item := waitNotification(t, a)
	select {
	case id := <-shown:
		if id != item.ID {
			t.Fatal("system notification is not linked to its in-app message")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("background notification was not shown")
	}
	if err := a.answerNotification(item.ID, 0); err != nil {
		t.Fatal(err)
	}
	if value := awaitMessage(t, result); value != 0 {
		t.Fatal("system permission failure lost the plugin button")
	}
}

func TestForegroundMessagesSkipSystemNotificationsAndClosingViewDismissesThem(t *testing.T) {
	a := testApp(t)
	shown := make(chan struct{}, 1)
	a.native.Notify = func(string, string, string, func()) (func(), error) {
		shown <- struct{}{}
		return nil, nil
	}
	a.views["source"] = newView("source", "Chat", "token")
	result := pluginMessage(a, context.Background(), `{"viewId":"source","message":"Waiting","items":["View"]}`)
	waitNotification(t, a)
	a.hostEvent(a.hostGeneration, "webview.dispose", json.RawMessage(`{"id":"source"}`))
	if value := awaitMessage(t, result); value != nil {
		t.Fatal("closing a view selected a button")
	}
	select {
	case <-shown:
		t.Fatal("a foreground message produced a system notification")
	default:
	}
	if len(a.snapshot()["notifications"].([]Notification)) != 0 {
		t.Fatal("closed view retained its message")
	}
}

func TestRestartDismissesPendingMessagesAndLateNativeNotifications(t *testing.T) {
	a := testApp(t)
	started, release, closed := make(chan struct{}), make(chan struct{}), make(chan struct{}, 1)
	a.native.Notify = func(string, string, string, func()) (func(), error) {
		close(started)
		<-release
		return func() { closed <- struct{}{} }, nil
	}
	a.SetWindowVisible(false)
	result := pluginMessage(a, context.Background(), `{"message":"Waiting","items":["View"]}`)
	waitNotification(t, a)
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("native notification did not start")
	}
	a.mu.Lock()
	generation := a.hostGeneration
	a.detachHostLocked()
	a.mu.Unlock()
	close(release)
	if value := awaitMessage(t, result); value != nil {
		t.Fatal("restarting the host selected an action")
	}
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("late system notification was not removed")
	}
	if value, err := a.showPluginMessage(context.Background(), generation, json.RawMessage(`{"message":"Stale"}`)); value != nil || err != nil {
		t.Fatal("old host queued a new notification")
	}
}

func TestNotificationAssetsLoadBeforeDesktopAndRequireShellAuthorization(t *testing.T) {
	a := testApp(t)
	page := httptest.NewRecorder()
	a.Handler().ServeHTTP(page, httptest.NewRequest("GET", a.ShellURL+"/", nil))
	notification := strings.Index(page.Body.String(), `<script src="notifications.js">`)
	desktop := strings.Index(page.Body.String(), `<script src="desktop.js">`)
	if notification < 0 || desktop < notification {
		t.Fatal("notification renderer must load before the desktop")
	}
	script := httptest.NewRecorder()
	a.Handler().ServeHTTP(script, httptest.NewRequest("GET", a.ShellURL+"/notifications.js", nil))
	if script.Code != http.StatusOK {
		t.Fatal("notification asset is not served")
	}
	r := httptest.NewRequest("POST", a.ShellURL+"/api/notification-action", strings.NewReader(`{"id":"x","action":0}`))
	w := httptest.NewRecorder()
	a.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatal("unauthorized notification action was accepted")
	}
}

func TestPluginNotificationButtonReturnsToItsOriginalConversation(t *testing.T) {
	a := testApp(t)
	prepareChatFixture(t, a)
	source := `const vscode = require('vscode');
exports.activate = context => {
  context.subscriptions.push(vscode.commands.registerCommand('claude-vscode.editor.open', () => {
    const panel = vscode.window.createWebviewPanel('claude', 'Notification fixture', 1);
    panel.webview.html = '<html><body>Notification fixture</body></html>';
    panel.webview.onDidReceiveMessage(async message => {
      if (message.type !== 'request' || message.request?.type !== 'show_notification') return;
      if (message.request.onlyIfNotVisible && panel.visible) return;
      const selected = await vscode.window.showInformationMessage(message.request.message, 'View');
      if (selected === 'View') panel.reveal();
      await panel.webview.postMessage({type:'fixture-notification-result', selected});
    });
  }));
};`
	if err := os.WriteFile(filepath.Join(a.prepared.ExtensionPath, "extension.cjs"), []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := a.activate(ctx); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	original, peer := a.active, a.peer
	a.mu.Unlock()
	if err := a.newConversation(ctx, ""); err != nil {
		t.Fatal(err)
	}
	if err := a.receiveViewMessage(original, json.RawMessage(`{"type":"request","request":{"type":"show_notification","message":"Needs attention","onlyIfNotVisible":true}}`)); err != nil {
		t.Fatal(err)
	}
	item := waitNotification(t, a)
	a.mu.Lock()
	origin := a.notifications[0].viewID
	a.mu.Unlock()
	if origin != original {
		t.Fatal("notification lost its source view")
	}
	// Pending notifications must not block unrelated plugin RPCs.
	if _, err := peer.Call(ctx, "settings.get", nil); err != nil {
		t.Fatal(err)
	}
	if err := a.answerNotification(item.ID, 0); err != nil {
		t.Fatal(err)
	}
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for {
		a.mu.Lock()
		active := a.active
		view := a.views[original]
		a.mu.Unlock()
		view.mu.Lock()
		replied := false
		for _, message := range view.messages {
			if strings.Contains(string(message.Data), `"fixture-notification-result","selected":"View"`) {
				replied = true
			}
		}
		view.mu.Unlock()
		if active == original && replied {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("plugin did not receive its selected button and reveal the source view")
		case <-tick.C:
		}
	}
	// The selected panel remains visible to VS Code while the app is behind
	// another window; desktop focus must still allow its background reminder.
	a.SetWindowFocused(false)
	if err := a.receiveViewMessage(original, json.RawMessage(`{"type":"request","request":{"type":"show_notification","message":"Background reminder","onlyIfNotVisible":true}}`)); err != nil {
		t.Fatal(err)
	}
	background := waitNotification(t, a)
	if background.Message != "Background reminder" {
		t.Fatalf("wrong background message: %+v", background)
	}
	if err := a.answerNotification(background.ID, -1); err != nil {
		t.Fatal(err)
	}
}
