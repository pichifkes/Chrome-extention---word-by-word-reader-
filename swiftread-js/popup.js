// popup.js — SwiftRead Enhanced Settings Popup

const DEFAULTS = {
  wpm:               250,
  charPenaltyFactor: 0.1,
  hyphenMultiplier:  1.8,
  minDurationMs:     80,
  maxDurationMs:     2000,
};

// ── Helpers ──────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function bindSlider(inputId, valId, storageKey, format) {
  const input = $(inputId);
  const label = $(valId);
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    label.textContent = format(v);
    chrome.storage.sync.set({ [storageKey]: v });
  });
  return (value) => {
    input.value = value;
    label.textContent = format(value);
  };
}

// Send an action directly to the active tab, injecting the content script
// first if it hasn't been loaded yet (handles pre-existing tabs).
async function sendToActiveTab(action) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    const [{ result: loaded } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => !!window.__sreLoaded,
    });
    if (!loaded) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] }).catch(() => {});
    }
    chrome.tabs.sendMessage(tab.id, { action });
  } catch (err) {
    console.warn('SwiftRead: cannot inject on this page —', err.message);
  }
}

// ── Init ─────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {

  const setWpm = bindSlider('input-wpm', 'val-wpm', 'wpm',
    v => `${Math.round(v)} WPM`);

  const setCpp = bindSlider('input-cpp', 'val-cpp', 'charPenaltyFactor',
    v => `${Math.round(v * 100)}% / char`);

  const setHm = bindSlider('input-hm', 'val-hm', 'hyphenMultiplier',
    v => `${v.toFixed(1)}×`);

  chrome.storage.sync.get(DEFAULTS, data => {
    setWpm(data.wpm);
    setCpp(data.charPenaltyFactor);
    setHm(data.hyphenMultiplier);
  });

  $('btn-read-page').addEventListener('click', () => {
    sendToActiveTab('readPage').then(() => window.close());
  });

  $('btn-reset').addEventListener('click', () => {
    chrome.storage.sync.set(DEFAULTS, () => {
      setWpm(DEFAULTS.wpm);
      setCpp(DEFAULTS.charPenaltyFactor);
      setHm(DEFAULTS.hyphenMultiplier);
    });
  });

});
