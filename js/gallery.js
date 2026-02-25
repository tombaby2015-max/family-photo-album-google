// gallery.js — показывает папки и фото (Google Drive версия)

var BATCH_SIZE = 40;

var gallery = {
    folders: [],
    currentPhotos: [],
    visiblePhotos: [],
    currentFolder: null,
    currentPhotoIndex: 0,
    editingFolder: null,
    previewState: { x: 50, y: 50, scale: 100 },
    keyHandler: null,

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
            self.renderFolders();
            var folder = null;
            for (var i = 0; i < folders.length; i++) {
                if (folders[i].id === folderId) { folder = folders[i]; break; }
            }
            if (folder) self.openFolder(folder, false);
            else self.showMainPage();
        });
    },

    loadFolders: function() {
        var self = this;
        var container = document.getElementById('folders-container');
        if (container) container.innerHTML = '<li class="loading">Загрузка папок...</li>';
        api.getFolders().then(function(folders) {
            self.folders = folders;
            self.renderFolders();
        });
    },

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

    // Обложка папки — только если задана вручную, иначе серый фон
    loadFolderCover: function(folder) {
        var self = this;
        var imgEl = document.getElementById('folder-image-' + folder.id);
        if (!imgEl) return;

        if (folder.cover_url) {
            var thumbUrl = 'https://photo-backend.belovolov-email.workers.dev/photo?id=' + folder.cover_url + '&size=thumb';
            self.applyFolderCover(imgEl, thumbUrl, folder);
        }
        // Нет обложки — оставляем серый фон, ничего не делаем
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

        // FIX #7: кнопки − Сохранить + симметрично
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

        return '<li id="folder-' + folder.id + '" class="t214__col t-item t-card__col t-col t-col_4 folder-card ' + hiddenClass + (isEditing ? ' editing' : '') + '" data-folder-id="' + folder.id + '">' +
            '<div class="folder-card__image" id="folder-image-' + folder.id + '" style="background-color:#eee;">' +
                '<div class="folder-card__title">' + folder.title + (folder.photo_count > 0 ? ' <span style="font-size:13px;opacity:0.8;font-weight:400;">(' + folder.photo_count + ' фото)</span>' : '') + '</div>' +
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

    // FIX #4: сохраняем file_id, убираем alert
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
            self.loadFolders();
        });
    },

    // === ОТКРЫТИЕ ПАПКИ ===
    openFolder: function(folder, pushState) {
        this._lastFolderId = folder.id; // FIX #1: запоминаем для возврата

        this.currentFolder = folder;
        this.currentPhotos = [];
        this.visiblePhotos = [];

        document.getElementById('main-page').style.display = 'none';
        document.getElementById('rec-cover').style.display = 'none';
        document.getElementById('folder-page').style.display = 'block';

        document.getElementById('folder-title-text').textContent = folder.title;

        // Полоска вверху — всегда главное фото сайта
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

        window.scrollTo(0, 0);

        if (pushState !== false) {
            window.location.hash = 'folder=' + folder.id;
        }

        this.loadPhotos(folder.id, 0);
    },

    // === ЗАГРУЗКА ФОТО ===
    loadPhotos: function(folderId, offset) {
        var self = this;
        var container = document.getElementById('photos-container');

        if (offset === 0) {
            if (container) container.innerHTML = '<div class="loading">Загрузка фото...</div>';
            self.currentPhotos = [];
            self.visiblePhotos = [];
        }

        api.getPhotosList(folderId).then(function(allPhotos) {
            self.currentPhotos = allPhotos;

            var batch = allPhotos.slice(offset, offset + BATCH_SIZE);
            if (batch.length === 0) {
                if (offset === 0 && container) {
                    container.innerHTML = '<div class="empty-state"><h4>В этой папке пока нет фото</h4></div>';
                }
                return;
            }

            api.getPhotosThumbnails(folderId, batch).then(function(thumbUrls) {
                for (var i = 0; i < batch.length; i++) {
                    batch[i].thumbUrl = thumbUrls[batch[i].id] || '';
                    batch[i].originalUrl = 'https://photo-backend.belovolov-email.workers.dev/photo?id=' + batch[i].file_id + '&size=original';
                }

                if (offset === 0 && container) {
                    container.innerHTML = '';
                } else {
                    var oldBtn = document.getElementById('load-more-container');
                    if (oldBtn) oldBtn.remove();
                }

                for (var j = 0; j < batch.length; j++) {
                    self.visiblePhotos.push(batch[j]);
                }

                self.renderPhotos(offset);

                if (offset + BATCH_SIZE < allPhotos.length) {
                    self.showLoadMoreButton(folderId, offset + BATCH_SIZE, allPhotos);
                }
            });
        }).catch(function() {
            if (offset === 0 && container) {
                container.innerHTML = '<p>Ошибка загрузки</p>';
            }
        });
    },

    showLoadMoreButton: function(folderId, nextOffset, allPhotos) {
        var self = this;
        var container = document.getElementById('photos-container');
        if (!container) return;

        var div = document.createElement('div');
        div.id = 'load-more-container';
        div.style.cssText = 'grid-column:1/-1;text-align:center;padding:20px;';
        div.innerHTML = '<button id="load-more-btn" style="padding:15px 30px;background:rgba(0,0,0,0.05);border:none;border-radius:8px;cursor:pointer;color:#666;font-size:16px;">+ Загрузить ещё фото</button>';
        container.appendChild(div);

        document.getElementById('load-more-btn').onclick = function() {
            this.textContent = 'Загружается...';
            self.loadPhotos(folderId, nextOffset);
        };
    },

    renderPhotos: function(fromIndex) {
        var self = this;
        var grid = document.getElementById('photos-container');
        if (!grid) return;

        var start = fromIndex || 0;
        for (var i = start; i < self.visiblePhotos.length; i++) {
            var item = self.createPhotoItem(self.visiblePhotos[i], i);
            var div = document.createElement('div');
            div.innerHTML = item;
            grid.appendChild(div.firstChild);
        }
    },

    createPhotoItem: function(photo, index) {
        var isAdmin = api.isAdmin();
        var hiddenClass = photo.hidden ? 'hidden-photo' : '';

        var adminActions = '';
        if (isAdmin) {
            // FIX #5: храним актуальное состояние hidden в data-атрибуте элемента
            adminActions =
                '<div class="photo-item__admin-actions" onclick="event.stopPropagation()">' +
                '<button onclick="event.stopPropagation(); admin.togglePhotoHidden(\'' + photo.id + '\')" title="' + (photo.hidden ? 'Показать' : 'Скрыть') + '">' + (photo.hidden ? '👁' : '🙈') + '</button>' +
                '<button onclick="event.stopPropagation(); admin.deletePhoto(\'' + photo.id + '\')" title="Удалить">🗑️</button>' +
                '</div>';
        }

        return '<div class="photo-item ' + hiddenClass + '" data-id="' + photo.id + '" data-hidden="' + (photo.hidden ? '1' : '0') + '" data-index="' + index + '" onclick="gallery.handlePhotoClick(event, ' + index + ', \'' + photo.id + '\')">' +
            '<img src="' + (photo.thumbUrl || '') + '" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover;">' +
            adminActions +
        '</div>';
    },

    handlePhotoClick: function(e, index, photoId) {
        if (typeof admin !== 'undefined' && admin.isSelectionMode) {
            e.stopPropagation();
            var checkbox = e.currentTarget.querySelector('.photo-checkbox-custom');
            if (checkbox) admin.togglePhotoSelection(photoId, checkbox);
            return;
        }
        this.openFullscreen(index);
    },

    // === FULLSCREEN ПРОСМОТР ===
    _animating: false,

    openFullscreen: function(index) {
        if (index < 0 || index >= this.visiblePhotos.length) return;

        this.currentPhotoIndex = index;
        var photo = this.visiblePhotos[index];
        var viewer = document.getElementById('fullscreen-viewer');
        var container = document.querySelector('.fullscreen-viewer__image-container');

        // Инициализируем два img-элемента если ещё нет
        if (container && !container.querySelector('#fv-img-a')) {
            container.innerHTML =
                '<img id="fv-img-a" class="fv-img-current" src="" alt="">' +
                '<img id="fv-img-b" src="" alt="" style="opacity:0;">';
        }

        var imgA = document.getElementById('fv-img-a');
        if (imgA) {
            imgA.src = photo.thumbUrl || '';
            imgA.className = 'fv-img-current';
        }
        var imgB = document.getElementById('fv-img-b');
        if (imgB) { imgB.src = ''; imgB.className = ''; imgB.style.opacity = '0'; }

        var link = document.getElementById('download-link');
        if (link) { link.href = photo.originalUrl || '#'; link.download = photo.name || 'photo.jpg'; }

        // Admin кнопки через класс
        var btnCover = document.getElementById('btn-set-cover');
        var btnDelete = document.getElementById('btn-delete-photo');
        if (api.isAdmin()) {
            if (btnCover) btnCover.classList.remove('fv-action-btn--admin-only');
            if (btnDelete) btnDelete.classList.remove('fv-action-btn--admin-only');
        } else {
            if (btnCover) btnCover.classList.add('fv-action-btn--admin-only');
            if (btnDelete) btnDelete.classList.add('fv-action-btn--admin-only');
        }

        if (viewer) viewer.style.display = 'flex';
        this._animating = false;

        // Инициализируем иконки Lucide после показа viewer
        if (typeof lucide !== 'undefined') lucide.createIcons();

        var self = this;
        if (this.keyHandler) document.removeEventListener('keydown', this.keyHandler);
        this.keyHandler = function(e) {
            if (e.key === 'Escape') self.closeFullscreen();
            else if (e.key === 'ArrowLeft') self.prevPhoto();
            else if (e.key === 'ArrowRight') self.nextPhoto();
        };
        document.addEventListener('keydown', this.keyHandler);
        this.initSwipe();
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

        // Обновляем ссылку скачивания
        var link = document.getElementById('download-link');
        if (link) { link.href = photo.originalUrl || '#'; link.download = photo.name || 'photo.jpg'; }

        // Запускаем анимацию в следующем кадре
        requestAnimationFrame(function() {
            requestAnimationFrame(function() {
                // Текущее уезжает
                imgA.className = direction === 'left' ? 'fv-img-out-left' : 'fv-img-out-right';
                // Новое въезжает
                imgB.className = 'fv-img-current';

                setTimeout(function() {
                    // Меняем местами: B становится новым текущим A
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
        if (this.currentPhotoIndex > 0) this.openFullscreen(this.currentPhotoIndex - 1);
    },

    nextPhoto: function() {
        if (this.currentPhotoIndex < this.visiblePhotos.length - 1) this.openFullscreen(this.currentPhotoIndex + 1);
    },

    // FIX #1: возвращаемся к нужной папке
    showMainPage: function() {
        if (typeof admin !== 'undefined' && admin.isSelectionMode) {
            admin.exitSelectionMode();
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
});

function scrollToFolders() {
    var mainPage = document.getElementById('main-page');
    if (mainPage) mainPage.scrollIntoView({ behavior: 'smooth' });
}
