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

function isPdfUrl(url) {
  return !!url && /\.pdf(\?|#|$)/i.test(url);
}

// Injects the content script into a tab if needed, then sends the action.
// For readSelection on PDF pages: executes in MAIN world first because
// window.getSelection() is not visible in the content script's isolated world.
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

    if (action === 'readSelection') {
      const tab = await chrome.tabs.get(tabId);
      if (isPdfUrl(tab.url)) {
        const [{ result: text }] = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: () => window.getSelection()?.toString()?.trim() ?? '',
        });
        if (text?.length > 2) {
          chrome.tabs.sendMessage(tabId, { action: 'readSelectionText', text });
          return;
        }
      }
    }

    chrome.tabs.sendMessage(tabId, { action });
  } catch (err) {
    console.warn('SwiftRead: cannot inject on this page —', err.message);
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'sre-read-selection') sendToTab(tab.id, 'readSelection');
  else if (info.menuItemId === 'sre-read-page')  sendToTab(tab.id, 'readPage');
});

// The permanent PDF selection button in content.js sends this message because
// content scripts cannot call chrome.scripting.executeScript themselves.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'getPdfSelection' && sender.tab?.id) {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: 'MAIN',
      func: () => window.getSelection()?.toString()?.trim() ?? '',
    })
      .then(([{ result }]) => sendResponse({ text: result ?? '' }))
      .catch(() => sendResponse({ text: '' }));
    return true; // keep channel open for async sendResponse
  }
});
