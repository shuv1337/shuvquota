# v2 TUI PTY QA — `lib/tui/app.js` + `lib/tui/terminal.js` with the Phase 4 renderer

Date: 2026-09-18. Driver: `termctrl 0.6.0` (real PTY sessions, names `shuvquota-v2-qa-*`, all
stopped after use). Harness: `/tmp/shuvcode/shuvquota-watch-smoke.mjs` (parent-supplied; injects
`loadSnapshot`, fixture data only, **no credential files or network touched** — verified by reading
the harness: it never imports anything outside `lib/tui/app.js`). Scan 1 succeeds, scan 2 throws
`simulated unavailable scan`, scan 3+ succeed. Runtime `bun` unless noted; the exit hang was
re-checked under `node`.

Fixture per provider (codex/claude/grok/antigravity): 3 accounts `fixture-1..3`, plan `Pro`,
email `fixture@example.test`, windows `5h percentRemaining 64 resetsAt 2026-09-19T03:00Z`,
`Weekly percentRemaining 20 resetsAt 2026-09-23T00:00Z`. 12 account cards total.

No files were edited other than this report.

## Round 4 — account panel (`m`) and in-house key parsing

Date: 2026-10-20 (PDT). Driver: `termctrl`, sessions `sq-manage-qa2` (bun, 100×30) and
`sq-manage-node` (node, 90×28), both exited and pruned. Harness: `~/.cache/agent-ws/shuvquota-qa/watch-manage.mjs`
runs `runWatch` with the real `lib/accounts.js` and credential store in an isolated home
(`HOME` set at launch; the harness exits unless `os.homedir()` equals it) and a fixture
provider whose `login` presents a URL with `noBrowser` and asks for a pasted code. No
network, no real credentials.

| Check | Result |
| --- | --- |
| **BUG-4** (bun) Esc in the panel | **FIXED** — readline's decoder under Bun held the lone ESC, so Esc did nothing and the next key arrived as Alt+key. `terminal.js` now parses input chunks itself; Esc closes or cancels immediately under bun and node |
| `m` opens the panel over the shell, scoped to providers with owned stores (Cursor hidden) | PASS |
| Add: ←/→ provider, label, Enter → URL wrapped in the panel, code prompt, Ctrl-Y, paste, Enter → `Added Claude work`, rescan shows it in the sidebar | PASS; store written `0600` with `enrollment: "independent"` |
| Rename `work` → `personal`; Reauth then Esc → `Sign-in cancelled`; Remove with `y` → store `accounts: []` | PASS |
| Resize to 44×16 with the panel open: frame bounded, footer truncates | PASS |
| Ctrl-C at the code prompt with typed input: process exits, `RESTORED {"raw":false}`, nothing persisted | PASS |
| node: add, Esc cancel, Esc close, add with code, `q` quit | PASS |

A harness mistake in the first attempt matters for future harnesses: assigning
`process.env.HOME` inside a Bun script does not change `os.homedir()`, so that run listed
the real stores. Its sign-in was cancelled before any code was submitted; real store
mtimes were confirmed unchanged.

## Round 3 — re-verification after parent's BUG-3 fix (whole-frame clear before paint)

Fix under test (read-only): `terminal.write` now emits `\x1b[H\x1b[2J` + `lines.join("\r\n")` —
no erase after any cell, no trailing newline. `app.js` now renders through
`toDisplaySnapshot(state.snapshot, { showEmail })`. Unit tests `test/tui-terminal.test.js` +
`test/tui-app.test.js`: 17 pass / 0 fail (includes the new full-width regression test). Sessions
`shuvquota-v2-qa-r3-{80x24,120x40,verify}`, all stopped; `termctrl list --all` clean, no leftover
harness processes. Widths below are `cellWidth()` from `lib/tui/width.js`, not byte counts.

| Item | Round 2 | Round 3 |
|------|---------|---------|
| BUG-3 80 cols, filter `3`: card lines 2–6 | 79/46/61/61/79 | **FIXED** — 80/80/80/80/80, endings `──╮`, `  │`, `──╯` |
| BUG-3 120×40 fresh start: right-column card lines | right `│`/`╮`/`╯` missing | **FIXED** — 30 card lines all exactly 120; max cellWidth over the whole 40-row frame = 120, 0 lines > 120 |
| BUG-3 after resize 200×50 → 120×40 | — | **FIXED** — same 120/120/120/120/120 |
| BUG-3 back to 80×24 after resizes, filter `3` | — | **FIXED** — 80/80 |
| BUG-2 card gaps (rows 7, 13 at 80×24 filter `3`) | fixed | **still clean** — both rows empty (`cat -A` shows only `$`) |
| BUG-2 help `?` | fixed | **still clean** — 8 help lines, blank rows below |
| BUG-2 stale → recover title | fixed | **still clean** — `… next 60s · stale · ?` → `shuvquota · updated 04:18:24 PM · next 60s · ?` |
| BUG-2 resize 80×24 → 200×50 | fixed | **still clean** — 17 non-empty lines, single footer at row 50, row 2 = 198 cells (4 × 48 + 3 × 2) |
| BUG-1 `q` (bun) | fixed | **still fixed** — `RESTORED {"raw":false,"paused":true}`, `status` → `exited` within 1.5 s |
| BUG-1 Ctrl-C (bun, 120×40) | fixed | **still fixed** — `exited` |
| `e` via `toDisplaySnapshot` | — | **PASS** — `f***@example.test` → `e` → `fixture@example.test` (all cards, e.g. rows 3 and 9) → `e` → `f***@example.test` |

Commands (80×24 session):

```
termctrl start shuvquota-v2-qa-r3-80x24 --cols 80 --rows 24 -- bun /tmp/shuvcode/shuvquota-watch-smoke.mjs
termctrl wait  shuvquota-v2-qa-r3-80x24 "updated"
termctrl send  shuvquota-v2-qa-r3-80x24 text:3        ; termctrl show … | sed -n 2,6p   # cellWidth 80 ×5
termctrl send  shuvquota-v2-qa-r3-80x24 text:e        ; termctrl show … | sed -n 3p     # fixture@example.test
termctrl send  shuvquota-v2-qa-r3-80x24 text:e        ; termctrl show … | sed -n 3p     # f***@example.test
termctrl send  shuvquota-v2-qa-r3-80x24 text:?        ; termctrl show … | sed -n 2,11p  # clean help
termctrl send  shuvquota-v2-qa-r3-80x24 text:? text:1 text:r ; (stale) ; text:r ; (recovered, clean title)
termctrl resize shuvquota-v2-qa-r3-80x24 --cols 200 --rows 50 ; --cols 120 --rows 40 ; --cols 80 --rows 24
termctrl send  shuvquota-v2-qa-r3-80x24 text:q        ; termctrl status … → exited
```

**Status: BUG-1, BUG-2, BUG-3 all resolved on real PTYs. No remaining defects found in this round.**
Round-1 observations OBS-1…OBS-5 (design notes, not bugs) still stand. Full-frame `ESC[2J` redraw
once per frame at 1 Hz produced no visible flicker in `termctrl show` captures; if flicker is seen
on slow terminals later, the per-line erase-*before*-content variant from Round 2 is the
alternative.

## Round 2 — re-verification after parent's `lib/tui/terminal.js` fix (historical)

Fix under test (read-only): `previousPaused = input.readableFlowing !== true`;
`write()` emits `\x1b[H` + `lines.join("\x1b[K\r\n")` + `\x1b[K\x1b[J`. Unit tests
`test/tui-terminal.test.js` + `test/tui-app.test.js`: 16 pass / 0 fail. Sessions
`shuvquota-v2-qa-fix-*` and `shuvquota-v2-qa-el`, all stopped; `termctrl list --all` clean.

| Item | Round 1 | Round 2 |
|------|---------|---------|
| BUG-1 `q` (bun) — process exits | FAIL | **FIXED** — `RESTORED {"raw":false,"paused":true}`, `termctrl status` → `exited` within 1.5 s |
| BUG-1 `q` (node) | FAIL | **FIXED** — same |
| BUG-1 Ctrl-C (`termctrl send … ctrl-c`) | FAIL | **FIXED** — `exited` |
| BUG-1 external `kill -INT <pid>` | FAIL | **FIXED** — `exited` |
| BUG-2 help `?` over table | residue | **FIXED** — 8 clean help lines, blank below |
| BUG-2 shorter title after stale → recover | `?tale · ?` | **FIXED** — `shuvquota · updated 04:13:58 PM · next 60s · ?` |
| BUG-2 provider filter `3` card gaps | old table rows | **FIXED** — ROW_GAP lines blank |
| BUG-2 resize 80×24 → 200×50 | two footers | **FIXED** — single footer at row 50; 17 non-empty lines = 1 title + 3 rows × 5 + footer |
| BUG-2 resize → 120×40 → 60×20 | fragments right of grid/table | **FIXED** — no fragments, no line > cols |
| Full-width lines keep last cell | OK (round 1) | **REGRESSION — BUG-3** below |

### BUG-3 (new, introduced by the BUG-2 fix) — last cell erased on lines that exactly fill the width

**Observed.** At 80 cols with filter `3` (three 80-wide tier-3 cards), every card line is missing
its right border: `╭────…──` (79 cells), `│ claude · fixture-1 · Pro · f***@example.test` (46, no
closing `│`), `╰────…──` (79). Same at 120 cols (two 59-wide cards: the right card's `│`/`╮`/`╯`
missing; the left card's are intact because column 59 is not the last terminal column). At 200 cols
the 4-column grid is 198 cells wide, so borders survive — which is why the 200×50 screen looks
correct and the defect is width-dependent.

```
termctrl start shuvquota-v2-qa-fix-80x24 --cols 80 --rows 24 -- bun /tmp/shuvcode/shuvquota-watch-smoke.mjs
termctrl wait  shuvquota-v2-qa-fix-80x24 "updated"
termctrl send  shuvquota-v2-qa-fix-80x24 text:3
termctrl show  shuvquota-v2-qa-fix-80x24 | sed -n 2,6p     # cellWidth = 79 / 46 / 61 / 61 / 79, expected 80 each
```

**Root cause.** The renderer output is correct — the raw ANSI stream (`termctrl show --format ansi`)
shows `…example.test<spaces>│ ESC[K` with the `│` present. After writing the 80th cell the cursor
sits *on* column 80 with wrap pending (VT "last column flag"); `ESC[K` erases from the cursor
inclusive, so it wipes the cell just written. Confirmed app-independent at 80 cols
(`/tmp/shuvquota-audit/qa/el-lastcell.sh`):

| Sequence | Visible width | Last char |
|----------|---------------|-----------|
| 80 chars, then `ESC[K`, CRLF (current fix) | 79 | erased |
| 79 chars, then `ESC[K`, CRLF | 79 | intact |
| `ESC[K`, then 80 chars, CRLF | **80** | intact |
| 80 chars, then `ESC[J` (old trailing-J pattern) | 79 | erased |

(The old code had the same defect only on the *final* line before `ESC[J`; the new per-line `ESC[K`
extends it to every full-width line.)

**Suggested fix.** Erase *before* writing each line, not after:
`"\x1b[H" + lines.map(l => "\x1b[K" + l).join("\r\n") + "\r\n\x1b[J"` — or `"\x1b[H" +
lines.map(l => \`\x1b[K${l}\`).join("\r\n") + "\x1b[J"` with the caveat that `ESC[J` after a
full-width last line also erases its last cell, so either move to the next line first (as above)
or pad the final line. Regression test: `write(["x".repeat(cols)])` must produce no `ESC[K`/`ESC[J`
immediately after the cell at column `cols`; PTY check: `cellWidth` of every card line at 80×24 with
filter `3` equals 80.

Everything else from round 1 (widths, tiers, v2 fields, stale/recover, scroll, interval, `NO_COLOR`)
was not re-exercised beyond what the table above covers; the renderer and app were unchanged.

## Summary (round 1 — historical; see Round 2 for current status of BUG-1/BUG-2)

| Area | Result |
|------|--------|
| v2 field integration (`percentRemaining`, `resetsAt`) | **PASS** — 64%/20% and `resets 20:00 Fri` / `resets 17:00 Tue` (Pacific) render at every tier; no `--%`, no blank resets |
| Widths 40/60/80/120/200, 24×8 (fresh start) | PASS — 40/60/80 → tier-0 table (12 cards can't fit card tiers in 22 body rows), 120 → 2 cols tier 3, 200 → 4 cols tier 3, 24×8 → table + scroll |
| Live resize | PASS (layout) / **FAIL (screen residue, BUG-2)** |
| Refresh failure → stale → recover (`r` and timer) | PASS — previous data preserved, footer `error: Quota unavailable; retry with r`, title `· stale`, cleared on next success |
| Email toggle `e` | PASS at card tiers (`f***@example.test` ↔ `fixture@example.test`); no visible effect at tier 0 (table has no email column — see OBS-1) |
| Help `?` | PASS (toggles) / residue (BUG-2) |
| Provider filter `1–5` | PASS — filters, resets scroll, 3 cards re-tier to cards at 80 cols |
| Scroll `j/k`, arrows, PgUp/PgDn, clamp | PASS — `↓8` → `↑3 ↓5` → `↑8` (clamped) → `↑2 ↓6` |
| Interval `+`/`-`, floor 15 | PASS — 60 → 90 → 15 (five `-` presses stop at 15) |
| `NO_COLOR` | PASS — 0 colour SGR sequences in the ANSI stream (12 with colour on) |
| `q`, Ctrl-C, external SIGINT → raw mode restored | PASS — `RESTORED {"raw":false,...}` printed on the main screen for all three |
| Process exits after quit | **FAIL (BUG-1)** — process stays alive indefinitely after `q`, Ctrl-C, and SIGINT, on bun and node |

## Bugs (for parent to fix; app/terminal not modified)

### BUG-1 — process never exits after quit (`q`, Ctrl-C, SIGINT); bun and node

**Observed.** After `q`, the alt screen is left and the harness prints
`RESTORED {"raw":false,"paused":false}`, but `termctrl status` still reports `running` 8 s later
(same under `node`, and after `ctrl-c` and `kill -INT <pid>`). The `"paused":false` in the RESTORED
line is the tell: stdin was left flowing.

```
termctrl start shuvquota-v2-qa-80x24 --cols 80 --rows 24 -- bun /tmp/shuvcode/shuvquota-watch-smoke.mjs
termctrl wait  shuvquota-v2-qa-80x24 "updated"
termctrl send  shuvquota-v2-qa-80x24 text:q
sleep 8
termctrl show   shuvquota-v2-qa-80x24   # → RESTORED {"raw":false,"paused":false}
termctrl status shuvquota-v2-qa-80x24   # → shuvquota-v2-qa-80x24 running   ← should be exited
```

**Root cause (read-only analysis of `lib/tui/terminal.js`).** `start()` snapshots
`previousPaused = input.isPaused()` *before* calling `input.resume()`. On a fresh TTY
`process.stdin`, `readableFlowing` is `null`, and `isPaused()` returns `false` for `null`
(verified: `node -e` / `bun -e` both print `isPaused false flowing null` on a PTY). So `stop()`
takes the `previousPaused === false` branch, never calls `input.pause()`, and the resumed TTY
read handle keeps the event loop alive after `runWatch` resolves.

**Minimal repro outside the app** (`/tmp/shuvquota-audit/qa/{nopause,withpause}.mjs`):

```
# nopause.mjs:   setRawMode(true); resume(); setRawMode(false);            → status: running (hangs)
# withpause.mjs: setRawMode(true); resume(); setRawMode(false); pause();   → status: exited
```

**Suggested fix.** In `stop()`, restore flowing state from what it actually was:
treat `readableFlowing !== true` at start as "was not flowing" (so `pause()` runs), or
unconditionally `input.pause()` when the app resumed it. `test/tui-terminal.test.js` should assert
`input.pause` is called when the injected input starts with `readableFlowing === null`.

### BUG-2 — previous frame residue: lines are not cleared to end-of-line

**Observed.** Any frame whose line *n* is shorter than line *n* of the previous frame shows the tail
of the old line. `terminal.write` emits `\x1b[H` + `lines.join("\r\n")` + `\x1b[J`; `\x1b[J` only
clears from the cursor (end of the last line) downward, and empty padding lines (`""`) clear nothing.

Concrete screens (80×24 unless noted):

1. Help overlay over the table — `?`:
   ```
   q / Ctrl-C  Quitount    quota
   r  Refresh─────────────────────────────
   e  Toggle emailxture-1  5h 64% · wk 20%
   ```
2. Title after recovery from stale (title got shorter): `shuvquota · updated 04:06:19 PM · next 60s · ?tale · ?`
   and later `… next 14s · ?ale · ??`.
3. Provider filter `3` (3 cards, 1 column) over the 12-row table — old table rows remain in the
   ROW_GAP lines between cards: `claude       fixture-1  5h 64% · wk 20%` between card 1 and 2.
4. Live resize 80×24 → 200×50: the old footer stays visible at row 24 while the new footer is at
   row 50 (two footers on screen). Resize → 120×40 shows old 200-col card fragments to the right of
   the new 2-column grid; → 60×20 and 40×20 show old card borders to the right of the table.
5. 24×8, `2` (codex filter) after scrolling: header line reads `prov   account   quota4…` and a
   stale `grok    fixture…  5h 64…` row remains below the 3 codex rows.

```
termctrl start shuvquota-v2-qa-80x24 --cols 80 --rows 24 -- bun /tmp/shuvcode/shuvquota-watch-smoke.mjs
termctrl wait  shuvquota-v2-qa-80x24 "updated"
termctrl send  shuvquota-v2-qa-80x24 text:?      ; termctrl show shuvquota-v2-qa-80x24   # residue in help
termctrl send  shuvquota-v2-qa-80x24 text:? text:3 ; termctrl show shuvquota-v2-qa-80x24 # residue between cards
termctrl resize shuvquota-v2-qa-80x24 --cols 200 --rows 50 ; termctrl show shuvquota-v2-qa-80x24 # two footers
```

**Suggested fix.** In `terminal.write`, emit `\x1b[K` after every line (`lines.join("\x1b[K\r\n") +
"\x1b[K\x1b[J"`), or have `renderFrame` pad every line to `cols` cells. `\x1b[K` is cheaper and
also covers the ROW_GAP `""` lines and the title/footer.

## Observations (not bugs, or design notes for parent)

- **OBS-1** `e` has no visible effect at tier 0 (the table has no email column), yet the footer
  advertises `e email`. Expected per §3.3 table spec; consider hiding the hint at tier 0 or adding a
  redacted email column when width allows.
- **OBS-2** When the tier-0 table scrolls, the `provider/account/quota` header and rule scroll away
  with the rows (24×8 after `j`: first body row is `codex   fixture…`). Deterministic and
  bounded; a sticky header would need `renderTable`/`renderView` support (renderer change, out of
  scope here).
- **OBS-3** Scroll offset is clamped by `renderFrame` (`state.scroll = view.viewport.offset`), so
  repeated PgDn stays at `↑8` and a filter change resets to 0. Works as intended.
- **OBS-4** `NO_COLOR` is honoured only because the harness passes `color: !process.env.NO_COLOR`;
  `app.js` has no env check. Phase 5/6 CLI wiring must do the same (plus non-TTY → `false`).
- **OBS-5** Countdown title (`next Ns`) and footer interval update live once per second; `+`/`-`
  reset `nextRefreshAt` immediately (`next 90s` right after two `+`).
- **OBS-6** Initial provider skeleton (`loading: true` at provider level) — already reported
  separately; not re-verified here.

## Detailed evidence

### 80×24 fresh start (tier-0 table via height fallback; 12 cards)

```
shuvquota · updated 04:05:42 PM · next 60s · ?
provider     account    quota
───────────────────────────────────────
codex        fixture-1  5h 64% · wk 20%
…
antigravity  fixture-3  5h 64% · wk 20%
(blank to row 23)
q quit · r refresh · e email · 1–5 providers · 60s
```

### Provider filter `2` at 80 cols (3 cards → tier 3, redacted email by default)

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ codex · fixture-1 · Pro · f***@example.test                                  │
│ 5h     ███████████████████░░░░░░░░░░░  64% resets 20:00 Fri                  │
│ Weekly ██████░░░░░░░░░░░░░░░░░░░░░░░░  20% resets 17:00 Tue                  │
╰──────────────────────────────────────────────────────────────────────────────╯
```

`e` → header becomes `claude · fixture-1 · Pro · fixture@example.test`; `e` again → redacted.
Resets: `2026-09-19T03:00Z` = Fri 20:00 PDT, `2026-09-23T00:00Z` = Tue 17:00 PDT — correct.

### Refresh failure → stale → recover (`r`, `r`)

```
shuvquota · updated 04:05:42 PM · next 60s · stale · ?      ← title; timestamp unchanged
provider     account    quota                                ← previous data intact
…
error: Quota unavailable; retry with r                       ← footer
```
Second `r`: `shuvquota · updated 04:06:19 PM · next 60s · ?` and normal footer (modulo BUG-2 residue).

Timer-driven variant (session `shuvquota-v2-qa-nocolor`, interval set to 15 s with `-`×4):
`termctrl wait … "stale" --timeout 20000` succeeded (~15 s), and 16 s later the title showed
`updated 04:10:15 PM` with no `stale` — auto-recovery without keypress works.

### Interval floor

`+` `+` → `next 90s` / footer `90s`; then `-`×5 → `next 15s` / footer `15s` (not 0 or negative).

### 24×8 scrolling (body = 6 rows; table = 14 lines)

| Input | Footer |
|-------|--------|
| start | `↓8 · q quit · r refresh` |
| `j`×3 | `↑3 ↓5 · q quit · r refr` |
| `page-down` | `↑8 · q quit · r refresh` |
| `page-down` (clamp) | `↑8 · q quit · r refresh` |
| `page-up` | `↑2 ↓6 · q quit · r refr` |
| `down`×2 | `↑4 ↓4 · q quit · r refr` |
| `up` | `↑3 ↓5 · q quit · r refr` |
| `2` | no indicator; 3 codex rows; `prov`/`account` narrow headers, `…` truncation |

Every line ≤ 24 cells; title truncated `shuvquota · updated 04:…`.

### Fresh-start widths

| Size | Layout | Colour SGR in ANSI stream |
|------|--------|---------------------------|
| 40×20 | table, footer truncated `… 1–5 prov` | 12 |
| 60×20 | table | 12 |
| 80×24 | table | 12 |
| 120×40 | 2 columns, tier 3, 59-wide cards, 6 rows + 2 blank | 12 |
| 200×50 | 4 columns, tier 3, 48-wide cards; `antigravity · fixture-1 · Pro · f***@exampl…` truncated in header | 6 |
| 100×30 `NO_COLOR=1` | table | **0** |

### Live resize (session started 80×24, then `termctrl resize`)

200×50 → 4-col grid; 120×40 → 2-col grid; 60×20 → table; 40×20 → table with truncated title/footer.
Layout recomputed on every resize (`onResize: draw`); only defect is BUG-2 residue.

### Exit paths

| Path | RESTORED line | Alt screen left | Process exited |
|------|---------------|-----------------|----------------|
| `q` (bun) | `{"raw":false,"paused":false}` | yes | **no** (BUG-1) |
| `q` (node) | same | yes | **no** |
| Ctrl-C (`termctrl send … ctrl-c`) | same | yes | **no** |
| `kill -INT <bun pid>` | same | yes | **no** |

## Commands used (reference)

```
termctrl start <name> --cols C --rows R -- bun /tmp/shuvcode/shuvquota-watch-smoke.mjs
NO_COLOR=1 termctrl start <name> --cols 100 --rows 30 -- bun /tmp/shuvcode/shuvquota-watch-smoke.mjs
termctrl wait <name> "updated" | "stale" [--timeout 20000]
termctrl show <name> [--format ansi]
termctrl send <name> text:e | text:? | text:1..5 | text:r | text:+ | text:- | text:j | text:k | up | down | page-up | page-down | text:q | ctrl-c
termctrl resize <name> --cols C --rows R
termctrl status <name> ; termctrl list --all ; termctrl stop <name>
```

Sessions used and stopped: `shuvquota-v2-qa-80x24`, `-node`, `-24x8`, `-nopause`, `-withpause`,
`-fresh-40x20`, `-fresh-60x20`, `-fresh-120x40`, `-fresh-200x50`, `-nocolor`. `termctrl list --all`
shows none remaining; no `shuvquota-watch-smoke` processes left.
