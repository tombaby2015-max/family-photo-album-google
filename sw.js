// sw.js — Service Worker для кеширования миниатюр фото
//
// Стратегия: Cache First для миниатюр
// - Первый запрос: идём в сеть, кешируем ответ
// - Повторные запросы: отдаём мгновенно из кеша, без сети
// ИСПРАВЛЕНО: очередь запросов MAX_CONCURRENT=4, повтор при ошибке до 3 раз

const CACHE_NAME = 'photo-thumbs-v1';
const THUMB_PATTERN = /\/photo\?.*size=thumb/;

// ==========================================
// ОЧЕРЕДЬ — не более 4 параллельных загрузок
// Остальные ждут своей очереди
// ==========================================
const MAX_CONCURRENT = 4;
var _activeRequests = 0;
var _queue = [];

function processQueue() {
  while (_queue.length > 0 && _activeRequests < MAX_CONCURRENT) {
    var item = _queue.shift();
    _activeRequests++;
    fetchWithRetry(item.request, 3)
      .then(function(response) {
        _activeRequests--;
        item.resolve(response);
        processQueue();
      })
      .catch(function(err) {
        _activeRequests--;
        item.reject(err);
        processQueue();
      });
  }
}

// ==========================================
// ПОВТОР — при ошибке пробуем ещё раз (до 3 попыток)
// Пауза 600мс между попытками
// ==========================================
function fetchWithRetry(request, attemptsLeft) {
  return fetch(request.clone()).then(function(response) {
    if (response.ok) return response;
    // Сервер вернул 5xx — повторяем
    if (attemptsLeft > 1) {
      return new Promise(function(resolve) {
        setTimeout(function() {
          resolve(fetchWithRetry(request, attemptsLeft - 1));
        }, 600);
      });
    }
    return response;
  }).catch(function(err) {
    // Сетевая ошибка — повторяем
    if (attemptsLeft > 1) {
      return new Promise(function(resolve) {
        setTimeout(function() {
          resolve(fetchWithRetry(request, attemptsLeft - 1));
        }, 600);
      });
    }
    throw err;
  });
}

function queuedFetch(request) {
  return new Promise(function(resolve, reject) {
    _queue.push({ request: request, resolve: resolve, reject: reject });
    processQueue();
  });
}

// ==========================================
// INSTALL
// ==========================================
self.addEventListener('install', function(event) {
  console.log('[SW] Install');
  self.skipWaiting();
});

// ==========================================
// ACTIVATE
// ==========================================
self.addEventListener('activate', function(event) {
  console.log('[SW] Activate');
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then(function(keys) {
        return Promise.all(
          keys
            .filter(function(key) { return key !== CACHE_NAME; })
            .map(function(key) {
              console.log('[SW] Удаляем старый кеш:', key);
              return caches.delete(key);
            })
        );
      })
    ])
  );
});

// ==========================================
// FETCH — перехватываем запросы миниатюр
// ==========================================
self.addEventListener('fetch', function(event) {
  var url = event.request.url;

  if (event.request.method !== 'GET') return;
  if (!THUMB_PATTERN.test(url)) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.match(event.request).then(function(cached) {
        if (cached) {
          // CACHE HIT — мгновенно из кеша
          return cached;
        }

        // CACHE MISS — в очередь, максимум 4 параллельно
        console.log('[SW] Cache MISS, загружаем:', url.split('?')[1]);
        return queuedFetch(event.request).then(function(response) {
          if (response.ok) {
            cache.put(event.request, response.clone());
            console.log('[SW] Закешировано:', url.split('?')[1]);
          }
          return response;
        }).catch(function(err) {
          console.error('[SW] Ошибка после всех попыток:', err);
          return new Response('', { status: 503 });
        });
      });
    })
  );
});

// ==========================================
// MESSAGE — управление кешем из gallery.js
// ==========================================
self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'CLEAR_THUMB_CACHE') {
    console.log('[SW] Получена команда очистки кеша');
    caches.delete(CACHE_NAME).then(function() {
      console.log('[SW] Кеш миниатюр очищен');
      self.clients.matchAll().then(function(clients) {
        clients.forEach(function(client) {
          client.postMessage({ type: 'CACHE_CLEARED' });
        });
      });
    });
  }

  if (event.data && event.data.type === 'GET_CACHE_STATS') {
    caches.open(CACHE_NAME).then(function(cache) {
      cache.keys().then(function(keys) {
        event.source.postMessage({
          type: 'CACHE_STATS',
          count: keys.length,
          cacheName: CACHE_NAME
        });
      });
    });
  }
});
