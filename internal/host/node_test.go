package host

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestCheckNodeVersion(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix executable fixture; real Node is covered by integration tests")
	}
	for _, version := range []string{"v20.19.0", "v22.0.0", "v24.14.0", "not-node"} {
		t.Run(version, func(t *testing.T) {
			filename := filepath.Join(t.TempDir(), "node")
			if err := os.WriteFile(filename, []byte("#!/bin/sh\nprintf '%s\\n' '"+version+"'\n"), 0700); err != nil {
				t.Fatal(err)
			}
			info, err := CheckNode(context.Background(), filename, t.TempDir())
			valid := strings.HasPrefix(version, "v22.") || strings.HasPrefix(version, "v24.")
			if valid && (err != nil || info.Version != version || info.Executable != filename) {
				t.Fatalf("valid Node rejected: %+v %v", info, err)
			}
			if !valid && err == nil {
				t.Fatal("accepted invalid or unsupported Node version")
			}
		})
	}
}

func fakeNode(t *testing.T, filename string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(filename), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filename, []byte("test executable"), 0700); err != nil {
		t.Fatal(err)
	}
}

func TestFindNodeRespectsExplicitSelection(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix executable fixture")
	}
	filename := filepath.Join(t.TempDir(), "node")
	fakeNode(t, filename)
	if path, err := FindNode(filename, t.TempDir()); err != nil || path != filename {
		t.Fatalf("wrong explicit Node: %q %v", path, err)
	}
	if _, err := FindNode(filepath.Join(t.TempDir(), "missing"), t.TempDir()); err == nil {
		t.Fatal("invalid explicit executable must not silently fall back")
	}
}

func TestFindNodePrefersPATH(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix executable fixture")
	}
	bin, home := t.TempDir(), t.TempDir()
	fakeNode(t, filepath.Join(bin, "node"))
	fakeNode(t, filepath.Join(home, ".volta", "bin", "node"))
	t.Setenv("PATH", bin)
	if path, err := FindNode("", home); err != nil || path != filepath.Join(bin, "node") {
		t.Fatalf("PATH priority lost: %q %v", path, err)
	}
}

func TestFindNodeWithFinderPATH(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix executable fixture")
	}
	home := t.TempDir()
	filename := filepath.Join(home, ".local", "share", "fnm", "aliases", "default", "bin", "node")
	fakeNode(t, filename)
	t.Setenv("PATH", t.TempDir())
	if path, err := FindNode("", home); err != nil || path != filename {
		t.Fatalf("fnm default was not found without shell PATH: %q %v", path, err)
	}
}
