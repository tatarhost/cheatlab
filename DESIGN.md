# CHEATLAB — DESIGN.md

## Product
CHEATLAB is a public creator workspace for publishing and discovering scripts, apps, code pastes, images, video and files. The same application contains accounts, profiles, chat, email, access keys, statistics, downloads and administration.

The interface must feel like one coherent professional web product. Preserve every route, API call, permission rule, upload flow, account flow, editor, media viewer and mobile navigation behavior.

## Visual direction
**Material paper workspace.** The default CHEATLAB interface is a tactile industrial/editorial desk: warm paper, matte cards, deep graphite controls, ruled dividers and one functional blue accent. It should feel closer to a well-made instrument or a Swiss editorial system than to a landing-page template.

- The default theme uses `#f1efe9` paper, `#fbfaf7` matte surfaces, `#1c1c20` graphite and `#1d57e8` blue.
- Frutiger Aero remains an optional compatibility theme and keeps its existing mascot identity when explicitly selected.
- Surface texture comes from one generated 96×96 film-grain tile, used through `--noise-url`; use ribbed headers, diagonal hatching and ruler grids only when they explain an interaction.
- Use restrained radii, one-pixel rules, consistent iconography and readable metadata. Avoid dark neon, purple/pink gradients, decorative blobs, skeleton loaders and visual clutter.
- Keep text and icons on an unfiltered HTML layer whenever an SVG filter is used for a physical/merging surface.

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
Motion is part of the interface system and is calculated as an interruptible physical response:
- The shared motion engine uses a fixed 60 Hz `requestAnimationFrame` step with spring stiffness and damping for hover travel, press feedback and route arrival.
- Buttons and icon controls respond on press (140ms target), with a restrained ripple and a small magnetic offset on a fine pointer.
- Navigation and tabs animate selection and press states without reflowing the page.
- Panels, message workspaces and page surfaces enter as one coordinated surface rather than a cascade of unrelated cards.
- Dialogs, drawers and menus use 180–300ms ease-out transitions.
- Use transforms, `translate`/`scale` and opacity; never animate layout dimensions in the shared shell.
- Respect `prefers-reduced-motion`; the spring engine settles immediately and decorative motion is disabled.

## Engineering constraints
- CSS-only visual changes wherever possible; no new framework or dependency.
- Do not change application state, router semantics, API contracts, authentication, permissions, upload behavior or data logic.
- Keep Frutiger Aero isolated from the default professional theme.
- Verify desktop and narrow mobile layouts before claiming visual QA.

## Files
- `public/style.css`: foundational styles and structural fallbacks.
- `public/redesign.css` and `public/design-refresh.css`: shared legacy layers kept for route-specific fallbacks.
- `public/professional.css`: final material-paper visual layer for the default theme.
- `public/motion.css`: responsive motion refinements.
- `public/motion.js`: route accessibility, noise generation and the shared spring interaction engine.
