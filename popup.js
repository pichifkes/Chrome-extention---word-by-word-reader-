// popup.js — SwiftRead Enhanced Settings Popup

const DEFAULTS = {
  cpm:                800,
  longWordThreshold:  8,
  longWordMultiplier: 1.5,
  hyphenMultiplier:   1.8,
  minDurationMs:      80,
  maxDurationMs:      2000,
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
    // Check whether the content script is already running on this tab.
    const [{ result: loaded } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => !!window.__sreLoaded,
    });

    if (!loaded) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      // CSS injection failure is non-fatal — overlay still works without custom styles.
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] }).catch(() => {});
    }

    chrome.tabs.sendMessage(tab.id, { action });
  } catch (err) {
    // Browser-internal pages (edge://, about:, PDF viewer, etc.) block injection.
    console.warn('SwiftRead: cannot inject on this page —', err.message);
  }
}

// ── Init ─────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {

  // Bind all sliders
  const setCpm = bindSlider('input-cpm', 'val-cpm', 'cpm',
    v => `${v} CPM`);

  const setLwt = bindSlider('input-lwt', 'val-lwt', 'longWordThreshold',
    v => `${v} chars`);

  const setLwm = bindSlider('input-lwm', 'val-lwm', 'longWordMultiplier',
    v => `${v.toFixed(1)}×`);

  const setHm = bindSlider('input-hm', 'val-hm', 'hyphenMultiplier',
    v => `${v.toFixed(1)}×`);

  // Load saved settings
  chrome.storage.sync.get(DEFAULTS, data => {
    setCpm(data.cpm);
    setLwt(data.longWordThreshold);
    setLwm(data.longWordMultiplier);
    setHm(data.hyphenMultiplier);
  });

  // Read Page — inject content script if needed, then send action, then close.
  $('btn-read-page').addEventListener('click', () => {
    sendToActiveTab('readPage').then(() => window.close());
  });

  // Reset to defaults
  $('btn-reset').addEventListener('click', () => {
    chrome.storage.sync.set(DEFAULTS, () => {
      setCpm(DEFAULTS.cpm);
      setLwt(DEFAULTS.longWordThreshold);
      setLwm(DEFAULTS.longWordMultiplier);
      setHm(DEFAULTS.hyphenMultiplier);
    });
  });

});
