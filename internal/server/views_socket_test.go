package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"golang.org/x/net/websocket"
)

func socketFixture(t *testing.T) (*App, *View, string) {
	t.Helper()
	a := testApp(t)
	server := httptest.NewServer(a.ViewHandler())
	t.Cleanup(server.Close)
	a.ViewURL = server.URL
	view := newView("test", "Test", "secret")
	a.views[view.ID] = view
	return a, view, strings.Replace(server.URL, "http:", "ws:", 1) + "/view/test/secret/socket"
}

func receiveViewFrame(t *testing.T, conn *websocket.Conn) viewMessage {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	var frame viewMessage
	if err := websocket.JSON.Receive(conn, &frame); err != nil {
		t.Fatal(err)
	}
	return frame
}

func TestViewSocketsReplayResumeAndClose(t *testing.T) {
	a, view, address := socketFixture(t)
	if err := view.post(json.RawMessage(`{"type":"first"}`)); err != nil {
		t.Fatal(err)
	}
	conn, err := websocket.Dial(address, "", a.ViewURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	first := receiveViewFrame(t, conn)
	if first.Sequence != 1 || string(first.Data) != `{"type":"first"}` {
		t.Fatalf("unexpected replay: %+v", first)
	}
	conn.Close()
	if err := view.post(json.RawMessage(`{"type":"second"}`)); err != nil {
		t.Fatal(err)
	}
	reconnected, err := websocket.Dial(address+"?since=1", "", a.ViewURL)
	if err != nil {
		t.Fatal(err)
	}
	defer reconnected.Close()
	second := receiveViewFrame(t, reconnected)
	if second.Sequence != 2 || string(second.Data) != `{"type":"second"}` {
		t.Fatalf("reconnection replayed an acknowledged message: %+v", second)
	}
	view.close()
	var next viewMessage
	if err := websocket.JSON.Receive(reconnected, &next); err == nil {
		t.Fatal("disposing a view must close its socket")
	}
}

func TestManyViewSocketsKeepMessagesIsolatedAndResourcesAvailable(t *testing.T) {
	a, _, address := socketFixture(t)
	for i := range 12 {
		id := fmt.Sprint(i)
		view := newView(id, "Test", "secret")
		a.mu.Lock()
		a.views[id] = view
		a.mu.Unlock()
		message := fmt.Sprintf(`{"view":%d}`, i)
		if err := view.post(json.RawMessage(message)); err != nil {
			t.Fatal(err)
		}
		conn, err := websocket.Dial(strings.Replace(address, "/test/", "/"+id+"/", 1), "", a.ViewURL)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		if frame := receiveViewFrame(t, conn); string(frame.Data) != message {
			t.Fatalf("cross-view message: %s", frame.Data)
		}
	}
	client := &http.Client{Timeout: 3 * time.Second}
	response, err := client.Get(a.ViewURL + "/view/test/secret/bridge.js")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	contents, _ := io.ReadAll(response.Body)
	if response.StatusCode != 200 || !strings.Contains(string(contents), "new WebSocket") {
		t.Fatal("retained conversations blocked the next page's script")
	}
}

func TestViewSocketRejectsForeignOriginsAndTokens(t *testing.T) {
	a, _, address := socketFixture(t)
	for _, origin := range []string{"http://attacker.example", a.ShellURL, "null"} {
		if conn, err := websocket.Dial(address, "", origin); err == nil {
			conn.Close()
			t.Fatalf("accepted foreign origin %q", origin)
		}
	}
	if conn, err := websocket.Dial(strings.Replace(address, "/secret/", "/wrong/", 1), "", a.ViewURL); err == nil {
		conn.Close()
		t.Fatal("accepted wrong view token")
	}
	request := httptest.NewRequest("GET", a.ViewURL+"/view/test/secret/socket", nil)
	request.Header.Set("Origin", a.ViewURL)
	response := httptest.NewRecorder()
	a.ViewHandler().ServeHTTP(response, request)
	if response.Code != 400 {
		t.Fatalf("non-upgrade request: %d", response.Code)
	}
}

func TestViewTransportSnapshotTracksQueuedMessagesAndBusyViews(t *testing.T) {
	a := testApp(t)
	view := newView("view", "Test", "secret")
	a.views[view.ID] = view
	for _, status := range []string{"", "working", "needs_input", "completed", "error", "interrupted"} {
		a.liveSessions["session"] = LiveSession{ViewID: view.ID, Status: status}
		for _, pending := range []bool{false, true} {
			view.PendingInput = pending
			if err := view.post(json.RawMessage(`{"type":"notification"}`)); err != nil {
				t.Fatal(err)
			}
			value := a.snapshot()["views"].([]map[string]any)[0]
			wantBusy := pending || status == "working" || status == "needs_input"
			if value["busy"] != wantBusy || value["sequence"] != view.sequence {
				t.Fatalf("status %q pending %v: unexpected transport state %+v", status, pending, value)
			}
		}
	}
	request := httptest.NewRequest("GET", a.ViewURL+"/view/view/secret/bridge.js", nil)
	response := httptest.NewRecorder()
	a.ViewHandler().ServeHTTP(response, request)
	if !strings.Contains(response.Body.String(), `"shellOrigin":"`+a.ShellURL+`"`) {
		t.Fatal("the view must only trust lifecycle messages from its own shell")
	}
}
