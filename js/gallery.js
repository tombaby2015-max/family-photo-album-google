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
        self._displayOrder = [];

        var items = document.querySelectorAll('#photos-container .photo-item');
        items.forEach(function(el) {
            var id = el.getAttribute('data-id');
            if (id) self._displayOrder.push(id);
        });
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

    // ОБЫЧНЫЙ РЕЖИМ
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

    // РЕЖИМ СЕКЦИЙ (только десктоп, только админ)
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
        var displayIndex = this._displayIndexById(photoId);
        if (displayIndex === -1) {
            for (var i = 0; i < this.visiblePhotos.length; i++) {
                if (this.visiblePhotos[i].id === photoId) { displayIndex = i; break; }
            }
        }
        this.openFullscreen(displayIndex);
    },

    // ============================================================
    // FULLSCREEN ПРОСМОТР — слайдер
    // Каждый слайд = 100vw, gap задаётся через padding на слайдах.
    // Это 100% надёжно без JS-измерений offsetWidth.
    // ============================================================
    _displayOrder: [],

    // Половина пробела с каждой стороны слайда = визуальный gap между фото
    _HALF_GAP: 15, // итоговый зазор = 30px

    _buildSliderDOM: function() {
        var self = this;
        var container = document.querySelector('.fullscreen-viewer__image-container');
        if (!container) return;
        container.innerHTML = '';

        // Враппер: overflow visible, ширина = 100%, flex
        var wrapper = document.createElement('div');
        wrapper.id = 'fv-slider-wrapper';
        wrapper.style.cssText = [
            'display:flex;',
            'width:100%;',
            'height:100%;',
            'will-change:transform;',
            'transition:transform 0.40s cubic-bezier(0.22,0.61,0.36,1);'
        ].join('');
        container.appendChild(wrapper);

        var hg = self._HALF_GAP;

        for (var i = 0; i < self._displayOrder.length; i++) {
            var photo = self._photoById(self._displayOrder[i]);
            var slide = document.createElement('div');
            slide.className = 'fv-slide';
            // Каждый слайд = 100vw (ширина вьюпорта), независимо от контейнера.
            // padding создаёт видимый зазор между фото.
            // Крайние слайды — только один отступ (внутренний).
            var pl = (i === 0) ? 0 : hg;
            var pr = (i === self._displayOrder.length - 1) ? 0 : hg;
            slide.style.cssText = [
                'flex-shrink:0;',
                'width:100vw;',
                'height:100%;',
                'display:flex;',
                'align-items:center;',
                'justify-content:center;',
                'box-sizing:border-box;',
                'padding-left:' + pl + 'px;',
                'padding-right:' + pr + 'px;'
            ].join('');

            var img = document.createElement('img');
            img.src = photo ? (photo.thumbUrl || '') : '';
            img.alt = '';
            img.draggable = false;
            img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;pointer-events:none;border-radius:4px;';
            slide.appendChild(img);
            wrapper.appendChild(slide);
        }
    },

    // Шаг = 100vw (каждый слайд ровно 100vw)
    _slideStep: function() {
        return window.innerWidth;
    },

    _sliderGoTo: function(index, animate) {
        var wrapper = document.getElementById('fv-slider-wrapper');
        if (!wrapper) return;
        wrapper.style.transition = animate
            ? 'transform 0.40s cubic-bezier(0.22,0.61,0.36,1)'
            : 'none';
        wrapper.style.transform = 'translateX(' + (-index * this._slideStep()) + 'px)';
    },

    openFullscreen: function(displayIndex) {
        if (!this._displayOrder || displayIndex < 0 || displayIndex >= this._displayOrder.length) return;

        this.currentPhotoIndex = displayIndex;
        var photo = this._photoById(this._displayOrder[displayIndex]);
        if (!photo) return;

        // Показываем viewer
        var viewer = document.getElementById('fullscreen-viewer');
        if (viewer) viewer.style.display = 'flex';

        this._buildSliderDOM();
        this._sliderGoTo(displayIndex, false);

        var actionsPanel = document.getElementById('fullscreen-actions');
        if (actionsPanel) {
            var isAdmin = api.isAdmin();
            actionsPanel.innerHTML =
                (isAdmin ?
                    '<button class="fv-action-btn" onclick="admin.setFolderCover()" title="Превью папки">' +
                    '<i data-lucide="image"></i><span>Обложка</span></button>' : '') +
                '<a id="download-link" class="fv-action-btn" href="' + (photo.originalUrl || '#') + '" download="' + (photo.name || 'photo.jpg') + '" title="Скачать оригинал">' +
                '<i data-lucide="download"></i><span>Скачать</span></a>' +
                (isAdmin ?
                    '<button class="fv-action-btn fv-action-btn--danger" onclick="admin.deleteCurrentPhoto()" title="Удалить">' +
                    '<i data-lucide="trash-2"></i><span>Удалить</span></button>' : '') +
                '<button class="fv-action-btn" onclick="gallery.closeFullscreen()" title="Закрыть">' +
                '<i data-lucide="x"></i><span>Закрыть</span></button>';
        }

        if (typeof lucide !== 'undefined') lucide.createIcons();

        var self = this;
        if (this.keyHandler) document.removeEventListener('keydown', this.keyHandler);
        this.keyHandler = function(e) {
            if (e.key === 'Escape') self.closeFullscreen();
            else if (e.key === 'ArrowLeft') self.prevPhoto();
            else if (e.key === 'ArrowRight') self.nextPhoto();
        };
        document.addEventListener('keydown', this.keyHandler);
        this._initSliderSwipe();
    },

    _changePhoto: function(newIndex) {
        if (!this._displayOrder || newIndex < 0 || newIndex >= this._displayOrder.length) return;
        this.currentPhotoIndex = newIndex;
        this._sliderGoTo(newIndex, true);
        var photo = this._photoById(this._displayOrder[newIndex]);
        var link = document.getElementById('download-link');
        if (link && photo) { link.href = photo.originalUrl || '#'; link.download = photo.name || 'photo.jpg'; }
    },

    _initSliderSwipe: function() {
        var self = this;
        var viewer = document.getElementById('fullscreen-viewer');
        if (!viewer) return;

        var startX = 0, startY = 0, isDragging = false, baseTranslate = 0;
        var movedX = 0; // FIX 2: отслеживаем реальное смещение для различия тап/свайп

        function getClientX(e) { return e.touches ? e.touches[0].clientX : e.clientX; }
        function getClientY(e) { return e.touches ? e.touches[0].clientY : e.clientY; }

        function onStart(e) {
            if (e.target.closest && (e.target.closest('.fullscreen-viewer__actions') || e.target.closest('.fullscreen-viewer__nav'))) return;
            startX = getClientX(e);
            startY = getClientY(e);
            movedX = 0;
            isDragging = true;
            var wrapper = document.getElementById('fv-slider-wrapper');
            if (wrapper) wrapper.style.transition = 'none';
            baseTranslate = -self.currentPhotoIndex * self._slideStep();
        }

        function onMove(e) {
            if (!isDragging) return;
            var dx = getClientX(e) - startX;
            var dy = getClientY(e) - startY;
            // Если движение вертикальное — отменяем свайп
            if (Math.abs(dy) > Math.abs(dx) && Math.abs(movedX) < 5) {
                isDragging = false;
                return;
            }
            e.preventDefault();
            movedX = dx;
            var wrapper = document.getElementById('fv-slider-wrapper');
            if (wrapper) wrapper.style.transform = 'translateX(' + (baseTranslate + dx) + 'px)';
        }

        function onEnd(e) {
            if (!isDragging) return;
            isDragging = false;

            var endX = e.changedTouches ? e.changedTouches[0].clientX : e.clientX;
            var dx = endX - startX;
            var step = self._slideStep();
            var newIndex = self.currentPhotoIndex;
            var maxIndex = self._displayOrder.length - 1;

            // Порог 25% ширины экрана для переключения
            if (dx < -step * 0.25 && newIndex < maxIndex) newIndex++;
            else if (dx > step * 0.25 && newIndex > 0) newIndex--;

            // Жёсткие границы — не выходим за пределы
            if (newIndex < 0) newIndex = 0;
            if (newIndex > maxIndex) newIndex = maxIndex;

            self._changePhoto(newIndex);
        }

        // FIX 2: Тап по краям — надёжная реализация через touchstart/touchend
        // (не через onclick, который ненадёжен на мобильных после свайпа)
        var tapStartX = 0, tapStartY = 0, tapStartTime = 0;

        function onTapStart(e) {
            if (e.target.closest && (e.target.closest('.fullscreen-viewer__actions') || e.target.closest('.fullscreen-viewer__nav'))) return;
            tapStartX = e.touches[0].clientX;
            tapStartY = e.touches[0].clientY;
            tapStartTime = Date.now();
        }

        function onTapEnd(e) {
            if (e.target.closest && (e.target.closest('.fullscreen-viewer__actions') || e.target.closest('.fullscreen-viewer__nav'))) return;

            var dt = Date.now() - tapStartTime;
            var dx = Math.abs(e.changedTouches[0].clientX - tapStartX);
            var dy = Math.abs(e.changedTouches[0].clientY - tapStartY);

            // Это тап: короткий (< 300мс), без движения (< 15px)
            if (dt < 300 && dx < 15 && dy < 15) {
                var rect = viewer.getBoundingClientRect();
                var tapX = e.changedTouches[0].clientX - rect.left;
                var zone = rect.width * 0.25; // 25% с каждого края

                if (tapX < zone) {
                    self.prevPhoto();
                } else if (tapX > rect.width - zone) {
                    self.nextPhoto();
                }
                // Центр экрана — не делаем ничего (закрытие убрано, т.к. мешает просмотру)
            }
        }

        // Mouse события (десктоп)
        viewer.onmousedown = onStart;
        viewer.onmousemove = onMove;
        viewer.onmouseup = onEnd;
        viewer.onmouseleave = onEnd;

        // Touch события (мобильные) — свайп
        viewer.ontouchstart = onStart;
        viewer.ontouchmove = onMove;
        viewer.ontouchend = onEnd;
        viewer.ontouchcancel = onEnd;

        // FIX 2: Отдельные обработчики для тапа на мобильных
        viewer.addEventListener('touchstart', onTapStart, { passive: true });
        viewer.addEventListener('touchend', onTapEnd, { passive: true });

        // Пересчёт при повороте/ресайзе — слайды 100vw, просто пересчитываем позицию
        window.onresize = function() {
            self._sliderGoTo(self.currentPhotoIndex, false);
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
        if (this.currentPhotoIndex > 0)
            this._changePhoto(this.currentPhotoIndex - 1);
    },

    nextPhoto: function() {
        if (this._displayOrder && this.currentPhotoIndex < this._displayOrder.length - 1)
            this._changePhoto(this.currentPhotoIndex + 1);
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
});

function scrollToFolders() {
    var mainPage = document.getElementById('main-page');
    if (mainPage) mainPage.scrollIntoView({ behavior: 'smooth' });
}
