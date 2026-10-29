package server

import (
	"context"
	"testing"
)

func TestGitCommandSuppressesWindowsConsole(t *testing.T) {
	cmd := gitCommand(context.Background(), t.TempDir(), "status", "--porcelain=v1")
	const createNoWindow = 0x08000000
	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.HideWindow || cmd.SysProcAttr.CreationFlags&createNoWindow == 0 {
		t.Fatalf("background Git must not create or show a console: %+v", cmd.SysProcAttr)
	}
}
