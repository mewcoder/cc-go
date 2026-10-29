package plugin

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func binaryFixture(platform string) []byte {
	b := make([]byte, 256)
	parts := strings.Split(platform, "-")
	switch parts[0] {
	case "win32":
		copy(b, "MZ")
		binary.LittleEndian.PutUint32(b[60:], 128)
		copy(b[128:], "PE\x00\x00")
		machine := uint16(0x8664)
		if parts[1] == "arm64" {
			machine = 0xaa64
		}
		binary.LittleEndian.PutUint16(b[132:], machine)
	case "darwin":
		binary.LittleEndian.PutUint32(b, 0xfeedfacf)
		cpu := uint32(0x01000007)
		if parts[1] == "arm64" {
			cpu = 0x0100000c
		}
		binary.LittleEndian.PutUint32(b[4:], cpu)
	case "linux", "alpine":
		copy(b, "\x7fELF")
		b[4], b[5] = 2, 1
		machine := uint16(62)
		if parts[1] == "arm64" {
			machine = 183
		}
		binary.LittleEndian.PutUint16(b[18:], machine)
	}
	return b
}

func writeRuntime(t *testing.T, root, target, platform string) string {
	t.Helper()
	name := "claude"
	if strings.HasPrefix(platform, "win32-") {
		name += ".exe"
	}
	file := filepath.Join(root, "resources", target, name)
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, binaryFixture(platform), 0700); err != nil {
		t.Fatal(err)
	}
	real, err := filepath.EvalSymlinks(file)
	if err != nil {
		t.Fatal(err)
	}
	return real
}

func TestBundledRuntimeChecksEachPlatformAndArchitectureWithoutPATH(t *testing.T) {
	for _, platform := range []string{"darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64", "linux-arm64", "linux-x64"} {
		t.Run(platform, func(t *testing.T) {
			root := t.TempDir()
			legacy := writeRuntime(t, root, "native-binary", platform)
			if got, err := BundledRuntime(root, platform); err != nil || got != legacy {
				t.Fatalf("legacy selection: %s %v", got, err)
			}
			preferred := writeRuntime(t, root, filepath.Join("native-binaries", platform), platform)
			if got, err := BundledRuntime(root, platform); err != nil || got != preferred {
				t.Fatalf("preferred selection: %s %v", got, err)
			}
		})
	}
}

func TestBundledWindowsARM64UsesOfficialX64Fallback(t *testing.T) {
	root := t.TempDir()
	file := writeRuntime(t, root, filepath.Join("native-binaries", "win32-x64"), "win32-x64")
	if got, err := BundledRuntime(root, "win32-arm64"); err != nil || got != file {
		t.Fatalf("x64 fallback: %s %v", got, err)
	}
}

func TestBundledRuntimeRejectsMissingWrongPlatformAndInvalidBinary(t *testing.T) {
	root := t.TempDir()
	if _, err := BundledRuntime(root, "darwin-arm64"); err == nil {
		t.Fatal("missing runtime accepted")
	}
	file := writeRuntime(t, root, "native-binary", "darwin-x64")
	if _, err := BundledRuntime(root, "darwin-arm64"); err == nil {
		t.Fatal("wrong architecture accepted")
	}
	if err := os.WriteFile(file, []byte("not a program"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := BundledRuntime(root, "darwin-x64"); err == nil {
		t.Fatal("invalid executable accepted")
	}
	if err := os.WriteFile(file, binaryFixture("linux-x64"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := BundledRuntime(root, "darwin-x64"); err == nil {
		t.Fatal("wrong OS accepted")
	}
}

func TestNewerStableVersionDoesNotDowngradeManualImports(t *testing.T) {
	for _, tc := range []struct {
		next, current string
		newer         bool
	}{
		{"2.1.313", "2.1.312", true}, {"2.2.0", "2.1.999", true},
		{"2.1.312", "2.1.312", false}, {"2.1.312", "2.1.313", false},
		{"2.1.312", "2.1.312-beta.1", true}, {"2.1.312+build2", "2.1.312+build1", false},
		{"2.1.313-beta.1", "2.1.312", false}, {"2.1.312", "2.1.312+build-1", false},
		{"invalid", "2.1.312", false}, {"2.1.312", "invalid", false},
	} {
		if got := NewerVersion(tc.next, tc.current); got != tc.newer {
			t.Errorf("%s > %s = %v", tc.next, tc.current, got)
		}
	}
}
