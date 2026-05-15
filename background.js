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
async function sendToTab(tabId, action) {
  try {
    const [{ result: loaded } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => !!window.__sreLoaded,
    });

    if (!loaded) {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] }).catch(() => {});
    }

    chrome.tabs.sendMessage(tabId, { action });
  } catch (err) {
    console.warn('SwiftRead: cannot inject on this page —', err.message);
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'sre-read-selection') {
    sendToTab(tab.id, 'readSelection');
  } else if (info.menuItemId === 'sre-read-page') {
    sendToTab(tab.id, 'readPage');
  }
});
