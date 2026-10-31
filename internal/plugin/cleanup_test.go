package plugin

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCleanupCacheKeepsActiveInstallationAndUserFiles(t *testing.T) {
	for _, externalArchive := range []bool{false, true} {
		t.Run(map[bool]string{false: "managed", true: "imported"}[externalArchive], func(t *testing.T) {
			directory := t.TempDir()
			write := func(name string) string {
				t.Helper()
				filename := filepath.Join(directory, name)
				if err := os.MkdirAll(filepath.Dir(filename), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filename, []byte("keep"), 0600); err != nil {
					t.Fatal(err)
				}
				return filename
			}
			prepared, err := Prepare(makeArchive(t, nil), filepath.Join(directory, "extensions"), Platform(), "1.2.3")
			if err != nil {
				t.Fatal(err)
			}
			archive := write("vsix/claude-code-1.2.3-" + Platform() + ".vsix")
			if externalArchive {
				archive = makeArchive(t, nil)
			}
			oldRoot := "extensions/" + strings.Repeat("b", 64) + "-12345"
			legacyRoot := "extensions/" + strings.Repeat("c", 64)
			write(oldRoot + "/.receipt.json")
			write(legacyRoot + "/.receipt.json")
			oldDownload := write("vsix/claude-code-1.2.2-" + Platform() + ".vsix")
			oldSnapshot := write("vsix/vscode-" + strings.Repeat("b", 64) + ".vsix")
			keep := []string{archive, prepared.ExtensionPath,
				write("desktop.json"), write("sessions/history.jsonl"), write("vsix/imported.vsix"),
				write("vsix/.download-live.part"), write("extensions/custom/data"),
				write("extensions/" + strings.Repeat("d", 64) + "/unknown"),
			}
			outside := t.TempDir()
			sentinel := filepath.Join(outside, "sentinel")
			if err := os.WriteFile(sentinel, []byte("keep"), 0600); err != nil {
				t.Fatal(err)
			}
			link := filepath.Join(directory, "extensions", strings.Repeat("e", 64))
			if err := os.Symlink(outside, link); err == nil {
				keep = append(keep, link, sentinel)
			}
			if err := CleanupCache(directory, archive, prepared.ExtensionPath); err != nil {
				t.Fatal(err)
			}
			for _, filename := range keep {
				if _, err := os.Lstat(filename); err != nil {
					t.Fatalf("removed protected file %s: %v", filename, err)
				}
			}
			for _, filename := range []string{oldDownload, oldSnapshot, filepath.Join(directory, oldRoot), filepath.Join(directory, legacyRoot)} {
				if _, err := os.Lstat(filename); !os.IsNotExist(err) {
					t.Fatalf("old cache remains: %s: %v", filename, err)
				}
			}
			if err := CleanupCache(directory, archive, prepared.ExtensionPath); err != nil {
				t.Fatal("cleanup is not repeatable:", err)
			}
		})
	}
}

func TestCleanupCacheRejectsUnsafeRoots(t *testing.T) {
	directory, outside := t.TempDir(), t.TempDir()
	filename := filepath.Join(outside, "claude-code-1.2.2-"+Platform()+".vsix")
	if err := os.WriteFile(filename, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(directory, "vsix")); err != nil {
		t.Skip("symlinks unavailable")
	}
	extensionPath := filepath.Join(directory, "extensions", strings.Repeat("a", 64), "extension")
	if err := os.MkdirAll(extensionPath, 0700); err != nil {
		t.Fatal(err)
	}
	if err := CleanupCache(directory, filename, extensionPath); err == nil {
		t.Fatal("accepted symlink cache root")
	}
	if err := CleanupCache(directory, filename, outside); err == nil {
		t.Fatal("accepted unmanaged active extension")
	}
	if _, err := os.Stat(filename); err != nil {
		t.Fatal("removed outside file:", err)
	}
}

func TestCleanupCacheCanonicalizesDataDirectoryAliases(t *testing.T) {
	directory := t.TempDir()
	archive := makeArchive(t, nil)
	prepared, err := Prepare(archive, filepath.Join(directory, "extensions"), Platform(), "1.2.3")
	if err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(t.TempDir(), "data-alias")
	if err := os.Symlink(directory, alias); err != nil {
		t.Skip("symlinks unavailable")
	}
	if err := CleanupCache(alias, archive, prepared.ExtensionPath); err != nil {
		t.Fatal("data directory alias rejected:", err)
	}
	if _, err := os.Stat(prepared.ExtensionPath); err != nil {
		t.Fatal("canonical current installation removed:", err)
	}
}
