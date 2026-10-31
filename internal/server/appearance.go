package server

func validTheme(value string) bool {
	return value == "dark" || value == "light" || validCodePalette(value)
}

func themeKind(value string) string {
	if value == "light" {
		return "light"
	}
	for _, family := range codeThemeCatalog {
		if family.Light == value {
			return "light"
		}
	}
	return "dark"
}

func themeFamily(value string) codeThemeInfo {
	for _, family := range codeThemeCatalog {
		if family.Light == value || family.Dark == value {
			return family
		}
	}
	return codeThemeSelection("default")
}

func selectTheme(current, choice string) (string, bool) {
	if choice == "light" || choice == "dark" {
		family := themeFamily(current)
		if family.ID == "default" {
			return choice, true
		}
		if choice == "light" {
			return family.Light, true
		}
		return family.Dark, true
	}
	if validCodeTheme(choice) {
		if choice == "default" {
			return themeKind(current), true
		}
		family := codeThemeSelection(choice)
		if themeKind(current) == "light" {
			return family.Light, true
		}
		return family.Dark, true
	}
	return choice, validTheme(choice)
}

func validTranscriptWidth(value string) bool {
	return value == "narrow" || value == "medium" || value == "wide"
}

func validInterfaceSize(value string) bool {
	return value == "small" || value == "medium" || value == "large"
}
