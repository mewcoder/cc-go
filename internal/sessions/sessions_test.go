package sessions

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestListTitlesMetadataAndBounds(t *testing.T) {
	projects, workspace := t.TempDir(), t.TempDir()
	directory := filepath.Join(projects, ProjectDirectory(workspace))
	_ = os.MkdirAll(directory, 0700)
	id := "11111111-1111-1111-1111-111111111111"
	contents := `{"type":"user","message":{"content":[{"type":"text","text":"First question"}]}}
{"type":"custom-title","customTitle":"Custom title"}
{"type":"custom-title","customTitle":"Latest custom title"}
`
	_ = os.WriteFile(filepath.Join(directory, id+".jsonl"), []byte(contents), 0600)
	_ = os.WriteFile(filepath.Join(directory, "not-a-session.jsonl"), []byte(contents), 0600)
	items := List(projects, workspace, nil)
	if len(items) != 1 || items[0].Title != "Latest custom title" {
		t.Fatalf("unexpected sessions: %+v", items)
	}
	items = List(projects, workspace, map[string]Metadata{Key(workspace, id): {Title: "Desktop name", Archived: true}})
	if len(items) != 1 || items[0].Title != "Desktop name" || !items[0].Archived {
		t.Fatalf("metadata not applied: %+v", items)
	}
	b, _ := os.ReadFile(filepath.Join(directory, id+".jsonl"))
	if string(b) != contents {
		t.Fatal("original transcript was changed")
	}
}

func TestProjectDirectoryMatchesClaudeEncoding(t *testing.T) {
	if got := ProjectDirectory("/Users/test/my_project.demo"); got != "-Users-test-my-project-demo" {
		t.Fatal(got)
	}
}

func TestListCreationTimeSurvivesMetadataAndLaterUpdates(t *testing.T) {
	projects, workspace := t.TempDir(), t.TempDir()
	directory := filepath.Join(projects, ProjectDirectory(workspace))
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	id := "11111111-1111-1111-1111-111111111111"
	filename := filepath.Join(directory, id+".jsonl")
	contents := `{"type":"file-history-snapshot"}
{"type":"user","timestamp":"2026-10-29T08:00:00.123Z","message":{"content":"Hello"}}
{"type":"assistant","timestamp":"2026-10-30T08:00:00Z"}
`
	if err := os.WriteFile(filename, []byte(contents), 0600); err != nil {
		t.Fatal(err)
	}
	want := time.Date(2026, 10, 29, 8, 0, 0, 123000000, time.UTC).UnixMilli()
	for _, updated := range []int64{want + 1000, want + 2000} {
		stamp := time.UnixMilli(updated)
		if err := os.Chtimes(filename, stamp, stamp); err != nil {
			t.Fatal(err)
		}
		items := List(projects, workspace, map[string]Metadata{Key(workspace, id): {Title: "Renamed"}})
		if len(items) != 1 || items[0].CreatedAt != want || items[0].UpdatedAt != time.Date(2026, 10, 30, 8, 0, 0, 0, time.UTC).UnixMilli() {
			t.Fatalf("unexpected timestamps: %+v", items)
		}
	}
}

func TestReadCreationTimeSkipsInvalidTimestampsAndHandlesLegacyTranscripts(t *testing.T) {
	for _, tc := range []struct {
		name, contents string
		want           int64
	}{
		{"legacy", `{"type":"user","message":{"content":"Hello"}}`, 0},
		{"invalid", "bad json\n{\"timestamp\":42}\n{\"timestamp\":\"invalid\"}\n{\"timestamp\":\"2026-10-29T16:00:00+08:00\"}\n", time.Date(2026, 10, 29, 8, 0, 0, 0, time.UTC).UnixMilli()},
	} {
		t.Run(tc.name, func(t *testing.T) {
			filename := filepath.Join(t.TempDir(), "session.jsonl")
			if err := os.WriteFile(filename, []byte(tc.contents), 0600); err != nil {
				t.Fatal(err)
			}
			if got := readCreatedAt(filename); got != tc.want {
				t.Fatalf("creation time = %d, want %d", got, tc.want)
			}
		})
	}
}

func TestListFiltersNonInteractiveHistoryBeforeLimitAndMetadata(t *testing.T) {
	projects, workspace := t.TempDir(), t.TempDir()
	directory := filepath.Join(projects, ProjectDirectory(workspace))
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	metadata := make(map[string]Metadata)
	for i := range 105 {
		id := fmt.Sprintf("10000000-0000-4000-8000-%012d", i)
		contents := `{"type":"queue-operation"}` + "\n" + `{"type":"user","entrypoint":"sdk-cli","message":{"content":"SDK task"}}` + "\n"
		filename := filepath.Join(directory, id+".jsonl")
		if err := os.WriteFile(filename, []byte(contents), 0600); err != nil {
			t.Fatal(err)
		}
		metadata[Key(workspace, id)] = Metadata{Title: "Renamed SDK task", Archived: true}
	}
	id := "20000000-0000-4000-8000-000000000000"
	filename := filepath.Join(directory, id+".jsonl")
	contents := `{"type":"user","entrypoint":"cli","message":{"content":"Normal chat"}}` + "\n"
	if err := os.WriteFile(filename, []byte(contents), 0600); err != nil {
		t.Fatal(err)
	}
	old := time.Unix(1, 0)
	if err := os.Chtimes(filename, old, old); err != nil {
		t.Fatal(err)
	}
	items := List(projects, workspace, metadata)
	if len(items) != 1 || items[0].ID != id || items[0].Title != "Normal chat" {
		t.Fatalf("filtered histories consumed the recent list: %+v", items)
	}
	if b, err := os.ReadFile(filename); err != nil || string(b) != contents {
		t.Fatal("filter changed the transcript")
	}
}

func TestHistoryVisibilityMatchesVSIXSessionKinds(t *testing.T) {
	for _, tc := range []struct {
		name, contents string
		visible        bool
	}{
		{"legacy", `{"type":"user","message":{"content":"Old chat"}}`, true},
		{"vscode", `{"type":"user","entrypoint":"vscode"}`, true},
		{"sdk-cli", `{"type":"user","entrypoint":"sdk-cli"}`, false},
		{"sdk-ts", `{"type":"user","entrypoint":"sdk-ts"}`, false},
		{"sdk-py", `{"type":"user","entrypoint":"sdk-py"}`, false},
		{"daemon", `{"type":"user","sessionKind":"daemon"}`, false},
		{"daemon-worker", `{"type":"user","sessionKind":"daemon-worker"}`, false},
		{"sidechain", `{"type":"user","isSidechain":true}`, false},
		{"quoted-marker", `{"type":"user","message":{"content":"sdk-cli","entrypoint":"sdk-cli","isSidechain":true}}`, true},
		{"tail-entrypoint", strings.Repeat("{}\n", 30000) + `{"type":"user","entrypoint":"sdk-cli"}` + "\n", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			filename := filepath.Join(t.TempDir(), "session.jsonl")
			if err := os.WriteFile(filename, []byte(tc.contents), 0600); err != nil {
				t.Fatal(err)
			}
			if got := visibleTranscript(filename); got != tc.visible {
				t.Fatalf("visibility = %v, want %v", got, tc.visible)
			}
		})
	}
}
