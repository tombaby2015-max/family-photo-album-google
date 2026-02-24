// admin.js — панель администратора (Google Drive версия)

var admin = {
    inactivityTimer: null,
    inactivityTimeout: 15 * 60 * 1000, // 15 минут
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
    },

    // === ТАЙМЕР БЕЗДЕЙСТВИЯ (автовыход) ===
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
    // Читает папки и фото из вашего Google Drive и добавляет новые в хранилище
    syncWithDrive: function() {
        if (!confirm('Синхронизировать с Google Drive?\n\nНовые папки и фото будут добавлены в альбом.')) return;

        var self = this;
        var btn = event.target;
        btn.textContent = '⏳ Синхронизация...';
        btn.disabled = true;

        api.sync().then(function(result) {
            btn.textContent = '🔄 Синхронизировать';
            btn.disabled = false;

            if (result.success) {
                alert(
                    '✅ Синхронизация завершена!\n' +
                    'Новых папок: ' + result.syncedFolders + '\n' +
                    'Новых фото: ' + result.syncedPhotos
                );
                gallery.loadFolders();
            } else {
                alert('❌ Ошибка: ' + (result.error || 'Неизвестная ошибка'));
            }
        }).catch(function(e) {
            btn.textContent = '🔄 Синхронизировать';
            btn.disabled = false;
            alert('❌ Ошибка соединения');
        });
    },

    // === УПРАВЛЕНИЕ ПАПКАМИ ===
    initSortable: function() {
        var container = document.getElementById('folders-container');
        if (!container || !api.isAdmin()) return;
        if (window.matchMedia('(max-width: 768px)').matches) return;

        var self = this;
        new Sortable(container, {
            animation: 150,
            handle: '.folder-card',
            ghostClass: 'sortable-ghost',
            dragClass: 'sortable-drag',
            onEnd: function() {
                var items = container.querySelectorAll('li.folder-card');
                var newOrder = [];
                items.forEach(function(item, i) {
                    var id = item.getAttribute('data-folder-id');
                    if (id) newOrder.push({ id: id, order: i + 1 });
                });
                self.saveFoldersOrder(newOrder);
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
    // Устанавливает текущее фото как обложку папки
    setFolderCover: function() {
        if (!gallery.currentFolder) return;
        var photo = gallery.visiblePhotos[gallery.currentPhotoIndex];
        if (!photo) return;

        var folderId = gallery.currentFolder.id;

        api.updateFolder(folderId, {
            cover_url: photo.file_id  // сохраняем Google Drive ID фото
        }).then(function(result) {
            if (result) {
                gallery.closeFullscreen();
                // Обновляем данные папки
                for (var i = 0; i < gallery.folders.length; i++) {
                    if (gallery.folders[i].id === folderId) {
                        gallery.folders[i].cover_url = photo.file_id;
                        break;
                    }
                }
                alert('✅ Обложка установлена!');
            } else {
                alert('Ошибка установки обложки');
            }
        });
    },

    // === УПРАВЛЕНИЕ ФОТО ===
    togglePhotoHidden: function(photoId, hide) {
        if (!gallery.currentFolder) return;
        var folderId = gallery.currentFolder.id;

        api.updatePhoto(folderId, photoId, { hidden: hide }).then(function(result) {
            if (result && result.success) {
                // Обновляем в памяти
                for (var i = 0; i < gallery.visiblePhotos.length; i++) {
                    if (gallery.visiblePhotos[i].id === photoId) {
                        gallery.visiblePhotos[i].hidden = hide;
                        break;
                    }
                }
                // Обновляем вид фото
                var photoEl = document.querySelector('[data-id="' + photoId + '"]');
                if (photoEl) {
                    if (hide) photoEl.classList.add('hidden-photo');
                    else photoEl.classList.remove('hidden-photo');
                    var btn = photoEl.querySelector('button');
                    if (btn) btn.textContent = hide ? '👁' : '🙈';
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
                // Убираем из массива
                gallery.visiblePhotos = gallery.visiblePhotos.filter(function(p) { return p.id !== photoId; });
            } else {
                alert('Ошибка удаления');
            }
        });
    },

    deleteCurrentPhoto: function() {
        var photo = gallery.visiblePhotos[gallery.currentPhotoIndex];
        if (!photo || !gallery.currentFolder) return;
        if (!confirm('Удалить это фото из альбома?')) return;

        var folderId = gallery.currentFolder.id;
        var photoId = photo.id;
        var self = this;

        api.deletePhoto(folderId, photoId).then(function(result) {
            if (result && result.success) {
                gallery.closeFullscreen();
                var photoEl = document.querySelector('[data-id="' + photoId + '"]');
                if (photoEl) photoEl.remove();
                gallery.visiblePhotos = gallery.visiblePhotos.filter(function(p) { return p.id !== photoId; });
            } else {
                alert('Ошибка удаления');
            }
        });
    },

    // === РЕЖИМ ВЫБОРА НЕСКОЛЬКИХ ФОТО ===
    enterSelectionMode: function() {
        this.isSelectionMode = true;
        this.selectedPhotos = [];

        document.getElementById('btn-enter-selection').style.display = 'none';
        document.getElementById('selection-toolbar').style.display = 'flex';

        // Добавляем чекбоксы к каждому фото
        var photos = document.querySelectorAll('.photo-item');
        photos.forEach(function(photoEl) {
            var cb = document.createElement('div');
            cb.className = 'photo-checkbox-custom';
            cb.innerHTML = '';
            photoEl.appendChild(cb);
        });
    },

    exitSelectionMode: function() {
        this.isSelectionMode = false;
        this.selectedPhotos = [];

        document.getElementById('btn-enter-selection').style.display = 'block';
        document.getElementById('selection-toolbar').style.display = 'none';

        document.querySelectorAll('.photo-checkbox-custom').forEach(function(cb) { cb.remove(); });
        this.updateSelectionButtons();
    },

    toggleSelectAll: function() {
        var self = this;
        var photos = document.querySelectorAll('.photo-item');
        var allSelected = this.selectedPhotos.length === photos.length;

        self.selectedPhotos = [];
        photos.forEach(function(photoEl) {
            var cb = photoEl.querySelector('.photo-checkbox-custom');
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
        this.updateSelectionButtons();
    },

    updateSelectionButtons: function() {
        var count = this.selectedPhotos.length;
        var hasSelected = count > 0;

        var btnDelete = document.getElementById('btn-delete-selected');
        var btnHide = document.getElementById('btn-hide-selected');

        if (btnDelete) {
            btnDelete.textContent = 'Удалить выбранные (' + count + ')';
            btnDelete.disabled = !hasSelected;
            btnDelete.style.opacity = hasSelected ? '1' : '0.5';
        }
        if (btnHide) {
            btnHide.textContent = 'Скрыть выбранные (' + count + ')';
            btnHide.disabled = !hasSelected;
            btnHide.style.opacity = hasSelected ? '1' : '0.5';
        }
    },

    deleteSelectedPhotos: function() {
        if (this.selectedPhotos.length === 0) return;
        if (!gallery.currentFolder) return;
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
                    self.exitSelectionMode();
                    alert('✅ Удалено: ' + toDelete.length + ' фото');
                }
            });
        });
    },

    hideSelectedPhotos: function(hide) {
        if (this.selectedPhotos.length === 0) return;
        if (!gallery.currentFolder) return;

        var self = this;
        var folderId = gallery.currentFolder.id;
        var toHide = this.selectedPhotos.slice();

        var done = 0;
        toHide.forEach(function(photoId) {
            api.updatePhoto(folderId, photoId, { hidden: hide }).then(function() {
                var el = document.querySelector('[data-id="' + photoId + '"]');
                if (el) {
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
                if (done === toHide.length) {
                    self.exitSelectionMode();
                }
            });
        });
    },

    // === БЭКАП ===
    manualBackup: function() {
        api.createBackup().then(function(result) {
            if (result.success) {
                // Файл уже скачался автоматически (через api.js)
                alert('✅ Бэкап скачан на ваш компьютер!');
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

        fetch(API_BASE + '/admin/storage-info', {
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
            html += '<p><strong>Папок:</strong> ' + folders.length + '</p>';
            html += '<p><strong>Фото активных:</strong> ' + active + ' | удалённых: ' + deleted + '</p>';
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
