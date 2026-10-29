package server

func validTranscriptWidth(value string) bool {
	return value == "narrow" || value == "medium" || value == "wide"
}
