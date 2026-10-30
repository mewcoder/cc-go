package plugin

import (
	"archive/zip"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func makeArchive(t *testing.T, extra map[string]string) string {
	t.Helper()
	file := filepath.Join(t.TempDir(), "plugin.vsix")
	f, err := os.Create(file)
	if err != nil {
		t.Fatal(err)
	}
	z := zip.NewWriter(f)
	entries := map[string]string{
		"extension/package.json":  `{"publisher":"Anthropic","name":"claude-code","version":"1.2.3","main":"./extension.cjs"}`,
		"extension/extension.cjs": `module.exports.activate = () => {};`,
		"extension.vsixmanifest":  `<PackageManifest><Metadata><Identity TargetPlatform="` + Platform() + `"/></Metadata></PackageManifest>`,
	}
	for k, v := range extra {
		entries[k] = v
	}
	for name, contents := range entries {
		w, err := z.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(contents)); err != nil {
			t.Fatal(err)
		}
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	return file
}

func TestPrepareAndCacheVerification(t *testing.T) {
	archive := makeArchive(t, nil)
	cache := t.TempDir()
	prepared, err := Prepare(archive, cache, Platform(), "1.2.3")
	if err != nil {
		t.Fatal(err)
	}
	if prepared.PackageJSON["version"] != "1.2.3" {
		t.Fatal("wrong manifest")
	}
	if _, err := Prepare(archive, cache, Platform(), "1.2.3"); err != nil {
		t.Fatal("valid cache should be reusable:", err)
	}
	if err := os.WriteFile(filepath.Join(prepared.ExtensionPath, "extension.cjs"), []byte("altered"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Prepare(archive, cache, Platform(), "1.2.3"); err == nil {
		t.Fatal("accepted changed cache")
	}
}

func TestPrepareDoesNotMoveExtractionDirectory(t *testing.T) {
	archive, cache := makeArchive(t, nil), t.TempDir()
	var opened *os.File
	defer func() {
		if opened != nil {
			_ = opened.Close()
		}
	}()
	ctx := checkingContext{t.Context(), func() {
		if opened != nil {
			return
		}
		entries, err := os.ReadDir(cache)
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range entries {
			if entry.IsDir() {
				// On Windows an open directory can block rename. It must not
				// prevent installation into that same directory.
				opened, err = os.Open(filepath.Join(cache, entry.Name()))
				if err != nil {
					t.Fatal(err)
				}
				if _, err := os.Stat(filepath.Join(opened.Name(), ".complete")); !errors.Is(err, os.ErrNotExist) {
					t.Fatal("unfinished extraction was marked complete:", err)
				}
				return
			}
		}
	}}
	prepared, err := prepare(ctx, archive, cache, Platform(), "")
	if err != nil {
		t.Fatal(err)
	}
	if opened == nil {
		t.Fatal("did not observe extraction")
	}
	root, err := filepath.EvalSymlinks(opened.Name())
	if err != nil || filepath.Dir(prepared.ExtensionPath) != root {
		t.Fatal("extraction directory was moved:", prepared.ExtensionPath, opened.Name(), err)
	}
	if _, err := os.Stat(filepath.Join(root, ".complete")); err != nil {
		t.Fatal("successful extraction was not marked complete:", err)
	}
	reused, err := Prepare(archive, cache, Platform(), "")
	if err != nil || reused.ExtensionPath != prepared.ExtensionPath {
		t.Fatal("completed extraction was not reused:", reused, err)
	}
}

func TestPrepareSkipsInterruptedDirectories(t *testing.T) {
	archive, cache := makeArchive(t, nil), t.TempDir()
	digest, err := fileHash(archive)
	if err != nil {
		t.Fatal(err)
	}
	interrupted := filepath.Join(cache, digest+"-interrupted")
	if err := os.Mkdir(interrupted, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(interrupted, ".receipt.json"), []byte("["), 0600); err != nil {
		t.Fatal(err)
	}
	prepared, err := Prepare(archive, cache, Platform(), "")
	if err != nil || prepared == nil {
		t.Fatal("interrupted extraction prevented retry:", err)
	}
	if filepath.Base(filepath.Dir(prepared.ExtensionPath)) == filepath.Base(interrupted) {
		t.Fatal("reused an interrupted extraction")
	}
	if _, err := os.Stat(interrupted); err != nil {
		t.Fatal("removed a directory that may belong to another installer:", err)
	}
}

func TestPrepareReusesLegacyCache(t *testing.T) {
	archive, cache := makeArchive(t, nil), t.TempDir()
	prepared, err := Prepare(archive, cache, Platform(), "")
	if err != nil {
		t.Fatal(err)
	}
	digest, err := fileHash(archive)
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Dir(prepared.ExtensionPath)
	if err := os.Remove(filepath.Join(root, ".complete")); err != nil {
		t.Fatal(err)
	}
	legacy := filepath.Join(cache, digest)
	if err := os.Rename(root, legacy); err != nil {
		t.Fatal(err)
	}
	reused, err := Prepare(archive, cache, Platform(), "")
	if err != nil || reused == nil {
		t.Fatal("legacy cache was not reused:", err)
	}
	resolved, err := filepath.EvalSymlinks(legacy)
	if err != nil || filepath.Dir(reused.ExtensionPath) != resolved {
		t.Fatal("legacy cache was replaced:", reused.ExtensionPath, err)
	}
}

func TestRejectUnsafeArchives(t *testing.T) {
	for _, name := range []string{"../escape", "/absolute", "extension/../../escape", `C:\escape`, "extension//double", "extension/./dot", ".receipt.json", ".complete", ".COMPLETE"} {
		t.Run(name, func(t *testing.T) {
			archive := makeArchive(t, map[string]string{name: "bad"})
			if _, err := Prepare(archive, t.TempDir(), Platform(), "1.2.3"); err == nil {
				t.Fatal("accepted unsafe path:", name)
			}
		})
	}
}

func TestRejectManifestMismatch(t *testing.T) {
	for name, extra := range map[string]map[string]string{
		"publisher": {"extension/package.json": `{"publisher":"Other","name":"claude-code","version":"1.2.3","main":"extension.cjs"}`},
		"entry":     {"extension/package.json": `{"publisher":"Anthropic","name":"claude-code","version":"1.2.3","main":"../extension.vsixmanifest"}`},
		"platform":  {"extension.vsixmanifest": `<PackageManifest><Metadata><Identity TargetPlatform="wrong"/></Metadata></PackageManifest>`},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Prepare(makeArchive(t, extra), t.TempDir(), Platform(), "1.2.3"); err == nil {
				t.Fatal("accepted mismatched manifest")
			}
		})
	}
	if _, err := Prepare(makeArchive(t, nil), t.TempDir(), Platform(), "9.9.9"); err == nil || !strings.Contains(err.Error(), "version") {
		t.Fatal("accepted wrong version:", err)
	}
}

func TestRejectCaseCollisionsAndSymlinks(t *testing.T) {
	if _, err := Prepare(makeArchive(t, map[string]string{"extension/EXTENSION.cjs": "bad"}), t.TempDir(), Platform(), "1.2.3"); err == nil {
		t.Fatal("accepted a case collision")
	}
	archive := makeArchive(t, nil)
	cache := t.TempDir()
	prepared, err := Prepare(archive, cache, Platform(), "1.2.3")
	if err != nil {
		t.Fatal(err)
	}
	filename := filepath.Join(prepared.ExtensionPath, "extension.cjs")
	b, _ := os.ReadFile(filename)
	outside := filepath.Join(t.TempDir(), "outside.cjs")
	_ = os.WriteFile(outside, b, 0600)
	_ = os.Remove(filename)
	if err := os.Symlink(outside, filename); err != nil {
		t.Skip(err)
	}
	if _, err := Prepare(archive, cache, Platform(), "1.2.3"); err == nil {
		t.Fatal("accepted a cache symlink escape")
	}
}
