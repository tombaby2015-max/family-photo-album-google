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
    sections: [],
    sectionModeActive: false,

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
        this._lastFolderId = folder.id;

        this.currentFolder = folder;
        this.currentPhotos = [];
        this.visiblePhotos = [];
        // Всегда начинаем в обычном виде — режим секций не включается автоматически
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

        // Сброс кнопок режима секций в исходное состояние
        this._resetSectionModeButtons();

        window.scrollTo(0, 0);

        if (pushState !== false) {
            window.location.hash = 'folder=' + folder.id;
        }

        this.loadPhotos(folder.id, 0);
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
    loadPhotos: function(folderId, offset) {
        var self = this;
        var container = document.getElementById('photos-container');

        if (offset === 0) {
            if (container) container.innerHTML = '<div class="loading">Загрузка фото...</div>';
            self.currentPhotos = [];
            self.visiblePhotos = [];
            self.sections = [];
        }

        Promise.all([
            api.getPhotosList(folderId),
            api.getSections(folderId)
        ]).then(function(results) {
            var allPhotos = results[0];
            self.sections = results[1] || [];
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

                // Если режим секций активен — инициализируем сортировку
                if (api.isAdmin() && self.sectionModeActive) {
                    setTimeout(function() {
                        if (typeof admin !== 'undefined') admin.initPhotosSortable();
                    }, 100);
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
        div.style.cssText = 'text-align:center;padding:20px;';
        div.innerHTML = '<button id="load-more-btn" style="padding:15px 30px;background:rgba(0,0,0,0.05);border:none;border-radius:8px;cursor:pointer;color:#666;font-size:16px;">+ Загрузить ещё фото</button>';
        container.appendChild(div);

        document.getElementById('load-more-btn').onclick = function() {
            this.textContent = 'Загружается...';
            self.loadPhotos(folderId, nextOffset);
        };
    },

    // === РЕНДЕР ФОТО ===
    // Единый метод — решает что показывать в зависимости от режима
    renderPhotos: function(fromIndex) {
        var self = this;
        var container = document.getElementById('photos-container');
        if (!container) return;

        if (!fromIndex || fromIndex === 0) {
            container.innerHTML = '';

            if (self.sectionModeActive && api.isAdmin()) {
                // РЕЖИМ СЕКЦИЙ: два блока (только десктоп, только админ)
                self._renderSectionMode(container);
            } else {
                // ОБЫЧНЫЙ РЕЖИМ: единая прокручиваемая страница
                // Нераспределённые фото сверху, затем секции с разделителями
                self._renderNormalMode(container);
            }
        } else {
            // Дозагрузка фото
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
    },

    // ОБЫЧНЫЙ РЕЖИМ (и гостевой, и админ без режима секций)
    _renderNormalMode: function(container) {
        var self = this;
        var sections = self.sections || [];

        // Разбиваем фото по секциям
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

        // Нераспределённые фото — сверху сеткой
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

        // Секции с разделителями
        for (var k = 0; k < sections.length; k++) {
            var section = sections[k];
            var sectionPhotos = bySection[section.id] || [];

            var sectionBlock = document.createElement('div');
            sectionBlock.className = 'photos-section-block';
            sectionBlock.id = 'section-block-' + section.id;

            // Разделитель с названием
            var headerHtml =
                '<div class="photos-section-header">' +
                '<div class="photos-section-line"></div>' +
                '<span class="photos-section-title" id="section-title-' + section.id + '">' + section.title + '</span>' +
                '<div class="photos-section-line"></div>';

            // Кнопки редактирования секции — только для админа
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

    // РЕЖИМ СЕКЦИЙ: два блока с независимым скроллом (только десктоп, только админ)
    _renderSectionMode: function(container) {
        var self = this;
        var sections = self.sections || [];

        // Разбиваем фото по секциям
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

        // --- ВЕРХНИЙ БЛОК: нераспределённые фото ---
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

        // --- НИЖНИЙ БЛОК: секции ---
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

        // Если секций нет — показываем подсказку
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

        // Кнопки "Обложка" и "Удалить" — только для админа, гости не видят
        var btnCover = document.getElementById('btn-set-cover');
        var btnDelete = document.getElementById('btn-delete-photo');
        if (api.isAdmin()) {
            if (btnCover) btnCover.style.display = '';
            if (btnDelete) btnDelete.style.display = '';
        } else {
            if (btnCover) btnCover.style.display = 'none';
            if (btnDelete) btnDelete.style.display = 'none';
        }

        if (viewer) viewer.style.display = 'flex';
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
        this.initSwipe();
    },

    _changePhoto: function(newIndex, direction) {
        if (this._animating) return;
        if (newIndex < 0 || newIndex >= this.visiblePhotos.length) return;

        var self = this;
        var photo = this.visiblePhotos[newIndex];

        var imgA = document.getElementById('fv-img-a');
        var imgB = document.getElementById('fv-img-b');
        if (!imgA || !imgB) { self.openFullscreen(newIndex); return; }

        this._animating = true;
        this.currentPhotoIndex = newIndex;

        imgB.src = photo.thumbUrl || '';
        imgB.className = direction === 'left' ? 'fv-img-in-left' : 'fv-img-in-right';

        var link = document.getElementById('download-link');
        if (link) { link.href = photo.originalUrl || '#'; link.download = photo.name || 'photo.jpg'; }

        requestAnimationFrame(function() {
            requestAnimationFrame(function() {
                imgA.className = direction === 'left' ? 'fv-img-out-left' : 'fv-img-out-right';
                imgB.className = 'fv-img-current';

                setTimeout(function() {
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
        if (this.currentPhotoIndex > 0) this._changePhoto(this.currentPhotoIndex - 1, 'right');
    },

    nextPhoto: function() {
        if (this.currentPhotoIndex < this.visiblePhotos.length - 1) this._changePhoto(this.currentPhotoIndex + 1, 'left');
    },

    showMainPage: function() {
        if (typeof admin !== 'undefined' && admin.isSelectionMode) {
            admin.exitSelectionMode();
        }

        // Выходим из режима секций
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
});

function scrollToFolders() {
    var mainPage = document.getElementById('main-page');
    if (mainPage) mainPage.scrollIntoView({ behavior: 'smooth' });
}
