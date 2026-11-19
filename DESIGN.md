# CHEATLAB — DESIGN.md

## Product
CHEATLAB is a monochrome creator workspace for scripts, apps, code pastes, images, video, files, chat, email and account tools. Keep the application cohesive and preserve existing routes, API contracts, access rules, upload flows, account flows and mobile navigation.

## Visual direction
**Original black-and-white technical workspace.** The default interface is deep black, charcoal and off-white. It should feel deliberate, precise and understated rather than like a generic AI-generated dashboard.

- Dark monochrome is the default. Use a white/black inverse only where contrast or hierarchy requires it.
- Frutiger Aero remains an optional, isolated theme; it must not leak gradients, blue accents or glass effects into the default theme.
- Use thin dividers, mostly square or modestly rounded corners, strong typographic hierarchy and restrained motion.
- Avoid blue/purple accent colors, decorative gradients, nested cards, giant pills, inflated empty space, glowing borders and ornamental dashboard widgets.
- Use panels only for meaningful groups. Prefer plain lists and clear section rules for navigation and monitoring.

## Typography
- UI: system sans with an optional locally available IBM Plex Sans fallback.
- Code, secrets, IDs, timestamps and numeric metadata: monospace.
- Compact headings; body copy 14–16px; never shrink important controls below a comfortable touch target.

## Layout
- Desktop: persistent navigation rail, sticky utility/search bar and a readable content canvas.
- Tablet and mobile: preserve the compact horizontally scrollable bottom navigation and scroll hint, fixed mobile search, safe-area insets and floating publish action.
- Keep route-specific controls and semantics intact.

## Motion
- Short, functional transitions for focus, pressed and selected states.
- Animate opacity and transform only; do not animate layout dimensions.
- Respect prefers-reduced-motion.

## Engineering constraints
- CSS-first visual changes; do not replace the router or application framework.
- Keep the default theme strictly monochrome.
- Keep Frutiger Aero isolated.
- Verify the mobile navigation and important account flows after changes.
