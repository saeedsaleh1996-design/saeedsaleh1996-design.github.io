'use strict';

// Register install support without caching private account data or API replies.
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      console.warn('FindIt install support could not be registered.');
    });
  });
}
