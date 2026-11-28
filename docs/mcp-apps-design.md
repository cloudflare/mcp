# MCP Apps design system

Every MCP App should look like one family when a host puts them next to each other. Kumo provides the components, colours and type scale. This page covers what Kumo doesn't decide for us: how big a card's title is, where text starts, and how tall controls are.

**D1 Studio (`src/d1-studio/app/`) is the reference.** Its values below were measured in the playground (`?view=release`, 560 px inline, light theme) and come from `d1-studio.css`.

**This page describes; it doesn't yet rule.** D1 Studio is still in review (#444), so its values can move. Until it lands, this page records the family as it is, and [Where the Apps differ today](#where-the-apps-differ-today) lists each App's known differences with the date they were measured. Once D1 lands, the values here become the rule: when an App differs, change the App; change this page, and D1 with it, only when the family's design changes.

See it drawn at `http://localhost:5180/design.html` (the playground's **Design** link), with guides, light and dark, and each App's title line as it is today. Compare every App with the playground's Release view (`http://localhost:5180/?view=release&display=inline&theme=light`), which shows each App side by side.

## Foundations

### Fonts

| Role      | Value                                                  | Source                                          |
| --------- | ------------------------------------------------------ | ----------------------------------------------- |
| Sans      | `ui-sans-serif, system-ui, sans-serif`                 | `app-shell/base.css`                            |
| Mono      | `'Paper Mono', ui-monospace, SFMono-Regular, Menlo, …` | D1's `--font-mono`, the dashboard Studio's mono |
| Root size | 14 px (`html` is never overridden)                     | `base.css`                                      |

Don't set `html { font-size }` or a different `font-family` on `body`. Kumo's `text-*` utilities are rem-based, so a 16 px root makes every Kumo size in the App bigger than in the other Apps.

### Type scale

All sizes are px. Kumo's `--text-xs/sm/base/lg` are 12/13/14/16.

| Token         | Size / line                    | Weight          | Colour              | Use                                                                    |
| ------------- | ------------------------------ | --------------- | ------------------- | ---------------------------------------------------------------------- |
| **Title**     | **15 / 20**                    | **500**         | `text-kumo-strong`  | The card's one title line, ellipsized to one line                      |
| Body          | 14 / 20                        | 400             | `text-kumo-default` | Sentences, cell text                                                   |
| Meta          | 12.5 / 20                      | 400             | `text-kumo-subtle`  | Counts, durations, state lines ("10 rows", "Running"), tabular numbers |
| Control label | 12.5 / 20                      | 500             | `text-kumo-default` | Ghost buttons, the copy trio, Run                                      |
| Footer        | 12 / 20                        | 400 (label 600) | `text-kumo-default` | Receipt and stats in the card's bottom band                            |
| Code          | 12 / 18 (11 / 15 under 440 px) | 400             | `text-kumo-default` | SQL, IDs, timestamps: `var(--font-mono)`                               |

Use `font-variant-numeric: tabular-nums` on anything that counts or ticks.

### No logo in the card

The card carries no Cloudflare logo. Both hosts draw the app's name and icon themselves, above or around the view:

- **ChatGPT**: "Do not include your logo as part of the response. ChatGPT will always append your logo and app name before the widget is rendered" (Apps SDK UI guidelines, Icons & imagery).
- **Claude** shows the app's icon in the view's title bar. Icons inside the view are monochrome and outlined, in the host's icon colours, never a coloured logo.

A mark in the card shows the logo twice. The title starts the card on its own, in the text column. To change the icon a host shows, declare it on the server (`serverInfo.icons`) or on the tool (`icons`), not in the view.

### Icons

Phosphor (`@phosphor-icons/react`), always `aria-hidden` unless the icon is the only label.

| Size | Weight                    | Use                                                        |
| ---- | ------------------------- | ---------------------------------------------------------- |
| 12   | bold (fill for Play/Send) | Inside 12.5 px controls: caret, check, pencil, sort        |
| 13   | bold                      | Copy, info, warning inside meta text                       |
| 15   | regular                   | Header icon buttons (fullscreen, open in dashboard)        |
| 16   | regular / fill            | Status glyph in the title's glyph column (failed, no rows) |

Phosphor's 1 em default is not a size: set `size` explicitly.

### Colour and surfaces

Kumo tokens only, no hex values in an App's chrome. Charts and syntax colours may use their own palettes, written down at the top of the App's CSS.

| Surface              | Light                                            | Dark                                    |
| -------------------- | ------------------------------------------------ | --------------------------------------- |
| Card                 | `--color-kumo-base`                              | base mixed 55% with `--color-kumo-tint` |
| Tray / recessed band | `--color-kumo-elevated`                          | base mixed 85% with tint                |
| Hover                | `--color-kumo-tint`                              | base mixed 30% with tint                |
| Ring                 | 1 px `--color-kumo-line`                         | same                                    |
| Focus                | 2 px `--color-kumo-focus` outline, `-2px` offset | same                                    |

Write each pair once as `light-dark()` custom properties on the card (see `.dq` in `d1-studio.css`).

## The card

| Property          | Value                                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `#root` padding   | 0: the card fills the frame                                                                                                  |
| Radius            | 12 px card, 6 px controls inside it (radii nest), 4 px chips                                                                 |
| Ring              | 1 px, drawn **inside** the card's box (`::after`, `inset: 0`) so no host clips it                                            |
| Shadow            | None: it would fall outside the frame                                                                                        |
| Width             | Fluid. The card is the query container (`container: <name> / inline-size`), and layout follows its width, never the viewport |
| Narrow breakpoint | `@container (width < 440px)`                                                                                                 |

### Grid

- **Text edge: 40 px.** The title, the SQL, state lines and the footer receipt all start here.
- **Glyph column: 40 px**, holding a 28 × 28 button 8 px in, so glyphs centre at 22 px.
- **Right edge: 8 px**, where the last control's box ends.
- **Title line**: `grid-template-columns: 40px minmax(0, 1fr) auto`, areas `glyph title meta`, min-height 28 px, 6 px above, 8 px below.
- **Footer band**: 40 px tall, 1 px top hairline, starting at the text edge less 8 px.

### Controls

| Control       | Height  | Padding | Radius | Label                                     |
| ------------- | ------- | ------- | ------ | ----------------------------------------- |
| Ghost button  | 26      | 0 8     | 6      | 12.5 / 500                                |
| Icon button   | 26 × 26 | none    | 6      | n/a                                       |
| Primary (Run) | 26      | 0 10    | 6      | 12.5 / 500, white on `--color-kumo-brand` |
| Glyph button  | 28 × 28 | none    | 6      | n/a                                       |

A choice between two or three outcomes that changes what the button writes (the spend card's **Email me** / **Stop Workers**) is a Kumo `Radio.Group` with `appearance="segmented"`, its legend kept for screen readers, placed above the form it changes. A setting that stops something (every Worker on an account) is confirmed with a Kumo `Checkbox` whose label says the consequence and names the account; the button explains what is missing rather than being disabled.

There is one primary button per card. Press feedback is `scale: 0.96` with a 160 ms `cubic-bezier(0.23, 1, 0.32, 1)` transition, and hover states sit behind `@media (hover: hover) and (pointer: fine)`.

## Where the Apps differ today

Measured on 27 November 2026 with the same settings as above. Every App now shares the title line (15 / 20, 500). The 16 px Cloudflare mark these Apps put before the title was removed from the threshold alerts on 27 November 2026 (see [No logo in the card](#no-logo-in-the-card)); D1 Studio and Worker deployment status still carry it until they change.

|                   | D1 Studio (reference) | Threshold alerts (Workers usage, billing, R2, spend) | Worker deployment status |
| ----------------- | --------------------- | ---------------------------------------------------- | ------------------------ |
| Font              | `ui-sans-serif`       | `--font-sans` (`-apple-system`), `html` 16 px        | `ui-sans-serif`          |
| Body line height  | 20 px                 | 21 px                                                | 21 px                    |
| Card radius       | 12 px                 | 8 px (LayerCard)                                     | 8 px                     |
| Ring              | inside, `kumo-line`   | border, `kumo-hairline`                              | border, `kumo-line`      |
| `#root` padding   | 0                     | 12 px (card is 536 px of 560)                        | 12 px                    |
| Primary button    | 26 px, 12.5 px label  | 36 px, 14 px label                                   | Kumo default             |
| Mono              | Paper Mono 12 / 18    | none                                                 | `ui-monospace` 12 / 18   |
| Narrow breakpoint | 440 px                | 460 px                                               | 480 px                   |

**Threshold alerts: a dated exception (27 November 2026).** The card was laid out at a 16 px root before this page existed: its chart, slider hit area and email field are sized in rem against it, and its form is a full-width field and button, not a toolbar of 26 px controls. Moving it to the 14 px root and D1's density is a re-layout of the chart and form, checked at 352 and 560 px in both themes, so it waits until D1 lands and these values are the rule.

## Checklist for a new App, or a change to one

- [ ] Imports `app-shell/base.css` and doesn't override `html`/`body` font or size.
- [ ] Title is 15 / 20, weight 500, `text-kumo-strong`, one line.
- [ ] No logo or `CloudflareLogo` in the card: the host shows the app's name and icon.
- [ ] Text starts at 40 px and controls end 8 px from the right edge.
- [ ] Card is 12 px radius with an inside 1 px `kumo-line` ring, no shadow, `#root` padding 0.
- [ ] Controls are 26 px tall with 6 px radius, and there is one primary button.
- [ ] Icons are Phosphor at an explicit size from the table above.
- [ ] Meta and numbers are 12.5 px, subtle, tabular.
- [ ] Every colour is a Kumo token, or a documented `light-dark()` pair.
- [ ] Layout uses a container query on the card, with the narrow break at 440 px.
- [ ] Checked side by side with D1 in the playground's Release view, in light and dark.
