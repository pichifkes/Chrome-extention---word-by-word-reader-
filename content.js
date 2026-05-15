// content.js — SwiftRead Enhanced

(function () {
  'use strict';

  if (window.__sreLoaded) return;
  window.__sreLoaded = true;

  // ================================================================
  // SETTINGS
  // ================================================================

  const DEFAULTS = {
    wpm:               250,
    charPenaltyFactor: 0.1,
    font:              'system-ui',
    hyphenMultiplier:  1.8,
    minDurationMs:     80,
    maxDurationMs:     2000,
  };

  let cfg = { ...DEFAULTS };

  function loadSettings() {
    return new Promise(resolve => {
      chrome.storage.sync.get(DEFAULTS, data => { cfg = { ...DEFAULTS, ...data }; resolve(); });
    });
  }

  function saveSettings(partial) {
    cfg = { ...cfg, ...partial };
    chrome.storage.sync.set(cfg);
  }

  // ================================================================
  // TOKEN BUILDING
  // ================================================================

  const LEADING_PUNCT  = /^[(\[{"'«‹"'`]+/;
  const TRAILING_PUNCT = /[)\]}"'»›"'`.,;:!?…]+$/;

  // Duration is always computed from current cfg so live WPM/penalty changes
  // take effect on the very next word without needing to restart.
  function wordDuration(word) {
    const base       = 60_000 / cfg.wpm;
    const chars      = word.replace(/[^a-zA-Z0-9]/g, '').length;
    const extraChars = Math.max(0, chars - 5);
    let   duration   = base + extraChars * base * cfg.charPenaltyFactor;
    if (word.includes('-') && word.replace(/-/g, '').length > 3) duration *= cfg.hyphenMultiplier;
    return Math.min(Math.max(duration, cfg.minDurationMs), cfg.maxDurationMs);
  }

  function makeWordToken(word, isLink = false) {
    const lead   = word.match(LEADING_PUNCT)?.[0]  ?? '';
    const trail  = word.match(TRAILING_PUNCT)?.[0] ?? '';
    const core   = word.slice(lead.length, word.length - trail.length);
    const target = core.length > 0 ? core : word;
    const i = Math.max(0, Math.min(Math.floor(target.length * 0.35), target.length - 1));
    return {
      type:   'word',
      text:   word,
      before: lead + target.slice(0, i),
      orp:    target[i] ?? target[0] ?? word[0],
      after:  target.slice(i + 1) + trail,
      isLink,
      ctx:    null,   // filled by annotateContext()
    };
  }

  function makeCodeToken(text)  { return { type: 'code',  text: text.trim(),    ctx: null }; }
  function makeTableToken(node) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll('script, style').forEach(el => el.remove());
    clone.querySelectorAll('*').forEach(el => {
      [...el.attributes].forEach(a => { if (a.name.startsWith('on')) el.removeAttribute(a.name); });
    });
    return { type: 'table', html: clone.outerHTML, ctx: null };
  }

  // ================================================================
  // BRACKET / QUOTE CONTEXT ANNOTATION
  // ================================================================

  // Only unambiguous open→close pairs. Straight ' and " are skipped because
  // they appear in contractions and are impossible to pair reliably.
  const CTX_OPEN = {
    '(':      ')',
    '[':      ']',
    '{':      '}',
    '“': '”',  // " → "
    '‘': '’',  // ' → '
    '«': '»',  // « → »
    '‹': '›',  // ‹ → ›
  };

  // Walk every token and attach token.ctx = { open, close } while inside a
  // bracket/quote, or null outside. Works across code/table blocks too.
  function annotateContext(tokens) {
    const stack = [];
    for (const token of tokens) {
      // Only word tokens can open/close brackets; others just inherit the stack.
      if (token.type === 'word') {
        const lead  = token.text.match(LEADING_PUNCT)?.[0]  ?? '';
        const trail = token.text.match(TRAILING_PUNCT)?.[0] ?? '';
        for (const ch of lead) {
          if (CTX_OPEN[ch]) stack.push({ open: ch, close: CTX_OPEN[ch] });
        }
        token.ctx = stack.length > 0 ? { ...stack[stack.length - 1] } : null;
        for (const ch of [...trail].reverse()) {
          if (stack.length && ch === stack[stack.length - 1].close) stack.pop();
        }
      } else {
        token.ctx = stack.length > 0 ? { ...stack[stack.length - 1] } : null;
      }
    }
  }

  // ================================================================
  // DOM → TOKEN EXTRACTION
  // ================================================================

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'BUTTON', 'INPUT',
    'SELECT', 'TEXTAREA', 'IFRAME', 'CANVAS', 'VIDEO', 'AUDIO',
    'NAV', 'FOOTER', 'HEADER', 'ASIDE',
  ]);

  function extractTokens(node, tokens = [], inPre = false, inLink = false) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (inPre) return tokens;
      node.textContent.split(/\s+/).filter(Boolean)
          .forEach(w => tokens.push(makeWordToken(w, inLink)));
      return tokens;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return tokens;

    const tag = node.tagName;
    if (SKIP_TAGS.has(tag)) return tokens;
    if (tag === 'PRE') {
      const t = node.textContent.trim(); if (t) tokens.push(makeCodeToken(t)); return tokens;
    }
    if (tag === 'TABLE') { tokens.push(makeTableToken(node)); return tokens; }
    if (tag === 'OL') {
      let n = parseInt(node.getAttribute('start') ?? '1', 10);
      for (const child of node.childNodes) {
        if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'LI')
          tokens.push(makeWordToken(`${n++}.`, inLink));
        extractTokens(child, tokens, false, inLink);
      }
      return tokens;
    }
    const nextLink = inLink || tag === 'A';
    for (const child of node.childNodes) extractTokens(child, tokens, false, nextLink);
    return tokens;
  }

  function findMainContent() {
    for (const sel of ['main', '[role="main"]', 'article', '.post-content', '.article-body',
                        '.article-content', '.entry-content', '.content', '.page-content']) {
      const el = document.querySelector(sel); if (el) return el;
    }
    return document.body;
  }

  function tokensFromPage()      { return extractTokens(findMainContent()); }
  function tokensFromSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return [];
    const frag = sel.getRangeAt(0).cloneContents();
    const wrap = document.createElement('div'); wrap.appendChild(frag);
    return extractTokens(wrap);
  }

  // ================================================================
  // READER STATE
  // ================================================================

  let overlay = null;
  const state = { tokens: [], index: 0, playing: false, timer: null, waitingForBlock: false };

  // ================================================================
  // OVERLAY CREATION
  // ================================================================

  function createOverlay() {
    if (overlay) return;

    overlay = document.createElement('div');
    overlay.id = 'sre-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = `
      <div id="sre-reader">

        <!-- ── Word view ── -->
        <div id="sre-word-view">
          <span id="sre-ctx-left"  aria-hidden="true"></span>
          <span id="sre-ctx-right" aria-hidden="true"></span>
          <div id="sre-orp-bar"></div>
          <div id="sre-word-display" aria-live="assertive" aria-atomic="true">
            <span id="sre-word-before"></span><span id="sre-word-orp"></span><span id="sre-word-after"></span>
          </div>
          <div id="sre-progress-track">
            <div id="sre-progress-fill"></div>
          </div>
        </div>

        <!-- ── Code view ── -->
        <div id="sre-code-view" hidden>
          <div id="sre-code-label">⌨ Code Block</div>
          <pre id="sre-code-content"></pre>
          <button id="sre-code-continue">Continue Reading →</button>
        </div>

        <!-- ── Table view ── -->
        <div id="sre-table-view" hidden>
          <div id="sre-table-label">⊞ Table</div>
          <div id="sre-table-content"></div>
          <button id="sre-table-continue">Continue Reading →</button>
        </div>

        <!-- ── Controls ── -->
        <div id="sre-controls">
          <button class="sre-btn" id="sre-prev"      title="Back 10 words (←)">⏮</button>
          <button class="sre-btn" id="sre-playpause" title="Play / Pause (Space)">▶</button>
          <button class="sre-btn" id="sre-next"      title="Forward 10 words (→)">⏭</button>

          <div id="sre-speed-wrap">
            <span id="sre-speed-label">250 WPM</span>
            <input type="range" id="sre-speed-input" min="50" max="800" step="10" value="250">
          </div>

          <div id="sre-penalty-wrap">
            <span id="sre-penalty-label">Penalty 10%</span>
            <input type="range" id="sre-penalty-input" min="0" max="0.5" step="0.05" value="0.1">
          </div>

          <select id="sre-font-select" title="Display font"></select>

          <button class="sre-btn" id="sre-close" title="Close (Esc)">✕</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector('#sre-playpause').addEventListener('click', togglePlay);
    // Buttons jump 10 words; arrow keys (handleKeydown) step 1 word for fine control.
    overlay.querySelector('#sre-prev').addEventListener('click', () => seekBy(-10));
    overlay.querySelector('#sre-next').addEventListener('click', () => seekBy(+10));
    overlay.querySelector('#sre-close').addEventListener('click', closeReader);
    overlay.querySelector('#sre-code-continue').addEventListener('click', onBlockContinue);
    overlay.querySelector('#sre-table-continue').addEventListener('click', onBlockContinue);

    // WPM slider
    const speedInput = overlay.querySelector('#sre-speed-input');
    const speedLabel = overlay.querySelector('#sre-speed-label');
    speedInput.value = cfg.wpm;
    speedLabel.textContent = `${cfg.wpm} WPM`;
    speedInput.addEventListener('input', () => {
      cfg.wpm = parseInt(speedInput.value, 10);
      speedLabel.textContent = `${cfg.wpm} WPM`;
      saveSettings({ wpm: cfg.wpm });
      // No need to reschedule — tick() recomputes duration from cfg on every call.
    });

    // Penalty slider
    const penaltyInput = overlay.querySelector('#sre-penalty-input');
    const penaltyLabel = overlay.querySelector('#sre-penalty-label');
    penaltyInput.value = cfg.charPenaltyFactor;
    penaltyLabel.textContent = `Penalty ${Math.round(cfg.charPenaltyFactor * 100)}%`;
    penaltyInput.addEventListener('input', () => {
      cfg.charPenaltyFactor = parseFloat(penaltyInput.value);
      penaltyLabel.textContent = `Penalty ${Math.round(cfg.charPenaltyFactor * 100)}%`;
      saveSettings({ charPenaltyFactor: cfg.charPenaltyFactor });
    });

    overlay.addEventListener('click', e => { if (e.target === overlay) closeReader(); });
    document.addEventListener('keydown', handleKeydown);
    populateFontSelector();
  }

  // ================================================================
  // FONT SELECTOR
  // ================================================================

  const COMMON_FONTS = [
    'system-ui', 'Arial', 'Arial Narrow',
    'Georgia', 'Garamond', 'Palatino Linotype', 'Times New Roman',
    'Courier New', 'Lucida Console', 'Consolas',
    'Verdana', 'Trebuchet MS', 'Tahoma', 'Impact', 'Comic Sans MS',
  ];

  async function populateFontSelector() {
    const select = overlay.querySelector('#sre-font-select');
    let fonts = COMMON_FONTS;
    try {
      if ('queryLocalFonts' in window) {
        const lf = await window.queryLocalFonts();
        fonts = ['system-ui', ...[...new Set(lf.map(f => f.family))].sort()];
      }
    } catch (_) {}
    fonts.forEach(family => {
      const opt = document.createElement('option');
      opt.value = opt.textContent = family;
      opt.style.fontFamily = family;
      if (family === cfg.font) opt.selected = true;
      select.appendChild(opt);
    });
    applyFont(cfg.font);
    select.addEventListener('change', e => { saveSettings({ font: e.target.value }); applyFont(e.target.value); });
  }

  function applyFont(font) {
    const d = overlay?.querySelector('#sre-word-display');
    if (d) d.style.fontFamily = `"${font}", system-ui, sans-serif`;
  }

  // ================================================================
  // DISPLAY LOGIC
  // ================================================================

  function showView(name) {
    // Use style.display directly to avoid the CSS specificity conflict where
    // `#sre-code-view { display:flex }` would override the [hidden] attribute.
    overlay.querySelector('#sre-word-view').style.display  = name === 'word'  ? ''     : 'none';
    overlay.querySelector('#sre-code-view').style.display  = name === 'code'  ? 'flex' : 'none';
    overlay.querySelector('#sre-table-view').style.display = name === 'table' ? 'flex' : 'none';
  }

  function renderToken(token) {
    if (!overlay) return;

    if (token.type === 'code') {
      showView('code');
      overlay.querySelector('#sre-code-content').textContent = token.text;
      state.waitingForBlock = true;
      pauseReader();
      return;
    }

    if (token.type === 'table') {
      showView('table');
      overlay.querySelector('#sre-table-content').innerHTML = token.html;
      state.waitingForBlock = true;
      pauseReader();
      return;
    }

    showView('word');
    overlay.querySelector('#sre-word-before').textContent = token.before;
    overlay.querySelector('#sre-word-orp').textContent    = token.orp;
    overlay.querySelector('#sre-word-after').textContent  = token.after;
    overlay.querySelector('#sre-word-display').classList.toggle('sre-is-link', !!token.isLink);

    // Bracket/quote context: show the opening char on the far left of the word
    // view and its matching close on the far right, persisting until the bracket closes.
    overlay.querySelector('#sre-ctx-left').textContent  = token.ctx?.open  ?? '';
    overlay.querySelector('#sre-ctx-right').textContent = token.ctx?.close ?? '';

    const pct = state.tokens.length > 1
      ? ((state.index - 1) / (state.tokens.length - 1)) * 100 : 100;
    overlay.querySelector('#sre-progress-fill').style.width = `${pct}%`;
  }

  // ================================================================
  // PLAYBACK CONTROL
  // ================================================================

  function tick() {
    if (!state.playing || state.waitingForBlock) return;
    if (state.index >= state.tokens.length) { stopReader(); return; }

    const token = state.tokens[state.index++];
    renderToken(token);
    if (state.waitingForBlock) return;
    // Recompute duration from current cfg on every tick so slider/key changes
    // take effect on the very next word with no restart required.
    state.timer = setTimeout(tick, token.type === 'word' ? wordDuration(token.text) : 0);
  }

  function startReader(tokens) {
    if (tokens.length === 0) return;
    annotateContext(tokens);   // fill bracket context in-place before display
    state.tokens        = tokens;
    state.index         = 0;
    state.playing       = false;
    state.waitingForBlock = false;
    clearTimeout(state.timer);

    createOverlay();
    overlay.style.display = 'flex';
    showView('word');          // ensure word view is visible from the start

    // Show first word, then wait for the user to press ▶ or Space.
    state.index = 1;
    renderToken(tokens[0]);
    updatePlayPauseBtn();
  }

  function togglePlay() { state.playing ? pauseReader() : resumeReader(); }

  function pauseReader() {
    state.playing = false;
    clearTimeout(state.timer);
    updatePlayPauseBtn();
  }

  function resumeReader() {
    if (state.waitingForBlock) return;
    state.playing = true;
    updatePlayPauseBtn();
    tick();
  }

  function stopReader() {
    state.playing = false;
    clearTimeout(state.timer);
    updatePlayPauseBtn();
  }

  function seekBy(delta) {
    clearTimeout(state.timer);
    const target = Math.max(0, Math.min(state.tokens.length - 1, state.index - 1 + delta));
    state.index  = target + 1;
    const token  = state.tokens[target];
    if (token.type !== 'code' && token.type !== 'table') state.waitingForBlock = false;
    renderToken(token);
    if (state.playing && !state.waitingForBlock) {
      state.timer = setTimeout(tick, token.type === 'word' ? wordDuration(token.text) : 0);
    }
  }

  // Dismiss code/table block and resume reading; the block view collapses
  // back to the word view immediately.
  function onBlockContinue() {
    state.waitingForBlock = false;
    showView('word');
    resumeReader();
  }

  function closeReader() {
    stopReader();
    if (overlay) overlay.style.display = 'none';
    document.removeEventListener('keydown', handleKeydown);
  }

  function updatePlayPauseBtn() {
    const btn = overlay?.querySelector('#sre-playpause');
    if (btn) btn.textContent = state.playing ? '⏸' : '▶';
  }

  // Adjust WPM by ±10 and sync the in-reader slider.
  // Because tick() calls wordDuration() at runtime the new speed takes effect
  // on the very next word automatically.
  function adjustWPM(delta) {
    cfg.wpm = Math.min(800, Math.max(50, cfg.wpm + delta));
    saveSettings({ wpm: cfg.wpm });
    const input = overlay?.querySelector('#sre-speed-input');
    const label = overlay?.querySelector('#sre-speed-label');
    if (input) input.value = cfg.wpm;
    if (label) label.textContent = `${cfg.wpm} WPM`;
  }

  function handleKeydown(e) {
    if (!overlay || overlay.style.display === 'none') return;
    switch (e.key) {
      case 'Escape':
        e.preventDefault(); closeReader(); break;
      case ' ':
        e.preventDefault();
        state.waitingForBlock ? onBlockContinue() : togglePlay();
        break;
      // Arrow keys = fine single-word seek; ⏮/⏭ buttons = 10-word jump.
      case 'ArrowRight': e.preventDefault(); seekBy(+1);    break;
      case 'ArrowLeft':  e.preventDefault(); seekBy(-1);    break;
      case 'ArrowUp':    e.preventDefault(); adjustWPM(+10); break;
      case 'ArrowDown':  e.preventDefault(); adjustWPM(-10); break;
    }
  }

  // ================================================================
  // FLOATING SELECTION BUTTON
  // ================================================================

  let selBtn = null;

  function showSelectionButton(x, y) {
    if (!selBtn) {
      selBtn = document.createElement('div');
      selBtn.id = 'sre-sel-btn';
      selBtn.innerHTML = '<button>▶ Read</button>';
      selBtn.querySelector('button').addEventListener('click', async () => {
        hideSelectionButton();
        await loadSettings();
        const tokens = tokensFromSelection();
        if (tokens.length > 0) startReader(tokens);
      });
      document.body.appendChild(selBtn);
    }
    selBtn.style.left    = `${x}px`;
    selBtn.style.top     = `${y}px`;
    selBtn.style.display = 'block';
  }

  function hideSelectionButton() { if (selBtn) selBtn.style.display = 'none'; }

  document.addEventListener('mouseup', e => {
    if (e.target.closest('#sre-overlay') || e.target.closest('#sre-sel-btn')) return;
    setTimeout(() => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim().length > 3) {
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        showSelectionButton(rect.right, rect.bottom + 10);
      } else { hideSelectionButton(); }
    }, 10);
  });

  document.addEventListener('mousedown', e => {
    if (!e.target.closest('#sre-sel-btn')) hideSelectionButton();
  });

  // ================================================================
  // MESSAGE LISTENER
  // ================================================================

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'readSelection') {
      loadSettings().then(() => { const t = tokensFromSelection(); if (t.length) startReader(t); });
    } else if (message.action === 'readPage') {
      loadSettings().then(() => { const t = tokensFromPage(); if (t.length) startReader(t); });
    }
  });

  loadSettings();

})();
