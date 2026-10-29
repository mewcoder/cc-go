package plugin

import (
	"archive/zip"
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

func TestRejectUnsafeArchives(t *testing.T) {
	for _, name := range []string{"../escape", "/absolute", "extension/../../escape", `C:\escape`, "extension//double", "extension/./dot", ".receipt.json"} {
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
