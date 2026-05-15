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

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'sre-read-selection') {
    chrome.tabs.sendMessage(tab.id, { action: 'readSelection' });
  } else if (info.menuItemId === 'sre-read-page') {
    chrome.tabs.sendMessage(tab.id, { action: 'readPage' });
  }
});

// Forward messages from popup → active content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === 'content') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, message);
      }
    });
  }
});
