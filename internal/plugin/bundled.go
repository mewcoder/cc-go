package plugin

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// BundledRuntime follows the official extension's executable selection order.
// It never searches PATH or substitutes a separately installed Claude CLI.
func BundledRuntime(extension, platform string) (string, error) {
	parts := strings.Split(platform, "-")
	if len(parts) != 2 {
		return "", fmt.Errorf("unsupported runtime platform: %s", platform)
	}
	name := "claude"
	if parts[0] == "win32" {
		name += ".exe"
	}
	platforms := []string{platform}
	if parts[0] == "alpine" {
		platforms[0] = "linux-" + parts[1] + "-musl"
	}
	if platform == "win32-arm64" {
		platforms = append(platforms, "win32-x64")
	}
	var candidates []string
	for _, target := range platforms {
		candidates = append(candidates, filepath.Join("resources", "native-binaries", target, name))
	}
	candidates = append(candidates, filepath.Join("resources", "native-binary", name))
	for _, candidate := range candidates {
		filename, err := inside(extension, filepath.ToSlash(candidate))
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return "", err
		}
		if err := checkRuntimeBinary(filename, platform); err != nil {
			return "", fmt.Errorf("bundled Claude cannot run on %s: %w", platform, err)
		}
		return filename, nil
	}
	return "", errors.New("the VSIX does not contain a Claude runtime for this platform; import or download the correct platform package")
}

func checkRuntimeBinary(filename, platform string) error {
	f, err := os.Open(filename)
	if err != nil {
		return err
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil {
		return err
	}
	if !stat.Mode().IsRegular() {
		return errors.New("runtime is not a regular file")
	}
	var header [64]byte
	if _, err := io.ReadFull(f, header[:]); err != nil {
		return fmt.Errorf("invalid executable header: %w", err)
	}
	var osname, arch string
	switch {
	case string(header[:2]) == "MZ":
		var pe [6]byte
		if _, err := f.ReadAt(pe[:], int64(binary.LittleEndian.Uint32(header[60:]))); err != nil || string(pe[:4]) != "PE\x00\x00" {
			return errors.New("invalid Windows executable")
		}
		osname = "win32"
		arch = map[uint16]string{0x8664: "x64", 0xaa64: "arm64"}[binary.LittleEndian.Uint16(pe[4:])]
	case string(header[:4]) == "\x7fELF":
		osname = strings.Split(platform, "-")[0]
		if osname != "linux" && osname != "alpine" {
			osname = "linux"
		}
		arch = map[uint16]string{62: "x64", 183: "arm64"}[binary.LittleEndian.Uint16(header[18:20])]
		if header[4] != 2 || header[5] != 1 {
			arch = ""
		}
	case binary.LittleEndian.Uint32(header[:4]) == 0xfeedfacf:
		osname = "darwin"
		arch = map[uint32]string{0x01000007: "x64", 0x0100000c: "arm64"}[binary.LittleEndian.Uint32(header[4:8])]
	default:
		return errors.New("unrecognized executable format")
	}
	actual := osname + "-" + arch
	if arch == "" || actual != platform && !(platform == "win32-arm64" && actual == "win32-x64") {
		return fmt.Errorf("wrong executable platform (%s)", actual)
	}
	if osname != "win32" && runtime.GOOS != "windows" && stat.Mode().Perm()&0111 == 0 {
		return errors.New("runtime does not have executable permission")
	}
	return nil
}
