# Built-in themes

`catalog.json` is the supported family list for the single Theme setting. Each family has one light and one
dark palette. Theme JSON is bundled at build time; the app does not fetch themes
from the network.

The initial palette list and menu order were checked against the local Claude
Desktop code-appearance menu on 2026-10-31. Vitesse is an additional CC Go
choice. Palette data was audited against the public projects and releases below
on the same date; differing snapshots were refreshed. Only palette data is
included, not another application's settings UI or highlighting implementation.

Public theme projects:

- Shiki's theme collection: https://github.com/shikijs/shiki/tree/main/packages/themes
  (`LICENSE-shiki.txt`). GitHub, Catppuccin, Solarized, Min and Rose Pine match
  `@shikijs/themes@4.5.0` (`dist/<name>.mjs`). Catppuccin's additional language
  rules, Solarized's new workbench colors, and Rose Pine's input/background
  changes were refreshed from that release. GitHub and Min were already equal.
- Pierre: https://github.com/pierrecomputer/theme (`LICENSE-pierre.txt`). Both
  palettes' colors, token rules and semantic rules match `themes/pierre-*.json`
  at revision `71693332d2551a033882216ca7617eb54cdf8aeb`.
- VS Code: https://github.com/microsoft/vscode/tree/main/extensions/theme-defaults
  (`LICENSE-vscode.txt`). This family uses **2026 Light / 2026 Dark**, not
  Light Modern / Dark Modern. Data comes from revision
  `a54301b1b8fb2e5da6fb61c85a7d5c4eb7ecb2cb`, with `2026-*.json`'s includes
  resolved recursively through `*_modern.json`, `*_plus.json` and `*_vs.json`.
  Included colors/semantic rules are merged, and token rules are concatenated
  in base-to-child order. Runtime name/type/display metadata is normalized.
- Standard One Light / One Dark:
  https://github.com/akamud/vscode-theme-onelight (`LICENSE-one-light.txt`) and
  https://github.com/akamud/vscode-theme-onedark (`LICENSE-one-dark.txt`).
  Data comes from `themes/OneLight.json` at
  `5866e900db932d580e978a58db42f65cde07998b` and `themes/OneDark.json` at
  `a8be970644982221f9b61fb1c4b3da74b4beab79`, with normalized name/type/display
  metadata. One Light's invalid-token foreground is preserved as upstream's
  `white`; the adapter converts named white/black to Monaco hex values. One
  Dark Pro and Darker are not used.
- Vitesse: https://github.com/antfu/vscode-theme-vitesse
  (`LICENSE-vitesse.txt`). `vitesse-light.json` and `vitesse-dark.json` come
  directly from `themes/` at revision
  `2862595c3d5d05fabfd5aeb50bcbb79ea2f8d85f`, retrieved on 2026-10-31.
  The original name is retained as `displayName`; `name` and `type` are
  normalized for the runtime. This family is an additional CC Go choice.

Settings controls use button colors for their selected state and checkbox
colors for their unselected track/thumb. `focusBorder` is not a fill color:
themes such as Vitesse intentionally make it transparent. Missing checkbox
colors fall back to the selected theme's input and foreground colors rather
than inheriting the host's default dark checkbox colors.
Radio controls draw their ring, selected fill and center dot with these same
theme colors, avoiding native accent-color contrast adjustments.
Missing link, status and Git colors are resolved from the same palette's
workbench, terminal or general markup colors, then its foreground. Host controls,
tooltips and scrollbars use these resolved tokens rather than another theme's
colors. Explicit upstream colors, including transparent focus borders, remain intact.

The runtime translates general TextMate scopes into Monaco Monarch token rules.
Language-specific TextMate selectors and semantic-token rules cannot be reproduced
exactly by Monarch. Editor and diff colors are retained; missing diff backgrounds use
the palette's existing diff, Git, gutter or general markup colors, then its foreground.
The original theme JSON remains intact apart from the noted
metadata/normalization.

The VSIX's existing theme-kind boundary is adapted in memory when its webview
bundle is served. The adapter accepts exactly one known startup hook and one
theme-kind function; a different bundle format is served intact with a console
warning. Vendor files on disk are never modified. Check both hooks and live
code/diff rendering when updating the VSIX.
