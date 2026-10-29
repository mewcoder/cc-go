package sessions

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type Project struct {
	Path      string `json:"path"`
	UpdatedAt int64  `json:"updatedAt"`
}

// Discover uses recorded working directories, not the lossy project folder encoding.
func Discover(projects string) ([]Project, error) {
	result := make([]Project, 0)
	directories, err := os.ReadDir(projects)
	if os.IsNotExist(err) {
		return result, nil
	}
	if err != nil {
		return nil, err
	}
	seen := make(map[string]int)
	for _, directory := range directories {
		if !directory.IsDir() || directory.Type()&os.ModeSymlink != 0 {
			continue
		}
		entries, err := os.ReadDir(filepath.Join(projects, directory.Name()))
		if err != nil {
			continue
		}
		var transcripts []os.FileInfo
		for _, entry := range entries {
			if !entry.Type().IsRegular() || !strings.HasSuffix(entry.Name(), ".jsonl") || !ID.MatchString(strings.TrimSuffix(entry.Name(), ".jsonl")) {
				continue
			}
			if info, err := entry.Info(); err == nil {
				transcripts = append(transcripts, info)
			}
		}
		// Inspect the newest transcripts first; a scan must not count as usage.
		sort.SliceStable(transcripts, func(i, j int) bool {
			return transcripts[i].ModTime().After(transcripts[j].ModTime())
		})
		for _, transcript := range transcripts {
			path := projectPath(filepath.Join(projects, directory.Name(), transcript.Name()), directory.Name())
			if path == "" {
				continue
			}
			updatedAt := transcript.ModTime().UnixMilli()
			if index, ok := seen[path]; ok {
				result[index].UpdatedAt = max(result[index].UpdatedAt, updatedAt)
			} else {
				seen[path] = len(result)
				result = append(result, Project{Path: path, UpdatedAt: updatedAt})
			}
			break
		}
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].UpdatedAt != result[j].UpdatedAt {
			return result[i].UpdatedAt > result[j].UpdatedAt
		}
		return result[i].Path < result[j].Path
	})
	return result, nil
}

func projectPath(filename, directory string) string {
	f, err := os.Open(filename)
	if err != nil {
		return ""
	}
	defer f.Close()
	s := bufio.NewScanner(io.LimitReader(f, 512<<10))
	s.Buffer(make([]byte, 65536), 1<<20)
	for n := 0; n < 500 && s.Scan(); n++ {
		var row struct{ Cwd string }
		if json.Unmarshal(s.Bytes(), &row) != nil || !filepath.IsAbs(row.Cwd) {
			continue
		}
		path := filepath.Clean(row.Cwd)
		if ProjectDirectory(path) != directory {
			continue
		}
		if info, err := os.Stat(path); err == nil && info.IsDir() {
			return path
		}
	}
	return ""
}
