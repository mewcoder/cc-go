package server

import (
	"os"
	"path/filepath"

	webfiles "cc-go/web"
)

// Development reads saved sources on each request; packaged apps keep embedded assets.
func (a *App) readWebFile(name string) ([]byte, error) {
	if a.cfg.DevAssets != "" {
		return os.ReadFile(filepath.Join(a.cfg.DevAssets, name))
	}
	return webfiles.Files.ReadFile(name)
}
