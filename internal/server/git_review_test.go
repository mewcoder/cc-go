package server

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func gitReviewRepo(t *testing.T) (string, func(...string) string, func(string, string)) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("Git unavailable")
	}
	dir := t.TempDir()
	git := func(args ...string) string {
		t.Helper()
		out, err := gitCommand(t.Context(), dir, args...).CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
		return string(out)
	}
	write := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	git("init", "-b", "main")
	git("config", "user.name", "Test")
	git("config", "user.email", "test@example.invalid")
	return dir, git, write
}

func TestGitReviewCombinesStagedWorkingTreeAndUntrackedWithoutWriting(t *testing.T) {
	dir, git, write := gitReviewRepo(t)
	write("tracked.txt", "base\nold\n")
	write("deleted.txt", "gone\n")
	write("rename.txt", "unchanged\n")
	write(".gitattributes", "*.bin -diff\n*.txt diff=review-test\n")
	git("add", ".")
	git("commit", "-m", "base")
	git("config", "diff.review-test.textconv", "command-that-must-not-run")
	git("config", "diff.external", "command-that-must-not-run")
	write("tracked.txt", "base\nstaged\n")
	git("add", "tracked.txt")
	write("tracked.txt", "base\nworking\nnew\n")
	if err := os.Remove(filepath.Join(dir, "deleted.txt")); err != nil {
		t.Fatal(err)
	}
	git("mv", "rename.txt", "renamed[1].txt")
	write("literal[1].txt", "<script>\nnew\n")
	write("image.bin", "classified as binary by attributes")
	before := git("status", "--porcelain=v1", "-z", "--untracked-files=all")
	index, err := os.ReadFile(filepath.Join(dir, ".git", "index"))
	if err != nil {
		t.Fatal(err)
	}
	review, err := readGitReview(t.Context(), dir)
	if err != nil {
		t.Fatal(err)
	}
	files := make(map[string]gitReviewFile)
	var totals GitChanges
	for _, file := range review.Files {
		files[file.Path] = file
		totals.Files++
		totals.Added += file.Added
		totals.Deleted += file.Deleted
		if file.Status == "??" {
			totals.Untracked++
		}
		if file.Binary {
			totals.Binary++
		}
	}
	if files["tracked.txt"].Added != 2 || files["tracked.txt"].Deleted != 1 || !files["image.bin"].Binary || files["renamed[1].txt"].OriginalPath != "rename.txt" {
		t.Fatalf("wrong change list: %+v", review)
	}
	info := readTestProject(t, dir)
	if info.Changes == nil || totals != *info.Changes {
		t.Fatalf("list and HUD must use the same HEAD comparison: %+v vs %+v", totals, info.Changes)
	}
	for path, want := range map[string]string{
		"tracked.txt": "+working", "deleted.txt": "-gone", "literal[1].txt": "+<script>", "renamed[1].txt": "rename from",
	} {
		diff, err := readGitReviewDiff(t.Context(), dir, path)
		if err != nil || !strings.Contains(diff.Patch, want) {
			t.Fatalf("diff %q: %+v %v", path, diff, err)
		}
		if path == "tracked.txt" && strings.Contains(diff.Patch, "+staged") {
			t.Fatal("preview compared against the index instead of HEAD")
		}
	}
	diff, err := readGitReviewDiff(t.Context(), dir, "image.bin")
	if err != nil || diff.Message != "Binary file." || diff.Patch != "" {
		t.Fatalf("binary preview: %+v %v", diff, err)
	}
	afterIndex, _ := os.ReadFile(filepath.Join(dir, ".git", "index"))
	if string(index) != string(afterIndex) || git("status", "--porcelain=v1", "-z", "--untracked-files=all") != before {
		t.Fatal("review changed the index or working tree")
	}
}

func TestGitReviewUnbornBranchLimitsAndSymlinks(t *testing.T) {
	dir, git, write := gitReviewRepo(t)
	write("staged.txt", "first\n")
	git("add", "staged.txt")
	write("new.txt", "second\n")
	review, err := readGitReview(t.Context(), dir)
	if err != nil || len(review.Files) != 2 {
		t.Fatalf("unborn branch: %+v %v", review, err)
	}
	diff, err := readGitReviewDiff(t.Context(), dir, "staged.txt")
	if err != nil || !strings.Contains(diff.Patch, "+first") {
		t.Fatalf("unborn staged diff: %+v %v", diff, err)
	}
	outside := filepath.Join(t.TempDir(), "outside.txt")
	if err := os.WriteFile(outside, []byte("contents-must-not-be-read"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "link")); err == nil {
		diff, err := readGitReviewDiff(t.Context(), dir, "link")
		if err != nil || !strings.Contains(diff.Patch, outside) || strings.Contains(diff.Patch, "contents-must-not-be-read") {
			t.Fatalf("symlink preview must show its target: %+v %v", diff, err)
		}
	}
	write("large.txt", strings.Repeat("x", gitPreviewLimit+1))
	diff, err = readGitReviewDiff(t.Context(), dir, "large.txt")
	if err != nil || !strings.Contains(diff.Message, "too large") || diff.Patch != "" {
		t.Fatalf("large untracked preview: %+v %v", diff, err)
	}
	git("commit", "-m", "initial")
	write("staged.txt", strings.Repeat("large line\n", 120000))
	diff, err = readGitReviewDiff(t.Context(), dir, "staged.txt")
	if err != nil || !diff.Truncated || len(diff.Patch) > gitPreviewLimit {
		t.Fatalf("large tracked preview was not bounded: bytes=%d truncated=%v err=%v", len(diff.Patch), diff.Truncated, err)
	}
	for _, path := range []string{"../outside.txt", outside, "new.txt\x00extra", "unchanged.txt"} {
		if _, err := readGitReviewDiff(t.Context(), dir, path); err == nil {
			t.Fatalf("unexpected preview allowed: %q", path)
		}
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := readGitReview(ctx, dir); err == nil {
		t.Fatal("cancelled review must stop")
	}
}

func TestGitReviewRoutesRequireActiveWorkspaceAndServeAssets(t *testing.T) {
	dir, _, write := gitReviewRepo(t)
	write("new.txt", "new\n")
	a := testApp(t)
	a.phase, a.state.Workspace = "active", dir
	for _, route := range []string{"/api/git-changes", "/api/git-diff"} {
		if w := postAPI(a, route, map[string]string{"workspace": t.TempDir(), "path": "new.txt"}); w.Code == 200 {
			t.Fatal("accepted a stale or unrelated workspace")
		}
		w := postAPI(a, route, map[string]string{"workspace": dir, "path": "new.txt"})
		if w.Code != 200 || !json.Valid(w.Body.Bytes()) {
			t.Fatalf("%s: %d %s", route, w.Code, w.Body.String())
		}
	}
}
