// background.js — Service Worker for SwiftRead Enhanced

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'sre-read-selection',
    title: 'Read Selected Text',
    contexts: ['selection'],
  });
  chrome.contextMenus.create({
    id: 'sre-read-page',
    title: 'Read This Page',
    contexts: ['page'],
  });
});

// Injects the content script into a tab if it isn't already running, then
// sends the requested action. Handles tabs that were open before the extension
// was installed or reloaded.
async function sendToTab(tabId, message) {
  try {
    const [{ result: loaded } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => !!window.__sreLoaded,
    });

    if (!loaded) {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] }).catch(() => {});
    }

    chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    console.warn('SwiftRead: cannot inject on this page —', err.message);
  }
}

// In Edge, right-clicking inside the embedded PDF viewer
// (chrome-extension://…/edge_pdf/index.html) hands us tab.id === -1 because
// that frame isn't a top-level tab. Fall back to the active tab.
async function resolveTabId(tab) {
  if (tab?.id != null && tab.id !== -1) return tab.id;
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return active?.id ?? null;
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const tabId = await resolveTabId(tab);
  if (tabId == null) return;
  if (info.menuItemId === 'sre-read-selection') {
    sendToTab(tabId, { action: 'readSelection', selectionText: info.selectionText || '' });
  } else if (info.menuItemId === 'sre-read-page') {
    sendToTab(tabId, { action: 'readPage' });
  }
});
