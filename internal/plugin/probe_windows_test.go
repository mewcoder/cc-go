package plugin

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestDetectWindowsNpmLauncherWithoutShell(t *testing.T) {
	node, err := exec.LookPath("node.exe")
	if err != nil {
		t.Skip("Node.js is not installed")
	}
	directory := t.TempDir()
	launcher := filepath.Join(directory, "claude.cmd")
	// This batch launcher must never be executed; Detect invokes the JS entry.
	if err := os.WriteFile(launcher, []byte("@exit /b 99\r\n"), 0600); err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(directory, "node_modules", "@anthropic-ai", "claude-code", "cli.js")
	if err := os.MkdirAll(filepath.Dir(script), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(script, []byte("console.log('1.2.3 (Claude Code)');\n"), 0600); err != nil {
		t.Fatal(err)
	}
	version, err := Detect(context.Background(), launcher, node)
	if err != nil || version != "1.2.3" {
		t.Fatalf("npm CLI detection failed: %q %v", version, err)
	}
}
