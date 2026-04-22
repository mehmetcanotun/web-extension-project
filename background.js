// background.js - Sahibinden Fiyat Takipçisi Service Worker

chrome.runtime.onInstalled.addListener(() => {
  console.log('Sahibinden Fiyat Takipçisi kuruldu.');
});

// Content script'ten gelen fiyat düşüşü bildirimleri
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'PRICE_DROP') {
    const { title, oldPrice, newPrice, dropPercent } = message.data;

    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: '📉 Fiyat Düştü!',
      message: `${title.substring(0, 50)}\n${oldPrice} → ${newPrice} (-%${dropPercent})`,
      priority: 2
    });
  }

  if (message.type === 'GET_STORAGE') {
    chrome.storage.local.get(null, (data) => {
      sendResponse({ data });
    });
    return true; // async
  }
});
