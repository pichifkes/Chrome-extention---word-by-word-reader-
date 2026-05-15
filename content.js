// content.js — SwiftRead Enhanced
// RSVP speed reader with adaptive pacing for long/hyphenated words and code blocks

(function () {
  'use strict';

  if (window.__sreLoaded) return;
  window.__sreLoaded = true;

  // ================================================================
  // SETTINGS
  // ================================================================

  const DEFAULTS = {
    cpm: 800,                  // characters per minute (base speed)
    font: 'system-ui',         // display font
    longWordThreshold: 8,      // chars — words longer than this slow down
    longWordMultiplier: 1.5,   // duration multiplier for long words
    hyphenMultiplier: 1.8,     // extra multiplier for hyphenated words
    minDurationMs: 80,         // fastest a word can be shown
    maxDurationMs: 2000,       // slowest a word can be shown
  };

  let cfg = { ...DEFAULTS };

  function loadSettings() {
    return new Promise(resolve => {
      chrome.storage.sync.get(DEFAULTS, data => {
        cfg = { ...DEFAULTS, ...data };
        resolve();
      });
    });
  }

  function saveSettings(partial) {
    cfg = { ...cfg, ...partial };
    chrome.storage.sync.set(cfg);
  }

  // ================================================================
  // TOKEN BUILDING
  // ================================================================

  /** Index of the Optimal Recognition Point (~35% into the word). */
  function orpIndex(word) {
    return Math.max(0, Math.min(Math.floor(word.length * 0.35), word.length - 1));
  }

  /**
   * Calculate how long to display a word (ms) based on CPM.
   * Long words and hyphenated compounds get a multiplier.
   */
  function wordDuration(word) {
    // Use only alphanumeric length for the base CPM calculation
    const effectiveLen = Math.max(1, word.replace(/[^a-zA-Z0-9]/g, '').length);
    const baseMs = (effectiveLen / cfg.cpm) * 60_000;

    let multiplier = 1;
    const stripped = word.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '');
    if (stripped.length > cfg.longWordThreshold) multiplier *= cfg.longWordMultiplier;
    // Hyphenated compounds: e.g. "state-of-the-art", "well-known"
    if (word.includes('-') && word.replace(/-/g, '').length > 3) multiplier *= cfg.hyphenMultiplier;

    return Math.min(Math.max(baseMs * multiplier, cfg.minDurationMs), cfg.maxDurationMs);
  }

  function makeWordToken(word) {
    const i = orpIndex(word);
    return {
      type: 'word',
      text: word,
      before: word.slice(0, i),
      orp:    word[i] ?? word[0],
      after:  word.slice(i + 1),
      duration: wordDuration(word),
    };
  }

  function makeCodeToken(text) {
    return { type: 'code', text: text.trim() };
  }

  // ================================================================
  // DOM → TOKEN EXTRACTION
  // ================================================================

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'BUTTON', 'INPUT',
    'SELECT', 'TEXTAREA', 'IFRAME', 'CANVAS', 'VIDEO', 'AUDIO',
    'NAV', 'FOOTER', 'HEADER', 'ASIDE',
  ]);

  const CODE_BLOCK_TAGS = new Set(['PRE']);   // treated as a single code token
  const INLINE_CODE_TAGS = new Set(['CODE', 'KBD', 'SAMP', 'TT']); // treated as words

  /**
   * Recursively walk a DOM subtree and build a flat token array.
   * @param {Node} node
   * @param {Array} tokens   accumulator
   * @param {boolean} inPre  are we already inside a <pre>?
   */
  function extractTokens(node, tokens = [], inPre = false) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (inPre) return tokens; // handled by the PRE element handler
      const text = node.textContent;
      const words = text.split(/\s+/).filter(w => w.length > 0);
      words.forEach(w => tokens.push(makeWordToken(w)));
      return tokens;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return tokens;

    const tag = node.tagName;
    if (SKIP_TAGS.has(tag)) return tokens;

    // Whole <pre> block becomes one code token (includes nested <code>)
    if (CODE_BLOCK_TAGS.has(tag)) {
      const text = node.textContent.trim();
      if (text) tokens.push(makeCodeToken(text));
      return tokens;
    }

    for (const child of node.childNodes) {
      extractTokens(child, tokens, false);
    }
    return tokens;
  }

  /** Find the most-likely main content element on the page. */
  function findMainContent() {
    const selectors = [
      'main', '[role="main"]', 'article',
      '.post-content', '.article-body', '.article-content',
      '.entry-content', '.content', '.page-content',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return document.body;
  }

  function tokensFromPage() {
    return extractTokens(findMainContent());
  }

  function tokensFromSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return [];
    const range = sel.getRangeAt(0);
    const frag = range.cloneContents();
    const wrapper = document.createElement('div');
    wrapper.appendChild(frag);
    return extractTokens(wrapper);
  }

  // ================================================================
  // READER STATE
  // ================================================================

  let overlay = null;

  const state = {
    tokens: [],
    index: 0,       // index of NEXT token to display
    playing: false,
    timer: null,
    waitingForCode: false,
  };

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

        <!-- ── Controls ── -->
        <div id="sre-controls">
          <button class="sre-btn" id="sre-prev"      title="Back (←)">⏮</button>
          <button class="sre-btn" id="sre-playpause" title="Play/Pause (Space)">▶</button>
          <button class="sre-btn" id="sre-next"      title="Forward (→)">⏭</button>

          <div id="sre-speed-wrap">
            <span id="sre-speed-label">800 CPM</span>
            <input type="range" id="sre-speed-input" min="100" max="3000" step="50" value="800">
          </div>

          <select id="sre-font-select" title="Display font"></select>

          <button class="sre-btn" id="sre-close" title="Close (Esc)">✕</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // ── Events ──────────────────────────────────────────────────
    overlay.querySelector('#sre-playpause').addEventListener('click', togglePlay);
    overlay.querySelector('#sre-prev').addEventListener('click', () => seekBy(-1));
    overlay.querySelector('#sre-next').addEventListener('click', () => seekBy(+1));
    overlay.querySelector('#sre-close').addEventListener('click', closeReader);
    overlay.querySelector('#sre-code-continue').addEventListener('click', onCodeContinue);

    // Speed slider
    const speedInput = overlay.querySelector('#sre-speed-input');
    speedInput.value = cfg.cpm;
    overlay.querySelector('#sre-speed-label').textContent = `${cfg.cpm} CPM`;
    speedInput.addEventListener('input', e => {
      cfg.cpm = parseInt(e.target.value, 10);
      overlay.querySelector('#sre-speed-label').textContent = `${cfg.cpm} CPM`;
      saveSettings({ cpm: cfg.cpm });
    });

    // Click backdrop to close
    overlay.addEventListener('click', e => {
      if (e.target === overlay) closeReader();
    });

    document.addEventListener('keydown', handleKeydown);

    // Populate font list (async — fires after overlay is shown)
    populateFontSelector();
  }

  // ================================================================
  // FONT SELECTOR
  // ================================================================

  const COMMON_FONTS = [
    'system-ui',
    'Arial', 'Arial Narrow',
    'Georgia', 'Garamond', 'Palatino Linotype',
    'Times New Roman',
    'Courier New', 'Lucida Console', 'Consolas',
    'Verdana', 'Trebuchet MS', 'Tahoma',
    'Impact', 'Comic Sans MS',
  ];

  async function populateFontSelector() {
    const select = overlay.querySelector('#sre-font-select');
    let fonts = COMMON_FONTS;

    try {
      if ('queryLocalFonts' in window) {
        const localFonts = await window.queryLocalFonts();
        const families = [...new Set(localFonts.map(f => f.family))].sort();
        fonts = ['system-ui', ...families];
      }
    } catch (_) {
      // Permission denied or API unavailable — fall back to common list
    }

    fonts.forEach(family => {
      const opt = document.createElement('option');
      opt.value = family;
      opt.textContent = family;
      opt.style.fontFamily = family;
      if (family === cfg.font) opt.selected = true;
      select.appendChild(opt);
    });

    applyFont(cfg.font);

    select.addEventListener('change', e => {
      const font = e.target.value;
      saveSettings({ font });
      applyFont(font);
    });
  }

  function applyFont(font) {
    if (!overlay) return;
    const display = overlay.querySelector('#sre-word-display');
    if (display) display.style.fontFamily = `"${font}", system-ui, sans-serif`;
  }

  // ================================================================
  // DISPLAY LOGIC
  // ================================================================

  function renderToken(token) {
    if (!overlay) return;

    const wordView = overlay.querySelector('#sre-word-view');
    const codeView = overlay.querySelector('#sre-code-view');

    if (token.type === 'code') {
      wordView.hidden = true;
      codeView.hidden = false;
      overlay.querySelector('#sre-code-content').textContent = token.text;
      // Pause and wait for user to click Continue
      state.waitingForCode = true;
      pauseReader();
      return;
    }

    wordView.hidden = false;
    codeView.hidden = true;
    overlay.querySelector('#sre-word-before').textContent = token.before;
    overlay.querySelector('#sre-word-orp').textContent    = token.orp;
    overlay.querySelector('#sre-word-after').textContent  = token.after;

    // Progress bar
    const pct = state.tokens.length > 1
      ? ((state.index - 1) / (state.tokens.length - 1)) * 100
      : 100;
    overlay.querySelector('#sre-progress-fill').style.width = `${pct}%`;
  }

  // ================================================================
  // PLAYBACK CONTROL
  // ================================================================

  function tick() {
    if (!state.playing || state.waitingForCode) return;
    if (state.index >= state.tokens.length) {
      stopReader();
      return;
    }

    const token = state.tokens[state.index];
    state.index++;
    renderToken(token);

    if (state.waitingForCode) return; // renderToken paused us

    const duration = token.type === 'word' ? token.duration : 0;
    state.timer = setTimeout(tick, duration);
  }

  function startReader(tokens) {
    if (tokens.length === 0) return;

    state.tokens = tokens;
    state.index = 0;
    state.playing = false;
    state.waitingForCode = false;
    clearTimeout(state.timer);

    createOverlay();
    overlay.style.display = 'flex';

    // Show first token immediately, then auto-play
    const first = state.tokens[0];
    state.index = 1;
    renderToken(first);

    if (!state.waitingForCode) {
      state.playing = true;
      state.timer = setTimeout(tick, first.duration ?? 300);
    }

    updatePlayPauseBtn();
  }

  function togglePlay() {
    if (state.playing) {
      pauseReader();
    } else {
      resumeReader();
    }
  }

  function pauseReader() {
    state.playing = false;
    clearTimeout(state.timer);
    updatePlayPauseBtn();
  }

  function resumeReader() {
    if (state.waitingForCode) return;
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
    // state.index is the NEXT token — currently displayed = index - 1
    const current = state.index - 1;
    const target  = Math.max(0, Math.min(state.tokens.length - 1, current + delta));

    state.index = target + 1;
    const token = state.tokens[target];

    // Reset code-wait if we jumped away from a code block
    if (token.type !== 'code') {
      state.waitingForCode = false;
      const wordView = overlay?.querySelector('#sre-word-view');
      const codeView = overlay?.querySelector('#sre-code-view');
      if (wordView) wordView.hidden = false;
      if (codeView) codeView.hidden = true;
    }

    renderToken(token);

    if (state.playing && !state.waitingForCode) {
      state.timer = setTimeout(tick, token.duration ?? 300);
    }
  }

  function onCodeContinue() {
    state.waitingForCode = false;
    const wordView = overlay?.querySelector('#sre-word-view');
    const codeView = overlay?.querySelector('#sre-code-view');
    if (wordView) wordView.hidden = false;
    if (codeView) codeView.hidden = true;
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

  function handleKeydown(e) {
    if (!overlay || overlay.style.display === 'none') return;
    switch (e.key) {
      case 'Escape':     e.preventDefault(); closeReader();     break;
      case ' ':          e.preventDefault(); togglePlay();      break;
      case 'ArrowRight': e.preventDefault(); seekBy(+1);        break;
      case 'ArrowLeft':  e.preventDefault(); seekBy(-1);        break;
      case 'ArrowUp':    e.preventDefault(); seekBy(+10);       break;
      case 'ArrowDown':  e.preventDefault(); seekBy(-10);       break;
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
    selBtn.style.left = `${x}px`;
    selBtn.style.top  = `${y}px`;
    selBtn.style.display = 'block';
  }

  function hideSelectionButton() {
    if (selBtn) selBtn.style.display = 'none';
  }

  document.addEventListener('mouseup', e => {
    if (e.target.closest('#sre-overlay') || e.target.closest('#sre-sel-btn')) return;
    setTimeout(() => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim().length > 3) {
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        showSelectionButton(
          window.scrollX + rect.right,
          window.scrollY + rect.bottom + 10,
        );
      } else {
        hideSelectionButton();
      }
    }, 10);
  });

  document.addEventListener('mousedown', e => {
    if (e.target.closest('#sre-sel-btn')) return;
    hideSelectionButton();
  });

  // ================================================================
  // MESSAGE LISTENER (from background.js / popup.js)
  // ================================================================

  chrome.runtime.onMessage.addListener(async message => {
    await loadSettings();
    if (message.action === 'readSelection') {
      const tokens = tokensFromSelection();
      if (tokens.length > 0) startReader(tokens);
    } else if (message.action === 'readPage') {
      const tokens = tokensFromPage();
      if (tokens.length > 0) startReader(tokens);
    }
  });

  // Eagerly load settings so they're ready when user clicks Read
  loadSettings();

})();
