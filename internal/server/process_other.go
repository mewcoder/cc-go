//go:build !windows

package server

import "os/exec"

func configureBackgroundProcess(*exec.Cmd) {}
