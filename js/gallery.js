// gallery.js — показывает папки и фото (Google Drive версия)
//
// ИЗМЕНЕНИЯ:
// 1. Добавлена регистрация Service Worker (sw.js)
//    SW кеширует миниатюры в Cache Storage браузера — работает быстрее localStorage,
//    не сбрасывается при деплоях воркера, живёт пока браузер сам не очистит кеш.
// 2. Добавлена диагностика: gallery.debugCacheStats() в консоли
// 3. Логика localStorage кеша для папок не изменилась
// 4. Оригиналы фото больше НЕ проксируются через Worker.
//    viewLink (lh3.googleusercontent.com =w2048) — для показа в fullscreen.
//    downloadUrl (drive.google.com/uc?export=download) — для скачивания.
//    Браузер загружает фото напрямую с Google CDN без участия Worker.

// Настройки кеша
var CACHE_KEY_FOLDERS = 'photo_cache_folders';
var CACHE_TTL = 30 * 60 * 1000; // 30 минут в миллисекундах
// Версия должна совпадать с CACHE_NAME в sw.js
// При смене версии кэша SW — старые метки загрузки автоматически игнорируются
var THUMB_CACHE_VERSION = 'v4';
var CACHE_KEY_LOADED_FOLDERS = 'photo_loaded_folders_' + THUMB_CACHE_VERSION;

// ==========================================
// SERVICE WORKER — регистрация
//
// sw.js должен лежать в корне сайта (рядом с index.html)
// чтобы его scope охватывал весь сайт.
// ==========================================
(function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    console.log('[SW] Service Worker не поддерживается этим браузером');
    return;
  }

  navigator.serviceWorker.register('/family-photo-album-google/sw.js').then(function(registration) {
    console.log('[SW] Зарегистрирован, scope:', registration.scope);

    // Разблокируем поворот экрана для PWA на Android
    if (screen.orientation && screen.orientation.unlock) {
      screen.orientation.unlock();
    }

    // Если есть обновление SW — активируем его
    registration.addEventListener('updatefound', function() {
      var newWorker = registration.installing;
      newWorker.addEventListener('statechange', function() {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          console.log('[SW] Доступно обновление Service Worker');
        }
      });
    });
  }).catch(function(err) {
    console.warn('[SW] Ошибка регистрации:', err);
  });

  // Слушаем сообщения от SW
  navigator.serviceWorker.addEventListener('message', function(event) {
    if (event.data && event.data.type === 'CACHE_CLEARED') {
      console.log('[SW] Кеш миниатюр был очищен');
    }
    if (event.data && event.data.type === 'CACHE_STATS') {
      console.log('[SW] Кеш миниатюр: ' + event.data.count + ' файлов в кеше "' + event.data.cacheName + '"');
    }
  });
})();

var gallery = {
    folders: [],
    currentPhotos: [],
    visiblePhotos: [],
    currentFolder: null,
    currentPhotoIndex: 0,
    editingFolder: null,
    previewState: { x: 50, y: 50, scale: 100 },
    keyHandler: null,
    sections: [],
    sectionModeActive: false,

    // ==========================================
    // ДИАГНОСТИКА КЕША
    // Вызови gallery.debugCacheStats() в консоли браузера
    // чтобы увидеть сколько миниатюр закешировано
    // ==========================================
    debugCacheStats: function() {
      if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) {
        console.warn('[Debug] Service Worker не активен');
        return;
      }
      navigator.serviceWorker.controller.postMessage({ type: 'GET_CACHE_STATS' });
      console.log('[Debug] Запрос статистики отправлен, смотри следующее сообщение...');
    },

    // Очистить кеш миниатюр (например после синхронизации с Drive)
    clearThumbCache: function() {
      if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) return;
      navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_THUMB_CACHE' });
      console.log('[Cache] Команда очистки кеша миниатюр отправлена');
    },

    // ==========================================
    // КЕШ ПАПОК (localStorage)
    // Сохраняем список папок в localStorage браузера.
    // При повторном открытии — показываем мгновенно из кеша,
    // фоном тихо загружаем свежие данные с сервера.
    // Если данные изменились — обновляем страницу незаметно.
    // ==========================================

    _saveFoldersToCache: function(folders) {
        if (api.isAdmin()) return;
        try {
            var entry = {
                folders: folders,
                timestamp: Date.now()
            };
            localStorage.setItem(CACHE_KEY_FOLDERS, JSON.stringify(entry));
        } catch(e) {}
    },

    _loadFoldersFromCache: function() {
        if (api.isAdmin()) return null;
        try {
            var raw = localStorage.getItem(CACHE_KEY_FOLDERS);
            if (!raw) return null;
            var entry = JSON.parse(raw);
            if (Date.now() - entry.timestamp > CACHE_TTL) {
                localStorage.removeItem(CACHE_KEY_FOLDERS);
                return null;
            }
            return entry.folders || null;
        } catch(e) {
            return null;
        }
    },

    clearFoldersCache: function() {
        try {
            localStorage.removeItem(CACHE_KEY_FOLDERS);
        } catch(e) {}
        // Также очищаем кеш миниатюр при полном сбросе
        this.clearThumbCache();
    },

    // ==========================================
    // ИНИЦИАЛИЗАЦИЯ
    // ==========================================
    init: function() {
        var self = this;
        var hash = window.location.hash;
        if (hash && hash.indexOf('folder=') !== -1) {
            var folderId = hash.split('folder=')[1];
            self.loadFoldersAndOpen(folderId);
        } else {
            this.loadFolders();
        }
    },

    loadFoldersAndOpen: function(folderId) {
        var self = this;
        api.getFolders().then(function(folders) {
            self.folders = folders;
            self._saveFoldersToCache(folders);
            self.renderFolders();
            var folder = null;
            for (var i = 0; i < folders.length; i++) {
                if (folders[i].id === folderId) { folder = folders[i]; break; }
            }
            if (folder) self.openFolder(folder, false);
            else self.showMainPage();
        });
    },

    // ==========================================
    // ЗАГРУЗКА ПАПОК — с кешем
    // ==========================================
    loadFolders: function() {
        var self = this;
        var container = document.getElementById('folders-container');

        var cached = self._loadFoldersFromCache();

        if (cached && cached.length > 0) {
            self.folders = cached;
            self.renderFolders();

            api.getFolders().then(function(freshFolders) {
                if (self._foldersChanged(cached, freshFolders)) {
                    self.folders = freshFolders;
                    self._saveFoldersToCache(freshFolders);
                    self.renderFolders();
                } else {
                    self._saveFoldersToCache(freshFolders);
                }
            });
        } else {
            if (container) container.innerHTML = '<li class="loading">Загрузка папок...</li>';
            api.getFolders().then(function(folders) {
                self.folders = folders;
                self._saveFoldersToCache(folders);
                self.renderFolders();
            });
        }
    },

    _foldersChanged: function(oldFolders, newFolders) {
        if (oldFolders.length !== newFolders.length) return true;
        for (var i = 0; i < newFolders.length; i++) {
            var nf = newFolders[i];
            var of_ = null;
            for (var j = 0; j < oldFolders.length; j++) {
                if (oldFolders[j].id === nf.id) { of_ = oldFolders[j]; break; }
            }
            if (!of_) return true;
            if (of_.title !== nf.title) return true;
            if (of_.hidden !== nf.hidden) return true;
            if (of_.photo_count !== nf.photo_count) return true;
            if (of_.cover_url !== nf.cover_url) return true;
            if (of_.order !== nf.order) return true;
        }
        return false;
    },

    // ==========================================
    // РЕНДЕР ПАПОК
    // ==========================================
    renderFolders: function() {
        var self = this;
        var container = document.getElementById('folders-container');
        if (!container) return;

        if (self.folders.length === 0) {
            container.innerHTML = '<li class="empty-state"><h4>Папок пока нет</h4><p>Добавьте папки в Google Drive и нажмите "Синхронизировать"</p></li>';
            return;
        }

        var html = '';
        for (var i = 0; i < self.folders.length; i++) {
            html += self.createFolderCard(self.folders[i]);
        }
        container.innerHTML = html;

        // Показываем баннер для страницы папок (folderId=null)
        // Считаем только папки у которых есть обложка
        var foldersWithCover = self.folders.filter(function(f) { return !!f.cover_url; });
        self._showFirstLoadBannerIfNeeded(null);
        self._trackFolderCovers(foldersWithCover);

        for (var k = 0; k < self.folders.length; k++) {
            self.loadFolderCover(self.folders[k]);
        }

        for (var j = 0; j < self.folders.length; j++) {
            (function(folder) {
                var card = document.getElementById('folder-' + folder.id);
                if (card) {
                    card.onclick = function(e) {
                        if (self.editingFolder) return;
                        if (e.target.closest('.folder-card__admin-actions')) return;
                        if (e.target.closest('.preview-editor')) return;
                        self.openFolder(folder);
                    };
                }
            })(self.folders[j]);
        }

        if (api.isAdmin() && typeof Sortable !== 'undefined') {
            setTimeout(function() {
                if (typeof admin !== 'undefined') admin.initSortable();
            }, 100);
        }
    },

    loadFolderCover: function(folder) {
        var self = this;
        var imgEl = document.getElementById('folder-image-' + folder.id);
        if (!imgEl) return;

        if (folder.cover_url) {
            var thumbUrl = 'https://photo-backend.belovolov-email.workers.dev/photo?id=' + folder.cover_url + '&size=cover';
            self.applyFolderCover(imgEl, thumbUrl, folder);
        }
    },

    applyFolderCover: function(imgEl, url, folder) {
        var x = folder.cover_x !== undefined ? folder.cover_x : 50;
        var y = folder.cover_y !== undefined ? folder.cover_y : 50;
        var scale = folder.cover_scale !== undefined ? folder.cover_scale : 100;
        imgEl.style.backgroundImage = 'url(\'' + url + '\')';
        imgEl.style.backgroundPosition = x + '% ' + y + '%';
        imgEl.style.backgroundSize = scale + '%';
        imgEl.dataset.fileId = folder.cover_url || '';
    },

    createFolderCard: function(folder) {
        var isAdmin = api.isAdmin();
        var isEditing = this.editingFolder === folder.id;
        var hiddenClass = folder.hidden ? 'hidden-folder' : '';

        var adminActions = '';
        if (isAdmin && !isEditing) {
            adminActions =
                '<div class="folder-card__admin-actions">' +
                '<button onclick="event.stopPropagation(); admin.toggleFolderHidden(\'' + folder.id + '\', ' + !folder.hidden + ')" title="' + (folder.hidden ? 'Показать' : 'Скрыть') + '">' + (folder.hidden ? '👁' : '🙈') + '</button>' +
                '<button onclick="event.stopPropagation(); admin.renameFolder(\'' + folder.id + '\', \'' + folder.title.replace(/'/g, "\\'" ).replace(/"/g, '&quot;') + '\')" title="Переименовать">✏️</button>' +
                '<button onclick="event.stopPropagation(); gallery.startEditPreview(\'' + folder.id + '\')" title="Редактировать обложку">🖼️</button>' +
                '</div>';
        }

        var previewEditor = '';
        if (isEditing) {
            previewEditor =
                '<div class="preview-editor">' +
                '<button class="preview-editor__btn up" onclick="gallery.movePreview(0, -10)">↑</button>' +
                '<button class="preview-editor__btn down" onclick="gallery.movePreview(0, 10)">↓</button>' +
                '<button class="preview-editor__btn left" onclick="gallery.movePreview(-10, 0)">←</button>' +
                '<button class="preview-editor__btn right" onclick="gallery.movePreview(10, 0)">→</button>' +
                '<button class="preview-editor__btn zoom-out" onclick="gallery.zoomPreview(-10)">−</button>' +
                '<button class="preview-editor__btn save" onclick="gallery.savePreview()">Сохранить</button>' +
                '<button class="preview-editor__btn zoom-in" onclick="gallery.zoomPreview(10)">+</button>' +
                '</div>';
        }

        var photoCount = isAdmin
            ? (folder.photo_count_admin || folder.photo_count || 0)
            : (folder.photo_count || 0);

        return '<li id="folder-' + folder.id + '" class="t214__col t-item t-card__col t-col t-col_4 folder-card ' + hiddenClass + (isEditing ? ' editing' : '') + '" data-folder-id="' + folder.id + '">' +
            '<div class="folder-card__image" id="folder-image-' + folder.id + '" style="background-color:#eee;">' +
                '<div class="folder-card__title">' +
                    '<div class="folder-card__title-name">' + folder.title.replace(/\|/g, '<br>') + '</div>' +
                    (photoCount > 0 ? '<div class="folder-card__title-count">(' + photoCount + ' фото)</div>' : '') +
                '</div>' +
                adminActions +
                previewEditor +
            '</div>' +
        '</li>';
    },

    // === РЕДАКТОР ОБЛОЖКИ ===
    startEditPreview: function(folderId) {
        var self = this;
        var folder = null;
        for (var i = 0; i < self.folders.length; i++) {
            if (self.folders[i].id === folderId) { folder = self.folders[i]; break; }
        }
        if (!folder) return;

        self.editingFolder = folderId;
        self.previewState = {
            x: folder.cover_x !== undefined ? folder.cover_x : 50,
            y: folder.cover_y !== undefined ? folder.cover_y : 50,
            scale: folder.cover_scale !== undefined ? folder.cover_scale : 100
        };

        self.renderFolders();

        var imgEl = document.getElementById('folder-image-' + folderId);
        if (imgEl) {
            if (folder.cover_url) {
                var url = 'https://photo-backend.belovolov-email.workers.dev/photo?id=' + folder.cover_url + '&size=thumb';
                imgEl.style.backgroundImage = 'url(\'' + url + '\')';
                imgEl.dataset.fileId = folder.cover_url;
            } else {
                api.getPhotosList(folderId).then(function(photos) {
                    if (photos.length > 0) {
                        var url = 'https://photo-backend.belovolov-email.workers.dev/photo?id=' + photos[0].file_id + '&size=thumb';
                        imgEl.style.backgroundImage = 'url(\'' + url + '\')';
                        imgEl.dataset.fileId = photos[0].file_id;
                    }
                });
            }
            self.updatePreviewStyle(imgEl);
        }
    },

    updatePreviewStyle: function(imgEl) {
        if (!imgEl) imgEl = document.getElementById('folder-image-' + this.editingFolder);
        if (!imgEl) return;
        imgEl.style.backgroundPosition = this.previewState.x + '% ' + this.previewState.y + '%';
        imgEl.style.backgroundSize = this.previewState.scale + '%';
    },

    movePreview: function(dx, dy) {
        this.previewState.x = Math.max(0, Math.min(100, this.previewState.x + dx));
        this.previewState.y = Math.max(0, Math.min(100, this.previewState.y + dy));
        this.updatePreviewStyle();
    },

    zoomPreview: function(delta) {
        this.previewState.scale = Math.max(50, Math.min(200, this.previewState.scale + delta));
        this.updatePreviewStyle();
    },

    savePreview: function() {
        var self = this;
        if (!self.editingFolder) return;

        var imgEl = document.getElementById('folder-image-' + self.editingFolder);
        var fileId = imgEl ? (imgEl.dataset.fileId || null) : null;

        api.updateFolder(self.editingFolder, {
            cover_url: fileId,
            cover_x: self.previewState.x,
            cover_y: self.previewState.y,
            cover_scale: self.previewState.scale
        }).then(function() {
            self.editingFolder = null;
            self.clearFoldersCache();
            self.loadFolders();
        });
    },

    // === БАННЕР ПЕРВОЙ ЗАГРУЗКИ ===
    _isFirstLoad: function(folderId) {
        // folderId = null означает страницу с папками
        var key = folderId || '__folders__';
        try {
            var loaded = JSON.parse(localStorage.getItem(CACHE_KEY_LOADED_FOLDERS) || '{}');
            return !loaded[key];
        } catch(e) { return true; }
    },

    _markFolderLoaded: function(folderId) {
        var key = folderId || '__folders__';
        try {
            var loaded = JSON.parse(localStorage.getItem(CACHE_KEY_LOADED_FOLDERS) || '{}');
            loaded[key] = true;
            localStorage.setItem(CACHE_KEY_LOADED_FOLDERS, JSON.stringify(loaded));
        } catch(e) {}
    },

    _showFirstLoadBannerIfNeeded: function(folderId) {
        if (!this._isFirstLoad(folderId)) return;
        var banner = document.getElementById('first-load-banner');
        var overlay = document.getElementById('first-load-banner-overlay');
        if (!banner) return;
        banner.style.display = 'block';
        if (overlay) overlay.style.display = 'block';
        var counter = document.getElementById('banner-counter-text');
        var sub = document.getElementById('banner-sub-text');
        if (counter) counter.textContent = '';
        if (sub) sub.textContent = '';
    },

    _hideFirstLoadBanner: function(folderId) {
        var banner = document.getElementById('first-load-banner');
        var overlay = document.getElementById('first-load-banner-overlay');
        if (banner) banner.style.display = 'none';
        if (overlay) overlay.style.display = 'none';
        this._markFolderLoaded(folderId);
    },

    // Последовательная prefetch-загрузка оригиналов через SW после показа миниатюр.
    // Загружает по одному фото в порядке отображения в сетке.
    // SW перехватит запросы и закеширует — при открытии fullscreen фото будет мгновенным.
    _prefetchOriginalsSequentially: function() {
        var self = this;
        var photos = self.visiblePhotos;
        if (!photos || photos.length === 0) return;
        if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) return;

        var index = 0;

function loadNext() {
            if (index >= photos.length) return;
            var photo = photos[index];
            index++;
            if (!photo.viewUrl) { loadNext(); return; }
            var img = new Image();
            img.onload  = function() { setTimeout(loadNext, 500); };
            img.onerror = function() { setTimeout(loadNext, 500); };
            img.src = photo.viewUrl;
        }

        loadNext();
    },

    // Трекер для обложек папок (background-image — onload не работает, используем Image())
    _trackFolderCovers: function(folders) {
        var self = this;
        if (!this._isFirstLoad(null)) return;
        var total = folders.length;
        if (total === 0) { self._hideFirstLoadBanner(null); return; }

        var loaded = 0;
        var counter = document.getElementById('banner-counter-text');
        var sub = document.getElementById('banner-sub-text');
        if (counter) counter.textContent = '0 / ' + total;
        if (sub) sub.textContent = 'обложек загружено';

        function onOne() {
            loaded++;
            if (counter) counter.textContent = loaded + ' / ' + total;
            if (loaded >= total) {
                setTimeout(function() { self._hideFirstLoadBanner(null); }, 800);
            }
        }

        folders.forEach(function(folder) {
            var url = 'https://photo-backend.belovolov-email.workers.dev/photo?id=' + folder.cover_url + '&size=thumb';
            var img = new Image();
            img.onload  = onOne;
            img.onerror = onOne;
            img.src = url;
        });

        // Страховка 60 сек
        setTimeout(function() { self._hideFirstLoadBanner(null); }, 60000);
    },

    // Запускает отслеживание загрузки img и обновляет счётчик
    _trackImagesLoading: function(folderId, total) {
        var self = this;
        if (!this._isFirstLoad(folderId)) return;
        if (total === 0) { self._hideFirstLoadBanner(folderId); return; }

        var loaded = 0;
        var counter = document.getElementById('banner-counter-text');
        var sub = document.getElementById('banner-sub-text');

        if (counter) counter.textContent = '0 / ' + total;
        if (sub) sub.textContent = 'фото загружено';

        var containerId = folderId ? 'photos-container' : 'folders-container';
        var container = document.getElementById(containerId);
        if (!container) { self._hideFirstLoadBanner(folderId); return; }

        var observed = new Set();
        var observer = null;

        function checkDone() {
            loaded++;
            if (counter) counter.textContent = loaded + ' / ' + total;
            if (loaded >= total) {
                if (observer) observer.disconnect();
                        setTimeout(function() {
                            self._hideFirstLoadBanner(folderId);
                            self._prefetchOriginalsSequentially();
                        }, 800);
            }
        }

        function attachToImg(img) {
            if (observed.has(img)) return;
            // Пропускаем img без src (обложки папок могут грузиться отдельно)
            if (!img.src || img.src === window.location.href) return;
            observed.add(img);
            if (img.complete && img.naturalWidth > 0) {
                // Уже загружено (из кэша браузера)
                checkDone();
            } else if (img.complete && img.naturalWidth === 0) {
                // Ошибка загрузки — тоже считаем
                checkDone();
            } else {
                img.addEventListener('load',  checkDone, { once: true });
                img.addEventListener('error', checkDone, { once: true });
            }
        }

        // MutationObserver — ловим img которые появятся после рендера
        observer = new MutationObserver(function(mutations) {
            mutations.forEach(function(m) {
                m.addedNodes.forEach(function(node) {
                    if (node.nodeType !== 1) return;
                    if (node.tagName === 'IMG') attachToImg(node);
                    if (node.querySelectorAll) {
                        node.querySelectorAll('img').forEach(attachToImg);
                    }
                });
                // Ловим изменение src у существующих img (обложки папок)
                if (m.type === 'attributes' && m.target.tagName === 'IMG') {
                    attachToImg(m.target);
                }
            });
        });
        observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });

        // Вешаем на уже существующие img (на случай если рендер уже прошёл)
        container.querySelectorAll('img').forEach(attachToImg);

        // Страховка: если через 60 сек не закрылся — закрываем принудительно
        setTimeout(function() { self._hideFirstLoadBanner(folderId); }, 60000);
    },

    // === ОТКРЫТИЕ ПАПКИ ===
    openFolder: function(folder, pushState) {
        this._lastFolderId = folder.id;

        this.currentFolder = folder;
        this.currentPhotos = [];
        this.visiblePhotos = [];
        this.sectionModeActive = false;

        document.getElementById('main-page').style.display = 'none';
        document.getElementById('rec-cover').style.display = 'none';
        document.getElementById('folder-page').style.display = 'block';
        document.getElementById('folder-page').classList.remove('section-mode');

        document.getElementById('folder-title-text').textContent = folder.title;

        var coverEl = document.getElementById('folder-cover-image');
        if (coverEl) {
            coverEl.style.backgroundImage = "url('https://static.tildacdn.ink/tild3730-6566-4766-b165-306164333335/photo-1499002238440-.jpg')";
            coverEl.style.backgroundSize = 'cover';
            coverEl.style.backgroundPosition = 'center';
        }

        var sidebarBtns = document.getElementById('sidebar-admin-buttons');
        if (sidebarBtns) {
            sidebarBtns.style.display = api.isAdmin() ? 'flex' : 'none';
        }

        this._resetSectionModeButtons();

        window.scrollTo(0, 0);

        if (pushState !== false) {
            window.location.hash = 'folder=' + folder.id;
        }

        this.loadPhotos(folder.id);
    },

    _resetSectionModeButtons: function() {
        var btnEnable = document.getElementById('btn-enable-sections');
        var btnExit = document.getElementById('btn-exit-sections');
        var btnAdd = document.getElementById('btn-add-section');
        if (btnEnable) btnEnable.style.display = 'block';
        if (btnExit) btnExit.style.display = 'none';
        if (btnAdd) btnAdd.style.display = 'none';
    },

    // === ЗАГРУЗКА ФОТО ===
    loadPhotos: function(folderId) {
        var self = this;
        var container = document.getElementById('photos-container');

        if (container) container.innerHTML = '<div class="loading">Загрузка фото...</div>';
        self.currentPhotos = [];
        self.visiblePhotos = [];
        self.sections = [];

        // Показываем баннер если эта папка ещё никогда не загружалась (нет кэша миниатюр)
        self._showFirstLoadBannerIfNeeded(folderId);

        Promise.all([
            api.getPhotosList(folderId),
            api.getSections(folderId)
        ]).then(function(results) {
            var allPhotos = results[0];
            self.sections = results[1] || [];
            self.currentPhotos = allPhotos;
            self.visiblePhotos = allPhotos.slice();

            if (allPhotos.length === 0) {
                if (container) container.innerHTML = '<div class="empty-state"><h4>В этой папке пока нет фото</h4></div>';
                return;
            }

            api.getPhotosThumbnails(folderId, allPhotos).then(function(thumbUrls) {
                for (var i = 0; i < allPhotos.length; i++) {
                    allPhotos[i].thumbUrl = thumbUrls[allPhotos[i].id] || '';

                    // Оригиналы: используем viewLink из KV (Google CDN, без Worker).
                    // Fallback: drive.google.com/uc (работает для расшаренных файлов).
                    // Worker больше не участвует в доставке оригинальных фото.
                    allPhotos[i].viewUrl = allPhotos[i].viewLink
                        || ('https://drive.google.com/uc?id=' + allPhotos[i].file_id);

                    // Ссылка для скачивания — drive.google.com с параметром export=download
                    allPhotos[i].downloadUrl =
                        'https://photo-backend.belovolov-email.workers.dev/photo' +
                        '?id='     + allPhotos[i].file_id +
                        '&size=original' +
                        '&folder=' + encodeURIComponent(self.currentFolder ? self.currentFolder.title : '') +
                        '&name='   + encodeURIComponent(allPhotos[i].name || (allPhotos[i].file_id + '.jpg'));
                }

                if (container) container.innerHTML = '';
                // Рендерим порциями по 20 — сетка появляется сразу, не ждём все фото
                self._renderPhotosInBatches(allPhotos, folderId);

                if (api.isAdmin() && self.sectionModeActive) {
                    setTimeout(function() {
                        if (typeof admin !== 'undefined') admin.initPhotosSortable();
                    }, 100);
                }
            });
        }).catch(function() {
            if (container) container.innerHTML = '<p>Ошибка загрузки</p>';
        });
    },

    // === РЕНДЕР ФОТО ===
    renderPhotos: function(fromIndex) {
        var self = this;
        var container = document.getElementById('photos-container');
        if (!container) return;

        if (!fromIndex || fromIndex === 0) {
            container.innerHTML = '';

            if (self.sectionModeActive && api.isAdmin()) {
                self._renderSectionMode(container);
            } else {
                self._renderNormalMode(container);
            }
        } else {
            for (var k = fromIndex; k < self.visiblePhotos.length; k++) {
                var photo = self.visiblePhotos[k];
                var targetGrid = self._getPhotoGrid(photo);
                if (targetGrid) {
                    var it = self.createPhotoItem(photo, k);
                    var dv = document.createElement('div');
                    dv.innerHTML = it;
                    targetGrid.appendChild(dv.firstChild);
                }
            }
        }

        self._buildDisplayOrder();
    },

    // Рендерит все фото сразу + запускает счётчик загрузки для баннера
    _renderPhotosInBatches: function(allPhotos, folderId) {
        var self = this;
        var total = self.visiblePhotos.length;

        // Запускаем отслеживание загрузки img ДО рендера
        self._trackImagesLoading(folderId, total);

        // Рендерим все фото сразу (порционность убрана — ломала перелистывание в секциях)
        self.renderPhotos(0);
    },

    _buildDisplayOrder: function() {
        var self = this;
        // Строим порядок из реального DOM — именно в том порядке как фото отображаются
        // (нераспределённые → секция 1 → секция 2 → ...)
        // Это важно для корректного перелистывания когда есть секции
        var container = document.getElementById('photos-container');
        if (container) {
            var items = container.querySelectorAll('.photo-item');
            var domOrder = [];
            items.forEach(function(el) {
                var id = el.getAttribute('data-id');
                if (id) domOrder.push(id);
            });
            if (domOrder.length > 0) {
                // Перестраиваем visiblePhotos в порядке DOM
                var photoMap = {};
                self.visiblePhotos.forEach(function(p) { photoMap[p.id] = p; });
                var reordered = [];
                domOrder.forEach(function(id) {
                    if (photoMap[id]) reordered.push(photoMap[id]);
                });
                // Добавляем фото которых нет в DOM (на случай рассинхронизации)
                self.visiblePhotos.forEach(function(p) {
                    if (!photoMap[p.id] || domOrder.indexOf(p.id) === -1) reordered.push(p);
                });
                self.visiblePhotos = reordered;
            }
        }
        self._displayOrder = self.visiblePhotos.map(function(p) { return p.id; });
    },

    _displayIndexById: function(photoId) {
        if (!this._displayOrder) return -1;
        return this._displayOrder.indexOf(photoId);
    },

    _photoById: function(photoId) {
        for (var i = 0; i < this.visiblePhotos.length; i++) {
            if (this.visiblePhotos[i].id === photoId) return this.visiblePhotos[i];
        }
        return null;
    },

    _renderNormalMode: function(container) {
        var self = this;
        var sections = self.sections || [];

        var bySection = {};
        var unsectioned = [];
        for (var i = 0; i < self.visiblePhotos.length; i++) {
            var p = self.visiblePhotos[i];
            if (p.section_id) {
                if (!bySection[p.section_id]) bySection[p.section_id] = [];
                bySection[p.section_id].push(p);
            } else {
                unsectioned.push(p);
            }
        }

        if (unsectioned.length > 0) {
            var grid = document.createElement('div');
            grid.id = 'unsectioned-grid';
            grid.className = 'photos-grid';
            grid.setAttribute('data-section-id', '');
            for (var j = 0; j < unsectioned.length; j++) {
                var item = self.createPhotoItem(unsectioned[j], self.visiblePhotos.indexOf(unsectioned[j]));
                var d = document.createElement('div');
                d.innerHTML = item;
                grid.appendChild(d.firstChild);
            }
            container.appendChild(grid);
        }

        for (var k = 0; k < sections.length; k++) {
            var section = sections[k];
            var sectionPhotos = bySection[section.id] || [];

            var sectionBlock = document.createElement('div');
            sectionBlock.className = 'photos-section-block';
            sectionBlock.id = 'section-block-' + section.id;

            var headerHtml =
                '<div class="photos-section-header">' +
                '<div class="photos-section-line"></div>' +
                '<span class="photos-section-title" id="section-title-' + section.id + '">' + section.title + '</span>' +
                '<div class="photos-section-line"></div>';

            if (api.isAdmin()) {
                headerHtml +=
                    '<div class="photos-section-admin-actions">' +
                    '<button onclick="admin.renameSection(\'' + section.id + '\')" title="Переименовать">✏️</button>' +
                    '<button onclick="admin.deleteSection(\'' + section.id + '\')" title="Удалить">🗑️</button>' +
                    '</div>';
            }
            headerHtml += '</div>';
            sectionBlock.innerHTML = headerHtml;

            var sectionGrid = document.createElement('div');
            sectionGrid.id = 'section-grid-' + section.id;
            sectionGrid.className = 'photos-grid';
            sectionGrid.setAttribute('data-section-id', section.id);

            for (var m = 0; m < sectionPhotos.length; m++) {
                var sItem = self.createPhotoItem(sectionPhotos[m], self.visiblePhotos.indexOf(sectionPhotos[m]));
                var sDiv = document.createElement('div');
                sDiv.innerHTML = sItem;
                sectionGrid.appendChild(sDiv.firstChild);
            }

            sectionBlock.appendChild(sectionGrid);
            container.appendChild(sectionBlock);
        }
    },

    _renderSectionMode: function(container) {
        var self = this;
        var sections = self.sections || [];

        var bySection = {};
        var unsectioned = [];
        for (var i = 0; i < self.visiblePhotos.length; i++) {
            var p = self.visiblePhotos[i];
            if (p.section_id) {
                if (!bySection[p.section_id]) bySection[p.section_id] = [];
                bySection[p.section_id].push(p);
            } else {
                unsectioned.push(p);
            }
        }

        var topBlock = document.createElement('div');
        topBlock.id = 'unsectioned-wrap';
        topBlock.className = 'section-mode-top';
        topBlock.style.display = unsectioned.length > 0 ? '' : 'none';

        var topLabel = document.createElement('div');
        topLabel.className = 'section-block-label';
        topLabel.textContent = 'Нераспределённые фото';
        topBlock.appendChild(topLabel);

        var topGrid = document.createElement('div');
        topGrid.id = 'unsectioned-grid';
        topGrid.className = 'photos-section-grid';
        topGrid.setAttribute('data-section-id', '');
        for (var j = 0; j < unsectioned.length; j++) {
            var item = self.createPhotoItem(unsectioned[j], self.visiblePhotos.indexOf(unsectioned[j]));
            var d = document.createElement('div');
            d.innerHTML = item;
            topGrid.appendChild(d.firstChild);
        }
        topBlock.appendChild(topGrid);
        container.appendChild(topBlock);

        var bottomBlock = document.createElement('div');
        bottomBlock.id = 'sections-wrap';
        bottomBlock.className = 'section-mode-bottom';

        for (var k = 0; k < sections.length; k++) {
            var section = sections[k];
            var sectionPhotos = bySection[section.id] || [];

            var sectionEl = document.createElement('div');
            sectionEl.className = 'photos-section-block';
            sectionEl.id = 'section-block-' + section.id;

            var headerHtml =
                '<div class="photos-section-header">' +
                '<div class="photos-section-line"></div>' +
                '<span class="photos-section-title" id="section-title-' + section.id + '">' + section.title + '</span>' +
                '<div class="photos-section-line"></div>' +
                '<div class="photos-section-admin-actions">' +
                '<button onclick="admin.renameSection(\'' + section.id + '\')" title="Переименовать">✏️</button>' +
                '<button onclick="admin.deleteSection(\'' + section.id + '\')" title="Удалить">🗑️</button>' +
                '</div>' +
                '</div>';
            sectionEl.innerHTML = headerHtml;

            var sectionGrid = document.createElement('div');
            sectionGrid.id = 'section-grid-' + section.id;
            sectionGrid.className = 'photos-section-grid';
            sectionGrid.setAttribute('data-section-id', section.id);

            for (var m = 0; m < sectionPhotos.length; m++) {
                var sItem = self.createPhotoItem(sectionPhotos[m], self.visiblePhotos.indexOf(sectionPhotos[m]));
                var sDiv = document.createElement('div');
                sDiv.innerHTML = sItem;
                sectionGrid.appendChild(sDiv.firstChild);
            }

            sectionEl.appendChild(sectionGrid);
            bottomBlock.appendChild(sectionEl);
        }

        if (sections.length === 0) {
            var hint = document.createElement('div');
            hint.style.cssText = 'padding:30px;text-align:center;color:#aaa;font-size:14px;';
            hint.textContent = 'Секций пока нет. Нажмите "+ Добавить секцию".';
            bottomBlock.appendChild(hint);
        }

        container.appendChild(bottomBlock);
    },

    _getPhotoGrid: function(photo) {
        if (photo.section_id) {
            var g = document.getElementById('section-grid-' + photo.section_id);
            if (g) return g;
        }
        return document.getElementById('unsectioned-grid');
    },

    _updateUnsectionedVisibility: function() {
        var wrap = document.getElementById('unsectioned-wrap');
        var grid = document.getElementById('unsectioned-grid');
        if (!wrap || !grid) return;
        wrap.style.display = grid.querySelector('.photo-item') !== null ? '' : 'none';
        this._buildDisplayOrder();
    },

    createPhotoItem: function(photo, index) {
        var isAdmin = api.isAdmin();
        var hiddenClass = photo.hidden ? 'hidden-photo' : '';

        var adminActions = '';
        if (isAdmin) {
            adminActions =
                '<div class="photo-item__admin-actions" onclick="event.stopPropagation()">' +
                '<button onclick="event.stopPropagation(); admin.togglePhotoHidden(\'' + photo.id + '\')" title="' + (photo.hidden ? 'Показать' : 'Скрыть') + '">' + (photo.hidden ? '👁' : '🙈') + '</button>' +
                '<button onclick="event.stopPropagation(); admin.deletePhoto(\'' + photo.id + '\')" title="Удалить">🗑️</button>' +
                '</div>';
        }

        return '<div class="photo-item ' + hiddenClass + '" data-id="' + photo.id + '" data-hidden="' + (photo.hidden ? '1' : '0') + '" data-index="' + index + '" onclick="gallery.handlePhotoClick(event, \'' + photo.id + '\')">' +
            '<img src="' + (photo.thumbUrl || '') + '" alt="" style="width:100%;height:100%;object-fit:cover;">' +
            adminActions +
        '</div>';
    },

    handlePhotoClick: function(e, photoId) {
        if (typeof admin !== 'undefined' && admin.isSelectionMode) {
            e.stopPropagation();
            var checkbox = e.currentTarget.querySelector('.photo-checkbox-custom');
            if (checkbox) admin.togglePhotoSelection(photoId, checkbox);
            return;
        }
        var displayIndex = -1;
        for (var i = 0; i < this.visiblePhotos.length; i++) {
            if (this.visiblePhotos[i].id === photoId) {
                displayIndex = i;
                break;
            }
        }
        if (displayIndex === -1) return;
        this.openFullscreen(displayIndex);
    },

    // === FULLSCREEN ПРОСМОТР ===
    _fvSlot: 0,

    _fvImgs: function() {
        return [
            document.getElementById('fv-img-0'),
            document.getElementById('fv-img-1'),
            document.getElementById('fv-img-2')
        ];
    },

    _fvSetPos: function(img, x, animate) {
        if (!img) return;
        img.style.transition = animate
            ? 'transform 0.32s cubic-bezier(.4,0,.2,1)'
            : 'none';
        img.style.transform = 'translateX(' + x + '%)';
    },

    openFullscreen: function(index) {
        if (index < 0 || index >= this.visiblePhotos.length) return;
        this.currentPhotoIndex = index;
        this._animating = false;

        var viewer = document.getElementById('fullscreen-viewer');
        var container = document.querySelector('.fullscreen-viewer__image-container');
        if (!viewer || !container) return;

        if (!document.getElementById('fv-img-0')) {
            var baseStyle = 'position:absolute;max-width:100%;max-height:100%;object-fit:contain;border-radius:4px;will-change:transform;';
            container.innerHTML =
                '<img id="fv-img-0" style="' + baseStyle + 'transform:translateX(0);" src="" alt="">' +
                '<img id="fv-img-1" style="' + baseStyle + 'transform:translateX(100%);" src="" alt="">' +
                '<img id="fv-img-2" style="' + baseStyle + 'transform:translateX(100%);" src="" alt="">';
        }

        this._fvSlot = 0;
        var imgs = this._fvImgs();
        for (var i = 0; i < 3; i++) {
            imgs[i].src = '';
            this._fvSetPos(imgs[i], 100, false);
        }

        // Используем viewUrl (Google CDN) — браузер грузит напрямую, Worker не участвует
        imgs[0].src = this.visiblePhotos[index].viewUrl || this.visiblePhotos[index].thumbUrl || '';
        this._fvSetPos(imgs[0], 0, false);

        this._updateActionsPanel(this.visiblePhotos[index]);
        viewer.style.display = 'flex';

        if (!document.getElementById('fv-tap-prev')) {
            var tapPrev = document.createElement('div');
            tapPrev.id = 'fv-tap-prev';
            tapPrev.style.cssText = 'position:absolute;left:0;top:0;width:25%;height:100%;z-index:3;cursor:pointer;display:none;-webkit-tap-highlight-color:transparent;user-select:none;';
            var tapNext = document.createElement('div');
            tapNext.id = 'fv-tap-next';
            tapNext.style.cssText = 'position:absolute;right:0;top:0;width:25%;height:100%;z-index:3;cursor:pointer;display:none;-webkit-tap-highlight-color:transparent;user-select:none;';
            var wrapper = document.querySelector('.fullscreen-viewer__wrapper');
            if (wrapper) {
                wrapper.appendChild(tapPrev);
                wrapper.appendChild(tapNext);
            }
        }

        var isMobile = window.innerWidth <= 768;
        var tapP = document.getElementById('fv-tap-prev');
        var tapN = document.getElementById('fv-tap-next');
        if (tapP) tapP.style.display = isMobile ? 'block' : 'none';
        if (tapN) tapN.style.display = isMobile ? 'block' : 'none';

        if (typeof lucide !== 'undefined') lucide.createIcons();

        var self = this;
        if (this.keyHandler) document.removeEventListener('keydown', this.keyHandler);
        this.keyHandler = function(e) {
            if (e.key === 'Escape') self.closeFullscreen();
            else if (e.key === 'ArrowLeft') self.prevPhoto();
            else if (e.key === 'ArrowRight') self.nextPhoto();
        };
        document.addEventListener('keydown', this.keyHandler);
    },

    _goToPhoto: function(newIndex, direction) {
        if (this._animating) return;
        if (newIndex < 0 || newIndex >= this.visiblePhotos.length) return;

        var self = this;
        var imgs = this._fvImgs();
        if (!imgs[0]) { self.openFullscreen(newIndex); return; }

        this._animating = true;

        var currSlot = this._fvSlot;
        var nextSlot = (currSlot + 1) % 3;

        var exitTo    = direction === 'left' ? -60  :  60;
        var enterFrom = direction === 'left' ? 160  : -160;
        var DURATION  = 280;

        // Используем viewUrl — Google CDN, без Worker
        imgs[nextSlot].src = self.visiblePhotos[newIndex].viewUrl || self.visiblePhotos[newIndex].thumbUrl || '';
        imgs[nextSlot].style.transition = 'none';
        imgs[nextSlot].style.transform  = 'translateX(' + enterFrom + '%)';
        imgs[nextSlot].style.opacity    = '0';

        requestAnimationFrame(function() {
            requestAnimationFrame(function() {
                var timing = 'transform ' + DURATION + 'ms cubic-bezier(.4,0,.2,1), opacity ' + DURATION + 'ms ease';

                imgs[currSlot].style.transition = timing;
                imgs[currSlot].style.transform  = 'translateX(' + exitTo + '%)';
                imgs[currSlot].style.opacity    = '0';

                imgs[nextSlot].style.transition = timing;
                imgs[nextSlot].style.transform  = 'translateX(0)';
                imgs[nextSlot].style.opacity    = '1';

                setTimeout(function() {
                    imgs[currSlot].style.transition = 'none';
                    imgs[currSlot].style.transform  = 'translateX(100%)';
                    imgs[currSlot].style.opacity    = '1';
                    imgs[currSlot].src = '';

                    self._fvSlot = nextSlot;
                    self.currentPhotoIndex = newIndex;
                    self._updateActionsPanel(self.visiblePhotos[newIndex]);
                    if (typeof lucide !== 'undefined') lucide.createIcons();
                    self._animating = false;
                }, DURATION + 20);
            });
        });
    },

    _updateActionsPanel: function(photo) {
        var panel = document.getElementById('fullscreen-actions');
        if (!panel) return;
        var isAdmin = api.isAdmin();

        // downloadUrl — drive.google.com/uc?export=download, скачивается напрямую с Google
        panel.innerHTML =
            (isAdmin ? '<button class="fv-action-btn" onclick="admin.setFolderCover()"><i data-lucide="image"></i><span>Обложка</span></button>' : '') +
            '<a id="download-link" class="fv-action-btn" href="' + (photo.downloadUrl || '#') + '" download><i data-lucide="download"></i><span>Скачать</span></a>' +
            (isAdmin ? '<button class="fv-action-btn fv-action-btn--danger" onclick="admin.deleteCurrentPhoto()"><i data-lucide="trash-2"></i><span>Удалить</span></button>' : '') +
            '<button class="fv-action-btn" onclick="gallery.closeFullscreen()"><i data-lucide="x"></i><span>Закрыть</span></button>';
    },

    closeFullscreen: function() {
        var viewer = document.getElementById('fullscreen-viewer');
        if (viewer) viewer.style.display = 'none';
        this._animating = false;
        if (this.keyHandler) {
            document.removeEventListener('keydown', this.keyHandler);
            this.keyHandler = null;
        }
    },

    prevPhoto: function() {
        if (this.currentPhotoIndex > 0)
            this._goToPhoto(this.currentPhotoIndex - 1, 'right');
    },

    nextPhoto: function() {
        if (this.currentPhotoIndex < this.visiblePhotos.length - 1)
            this._goToPhoto(this.currentPhotoIndex + 1, 'left');
    },

    initSwipe: function() {
        var self = this;
        var viewer = document.getElementById('fullscreen-viewer');
        if (!viewer) return;

        var startX = 0, startY = 0, startTime = 0;

        viewer.addEventListener('touchstart', function(e) {
            if (e.target.closest('.fullscreen-viewer__actions') || e.target.closest('.fullscreen-viewer__nav')) return;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            startTime = Date.now();
        }, { passive: true });

        viewer.addEventListener('touchend', function(e) {
            if (e.target.closest('.fullscreen-viewer__actions') || e.target.closest('.fullscreen-viewer__nav')) return;

            var dx = e.changedTouches[0].clientX - startX;
            var dy = e.changedTouches[0].clientY - startY;
            var dt = Date.now() - startTime;
            var absDx = Math.abs(dx);
            var absDy = Math.abs(dy);

            if (absDx < 15 && absDy < 15 && dt < 300) {
                var tapP = document.getElementById('fv-tap-prev');
                var tapN = document.getElementById('fv-tap-next');
                if (tapP && tapP.style.display !== 'none') {
                    var vw = viewer.offsetWidth;
                    var zone = vw * 0.25;
                    if (startX < zone) { self.prevPhoto(); return; }
                    if (startX > vw - zone) { self.nextPhoto(); return; }
                }
                return;
            }

            if (absDy > absDx * 0.8) return;
            if (absDx < 40) return;
            if (dx < 0) self._goToPhoto(self.currentPhotoIndex + 1, 'left');
            else self._goToPhoto(self.currentPhotoIndex - 1, 'right');
        }, { passive: true });
    },

    showMainPage: function() {
        if (typeof admin !== 'undefined' && admin.isSelectionMode) {
            admin.exitSelectionMode();
        }

        if (this.sectionModeActive) {
            this.sectionModeActive = false;
            var fp = document.getElementById('folder-page');
            if (fp) fp.classList.remove('section-mode');
        }

        var lastFolderId = this._lastFolderId;

        document.getElementById('folder-page').style.display = 'none';
        document.getElementById('main-page').style.display = 'block';
        document.getElementById('rec-cover').style.display = 'block';
        this.currentFolder = null;
        window.location.hash = '';

        if (lastFolderId) {
            setTimeout(function() {
                var card = document.getElementById('folder-' + lastFolderId);
                if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 100);
        }
    }
};

document.addEventListener('DOMContentLoaded', function() {
    gallery.init();
    gallery.initSwipe();
});

function scrollToFolders() {
    var mainPage = document.getElementById('main-page');
    if (mainPage) mainPage.scrollIntoView({ behavior: 'smooth' });
}
