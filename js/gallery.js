// gallery.js — показывает папки и фото (Google Drive версия)

var BATCH_SIZE = 40;

var gallery = {
    folders: [],
    currentPhotos: [],      // все фото текущей папки
    visiblePhotos: [],      // фото которые сейчас видны на странице
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

        // Загружаем обложки папок
        for (var k = 0; k < self.folders.length; k++) {
            self.loadFolderCover(self.folders[k]);
        }

        // Клики по папкам
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

        // Drag & drop для сортировки (только для админа на компьютере)
        if (api.isAdmin() && typeof Sortable !== 'undefined') {
            setTimeout(function() {
                if (typeof admin !== 'undefined') admin.initSortable();
            }, 100);
        }
    },

    // Загружаем обложку папки (первое фото или заданная обложка)
    loadFolderCover: function(folder) {
        var self = this;
        var imgEl = document.getElementById('folder-image-' + folder.id);
        if (!imgEl) return;

        // Если у папки есть заданная обложка
        if (folder.cover_url && folder.cover_url.startsWith('https://drive.google.com')) {
            // Уже есть прямая ссылка — применяем
            self.applyFolderCover(imgEl, folder.cover_url, folder);
            return;
        }

        if (folder.cover_url) {
            // cover_url содержит Google Drive file_id — строим ссылку на миниатюру
            var thumbUrl = 'https://drive.google.com/thumbnail?id=' + folder.cover_url + '&sz=w800';
            self.applyFolderCover(imgEl, thumbUrl, folder);
            return;
        }

        // Нет обложки — берём первое фото из папки
        api.getPhotosList(folder.id).then(function(photos) {
            if (photos.length > 0) {
                var thumbUrl = 'https://drive.google.com/thumbnail?id=' + photos[0].file_id + '&sz=w800';
                self.applyFolderCover(imgEl, thumbUrl, folder);
            }
        });
    },

    applyFolderCover: function(imgEl, url, folder) {
        var x = folder.cover_x !== undefined ? folder.cover_x : 50;
        var y = folder.cover_y !== undefined ? folder.cover_y : 50;
        var scale = folder.cover_scale !== undefined ? folder.cover_scale : 100;
        imgEl.style.backgroundImage = 'url(\'' + url + '\')';
        imgEl.style.backgroundPosition = x + '% ' + y + '%';
        imgEl.style.backgroundSize = scale + '%';
        imgEl.dataset.coverUrl = url;
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
                '<button class="preview-editor__btn zoom-in" onclick="gallery.zoomPreview(10)">+</button>' +
                '<button class="preview-editor__btn save" onclick="gallery.savePreview()">Сохранить</button>' +
                '</div>';
        }

        return '<li id="folder-' + folder.id + '" class="t214__col t-item t-card__col t-col t-col_4 folder-card ' + hiddenClass + (isEditing ? ' editing' : '') + '" data-folder-id="' + folder.id + '">' +
            '<div class="folder-card__image" id="folder-image-' + folder.id + '" style="background-color:#eee;">' +
                '<div class="folder-card__title">' + folder.title + '</div>' +
                adminActions +
                previewEditor +
            '</div>' +
        '</li>';
    },

    // === РЕДАКТОР ПОЛОЖЕНИЯ ОБЛОЖКИ ===
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

        // Восстанавливаем обложку в режиме редактирования
        var imgEl = document.getElementById('folder-image-' + folderId);
        if (imgEl) {
            if (folder.cover_url) {
                var thumbUrl = folder.cover_url.startsWith('http')
                    ? folder.cover_url
                    : 'https://drive.google.com/thumbnail?id=' + folder.cover_url + '&sz=w800';
                imgEl.style.backgroundImage = 'url(\'' + thumbUrl + '\')';
            } else {
                api.getPhotosList(folderId).then(function(photos) {
                    if (photos.length > 0) {
                        var url = 'https://drive.google.com/thumbnail?id=' + photos[0].file_id + '&sz=w800';
                        imgEl.style.backgroundImage = 'url(\'' + url + '\')';
                    }
                });
            }
            self.updatePreviewStyle(imgEl);
        }
    },

    updatePreviewStyle: function(imgEl) {
        if (!imgEl) {
            imgEl = document.getElementById('folder-image-' + this.editingFolder);
        }
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
        var coverUrl = imgEl ? (imgEl.dataset.coverUrl || null) : null;

        api.updateFolder(self.editingFolder, {
            cover_url: coverUrl,
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
        this.currentFolder = folder;
        this.currentPhotos = [];
        this.visiblePhotos = [];

        document.getElementById('main-page').style.display = 'none';
        document.getElementById('rec-cover').style.display = 'none';
        document.getElementById('folder-page').style.display = 'block';

        document.getElementById('folder-title-text').textContent = folder.title;

        // Обложка полосы вверху страницы папки
        var coverEl = document.getElementById('folder-cover-image');
        if (coverEl) {
            if (folder.cover_url) {
                var url = folder.cover_url.startsWith('http')
                    ? folder.cover_url
                    : 'https://drive.google.com/thumbnail?id=' + folder.cover_url + '&sz=w800';
                coverEl.style.backgroundImage = 'url(\'' + url + '\')';
            } else {
                coverEl.style.backgroundImage = 'none';
                coverEl.style.backgroundColor = '#eee';
            }
        }

        // Кнопки для администратора в боковой панели
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

            // Сначала показываем миниатюры (маленькие, загружаются быстро)
            api.getPhotosThumbnails(folderId, batch).then(function(thumbUrls) {
                // Добавляем URL в объекты фото
                for (var i = 0; i < batch.length; i++) {
                    batch[i].thumbUrl = thumbUrls[batch[i].id] || '';
                    // Оригинальный URL сформируем при открытии просмотра
                    batch[i].originalUrl = 'https://photo-backend.belovolov-email.workers.dev/photo?id=' + batch[i].file_id + '&size=original';
                }

                // Если это первая загрузка — очищаем контейнер
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
            var node = div.firstChild;
            grid.appendChild(node);
        }
    },

    createPhotoItem: function(photo, index) {
        var isAdmin = api.isAdmin();
        var hiddenClass = photo.hidden ? 'hidden-photo' : '';

        var adminActions = '';
        if (isAdmin) {
            adminActions =
                '<div class="photo-item__admin-actions" onclick="event.stopPropagation()">' +
                '<button onclick="event.stopPropagation(); admin.togglePhotoHidden(\'' + photo.id + '\', ' + !photo.hidden + ')" title="' + (photo.hidden ? 'Показать' : 'Скрыть') + '">' + (photo.hidden ? '👁' : '🙈') + '</button>' +
                '<button onclick="event.stopPropagation(); admin.deletePhoto(\'' + photo.id + '\')" title="Удалить">🗑️</button>' +
                '</div>';
        }

        var imgSrc = photo.thumbUrl || '';

        return '<div class="photo-item ' + hiddenClass + '" data-id="' + photo.id + '" data-index="' + index + '" onclick="gallery.handlePhotoClick(event, ' + index + ', \'' + photo.id + '\')">' +
            '<img src="' + imgSrc + '" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover;">' +
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

    // === ПОЛНОЭКРАННЫЙ ПРОСМОТР ===
    openFullscreen: function(index) {
        if (index < 0 || index >= this.visiblePhotos.length) return;

        this.currentPhotoIndex = index;
        var photo = this.visiblePhotos[index];

        var img = document.getElementById('fullscreen-image');
        var link = document.getElementById('download-link');
        var viewer = document.getElementById('fullscreen-viewer');

        var btnCover = document.getElementById('btn-set-cover');
        var btnDelete = document.getElementById('btn-delete-photo');
        if (btnCover) btnCover.style.display = api.isAdmin() ? 'inline-block' : 'none';
        if (btnDelete) btnDelete.style.display = api.isAdmin() ? 'inline-block' : 'none';

        // Для просмотра используем миниатюру (загружается быстро)
        // Для скачивания — оригинал
        if (img) img.src = photo.thumbUrl || '';
        if (link) {
            link.href = photo.originalUrl || '#';
            link.download = photo.name || 'photo.jpg';
        }
        if (viewer) viewer.style.display = 'flex';

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

    initSwipe: function() {
        var self = this;
        var imageContainer = document.querySelector('.fullscreen-viewer__image-container');
        if (!imageContainer) return;
        var startX = 0;
        imageContainer.ontouchstart = function(e) { startX = e.changedTouches[0].screenX; };
        imageContainer.ontouchend = function(e) {
            var diff = startX - e.changedTouches[0].screenX;
            if (Math.abs(diff) > 50) {
                if (diff > 0) self.nextPhoto();
                else self.prevPhoto();
            }
        };
    },

    closeFullscreen: function() {
        var viewer = document.getElementById('fullscreen-viewer');
        if (viewer) viewer.style.display = 'none';
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

    // === ВОЗВРАТ НА ГЛАВНУЮ ===
    showMainPage: function() {
        if (typeof admin !== 'undefined' && admin.isSelectionMode) {
            admin.exitSelectionMode();
        }
        document.getElementById('folder-page').style.display = 'none';
        document.getElementById('main-page').style.display = 'block';
        document.getElementById('rec-cover').style.display = 'block';
        this.currentFolder = null;
        window.location.hash = '';
        window.scrollTo(0, 0);
    }
};

document.addEventListener('DOMContentLoaded', function() {
    gallery.init();
});

function scrollToFolders() {
    var mainPage = document.getElementById('main-page');
    if (mainPage) mainPage.scrollIntoView({ behavior: 'smooth' });
}
