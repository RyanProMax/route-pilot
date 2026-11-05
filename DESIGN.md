---
name: route-pilot
description: A quiet public status sheet with visible choices and unruled observations.
colors:
  forest: "#244b3f"
  forest-hover: "#305e50"
  forest-active: "#1d3d33"
  healthy: "#159b76"
  slow: "#bd9425"
  error: "#d3635b"
  unknown: "#e0e5e3"
  white: "#ffffff"
  ink: "#22392f"
  muted: "#627168"
  secondary-ink: "#53665b"
  line: "#e9edea"
  tab-surface: "#f2f5f3"
  tab-hover: "#e8eee9"
  period-surface: "#e8eeea"
  progress-rail: "#edf0ee"
  range-track: "#f2f4f3"
  selection: "#dceee6"
typography:
  body:
    fontFamily: 'Manrope, "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "14px"
    fontWeight: 400
  brand:
    fontSize: "27px"
    fontWeight: 700
    letterSpacing: "-0.035em"
  title:
    fontSize: "15px"
    fontWeight: 600
    letterSpacing: "-0.01em"
  node:
    fontSize: "14px"
    fontWeight: 600
    lineHeight: "42px"
  secondary:
    fontSize: "12px"
    fontWeight: 400
  label:
    fontSize: "11px"
    fontWeight: 500
  amount:
    fontSize: "17px"
    fontWeight: 600
rounded:
  sample: "2px"
  control: "8px"
  period: "20px"
spacing:
  compact: "8px"
  related: "10px"
  small: "12px"
  content: "16px"
  group: "20px"
  section: "24px"
  separation: "32px"
components:
  node-tab:
    backgroundColor: "{colors.tab-surface}"
    textColor: "{colors.secondary-ink}"
    typography: "{typography.node}"
    rounded: "{rounded.control}"
    padding: "0 20px"
    height: "44px"
  node-tab-hover:
    backgroundColor: "{colors.tab-hover}"
  node-tab-selected:
    backgroundColor: "{colors.forest}"
    textColor: "{colors.white}"
  node-tab-selected-hover:
    backgroundColor: "{colors.forest-hover}"
  node-tab-selected-active:
    backgroundColor: "{colors.forest-active}"
  quota-row:
    padding: "28px 0"
  period-tag:
    backgroundColor: "{colors.period-surface}"
    textColor: "{colors.secondary-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.period}"
    padding: "0 13px"
  range-control:
    backgroundColor: "{colors.range-track}"
    typography: "{typography.secondary}"
    rounded: "{rounded.control}"
    padding: "4px"
  range-selected:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
  history-sample:
    rounded: "{rounded.sample}"
    padding: "0"
    height: "26px"
---

<!-- impeccable:design-contract
seed: a602ec91
scope: implemented public status surface
visual-authority: user-pinned minimal white single page; code-first
image-comp: none selected
quality-bar-reference: none selected
finish-review: ship; no material visual fixes
sources: web/src/status.tsx; web/src/status.css; web/status/index.html; web/public/routepilot-mark.svg
-->

# Design System: route-pilot

## Overview

**Creative North Star: "The Quiet Status Sheet"**

route-pilot makes public operational evidence easy to scan on a plain white page. A compact geometric route mark, forest-green node selection, an unfilled quota row, and evenly spaced history rows create a calm visual rhythm. Manrope gives Latin lettering a distinct voice while operating-system Chinese fonts keep the interface familiar and legible.

This record captures the implemented public status surface. Its composition follows the user-pinned, code-first direction and the contract in the HTML entry point, with seed `a602ec91`. No image composition or separate quality-bar reference was selected. The stylesheet and component theme are the implementation authority; the finish review returned **ship**, with no material visual fixes.

**Key Characteristics:**

- A white page with forest-green selection and an unfilled quota row.
- Visible, wrapping node choices with a country flag or globe.
- Unruled observation rows with aligned, tabular measurements.
- Four consistent state colors, always explained by words or the legend.
- A compact route-R mark and Manrope Latin lettering with system Chinese fallbacks.

## Colors

The palette pairs a deep forest accent with green-tinted neutrals; brighter colors belong to measured states.

### Primary

- **Forest:** `forest` identifies the selected node, the route mark, and keyboard focus. Its hover and active companions deepen or lighten the same interaction role.
- **Healthy Green:** `healthy` marks healthy samples, status dots, the route mark's endpoint, and the ordinary remaining-quota fill.

### Secondary

- **Slow Amber:** `slow` identifies the “缓慢” state and a low remaining quota.
- **Error Coral:** `error` identifies the “异常” state and the most depleted quota condition. These are semantic colors rather than additional brand accents.

### Neutral

- **White:** The page, table, selected time segment, and tooltip share `white`.
- **Forest Ink:** `ink` carries names and headings; `secondary-ink` carries supporting metrics and inactive node labels; `muted` carries timestamps, headers, and legend text.
- **Pale Surfaces:** `tab-surface`, `tab-hover`, `period-surface`, `progress-rail`, and `range-track` provide small, purpose-specific tonal changes.
- **Unknown Gray:** `unknown` marks “无数据” in both current states and history.
- **Fine Line:** `line` supports the table heading baseline; observation and event rows remain unruled.
- **Text Selection:** `selection` is the page's pale green selection highlight.

**The State Has Meaning Rule.** Keep 健康, 缓慢, 异常, and 无数据 consistent across current badges, history samples, the legend, and event records. Preserve a text explanation of color.

**The Evidence Before Green Rule.** Missing, failed-to-load, or stale current observations show no data. A green historical sample cannot establish current health.

## Typography

**Body Font:** Manrope, with PingFang SC, Microsoft YaHei, and generic sans-serif fallbacks as recorded in `typography.body`. The variable Manrope font is served locally and preloaded by the status entry point. Latin characters use Manrope; Chinese characters use the available system fallback.

**Character:** Rounded geometric Latin lettering and restrained weight changes make the page approachable without turning status into decoration. The page uses tabular numerals; no separate monospace family is introduced.

### Hierarchy

- **Brand:** `brand` gives the wordmark its tight spacing and strong weight. It contracts at the two mobile breakpoints.
- **Title:** `title` names the quota, stability, and optional event sections.
- **Body:** `body` is the table and page baseline; check names use a medium weight.
- **Node:** `node` makes the selected and available instances equally easy to locate.
- **Secondary:** `secondary` supports the update time, metrics, current states, and time-range control.
- **Label:** `label` supports column headings and the monthly tag; legend labels use the same size with regular weight.
- **Amount:** `amount` emphasizes the remaining quota, followed by a smaller, muted total and unit.

**The Stable Measurement Rule.** Keep numerals tabular and rate, duration, and quota values aligned. Preserve the em dash when a value is unavailable.

## Layout

The page is one centered column with a maximum width of 1040px and desktop side gutters of at least 40px. The header is 116px tall: the brand sits at the left and the update timestamp at the right. The main sequence is node selection, the quota row, stability records, and an optional list of state changes. The public surface has no sidebar, refresh action, row disclosure, or explanatory description block.

Node choices wrap naturally with a 10px gap. Each stays visibly selected during background updates; the control never becomes a horizontally scrolling tab rail. The quota row aligns with the observation table: heading with monthly tag, full-length meter, then the percentage and amount stacked at the right across the final two numeric columns. The rail uses the same 16px cell insets as history strips, so both ends align. It has no border or shadow. The history section begins 44px below it, with its title and time-range selector on one line.

The desktop observation table aligns check name with its current status dot, history, success rate, and connection duration. Rows are 78px tall, without bottom rules or hover fills. History samples are 26px tall with a 3px gap. Only the column-heading baseline separates the heading from the evidence. The legend is horizontally centered below the table. Event records, when present, use a compact unruled table below.

At **820px and below**, page gutters become 20px and the header contracts to 96px. The brand mark becomes 32px and its wordmark 23px. The quota heading and monthly tag share the first row; its full-width meter spans the second, with the percentage and remaining amount aligned at opposite ends below it. The history section begins after 36px. Table headings disappear, and each observation becomes a two-row grid: identity and metrics above a full-width history strip. The strip becomes 24px tall with a 2px gap, and the legend remains centered. No measurement column is discarded.

At **360px and below**, the wordmark becomes 21px, the mark 28px, and the time-range text 10px. Observation-column gaps contract to 8px. The reviewed 320px layout retains its visible node selector, quota, metrics, histories, and four-state legend.

**The Unruled Row Rule.** Use alignment and whitespace to separate observations. Keep borders, row hover fills, and enclosing cards out of the status list.

## Elevation & Depth

The main surface is flat. White space and alignment provide structure; the node tabs and history buttons have no resting shadow. The time-range control has a flat white selected segment with no hover fill, pressed fill or shadow; Ant Design's moving thumb preserves selection continuity. The soft floating treatment remains confined to history tooltips. Keyboard focus uses a forest outline, rather than lifting a surface.

The sidecar records the installed library's tooltip filter separately from the frontmatter's primitives.

## Shapes

The geometric route-R mark uses a continuous forest stroke with rounded joins and caps, plus a healthy-green endpoint. It is an inline-vector identity asset, also used as the favicon. Keep its original proportions and clear space beside the wordmark.

Node choices are individually rounded rectangles, with neither joined separators nor an enclosing track. The quota row has no enclosing fill, border, shadow, or container radius. The monthly tag is a small pill, status dots are circles, and history samples are narrow rectangles with minimally softened corners. The flag is a small rectangular asset with the same corner softening as history samples. No illustrative imagery is part of the current surface.

## Components

### Brand and Update Time

The route mark and wordmark form a home link. The update timestamp sits opposite them in muted type and reports the displayed data's update time. Both remain on one header line at the reviewed mobile widths. Static timestamp text has the default cursor.

The installed mobile app uses the same route mark on an opaque white launcher tile, with separate maskable and Apple exports. Standalone display retains the ordinary status page and respects device safe areas; no install banner or extra navigation is added. Offline launches use the same quiet brand treatment and a concise connection message with retry. Already-open pages preserve historical evidence while marking current health unavailable when offline.

### Node Selection

Ant Design `Radio.Group` with button options provides the node choices. Each label pairs a country flag, or a globe fallback, with a node name. The default surface is pale; selection uses white text on forest. Hover and pressed states use the recorded variants, and the controls remain flat.

The control height stays 44px. Horizontal padding contracts from 20px to 18px on mobile. The wrapper exposes a forest focus outline when its radio receives keyboard focus. Preserve radio semantics, a visible selection, and wrapping behavior when instances are added.

### Remaining Quota

An unfilled row aligned with the status sheet contains the heading, monthly tag, progress rail, percentage, and remaining/total amount. The rail matches the history strip width on desktop and fills the same available row on mobile; percentage text sits outside that aligned rail. The rail is 8px thick. Low remaining quota changes its fill to amber, then coral; missing or stale values show an em dash or “待更新”. The row itself is static and has the default cursor.

### Time Range

Ant Design `Segmented` provides the three time windows. The selected segment is white on a quiet gray-green track. Hover and pressed overlays are transparent, both the selected item and moving thumb are shadowless, and the library's thumb movement is retained. It stays beside the stability heading on mobile, with smaller text and track padding. Preserve its keyboard behavior and selected-state semantics; the control switches between three histories delivered by one bundled request. Switching never clears the table or triggers a request; one foreground poll updates all three windows every minute.

### Observations and History Samples

Observation rows are static records. A small current-status dot precedes each check name; its accessible label names the status. There is no separate current-status column or repeated status word. Credential and connection values are available in the history tooltips. Counts and their history representation follow the current data contract.

Each history sample is a button. Color carries its measured state; connection-history height may additionally encode count magnitude. Hover or keyboard focus slightly darkens a sample. All states keep zero-width borders and fixed hit targets. On fine-pointer hover, painted bars animate via transforms: the focused bar widens to 2.2× and grows upward to 1.12× height, with the two neighbors on each side narrowing to .55× and .85×. Their offsets preserve gaps and the total rail length. Endpoints use bounded 1.6×/2.05× expansion. Arrival uses 220ms and exit 160ms with cubic-bezier(0.16, 1, 0.3, 1). No layout width changes, moving hit regions, additional pointer handlers or animation dependency are needed. Touch keeps the original bar geometry; reduced-motion disables spatial expansion while preserving focus, color and tooltip feedback. Its accessible name includes the check, time interval, and state or value. The surrounding text and metrics keep the default cursor; only the sample controls use a pointer.

### History Tooltip

One tooltip is open at a time, sized to its content with no repeated check title or stretched spacing. Every tooltip uses two rows: a leading status dot followed by the state or measurements, then the time interval 6px below. Same-day ranges use `11/05 17:00 – 17:20`; intervals crossing local midnight retain both dates. When both credential and connection measurements exist, they share the first row with a 12px gap; the leading dot is 8px before the measurements. Omit unavailable credential data and retain a measured zero. Numeric values use semibold weight and units use secondary text. Content padding is 12px by 14px; width is intrinsic and capped at the viewport minus 24px. Missing observations retain “无数据” and its unknown-status dot. Pointer devices use hover and focus; touch devices use click. Changing node or time range closes the active tooltip. Keep outside dismissal and the single-tooltip behavior intact.

### Legend, Events, and Feedback

The four-state legend repeats the same dot-and-word treatment as current health. Optional state-change records align check, state, and time without header labels or row rules. Warnings, loading skeletons, and the empty state use the existing Ant Design components within the same page width. Initial loading uses one complete Ant Design skeleton, including the brand, update time, instance choice, quota, range control, table and legend. It is rendered into static HTML at build time, so no application download is required to reveal the layout. Its desktop and mobile geometry follows the loaded page; no actual labels or placeholder health claims are mixed into it. Range changes and background updates preserve the table; a failed refresh retains history and marks current readings unavailable.

Node-state color transitions last 180ms with an ease-out curve. Other library transitions remain brief. The reduced-motion query reduces animation and transition duration to 0.01ms. Global focus uses a 2px forest outline with a 4px offset; node wrappers use a 3px offset. Static text uses the default cursor, interactive controls use a pointer, and editable text fields, if introduced, use a text cursor.

## Do's and Don'ts

### Do:

- **Do** preserve the white single-page composition and visible, wrapping node selection.
- **Do** use the route-R vector mark and Manrope with system Chinese fallbacks.
- **Do** keep observations unruled, values aligned, and numerals tabular.
- **Do** explain status color with words or the four-state legend and preserve explicit no-data states.
- **Do** retain visible keyboard focus, touch-accessible history tooltips, and reduced-motion behavior.
- **Do** use the default cursor for static text and a pointer for interactive controls.
- **Do** keep all measurement fields available when rows reflow on narrow screens.

### Don't:

- **Don't** restore a sidebar, refresh button, disclosure rows, or description blocks to this public status surface.
- **Don't** turn the quota or observation rows into shadowed cards.
- **Don't** show historical success as current health when evidence is missing or stale.
- **Don't** use failure colors as decorative accents or turn unknown samples green.
- **Don't** hard-code account, deployment, or host identifiers into reusable visual examples.

## Host load and private management

Host metrics use the existing unfilled sheet: four columns on desktop and two on mobile. CPU, memory and disk use 4px rails; one-minute system load is numeric. Missing or stale readings show em dashes. The initial skeleton reserves the same space.

The private `/admin/` surface shares the brand, typography and Ant Design theme. It has a compact key form, host metrics and a read-only credential usage table; no sidebar or mutation controls. The table scrolls within its container on narrow screens. Usage is monthly upload/download payload bytes; reset gaps use an asterisk with an explanatory tooltip. No credentials or bearer URLs appear in the UI.

Verified login, logout, table content, metric layout and absence of page overflow at 1404px and 390px. Browser plugin was unavailable; standard Playwright with Chrome was used.
