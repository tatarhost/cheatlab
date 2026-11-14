# CHEATLAB — DESIGN.md

## Product
CHEATLAB is a public creator workspace for publishing and discovering scripts, apps, code pastes, images, video and files. The same application contains accounts, profiles, chat, email, access keys, statistics, downloads and administration.

The interface must feel like one coherent professional web product. Preserve every route, API call, permission rule, upload flow, account flow, editor, media viewer and mobile navigation behavior.

## Visual direction
**Modern professional workspace.** A familiar, polished web-app design with a calm neutral foundation, clear blue accent, precise typography, subtle depth, clean surfaces and generous but efficient spacing. This is the default visual direction; it is not Frutiger Aero and should not look like a generic landing-page template.

- Dark mode remains the default; light mode is fully supported.
- Frutiger Aero remains an optional theme and keeps its existing visual identity and animated mascot logo.
- Use restrained rounded surfaces, clear dividers, consistent iconography and readable metadata.
- Avoid excessive nested cards, oversized pills, decorative gradients, visual clutter and gimmicky motion.

## Typography
- UI: IBM Plex Sans with platform sans fallback.
- Code, IDs, timestamps and numeric metadata: IBM Plex Mono with platform mono fallback.
- Keep headings clear and compact; body copy readable at 14–16px.

## Layout
- Desktop: persistent 248px navigation rail, sticky utility/search bar, content canvas capped at 1500px.
- Tablet and mobile: preserve the compact horizontally scrollable bottom navigation and scroll hint, fixed mobile search, safe-area insets and floating publish action.
- Keep existing navigation structure and all route-specific controls.
- Lists stay scannable; use panels only for meaningful groups.

## Motion
Motion is part of the interface system:
- Buttons and icon controls respond on press (140ms).
- Hover/focus states animate color, border and elevation on pointer devices.
- Navigation and tabs animate selection and press states.
- Panels, message workspaces and page surfaces enter with short, subtle transitions.
- Dialogs, drawers and menus use 180–260ms ease-out transitions.
- Use transform and opacity; never animate layout dimensions.
- Respect `prefers-reduced-motion`; avoid motion that blocks interaction.

## Engineering constraints
- CSS-only visual changes wherever possible; no new framework or dependency.
- Do not change application state, router semantics, API contracts, authentication, permissions, upload behavior or data logic.
- Keep Frutiger Aero isolated from the default professional theme.
- Verify desktop and narrow mobile layouts before claiming visual QA.

## Files
- `public/style.css`: foundational styles.
- `public/redesign.css` and `public/design-refresh.css`: existing shared redesign layers.
- `public/professional.css`: final professional visual layer.
- `public/motion.css`: responsive motion refinements.
