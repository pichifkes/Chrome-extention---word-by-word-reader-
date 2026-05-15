// content.js — SwiftRead Enhanced

(function () {
  'use strict';

  if (window.__sreLoaded) return;
  window.__sreLoaded = true;

  // ================================================================
  // SETTINGS
  // ================================================================

  const DEFAULTS = {
    wpm:              250,   // words per minute (base speed)
    charPenaltyFactor: 0.1,  // extra time per char above 5, as fraction of base word time
    font:             'system-ui',
    hyphenMultiplier: 1.8,
    minDurationMs:    80,
    maxDurationMs:    2000,
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

  const LEADING_PUNCT  = /^[(\[{"'«‹"'`]+/;
  const TRAILING_PUNCT = /[)\]}"'»›"'`.,;:!?…]+$/;

  // Duration in ms for one word.
  // Base = 60 000 / wpm. Each character above 5 adds charPenaltyFactor × base.
  function wordDuration(word) {
    const base       = 60_000 / cfg.wpm;
    const chars      = word.replace(/[^a-zA-Z0-9]/g, '').length;
    const extraChars = Math.max(0, chars - 5);
    let   duration   = base + extraChars * base * cfg.charPenaltyFactor;
    if (word.includes('-') && word.replace(/-/g, '').length > 3) {
      duration *= cfg.hyphenMultiplier;
    }
    return Math.min(Math.max(duration, cfg.minDurationMs), cfg.maxDurationMs);
  }

  function makeWordToken(word, isLink = false) {
    // Separate punctuation from core so the ORP lands on a real letter.
    const lead   = word.match(LEADING_PUNCT)?.[0]  ?? '';
    const trail  = word.match(TRAILING_PUNCT)?.[0] ?? '';
    const core   = word.slice(lead.length, word.length - trail.length);
    const target = core.length > 0 ? core : word;
    const i = Math.max(0, Math.min(Math.floor(target.length * 0.35), target.length - 1));
    return {
      type:     'word',
      text:     word,
      before:   lead + target.slice(0, i),
      orp:      target[i] ?? target[0] ?? word[0],
      after:    target.slice(i + 1) + trail,
      duration: wordDuration(word),
      isLink,
    };
  }

  function makeCodeToken(text) {
    return { type: 'code', text: text.trim() };
  }

  function makeTableToken(node) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll('script, style').forEach(el => el.remove());
    clone.querySelectorAll('*').forEach(el => {
      [...el.attributes].forEach(attr => {
        if (attr.name.startsWith('on')) el.removeAttribute(attr.name);
      });
    });
    return { type: 'table', html: clone.outerHTML };
  }

  // ================================================================
  // DOM → TOKEN EXTRACTION
  // ================================================================

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'BUTTON', 'INPUT',
    'SELECT', 'TEXTAREA', 'IFRAME', 'CANVAS', 'VIDEO', 'AUDIO',
    'NAV', 'FOOTER', 'HEADER', 'ASIDE',
  ]);

  // inLink propagates down through <a> subtrees so every word inside a link
  // gets the isLink flag and will be rendered in the link colour.
  function extractTokens(node, tokens = [], inPre = false, inLink = false) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (inPre) return tokens;
      const words = node.textContent.split(/\s+/).filter(w => w.length > 0);
      words.forEach(w => tokens.push(makeWordToken(w, inLink)));
      return tokens;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return tokens;

    const tag = node.tagName;
    if (SKIP_TAGS.has(tag)) return tokens;

    if (tag === 'PRE') {
      const text = node.textContent.trim();
      if (text) tokens.push(makeCodeToken(text));
      return tokens;
    }

    if (tag === 'TABLE') {
      tokens.push(makeTableToken(node));
      return tokens;
    }

    if (tag === 'OL') {
      let n = parseInt(node.getAttribute('start') ?? '1', 10);
      for (const child of node.childNodes) {
        if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'LI') {
          tokens.push(makeWordToken(`${n}.`, inLink));
          n++;
        }
        extractTokens(child, tokens, false, inLink);
      }
      return tokens;
    }

    const nextLink = inLink || tag === 'A';
    for (const child of node.childNodes) {
      extractTokens(child, tokens, false, nextLink);
    }
    return tokens;
  }

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

  function tokensFromPage()      { return extractTokens(findMainContent()); }

  function tokensFromSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return [];
    const frag = sel.getRangeAt(0).cloneContents();
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
    index: 0,              // index of NEXT token to display
    playing: false,
    timer: null,
    waitingForBlock: false,
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

        <!-- ── Table view ── -->
        <div id="sre-table-view" hidden>
          <div id="sre-table-label">⊞ Table</div>
          <div id="sre-table-content"></div>
          <button id="sre-table-continue">Continue Reading →</button>
        </div>

        <!-- ── Controls ── -->
        <div id="sre-controls">
          <button class="sre-btn" id="sre-prev"      title="Back (←)">⏮</button>
          <button class="sre-btn" id="sre-playpause" title="Play (Space)">▶</button>
          <button class="sre-btn" id="sre-next"      title="Forward (→)">⏭</button>

          <div id="sre-speed-wrap">
            <span id="sre-speed-label">250 WPM</span>
            <input type="range" id="sre-speed-input" min="50" max="800" step="25" value="250">
          </div>

          <select id="sre-font-select" title="Display font"></select>

          <button class="sre-btn" id="sre-close" title="Close (Esc)">✕</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector('#sre-playpause').addEventListener('click', togglePlay);
    overlay.querySelector('#sre-prev').addEventListener('click', () => seekBy(-1));
    overlay.querySelector('#sre-next').addEventListener('click', () => seekBy(+1));
    overlay.querySelector('#sre-close').addEventListener('click', closeReader);
    overlay.querySelector('#sre-code-continue').addEventListener('click', onBlockContinue);
    overlay.querySelector('#sre-table-continue').addEventListener('click', onBlockContinue);

    const speedInput = overlay.querySelector('#sre-speed-input');
    speedInput.value = cfg.wpm;
    overlay.querySelector('#sre-speed-label').textContent = `${cfg.wpm} WPM`;
    speedInput.addEventListener('input', e => {
      cfg.wpm = parseInt(e.target.value, 10);
      overlay.querySelector('#sre-speed-label').textContent = `${cfg.wpm} WPM`;
      saveSettings({ wpm: cfg.wpm });
    });

    overlay.addEventListener('click', e => {
      if (e.target === overlay) closeReader();
    });

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
        const localFonts = await window.queryLocalFonts();
        const families = [...new Set(localFonts.map(f => f.family))].sort();
        fonts = ['system-ui', ...families];
      }
    } catch (_) {}
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

  function showView(name) {
    overlay.querySelector('#sre-word-view').hidden  = name !== 'word';
    overlay.querySelector('#sre-code-view').hidden  = name !== 'code';
    overlay.querySelector('#sre-table-view').hidden = name !== 'table';
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

    // Colour link words differently so readers can recognise hyperlink text.
    overlay.querySelector('#sre-word-display').classList.toggle('sre-is-link', !!token.isLink);

    const pct = state.tokens.length > 1
      ? ((state.index - 1) / (state.tokens.length - 1)) * 100
      : 100;
    overlay.querySelector('#sre-progress-fill').style.width = `${pct}%`;
  }

  // ================================================================
  // PLAYBACK CONTROL
  // ================================================================

  function tick() {
    if (!state.playing || state.waitingForBlock) return;
    if (state.index >= state.tokens.length) { stopReader(); return; }

    const token = state.tokens[state.index];
    state.index++;
    renderToken(token);

    if (state.waitingForBlock) return;
    state.timer = setTimeout(tick, token.type === 'word' ? token.duration : 0);
  }

  function startReader(tokens) {
    if (tokens.length === 0) return;

    state.tokens = tokens;
    state.index = 0;
    state.playing = false;
    state.waitingForBlock = false;
    clearTimeout(state.timer);

    createOverlay();
    overlay.style.display = 'flex';

    // Show the first word, then wait for the user to press ▶ or Space.
    const first = state.tokens[0];
    state.index = 1;
    renderToken(first);
    updatePlayPauseBtn();
  }

  function togglePlay() {
    if (state.playing) { pauseReader(); } else { resumeReader(); }
  }

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
    const current = state.index - 1;
    const target  = Math.max(0, Math.min(state.tokens.length - 1, current + delta));
    state.index   = target + 1;
    const token   = state.tokens[target];

    if (token.type !== 'code' && token.type !== 'table') {
      state.waitingForBlock = false;
    }

    renderToken(token);

    if (state.playing && !state.waitingForBlock) {
      state.timer = setTimeout(tick, token.duration ?? 300);
    }
  }

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

  // Adjust WPM by delta and sync the in-reader slider label immediately.
  function adjustWPM(delta) {
    cfg.wpm = Math.min(800, Math.max(50, cfg.wpm + delta));
    saveSettings({ wpm: cfg.wpm });
    const speedInput = overlay?.querySelector('#sre-speed-input');
    const speedLabel = overlay?.querySelector('#sre-speed-label');
    if (speedInput) speedInput.value = cfg.wpm;
    if (speedLabel) speedLabel.textContent = `${cfg.wpm} WPM`;
  }

  function handleKeydown(e) {
    if (!overlay || overlay.style.display === 'none') return;
    switch (e.key) {
      case 'Escape':
        e.preventDefault(); closeReader(); break;
      case ' ':
        e.preventDefault();
        if (state.waitingForBlock) { onBlockContinue(); } else { togglePlay(); }
        break;
      case 'ArrowRight':
        e.preventDefault(); seekBy(+1);      break;
      case 'ArrowLeft':
        e.preventDefault(); seekBy(-1);      break;
      case 'ArrowUp':
        e.preventDefault(); adjustWPM(+25); break;
      case 'ArrowDown':
        e.preventDefault(); adjustWPM(-25); break;
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
        showSelectionButton(rect.right, rect.bottom + 10);
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
  // MESSAGE LISTENER
  // ================================================================

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'readSelection') {
      loadSettings().then(() => {
        const tokens = tokensFromSelection();
        if (tokens.length > 0) startReader(tokens);
      });
    } else if (message.action === 'readPage') {
      loadSettings().then(() => {
        const tokens = tokensFromPage();
        if (tokens.length > 0) startReader(tokens);
      });
    }
  });

  loadSettings();

})();
