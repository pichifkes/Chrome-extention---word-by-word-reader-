// content.js — SwiftRead Enhanced (Rust/WASM backend)

(function () {
  'use strict';

  if (window.__sreLoaded) return;
  window.__sreLoaded = true;

  // ================================================================
  // SETTINGS
  // ================================================================

  const DEFAULTS = {
    wpm:              250,
    charPenaltyMs:    25,
    font:             'system-ui',
    hyphenMultiplier: 1.8,
    minDurationMs:    80,
    maxDurationMs:    2000,
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
  // WASM BACKEND
  // ================================================================

  let wasmFns = null;
  let wasmInitPromise = null;

  function initWasm() {
    if (wasmFns) return Promise.resolve(wasmFns);
    if (wasmInitPromise) return wasmInitPromise;
    wasmInitPromise = (async () => {
      try {
        const jsUrl   = chrome.runtime.getURL('pkg/swiftread_rs.js');
        const wasmUrl = chrome.runtime.getURL('pkg/swiftread_rs_bg.wasm');
        const mod = await import(jsUrl);
        await mod.default(wasmUrl);
        wasmFns = mod;
      } catch (e) {
        console.warn('SwiftRead: WASM init failed, using JS fallback —', e);
      }
      return wasmFns;
    })();
    return wasmInitPromise;
  }

  // Called at tick time — reads current cfg so live changes take effect immediately.
  function wordDuration(word) {
    if (wasmFns) {
      return wasmFns.word_duration(
        word, cfg.wpm, cfg.charPenaltyMs,
        cfg.hyphenMultiplier, cfg.minDurationMs, cfg.maxDurationMs,
      );
    }
    const base       = 60_000 / cfg.wpm;
    const chars      = word.replace(/[^a-zA-Z0-9]/g, '').length;
    const extraChars = Math.max(0, chars - 5);
    let   duration   = base + extraChars * cfg.charPenaltyMs;
    if (word.includes('-') && word.replace(/-/g, '').length > 3) duration *= cfg.hyphenMultiplier;
    return Math.min(Math.max(duration, cfg.minDurationMs), cfg.maxDurationMs);
  }

  // ================================================================
  // PDF SUPPORT
  // ================================================================

  function looksLikePdf() {
    return document.contentType === 'application/pdf' ||
           /\.pdf(\?|#|$)/i.test(window.location.href);
  }

  async function extractPdfSegments(pdfUrl) {
    const fns = await initWasm();
    if (!fns) throw new Error('WASM not available for PDF extraction');

    const response = await fetch(pdfUrl);
    if (!response.ok) throw new Error(`PDF fetch failed: ${response.status}`);

    const bytes = new Uint8Array(await response.arrayBuffer());
    const text  = fns.extract_pdf_text(bytes);
    if (!text) throw new Error('No extractable text in this PDF');

    // Split on blank lines to get paragraph-level segments; Rust build_tokens
    // handles word splitting and ORP from there.
    return text
      .split(/\n{2,}/)
      .map(p => p.replace(/\s+/g, ' ').trim())
      .filter(p => p.length > 2)
      .map(t => ({ type: 'text', text: t, is_link: false }));
  }

  // ================================================================
  // DOM → SEGMENT EXTRACTION
  // ================================================================

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'BUTTON', 'INPUT',
    'SELECT', 'TEXTAREA', 'IFRAME', 'CANVAS', 'VIDEO', 'AUDIO',
    'NAV', 'FOOTER', 'HEADER', 'ASIDE',
  ]);

  function extractSegments(node, segments = [], inLink = false) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent.replace(/\s+/g, ' ').trim();
      if (text) segments.push({ type: 'text', text, is_link: inLink });
      return segments;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return segments;

    const tag = node.tagName;
    if (SKIP_TAGS.has(tag)) return segments;

    if (tag === 'PRE') {
      const t = node.textContent.trim();
      if (t) segments.push({ type: 'code', text: t });
      return segments;
    }

    if (tag === 'TABLE') {
      const clone = node.cloneNode(true);
      clone.querySelectorAll('script, style').forEach(el => el.remove());
      clone.querySelectorAll('*').forEach(el => {
        [...el.attributes].forEach(a => { if (a.name.startsWith('on')) el.removeAttribute(a.name); });
      });
      segments.push({ type: 'table', html: clone.outerHTML });
      return segments;
    }

    if (tag === 'OL') {
      let n = parseInt(node.getAttribute('start') ?? '1', 10);
      for (const child of node.childNodes) {
        if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'LI')
          segments.push({ type: 'text', text: `${n++}.`, is_link: inLink });
        extractSegments(child, segments, inLink);
      }
      return segments;
    }

    const nextLink = inLink || tag === 'A';
    for (const child of node.childNodes) extractSegments(child, segments, nextLink);
    return segments;
  }

  async function buildTokens(segments) {
    const fns = await initWasm();
    if (fns) {
      const raw = JSON.parse(fns.build_tokens(JSON.stringify(segments)));
      return raw.map(t => ({
        type:   t.type,
        text:   t.text   || '',
        before: t.before || '',
        orp:    t.orp    || '',
        after:  t.after  || '',
        isLink: t.is_link || false,
        ctx:    t.ctx    || null,
        html:   t.html   || null,
      }));
    }
    return buildTokensJS(segments);
  }

  // ================================================================
  // JS TOKEN FALLBACK
  // ================================================================

  const LEADING_PUNCT  = /^[(\[{"'«‹"'`]+/;
  const TRAILING_PUNCT = /[)\]}"'»›"'`.,;:!?…]+$/;
  const CTX_OPEN = {
    '(': ')', '[': ']', '{': '}',
    '"': '"', '‘': '’', '«': '»', '‹': '›',
  };

  function makeWordTokenJS(word, isLink) {
    const lead   = word.match(LEADING_PUNCT)?.[0]  ?? '';
    const trail  = word.match(TRAILING_PUNCT)?.[0] ?? '';
    const core   = word.slice(lead.length, word.length - trail.length);
    const target = core.length > 0 ? core : word;
    const i = Math.max(0, Math.min(Math.floor(target.length * 0.35), target.length - 1));
    return {
      type: 'word', text: word,
      before: lead + target.slice(0, i),
      orp:    target[i] ?? target[0] ?? word[0],
      after:  target.slice(i + 1) + trail,
      isLink: isLink || false, ctx: null, html: null,
    };
  }

  function buildTokensJS(segments) {
    const tokens = [];
    for (const seg of segments) {
      if (seg.type === 'text') {
        for (const w of seg.text.split(/\s+/).filter(Boolean))
          tokens.push(makeWordTokenJS(w, seg.is_link));
      } else if (seg.type === 'code' && seg.text) {
        tokens.push({ type: 'code', text: seg.text, before: '', orp: '', after: '', isLink: false, ctx: null, html: null });
      } else if (seg.type === 'table' && seg.html) {
        tokens.push({ type: 'table', text: '', before: '', orp: '', after: '', isLink: false, ctx: null, html: seg.html });
      }
    }
    const stack = [];
    for (const token of tokens) {
      if (token.type === 'word') {
        const lead  = token.text.match(LEADING_PUNCT)?.[0]  ?? '';
        const trail = token.text.match(TRAILING_PUNCT)?.[0] ?? '';
        for (const ch of lead) { if (CTX_OPEN[ch]) stack.push({ open: ch, close: CTX_OPEN[ch] }); }
        token.ctx = stack.length > 0 ? { ...stack[stack.length - 1] } : null;
        for (const ch of [...trail].reverse()) {
          if (stack.length && ch === stack[stack.length - 1].close) stack.pop();
        }
      } else {
        token.ctx = stack.length > 0 ? { ...stack[stack.length - 1] } : null;
      }
    }
    return tokens;
  }

  // ================================================================
  // PAGE / SELECTION TOKEN EXTRACTION
  // ================================================================

  function findMainContent() {
    for (const sel of ['main', '[role="main"]', 'article', '.post-content', '.article-body',
                       '.article-content', '.entry-content', '.content', '.page-content']) {
      const el = document.querySelector(sel); if (el) return el;
    }
    return document.body;
  }

  function tokensFromPage() {
    if (looksLikePdf()) {
      return extractPdfSegments(window.location.href).then(buildTokens);
    }
    return buildTokens(extractSegments(findMainContent()));
  }

  function tokensFromSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return Promise.resolve([]);
    const frag = sel.getRangeAt(0).cloneContents();
    const wrap = document.createElement('div'); wrap.appendChild(frag);
    return buildTokens(extractSegments(wrap));
  }

  // ================================================================
  // READER STATE
  // ================================================================

  let overlay = null;
  const refs  = {};
  const state = { tokens: [], index: 0, playing: false, timer: null, waitingForBlock: false };

  // ================================================================
  // OVERLAY CREATION
  // ================================================================

  function bindOverlayControl(sliderKey, numKey, cfgKey, parse, min, max) {
    const apply = (raw) => {
      const v = Math.min(max, Math.max(min, parse(raw)));
      cfg[cfgKey] = v;
      refs[sliderKey].value = v;
      refs[numKey].value    = v;
      saveSettings({ [cfgKey]: v });
    };
    refs[sliderKey].value = cfg[cfgKey];
    refs[numKey].value    = cfg[cfgKey];
    refs[sliderKey].addEventListener('input',  () => apply(refs[sliderKey].value));
    refs[numKey].addEventListener('change',    () => apply(refs[numKey].value));
  }

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
          <div id="sre-ctrl-transport">
            <button class="sre-btn" id="sre-prev"      title="Back 10 words (←)">⏮</button>
            <button class="sre-btn" id="sre-playpause" title="Play / Pause (Space)">▶</button>
            <button class="sre-btn" id="sre-next"      title="Forward 10 words (→)">⏭</button>
            <button class="sre-btn" id="sre-close"     title="Close (Esc)">✕</button>
          </div>
          <div class="sre-ctrl-row">
            <span class="sre-ctrl-lbl">WPM</span>
            <input type="range"  class="sre-ctrl-slider" id="sre-speed-input" min="50"  max="800" step="10" value="250">
            <input type="number" class="sre-ctrl-num"    id="sre-speed-num"   min="50"  max="800" step="10" value="250">
          </div>
          <div class="sre-ctrl-row">
            <span class="sre-ctrl-lbl">ms / extra char</span>
            <input type="range"  class="sre-ctrl-slider" id="sre-penalty-input" min="0" max="500" step="5" value="25">
            <input type="number" class="sre-ctrl-num"    id="sre-penalty-num"   min="0" max="500" step="5" value="25">
            <select id="sre-font-select" title="Display font"></select>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const q = id => overlay.querySelector(id);
    refs.wordView     = q('#sre-word-view');
    refs.codeView     = q('#sre-code-view');
    refs.tableView    = q('#sre-table-view');
    refs.wordBefore   = q('#sre-word-before');
    refs.wordOrp      = q('#sre-word-orp');
    refs.wordAfter    = q('#sre-word-after');
    refs.wordDisplay  = q('#sre-word-display');
    refs.ctxLeft      = q('#sre-ctx-left');
    refs.ctxRight     = q('#sre-ctx-right');
    refs.codeContent  = q('#sre-code-content');
    refs.tableContent = q('#sre-table-content');
    refs.progressFill = q('#sre-progress-fill');
    refs.playpause    = q('#sre-playpause');
    refs.speedInput   = q('#sre-speed-input');
    refs.speedNum     = q('#sre-speed-num');
    refs.penaltyInput = q('#sre-penalty-input');
    refs.penaltyNum   = q('#sre-penalty-num');

    refs.playpause.addEventListener('click', togglePlay);
    q('#sre-prev').addEventListener('click', () => seekBy(-10));
    q('#sre-next').addEventListener('click', () => seekBy(+10));
    q('#sre-close').addEventListener('click', closeReader);
    q('#sre-code-continue').addEventListener('click', onBlockContinue);
    q('#sre-table-continue').addEventListener('click', onBlockContinue);

    bindOverlayControl('speedInput',   'speedNum',   'wpm',           parseInt,   50,  800);
    bindOverlayControl('penaltyInput', 'penaltyNum', 'charPenaltyMs', parseFloat,  0,  500);

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
    if (refs.wordDisplay) refs.wordDisplay.style.fontFamily = `"${font}", system-ui, sans-serif`;
  }

  // ================================================================
  // DISPLAY LOGIC
  // ================================================================

  function showView(name) {
    refs.wordView.style.display  = name === 'word'  ? ''     : 'none';
    refs.codeView.style.display  = name === 'code'  ? 'flex' : 'none';
    refs.tableView.style.display = name === 'table' ? 'flex' : 'none';
  }

  // Show a loading message in the word view while PDF is being extracted.
  function showLoading(msg) {
    createOverlay();
    overlay.style.display = 'flex';
    showView('word');
    refs.wordBefore.textContent = '';
    refs.wordOrp.textContent    = '';
    refs.wordAfter.textContent  = '';
    refs.ctxLeft.textContent    = '';
    refs.ctxRight.textContent   = '';
    refs.wordDisplay.style.fontSize = '18px';
    refs.wordDisplay.textContent = msg;
  }

  function resetWordDisplay() {
    refs.wordDisplay.style.fontSize = '';
    refs.wordDisplay.textContent    = '';
    refs.wordDisplay.innerHTML = '<span id="sre-word-before"></span><span id="sre-word-orp"></span><span id="sre-word-after"></span>';
    refs.wordBefore = overlay.querySelector('#sre-word-before');
    refs.wordOrp    = overlay.querySelector('#sre-word-orp');
    refs.wordAfter  = overlay.querySelector('#sre-word-after');
  }

  function renderToken(token) {
    if (!overlay) return;

    if (token.type === 'code') {
      showView('code');
      refs.codeContent.textContent = token.text;
      state.waitingForBlock = true;
      pauseReader();
      return;
    }

    if (token.type === 'table') {
      showView('table');
      refs.tableContent.innerHTML = token.html;
      state.waitingForBlock = true;
      pauseReader();
      return;
    }

    showView('word');
    refs.wordBefore.textContent = token.before;
    refs.wordOrp.textContent    = token.orp;
    refs.wordAfter.textContent  = token.after;
    refs.wordDisplay.classList.toggle('sre-is-link', !!token.isLink);
    refs.ctxLeft.textContent  = token.ctx?.open  ?? '';
    refs.ctxRight.textContent = token.ctx?.close ?? '';

    const pct = state.tokens.length > 1
      ? ((state.index - 1) / (state.tokens.length - 1)) * 100 : 100;
    refs.progressFill.style.width = `${pct}%`;
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
    state.timer = setTimeout(tick, token.type === 'word' ? wordDuration(token.text) : 0);
  }

  function startReader(tokens) {
    if (tokens.length === 0) return;
    state.tokens          = tokens;
    state.index           = 0;
    state.playing         = false;
    state.waitingForBlock = false;
    clearTimeout(state.timer);

    createOverlay();
    overlay.style.display = 'flex';
    showView('word');
    resetWordDisplay();

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

  function stopReader() { pauseReader(); }

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
    if (refs.playpause) refs.playpause.textContent = state.playing ? '⏸' : '▶';
  }

  function adjustWPM(delta) {
    cfg.wpm = Math.min(800, Math.max(50, cfg.wpm + delta));
    saveSettings({ wpm: cfg.wpm });
    if (refs.speedInput) refs.speedInput.value = cfg.wpm;
    if (refs.speedNum)   refs.speedNum.value   = cfg.wpm;
  }

  function handleKeydown(e) {
    if (!overlay || overlay.style.display === 'none') return;
    switch (e.key) {
      case 'Escape':     e.preventDefault(); closeReader(); break;
      case ' ':          e.preventDefault(); state.waitingForBlock ? onBlockContinue() : togglePlay(); break;
      case 'ArrowRight': e.preventDefault(); seekBy(+1);     break;
      case 'ArrowLeft':  e.preventDefault(); seekBy(-1);     break;
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
        const tokens = await tokensFromSelection();
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
      loadSettings().then(() => tokensFromSelection()).then(t => { if (t.length) startReader(t); });
    } else if (message.action === 'readPage') {
      loadSettings().then(async () => {
        if (looksLikePdf()) {
          showLoading('Extracting PDF text…');
          try {
            const t = await tokensFromPage();
            if (t.length) startReader(t);
            else { resetWordDisplay(); refs.wordDisplay.textContent = 'No text found in PDF.'; }
          } catch (err) {
            console.error('SwiftRead PDF error:', err);
            resetWordDisplay();
            refs.wordDisplay.textContent = 'Could not read this PDF.';
          }
        } else {
          const t = await tokensFromPage();
          if (t.length) startReader(t);
        }
      });
    }
  });

  loadSettings();
  initWasm();

})();
