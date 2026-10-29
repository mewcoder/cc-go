package assets

import (
	"bytes"
	"image/png"
	"testing"
)

func TestTrayIconIsSmallTransparentMonochromeTemplate(t *testing.T) {
	img, err := png.Decode(bytes.NewReader(TrayIcon))
	if err != nil {
		t.Fatal(err)
	}
	if img.Bounds().Dx() != 32 || img.Bounds().Dy() != 32 {
		t.Fatalf("expected a 32px tray asset, got %v", img.Bounds())
	}
	var visible, transparent int
	for y := 0; y < 32; y++ {
		for x := 0; x < 32; x++ {
			r, g, b, a := img.At(x, y).RGBA()
			if a == 0 {
				transparent++
				continue
			}
			visible++
			if r != 0 || g != 0 || b != 0 {
				t.Fatalf("template must use alpha, not color: pixel %d,%d", x, y)
			}
		}
	}
	if visible < 100 || transparent < 500 || bytes.Equal(TrayIcon, Icon) {
		t.Fatal("tray must use a separate visible mark without the application icon's background")
	}
	for _, p := range [][2]int{{0, 0}, {31, 0}, {0, 31}, {31, 31}} {
		if _, _, _, a := img.At(p[0], p[1]).RGBA(); a != 0 {
			t.Fatal("tray corners must be transparent")
		}
	}
}
