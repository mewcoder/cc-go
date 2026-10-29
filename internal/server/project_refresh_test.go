package server

import (
	"context"
	"encoding/json"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestFrequentSnapshotsNeverLaunchGitEvenAfterCacheExpires(t *testing.T) {
	a := testApp(t)
	workspace := a.state.Workspace
	reads := 0
	a.project.read = func(context.Context, string) ProjectInfo { reads++; return ProjectInfo{} }
	a.snapshot()
	if reads != 0 {
		t.Fatal("even the first UI snapshot must not query Git")
	}
	old := time.Now().Add(-time.Hour)
	a.project.info = ProjectInfo{Path: workspace, Branch: "cached-branch", GitStatus: "branch"}
	a.project.at = old
	for i := 0; i < 100; i++ {
		if got := a.snapshot()["project"].(ProjectInfo); got.Branch != "cached-branch" {
			t.Fatal("snapshot performed a Git refresh")
		}
	}
	if a.project.at != old {
		t.Fatal("snapshot refreshed the Git cache")
	}
}

func TestClaudeTerminalTransitionsInvalidateGitWithoutPollingTokensOrRepeatedStates(t *testing.T) {
	a := testApp(t)
	emit := func(workspace, status string, completed int64, generation uint64) {
		data, _ := json.Marshal(map[string]any{"sessions": []LiveSession{{ID: "session", Workspace: workspace, Status: status, CompletedAt: completed}}})
		a.hostEvent(generation, "host.sessions", data)
	}
	workspace := a.state.Workspace
	emit(workspace, "working", 0, a.hostGeneration)
	if a.project.revision() != 0 {
		t.Fatal("starting/streaming must not poll Git")
	}
	emit(workspace, "completed", 10, a.hostGeneration)
	if a.project.revision() != 1 {
		t.Fatal("completed operation did not invalidate Git")
	}
	emit(workspace, "completed", 10, a.hostGeneration)
	emit("/another-workspace", "completed", 20, a.hostGeneration)
	emit(workspace, "error", 0, a.hostGeneration+1)
	if a.project.revision() != 1 {
		t.Fatal("duplicate, unrelated or stale events refreshed Git")
	}
	emit(workspace, "working", 0, a.hostGeneration)
	emit(workspace, "interrupted", 0, a.hostGeneration)
	if a.project.revision() != 2 {
		t.Fatal("interrupted operation did not invalidate Git")
	}
}

func TestProjectRefreshCacheDeduplicatesWithoutIdleExpiration(t *testing.T) {
	var calls atomic.Int32
	started, release := make(chan struct{}), make(chan struct{})
	cache := projectCache{read: func(context.Context, string) ProjectInfo {
		if calls.Add(1) == 1 {
			close(started)
			<-release
		}
		return ProjectInfo{Path: "/workspace", Branch: "main"}
	}}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); cache.getContext(context.Background(), "/workspace", false) }()
	}
	<-started
	// A slow read must not block the high-frequency cached snapshot path.
	cached := make(chan struct{})
	go func() { cache.cached("/workspace"); close(cached) }()
	select {
	case <-cached:
	case <-time.After(time.Second):
		t.Fatal("cached snapshot blocked on Git")
	}
	close(release)
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("concurrent reads were not merged: %d", calls.Load())
	}
	cache.at = time.Now().Add(-time.Hour)
	cache.get("/workspace")
	if calls.Load() != 1 {
		t.Fatal("idle cache must not expire on a timer")
	}
	cache.getContext(context.Background(), "/workspace", true)
	if calls.Load() != 2 {
		t.Fatal("foreground refresh did not bypass old cache")
	}
	cache.getContext(context.Background(), "/workspace", true)
	if calls.Load() != 2 {
		t.Fatal("repeated focus events caused a process storm")
	}
	cache.at = time.Now().Add(-time.Hour)
	cache.get("/workspace")
	if calls.Load() != 2 {
		t.Fatal("an old cache must remain until an event invalidates it")
	}
	cache.invalidate()
	cache.get("/workspace")
	if calls.Load() != 3 {
		t.Fatal("event invalidation did not refresh Git")
	}
}

func TestProjectRequestsPauseOutsideVisibleConversationOnAllPlatforms(t *testing.T) {
	a := testApp(t)
	a.phase, a.pluginSetupOpen = "active", false
	var calls int
	a.project.read = func(_ context.Context, workspace string) ProjectInfo {
		calls++
		return ProjectInfo{Path: workspace, Branch: "main"}
	}
	workspace := a.state.Workspace
	for _, mode := range []string{"setup", "settings", "hidden", "minimized", "wrong-workspace"} {
		a.pluginSetupOpen, a.settingsOpen = mode == "setup", mode == "settings"
		a.SetWindowVisible(mode != "hidden" && mode != "minimized")
		requested := workspace
		if mode == "wrong-workspace" {
			requested = "/another-workspace"
		}
		if a.projectInfo(context.Background(), requested, true) != nil {
			t.Fatalf("Git ran during %s", mode)
		}
	}
	if calls != 0 {
		t.Fatal("inactive requests launched Git")
	}
	a.pluginSetupOpen, a.settingsOpen = false, false
	a.SetWindowVisible(true)
	if a.projectInfo(context.Background(), workspace, true) == nil || calls != 1 {
		t.Fatal("visible conversation did not refresh")
	}
	a.SetWindowVisible(false)
	a.SetWindowVisible(true)
	a.projectInfo(context.Background(), workspace, true)
	if calls != 2 {
		t.Fatal("restoring a native window must invalidate cached Git immediately")
	}
}
