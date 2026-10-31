//go:build !headless

package desktop

import (
	"context"
	"encoding/json"
	"testing"

	"cc-go/internal/server"
)

func TestViewBridgeRejectsCallsWithoutTrustedPage(t *testing.T) {
	bridge := &ViewBridge{backend: &server.App{ShellURL: "http://127.0.0.1:1234"}}
	if err := bridge.Stream(context.Background(), "view", "token", nil); err == nil {
		t.Fatal("stream accepted a call without a trusted shell page")
	}
	if err := bridge.Post(context.Background(), "view", "token", "state", json.RawMessage(`{}`)); err == nil {
		t.Fatal("post accepted a call without a trusted shell page")
	}
}
