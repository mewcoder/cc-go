//go:build headless

package desktop

import (
	"errors"

	"cc-go/internal/server"
)

func Run(*server.App) error {
	return errors.New("this binary was built with -tags headless; use --web")
}
