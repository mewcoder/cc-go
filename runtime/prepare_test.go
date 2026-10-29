package runtimefiles

import (
	"bytes"
	"context"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPrepareIncludesAllEmbeddedFilesAndRepairsCache(t *testing.T) {
	root := filepath.Join(t.TempDir(), "data with spaces", "runtime")
	script, err := Prepare(root)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(script) != "extension-host.cjs" || filepath.Dir(filepath.Dir(script)) != root {
		t.Fatalf("unexpected runtime location: %s", script)
	}
	err = fs.WalkDir(Files, ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		target := name
		if strings.HasPrefix(name, "deps/") {
			target = "node_modules/" + strings.TrimPrefix(name, "deps/")
		}
		want, err := Files.ReadFile(name)
		if err != nil {
			return err
		}
		got, err := os.ReadFile(filepath.Join(filepath.Dir(script), filepath.FromSlash(target)))
		if err != nil {
			return err
		}
		if !bytes.Equal(got, want) {
			t.Errorf("incorrect embedded file: %s", name)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	dependency := filepath.Join(filepath.Dir(script), "node_modules", "picomatch", "index.js")
	if err := os.WriteFile(dependency, []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	again, err := Prepare(root)
	if err != nil || again != script {
		t.Fatalf("same embedded runtime must reuse its directory: %s %v", again, err)
	}
	got, err := os.ReadFile(dependency)
	want, _ := Files.ReadFile("deps/picomatch/index.js")
	if err != nil || !bytes.Equal(got, want) {
		t.Fatalf("cached dependency was not restored: %v", err)
	}
}

func TestPreparedRuntimeNeedsNoExternalNodeModules(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node.js is not installed")
	}
	script, err := Prepare(filepath.Join(t.TempDir(), "runtime"))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, node, "-e", `
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const load = createRequire(process.argv[1]);
assert.equal(typeof load('./vscode-api.cjs').createVscodeApi, 'function');
assert.equal(load('./vscode-types.cjs').Uri.file('/test/file.txt').scheme, 'file');
const matches = load('picomatch')('**/*.go');
assert.ok(matches('internal/server/app.go'));
assert.ok(!matches('web/shell.js'));
assert.equal(load('vscode-uri').URI.parse('https://example.com/path').authority, 'example.com');
console.log('standalone-runtime-ok');
`, script)
	cmd.Dir = t.TempDir()
	for _, value := range os.Environ() {
		key, _, _ := strings.Cut(value, "=")
		if !strings.EqualFold(key, "NODE_PATH") && !strings.EqualFold(key, "NODE_OPTIONS") {
			cmd.Env = append(cmd.Env, value)
		}
	}
	out, err := cmd.CombinedOutput()
	if err != nil || strings.TrimSpace(string(out)) != "standalone-runtime-ok" {
		t.Fatalf("standalone runtime failed: %v\n%s", err, out)
	}
}

func TestPrepareReportsUnwritableDestination(t *testing.T) {
	root := filepath.Join(t.TempDir(), "file-not-directory")
	if err := os.WriteFile(root, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Prepare(root); err == nil {
		t.Fatal("preparing runtime beneath a file must fail")
	}
}
