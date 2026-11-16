// Service worker: rende l'app utilizzabile anche senza connessione.
// Cambiare VERSION quando si pubblica una nuova versione dei file.
const VERSION = 'crescita-v5';
const FILES = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png',
               './firebase-config.js', './firebase-adapter.js', './cloud.js'];
const SDK = 'https://www.gstatic.com/firebasejs/';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Solo i file dell'app e le librerie Firebase passano da qui: rete prima (così gli
// aggiornamenti arrivano), copia salvata se offline. Il traffico del database no.
self.addEventListener('fetch', e => {
  const url = e.request.url;
  if (e.request.method !== 'GET') return;
  if (!url.startsWith(self.location.origin) && !url.startsWith(SDK)) return;
  e.respondWith(
    fetch(e.request)
      .then(r => { if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); } return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true })
        .then(r => r || (e.request.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
  );
});
