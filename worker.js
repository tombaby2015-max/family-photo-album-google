// worker.js — ОПТИМИЗИРОВАННАЯ версия (План Б)
//
// ГЛАВНОЕ ИЗМЕНЕНИЕ: структура хранения в KV
//
// БЫЛО (старая структура — медленно):
//   folder:ABC          → { title, hidden, order, cover_url, ... }
//   photo:ABC:photo1    → { name, hidden, deleted, ... }
//   photo:ABC:photo2    → { name, hidden, deleted, ... }
//   photo:ABC:photo3    → { name, hidden, deleted, ... }
//   ... (100 отдельных ключей на папку = 100 запросов к KV)
//
// СТАЛО (новая структура — быстро):
//   folder:ABC          → { title, hidden, order, cover_url, ..., photos: [...все фото сразу] }
//   folders_index       → [ ...все папки сразу для быстрой загрузки главной страницы ]
//   sections:ABC        → [ ...секции папки ] (не изменилось)
//
// ИТОГ: вместо 800+ запросов к KV — 1-8 запросов.

export default {
  async fetch(request, env, ctx) {
    console.log('=== Запрос:', request.method, request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const workerBase = `https://${url.host}`;

    if (!env.PHOTO_KV) {
      return json({ error: "KV not bound" }, corsHeaders, 500);
    }

    const authHeader = request.headers.get("Authorization");
    const token = authHeader ? authHeader.replace("Bearer ", "") : null;
    const isAdmin = token ? !!(await env.PHOTO_KV.get(`admin_token:${token}`)) : false;

    // ==========================================
    // ПОКАЗ ФОТО (проксирование через воркер)
    // Не изменилось — Google Drive не даёт прямые ссылки
    // Добавлено: кеширование через Cloudflare Cache API
    // ==========================================
    if (request.method === "GET" && url.pathname === "/photo") {
      const fileId = url.searchParams.get("id");
      const size = url.searchParams.get("size") || "thumb";
      const folderName = url.searchParams.get("folder") || "";  // название папки для имени файла
      if (!fileId) return new Response("id required", { status: 400 });

      // Для кеша используем ключ без параметра folder (чтобы не дублировать кеш)
      const cache = caches.default;
      const cacheKey = new Request(`${workerBase}/photo?id=${fileId}&size=${size}`);
      const cachedResponse = await cache.match(cacheKey);
      if (cachedResponse && size !== "original") {
        // Для оригиналов не отдаём из кеша — нужно поставить правильный Content-Disposition
        return cachedResponse;
      }

      try {
        const accessToken = await getGoogleAccessToken(env);

        // Имя файла берём из параметра URL (передаётся из gallery.js)
        // Не делаем отдельный запрос к Drive API за metadata
        const photoName = url.searchParams.get("name") || "photo.jpg";

        const resp = await fetch(
          `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        if (!resp.ok) {
          return new Response("Фото не найдено", { status: 404, headers: corsHeaders });
        }

        const contentType = resp.headers.get("content-type") || "image/jpeg";

        const headers = {
          ...corsHeaders,
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=604800",
        };

        if (size === "original") {
          // Формируем имя: "Название папки — IMG_2045.jpg"
          const decodedFolder = folderName ? decodeURIComponent(folderName) : "";
          const downloadName = decodedFolder
            ? `${decodedFolder} — ${photoName}`
            : photoName;
          // encodeURIComponent для поддержки кириллицы в имени файла
          headers["Content-Disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
        }

        const response = new Response(resp.body, { headers });

        // Кешируем только миниатюры (оригиналы не кешируем — у них динамический заголовок)
        if (size !== "original") {
          ctx.waitUntil(cache.put(cacheKey, response.clone()));
        }

        return response;

      } catch (e) {
        return new Response("Ошибка: " + e.message, { status: 500, headers: corsHeaders });
      }
    }

    // ==========================================
    // СПИСОК ПАПОК — ГЛАВНАЯ ОПТИМИЗАЦИЯ
    //
    // БЫЛО: 1 list() + 8 get(folder) + 8 list(photos) + 800 get(photo) = ~820 запросов
    // СТАЛО: 1 get(folders_index) = 1 запрос
    //
    // folders_index содержит все папки сразу, включая photo_count
    // Фото внутри папки НЕ передаются здесь — только метаданные папок
    // ==========================================
    if (request.method === "GET" && url.pathname === "/folders") {
      // Читаем индекс всех папок — один запрос вместо сотен
      let folders = await getFoldersIndex(env);

      // Сортируем по полю order
      folders.sort((a, b) => (a.order || 0) - (b.order || 0));

      // Обычный посетитель не видит скрытые папки
      if (!isAdmin) {
        folders = folders.filter(f => !f.hidden);
      }

      return json({ folders }, corsHeaders);
    }

    // ==========================================
    // СПИСОК ФОТО В ПАПКЕ — ВТОРАЯ ОПТИМИЗАЦИЯ
    //
    // БЫЛО: 1 list() + 100 get(photo) = 101 запрос
    // СТАЛО: 1 get(folder:ID) → поле photos внутри = 1 запрос
    // ==========================================
    if (request.method === "GET" && url.pathname === "/photos/list") {
      const folderId = url.searchParams.get("folder_id");
      if (!folderId) return json({ error: "folder_id required" }, corsHeaders, 400);

      const folder = await getFolder(env, folderId);
      if (!folder) return json({ photos: [] }, corsHeaders);

      let photos = folder.photos || [];

      // Фильтруем удалённые и скрытые
      photos = photos.filter(p => {
        if (p.deleted) return false;
        if (!isAdmin && p.hidden) return false;
        return true;
      });

      // Сортировка: сначала по полю order (если задан), потом по имени файла
      photos.sort((a, b) => {
        if (a.order !== undefined && b.order !== undefined) return a.order - b.order;
        if (a.order !== undefined) return -1;
        if (b.order !== undefined) return 1;
        return (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' });
      });

      return json({ photos }, corsHeaders);
    }

    // ==========================================
    // ССЫЛКИ ДЛЯ ПРОСМОТРА (миниатюры) — не изменилось
    // Просто формируем URL-адреса, никаких запросов к KV
    // ==========================================
    if (request.method === "POST" && url.pathname === "/photos/thumbnails") {
      const body = await request.json();
      const photos = body.photos || [];

      const urls = {};
      for (const photo of photos) {
        urls[photo.id] = `${workerBase}/photo?id=${photo.file_id}&size=thumb`;
      }

      return json({ urls }, corsHeaders);
    }

    // ==========================================
    // ССЫЛКИ ДЛЯ СКАЧИВАНИЯ (оригиналы) — не изменилось
    // ==========================================
    if (request.method === "POST" && url.pathname === "/photos/urls") {
      const body = await request.json();
      const photos = body.photos || [];

      const urls = {};
      for (const photo of photos) {
        urls[photo.id] = `${workerBase}/photo?id=${photo.file_id}&size=original`;
      }

      return json({ urls }, corsHeaders);
    }

    // ==========================================
    // ВХОД В АДМИНКУ — не изменилось
    // ==========================================
    if (request.method === "POST" && url.pathname === "/admin/login") {
      const body = await request.json();
      if (body.password !== env.ADMIN_PASSWORD) {
        return json({ error: "invalid password" }, corsHeaders, 401);
      }
      const newToken = crypto.randomUUID();
      await env.PHOTO_KV.put(`admin_token:${newToken}`, "1", { expirationTtl: 86400 });
      return json({ token: newToken }, corsHeaders);
    }

    // ==========================================
    // СИНХРОНИЗАЦИЯ С GOOGLE DRIVE
    //
    // Логика та же: сравниваем что есть в Drive с тем что в KV.
    // Изменение: теперь пишем данные в новую структуру.
    // Фото папки хранятся ВНУТРИ объекта папки, а не отдельными ключами.
    // В конце обновляем folders_index.
    // ==========================================
    if (request.method === "POST" && url.pathname === "/sync") {
      if (!isAdmin) return json({ error: "unauthorized" }, corsHeaders, 401);

      try {
        const accessToken = await getGoogleAccessToken(env);

        // Получаем все папки из Google Drive
        const foldersResp = await fetch(
          `https://www.googleapis.com/drive/v3/files?q='${env.DRIVE_FOLDER_ID}'+in+parents+and+mimeType='application/vnd.google-apps.folder'+and+trashed=false&fields=files(id,name)&orderBy=name`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const foldersData = await foldersResp.json();
        const driveFolders = foldersData.files || [];
        const driveFolderIds = new Set(driveFolders.map(f => f.id));

        let syncedFolders = 0;
        let syncedPhotos = 0;
        let deletedFolders = 0;
        let deletedPhotos = 0;

        // Читаем текущий индекс папок
        const currentIndex = await getFoldersIndex(env);
        const currentFolderIds = new Set(currentIndex.map(f => f.id));

        // Удаляем папки которых нет в Drive
        for (const existingFolder of currentIndex) {
          if (!driveFolderIds.has(existingFolder.id)) {
            await env.PHOTO_KV.delete(`folder:${existingFolder.id}`);
            await env.PHOTO_KV.delete(`sections:${existingFolder.id}`);
            deletedFolders++;
            deletedPhotos += (existingFolder.photo_count || 0);
          }
        }

        // Синхронизируем каждую папку из Drive
        for (const driveFolder of driveFolders) {
          const folderKey = `folder:${driveFolder.id}`;

          // Читаем существующие данные папки (или создаём новые)
          let folderData = await getFolder(env, driveFolder.id);
          const isNew = !folderData;

          if (isNew) {
            folderData = {
              title: driveFolder.name,
              hidden: false,
              order: 0,
              cover_url: null,
              cover_x: 50,
              cover_y: 50,
              cover_scale: 100,
              photos: [],
              schema: 2  // новая схема хранения
            };
            syncedFolders++;
          }

          // Получаем все фото этой папки из Google Drive
          const drivePhotos = [];
          let pageToken = null;
          do {
            let photosUrl = `https://www.googleapis.com/drive/v3/files?q='${driveFolder.id}'+in+parents+and+(mimeType='image/jpeg'+or+mimeType='image/png'+or+mimeType='image/heic'+or+mimeType='image/webp')+and+trashed=false&fields=files(id,name,mimeType,createdTime)&orderBy=name&pageSize=1000`;
            if (pageToken) photosUrl += `&pageToken=${pageToken}`;

            const photosResp = await fetch(photosUrl, {
              headers: { Authorization: `Bearer ${accessToken}` }
            });
            const photosData = await photosResp.json();
            drivePhotos.push(...(photosData.files || []));
            pageToken = photosData.nextPageToken || null;
          } while (pageToken);

          const drivePhotoIds = new Set(drivePhotos.map(p => p.id));

          // Существующие фото в KV (чтобы сохранить их настройки: hidden, order, section_id)
          const existingPhotosMap = {};
          for (const p of (folderData.photos || [])) {
            existingPhotosMap[p.file_id] = p;
          }

          // Собираем новый список фото:
          // - берём все фото из Drive
          // - если фото уже было — сохраняем его настройки (hidden, order, section_id)
          // - если фото новое — создаём с дефолтными настройками
          const newPhotos = [];
          for (const drivePhoto of drivePhotos) {
            if (existingPhotosMap[drivePhoto.id]) {
              // Фото уже знакомо — сохраняем его настройки
              newPhotos.push(existingPhotosMap[drivePhoto.id]);
            } else {
              // Новое фото из Drive
              newPhotos.push({
                id: drivePhoto.id,        // id = file_id для простоты
                file_id: drivePhoto.id,
                name: drivePhoto.name,
                date: drivePhoto.createdTime,
                deleted: false,
                hidden: false,
                schema: 2
              });
              syncedPhotos++;
            }
          }

          // Считаем удалённые фото (были в KV, нет в Drive)
          for (const p of (folderData.photos || [])) {
            if (!drivePhotoIds.has(p.file_id) && !p.deleted) {
              deletedPhotos++;
            }
          }

          // Обновляем папку с новым списком фото
          folderData.photos = newPhotos;
          await env.PHOTO_KV.put(folderKey, JSON.stringify(folderData));
        }

        // Пересобираем folders_index после синхронизации
        await rebuildFoldersIndex(env);

        return json({ success: true, syncedFolders, syncedPhotos, deletedFolders, deletedPhotos }, corsHeaders);

      } catch (e) {
        console.error('Ошибка синхронизации:', e);
        return json({ error: e.message }, corsHeaders, 500);
      }
    }

    // ==========================================
    // ИЗМЕНЕНИЕ ПАПКИ (название, скрыть, обложка)
    // Изменение: после обновления пересобираем folders_index
    // ==========================================
    if (request.method === "PATCH" && url.pathname === "/folders") {
      if (!isAdmin) return json({ error: "unauthorized" }, corsHeaders, 401);

      const body = await request.json();
      const folderId = body.id;
      if (!folderId) return json({ error: "id required" }, corsHeaders, 400);

      const folder = await getFolder(env, folderId);
      if (!folder) return json({ error: "folder not found" }, corsHeaders, 404);

      if (body.title !== undefined) folder.title = body.title;
      if (body.hidden !== undefined) folder.hidden = body.hidden;
      if (body.order !== undefined) folder.order = body.order;
      if (body.cover_url !== undefined) folder.cover_url = body.cover_url;
      if (body.cover_x !== undefined) folder.cover_x = body.cover_x;
      if (body.cover_y !== undefined) folder.cover_y = body.cover_y;
      if (body.cover_scale !== undefined) folder.cover_scale = body.cover_scale;

      await env.PHOTO_KV.put(`folder:${folderId}`, JSON.stringify(folder));

      // Обновляем индекс папок
      await rebuildFoldersIndex(env);

      return json({ id: folderId, ...folder }, corsHeaders);
    }

    // ==========================================
    // ПОРЯДОК ПАПОК
    // ==========================================
    if (request.method === "POST" && url.pathname === "/folders/reorder") {
      if (!isAdmin) return json({ error: "unauthorized" }, corsHeaders, 401);

      const body = await request.json();
      const orders = body.orders || [];

      // Обновляем порядок параллельно (группами по 50 — лимит Cloudflare)
      const CHUNK = 50;
      for (let i = 0; i < orders.length; i += CHUNK) {
        const chunk = orders.slice(i, i + CHUNK);
        await Promise.all(chunk.map(async (item) => {
          const folder = await getFolder(env, item.id);
          if (folder) {
            folder.order = item.order;
            await env.PHOTO_KV.put(`folder:${item.id}`, JSON.stringify(folder));
          }
        }));
      }

      // Обновляем индекс
      await rebuildFoldersIndex(env);

      return json({ success: true, updated: orders.length }, corsHeaders);
    }

    // ==========================================
    // СКРЫТИЕ / ПОКАЗ ФОТО
    // Изменение: теперь меняем фото внутри массива папки
    // ==========================================
    if (request.method === "PATCH" && url.pathname === "/photos") {
      if (!isAdmin) return json({ error: "unauthorized" }, corsHeaders, 401);

      const body = await request.json();
      const photoId = body.id;
      const folderId = body.folder_id;
      if (!photoId || !folderId) return json({ error: "id and folder_id required" }, corsHeaders, 400);

      const folder = await getFolder(env, folderId);
      if (!folder) return json({ error: "folder not found" }, corsHeaders, 404);

      const photo = (folder.photos || []).find(p => p.id === photoId);
      if (!photo) return json({ error: "photo not found" }, corsHeaders, 404);

      if (body.hidden !== undefined) photo.hidden = body.hidden;

      await env.PHOTO_KV.put(`folder:${folderId}`, JSON.stringify(folder));
      await updateFolderInIndex(env, folderId, folder);

      return json({ success: true, id: photoId, hidden: photo.hidden }, corsHeaders);
    }

    // ==========================================
    // УДАЛЕНИЕ ФОТО (помечаем deleted=true)
    // ==========================================
    if (request.method === "DELETE" && url.pathname === "/photos") {
      if (!isAdmin) return json({ error: "unauthorized" }, corsHeaders, 401);

      const photoId = url.searchParams.get("id");
      const folderId = url.searchParams.get("folder_id");
      if (!photoId || !folderId) return json({ error: "id and folder_id required" }, corsHeaders, 400);

      const folder = await getFolder(env, folderId);
      if (folder) {
        const photo = (folder.photos || []).find(p => p.id === photoId);
        if (photo) {
          photo.deleted = true;
          await env.PHOTO_KV.put(`folder:${folderId}`, JSON.stringify(folder));
          await updateFolderInIndex(env, folderId, folder);
        }
      }

      return json({ success: true }, corsHeaders);
    }

    // ==========================================
    // ПОРЯДОК ФОТО (drag-and-drop в режиме секций)
    // ==========================================
    if (request.method === "POST" && url.pathname === "/photos/reorder") {
      if (!isAdmin) return json({ error: "unauthorized" }, corsHeaders, 401);

      const body = await request.json();
      const { folder_id, orders } = body;
      if (!folder_id || !orders) return json({ error: "folder_id and orders required" }, corsHeaders, 400);

      const folder = await getFolder(env, folder_id);
      if (!folder) return json({ success: true }, corsHeaders);

      const photosMap = {};
      for (const p of (folder.photos || [])) {
        photosMap[p.id] = p;
      }

      for (const item of orders) {
        if (photosMap[item.id]) {
          photosMap[item.id].order = item.order;
          if (item.section_id !== undefined) {
            if (item.section_id) photosMap[item.id].section_id = item.section_id;
            else delete photosMap[item.id].section_id;
          }
        }
      }

      await env.PHOTO_KV.put(`folder:${folder_id}`, JSON.stringify(folder));

      return json({ success: true }, corsHeaders);
    }

    // ==========================================
    // НАЗНАЧЕНИЕ СЕКЦИИ ДЛЯ ФОТО
    // ==========================================
    if (request.method === "PATCH" && url.pathname === "/photos/section") {
      if (!isAdmin) return json({ error: "unauthorized" }, corsHeaders, 401);

      const body = await request.json();
      const { folder_id, photo_id, section_id } = body;
      if (!folder_id || !photo_id) return json({ error: "folder_id and photo_id required" }, corsHeaders, 400);

      const folder = await getFolder(env, folder_id);
      if (!folder) return json({ error: "folder not found" }, corsHeaders, 404);

      const photo = (folder.photos || []).find(p => p.id === photo_id);
      if (!photo) return json({ error: "photo not found" }, corsHeaders, 404);

      if (section_id) photo.section_id = section_id;
      else delete photo.section_id;

      await env.PHOTO_KV.put(`folder:${folder_id}`, JSON.stringify(folder));

      return json({ success: true }, corsHeaders);
    }

    // ==========================================
    // СЕКЦИИ — не изменилось по логике
    // Секции по-прежнему хранятся как sections:FOLDER_ID
    // ==========================================

    if (request.method === "GET" && url.pathname === "/sections") {
      const folderId = url.searchParams.get("folder_id");
      if (!folderId) return json({ error: "folder_id required" }, corsHeaders, 400);

      const data = await env.PHOTO_KV.get(`sections:${folderId}`);
      const sections = data ? JSON.parse(data) : [];
      sections.sort((a, b) => (a.order || 0) - (b.order || 0));
      return json({ sections }, corsHeaders);
    }

    if (request.method === "POST" && url.pathname === "/sections") {
      if (!isAdmin) return json({ error: "unauthorized" }, corsHeaders, 401);

      const body = await request.json();
      const folderId = body.folder_id;
      if (!folderId) return json({ error: "folder_id required" }, corsHeaders, 400);

      const key = `sections:${folderId}`;
      const existing = await env.PHOTO_KV.get(key);
      const sections = existing ? JSON.parse(existing) : [];

      const newSection = {
        id: crypto.randomUUID(),
        title: body.title || 'Новая секция',
        order: sections.length > 0 ? Math.max(...sections.map(s => s.order || 0)) + 1 : 1
      };
      sections.push(newSection);
      await env.PHOTO_KV.put(key, JSON.stringify(sections));
      return json({ success: true, section: newSection }, corsHeaders);
    }

    if (request.method === "PATCH" && url.pathname === "/sections") {
      if (!isAdmin) return json({ error: "unauthorized" }, corsHeaders, 401);

      const body = await request.json();
      const { folder_id, id, title } = body;
      if (!folder_id || !id) return json({ error: "folder_id and id required" }, corsHeaders, 400);

      const key = `sections:${folder_id}`;
      const existing = await env.PHOTO_KV.get(key);
      if (!existing) return json({ error: "not found" }, corsHeaders, 404);

      const sections = JSON.parse(existing);
      const section = sections.find(s => s.id === id);
      if (!section) return json({ error: "section not found" }, corsHeaders, 404);
      if (title !== undefined) section.title = title;
      await env.PHOTO_KV.put(key, JSON.stringify(sections));
      return json({ success: true }, corsHeaders);
    }

    if (request.method === "DELETE" && url.pathname === "/sections") {
      if (!isAdmin) return json({ error: "unauthorized" }, corsHeaders, 401);

      const folderId = url.searchParams.get("folder_id");
      const sectionId = url.searchParams.get("id");
      if (!folderId || !sectionId) return json({ error: "folder_id and id required" }, corsHeaders, 400);

      const key = `sections:${folderId}`;
      const existing = await env.PHOTO_KV.get(key);
      if (existing) {
        const sections = JSON.parse(existing).filter(s => s.id !== sectionId);
        await env.PHOTO_KV.put(key, JSON.stringify(sections));
      }

      // Снимаем секцию с фото которые были в этой секции
      const folder = await getFolder(env, folderId);
      if (folder) {
        for (const p of (folder.photos || [])) {
          if (p.section_id === sectionId) delete p.section_id;
        }
        await env.PHOTO_KV.put(`folder:${folderId}`, JSON.stringify(folder));
      }

      return json({ success: true }, corsHeaders);
    }

    if (request.method === "POST" && url.pathname === "/sections/reorder") {
      if (!isAdmin) return json({ error: "unauthorized" }, corsHeaders, 401);

      const body = await request.json();
      const { folder_id, orders } = body;
      if (!folder_id || !orders) return json({ error: "folder_id and orders required" }, corsHeaders, 400);

      const key = `sections:${folder_id}`;
      const existing = await env.PHOTO_KV.get(key);
      if (!existing) return json({ success: true }, corsHeaders);

      const sections = JSON.parse(existing);
      orders.forEach(item => {
        const s = sections.find(s => s.id === item.id);
        if (s) s.order = item.order;
      });
      await env.PHOTO_KV.put(key, JSON.stringify(sections));
      return json({ success: true }, corsHeaders);
    }

    // ==========================================
    // БЭКАП — обновлён под новую структуру
    // Теперь бэкапим folder:* ключи (каждый содержит и метаданные папки, и все фото)
    // ==========================================
    if (request.method === "POST" && url.pathname === "/admin/backup") {
      if (!isAdmin) return json({ error: "unauthorized" }, corsHeaders, 401);

      const folderList = await env.PHOTO_KV.list({ prefix: `folder:` });
      const data = { folders: [], sections: [], created: new Date().toISOString(), schema: 2 };

      // Читаем папки параллельно группами по 50
      const CHUNK = 50;
      for (let i = 0; i < folderList.keys.length; i += CHUNK) {
        const chunk = folderList.keys.slice(i, i + CHUNK);
        const values = await Promise.all(chunk.map(k => env.PHOTO_KV.get(k.name)));
        chunk.forEach((k, idx) => {
          if (values[idx]) {
            data.folders.push({ key: k.name, value: JSON.parse(values[idx]) });
          }
        });
      }

      // Секции
      const sectionsList = await env.PHOTO_KV.list({ prefix: `sections:` });
      for (let i = 0; i < sectionsList.keys.length; i += CHUNK) {
        const chunk = sectionsList.keys.slice(i, i + CHUNK);
        const values = await Promise.all(chunk.map(k => env.PHOTO_KV.get(k.name)));
        chunk.forEach((k, idx) => {
          if (values[idx]) {
            data.sections.push({ key: k.name, value: JSON.parse(values[idx]) });
          }
        });
      }

      return json({ success: true, backup: data }, corsHeaders);
    }

    // ==========================================
    // ВОССТАНОВЛЕНИЕ ИЗ БЭКАПА
    // Поддерживает оба формата: старый (schema 1) и новый (schema 2)
    // ==========================================
    if (request.method === "POST" && url.pathname === "/admin/restore") {
      if (!isAdmin) return json({ error: "unauthorized" }, corsHeaders, 401);

      const body = await request.json();
      if (!body || !body.folders) {
        return json({ error: "invalid backup format" }, corsHeaders, 400);
      }

      let restoredFolders = 0;
      let restoredPhotos = 0;

      if (body.schema === 2) {
        // Новый формат: folder:ID содержит и папку, и фото
        for (const item of body.folders) {
          if (item.key && item.value) {
            await env.PHOTO_KV.put(item.key, JSON.stringify(item.value));
            restoredFolders++;
            restoredPhotos += (item.value.photos || []).length;
          }
        }
        for (const item of (body.sections || [])) {
          if (item.key && item.value) {
            await env.PHOTO_KV.put(item.key, JSON.stringify(item.value));
          }
        }
      } else {
        // Старый формат (schema 1): folder:ID и photo:ID:photoID отдельно
        // Конвертируем в новый формат при восстановлении
        const foldersMap = {};
        for (const item of body.folders) {
          if (item.key && item.value) {
            const folderId = item.key.replace('folder:', '');
            foldersMap[folderId] = { ...item.value, photos: [], schema: 2 };
            restoredFolders++;
          }
        }
        for (const item of (body.photos || [])) {
          if (item.key && item.value) {
            const parts = item.key.split(':');
            const folderId = parts[1];
            const photoId = parts[2];
            if (foldersMap[folderId]) {
              foldersMap[folderId].photos.push({
                id: photoId,
                file_id: item.value.file_id,
                name: item.value.name,
                date: item.value.date,
                deleted: item.value.deleted || false,
                hidden: item.value.hidden || false,
                order: item.value.order,
                section_id: item.value.section_id,
                schema: 2
              });
              restoredPhotos++;
            }
          }
        }
        for (const [folderId, folderData] of Object.entries(foldersMap)) {
          await env.PHOTO_KV.put(`folder:${folderId}`, JSON.stringify(folderData));
        }
      }

      // Пересобираем индекс
      await rebuildFoldersIndex(env);

      return json({ success: true, restoredFolders, restoredPhotos }, corsHeaders);
    }

    // ==========================================
    // ИНФОРМАЦИЯ О ХРАНИЛИЩЕ (для просмотра в панели)
    // ==========================================
    if (request.method === "GET" && url.pathname === "/admin/storage-info") {
      if (!isAdmin) return json({ error: "unauthorized" }, corsHeaders, 401);

      const foldersIndex = await getFoldersIndex(env);
      const folders = [];
      let totalPhotos = 0;
      let deletedPhotos = 0;

      const folderList = await env.PHOTO_KV.list({ prefix: `folder:` });
      const CHUNK = 50;
      for (let i = 0; i < folderList.keys.length; i += CHUNK) {
        const chunk = folderList.keys.slice(i, i + CHUNK);
        const values = await Promise.all(chunk.map(k => env.PHOTO_KV.get(k.name)));
        chunk.forEach((k, idx) => {
          if (values[idx]) {
            const f = JSON.parse(values[idx]);
            const folderId = k.name.replace('folder:', '');
            const photos = f.photos || [];
            const active = photos.filter(p => !p.deleted).length;
            const del = photos.filter(p => p.deleted).length;
            totalPhotos += active;
            deletedPhotos += del;
            folders.push({ id: folderId, title: f.title, hidden: f.hidden, photo_count: active });
          }
        });
      }

      return json({ success: true, folders, totalPhotos, deletedPhotos }, corsHeaders);
    }

    // ==========================================
    // ОЧИСТКА ХРАНИЛИЩА
    // ==========================================
    if (request.method === "POST" && url.pathname === "/admin/clear-storage") {
      if (!isAdmin) return json({ error: "unauthorized" }, corsHeaders, 401);

      let deletedFolders = 0;
      let deletedPhotos = 0;

      const folderList = await env.PHOTO_KV.list({ prefix: `folder:` });
      for (const key of folderList.keys) {
        const data = await env.PHOTO_KV.get(key.name);
        if (data) {
          const f = JSON.parse(data);
          deletedPhotos += (f.photos || []).length;
        }
        await env.PHOTO_KV.delete(key.name);
        deletedFolders++;
      }

      // Удаляем индекс
      await env.PHOTO_KV.delete('folders_index');

      // Удаляем секции
      const sectionsList = await env.PHOTO_KV.list({ prefix: `sections:` });
      for (const key of sectionsList.keys) {
        await env.PHOTO_KV.delete(key.name);
      }

      return json({ success: true, deletedFolders, deletedPhotos }, corsHeaders);
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  }
};

// ==========================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ==========================================

// Читает одну папку (с фото внутри) из KV
async function getFolder(env, folderId) {
  const data = await env.PHOTO_KV.get(`folder:${folderId}`);
  if (!data) return null;
  return JSON.parse(data);
}

// Читает индекс всех папок (без фото — только метаданные)
// Этот индекс используется для быстрой загрузки главной страницы
async function getFoldersIndex(env) {
  const data = await env.PHOTO_KV.get('folders_index');
  if (data) return JSON.parse(data);

  // Если индекса нет — строим его на лету
  return await rebuildFoldersIndex(env);
}

// Пересобирает индекс папок из актуальных данных
// Вызывается после любого изменения папок
async function rebuildFoldersIndex(env) {
  const list = await env.PHOTO_KV.list({ prefix: `folder:` });
  if (list.keys.length === 0) {
    await env.PHOTO_KV.put('folders_index', JSON.stringify([]));
    return [];
  }

  // Читаем все папки параллельно группами по 50
  const CHUNK = 50;
  const folders = [];
  for (let i = 0; i < list.keys.length; i += CHUNK) {
    const chunk = list.keys.slice(i, i + CHUNK);
    const values = await Promise.all(chunk.map(k => env.PHOTO_KV.get(k.name)));
    chunk.forEach((k, idx) => {
      if (values[idx]) {
        const f = JSON.parse(values[idx]);
        const folderId = k.name.replace('folder:', '');
        const photos = f.photos || [];
        // В индекс кладём только метаданные (БЕЗ массива фото — он нам здесь не нужен)
        folders.push({
          id: folderId,
          title: f.title,
          hidden: f.hidden || false,
          order: f.order || 0,
          cover_url: f.cover_url || null,
          cover_x: f.cover_x !== undefined ? f.cover_x : 50,
          cover_y: f.cover_y !== undefined ? f.cover_y : 50,
          cover_scale: f.cover_scale !== undefined ? f.cover_scale : 100,
          photo_count: photos.filter(p => !p.deleted && !p.hidden).length,
          photo_count_admin: photos.filter(p => !p.deleted).length
        });
      }
    });
  }

  await env.PHOTO_KV.put('folders_index', JSON.stringify(folders));
  return folders;
}

// Обновляет одну папку в индексе (быстро, без полной пересборки)
async function updateFolderInIndex(env, folderId, folderData) {
  const indexData = await env.PHOTO_KV.get('folders_index');
  if (!indexData) return;

  const index = JSON.parse(indexData);
  const existing = index.find(f => f.id === folderId);
  if (!existing) return;

  const photos = folderData.photos || [];
  existing.photo_count = photos.filter(p => !p.deleted && !p.hidden).length;
  existing.photo_count_admin = photos.filter(p => !p.deleted).length;
  existing.hidden = folderData.hidden || false;
  existing.title = folderData.title;
  existing.cover_url = folderData.cover_url || null;
  existing.cover_x = folderData.cover_x !== undefined ? folderData.cover_x : 50;
  existing.cover_y = folderData.cover_y !== undefined ? folderData.cover_y : 50;
  existing.cover_scale = folderData.cover_scale !== undefined ? folderData.cover_scale : 100;

  await env.PHOTO_KV.put('folders_index', JSON.stringify(index));
}

// ==========================================
// ПОЛУЧЕНИЕ ТОКЕНА GOOGLE — с кешированием!
// БЫЛО: каждый запрос = новый JWT + HTTP запрос к Google
// СТАЛО: токен кешируется в KV на 55 минут
// ==========================================
async function getGoogleAccessToken(env) {
  // Проверяем кеш токена
  const cached = await env.PHOTO_KV.get('google_access_token');
  if (cached) return cached;

  const now = Math.floor(Date.now() / 1000);

  const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const claim = btoa(JSON.stringify({
    iss: env.GOOGLE_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const signingInput = `${header}.${claim}`;

  const pemKey = env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
  const keyBody = pemKey
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  const keyBytes = Uint8Array.from(atob(keyBody), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyBytes.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const jwt = `${signingInput}.${sigB64}`;

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });

  const tokenData = await tokenResp.json();
  if (!tokenData.access_token) {
    throw new Error('Не удалось получить токен Google: ' + JSON.stringify(tokenData));
  }

  // Сохраняем токен в KV на 55 минут (токен живёт 60 мин, берём с запасом)
  await env.PHOTO_KV.put('google_access_token', tokenData.access_token, { expirationTtl: 3300 });

  return tokenData.access_token;
}

function json(data, headers, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "Content-Type": "application/json" }
  });
}
