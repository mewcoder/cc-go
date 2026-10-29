package server

import (
	"os/exec"
	"syscall"
)

func configureBackgroundProcess(cmd *exec.Cmd) {
	// GUI executables do not prevent console-subsystem children from opening
	// their own console. Suppress its creation as well as its initial display.
	const createNoWindow = 0x08000000
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}
