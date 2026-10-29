package host

import (
	"os/exec"
	"strconv"
	"syscall"
)

func configureProcess(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true} }

func configureProbe(cmd *exec.Cmd) { configureProcess(cmd) }

func terminateProcess(cmd *exec.Cmd) {
	if cmd.Process != nil {
		kill := exec.Command("taskkill", "/PID", strconv.Itoa(cmd.Process.Pid), "/T", "/F")
		configureProcess(kill)
		_ = kill.Run()
	}
}
