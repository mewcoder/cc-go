package server

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const gitPreviewLimit = 1 << 20

type gitReviewFile struct {
	Path         string `json:"path"`
	OriginalPath string `json:"originalPath,omitempty"`
	Status       string `json:"status"`
	Added        int    `json:"added"`
	Deleted      int    `json:"deleted"`
	Binary       bool   `json:"binary"`
}

type gitReview struct {
	Root  string          `json:"root"`
	Files []gitReviewFile `json:"files"`
}

type gitReviewDiff struct {
	Path      string `json:"path"`
	Patch     string `json:"patch"`
	Message   string `json:"message,omitempty"`
	Truncated bool   `json:"truncated"`
}

type gitReviewOutput struct {
	buffer    bytes.Buffer
	limit     int
	truncated bool
}

func (b *gitReviewOutput) Write(p []byte) (int, error) {
	n := len(p)
	if len(p) > b.limit-b.buffer.Len() {
		p = p[:b.limit-b.buffer.Len()]
		b.truncated = true
	}
	_, _ = b.buffer.Write(p)
	return n, nil
}

func (b *gitReviewOutput) String() string { return b.buffer.String() }

func reviewGit(ctx context.Context, root string, limit int, args ...string) (string, bool, error) {
	cmd := gitCommand(ctx, root, append([]string{"--literal-pathspecs"}, args...)...)
	out, stderr := &gitReviewOutput{limit: limit}, &gitReviewOutput{limit: 16 << 10}
	cmd.Stdout, cmd.Stderr = out, stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return "", false, ctx.Err()
		}
		return "", false, fmt.Errorf("Git: %s", strings.TrimSpace(stderr.String()))
	}
	return out.String(), out.truncated, nil
}

func reviewGitText(ctx context.Context, root string, args ...string) (string, error) {
	text, truncated, err := reviewGit(ctx, root, 4<<20, args...)
	if err == nil && truncated {
		err = errors.New("too many Git changes to list")
	}
	return text, err
}

func reviewGitRoot(ctx context.Context, workspace string) (string, error) {
	root, err := reviewGitText(ctx, workspace, "rev-parse", "--show-toplevel")
	return strings.TrimSuffix(root, "\n"), err
}

func reviewGitBase(ctx context.Context, root string) (string, error) {
	if _, err := reviewGitText(ctx, root, "rev-parse", "--verify", "HEAD"); err == nil {
		return "HEAD", nil
	}
	empty, err := reviewGitText(ctx, root, "hash-object", "-t", "tree", "--stdin")
	return strings.TrimSpace(empty), err
}

func reviewGitStatus(ctx context.Context, root string) ([]gitFileStatus, error) {
	status, err := reviewGitText(ctx, root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none")
	return gitStatusEntries(status), err
}

func reviewGitAttributes(ctx context.Context, root string, paths []string) (map[string]string, error) {
	attrs := make(map[string]string)
	if len(paths) == 0 {
		return attrs, nil
	}
	text, err := reviewGitText(ctx, root, append([]string{"check-attr", "-z", "diff", "--"}, paths...)...)
	parts := strings.Split(text, "\x00")
	for i := 0; i+2 < len(parts); i += 3 {
		attrs[parts[i]] = parts[i+2]
	}
	return attrs, err
}

func readGitReview(ctx context.Context, workspace string) (gitReview, error) {
	result := gitReview{Files: []gitReviewFile{}}
	root, err := reviewGitRoot(ctx, workspace)
	if err != nil {
		return result, err
	}
	result.Root = root
	status, err := reviewGitStatus(ctx, root)
	if err != nil {
		return result, err
	}
	base, err := reviewGitBase(ctx, root)
	if err != nil {
		return result, err
	}
	text, err := reviewGitText(ctx, root, "diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", base, "--")
	if err != nil {
		return result, err
	}
	counts := make(map[string]gitReviewFile)
	records := strings.Split(text, "\x00")
	for i := 0; i < len(records); i++ {
		record := records[i]
		if record == "" {
			continue
		}
		parts := strings.SplitN(record, "\t", 3)
		if len(parts) != 3 {
			return result, errors.New("invalid Git change statistics")
		}
		file := gitReviewFile{Binary: parts[0] == "-"}
		if !file.Binary {
			var parseErr error
			file.Added, parseErr = strconv.Atoi(parts[0])
			if parseErr != nil {
				return result, parseErr
			}
			file.Deleted, parseErr = strconv.Atoi(parts[1])
			if parseErr != nil {
				return result, parseErr
			}
		}
		path := parts[2]
		if path == "" {
			// Numstat -z encodes a detected rename as old and new pathname records.
			if i+2 >= len(records) {
				return result, errors.New("invalid Git rename statistics")
			}
			i += 2
			path = records[i]
		}
		counts[path] = file
	}
	var untracked []string
	for _, file := range status {
		if file.code == "??" {
			untracked = append(untracked, file.path)
		}
	}
	attrs, err := reviewGitAttributes(ctx, root, untracked)
	if err != nil {
		return result, err
	}
	for _, entry := range status {
		if !filepath.IsLocal(entry.path) {
			return result, errors.New("invalid Git path")
		}
		file := counts[entry.path]
		file.Path, file.OriginalPath, file.Status = entry.path, entry.original, entry.code
		if entry.original != "" && strings.Contains(entry.code, "R") {
			old := counts[entry.original]
			file.Added += old.Added
			file.Deleted += old.Deleted
			file.Binary = file.Binary || old.Binary
		}
		if entry.code == "??" {
			file.Added, file.Binary, err = countNewFileLines(ctx, filepath.Join(root, filepath.FromSlash(entry.path)), attrs[entry.path])
			if err != nil {
				return result, err
			}
		}
		result.Files = append(result.Files, file)
	}
	return result, nil
}

func readGitReviewDiff(ctx context.Context, workspace, path string) (gitReviewDiff, error) {
	result := gitReviewDiff{Path: path}
	if !filepath.IsLocal(path) || strings.ContainsRune(path, '\x00') {
		return result, errors.New("invalid Git path")
	}
	root, err := reviewGitRoot(ctx, workspace)
	if err != nil {
		return result, err
	}
	files, err := reviewGitStatus(ctx, root)
	if err != nil {
		return result, err
	}
	for _, file := range files {
		if file.path != path {
			continue
		}
		if file.code == "??" {
			attrs, err := reviewGitAttributes(ctx, root, []string{path})
			if err != nil {
				return result, err
			}
			return untrackedGitDiff(root, path, attrs[path])
		}
		base, err := reviewGitBase(ctx, root)
		if err != nil {
			return result, err
		}
		args := []string{"diff", "--no-color", "--no-ext-diff", "--no-textconv", "--submodule=short", base, "--", path}
		if file.original != "" {
			args = append(args, file.original)
		}
		result.Patch, result.Truncated, err = reviewGit(ctx, root, gitPreviewLimit, args...)
		if result.Patch == "" && err == nil {
			result.Message = "No net changes compared with HEAD."
		}
		return result, err
	}
	return result, errors.New("file is no longer changed; refresh the file list")
}

func untrackedGitDiff(directory, path, attribute string) (gitReviewDiff, error) {
	result := gitReviewDiff{Path: path}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return result, err
	}
	defer root.Close()
	info, err := root.Lstat(path)
	if err != nil {
		return result, err
	}
	var data []byte
	if info.Mode()&os.ModeSymlink != 0 {
		target, err := root.Readlink(path)
		if err != nil {
			return result, err
		}
		data = []byte(target)
	} else if info.IsDir() {
		result.Message = "Embedded repository."
		return result, nil
	} else if !info.Mode().IsRegular() {
		return result, errors.New("not a regular file")
	} else {
		if attribute == "unset" {
			result.Message = "Binary file."
			return result, nil
		}
		file, err := root.Open(path)
		if err != nil {
			return result, err
		}
		defer file.Close()
		data, err = io.ReadAll(io.LimitReader(file, gitPreviewLimit+1))
		if err != nil {
			return result, err
		}
		if attribute != "set" && bytes.IndexByte(data[:min(len(data), 8000)], 0) >= 0 {
			result.Message = "Binary file."
			return result, nil
		}
		if len(data) > gitPreviewLimit {
			result.Message = "File is too large to preview (over 1 MiB)."
			return result, nil
		}
	}
	if len(data) == 0 {
		result.Message = "New empty file."
		return result, nil
	}
	lines := strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
	var patch strings.Builder
	fmt.Fprintf(&patch, "--- /dev/null\n+++ b/%s\n@@ -0,0 +1,%d @@\n", path, len(lines))
	for _, line := range lines {
		fmt.Fprintf(&patch, "+%s\n", line)
	}
	if data[len(data)-1] != '\n' {
		patch.WriteString("\\ No newline at end of file\n")
	}
	result.Patch = patch.String()
	return result, nil
}

func (a *App) gitReviewRequest(ctx context.Context, workspace, path string, detail bool) (any, error) {
	a.mu.Lock()
	allowed := workspace != "" && workspace == a.state.Workspace && a.phase == "active"
	a.mu.Unlock()
	if !allowed {
		return nil, errors.New("the active project changed; reopen Changes")
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	if detail {
		return readGitReviewDiff(ctx, workspace, path)
	}
	return readGitReview(ctx, workspace)
}
