// api.js — связь сайта с сервером (Google Drive версия)

var API_BASE = 'https://photo-backend.belovolov-email.workers.dev';

var api = {

    getToken: function() {
        return localStorage.getItem('admin_token');
    },

    isAdmin: function() {
        return !!this.getToken();
    },

    setToken: function(token) {
        localStorage.setItem('admin_token', token);
    },

    clearToken: function() {
        localStorage.removeItem('admin_token');
    },

    getHeaders: function(isAdmin) {
        var headers = { 'Content-Type': 'application/json' };
        if (isAdmin && this.getToken()) {
            headers['Authorization'] = 'Bearer ' + this.getToken();
        }
        return headers;
    },

    // === ВХОД В АДМИНКУ ===
    login: function(password) {
        var self = this;
        return fetch(API_BASE + '/admin/login', {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify({ password: password })
        }).then(function(r) { return r.json(); })
          .then(function(data) {
            if (data.token) {
                self.setToken(data.token);
                return { success: true };
            }
            return { success: false, error: data.error || 'Неверный пароль' };
        }).catch(function() {
            return { success: false, error: 'Ошибка соединения' };
        });
    },

    logout: function() {
        this.clearToken();
    },

    // === СИНХРОНИЗАЦИЯ С GOOGLE DRIVE ===
    // Читает папки и фото из Google Drive и сохраняет в хранилище
    sync: function() {
        return fetch(API_BASE + '/sync', {
            method: 'POST',
            headers: this.getHeaders(true)
        }).then(function(r) { return r.json(); })
          .catch(function() { return { success: false, error: 'Ошибка соединения' }; });
    },

    // === ПАПКИ ===
    getFolders: function() {
        return fetch(API_BASE + '/folders', {
            headers: this.getHeaders(this.isAdmin())
        }).then(function(r) { return r.json(); })
          .then(function(data) { return data.folders || []; })
          .catch(function() { return []; });
    },

    updateFolder: function(folderId, updates) {
        var body = { id: folderId };
        for (var key in updates) { body[key] = updates[key]; }
        return fetch(API_BASE + '/folders', {
            method: 'PATCH',
            headers: this.getHeaders(true),
            body: JSON.stringify(body)
        }).then(function(r) { return r.json(); })
          .catch(function() { return null; });
    },

    reorderFolders: function(orders) {
        return fetch(API_BASE + '/folders/reorder', {
            method: 'POST',
            headers: this.getHeaders(true),
            body: JSON.stringify({ orders: orders })
        }).then(function(r) { return r.json(); })
          .catch(function() { return null; });
    },

    // === ФОТО ===
    getPhotosList: function(folderId) {
        return fetch(API_BASE + '/photos/list?folder_id=' + folderId, {
            headers: this.getHeaders(this.isAdmin())
        }).then(function(r) { return r.json(); })
          .then(function(data) { return data.photos || []; })
          .catch(function() { return []; });
    },

    // Ссылки для быстрого просмотра (уменьшенные копии — загружаются быстро)
    getPhotosThumbnails: function(folderId, photos) {
        return fetch(API_BASE + '/photos/thumbnails', {
            method: 'POST',
            headers: this.getHeaders(this.isAdmin()),
            body: JSON.stringify({ folder_id: folderId, photos: photos })
        }).then(function(r) { return r.json(); })
          .then(function(data) { return data.urls || {}; })
          .catch(function() { return {}; });
    },

    // Ссылки на оригиналы (для скачивания и просмотра в полном размере)
    getPhotosUrls: function(folderId, photos) {
        return fetch(API_BASE + '/photos/urls', {
            method: 'POST',
            headers: this.getHeaders(this.isAdmin()),
            body: JSON.stringify({ folder_id: folderId, photos: photos })
        }).then(function(r) { return r.json(); })
          .then(function(data) { return data.urls || {}; })
          .catch(function() { return {}; });
    },

    updatePhoto: function(folderId, photoId, updates) {
        var body = { id: photoId, folder_id: folderId };
        for (var key in updates) { body[key] = updates[key]; }
        return fetch(API_BASE + '/photos', {
            method: 'PATCH',
            headers: this.getHeaders(true),
            body: JSON.stringify(body)
        }).then(function(r) { return r.json(); })
          .catch(function() { return null; });
    },

    deletePhoto: function(folderId, photoId) {
        return fetch(API_BASE + '/photos?id=' + photoId + '&folder_id=' + folderId, {
            method: 'DELETE',
            headers: this.getHeaders(true)
        }).then(function(r) { return r.json(); })
          .catch(function() { return null; });
    },

    // === БЭКАП ===
    createBackup: function() {
        return fetch(API_BASE + '/admin/backup', {
            method: 'POST',
            headers: this.getHeaders(true)
        }).then(function(r) { return r.json(); })
          .then(function(data) {
            // Скачиваем бэкап как файл на компьютер
            if (data.success && data.backup) {
                var json = JSON.stringify(data.backup, null, 2);
                var blob = new Blob([json], { type: 'application/json' });
                var url = URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = url;
                a.download = 'backup-' + new Date().toISOString().slice(0,10) + '.json';
                a.click();
                URL.revokeObjectURL(url);
            }
            return data;
        }).catch(function() { return { success: false }; });
    },

    restoreBackup: function(backupData) {
        return fetch(API_BASE + '/admin/restore', {
            method: 'POST',
            headers: this.getHeaders(true),
            body: JSON.stringify(backupData)
        }).then(function(r) { return r.json(); })
          .catch(function() { return { success: false, error: 'Ошибка соединения' }; });
    },

    clearStorage: function() {
        return fetch(API_BASE + '/admin/clear-storage', {
            method: 'POST',
            headers: this.getHeaders(true)
        }).then(function(r) { return r.json(); })
          .catch(function() { return { success: false, error: 'Ошибка соединения' }; });
    }
};
