//go:build headless

package desktop

import (
	"errors"

	"cc-go/internal/server"
)

func AcquireSingleInstanceLock() bool { return true }

func Run(*server.App) error {
	return errors.New("this binary was built with -tags headless; use --web")
}
