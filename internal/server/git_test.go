package server

import (
	"context"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestGitCommandPreservesArgumentsAndIsolatesEnvironment(t *testing.T) {
	t.Setenv("GIT_DIR", "wrong-repository")
	t.Setenv("GIT_WORK_TREE", "wrong-worktree")
	t.Setenv("GIT_CONFIG_COUNT", "1")
	t.Setenv("GIT_CONFIG_KEY_0", "core.fsmonitor")
	t.Setenv("GIT_CONFIG_VALUE_0", "unexpected-command")
	t.Setenv("CC_GO_GIT_TEST", "preserved")
	directory := filepath.Join(t.TempDir(), "workspace with spaces")
	args := []string{"status", "--porcelain=v1", "-z"}
	cmd := gitCommand(context.Background(), directory, args...)
	want := append([]string{"-C", directory, "-c", "core.fsmonitor=false"}, args...)
	if !reflect.DeepEqual(cmd.Args[1:], want) {
		t.Fatalf("Git arguments were changed or shell-quoted: %q", cmd.Args)
	}
	if name := strings.TrimSuffix(strings.ToLower(filepath.Base(cmd.Path)), ".exe"); name != "git" {
		t.Fatalf("expected Git directly, not a shell: %q", cmd.Path)
	}
	env := make(map[string]string)
	for _, value := range cmd.Env {
		key, value, ok := strings.Cut(value, "=")
		if !ok {
			continue
		}
		if strings.HasPrefix(key, "GIT_") && key != "GIT_OPTIONAL_LOCKS" {
			t.Fatalf("inherited a Git override: %s", key)
		}
		env[key] = value
	}
	if env["GIT_OPTIONAL_LOCKS"] != "0" || env["LC_ALL"] != "C" || env["CC_GO_GIT_TEST"] != "preserved" {
		t.Fatalf("missing Git command environment: %v", env)
	}
}

func TestGitCommandHonorsCancellation(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("Git unavailable")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := gitCommand(ctx, t.TempDir(), "status").Run(); err != context.Canceled {
		t.Fatalf("expected context cancellation, got %v", err)
	}
}
