package server

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	runtimefiles "cc-go/runtime"
)

var themePalettesCSS = buildThemePalettesCSS()

func buildThemePalettesCSS() string {
	var css strings.Builder
	for _, family := range codeThemeCatalog {
		for _, id := range []string{family.Light, family.Dark} {
			b, err := runtimefiles.Files.ReadFile("code-themes/" + id + ".json")
			if err != nil {
				panic(err)
			}
			var palette struct {
				Colors      map[string]any `json:"colors"`
				TokenColors []struct {
					Scope    any `json:"scope"`
					Settings struct {
						Foreground string `json:"foreground"`
					} `json:"settings"`
				} `json:"tokenColors"`
			}
			if err := json.Unmarshal(b, &palette); err != nil {
				panic(err)
			}
			colors := make(map[string]string)
			for key, value := range palette.Colors {
				if text, ok := value.(string); ok && validPaletteColor.MatchString(text) {
					colors[key] = text
				}
			}
			bg, fg := colors["editor.background"], colors["editor.foreground"]
			if fg == "" {
				fg = colors["foreground"]
				if fg == "" {
					fg = "#d4d4d4"
					if themeKind(id) == "light" {
						fg = "#202020"
					}
				}
				colors["editor.foreground"] = fg
			}
			if bg == "" {
				panic("theme missing editor background: " + id)
			}
			mix := func(percent int) string { return fmt.Sprintf("color-mix(in srgb, %s %d%%, %s)", fg, percent, bg) }
			colorOr := func(key, fallback string) string {
				if value := colors[key]; value != "" {
					return value
				}
				return fallback
			}
			firstColor := func(fallback string, keys ...string) string {
				for _, key := range keys {
					if value := colors[key]; value != "" {
						return value
					}
				}
				return fallback
			}
			tokenColor := func(scope string) string {
				value := fg
				for _, rule := range palette.TokenColors {
					var scopes []string
					switch raw := rule.Scope.(type) {
					case string:
						scopes = strings.Split(raw, ",")
					case []any:
						for _, item := range raw {
							if text, ok := item.(string); ok {
								scopes = append(scopes, text)
							}
						}
					}
					for _, candidate := range scopes {
						if strings.TrimSpace(candidate) == scope && validPaletteColor.MatchString(rule.Settings.Foreground) {
							value = rule.Settings.Foreground
						}
					}
				}
				return value
			}
			success := firstColor(tokenColor("markup.inserted"), "gitDecoration.addedResourceForeground", "editorGutter.addedBackground", "terminal.ansiGreen")
			danger := firstColor(tokenColor("markup.deleted"), "errorForeground", "editorError.foreground", "problemsErrorIcon.foreground", "terminal.ansiRed", "gitDecoration.deletedResourceForeground", "debugIcon.stopForeground")
			warning := firstColor(fg, "editorWarning.foreground", "problemsWarningIcon.foreground", "terminal.ansiYellow", "list.warningForeground")
			accent := fg
			for _, key := range []string{"textLink.foreground", "textLink.activeForeground", "editorLink.activeForeground", "focusBorder", "button.background"} {
				value := colors[key]
				if value == "" {
					continue
				}
				// Translucent accent fills still provide an opaque hue for icons and links.
				if len(value) == 9 {
					if value[7:] == "00" {
						continue
					}
					value = value[:7]
				} else if len(value) == 5 {
					if value[4] == '0' {
						continue
					}
					value = value[:4]
				}
				accent = value
				break
			}
			fallback := map[string]string{
				"focusBorder": accent, "textLink.foreground": accent,
				"errorForeground": danger, "editorError.foreground": danger, "editorWarning.foreground": warning,
				"editorInfo.foreground":        firstColor(accent, "problemsInfoIcon.foreground", "terminal.ansiBlue"),
				"problemsErrorIcon.foreground": danger, "problemsWarningIcon.foreground": warning,
				"problemsInfoIcon.foreground":             firstColor(accent, "editorInfo.foreground", "terminal.ansiBlue"),
				"icon.foreground":                         colorOr("foreground", fg),
				"gitDecoration.addedResourceForeground":   success,
				"gitDecoration.deletedResourceForeground": firstColor(tokenColor("markup.deleted"), "editorGutter.deletedBackground", "terminal.ansiRed", "errorForeground", "debugIcon.stopForeground"),
				"foreground":                              fg, "descriptionForeground": mix(65), "disabledForeground": mix(45),
				"sideBar.background": bg, "sideBar.foreground": fg, "panel.background": bg,
				"panel.border": mix(15), "widget.border": mix(20), "widget.shadow": "#00000033",
				"input.background": bg, "input.foreground": fg, "input.border": mix(25),
				"input.placeholderForeground": mix(65), "inputOption.activeBorder": accent,
				"inputOption.hoverBackground": mix(7), "inputValidation.infoBorder": accent,
				"checkbox.background": colorOr("input.background", bg),
				"checkbox.foreground": colorOr("foreground", fg),
				"checkbox.border":     colorOr("input.border", mix(25)),
				"dropdown.background": bg, "dropdown.foreground": fg, "dropdown.border": mix(25),
				"list.hoverBackground": mix(7), "list.activeSelectionBackground": mix(14),
				"list.inactiveSelectionBackground": mix(10), "list.activeSelectionForeground": fg,
				"list.focusBackground": mix(12), "list.focusForeground": fg,
				"list.dropBackground": mix(14),
				"menu.background":     bg, "menu.foreground": fg, "menu.border": mix(20),
				"menu.selectionBackground": colorOr("list.hoverBackground", mix(7)),
				"menu.selectionForeground": fg, "menu.selectionBorder": mix(20),
				"toolbar.hoverBackground": colorOr("list.hoverBackground", mix(7)),
				"progressBar.background":  accent, "textLink.activeForeground": accent,
				"textPreformat.background": mix(10), "textPreformat.foreground": fg,
				"chat.slashCommandBackground": mix(14), "chat.slashCommandForeground": accent,
				"banner.background": mix(14), "banner.foreground": fg, "banner.iconForeground": accent,
				"editorActionList.background": bg, "editorActionList.foreground": fg,
				"editorActionList.focusBackground": mix(12), "editorActionList.focusForeground": fg,
				"editorMarkerNavigationInfo.headerBackground": mix(10),
				"editor.lineHighlightBackground":              mix(7),
				"terminal.ansiBlack":                          bg, "terminal.ansiWhite": fg, "terminal.ansiBrightBlack": mix(65),
				"terminal.ansiRed": danger, "terminal.ansiGreen": success, "terminal.ansiYellow": warning,
				"terminal.ansiBlue": accent, "terminal.ansiCyan": colorOr("editorInfo.foreground", accent),
				"terminal.ansiMagenta": tokenColor("keyword"),
				"charts.foreground":    fg, "charts.red": danger, "charts.green": success, "charts.yellow": warning,
				"charts.blue":       colorOr("terminal.ansiBlue", accent),
				"charts.purple":     colorOr("terminal.ansiMagenta", tokenColor("keyword")),
				"charts.orange":     tokenColor("constant.numeric"),
				"button.background": mix(20), "button.foreground": fg, "button.hoverBackground": mix(25),
				"button.secondaryBackground": mix(10), "button.secondaryForeground": fg,
				"button.secondaryHoverBackground": mix(16), "badge.background": mix(15), "badge.foreground": fg,
				"editorWidget.background": bg, "editorWidget.foreground": fg, "editorWidget.border": mix(20),
				"editorHoverWidget.background": bg, "editorHoverWidget.foreground": fg, "editorHoverWidget.border": mix(20),
				"textCodeBlock.background": bg, "scrollbarSlider.background": mix(20),
				"scrollbarSlider.hoverBackground": mix(30), "scrollbarSlider.activeBackground": mix(40),
				"sideBarActivityBarTop.border": mix(15), "inlineChatInput.border": mix(25),
			}
			for key, value := range fallback {
				if colors[key] == "" {
					colors[key] = value
				}
			}
			keys := make([]string, 0, len(colors))
			for key := range colors {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			fmt.Fprintf(&css, ":root:has(body[data-color-theme=%q]), :root body[data-color-theme=%q] .sidebar {\n  color-scheme: %s;\n", id, id, themeKind(id))
			for _, key := range keys {
				fmt.Fprintf(&css, "  --vscode-%s: %s;\n", strings.ReplaceAll(key, ".", "-"), colors[key])
			}
			css.WriteString("}\n")
		}
	}
	return css.String()
}
