package runtimefiles

import "embed"

//go:generate node ../scripts/vendor-runtime.cjs

//go:embed *.cjs *.css deps code-themes
var Files embed.FS
