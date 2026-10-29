//go:build !windows

package plugin

import "os/exec"

func configureProbe(*exec.Cmd) {}
