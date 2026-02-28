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
                '<button class="preview-editor__btn cancel" onclick="gallery.cancelPreview()">✕</button>' +
                '</div>';
        }

        return '<li id="folder-' + folder.id + '" class="folder-card ' + hiddenClass + (isEditing ? ' editing' : '') + '">' +
            '<div class="folder-card__image" id="folder-image-' + folder.id + '"></div>' +
            '<div class="folder-card__title">' + folder.title + ' <span>(' + folder.photo_count + ')</span></div>' +
            adminActions + previewEditor +
            '</li>';
    },

    startEditPreview: function(folderId) {
        var self = this;
        var folder = null;
        for (var i = 0; i < this.folders.length; i++) {
            if (this.folders[i].id === folderId) { folder = this.folders[i]; break; }
        }
        if (!folder) return;

        var imgEl = document.getElementById('folder-image-' + folderId);
        if (!imgEl || !imgEl.dataset.fileId) return alert('Обложка не установлена');

        var fileId = imgEl.dataset.fileId;
        var url = 'https://photo-backend.belovolov-email.workers.dev/photo?id=' + fileId + '&size=full';

        var img = new Image();
        img.onload = function() {
            self.editingFolder = folderId;
            self.previewState.x = folder.cover_x || 50;
            self.previewState.y = folder.cover_y || 50;
            self.previewState.scale = folder.cover_scale || 100;
            self.previewState.imgUrl = url;
            self.renderFolders();
        };
        img.src = url;
    },

    movePreview: function(dx, dy) {
        this.previewState.x = Math.max(0, Math.min(100, this.previewState.x + dx));
        this.previewState.y = Math.max(0, Math.min(100, this.previewState.y + dy));
        this._applyPreviewEdit();
    },

    zoomPreview: function(ds) {
        this.previewState.scale = Math.max(100, this.previewState.scale + ds);
        this._applyPreviewEdit();
    },

    _applyPreviewEdit: function() {
        var imgEl = document.getElementById('folder-image-' + this.editingFolder);
        if (!imgEl) return;
        imgEl.style.backgroundImage = 'url(\'' + this.previewState.imgUrl + '\')';
        imgEl.style.backgroundPosition = this.previewState.x + '% ' + this.previewState.y + '%';
        imgEl.style.backgroundSize = this.previewState.scale + '%';
    },

    savePreview: function() {
        var folderId = this.editingFolder;
        api.updateFolder(folderId, {
            cover_x: this.previewState.x,
            cover_y: this.previewState.y,
            cover_scale: this.previewState.scale
        }).then(function(result) {
            if (result) {
                for (var i = 0; i < gallery.folders.length; i++) {
                    if (gallery.folders[i].id === folderId) {
                        gallery.folders[i].cover_x = gallery.previewState.x;
                        gallery.folders[i].cover_y = gallery.previewState.y;
                        gallery.folders[i].cover_scale = gallery.previewState.scale;
                        break;
                    }
                }
                gallery.editingFolder = null;
                gallery.renderFolders();
            } else {
                alert('Ошибка сохранения');
            }
        });
    },

    cancelPreview: function() {
        this.editingFolder = null;
        this.renderFolders();
    },

    // ==========================================
    // ОТКРЫТИЕ ПАПКИ
    // ==========================================
    openFolder: function(folder, scrollToLast) {
        var self = this;
        this.currentFolder = folder;
        this.sections = [];
        this.sectionModeActive = false;
        this.visiblePhotos = [];
        this.currentPhotos = [];

        document.getElementById('main-page').style.display = 'none';
        document.getElementById('rec-cover').style.display = 'none';

        var fp = document.getElementById('folder-page');
        if (fp) {
            fp.style.display = 'block';
            fp.classList.remove('section-mode');
        }

        var title = document.getElementById('folder-title-text');
        if (title) title.textContent = folder.title;

        var cover = document.getElementById('folder-cover-image');
        if (cover) {
            if (folder.cover_url) {
                var thumbUrl = 'https://photo-backend.belovolov-email.workers.dev/photo?id=' + folder.cover_url + '&size=thumb';
                cover.style.backgroundImage = 'url(\'' + thumbUrl + '\')';
                cover.style.backgroundPosition = (folder.cover_x || 50) + '% ' + (folder.cover_y || 50) + '%';
                cover.style.backgroundSize = (folder.cover_scale || 100) + '%';
            } else {
                cover.style.backgroundImage = '';
            }
        }

        var sidebarBtns = document.getElementById('sidebar-admin-buttons');
        if (sidebarBtns) sidebarBtns.style.display = api.isAdmin() ? 'flex' : 'none';

        var container = document.getElementById('photos-container');
        if (container) container.innerHTML = '<div class="loading">Загрузка фото...</div>';

        window.location.hash = 'folder=' + folder.id;

        api.getSections(folder.id).then(function(sections) {
            self.sections = sections;
            return api.getPhotosList(folder.id);
        }).then(function(photos) {
            self.currentPhotos = photos;
            self.visiblePhotos = photos.filter(function(p) { return !p.hidden || api.isAdmin(); });
            self.renderPhotos(0);
            if (scrollToLast) {
                setTimeout(function() {
                    var lastPhoto = document.querySelector('.photo-item:last-child');
                    if (lastPhoto) lastPhoto.scrollIntoView({ behavior: 'smooth' });
                }, 100);
            }
        });
    },

    // ==========================================
    // РЕНДЕР ФОТО
    // ==========================================
    renderPhotos: function(startIndex) {
        var self = this;
        var container = document.getElementById('photos-container');
        if (!container) return;

        var html = '';
        if (this.sectionModeActive) {
            html += this._renderSections();
        } else {
            html += '<div class="photos-grid" id="photos-grid">';
            for (var i = startIndex; i < Math.min(startIndex + 40, this.visiblePhotos.length); i++) {
                html += this.createPhotoItem(this.visiblePhotos[i], i);
            }
            html += '</div>';
        }

        container.innerHTML = html;

        if (this.sectionModeActive) {
            this.sections.forEach(function(section) {
                var header = document.getElementById('section-header-' + section.id);
                if (header) {
                    header.onclick = function() {
                        admin.editSection(section.id, section.title);
                    };
                }
            });
            this._assignPhotosToSections();
            this._updateUnsectionedVisibility();
            if (api.isAdmin()) setTimeout(function() { admin.initSectionsSortable(); admin.initPhotosSortable(); }, 100);
        } else {
            if (api.isAdmin()) setTimeout(function() { admin.initPhotosSortable(); }, 100);
        }

        if (startIndex + 40 < this.visiblePhotos.length) {
            var loadMore = document.createElement('button');
            loadMore.textContent = 'Загрузить ещё';
            loadMore.onclick = function() { self.renderPhotos(startIndex + 40); };
            container.appendChild(loadMore);
        }
    },

    _renderSections: function() {
        var html = '<div id="unsectioned-wrap" class="photos-section-block"><h3 id="unsectioned-header">Без секции</h3><div id="unsectioned-grid" class="photos-grid"></div></div>';
        this.sections.forEach(function(section) {
            html += '<div class="photos-section-block" data-section-id="' + section.id + '">' +
                '<h3 id="section-header-' + section.id + '">' + section.title + '</h3>' +
                '<div id="section-grid-' + section.id + '" class="photos-grid"></div>' +
                '</div>';
        });
        return html;
    },

    _assignPhotosToSections: function() {
        var self = this;
        this.visiblePhotos.forEach(function(photo, index) {
            var grid = self._getPhotoGrid(photo);
            if (grid) {
                grid.innerHTML += self.createPhotoItem(photo, index);
            }
        });
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
    // Анимация: два img (fv-img-a = текущее, fv-img-b = новое).
    // При смене: текущее уезжает влево/вправо, новое въезжает с другой стороны.

    openFullscreen: function(index) {
        if (index < 0 || index >= this.visiblePhotos.length) return;
        this.currentPhotoIndex = index;
        this._animating = false;

        var viewer = document.getElementById('fullscreen-viewer');
        var container = document.querySelector('.fullscreen-viewer__image-container');
        if (!viewer || !container) return;

        // Создаём два слоя один раз
        if (!document.getElementById('fv-img-a')) {
            container.innerHTML =
                '<img id="fv-img-a" style="position:absolute;max-width:100%;max-height:100%;object-fit:contain;border-radius:4px;transition:transform 0.32s cubic-bezier(.4,0,.2,1),opacity 0.32s ease;will-change:transform,opacity;" src="" alt="">' +
                '<img id="fv-img-b" style="position:absolute;max-width:100%;max-height:100%;object-fit:contain;border-radius:4px;transition:transform 0.32s cubic-bezier(.4,0,.2,1),opacity 0.32s ease;will-change:transform,opacity;opacity:0;transform:translateX(100%);" src="" alt="">';
        }

        var imgA = document.getElementById('fv-img-a');
        var imgB = document.getElementById('fv-img-b');
        imgA.src = this.visiblePhotos[index].thumbUrl || '';
        imgA.style.transform = 'translateX(0)';
        imgA.style.opacity = '1';
        imgB.src = '';
        imgB.style.transform = 'translateX(100%)';
        imgB.style.opacity = '0';

        this._updateActionsPanel(this.visiblePhotos[index]);
        viewer.style.display = 'flex';
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
        var imgA = document.getElementById('fv-img-a');
        var imgB = document.getElementById('fv-img-b');
        if (!imgA || !imgB) { self.openFullscreen(newIndex); return; }

        this._animating = true;
        this.currentPhotoIndex = newIndex;

        // direction: 'left' — листаем вперёд, 'right' — назад
        var enterFrom = direction === 'left' ? 'translateX(100%)' : 'translateX(-100%)';
        var exitTo    = direction === 'left' ? 'translateX(-100%)' : 'translateX(100%)';

        // Ставим B за краем экрана (без transition)
        imgB.style.transition = 'none';
        imgB.style.transform = enterFrom;
        imgB.style.opacity = '1';
        imgB.src = self.visiblePhotos[newIndex].thumbUrl || '';

        // Следующий кадр — запускаем анимацию
        requestAnimationFrame(function() {
            requestAnimationFrame(function() {
                imgA.style.transform = exitTo;
                imgA.style.opacity = '0';
                imgB.style.transition = 'transform 0.32s cubic-bezier(.4,0,.2,1), opacity 0.32s ease';
                imgB.style.transform = 'translateX(0)';
                imgB.style.opacity = '1';

                setTimeout(function() {
                    // Меняем местами: B становится новым A
                    imgA.src = imgB.src;
                    imgA.style.transition = 'none';
                    imgA.style.transform = 'translateX(0)';
                    imgA.style.opacity = '1';
                    imgB.style.transition = 'none';
                    imgB.style.transform = 'translateX(100%)';
                    imgB.style.opacity = '0';
                    imgB.src = '';

                    self._updateActionsPanel(self.visiblePhotos[newIndex]);
                    if (typeof lucide !== 'undefined') lucide.createIcons();
                    self._animating = false;
                }, 340);
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

        var startX = 0, startY = 0;

        viewer.addEventListener('touchstart', function(e) {
            if (e.target.closest('.fullscreen-viewer__actions') || e.target.closest('.fullscreen-viewer__nav')) return;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
        }, { passive: true });

        viewer.addEventListener('touchend', function(e) {
            if (e.target.closest('.fullscreen-viewer__actions') || e.target.closest('.fullscreen-viewer__nav')) return;
            var dx = e.changedTouches[0].clientX - startX;
            var dy = e.changedTouches[0].clientY - startY;
            if (Math.abs(dy) > Math.abs(dx)) return;
            if (dx < -50) self.nextPhoto();  // Свайп влево — вперёд
            else if (dx > 50) self.prevPhoto();  // Свайп вправо — назад
            else {
                // Логика тапа (нажатия) на края фото — только в мобильной версии (max-width: 768px)
                if (window.matchMedia('(max-width: 768px)').matches) {
                    var viewerWidth = viewer.clientWidth;
                    var tapX = e.changedTouches[0].clientX;
                    if (tapX < viewerWidth / 2) {
                        self.prevPhoto();  // Тап слева — назад
                    } else {
                        self.nextPhoto();  // Тап справа — вперёд
                    }
                }
            }
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
