package sessions

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDiscoverProjectsFromRecordedPaths(t *testing.T) {
	projects, workspace := t.TempDir(), t.TempDir()
	workspace = filepath.Join(workspace, "project-with_dots.and spaces")
	if err := os.MkdirAll(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	directory := filepath.Join(projects, ProjectDirectory(workspace))
	_ = os.MkdirAll(directory, 0700)
	row, _ := json.Marshal(map[string]string{"cwd": workspace})
	contents := append([]byte("not json\n{\"type\":\"file-history-snapshot\"}\n"), row...)
	filename := filepath.Join(directory, "11111111-1111-1111-1111-111111111111.jsonl")
	_ = os.WriteFile(filename, contents, 0600)
	_ = os.WriteFile(filepath.Join(directory, "22222222-2222-2222-2222-222222222222.jsonl"), row, 0600)
	items, err := Discover(projects)
	if err != nil || len(items) != 1 || items[0].Path != workspace {
		t.Fatalf("unexpected projects: %+v, %v", items, err)
	}
	unchanged, _ := os.ReadFile(filename)
	if string(unchanged) != string(contents) {
		t.Fatal("discovery changed the transcript")
	}
	_ = os.Remove(workspace)
	items, err = Discover(projects)
	if err != nil || len(items) != 0 {
		t.Fatalf("missing workspace must not be offered: %+v, %v", items, err)
	}
}

func TestDiscoverIgnoresUnrelatedAndSymlinkTranscripts(t *testing.T) {
	projects, workspace := t.TempDir(), t.TempDir()
	directory := filepath.Join(projects, ProjectDirectory(workspace))
	_ = os.MkdirAll(directory, 0700)
	row, _ := json.Marshal(map[string]string{"cwd": workspace})
	_ = os.WriteFile(filepath.Join(directory, "not-a-session.jsonl"), row, 0600)
	other := filepath.Join(projects, "wrong-encoding")
	_ = os.MkdirAll(other, 0700)
	_ = os.WriteFile(filepath.Join(other, "11111111-1111-1111-1111-111111111111.jsonl"), row, 0600)
	outside := filepath.Join(t.TempDir(), "transcript.jsonl")
	_ = os.WriteFile(outside, row, 0600)
	// Symlink creation can be unavailable on Windows; the other cases still run.
	_ = os.Symlink(outside, filepath.Join(directory, "22222222-2222-2222-2222-222222222222.jsonl"))
	items, err := Discover(projects)
	if err != nil || len(items) != 0 {
		t.Fatalf("unexpected projects: %+v, %v", items, err)
	}
}

func TestDiscoverMissingProjectsIsEmpty(t *testing.T) {
	items, err := Discover(filepath.Join(t.TempDir(), "missing"))
	if err != nil || items == nil || len(items) != 0 {
		t.Fatalf("expected empty list: %+v, %v", items, err)
	}
}

func TestDiscoverIgnoresSDKOnlyProjectsAndSDKRecency(t *testing.T) {
	projects := t.TempDir()
	for _, sdkOnly := range []bool{false, true} {
		workspace := t.TempDir()
		directory := filepath.Join(projects, ProjectDirectory(workspace))
		if err := os.MkdirAll(directory, 0700); err != nil {
			t.Fatal(err)
		}
		for _, sdk := range []bool{false, true} {
			if sdkOnly && !sdk {
				continue
			}
			id, entrypoint, updated := "11111111-1111-1111-1111-111111111111", "cli", int64(1000)
			if sdk {
				id, entrypoint, updated = "22222222-2222-2222-2222-222222222222", "sdk-cli", 5000
			}
			row, _ := json.Marshal(map[string]string{"cwd": workspace, "entrypoint": entrypoint})
			filename := filepath.Join(directory, id+".jsonl")
			if err := os.WriteFile(filename, row, 0600); err != nil {
				t.Fatal(err)
			}
			stamp := time.UnixMilli(updated)
			if err := os.Chtimes(filename, stamp, stamp); err != nil {
				t.Fatal(err)
			}
		}
	}
	items, err := Discover(projects)
	if err != nil || len(items) != 1 || items[0].UpdatedAt != 1000 {
		t.Fatalf("SDK history affected project discovery: %+v, %v", items, err)
	}
}

func TestDiscoverSortsByNewestValidTranscript(t *testing.T) {
	projects, root := t.TempDir(), t.TempDir()
	write := func(path, id, contents string, updatedAt int64) {
		t.Helper()
		directory := filepath.Join(projects, ProjectDirectory(path))
		if err := os.MkdirAll(directory, 0700); err != nil {
			t.Fatal(err)
		}
		filename := filepath.Join(directory, id+".jsonl")
		if err := os.WriteFile(filename, []byte(contents), 0600); err != nil {
			t.Fatal(err)
		}
		stamp := time.UnixMilli(updatedAt)
		if err := os.Chtimes(filename, stamp, stamp); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"a", "b", "c"} {
		path := filepath.Join(root, name)
		if err := os.MkdirAll(path, 0700); err != nil {
			t.Fatal(err)
		}
		row, _ := json.Marshal(map[string]string{"cwd": path})
		write(path, "11111111-1111-1111-1111-111111111111", string(row), 1000)
		if name != "a" {
			write(path, "22222222-2222-2222-2222-222222222222", string(row), 3000)
		}
		// A newer invalid transcript must not promote an old project.
		write(path, "33333333-3333-3333-3333-333333333333", "not json", 5000)
	}
	for range 2 {
		items, err := Discover(projects)
		if err != nil || len(items) != 3 {
			t.Fatalf("discovery: %+v %v", items, err)
		}
		for i, name := range []string{"b", "c", "a"} {
			if items[i].Path != filepath.Join(root, name) {
				t.Fatalf("not recent-first with stable ties: %+v", items)
			}
		}
		if items[0].UpdatedAt != 3000 || items[2].UpdatedAt != 1000 {
			t.Fatalf("wrong transcript times: %+v", items)
		}
	}
}
