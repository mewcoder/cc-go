package server

import (
	"context"
	"os"
	"os/exec"
	"strings"
)

func gitCommand(ctx context.Context, directory string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", directory, "-c", "core.fsmonitor=false"}, args...)...)
	configureBackgroundProcess(cmd)
	for _, value := range os.Environ() {
		if !strings.HasPrefix(value, "GIT_") {
			cmd.Env = append(cmd.Env, value)
		}
	}
	cmd.Env = append(cmd.Env, "GIT_OPTIONAL_LOCKS=0", "LC_ALL=C")
	return cmd
}
