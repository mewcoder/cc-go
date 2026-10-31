package server

import (
	"errors"
	"os"
	"path/filepath"
)

func revealLocalPath(native Native, path string) error {
	if !filepath.IsAbs(path) {
		return errors.New("revealing a file requires an absolute local path")
	}
	if _, err := os.Stat(path); err != nil {
		return err
	}
	if native.ShowItemInFolder == nil {
		return errors.New("revealing a file requires desktop mode")
	}
	native.ShowItemInFolder(path)
	return nil
}
