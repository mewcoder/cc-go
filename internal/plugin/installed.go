package plugin

import (
	"archive/zip"
	"compress/flate"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Installed directories are executable code trusted by the current user, just
// like a manually imported VSIX. They are not authenticated registry downloads.
type Installed struct {
	Archive  string
	Prepared *Prepared
}

func VSCodeExtensionDirectories(home, portable string) []string {
	roots := []string{filepath.Join(home, ".vscode", "extensions"), filepath.Join(home, ".vscode-insiders", "extensions")}
	if filepath.IsAbs(portable) {
		roots = append([]string{filepath.Join(portable, "extensions")}, roots...)
	}
	return roots
}

// ReuseInstalled snapshots the newest usable stable extension into our own
// archive/cache. VS Code updates/removal must not break an initialized host.
func ReuseInstalled(ctx context.Context, roots []string, archives, cache, platform string) (Installed, error) {
	type candidate struct{ directory, version string }
	var candidates []candidate
	var failures []error
	for _, root := range roots {
		if err := ctx.Err(); err != nil {
			return Installed{}, err
		}
		entries, err := os.ReadDir(root)
		if err != nil {
			if !os.IsNotExist(err) {
				failures = append(failures, fmt.Errorf("read VS Code extensions directory: %w", err))
			}
			continue
		}
		obsolete, err := readObsolete(filepath.Join(root, ".obsolete"))
		if err != nil {
			failures = append(failures, err)
			continue
		}
		for _, entry := range entries {
			if err := ctx.Err(); err != nil {
				return Installed{}, err
			}
			if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 || !strings.HasPrefix(strings.ToLower(entry.Name()), "anthropic.claude-code-") || obsolete[entry.Name()] {
				continue
			}
			directory := filepath.Join(root, entry.Name())
			prepared, err := validateExtension(directory, filepath.Join(directory, ".vsixmanifest"), platform, "")
			if err != nil {
				continue
			}
			version := prepared.PackageJSON["version"].(string)
			metadata, _ := prepared.PackageJSON["__metadata"].(map[string]any)
			if prerelease(version) || metadata["isPreReleaseVersion"] == true || metadata["targetPlatform"] != nil && metadata["targetPlatform"] != platform {
				continue
			}
			if _, err := BundledRuntime(directory, platform); err == nil {
				candidates = append(candidates, candidate{directory, version})
			}
		}
	}
	sort.SliceStable(candidates, func(i, j int) bool { return NewerVersion(candidates[i].version, candidates[j].version) })
	for _, item := range candidates {
		if err := ctx.Err(); err != nil {
			return Installed{}, err
		}
		if err := privateImportDirectories(item.directory, archives, cache); err != nil {
			failures = append(failures, err)
			continue
		}
		archive, err := snapshotInstalled(ctx, item.directory, archives)
		if err != nil {
			failures = append(failures, err)
			continue
		}
		prepared, err := prepare(ctx, archive, cache, platform, item.version)
		if err == nil {
			_, err = BundledRuntime(prepared.ExtensionPath, platform)
		}
		if err != nil {
			failures = append(failures, err)
			continue
		}
		if err := ctx.Err(); err != nil {
			return Installed{}, err
		}
		return Installed{Archive: archive, Prepared: prepared}, nil
	}
	if err := ctx.Err(); err != nil {
		return Installed{}, err
	}
	return Installed{}, errors.Join(failures...)
}

func readObsolete(filename string) (map[string]bool, error) {
	obsolete := make(map[string]bool)
	file, err := os.Open(filename)
	if os.IsNotExist(err) {
		return obsolete, nil
	}
	if err == nil {
		defer file.Close()
		var b []byte
		b, err = io.ReadAll(io.LimitReader(file, (1<<20)+1))
		if err == nil && len(b) > 1<<20 {
			err = errors.New("obsolete list exceeds 1 MiB")
		}
		if err == nil {
			err = json.Unmarshal(b, &obsolete)
		}
	}
	if err != nil {
		return nil, fmt.Errorf("read VS Code obsolete list %s: %w", filename, err)
	}
	return obsolete, nil
}

// Check existing ancestors too: the data directory may not exist yet, or its
// parent may be a symlink into VS Code's installation.
func privateImportDirectories(source string, destinations ...string) error {
	resolvedSource, err := filepath.EvalSymlinks(source)
	if err != nil {
		return err
	}
	for _, destination := range destinations {
		parent, err := filepath.Abs(destination)
		if err != nil {
			return err
		}
		var suffix []string
		for {
			resolved, err := filepath.EvalSymlinks(parent)
			if err == nil {
				for i := len(suffix) - 1; i >= 0; i-- {
					resolved = filepath.Join(resolved, suffix[i])
				}
				relative, err := filepath.Rel(resolvedSource, resolved)
				if err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
					return errors.New("import cache must be outside the installed VS Code extension")
				}
				break
			}
			if !os.IsNotExist(err) || filepath.Dir(parent) == parent {
				return err
			}
			suffix = append(suffix, filepath.Base(parent))
			parent = filepath.Dir(parent)
		}
	}
	return nil
}

func snapshotInstalled(ctx context.Context, source, archives string) (string, error) {
	root, err := os.OpenRoot(source)
	if err != nil {
		return "", err
	}
	defer root.Close()
	if err := os.MkdirAll(archives, 0700); err != nil {
		return "", err
	}
	file, err := os.CreateTemp(archives, ".vscode-*.vsix")
	if err != nil {
		return "", err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	hash := sha256.New()
	writer := zip.NewWriter(io.MultiWriter(file, hash))
	writer.RegisterCompressor(zip.Deflate, func(w io.Writer) (io.WriteCloser, error) { return flate.NewWriter(w, flate.BestSpeed) })
	var total int64
	var count int
	err = filepath.WalkDir(source, func(filename string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("symlink in installed extension")
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return errors.New("special file in installed extension")
		}
		total += info.Size()
		count++
		if total > MaxExpanded || count > 50000 {
			return errors.New("installed extension exceeds import limits")
		}
		relative, err := filepath.Rel(source, filename)
		if err != nil {
			return err
		}
		name := "extension/" + filepath.ToSlash(relative)
		if relative == ".vsixmanifest" {
			name = "extension.vsixmanifest"
		}
		if _, err := safeName(name); err != nil {
			return err
		}
		header, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		header.Name, header.Method = name, zip.Deflate
		output, err := writer.CreateHeader(header)
		if err != nil {
			return err
		}
		input, err := root.Open(relative)
		if err != nil {
			return err
		}
		n, copyErr := io.Copy(output, contextReader{ctx, io.LimitReader(input, info.Size()+1)})
		closeErr := input.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		if n != info.Size() {
			return errors.New("installed extension changed during import")
		}
		return nil
	})
	zipErr := writer.Close()
	closeErr := file.Close()
	if err != nil {
		return "", err
	}
	if zipErr != nil {
		return "", zipErr
	}
	if closeErr != nil {
		return "", closeErr
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	info, err := os.Stat(file.Name())
	if err != nil {
		return "", fmt.Errorf("stat installed extension archive: %w", err)
	}
	if info.Size() > MaxArchive {
		return "", errors.New("installed extension archive exceeds import limits")
	}
	digest := hex.EncodeToString(hash.Sum(nil))
	destination := filepath.Join(archives, "vscode-"+digest+".vsix")
	if info, err := os.Lstat(destination); err == nil {
		if !info.Mode().IsRegular() {
			return "", errors.New("unsafe installed extension archive cache")
		}
		existing, err := fileHashContext(ctx, destination)
		if err != nil {
			return "", err
		}
		if existing != digest {
			return "", errors.New("installed extension archive cache altered")
		}
		return destination, nil
	} else if !os.IsNotExist(err) {
		return "", err
	}
	if err := os.Rename(file.Name(), destination); err != nil {
		return "", fmt.Errorf("cache installed extension: %w", err)
	}
	return destination, nil
}
