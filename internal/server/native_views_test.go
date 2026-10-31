package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func waitNative(t *testing.T, done <-chan error) error {
	t.Helper()
	select {
	case err := <-done:
		return err
	case <-time.After(3 * time.Second):
		t.Fatal("native stream did not stop")
		return nil
	}
}

func TestNativeViewRequiresDesktopAndViewToken(t *testing.T) {
	a := testApp(t)
	a.views["view"] = newView("view", "View", "secret")
	if err := a.ReceiveNativeView("view", "secret", "state", json.RawMessage(`{}`)); err == nil {
		t.Fatal("browser mode accepted native operation")
	}
	a.EnableNativeViews()
	for _, idToken := range [][2]string{{"view", ""}, {"view", "wrong"}, {"missing", "secret"}} {
		if err := a.ReceiveNativeView(idToken[0], idToken[1], "state", json.RawMessage(`{}`)); err == nil {
			t.Fatal("unauthorized view accepted")
		}
	}
	if err := a.ReceiveNativeView("view", "secret", "state", json.RawMessage(`{"draft":"kept"}`)); err != nil {
		t.Fatal(err)
	}
	if string(a.views["view"].state) != `{"draft":"kept"}` {
		t.Fatal("state not saved")
	}
	for _, operation := range []string{"new", "close", "workspace", "arbitrary"} {
		if err := a.ReceiveNativeView("view", "secret", operation, json.RawMessage(`{}`)); err == nil {
			t.Fatal("privileged operation accepted")
		}
	}
	a.views["view"].close()
	if err := a.ReceiveNativeView("view", "secret", "state", json.RawMessage(`{}`)); err == nil {
		t.Fatal("closed view accepted")
	}
}

func TestNativeViewDrainsOrderedMessagesWithoutReplayRetention(t *testing.T) {
	a := testApp(t)
	a.EnableNativeViews()
	var wg sync.WaitGroup
	for index := range 12 {
		id := fmt.Sprint(index)
		v := newView(id, id, "secret")
		a.mu.Lock()
		a.views[id] = v
		a.mu.Unlock()
		_ = v.post(json.RawMessage(`{"initial":true}`))
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			received := make(chan json.RawMessage)
			done := make(chan error, 1)
			go func() {
				done <- a.StreamNativeView(ctx, id, "secret", func(data json.RawMessage) error {
					select {
					case received <- data:
						return nil
					case <-ctx.Done():
						return ctx.Err()
					}
				}, func() {})
			}()
			if string(<-received) != `{"initial":true}` {
				t.Error("lost initialization")
			}
			// Total traffic exceeds the old 32 MiB retained-history limit.
			for sequence := range 20 {
				data := json.RawMessage(fmt.Sprintf(`{"sequence":%d,"text":%q}`, sequence, strings.Repeat("x", 2<<20)))
				if err := v.post(data); err != nil {
					t.Error(err)
					break
				}
				if got := <-received; string(got) != string(data) {
					t.Error("out of order or corrupted message")
				}
			}
			cancel()
			waitNative(t, done)
			v.mu.Lock()
			defer v.mu.Unlock()
			if v.bytes != 0 || len(v.messages) != 0 {
				t.Errorf("retained sent history: bytes=%d count=%d", v.bytes, len(v.messages))
			}
		}()
	}
	wg.Wait()
}

func TestNativeViewDisposeUnblocksFrameworkSend(t *testing.T) {
	a := testApp(t)
	a.EnableNativeViews()
	v := newView("view", "View", "secret")
	a.views[v.ID] = v
	_ = v.post(json.RawMessage(`{}`))
	entered, closed := make(chan struct{}), make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- a.StreamNativeView(context.Background(), v.ID, v.Token, func(json.RawMessage) error {
			close(entered)
			<-closed
			return errors.New("channel closed")
		}, func() { close(closed) })
	}()
	<-entered
	v.close()
	if waitNative(t, done) == nil {
		t.Fatal("blocked send did not fail")
	}
}

func TestNativeViewReloadCancelsPreviousSubscription(t *testing.T) {
	a := testApp(t)
	a.EnableNativeViews()
	v := newView("view", "View", "secret")
	a.views[v.ID] = v
	_ = v.post(json.RawMessage(`{"initial":true}`))
	entered, closed := make(chan struct{}), make(chan struct{})
	old := make(chan error, 1)
	go func() {
		old <- a.StreamNativeView(context.Background(), v.ID, v.Token, func(json.RawMessage) error {
			close(entered)
			<-closed
			return errors.New("replaced")
		}, func() { close(closed) })
	}()
	<-entered
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- a.StreamNativeView(ctx, v.ID, v.Token, func(data json.RawMessage) error {
			if string(data) != `{"initial":true}` {
				t.Error("failed send was discarded")
			}
			cancel()
			return nil
		}, func() {})
	}()
	waitNative(t, old)
	waitNative(t, done)
}

func TestNativeViewBridgeConfigAndNoHTTPStreams(t *testing.T) {
	a := testApp(t)
	a.EnableNativeViews()
	a.views["view"] = newView("view", "View", "secret")
	for _, endpoint := range []string{"events", "socket", "message", "state", "external"} {
		w := httptest.NewRecorder()
		a.ViewHandler().ServeHTTP(w, httptest.NewRequest("GET", a.ViewURL+"/view/view/secret/"+endpoint, nil))
		if w.Code != http.StatusGone {
			t.Fatalf("HTTP fallback still available: %s %d", endpoint, w.Code)
		}
	}
	w := httptest.NewRecorder()
	a.ViewHandler().ServeHTTP(w, httptest.NewRequest("GET", a.ViewURL+"/view/view/secret/bridge.js", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"native":true`) {
		t.Fatal("native bridge flag missing")
	}
}
