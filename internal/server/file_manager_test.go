package server

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRevealFileHostCallSupportsMemoryOutsideWorkspace(t *testing.T) {
	a := testApp(t)
	memory := filepath.Join(t.TempDir(), "project with spaces;literal", "memory")
	if err := os.MkdirAll(memory, 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(memory, "MEMORY #1%.md")
	if err := os.WriteFile(file, []byte("saved memory"), 0600); err != nil {
		t.Fatal(err)
	}
	workspace := a.state.Workspace
	var revealed []string
	a.SetNative(Native{ShowItemInFolder: func(path string) { revealed = append(revealed, path) }})
	for _, path := range []string{memory, file} {
		args, _ := json.Marshal(map[string]string{"path": path})
		if _, err := a.hostCall(context.Background(), "file.reveal", args); err != nil {
			t.Fatal(err)
		}
		if revealed[len(revealed)-1] != path {
			t.Fatalf("path changed: %q", revealed)
		}
	}
	if len(revealed) != 2 || a.state.Workspace != workspace {
		t.Fatal("revealing memory must not switch the active workspace")
	}
	if data, err := os.ReadFile(file); err != nil || string(data) != "saved memory" {
		t.Fatalf("memory file changed: %q, %v", data, err)
	}
}

func TestRevealFileRejectsInvalidPathsAndHeadlessMode(t *testing.T) {
	calls := 0
	native := Native{ShowItemInFolder: func(string) { calls++ }}
	for _, path := range []string{"", "relative/memory", "https://example.com/memory", filepath.Join(t.TempDir(), "missing")} {
		if err := revealLocalPath(native, path); err == nil {
			t.Fatalf("accepted invalid path %q", path)
		}
	}
	if calls != 0 {
		t.Fatal("invalid paths reached the file manager")
	}
	if err := revealLocalPath(Native{}, t.TempDir()); err == nil || !strings.Contains(err.Error(), "desktop mode") {
		t.Fatalf("headless mode should report a useful error: %v", err)
	}
}
