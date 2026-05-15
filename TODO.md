# SwiftRead Enhanced — Tasks & Known Issues

## How to set up Git (one-time)
The `.git` folder was corrupted during scaffolding. Run this in the project folder:
```
rmdir /s /q .git && git init && git add . && git commit -m "feat: initial commit"
```

---

## Open Tasks

### High priority

- [ ] **#1 — `queryLocalFonts` permission prompt**
  The `queryLocalFonts()` API requires the user to grant `local-fonts` permission at runtime.
  Currently the extension silently falls back to the built-in list if permission is denied.
  **To fix:** Add a small "Grant font access" button in the popup that calls
  `window.queryLocalFonts()` with a user gesture, so Chrome shows the permission dialog.

- [ ] **#2 — ORP lands on punctuation for hyphenated words**
  Example: `"state-of-the-art"` → ORP index 5 = `"-"` (a dash, not a letter).
  **To fix:** In `orpIndex()`, skip past leading/trailing punctuation when picking the
  highlighted character, or compute ORP on the stripped word then map back.

- [ ] **#3 — Selection extraction misses mixed text+code selections**
  When the user selects text that spans both a `<p>` and a `<pre>` block, the `<pre>` is
  caught as a code token ✓ but inline `<code>` inside prose is treated as plain words ✓.
  Edge case: `<pre><code>…</code></pre>` nesting — outer `<pre>` is captured correctly but
  inner text may be double-counted if the DOM has unusual nesting.
  **To fix:** Add a guard in `extractTokens` to skip child nodes once a `PRE` is matched.

- [ ] **#4 — `readPage` on single-page apps may get stale content**
  `findMainContent()` reads the DOM once. On React/Vue/Angular SPAs the content area may
  not yet be rendered when the message arrives.
  **To fix:** Add a short `MutationObserver`-based wait, or let the user trigger via
  text selection instead.

---

### Medium priority

- [ ] **#5 — No visual indicator when reader reaches the end**
  The reader silently stops. User has to notice the word stopped updating.
  **To fix:** Show a brief "Done ✓" state in `#sre-word-display` and change the play
  button to a restart icon.

- [ ] **#6 — Speed slider in overlay doesn't recalculate existing token durations**
  Changing CPM mid-read only affects the *next* `setTimeout` call, not pre-computed
  `token.duration` values baked in at parse time.
  **To fix:** Store raw word lengths in tokens; compute `duration` dynamically in `tick()`
  using the current `cfg.cpm` rather than at parse time.

- [ ] **#7 — `<pre>` blocks inside `<blockquote>` or `<details>` are skipped**
  `SKIP_TAGS` does not include `BLOCKQUOTE` or `DETAILS`, but some sites wrap code in
  unusual containers that may trigger the skip path.
  **To fix:** Audit `SKIP_TAGS` list; add `DETAILS` handling so `<summary>` text is read
  and `<pre>` inside is caught.

- [ ] **#8 — Popup "Read This Page" fails silently if content script hasn't loaded**
  On pages where the extension wasn't injected (e.g. `chrome://` pages, PDF viewer),
  `sendMessage` throws an error that the popup doesn't surface.
  **To fix:** Wrap `chrome.tabs.sendMessage` in `background.js` in a try/catch and send
  back an error response; show a toast in the popup.

---

### Low priority / nice-to-have

- [ ] **#9 — Add sentence-boundary pause**
  Words ending in `.`, `!`, or `?` could get a small extra pause (e.g. 1.3×) to mimic
  natural reading rhythm.

- [ ] **#10 — Remember reading position per page**
  If the user closes the reader mid-article and reopens it, it restarts from word 0.
  Use `chrome.storage.session` keyed by URL to restore position.

- [ ] **#11 — Add WPM display alongside CPM**
  Users familiar with WPM-based tools (SwiftRead, Spreeder) may find CPM unintuitive.
  Show an estimated WPM in parentheses next to the CPM label (≈ CPM / 5).

- [ ] **#12 — Extension icon missing**
  No icon is provided. Chrome shows a grey puzzle-piece default.
  **To fix:** Add `icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png` and
  reference them in `manifest.json` under `"icons"` and `"action"`.

---

## Completed

- [x] Token parser with CPM-based word duration
- [x] Long-word slow-down (configurable threshold + multiplier)
- [x] Hyphenated compound slow-down (configurable multiplier)
- [x] Code block detection (`<pre>`) → pause + show full block → Continue
- [x] ORP (Optimal Recognition Point) highlighting
- [x] Floating "▶ Read" button on text selection
- [x] Context-menu triggers (selection + page)
- [x] Popup with CPM slider, multiplier sliders, reset button
- [x] System font picker with `queryLocalFonts` fallback
- [x] Light / dark theme via `prefers-color-scheme`
- [x] Keyboard shortcuts: Space, ←/→, ↑/↓, Esc
- [x] Progress bar
