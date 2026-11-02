package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"cc-go/internal/plugin"
)

func TestBackgroundUpdateDownloadFailureKeepsCurrentChat(t *testing.T) {
	a := testApp(t)
	prepareChatFixture(t, a)
	if err := a.activate(t.Context()); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	peer, active, archive := a.peer, a.active, a.state.Archive
	a.mu.Unlock()
	fixtureRegistry(t, "1.2.4")
	transport := http.DefaultTransport
	http.DefaultTransport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/plugin.vsix" {
			return nil, context.DeadlineExceeded
		}
		return transport.RoundTrip(r)
	})
	t.Cleanup(func() { http.DefaultTransport = transport })
	if w := postAPI(a, "/api/update-check", map[string]any{}); w.Code != 400 {
		t.Fatal("download failure not reported:", w.Code, w.Body.String())
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.peer != peer || a.active != active || a.state.Archive != archive || a.phase != "active" || a.pluginSetupOpen || a.pluginUpdating || a.stopping || a.updateError == "" {
		t.Fatal("download failure interrupted the current chat or opened setup")
	}
}

func TestUpdateStagesSilentlyThenActivatesOfflineAndCleansOnlyAfterSuccess(t *testing.T) {
	a := testApp(t)
	prepareChatFixture(t, a)
	if err := a.activate(t.Context()); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	oldRoot := filepath.Dir(a.prepared.ExtensionPath)
	oldPeer := a.peer
	imported := a.state.Archive
	a.mu.Unlock()
	oldArchive := filepath.Join(a.cfg.DataDir, "vsix", "claude-code-1.2.3-"+plugin.Platform()+".vsix")
	if err := os.MkdirAll(filepath.Dir(oldArchive), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(oldArchive, []byte("old managed archive"), 0600); err != nil {
		t.Fatal(err)
	}
	fixtureRegistry(t, "1.2.4")
	transport := http.DefaultTransport
	http.DefaultTransport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		state := a.snapshot()
		if state["pluginSetupOpen"] != false {
			t.Error("direct update opened setup before finishing")
		}
		if state["phase"] != "active" || state["pluginUpdating"] != false || len(state["views"].([]map[string]any)) == 0 {
			t.Error("background download replaced the active chat:", state["phase"], state["pluginUpdating"])
		}
		if state["pluginSetup"].(map[string]any)["updateReady"] != false {
			t.Error("update was offered before download validation")
		}
		if !a.opMu.TryLock() {
			t.Error("background download blocked session operations")
		} else {
			a.opMu.Unlock()
		}
		for _, file := range []string{oldRoot, oldArchive, imported} {
			if _, err := os.Stat(file); err != nil {
				t.Error("old installation removed before activation:", file, err)
			}
		}
		return transport.RoundTrip(r)
	})
	if w := postAPI(a, "/api/update-check", map[string]any{}); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	setup := a.snapshot()["pluginSetup"].(map[string]any)
	if setup["updateReady"] != true || setup["updateVersion"] != "1.2.4" || setup["readyVersion"] != "1.2.3" || a.peer != oldPeer || a.state.Archive != imported {
		t.Fatal("staging changed the active installation or failed to publish the validated update")
	}
	// Clicking Update must use the prepared local package, including offline.
	http.DefaultTransport = roundTripFunc(func(*http.Request) (*http.Response, error) {
		t.Error("applying a staged update made a network request")
		return nil, context.DeadlineExceeded
	})
	if w := postAPI(a, "/api/update-plugin", map[string]any{}); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	a.mu.Lock()
	active := a.phase == "active" && a.peer != nil && a.peer != oldPeer && a.version == "1.2.4" && !a.pluginSetupOpen && !a.pluginUpdating
	archive, extension := a.state.Archive, a.prepared.ExtensionPath
	a.mu.Unlock()
	if !active {
		t.Fatal("update still requires an Apply/Start action")
	}
	for _, file := range []string{oldRoot, oldArchive} {
		if _, err := os.Stat(file); !os.IsNotExist(err) {
			t.Fatal("obsolete installation remains:", file, err)
		}
	}
	for _, file := range []string{archive, extension, imported} {
		if _, err := os.Stat(file); err != nil {
			t.Fatal("current installation or imported original removed:", file, err)
		}
	}
	if persistedState(t, a).Archive != archive {
		t.Fatal("new installation not persisted before cleanup")
	}
}

func TestUpdateActivationFailureRestoresOldHostAndKeepsCache(t *testing.T) {
	a := testApp(t)
	prepareChatFixture(t, a)
	if err := a.activate(t.Context()); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	oldPrepared, oldArchive := a.prepared, a.state.Archive
	a.mu.Unlock()
	// A valid package/runtime whose extension throws during activation.
	archive, err := os.ReadFile(activationRecoveryArchive(t, filepath.Join(t.TempDir(), "never-created"), "1.2.4"))
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(archive)
	fixtureRegistry(t, "1.2.4")
	transport := http.DefaultTransport
	http.DefaultTransport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/plugin.vsix" || r.URL.Path == "/sha256" {
			body := archive
			if r.URL.Path == "/sha256" {
				body = []byte(hex.EncodeToString(digest[:]))
			}
			return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(body)), Header: make(http.Header)}, nil
		}
		return transport.RoundTrip(r)
	})
	if w := postAPI(a, "/api/update-check", map[string]any{}); w.Code != 200 {
		t.Fatal("stage broken-activation update:", w.Body.String())
	}
	if w := postAPI(a, "/api/update-plugin", map[string]any{}); w.Code != 400 || !strings.Contains(w.Body.String(), "fixture activation failed") {
		t.Fatalf("activation failure not reported: %d %s", w.Code, w.Body.String())
	}
	a.mu.Lock()
	restored := a.phase == "active" && a.peer != nil && a.prepared == oldPrepared && a.state.Archive == oldArchive && a.version == "1.2.3" && a.updateError != "" && !a.pluginSetupOpen && !a.pluginUpdating
	a.mu.Unlock()
	if !restored || persistedState(t, a).Archive != oldArchive {
		t.Fatal("failed update did not restore and persist the previous installation")
	}
	if _, err := os.Stat(oldPrepared.ExtensionPath); err != nil {
		t.Fatal("failed update removed the previous cache:", err)
	}
}

func TestActivePluginUpdateRequiresValidatedDownload(t *testing.T) {
	a := testApp(t)
	prepareChatFixture(t, a)
	if err := a.activate(t.Context()); err != nil {
		t.Fatal(err)
	}
	peer := a.peer
	requests := fixtureRegistry(t, "1.2.4")
	a.latestVersion = "1.2.4"
	if w := postAPI(a, "/api/update-plugin", map[string]any{}); w.Code != 400 {
		t.Fatal("unstaged update accepted:", w.Code, w.Body.String())
	}
	if *requests != 0 || a.peer != peer || a.phase != "active" || a.stopping {
		t.Fatal("unstaged update downloaded or interrupted the host")
	}
}

func TestInvalidBackgroundPackageIsNotOfferedForUpdate(t *testing.T) {
	a := testApp(t)
	prepareChatFixture(t, a)
	if err := a.activate(t.Context()); err != nil {
		t.Fatal(err)
	}
	peer, archive := a.peer, a.state.Archive
	fixtureRegistry(t, "1.2.4", "9.9.9")
	if w := postAPI(a, "/api/update-check", map[string]any{}); w.Code != 400 {
		t.Fatal("invalid update was accepted:", w.Body.String())
	}
	if a.updateReady != nil || a.updateError == "" || a.peer != peer || a.state.Archive != archive || a.phase != "active" {
		t.Fatal("invalid package became available or disturbed the current host")
	}
}

func TestBackgroundPluginDownloadAllowsDraftsAndRunningConversations(t *testing.T) {
	a := testApp(t)
	prepareChatFixture(t, a)
	if err := a.activate(t.Context()); err != nil {
		t.Fatal(err)
	}
	peer := a.peer
	a.views[a.active].HasDraft = true
	a.liveSessions["working"] = LiveSession{Status: "working"}
	fixtureRegistry(t, "1.2.4")
	if w := postAPI(a, "/api/update-check", map[string]any{}); w.Code != 200 {
		t.Fatal("background download blocked by chat:", w.Body.String())
	}
	if a.updateReady == nil || a.peer != peer || a.phase != "active" || a.stopping {
		t.Fatal("background download disturbed chat")
	}
	if w := postAPI(a, "/api/update-plugin", map[string]any{}); w.Code != 400 || a.peer != peer || a.updateReady == nil {
		t.Fatal("applying update must preserve a busy chat and retain the staged package")
	}
}

func TestStartingPreparedPluginCleansExistingHistory(t *testing.T) {
	a := testApp(t)
	prepareChatFixture(t, a)
	oldRoot := filepath.Join(a.cfg.DataDir, "extensions", strings.Repeat("b", 64))
	if err := os.MkdirAll(oldRoot, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(oldRoot, ".receipt.json"), []byte("[]"), 0600); err != nil {
		t.Fatal(err)
	}
	if w := postAPI(a, "/api/start", map[string]any{}); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if _, err := os.Stat(oldRoot); !os.IsNotExist(err) {
		t.Fatal("successful start did not clean historical cache:", err)
	}
	if a.snapshot()["phase"] != "active" {
		t.Fatal("historical cleanup took the host offline")
	}
}
