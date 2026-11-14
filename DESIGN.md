# CHEATLAB — DESIGN.md

## Product and purpose

CHEATLAB is a public creator workspace for publishing and discovering scripts, apps, code pastes, images, video and files. The same application also contains user accounts, profiles, chat, email, access keys, statistics, downloads and administration.

The redesign must make the existing product feel like one coherent, deliberate tool. It must not remove, rename or break any route, API call, permission rule, upload flow, account flow, editor, media viewer or mobile navigation behavior.

## Audience and use scene

People visit to find or publish a particular item quickly, often from a phone. The interface therefore prioritizes scan speed, readable metadata, predictable navigation, reliable controls and clear loading/empty/error states. Code, identifiers and file metadata use a readable mono face; ordinary interface copy stays in a humanist sans.

## Visual direction

**A monochrome technical workspace with Swiss editorial structure.** The visual language is precise, calm and tool-like: strong typographic hierarchy, open list rows, measured separators, disciplined whitespace and a clear grid. The subject matter is a creator utility, not a marketing dashboard.

Preserve the existing user preference: classic black-and-white remains the default theme. Frutiger Aero remains an optional theme and keeps its existing visual identity and animated mascot logo. The redesign should harmonize structure, spacing and interaction quality across both themes without turning the default into Aero.

## Selected UI style

**Minimalism & Swiss Style** — UI-UX Pro Max style ID: `minimalism-and-swiss-style`.

Source: `skills/ui-ux-pro-max/data/styles.csv` in https://github.com/tatarhost/skills

Use its monochromatic base, grid alignment, essential controls, restrained depth and clear hierarchy. Do not imitate a generic SaaS card dashboard.

## Design tokens

### Classic dark (default)

| Token | Value | Role |
|---|---|---|
| `--paper` | `#090A0B` | page canvas |
| `--fog` | `#111316` | primary surface |
| `--fog-2` | `#191D21` | raised / selected surface |
| `--line` | `#2A3036` | separators and outlines |
| `--ink` | `#F1F3F4` | primary text |
| `--mute` | `#929BA4` | secondary text |
| `--accent` | `#F1F3F4` | primary action |
| `--accent-ink` | `#090A0B` | text on primary action |
| `--danger` | `#E56A6A` | destructive / error state |

### Classic light

| Token | Value | Role |
|---|---|---|
| `--paper` | `#F4F5F5` | page canvas |
| `--fog` | `#FFFFFF` | primary surface |
| `--fog-2` | `#ECEFF0` | raised / selected surface |
| `--line` | `#D9DEE1` | separators and outlines |
| `--ink` | `#171B1E` | primary text |
| `--mute` | `#626C74` | secondary text |
| `--accent` | `#171B1E` | primary action |
| `--accent-ink` | `#FFFFFF` | text on primary action |

### Typography

- UI and headings: IBM Plex Sans, with a platform sans fallback.
- Code, IDs, timestamps and numeric metadata: IBM Plex Mono, with a platform mono fallback.
- Headings use a compact, editorial scale; body copy remains comfortably readable.
- No all-caps eyebrow labels above every heading; labels are reserved for real metadata.

### Layout and shape

- Desktop: 248px navigation rail, sticky utility bar, centered content canvas capped at 1360px.
- Main spacing scale: 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64px.
- Controls: 8px radius. Panels: 12px. Larger overlays: 16px. Avoid one radius everywhere.
- Feed content uses open rows and dividers; use panels only where grouping carries meaning.
- Keep the compact horizontally scrollable mobile navigation and its scroll hint; respect safe areas.
- Preserve the existing fixed mobile search and floating publish action without overlap.

## Motion language

Motion explains state changes and spatial continuity; it is not decoration.

- Press feedback: 100–140ms, ease-out, subtle scale only.
- Hover/focus feedback: 140–180ms, color/border/opacity; no constant icon wiggles.
- Menus, drawers and dialogs: 180–260ms, enter from their origin, exits shorter than entrances.
- Route change: one page-level reveal up to 240ms; animate the page surface once, not every child.
- No scroll-triggered animation on every row or panel, no ambient infinite loops in the classic theme.
- Respect `prefers-reduced-motion`: remove transform/blur motion and keep a static state change.
- Use opacity and transform for movement; avoid layout-affecting animation.

## Components and interaction principles

- Navigation is persistent and visibly marks the current route.
- Search remains prominent and easy to reach on mobile.
- Primary actions are clear; secondary actions do not compete.
- Lists are information-first, metadata aligned, and resilient to long titles.
- Code/media surfaces retain their specialized presentation.
- Focus is visible; icon-only controls keep accessible names; keyboard users can complete all flows.
- Keep existing Aero theme, logo switching and user preference behavior.

## Explicit anti-patterns

No generic purple/blue gradient SaaS kit, identical nested cards, unnecessary glass blur in the classic theme, decorative glows, infinite icon motion, oversized pill controls, emoji icons, or animation on every element. No new framework or dependency for a CSS-level redesign.

## References used

- CHEATLAB current implementation: `public/index.html`, `public/style.css`, `public/redesign.css`, `public/app.js`.
- UI-UX Pro Max: Minimalism & Swiss Style.
- Frontend Design: distinctive, subject-grounded choices and restrained motion.
- Impeccable: new visual world and craft-floor references.
- Frontend UI Engineering: preserve architecture, state and responsive behavior.
- Design Engineering / animate / choreograph: purposeful, interruptible micro-interactions and restrained timing.
- better-ui / better-layout / better-typography / better-colors / better-accessibility: precise component polish and WCAG-aware behavior.

## Scope of this refresh

Retheme the shared shell and all existing page surfaces through a final CSS layer. Add a small motion controller for route transitions only. Do not change API contracts, data logic, router semantics or authentication/upload behavior.
