package plugin

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
)

var cacheDirectoryName = regexp.MustCompile(`^[a-f0-9]{64}(?:-[0-9]+)?$`)
var cacheArchiveName = regexp.MustCompile(`^(?:vscode-[a-f0-9]{64}|claude-code-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?-(?:darwin|win32|linux)-(?:x64|arm64|armhf|ia32))\.vsix$`)

// CleanupCache removes only host-owned installations after successful activation.
// Imported originals, unknown files and symlinks are never cleanup candidates.
func CleanupCache(directory, archive, extensionPath string) error {
	// Prepare resolves symlinks, including macOS /var -> /private/var. Compare
	// canonical paths so the current installation cannot look like an old one.
	directory, err := filepath.EvalSymlinks(directory)
	if err != nil {
		return err
	}
	directory, err = filepath.Abs(directory)
	if err != nil {
		return err
	}
	archive, err = filepath.EvalSymlinks(archive)
	if err != nil {
		return err
	}
	archive, err = filepath.Abs(archive)
	if err != nil {
		return err
	}
	extensionPath, err = filepath.EvalSymlinks(extensionPath)
	if err != nil {
		return err
	}
	extensionPath, err = filepath.Abs(extensionPath)
	if err != nil {
		return err
	}
	active := filepath.Dir(extensionPath)
	if filepath.Base(extensionPath) != "extension" || filepath.Dir(active) != filepath.Join(directory, "extensions") {
		return errors.New("active extension is outside the managed cache")
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return err
	}
	defer root.Close()
	var failures []error
	for _, kind := range []string{"vsix", "extensions"} {
		info, err := root.Lstat(kind)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			failures = append(failures, err)
			continue
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			failures = append(failures, errors.New("unsafe plugin cache directory: "+kind))
			continue
		}
		cache, err := root.OpenRoot(kind)
		if err != nil {
			failures = append(failures, err)
			continue
		}
		listing, err := cache.Open(".")
		if err != nil {
			failures = append(failures, err)
			cache.Close()
			continue
		}
		entries, err := listing.ReadDir(-1)
		listing.Close()
		if err != nil {
			failures = append(failures, err)
			cache.Close()
			continue
		}
		for _, entry := range entries {
			name := entry.Name()
			filename := filepath.Join(directory, kind, name)
			if filename == archive || filename == active || entry.Type()&os.ModeSymlink != 0 {
				continue
			}
			if kind == "vsix" {
				if !entry.Type().IsRegular() || !cacheArchiveName.MatchString(name) {
					continue
				}
			} else {
				if !entry.IsDir() || !cacheDirectoryName.MatchString(name) {
					continue
				}
				// A digest-shaped directory alone is not proof of ownership.
				receipt, err := cache.Lstat(filepath.Join(name, ".receipt.json"))
				if err != nil || !receipt.Mode().IsRegular() {
					continue
				}
			}
			if err := cache.RemoveAll(name); err != nil {
				failures = append(failures, err)
			}
		}
		cache.Close()
	}
	return errors.Join(failures...)
}
