package sessions

import (
	"os"
	"path/filepath"
	"testing"
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
