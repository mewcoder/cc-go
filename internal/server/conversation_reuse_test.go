package server

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func waitForConversationView(t *testing.T, a *App, id string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		a.mu.Lock()
		active := a.active
		a.mu.Unlock()
		if active == id {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("conversation did not focus its existing view")
}

func TestOpenConversationReusesExistingView(t *testing.T) {
	for _, status := range []string{"working", "needs_input", "completed"} {
		t.Run(status, func(t *testing.T) {
			a := testApp(t)
			prepareChatFixture(t, a)
			if err := a.activate(context.Background()); err != nil {
				t.Fatal(err)
			}
			a.mu.Lock()
			original, workspace, peer := a.active, a.state.Workspace, a.peer
			a.setViewSessionLocked(original, regressionSessionID)
			a.views[original].HasDraft = true
			a.liveSessions["original"] = LiveSession{
				ViewID: original, Workspace: workspace, ID: regressionSessionID, Status: status,
			}
			a.mu.Unlock()
			if err := a.newConversation(context.Background(), workspace); err != nil {
				t.Fatal(err)
			}
			a.mu.Lock()
			blank, count := a.active, len(a.views)
			a.mu.Unlock()
			if blank == original || count != 2 {
				t.Fatal("new chat replaced the original conversation's page")
			}
			for i := 0; i < 2; i++ {
				if err := a.openConversation(context.Background(), workspace, regressionSessionID); err != nil {
					t.Fatal(err)
				}
				waitForConversationView(t, a, original)
			}
			a.mu.Lock()
			defer a.mu.Unlock()
			if a.peer != peer || len(a.views) != count || a.activeSessionID != regressionSessionID {
				t.Fatal("reopening created a duplicate page or replaced the host")
			}
			if !a.views[original].HasDraft || a.views[blank].SessionID != "" || a.liveSessions["original"].Status != status {
				t.Fatal("reopening changed a draft, another page's identity, or execution state")
			}
		})
	}
}

func TestClosedConversationCanBeOpenedInNewView(t *testing.T) {
	a := testApp(t)
	prepareChatFixture(t, a)
	if err := a.activate(context.Background()); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	original, peer := a.active, a.peer
	a.setViewSessionLocked(original, regressionSessionID)
	a.mu.Unlock()
	for _, message := range []string{
		`{"type":"launch_claude","channelId":"closed"}`,
		`{"type":"io_message","channelId":"closed","message":{"type":"user"}}`,
	} {
		if err := a.receiveViewMessage(original, json.RawMessage(message)); err != nil {
			t.Fatal(err)
		}
	}
	if err := a.newConversation(context.Background(), ""); err != nil {
		t.Fatal(err)
	}
	if err := a.changeView(original, true); err != nil {
		t.Fatal(err)
	}
	// An RPC reply follows the close notification on the same ordered stream.
	if _, err := peer.Call(context.Background(), "settings.get", nil); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	err := a.runningConversationErrorLocked()
	a.mu.Unlock()
	if err != nil {
		t.Fatal("closed page left an active channel behind:", err)
	}
	if err := a.openConversation(context.Background(), "", regressionSessionID); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.views[original] != nil || len(a.views) != 2 || a.activeSessionID != regressionSessionID {
		t.Fatal("a closed page prevented the session from opening in a new page")
	}
}

func TestSessionSelectionBindsBackgroundViewBeforeReopen(t *testing.T) {
	a := testApp(t)
	prepareChatFixture(t, a)
	if err := a.activate(context.Background()); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	original := a.active
	a.mu.Unlock()
	if err := a.newConversation(context.Background(), ""); err != nil {
		t.Fatal(err)
	}
	message, _ := json.Marshal(map[string]any{
		"type": "request", "requestId": "selection",
		"request": map[string]any{"type": "update_session_state", "sessionId": regressionSessionID, "idConfirmed": true},
	})
	if err := a.receiveViewMessage(original, message); err != nil {
		t.Fatal(err)
	}
	if _, err := a.peer.Call(context.Background(), "settings.get", nil); err != nil {
		t.Fatal(err)
	}
	if err := a.openConversation(context.Background(), "", regressionSessionID); err != nil {
		t.Fatal(err)
	}
	waitForConversationView(t, a, original)
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.views) != 2 {
		t.Fatal("a session confirmed in a background page opened a duplicate")
	}
}

func TestOpenConversationReactivatesChannelRetainedByPluginNewButton(t *testing.T) {
	a := testApp(t)
	prepareChatFixture(t, a)
	if err := a.activate(context.Background()); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	original, peer := a.active, a.peer
	a.mu.Unlock()
	send := func(message any) {
		t.Helper()
		data, _ := json.Marshal(message)
		if err := a.receiveViewMessage(original, data); err != nil {
			t.Fatal(err)
		}
	}
	// The first session ID comes from the CLI, not a resume argument.
	send(map[string]any{"type": "launch_claude", "channelId": "first"})
	if _, err := peer.Call(context.Background(), "command", map[string]any{"command": "claude-vscode.newConversation"}); err != nil {
		t.Fatal(err)
	}
	const second = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
	send(map[string]any{"type": "launch_claude", "channelId": "second", "resume": second})
	if _, err := peer.Call(context.Background(), "settings.get", nil); err != nil {
		t.Fatal(err)
	}
	if err := a.openConversation(context.Background(), "", regressionSessionID); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.views) != 1 || a.active != original || a.activeSessionID != regressionSessionID {
		t.Fatal("opening a retained channel created a duplicate conversation")
	}
	view := a.views[original]
	view.mu.Lock()
	defer view.mu.Unlock()
	for _, queued := range view.messages {
		var message struct {
			Message struct {
				Request struct{ Type, SessionID string }
			}
		}
		if json.Unmarshal(queued.Data, &message) == nil && message.Message.Request.Type == "activate_session" && message.Message.Request.SessionID == regressionSessionID {
			return
		}
	}
	t.Fatal("the original page was focused without switching back to its retained conversation")
}
