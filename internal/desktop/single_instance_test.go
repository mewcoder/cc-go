//go:build !headless

package desktop

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestSingleInstanceProcess(t *testing.T) {
	if os.Getenv("CC_GO_SINGLE_INSTANCE_HELPER") != "1" {
		return
	}
	if !AcquireSingleInstanceLock() {
		fmt.Println("existing")
		os.Exit(0)
	}
	fmt.Println("acquired")
	_, _ = io.Copy(io.Discard, os.Stdin)
	os.Exit(0)
}

func TestDuplicateLaunchExitsAndCrashDoesNotPreventRelaunch(t *testing.T) {
	// Keep the socket path short and isolated from the user's running client.
	root := ""
	if runtime.GOOS != "windows" {
		root = "/tmp"
	}
	directory, err := os.MkdirTemp(root, "cci-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	command := func() *exec.Cmd {
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestSingleInstanceProcess$")
		cmd.Env = append(os.Environ(), "CC_GO_SINGLE_INSTANCE_HELPER=1",
			"XDG_RUNTIME_DIR="+directory, "TMPDIR="+directory, "TMP="+directory, "TEMP="+directory)
		return cmd
	}
	first := command()
	input, err := first.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := first.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = input.Close()
		_ = first.Process.Kill()
		_ = first.Wait()
	})
	lines := bufio.NewScanner(output)
	if !lines.Scan() || lines.Text() != "acquired" {
		t.Fatal("first process did not acquire the instance lock:", lines.Text(), lines.Err())
	}
	second, err := command().CombinedOutput()
	if err != nil || strings.TrimSpace(string(second)) != "existing" {
		t.Fatalf("second launch was not forwarded: %s (%v)", second, err)
	}
	// Simulate an abrupt exit, which leaves a stale socket behind.
	if err := first.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = first.Wait()
	restarted, err := command().CombinedOutput()
	if err != nil || strings.TrimSpace(string(restarted)) != "acquired" {
		t.Fatalf("stale lock blocked relaunch: %s (%v)", restarted, err)
	}
}
