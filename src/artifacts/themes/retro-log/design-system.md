# retro-log

A 70s field manual on a dark-brown binder sheet. Mustard carries the type, the sunset stripe is the identity.

## Tokens

Use semantic classes only; never raw Tailwind palette colors or inline hex.

- Surfaces: `bg-bg` (page), `bg-surface` (cards), `bg-sunken` (wells, code, table heads).
- Text: `text-fg`, `text-muted` (secondary only), `text-primary` (mustard highlights).
- Lines: `border-border` (hairlines), `border-border-strong` (form boxes, rules).
- Action: `bg-primary text-primary-fg`. `text-accent` (orange) only for one word in a title or one abort button.
- Status: `text-success`, `text-warning`, `text-error`, for status only.
- Shape: `rounded-sm`, `rounded-md`, `shadow-sm` (the button's 3px offset); cards are flat (`shadow-card` is none).
- Charts: read colors from CSS variables, e.g. `getComputedStyle(document.documentElement).getPropertyValue("--color-primary")`.

## Type

- `font-display` (Righteous): titles, big numbers, button labels. One weight; never bold it. Uppercase with letter spacing for buttons.
- `font-sans` / `font-mono` (Courier Prime): body, tables, code, IDs, anything longer than a line.
- `font-type` (Special Elite): captions, labels, entry numbers, form field names only. Never paragraphs, never code.

## Components (in tokens.css)

- `<div class="band"><i></i><i></i><i></i><i></i></div>`: the four-stripe sunset band. Once per page, at the very top, full width. Never a second one, never as a background.
- `<span class="stamp">verified</span>`: one stamp per page, always rotated, double-ruled.
- `<span class="label">no. 014</span>`: typewriter eyebrow for labels and captions.

## Rules

- Number everything: entries (`no. 001`), figures (`fig. 1`), sections (`01 · overview`).
- Lists of records are a numbered entries table (`bg-surface border border-border`, `bg-sunken` head row).
- Metadata goes in form boxes: `border border-border-strong rounded-sm p-3` with a `label` caption.
- One filled button per page (`bg-primary text-primary-fg font-display uppercase tracking-widest rounded-full shadow-sm px-5 py-2`); others are ghost (`border border-primary text-primary`).
- No gradients, no drop shadow larger than the button's.
