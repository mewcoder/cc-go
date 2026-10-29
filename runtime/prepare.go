package runtimefiles

import (
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Prepare installs the embedded host and its dependencies into a versioned
// data directory, so the executable needs no adjacent node_modules directory.
func Prepare(root string) (string, error) {
	var names []string
	hash := sha256.New()
	err := fs.WalkDir(Files, ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		data, err := Files.ReadFile(name)
		if err != nil {
			return err
		}
		names = append(names, name)
		hash.Write([]byte(name + "\x00"))
		hash.Write(data)
		return nil
	})
	if err != nil {
		return "", err
	}
	directory := filepath.Join(root, hex.EncodeToString(hash.Sum(nil))[:16])
	for _, name := range names {
		target := name
		if strings.HasPrefix(name, "deps/") {
			target = "node_modules/" + strings.TrimPrefix(name, "deps/")
		}
		filename := filepath.Join(directory, filepath.FromSlash(target))
		if err := os.MkdirAll(filepath.Dir(filename), 0700); err != nil {
			return "", err
		}
		data, err := Files.ReadFile(name)
		if err != nil {
			return "", err
		}
		if err := os.WriteFile(filename, data, 0600); err != nil {
			return "", err
		}
	}
	return filepath.Join(directory, "extension-host.cjs"), nil
}
