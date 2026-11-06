# Application icons

PNG exports of `web/src/assets/routepilot-mark.svg`, generated locally with resvg by
`npm --prefix web run icons`. These are deterministic renders of the shared abstract R
vector used by the home, login and admin pages, with an opaque cool-white background. No external artwork or generated image is used.

The 192px and 512px icons serve standard launchers, the 180px icon serves Apple home
screens, and the separate maskable icon keeps the mark inside the central safe circle.

The same generation task synchronizes `/routepilot-mark.svg` with the canonical vector.
