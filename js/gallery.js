// gallery.js — показывает папки и фото (Google Drive версия)
//
// ОПТИМИЗАЦИЯ: добавлен localStorage кеш для папок
// Логика "сначала показать из кеша, потом проверить на сервере"
//
// Всё остальное не изменилось:
// - роли посетитель/администратор
// - секции внутри папок
// - батчевая загрузка по 40 фото
// - обложка с настройкой позиции
// - hash в URL (#folder=ID)
// - полноэкранный просмотр, свайпы, клавиши


// Настройки кеша
var CACHE_KEY_FOLDERS = 'photo_cache_folders';
var CACHE_TTL = 30 * 60 * 1000; // 30 минут в миллисекундах

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
    // КЕШ ПАПОК
    // Сохраняем список папок в localStorage браузера.
    // При следующем открытии — показываем мгновенно из кеша,
    // фоном тихо загружаем свежие данные с сервера.
    // Если данные изменились — обновляем страницу незаметно.
    // ==========================================

    // Сохранить папки в кеш
    _saveFoldersToCache: function(folders) {
        // Администраторам не кешируем — им всегда нужны актуальные данные
        if (api.isAdmin()) return;
        try {
            var entry = {
                folders: folders,
                timestamp: Date.now()
            };
            localStorage.setItem(CACHE_KEY_FOLDERS, JSON.stringify(entry));
        } catch(e) {
            // localStorage может быть недоступен (приватный режим и т.д.) — игнорируем
        }
    },

    // Прочитать папки из кеша
    // Возвращает массив папок или null если кеш устарел/отсутствует
    _loadFoldersFromCache: function() {
        if (api.isAdmin()) return null;
        try {
            var raw = localStorage.getItem(CACHE_KEY_FOLDERS);
            if (!raw) return null;
            var entry = JSON.parse(raw);
            // Проверяем не устарел ли кеш
            if (Date.now() - entry.timestamp > CACHE_TTL) {
                localStorage.removeItem(CACHE_KEY_FOLDERS);
                return null;
            }
            return entry.folders || null;
        } catch(e) {
            return null;
        }
    },

    // Сбросить кеш (вызывается после синхронизации или изменений)
    clearFoldersCache: function() {
        try {
            localStorage.removeItem(CACHE_KEY_FOLDERS);
        } catch(e) {}
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
    //
    // Шаг 1: Мгновенно показываем из кеша (если есть)
    // Шаг 2: Фоном загружаем с сервера
    // Шаг 3: Если данные отличаются — обновляем страницу
    // ==========================================
    loadFolders: function() {
        var self = this;
        var container = document.getElementById('folders-container');

        // Пробуем загрузить из кеша
        var cached = self._loadFoldersFromCache();

        if (cached && cached.length > 0) {
            // Есть кеш — показываем мгновенно
            self.folders = cached;
            self.renderFolders();

            // Фоном тихо загружаем свежие данные
            api.getFolders().then(function(freshFolders) {
                // Сравниваем с кешем — изменилось ли что-то?
                if (self._foldersChanged(cached, freshFolders)) {
                    // Данные изменились — обновляем
                    self.folders = freshFolders;
                    self._saveFoldersToCache(freshFolders);
                    self.renderFolders();
                } else {
                    // Ничего не изменилось — просто обновляем временную метку кеша
                    self._saveFoldersToCache(freshFolders);
                }
            });
        } else {
            // Кеша нет — обычная загрузка с индикатором
            if (container) container.innerHTML = '<li class="loading">Загрузка папок...</li>';
            api.getFolders().then(function(folders) {
                self.folders = folders;
                self._saveFoldersToCache(folders);
                self.renderFolders();
            });
        }
    },

    // Сравниваем два списка папок — изменилось ли что-то важное
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
    // РЕНДЕР ПАПОК — не изменился
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
            var thumbUrl = 'https://photo-backend.belovolov-email.workers.dev/photo?id=' + folder.cover_url + '&size=thumb';
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
                '<button onclick="event.stopPropagation(); admin.renameFolder(\'' + folder.id + '\', \'' + folder.title.replace(/'/g, "\\'") + '\')" title="Переименовать">✏️</button>' +
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

        // Счётчик фото: для админа показываем полное число (включая скрытые)
        var photoCount = isAdmin
            ? (folder.photo_count_admin || folder.photo_count || 0)
            : (folder.photo_count || 0);

        return '<li id="folder-' + folder.id + '" class="t214__col t-item t-card__col t-col t-col_4 folder-card ' + hiddenClass + (isEditing ? ' editing' : '') + '" data-folder-id="' + folder.id + '">' +
            '<div class="folder-card__image" id="folder-image-' + folder.id + '" style="background-color:#eee;">' +
                '<div class="folder-card__title">' + folder.title + (photoCount > 0 ? ' <span style="font-size:13px;opacity:0.8;font-weight:400;">(' + photoCount + ' фото)</span>' : '') + '</div>' +
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
            // Сбрасываем кеш — обложка изменилась
            self.clearFoldersCache();
            self.loadFolders();
        });
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
    // Загружаем все фото папки за один запрос (после оптимизации KV структуры)
    loadPhotos: function(folderId) {
        var self = this;
        var container = document.getElementById('photos-container');

        if (container) container.innerHTML = '<div class="loading">Загрузка фото...</div>';
        self.currentPhotos = [];
        self.visiblePhotos = [];
        self.sections = [];

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
                    var folderName = (gallery.currentFolder && gallery.currentFolder.title) ? encodeURIComponent(gallery.currentFolder.title) : '';
                    allPhotos[i].originalUrl = 'https://photo-backend.belovolov-email.workers.dev/photo?id=' + allPhotos[i].file_id + '&size=original&folder=' + folderName;
                }

                if (container) container.innerHTML = '';
                self.renderPhotos(0);

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

    _buildDisplayOrder: function() {
        var self = this;
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
            '<img src="' + (photo.thumbUrl || '') + '" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover;">' +
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
    openFullscreen: function(index) {
        if (index < 0 || index >= this.visiblePhotos.length) return;

        this.currentPhotoIndex = index;
        var photo = this.visiblePhotos[index];
        var viewer = document.getElementById('fullscreen-viewer');
        var container = document.querySelector('.fullscreen-viewer__image-container');
        if (!viewer || !container) return;

        // Инициализируем два img-слоя если ещё нет
        if (!container.querySelector('#fv-img-a')) {
            container.innerHTML =
                '<img id="fv-img-a" class="fv-img-current" src="" alt="">' +
                '<img id="fv-img-b" src="" alt="" style="opacity:0;">';
        }

        var imgA = document.getElementById('fv-img-a');
        if (imgA) { imgA.src = photo.thumbUrl || ''; imgA.className = 'fv-img-current'; }
        var imgB = document.getElementById('fv-img-b');
        if (imgB) { imgB.src = ''; imgB.className = ''; imgB.style.opacity = '0'; }

        this._updateActionsPanel(photo);
        viewer.style.display = 'flex';
        this._animating = false;

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

    // Плавная смена фото: текущее уезжает, новое въезжает одновременно
    _changePhoto: function(newIndex, direction) {
        if (this._animating) return;
        if (newIndex < 0 || newIndex >= this.visiblePhotos.length) return;

        var self = this;
        var photo = this.visiblePhotos[newIndex];

        var imgA = document.getElementById('fv-img-a'); // текущее (видимое)
        var imgB = document.getElementById('fv-img-b'); // следующее (скрытое)
        if (!imgA || !imgB) { self.openFullscreen(newIndex); return; }

        this._animating = true;
        this.currentPhotoIndex = newIndex;

        // Загружаем новое фото в скрытый слой
        imgB.src = photo.thumbUrl || '';
        // Ставим начальную позицию для въезда (без transition)
        imgB.className = direction === 'left' ? 'fv-img-in-left' : 'fv-img-in-right';

        this._updateActionsPanel(photo);
        if (typeof lucide !== 'undefined') lucide.createIcons();

        // Запускаем анимацию в следующем кадре
        requestAnimationFrame(function() {
            requestAnimationFrame(function() {
                imgA.className = direction === 'left' ? 'fv-img-out-left' : 'fv-img-out-right';
                imgB.className = 'fv-img-current';

                setTimeout(function() {
                    // B стал текущим — переносим в A, сбрасываем B
                    imgA.src = imgB.src;
                    imgA.className = 'fv-img-current';
                    imgB.className = '';
                    imgB.style.opacity = '0';
                    imgB.src = '';
                    self._animating = false;
                }, 350);
            });
        });
    },



    _updateActionsPanel: function(photo) {
        var panel = document.getElementById('fullscreen-actions');
        if (!panel) return;
        var isAdmin = api.isAdmin();

        panel.innerHTML =
            (isAdmin ? '<button class="fv-action-btn" onclick="admin.setFolderCover()"><i data-lucide="image"></i><span>Обложка</span></button>' : '') +
            '<a id="download-link" class="fv-action-btn" href="' + (photo.originalUrl || '#') + '"><i data-lucide="download"></i><span>Скачать</span></a>' +
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
        this._changePhoto(this.currentPhotoIndex - 1, 'right');
    },

    nextPhoto: function() {
        this._changePhoto(this.currentPhotoIndex + 1, 'left');
    },

    initSwipe: function() {
        var self = this;
        var container = document.querySelector('.fullscreen-viewer__image-container');
        if (!container) return;

        var startX = 0, startY = 0;

        container.ontouchstart = function(e) {
            startX = e.changedTouches[0].screenX;
            startY = e.changedTouches[0].screenY;
        };

        container.ontouchmove = function(e) {
            var dx = Math.abs(e.changedTouches[0].screenX - startX);
            var dy = Math.abs(e.changedTouches[0].screenY - startY);
            if (dx > dy) e.preventDefault();
        };

        container.ontouchend = function(e) {
            var dx = e.changedTouches[0].screenX - startX;
            var dy = e.changedTouches[0].screenY - startY;
            if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40) {
                if (dx < 0) self._changePhoto(self.currentPhotoIndex + 1, 'left');
                else self._changePhoto(self.currentPhotoIndex - 1, 'right');
            }
        };
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
