// popup.js — SwiftRead Enhanced Settings Popup

const DEFAULTS = {
  wpm:              250,
  charPenaltyMs:    25,
  hyphenMultiplier: 1.8,
  minDurationMs:    80,
  maxDurationMs:    2000,
};

function $(id) { return document.getElementById(id); }

// Batched, debounced storage writes (shared across all bindings). Avoids
// burning the chrome.storage.sync quota during a slider drag (~120/min limit).
const pendingWrites = {};
let writeTimer = null;
function scheduleStorageWrite(partial) {
  Object.assign(pendingWrites, partial);
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    const snapshot = { ...pendingWrites };
    for (const k of Object.keys(pendingWrites)) delete pendingWrites[k];
    chrome.storage.sync.set(snapshot);
  }, 200);
}

// Bind a range slider + number input pair to a storage key.
function bindSetting(sliderId, numId, storageKey, parse, min, max) {
  const slider = $(sliderId);
  const num    = $(numId);
  const apply  = (raw) => {
    const parsed = parse(raw);
    if (!Number.isFinite(parsed)) return;
    const v = Math.min(max, Math.max(min, parsed));
    slider.value = v;
    num.value    = v;
    scheduleStorageWrite({ [storageKey]: v });
  };
  slider.addEventListener('input',  () => apply(slider.value));
  num.addEventListener('change',    () => apply(num.value));
  return (value) => { slider.value = value; num.value = value; };
}

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

document.addEventListener('DOMContentLoaded', () => {

  const setWpm = bindSetting('input-wpm', 'num-wpm', 'wpm',           parseInt,   50,  800);
  const setCpp = bindSetting('input-cpp', 'num-cpp', 'charPenaltyMs', parseFloat,  0,  500);
  const setHm  = bindSliderOnly('input-hm', 'val-hm', 'hyphenMultiplier', v => `${v.toFixed(1)}×`);

  chrome.storage.sync.get(DEFAULTS, data => {
    setWpm(data.wpm);
    setCpp(data.charPenaltyMs);
    setHm(data.hyphenMultiplier);
  });

  $('btn-read-page').addEventListener('click', () => {
    sendToActiveTab('readPage').then(() => window.close());
  });

  $('btn-reset').addEventListener('click', () => {
    chrome.storage.sync.set(DEFAULTS, () => {
      setWpm(DEFAULTS.wpm);
      setCpp(DEFAULTS.charPenaltyMs);
      setHm(DEFAULTS.hyphenMultiplier);
    });
  });

});

// Hyphen multiplier keeps the old label-only pattern (no number input).
function bindSliderOnly(sliderId, valId, storageKey, format) {
  const slider = $(sliderId);
  const label  = $(valId);
  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value);
    if (!Number.isFinite(v)) return;
    label.textContent = format(v);
    scheduleStorageWrite({ [storageKey]: v });
  });
  return (value) => { slider.value = value; label.textContent = format(value); };
}
