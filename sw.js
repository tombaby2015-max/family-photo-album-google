// sw.js — Service Worker для кеширования миниатюр фото
//
// Стратегия: Cache First для миниатюр
// - Первый запрос: идём в сеть, кешируем ответ
// - Повторные запросы: отдаём мгновенно из кеша, без сети
// - Кеш не сбрасывается при деплоях воркера Cloudflare
// - Кеш не сбрасывается при перезагрузке страницы
// - Работает до тех пор пока браузер сам не очистит кеш (обычно 50-100MB лимит)

const CACHE_NAME = 'photo-thumbs-v1';

// Обрабатываем только запросы к нашему воркеру за миниатюрами
const THUMB_PATTERN = /\/photo\?.*size=thumb/;

// ==========================================
// INSTALL — активируемся сразу без ожидания
// ==========================================
self.addEventListener('install', function(event) {
  console.log('[SW] Install');
  // Активируемся немедленно, не ждём закрытия старых вкладок
  self.skipWaiting();
});

// ==========================================
// ACTIVATE — берём контроль над всеми вкладками
// ==========================================
self.addEventListener('activate', function(event) {
  console.log('[SW] Activate');
  event.waitUntil(
    Promise.all([
      // Берём контроль над всеми открытыми вкладками немедленно
      self.clients.claim(),
      // Удаляем старые версии кеша если есть
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
// FETCH — перехватываем запросы
// ==========================================
self.addEventListener('fetch', function(event) {
  var url = event.request.url;

  // Обрабатываем только GET запросы за миниатюрами
  if (event.request.method !== 'GET') return;
  if (!THUMB_PATTERN.test(url)) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.match(event.request).then(function(cached) {
        if (cached) {
          // CACHE HIT — отдаём из кеша мгновенно
          console.log('[SW] Cache HIT:', url.split('?')[1]);
          return cached;
        }

        // CACHE MISS — идём в сеть
        console.log('[SW] Cache MISS, загружаем:', url.split('?')[1]);
        return fetch(event.request).then(function(response) {
          // Кешируем только успешные ответы
          if (response.ok) {
            // Клонируем — response можно прочитать только один раз
            cache.put(event.request, response.clone());
            console.log('[SW] Закешировано:', url.split('?')[1]);
          }
          return response;
        }).catch(function(err) {
          console.error('[SW] Ошибка загрузки:', err);
          // Возвращаем пустой ответ чтобы не ломать страницу
          return new Response('', { status: 503 });
        });
      });
    })
  );
});

// ==========================================
// MESSAGE — управление кешем извне
// gallery.js может отправить сообщение чтобы очистить кеш
// ==========================================
self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'CLEAR_THUMB_CACHE') {
    console.log('[SW] Получена команда очистки кеша');
    caches.delete(CACHE_NAME).then(function() {
      console.log('[SW] Кеш миниатюр очищен');
      // Уведомляем все вкладки
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
