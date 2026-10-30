package plugin

import (
	"archive/zip"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Trigger filesystem changes or cancellation at an actual IO checkpoint,
// without sleeps or timing-dependent large fixtures.
type checkingContext struct {
	context.Context
	check func()
}

func (c checkingContext) Err() error {
	c.check()
	return c.Context.Err()
}

func TestInstalledDiscoveryReportsReadFailuresButIgnoresMissingDirectories(t *testing.T) {
	root := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(root, []byte("file"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err := ReuseInstalled(t.Context(), []string{root}, t.TempDir(), t.TempDir(), Platform())
	var pathError *os.PathError
	if err == nil || !errors.As(err, &pathError) || !strings.Contains(err.Error(), root) {
		t.Fatal("directory read error lost its cause or path:", err)
	}
	installed, err := ReuseInstalled(t.Context(), []string{root + "-missing"}, t.TempDir(), t.TempDir(), Platform())
	if err != nil || installed.Prepared != nil {
		t.Fatal("ordinary absent VS Code installation should not be an error:", err)
	}
}

func TestInstalledSnapshotStreamsCorrectHashAndReportsStatFailures(t *testing.T) {
	source := installedFixture(t, t.TempDir(), "2.1.312", Platform())
	archives := t.TempDir()
	archive, err := snapshotInstalled(t.Context(), source, archives)
	if err != nil {
		t.Fatal(err)
	}
	digest, err := fileHash(archive)
	if err != nil || filepath.Base(archive) != "vscode-"+digest+".vsix" {
		t.Fatal("streamed hash did not include the complete ZIP directory:", archive, err)
	}
	removed := false
	ctx := checkingContext{t.Context(), func() {
		parts, _ := filepath.Glob(filepath.Join(archives, ".vscode-*.vsix"))
		for _, part := range parts {
			reader, err := zip.OpenReader(part)
			if err != nil {
				continue
			}
			reader.Close()
			if err := os.Remove(part); err != nil {
				t.Fatal(err)
			}
			removed = true
		}
	}}
	_, err = snapshotInstalled(ctx, source, archives)
	if !removed || !errors.Is(err, os.ErrNotExist) || !strings.Contains(err.Error(), "stat installed extension archive") || strings.Contains(err.Error(), "exceeds") {
		t.Fatal("stat failure was misreported as a size failure:", err)
	}
}

func TestInstalledCopyCancellationCleansPartialArchives(t *testing.T) {
	source := installedFixture(t, t.TempDir(), "2.1.312", Platform())
	archives := t.TempDir()
	parent, cancel := context.WithCancel(t.Context())
	defer cancel()
	ctx := checkingContext{parent, func() {
		parts, _ := filepath.Glob(filepath.Join(archives, ".vscode-*.vsix"))
		if len(parts) > 0 {
			cancel()
		}
	}}
	if _, err := snapshotInstalled(ctx, source, archives); !errors.Is(err, context.Canceled) {
		t.Fatal("local snapshot ignored cancellation:", err)
	}
	entries, _ := os.ReadDir(archives)
	if len(entries) != 0 {
		t.Fatal("cancel left partial local archives")
	}
}

func TestLocalPrepareCancelsExtractionAndCacheVerification(t *testing.T) {
	archive := makeArchive(t, map[string]string{"extension/payload": strings.Repeat("payload", 100000)})
	for _, cached := range []bool{false, true} {
		t.Run(map[bool]string{false: "extract", true: "verify-cache"}[cached], func(t *testing.T) {
			cache := t.TempDir()
			var root string
			if cached {
				prepared, err := Prepare(archive, cache, Platform(), "")
				if err != nil {
					t.Fatal(err)
				}
				root = filepath.Dir(prepared.ExtensionPath)
			}
			parent, cancel := context.WithCancel(t.Context())
			defer cancel()
			checks := 0
			ctx := checkingContext{parent, func() {
				if cached {
					checks++
					if checks == 4 {
						cancel()
					}
					return
				}
				files, _ := filepath.Glob(filepath.Join(cache, "*", "extension", "payload"))
				for _, file := range files {
					if info, err := os.Stat(file); err == nil && info.Size() > 0 {
						cancel()
					}
				}
			}}
			var err error
			if cached {
				err = verifyReceipt(ctx, root)
			} else {
				_, err = prepare(ctx, archive, cache, Platform(), "")
			}
			if !errors.Is(err, context.Canceled) {
				t.Fatal("local preparation ignored cancellation:", err)
			}
			entries, _ := os.ReadDir(cache)
			if !cached && len(entries) != 0 {
				t.Fatal("cancel published a partial extraction")
			}
			if !cached {
				if _, err := Prepare(archive, cache, Platform(), ""); err != nil {
					t.Fatal("could not retry after cancellation:", err)
				}
			}
			if cached {
				if _, err := Prepare(archive, cache, Platform(), ""); err != nil {
					t.Fatal("cancel damaged the existing verified cache:", err)
				}
			}
		})
	}
}
