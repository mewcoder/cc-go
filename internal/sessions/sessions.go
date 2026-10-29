package sessions

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var ID = regexp.MustCompile(`(?i)^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
var projectChars = regexp.MustCompile(`[^a-zA-Z0-9]`)
var tags = regexp.MustCompile(`<[^>]*>`)

type Session struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	UpdatedAt int64  `json:"updatedAt"`
	Archived  bool   `json:"archived,omitempty"`
}

type Metadata struct {
	ReadAt   int64  `json:"readAt,omitempty"`
	Title    string `json:"title,omitempty"`
	Archived bool   `json:"archived,omitempty"`
}

func Key(workspace, id string) string { return workspace + "\n" + id }

func ProjectDirectory(workspace string) string { return projectChars.ReplaceAllString(workspace, "-") }

func List(projects, workspace string, metadata map[string]Metadata) []Session {
	names := []string{ProjectDirectory(workspace)}
	if real, err := filepath.EvalSymlinks(workspace); err == nil && real != workspace {
		names = append(names, ProjectDirectory(real))
	}
	seen := make(map[string]bool)
	var result []Session
	for _, name := range names {
		entries, err := os.ReadDir(filepath.Join(projects, name))
		if err != nil {
			continue
		}
		for _, entry := range entries {
			id := strings.TrimSuffix(entry.Name(), ".jsonl")
			if !strings.HasSuffix(entry.Name(), ".jsonl") || !ID.MatchString(id) || seen[id] || entry.Type()&os.ModeSymlink != 0 || entry.IsDir() {
				continue
			}
			stat, err := entry.Info()
			if err != nil {
				continue
			}
			seen[id] = true
			meta := metadata[Key(workspace, id)]
			result = append(result, Session{ID: id, Title: meta.Title, UpdatedAt: stat.ModTime().UnixMilli(), Archived: meta.Archived})
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].UpdatedAt > result[j].UpdatedAt })
	// Resolve titles only for a bounded recent list, never materialize entire transcripts.
	if len(result) > 100 {
		result = result[:100]
	}
	for i := range result {
		if result[i].Title != "" {
			continue
		}
		for _, name := range names {
			title := readTitle(filepath.Join(projects, name, result[i].ID+".jsonl"))
			if title != "" {
				result[i].Title = title
				break
			}
		}
		if result[i].Title == "" {
			result[i].Title = "Chat " + result[i].ID[:8]
		}
	}
	return result
}

func readTitle(filename string) string {
	f, err := os.Open(filename)
	if err != nil {
		return ""
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil {
		return ""
	}
	var first, custom string
	scan := func(r io.Reader, onlyCustom bool) {
		s := bufio.NewScanner(r)
		s.Buffer(make([]byte, 65536), 1<<20)
		for n := 0; n < 500 && s.Scan(); n++ {
			var row struct {
				Type, CustomTitle string
				IsMeta            bool
				Message           struct{ Content json.RawMessage }
			}
			if json.Unmarshal(s.Bytes(), &row) != nil {
				continue
			}
			if row.Type == "custom-title" && strings.TrimSpace(row.CustomTitle) != "" {
				custom = row.CustomTitle
			}
			if onlyCustom || first != "" || row.Type != "user" || row.IsMeta {
				continue
			}
			var text string
			if json.Unmarshal(row.Message.Content, &text) != nil {
				var parts []struct{ Type, Text string }
				if json.Unmarshal(row.Message.Content, &parts) == nil {
					for _, p := range parts {
						if p.Type == "text" {
							text += p.Text + " "
						}
					}
				}
			}
			first = strings.Join(strings.Fields(tags.ReplaceAllString(text, " ")), " ")
		}
	}
	scan(io.LimitReader(f, 512<<10), false)
	if stat.Size() > 512<<10 {
		if _, err := f.Seek(max(0, stat.Size()-(256<<10)), io.SeekStart); err == nil {
			b, _ := io.ReadAll(io.LimitReader(f, 256<<10))
			if i := bytes.IndexByte(b, '\n'); i >= 0 {
				scan(bytes.NewReader(b[i+1:]), true)
			}
		}
	}
	if custom != "" {
		first = custom
	}
	runes := []rune(first)
	if len(runes) > 80 {
		first = string(runes[:77]) + "..."
	}
	return first
}
