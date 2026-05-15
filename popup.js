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

  // Read Page button → send message to content script via background
  $('btn-read-page').addEventListener('click', () => {
    chrome.runtime.sendMessage({ target: 'content', action: 'readPage' });
    window.close();
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
