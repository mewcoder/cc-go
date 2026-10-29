package plugin

import (
	"os/exec"
	"syscall"
)

func configureProbe(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true} }
