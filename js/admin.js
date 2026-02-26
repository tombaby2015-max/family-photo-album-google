// admin.js — панель администратора (Google Drive версия) 

var admin = {
    inactivityTimer: null,
    inactivityTimeout: 15 * 60 * 1000,
    isAdminActive: false,
    isSelectionMode: false,
    selectedPhotos: [],

    // === ВХОД И ВЫХОД ===
    openModal: function() {
        var modal = document.getElementById('admin-modal');
        var input = document.getElementById('admin-password');
        var err = document.getElementById('admin-error');
        if (modal) modal.style.display = 'flex';
        if (input) { input.value = ''; input.focus(); }
        if (err) err.textContent = '';
    },

    closeModal: function() {
        var modal = document.getElementById('admin-modal');
        if (modal) modal.style.display = 'none';
    },

    login: function() {
        var input = document.getElementById('admin-password');
        var err = document.getElementById('admin-error');
        if (!input || !input.value) {
            if (err) err.textContent = 'Введите пароль';
            return;
        }
        var self = this;
        api.login(input.value).then(function(result) {
            if (result.success) {
                self.closeModal();
                self.showAdminUI();
                self.startInactivityTimer();
                gallery.loadFolders();
            } else {
                if (err) err.textContent = result.error || 'Ошибка входа';
            }
        }).catch(function() {
            if (err) err.textContent = 'Ошибка соединения';
        });
    },

    logout: function() {
        api.logout();
        this.hideAdminUI();
        this.stopInactivityTimer();
        location.reload();
    },

    showAdminUI: function() {
        var panel = document.getElementById('admin-panel');
        var sidebar = document.getElementById('sidebar-admin-buttons');
        if (panel) panel.style.display = 'block';
        if (sidebar && gallery.currentFolder) sidebar.style.display = 'flex';
        this.isAdminActive = true;
        gallery.loadFolders();
    },

    hideAdminUI: function() {
        var panel = document.getElementById('admin-panel');
        var sidebar = document.getElementById('sidebar-admin-buttons');
        if (panel) panel.style.display = 'none';
        if (sidebar) sidebar.style.display = 'none';
        this.isAdminActive = false;

        if (gallery.sectionModeActive) {
            gallery.sectionModeActive = false;
            var fp = document.getElementById('folder-page');
            if (fp) fp.classList.remove('section-mode');
            gallery._resetSectionModeButtons();
            gallery.renderPhotos(0);
        }
    },

    // === ТАЙМЕР БЕЗДЕЙСТВИЯ ===
    startInactivityTimer: function() {
        this.stopInactivityTimer();
        var self = this;
        this.inactivityTimer = setTimeout(function() {
            alert('Вы автоматически вышли из-за бездействия');
            api.logout();
            self.hideAdminUI();
            location.reload();
        }, this.inactivityTimeout);
    },

    stopInactivityTimer: function() {
        if (this.inactivityTimer) {
            clearTimeout(this.inactivityTimer);
            this.inactivityTimer = null;
        }
    },

    resetInactivityTimer: function() {
        if (this.isAdminActive) this.startInactivityTimer();
    },

    // === СИНХРОНИЗАЦИЯ С GOOGLE DRIVE ===
    syncWithDrive: function(btn) {
        if (!confirm('Синхронизировать с Google Drive?\n\nНовые папки и фото будут добавлены. Удалённые из Drive — скрыты на сайте.')) return;

        var self = this;
        if (btn) { btn.textContent = '⏳ Синхронизация...'; btn.disabled = true; }

        api.sync().then(function(result) {
            if (btn) { btn.textContent = '🔄 Синхронизировать'; btn.disabled = false; }
            if (result.success) {
                var msg = '✅ Готово!\nНовых папок: ' + result.syncedFolders + '\nНовых фото: ' + result.syncedPhotos;
                if (result.deletedFolders || result.deletedPhotos) {
                    msg += '\nУдалено папок: ' + (result.deletedFolders || 0) + '\nУдалено фото: ' + (result.deletedPhotos || 0);
                }
                alert(msg);
                gallery.loadFolders();
            } else {
                alert('❌ Ошибка: ' + (result.error || 'Неизвестная ошибка'));
            }
        }).catch(function() {
            if (btn) { btn.textContent = '🔄 Синхронизировать'; btn.disabled = false; }
            alert('❌ Ошибка соединения');
        });
    },

    // === УПРАВЛЕНИЕ ПАПКАМИ ===
    initSortable: function() {
        var container = document.getElementById('folders-container');
        if (!container || !api.isAdmin()) return;
        if (window.matchMedia('(max-width: 768px)').matches) return;

        var self = this;

        if (self._folderSortable) {
            try { self._folderSortable.destroy(); } catch(e) {}
            self._folderSortable = null;
        }

        // Подключаем Swap-плагин (доступен в том же UMD-бандле SortableJS)
        if (Sortable.mount && typeof Sortable.Swap !== 'undefined') {
            Sortable.mount(new Sortable.Swap());
        }

        self._folderSortable = new Sortable(container, {
            animation: 150,
            handle: '.folder-card',
            ghostClass: 'sortable-ghost',
            dragClass: 'sortable-drag',
            swap: true,
            swapClass: 'sortable-swap-highlight',
            onEnd: function(evt) {
                var i = evt.oldIndex;
                var j = evt.newIndex;
                if (i === j) return;

                // Swap в массиве данных
                var tmp = gallery.folders[i];
                gallery.folders[i] = gallery.folders[j];
                gallery.folders[j] = tmp;

                // Сохраняем на сервере
                var newOrder = gallery.folders.map(function(folder, idx) {
                    return { id: folder.id, order: idx + 1 };
                });
                self.saveFoldersOrder(newOrder);

                // Перерисовываем DOM из данных
                setTimeout(function() { gallery.renderFolders(); }, 0);
            }
        });
    },
    saveFoldersOrder: function(newOrder) {
        api.reorderFolders(newOrder).then(function(result) {
            if (!result || !result.success) alert('Ошибка сохранения порядка!');
        });
    },

    renameFolder: function(folderId, currentTitle) {
        var id = folderId || (gallery.currentFolder ? gallery.currentFolder.id : null);
        var title = currentTitle || (gallery.currentFolder ? gallery.currentFolder.title : '');
        if (!id) return;

        var newTitle = prompt('Новое название:', title);
        if (!newTitle || newTitle === title) return;

        api.updateFolder(id, { title: newTitle }).then(function(result) {
            if (result) {
                if (gallery.currentFolder && gallery.currentFolder.id === id) {
                    gallery.currentFolder.title = newTitle;
                    var titleEl = document.getElementById('folder-title-text');
                    if (titleEl) titleEl.textContent = newTitle;
                }
                gallery.loadFolders();
            } else {
                alert('Ошибка переименования');
            }
        });
    },

    toggleFolderHidden: function(folderId, hide) {
        api.updateFolder(folderId, { hidden: hide }).then(function(result) {
            if (result) gallery.loadFolders();
            else alert('Ошибка');
        });
    },

    // === ОБЛОЖКА ПАПКИ ===
    setFolderCover: function() {
        if (!gallery.currentFolder) return;
        var photoId = gallery._displayOrder ? gallery._displayOrder[gallery.currentPhotoIndex] : null;
        if (!photoId) return;
        var photo = gallery._photoById(photoId);
        if (!photo) return;

        var folderId = gallery.currentFolder.id;
        api.updateFolder(folderId, { cover_url: photo.file_id }).then(function(result) {
            if (result) {
                gallery.closeFullscreen();
                for (var i = 0; i < gallery.folders.length; i++) {
                    if (gallery.folders[i].id === folderId) {
                        gallery.folders[i].cover_url = photo.file_id;
                        break;
                    }
                }
                gallery.loadFolders();
            } else {
                alert('Ошибка установки обложки');
            }
        });
    },

    // === УПРАВЛЕНИЕ ФОТО ===
    togglePhotoHidden: function(photoId) {
        if (!gallery.currentFolder) return;
        var folderId = gallery.currentFolder.id;

        var photoEl = document.querySelector('[data-id="' + photoId + '"]');
        if (!photoEl) return;

        var currentlyHidden = photoEl.getAttribute('data-hidden') === '1';
        var newHidden = !currentlyHidden;

        api.updatePhoto(folderId, photoId, { hidden: newHidden }).then(function(result) {
            if (result && result.success) {
                photoEl.setAttribute('data-hidden', newHidden ? '1' : '0');
                if (newHidden) photoEl.classList.add('hidden-photo');
                else photoEl.classList.remove('hidden-photo');

                var btn = photoEl.querySelector('.photo-item__admin-actions button');
                if (btn) {
                    btn.title = newHidden ? 'Показать' : 'Скрыть';
                    btn.textContent = newHidden ? '👁' : '🙈';
                }

                for (var i = 0; i < gallery.visiblePhotos.length; i++) {
                    if (gallery.visiblePhotos[i].id === photoId) {
                        gallery.visiblePhotos[i].hidden = newHidden;
                        break;
                    }
                }
            } else {
                alert('Ошибка');
            }
        });
    },

    deletePhoto: function(photoId) {
        if (!gallery.currentFolder) return;
        if (!confirm('Удалить это фото из альбома?')) return;

        var folderId = gallery.currentFolder.id;
        api.deletePhoto(folderId, photoId).then(function(result) {
            if (result && result.success) {
                var photoEl = document.querySelector('[data-id="' + photoId + '"]');
                if (photoEl) photoEl.remove();
                gallery.visiblePhotos = gallery.visiblePhotos.filter(function(p) { return p.id !== photoId; });
                gallery._buildDisplayOrder();
            } else {
                alert('Ошибка удаления');
            }
        });
    },

    deleteCurrentPhoto: function() {
        if (!gallery._displayOrder || !gallery.currentFolder) return;
        var photoId = gallery._displayOrder[gallery.currentPhotoIndex];
        if (!photoId) return;
        if (!confirm('Удалить это фото из альбома?')) return;

        var folderId = gallery.currentFolder.id;

        api.deletePhoto(folderId, photoId).then(function(result) {
            if (result && result.success) {
                gallery.closeFullscreen();
                var photoEl = document.querySelector('[data-id="' + photoId + '"]');
                if (photoEl) photoEl.remove();
                gallery.visiblePhotos = gallery.visiblePhotos.filter(function(p) { return p.id !== photoId; });
                gallery._buildDisplayOrder();
                gallery._updateUnsectionedVisibility();
            } else {
                alert('Ошибка удаления');
            }
        });
    },

    // === РЕЖИМ СЕКЦИЙ (только десктоп, только админ) ===

    enableSectionMode: function() {
        if (!gallery.currentFolder) return;
        if (window.matchMedia('(max-width: 768px)').matches) return;

        gallery.sectionModeActive = true;
        document.getElementById('folder-page').classList.add('section-mode');

        var btnEnable = document.getElementById('btn-enable-sections');
        var btnExit = document.getElementById('btn-exit-sections');
        var btnAdd = document.getElementById('btn-add-section');
        if (btnEnable) btnEnable.style.display = 'none';
        if (btnExit) btnExit.style.display = 'block';
        if (btnAdd) btnAdd.style.display = 'block';

        gallery.renderPhotos(0);
        setTimeout(function() { admin.initPhotosSortable(); }, 150);
    },

    exitSectionMode: function() {
        gallery.sectionModeActive = false;
        document.getElementById('folder-page').classList.remove('section-mode');

        var btnEnable = document.getElementById('btn-enable-sections');
        var btnExit = document.getElementById('btn-exit-sections');
        var btnAdd = document.getElementById('btn-add-section');
        if (btnEnable) btnEnable.style.display = 'block';
        if (btnExit) btnExit.style.display = 'none';
        if (btnAdd) btnAdd.style.display = 'none';

        admin._photoSortables.forEach(function(s) { try { s.destroy(); } catch(e) {} });
        admin._photoSortables = [];

        gallery.renderPhotos(0);
    },

    addSection: function() {
        if (!gallery.currentFolder) return;
        var title = prompt('Название секции (например: 2014):');
        if (!title || !title.trim()) return;
        var folderId = gallery.currentFolder.id;
        api.createSection(folderId, title.trim()).then(function(result) {
            if (result && result.success) {
                gallery.loadPhotos(folderId, 0);
                setTimeout(function() {
                    if (!gallery.sectionModeActive && api.isAdmin()) {
                        admin.enableSectionMode();
                    } else if (gallery.sectionModeActive) {
                        setTimeout(function() { admin.initPhotosSortable(); }, 100);
                    }
                }, 500);
            } else {
                alert('Ошибка создания секции');
            }
        });
    },

    renameSection: function(sectionId) {
        if (!gallery.currentFolder) return;
        var section = null;
        for (var i = 0; i < gallery.sections.length; i++) {
            if (gallery.sections[i].id === sectionId) { section = gallery.sections[i]; break; }
        }
        var current = section ? section.title : '';
        var newTitle = prompt('Новое название:', current);
        if (!newTitle || newTitle.trim() === current) return;
        newTitle = newTitle.trim();
        var folderId = gallery.currentFolder.id;
        api.updateSection(folderId, sectionId, newTitle).then(function(result) {
            if (result && result.success) {
                var el = document.getElementById('section-title-' + sectionId);
                if (el) el.textContent = newTitle;
                if (section) section.title = newTitle;
            } else {
                alert('Ошибка переименования');
            }
        });
    },

    deleteSection: function(sectionId) {
        if (!gallery.currentFolder) return;
        if (!confirm('Удалить эту секцию?\nФото останутся в папке (без секции).')) return;
        var folderId = gallery.currentFolder.id;
        var wasSectionMode = gallery.sectionModeActive;
        api.deleteSection(folderId, sectionId).then(function(result) {
            if (result && result.success) {
                gallery.loadPhotos(folderId, 0);
                if (wasSectionMode) {
                    setTimeout(function() {
                        gallery.sectionModeActive = true;
                        document.getElementById('folder-page').classList.add('section-mode');
                        gallery.renderPhotos(0);
                        setTimeout(function() { admin.initPhotosSortable(); }, 150);
                    }, 400);
                }
            } else {
                alert('Ошибка удаления секции');
            }
        });
    },

    // Drag-and-drop фото между секциями
    _photoSortables: [],

    initPhotosSortable: function() {
        var self = this;
        if (!api.isAdmin()) return;

        self._photoSortables.forEach(function(s) { try { s.destroy(); } catch(e) {} });
        self._photoSortables = [];

        var grids = document.querySelectorAll('.photos-section-grid');
        var groupName = 'photos-' + (gallery.currentFolder ? gallery.currentFolder.id : 'x');

        grids.forEach(function(grid) {
            var sortable = new Sortable(grid, {
                group: {
                    name: groupName,
                    pull: true,
                    put: true
                },
                animation: 150,
                ghostClass: 'sortable-ghost',
                dragClass: 'sortable-drag',
                onEnd: function(evt) {
                    var photoId = evt.item.getAttribute('data-id');
                    var targetGrid = evt.to;
                    var targetSectionId = targetGrid.getAttribute('data-section-id') || null;
                    if (targetSectionId === '') targetSectionId = null;
                    var folderId = gallery.currentFolder ? gallery.currentFolder.id : null;
                    if (!folderId || !photoId) return;

                    for (var i = 0; i < gallery.visiblePhotos.length; i++) {
                        if (gallery.visiblePhotos[i].id === photoId) {
                            if (targetSectionId) gallery.visiblePhotos[i].section_id = targetSectionId;
                            else delete gallery.visiblePhotos[i].section_id;
                            break;
                        }
                    }

                    gallery._updateUnsectionedVisibility();

                    var items = targetGrid.querySelectorAll('.photo-item');
                    var orders = [];
                    items.forEach(function(item, idx) {
                        orders.push({
                            id: item.getAttribute('data-id'),
                            order: idx + 1,
                            section_id: targetSectionId
                        });
                    });
                    api.reorderPhotos(folderId, orders);
                }
            });
            self._photoSortables.push(sortable);
        });
    },

    // === РЕЖИМ ВЫБОРА ФОТО ===
    enterSelectionMode: function() {
        this.isSelectionMode = true;
        this.selectedPhotos = [];

        document.getElementById('btn-enter-selection').style.display = 'none';
        document.getElementById('selection-toolbar').style.display = 'flex';

        var btnAll = document.getElementById('btn-select-all');
        if (btnAll) btnAll.textContent = 'Выбрать все';

        document.querySelectorAll('.photo-item').forEach(function(photoEl) {
            var cb = document.createElement('div');
            cb.className = 'photo-checkbox-custom';
            cb.innerHTML = '';
            photoEl.appendChild(cb);
        });

        this.updateSelectionButtons();
    },

    exitSelectionMode: function() {
        this.isSelectionMode = false;
        this.selectedPhotos = [];

        var btnEnter = document.getElementById('btn-enter-selection');
        var toolbar = document.getElementById('selection-toolbar');
        if (btnEnter) btnEnter.style.display = 'block';
        if (toolbar) toolbar.style.display = 'none';

        var btnAll = document.getElementById('btn-select-all');
        if (btnAll) btnAll.textContent = 'Выбрать все';

        document.querySelectorAll('.photo-checkbox-custom').forEach(function(cb) { cb.remove(); });
        this.updateSelectionButtons();
    },

    toggleSelectAll: function() {
        var self = this;
        var photos = document.querySelectorAll('.photo-item');
        var allSelected = this.selectedPhotos.length === photos.length && photos.length > 0;

        self.selectedPhotos = [];

        photos.forEach(function(photoEl) {
            var cb = photoEl.querySelector('.photo-checkbox-custom');
            if (!cb) return;
            if (!allSelected) {
                cb.classList.add('checked');
                cb.innerHTML = '✓';
                self.selectedPhotos.push(photoEl.getAttribute('data-id'));
            } else {
                cb.classList.remove('checked');
                cb.innerHTML = '';
            }
        });

        var btn = document.getElementById('btn-select-all');
        if (btn) btn.textContent = allSelected ? 'Выбрать все' : 'Снять выбор';

        this.updateSelectionButtons();
    },

    togglePhotoSelection: function(photoId, cbEl) {
        var idx = this.selectedPhotos.indexOf(photoId);
        if (idx === -1) {
            this.selectedPhotos.push(photoId);
            cbEl.classList.add('checked');
            cbEl.innerHTML = '✓';
        } else {
            this.selectedPhotos.splice(idx, 1);
            cbEl.classList.remove('checked');
            cbEl.innerHTML = '';
        }

        var photos = document.querySelectorAll('.photo-item');
        var btn = document.getElementById('btn-select-all');
        if (btn) {
            btn.textContent = (this.selectedPhotos.length === photos.length && photos.length > 0)
                ? 'Снять выбор'
                : 'Выбрать все';
        }

        this.updateSelectionButtons();
    },

    updateSelectionButtons: function() {
        var count = this.selectedPhotos.length;
        var has = count > 0;

        var btnDelete = document.getElementById('btn-delete-selected');
        var btnHide = document.getElementById('btn-hide-selected');

        if (btnDelete) {
            btnDelete.textContent = 'Удалить выбранные (' + count + ')';
            btnDelete.disabled = !has;
            btnDelete.style.opacity = has ? '1' : '0.5';
        }
        if (btnHide) {
            btnHide.textContent = 'Скрыть выбранные (' + count + ')';
            btnHide.disabled = !has;
            btnHide.style.opacity = has ? '1' : '0.5';
        }
    },

    deleteSelectedPhotos: function() {
        if (this.selectedPhotos.length === 0 || !gallery.currentFolder) return;
        if (!confirm('Удалить ' + this.selectedPhotos.length + ' фото?')) return;

        var self = this;
        var folderId = gallery.currentFolder.id;
        var toDelete = this.selectedPhotos.slice();
        var done = 0;

        toDelete.forEach(function(photoId) {
            api.deletePhoto(folderId, photoId).then(function() {
                var el = document.querySelector('[data-id="' + photoId + '"]');
                if (el) el.remove();
                gallery.visiblePhotos = gallery.visiblePhotos.filter(function(p) { return p.id !== photoId; });
                done++;
                if (done === toDelete.length) {
                    gallery._buildDisplayOrder();
                    self.exitSelectionMode();
                    alert('✅ Удалено: ' + toDelete.length + ' фото');
                }
            });
        });
    },

    hideSelectedPhotos: function(hide) {
        if (this.selectedPhotos.length === 0 || !gallery.currentFolder) return;

        var self = this;
        var folderId = gallery.currentFolder.id;
        var toHide = this.selectedPhotos.slice();
        var done = 0;

        toHide.forEach(function(photoId) {
            api.updatePhoto(folderId, photoId, { hidden: hide }).then(function() {
                var el = document.querySelector('[data-id="' + photoId + '"]');
                if (el) {
                    el.setAttribute('data-hidden', hide ? '1' : '0');
                    if (hide) el.classList.add('hidden-photo');
                    else el.classList.remove('hidden-photo');
                }
                for (var i = 0; i < gallery.visiblePhotos.length; i++) {
                    if (gallery.visiblePhotos[i].id === photoId) {
                        gallery.visiblePhotos[i].hidden = hide;
                        break;
                    }
                }
                done++;
                if (done === toHide.length) self.exitSelectionMode();
            });
        });
    },

    // === БЭКАП ===
    manualBackup: function() {
        api.createBackup().then(function(result) {
            if (result.success) {
                alert('✅ Бэкап скачан на компьютер!');
            } else {
                alert('❌ Ошибка бэкапа');
            }
        });
    },

    restoreFromBackup: function() {
        var input = document.getElementById('restore-backup-file');
        if (!input) {
            input = document.createElement('input');
            input.type = 'file';
            input.id = 'restore-backup-file';
            input.accept = '.json';
            input.style.display = 'none';
            document.body.appendChild(input);
        }
        input.onchange = function() {
            var file = input.files[0];
            if (!file) return;
            if (!confirm('Восстановить данные из бэкапа?\nТекущие данные будут перезаписаны.')) {
                input.value = '';
                return;
            }
            var reader = new FileReader();
            reader.onload = function(e) {
                try {
                    var data = JSON.parse(e.target.result);
                    api.restoreBackup(data).then(function(result) {
                        if (result.success) {
                            alert('♻️ Восстановлено!\nПапок: ' + result.restoredFolders + '\nФото: ' + result.restoredPhotos);
                            gallery.loadFolders();
                        } else {
                            alert('❌ Ошибка: ' + (result.error || 'unknown'));
                        }
                    });
                } catch (e) {
                    alert('❌ Неверный формат файла');
                }
            };
            reader.readAsText(file);
            input.value = '';
        };
        input.click();
    },

    // === ПРОСМОТР ХРАНИЛИЩА ===
    viewStorage: function() {
        var token = api.getToken();
        if (!token) { alert('Не авторизован'); return; }

        var modal = document.getElementById('storage-viewer');
        if (modal) modal.remove();

        modal = document.createElement('div');
        modal.id = 'storage-viewer';
        modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);z-index:10002;overflow:auto;display:none;';
        modal.innerHTML =
            '<div style="background:#fff;max-width:900px;margin:50px auto;padding:30px;border-radius:8px;position:relative;">' +
            '<button onclick="document.getElementById(\'storage-viewer\').remove()" style="position:absolute;top:15px;right:15px;background:none;border:none;font-size:24px;cursor:pointer;">×</button>' +
            '<h2 style="margin-top:0;">📦 Данные хранилища</h2>' +
            '<div id="storage-content"><p>Загрузка...</p></div>' +
            '</div>';
        document.body.appendChild(modal);
        modal.style.display = 'block';

        fetch('https://photo-backend.belovolov-email.workers.dev/admin/storage-info', {
            headers: { 'Authorization': 'Bearer ' + token }
        }).then(function(r) { return r.json(); })
          .then(function(resp) {
            if (!resp.success) {
                document.getElementById('storage-content').innerHTML = '<p style="color:red;">Ошибка</p>';
                return;
            }
            var folders = resp.folders || [];
            var photos = resp.photos || [];
            var active = photos.filter(function(p) { return !p.deleted; }).length;
            var deleted = photos.filter(function(p) { return p.deleted; }).length;

            var html = '<h3>📊 Статистика</h3>';
            html += '<p><strong>Папок:</strong> ' + folders.length + ' | <strong>Фото активных:</strong> ' + active + ' | удалённых: ' + deleted + '</p>';
            html += '<h3 style="margin-top:20px;">📁 Папки</h3>';
            html += '<table style="width:100%;border-collapse:collapse;">';
            html += '<tr style="background:#f0f0f0;"><th style="padding:8px;border:1px solid #ddd;">Название</th><th style="padding:8px;border:1px solid #ddd;">Скрыта</th></tr>';
            folders.forEach(function(f) {
                html += '<tr><td style="padding:8px;border:1px solid #ddd;">' + f.title + '</td><td style="padding:8px;border:1px solid #ddd;">' + (f.hidden ? '✓' : '') + '</td></tr>';
            });
            html += '</table>';
            document.getElementById('storage-content').innerHTML = html;
        }).catch(function() {
            document.getElementById('storage-content').innerHTML = '<p style="color:red;">Ошибка загрузки</p>';
        });
    },

    // === ОЧИСТКА ХРАНИЛИЩА ===
    openClearStorageModal: function() {
        document.getElementById('clear-storage-modal').style.display = 'flex';
        document.getElementById('clear-storage-password').value = '';
        document.getElementById('clear-storage-error').textContent = '';
        document.getElementById('clear-storage-password').focus();
    },

    closeClearStorageModal: function() {
        document.getElementById('clear-storage-modal').style.display = 'none';
    },

    confirmClearStorage: function() {
        var password = document.getElementById('clear-storage-password').value;
        var errorEl = document.getElementById('clear-storage-error');
        if (!password) { errorEl.textContent = 'Введите пароль'; return; }

        var self = this;
        api.login(password).then(function(result) {
            if (!result.success) { errorEl.textContent = 'Неверный пароль'; return; }
            if (!confirm('⚠️ Удалить ВСЕ папки и фото из хранилища?\n(Сами файлы в Google Drive останутся)')) return;

            api.clearStorage().then(function(result) {
                if (result.success) {
                    alert('✅ Хранилище очищено\nПапок: ' + result.deletedFolders + '\nФото: ' + result.deletedPhotos);
                    self.closeClearStorageModal();
                    gallery.loadFolders();
                } else {
                    alert('❌ Ошибка: ' + (result.error || 'unknown'));
                }
            });
        });
    },

    reloadPage: function() {
        location.reload(true);
    }
};

document.addEventListener('DOMContentLoaded', function() {
    if (api.isAdmin()) {
        admin.showAdminUI();
        admin.startInactivityTimer();
    }

    var passInput = document.getElementById('admin-password');
    if (passInput) {
        passInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') admin.login();
        });
    }

    ['click', 'touchstart', 'keydown', 'scroll'].forEach(function(ev) {
        document.addEventListener(ev, function() {
            if (admin.isAdminActive) admin.resetInactivityTimer();
        });
    });
});
