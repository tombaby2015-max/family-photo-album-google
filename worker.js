// worker.js
//
// СТРУКТУРА KV:
//   folder:ABC        → { title, hidden, order, cover_url, ..., photos: [...с thumbnailLink, viewLink] }
//   folders_index     → [ ...все папки для главной страницы ]
//   sections:ABC      → [ ...секции папки ]
//   thumb:FILE_ID     → thumbnailLink (создаётся лениво при первом запросе миниатюры, TTL 30 дней)
//   google_access_token
//   admin_token:XXX
//
// КЛЮЧЕВАЯ ЛОГИКА thumb:
//   /sync — НЕ создаёт thumb: ключи вообще (избегаем лимита KV операций)
//   /photo?size=thumb — при первом запросе сам находит thumbnailLink в папке
//                       и кладёт в KV.put("thumb:FILE_ID", ttl=30д). Один раз. Лениво.
//                       Следующие запросы — мгновенный KV.get без чтения папки.
//   Memory cache (Map) — защита от stampede: повторные запросы в рамках одного
//                        инстанса воркера не делают лишних KV.get
//
// ОРИГИНАЛЫ:
//   Worker больше НЕ проксирует оригинальные фото через alt=media.
//   /sync сохраняет viewLink = thumbnailLink с параметром =w2048 (Google CDN).
//   /photos/urls возвращает drive.google.com/uc?id=FILE_ID&export=download для скачивания.
//   Браузер загружает фото напрямую с серверов Google — без участия Worker.

// Улучшение 1: memory cache против stampede
const thumbMemoryCache = new Map();

export default {
  async fetch(request, env, ctx) {
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
    // ПОКАЗ ФОТО (только миниатюры)
    //
    // size=original и size=view УДАЛЕНЫ.
    // Worker больше не проксирует оригиналы через alt=media.
    // Оригиналы отдаются через viewLink (Google CDN) напрямую браузеру.
    // ==========================================
    if (request.method === "GET" && url.pathname === "/photo") {
      const fileId = url.searchParams.get("id");
      const size   = url.searchParams.get("size") || "thumb";
      const folderId = url.searchParams.get("folder_id") || "";

      if (!fileId) return new Response("id required", { status: 400 });

      // Только миниатюры — остальное браузер грузит напрямую с Google
      if (size !== "thumb") {
        return new Response("Direct Google links should be used for originals", { status: 400, headers: corsHeaders });
      }

      // --- МИНИАТЮРЫ: ленивое кеширование ---

      // 1. Быстрый путь — memory cache (защита от stampede)
      if (thumbMemoryCache.has(fileId)) {
        const thumbUrl = thumbMemoryCache.get(fileId).replace(/=s\d+$/, '=s400');
        const googleResp = await fetch(thumbUrl);
        if (!googleResp.ok) {
          return new Response("Thumbnail not available", { status: 404, headers: corsHeaders });
        }
        return new Response(googleResp.body, {
          headers: {
            ...corsHeaders,
            "Content-Type": googleResp.headers.get("content-type") || "image/jpeg",
            "Cache-Control": "public, max-age=86400",
          }
        });
      }

      // 2. Быстрый путь — уже есть в KV
      const cached = await env.PHOTO_KV.get(`thumb:${fileId}`);
      if (cached) {
        if (cached.startsWith('https://')) {
          thumbMemoryCache.set(fileId, cached);
          const thumbUrl = cached.replace(/=s\d+$/, '=s400');
          const googleResp = await fetch(thumbUrl);
          if (!googleResp.ok) {
            return new Response("Thumbnail not available", { status: 404, headers: corsHeaders });
          }
          return new Response(googleResp.body, {
            headers: {
              ...corsHeaders,
              "Content-Type": googleResp.headers.get("content-type") || "image/jpeg",
              "Cache-Control": "public, max-age=86400",
            }
          });
        }
        // Мусор в KV — удаляем и идём дальше
        ctx.waitUntil(env.PHOTO_KV.delete(`thumb:${fileId}`));
      }

      // 3. Медленный путь — ищем thumbnailLink в папке (один раз за всю жизнь фото)
      let thumbLink = null;

      if (folderId) {
        // Знаем папку — 1 KV.get
        const folder = await getFolder(env, folderId);
        if (folder?.photos) {
          const photo = folder.photos.find(p => p.file_id === fileId);
          if (photo?.thumbnailLink) thumbLink = photo.thumbnailLink;
        }
      }

      if (!thumbLink) {
        // Не знаем папку — перебираем индекс (редкий случай)
        const index = await getFoldersIndex(env);
        for (const meta of index) {
          const folder = await getFolder(env, meta.id);
          if (folder?.photos) {
            const photo = folder.photos.find(p => p.file_id === fileId);
            if (photo?.thumbnailLink) { thumbLink = photo.thumbnailLink; break; }
          }
        }
      }

      if (thumbLink && thumbLink.startsWith('https://')) {
        thumbMemoryCache.set(fileId, thumbLink);

        ctx.waitUntil(
          env.PHOTO_KV.put(`thumb:${fileId}`, thumbLink, { expirationTtl: 60 * 60 * 24 * 30 })
        );

        const thumbUrl = thumbLink.replace(/=s\d+$/, '=s400');
        const googleResp = await fetch(thumbUrl);
        if (!googleResp.ok) {
          return new Response("Thumbnail not available", { status: 404, headers: corsHeaders });
        }
        const contentType = googleResp.headers.get("content-type") || "image/jpeg";
        return new Response(googleResp.body, {
          headers: {
            ...corsHeaders,
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=86400",
          }
        });
      }

      return new Response("Thumbnail not found", { status: 404, headers: corsHeaders });
    }

    // ==========================================
    // СПИСОК ПАПОК
    // ==========================================
    if (request.method === "GET" && url.pathname === "/folders") {
      let folders = await getFoldersIndex(env);
      folders.sort((a, b) => (a.order || 0) - (b.order || 0));
      if (!isAdmin) folders = folders.filter(f => !f.hidden);
      return json({ folders }, corsHeaders);
    }

    // ==========================================
    // СПИСОК ФОТО В ПАПКЕ
    // ==========================================
    if (request.method === "GET" && url.pathname === "/photos/list") {
      const folderId = url.searchParams.get("folder_id");
      if (!folderId) return json({ error: "folder_id required" }, corsHeaders, 400);

      const folder = await getFolder(env, folderId);
      if (!folder) return json({ photos: [] }, corsHeaders);

      let photos = (folder.photos || []).filter(p => {
        if (p.deleted) return false;
        if (!isAdmin && p.hidden) return false;
        return true;
      });

      photos.sort((a, b) => {
        if (a.order !== undefined && b.order !== undefined) return a.order - b.order;
        if (a.order !== undefined) return -1;
        if (b.order !== undefined) return 1;
        return (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' });
      });

      return json({ photos }, corsHeaders);
    }

    // ==========================================
    // ССЫЛКИ ДЛЯ МИНИАТЮР
    // ==========================================
    if (request.method === "POST" && url.pathname === "/photos/thumbnails") {
      const body     = await request.json();
      const photos   = body.photos   || [];
      const folderId = body.folder_id || "";

      const urls = {};
      for (const photo of photos) {
        urls[photo.id] = `${workerBase}/photo?id=${photo.file_id}&size=thumb&folder_id=${folderId}`;
      }
      return json({ urls }, corsHeaders);
    }

    // ==========================================
    // ССЫЛКИ ДЛЯ ПРОСМОТРА И СКАЧИВАНИЯ (оригиналы)
    //
    // Worker больше не проксирует байты.
    // viewLink  — Google CDN (lh3.googleusercontent.com), для показа в браузере.
    // downloadUrl — drive.google.com/uc?export=download, для скачивания.
    // Оба варианта требуют "Anyone with link → Viewer" на папку в Drive.
    // ==========================================
    if (request.method === "POST" && url.pathname === "/photos/urls") {
      const body   = await request.json();
      const photos = body.photos || [];
      const folderId = body.folder_id || "";

      // Читаем папку один раз — нужны viewLink
      let folderPhotosMap = {};
      if (folderId) {
        const folder = await getFolder(env, folderId);
        if (folder?.photos) {
          for (const p of folder.photos) {
            folderPhotosMap[p.file_id] = p;
          }
        }
      }

      const urls = {};
      for (const photo of photos) {
        const stored = folderPhotosMap[photo.file_id];
        // viewLink предпочтительнее — Google CDN, быстро, без OAuth
        // Fallback: drive.google.com/uc (работает для расшаренных файлов)
        const viewUrl = stored?.viewLink
          || `https://drive.google.com/uc?id=${photo.file_id}`;
        urls[photo.id] = viewUrl;
      }
      return json({ urls }, corsHeaders);
    }

    // ==========================================
    // ВХОД В АДМИНКУ
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
    // ⚠️ thumb: ключи здесь НЕ создаются намеренно.
    // thumbnailLink сохраняется только внутри объекта фото в папке.
    // thumb: ключ создастся лениво при первом запросе миниатюры.
    //
    // viewLink формируется из thumbnailLink: меняем параметр размера на =w2048.
    // Это ссылка на Google CDN (lh3.googleusercontent.com) — без OAuth, мгновенно.
    // ==========================================
    if (request.method === "POST" && url.pathname === "/sync") {
      if (!isAdmin) return json({ error: "unauthorized" }, corsHeaders, 401);

      try {
        const accessToken = await getGoogleAccessToken(env);

        const foldersResp = await fetch(
          `https://www.googleapis.com/drive/v3/files?q='${env.DRIVE_FOLDER_ID}'+in+parents+and+mimeType='application/vnd.google-apps.folder'+and+trashed=false&fields=files(id,name)&orderBy=name`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const foldersData  = await foldersResp.json();
        const driveFolders = foldersData.files || [];
        const driveFolderIds = new Set(driveFolders.map(f => f.id));

        let syncedFolders = 0, syncedPhotos = 0, deletedFolders = 0, deletedPhotos = 0;

        const currentIndex = await getFoldersIndex(env);

        for (const existing of currentIndex) {
          if (!driveFolderIds.has(existing.id)) {
            await env.PHOTO_KV.delete(`folder:${existing.id}`);
            await env.PHOTO_KV.delete(`sections:${existing.id}`);
            deletedFolders++;
            deletedPhotos += (existing.photo_count || 0);
          }
        }

        for (const driveFolder of driveFolders) {
          let folderData = await getFolder(env, driveFolder.id);

          if (!folderData) {
            folderData = {
              title: driveFolder.name,
              hidden: false,
              order: 0,
              cover_url: null,
              cover_x: 50,
              cover_y: 50,
              cover_scale: 100,
              photos: [],
              schema: 2
            };
            syncedFolders++;
          }

          const drivePhotos = [];
          let pageToken = null;
          do {
            let photosUrl = `https://www.googleapis.com/drive/v3/files?q='${driveFolder.id}'+in+parents+and+(mimeType='image/jpeg'+or+mimeType='image/png'+or+mimeType='image/heic'+or+mimeType='image/webp')+and+trashed=false&fields=files(id,name,mimeType,createdTime,thumbnailLink)&orderBy=name&pageSize=1000`;
            if (pageToken) photosUrl += `&pageToken=${pageToken}`;
            const photosResp = await fetch(photosUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
            const photosData = await photosResp.json();
            drivePhotos.push(...(photosData.files || []));
            pageToken = photosData.nextPageToken || null;
          } while (pageToken);

          const drivePhotoIds    = new Set(drivePhotos.map(p => p.id));
          const existingPhotosMap = {};
          for (const p of (folderData.photos || [])) existingPhotosMap[p.file_id] = p;

          const newPhotos = [];
          for (const dp of drivePhotos) {
            if (existingPhotosMap[dp.id]) {
              const ep = existingPhotosMap[dp.id];
              if (dp.thumbnailLink) {
                ep.thumbnailLink = dp.thumbnailLink;
                // viewLink = Google CDN, параметр размера w2048 вместо s128
                ep.viewLink = dp.thumbnailLink.replace(/=s\d+$/, '=w2048');
              }
              newPhotos.push(ep);
            } else {
              const np = {
                id: dp.id,
                file_id: dp.id,
                name: dp.name,
                date: dp.createdTime,
                deleted: false,
                hidden: false,
                schema: 2
              };
              if (dp.thumbnailLink) {
                np.thumbnailLink = dp.thumbnailLink;
                // viewLink сохраняется при синхронизации — Worker не нужен для просмотра
                np.viewLink = dp.thumbnailLink.replace(/=s\d+$/, '=w2048');
              }
              newPhotos.push(np);
              syncedPhotos++;
            }
          }

          for (const p of (folderData.photos || [])) {
            if (!drivePhotoIds.has(p.file_id) && !p.deleted) deletedPhotos++;
          }

          folderData.photos = newPhotos;
          await env.PHOTO_KV.put(`folder:${driveFolder.id}`, JSON.stringify(folderData));
        }

        await rebuildFoldersIndex(env);

        return json({ success: true, syncedFolders, syncedPhotos, deletedFolders, deletedPhotos }, corsHeaders);

      } catch (e) {
        console.error('Ошибка синхронизации:', e);
        return json({ error: e.message }, corsHeaders, 500);
      }
    }

    // ==========================================
    // ИЗМЕНЕНИЕ ПАПКИ
    // ==========================================
    if (request.method === "PATCH" && url.pathname === "/folders") {
      if (!isAdmin) return json({ error: "unauthorized" }, corsHeaders, 401);

      const body     = await request.json();
      const folderId = body.id;
      if (!folderId) return json({ error: "id required" }, corsHeaders, 400);

      const folder = await getFolder(env, folderId);
      if (!folder) return json({ error: "folder not found" }, corsHeaders, 404);

      if (body.title       !== undefined) folder.title       = body.title;
      if (body.hidden      !== undefined) folder.hidden      = body.hidden;
      if (body.order       !== undefined) folder.order       = body.order;
      if (body.cover_url   !== undefined) folder.cover_url   = body.cover_url;
      if (body.cover_x     !== undefined) folder.cover_x     = body.cover_x;
      if (body.cover_y     !== undefined) folder.cover_y     = body.cover_y;
      if (body.cover_scale !== undefined) folder.cover_scale = body.cover_scale;

      await env.PHOTO_KV.put(`folder:${folderId}`, JSON.stringify(folder));
      await rebuildFoldersIndex(env);

      return json({ id: folderId, ...folder }, corsHeaders);
    }

    // ==========================================
    // ПОРЯДОК ПАПОК
    // ==========================================
    if (request.method === "POST" && url.pathname === "/folders/reorder") {
      if (!isAdmin) return json({ error: "unauthorized" }, corsHeaders, 401);

      const body   = await request.json();
      const orders = body.orders || [];
      const CHUNK  = 50;

      for (let i = 0; i < orders.length; i += CHUNK) {
        const chunk = orders.slice(i, i + CHUNK);
        await Promise.all(chunk.map(async item => {
          const folder = await getFolder(env, item.id);
          if (folder) {
            folder.order = item.order;
            await env.PHOTO_KV.put(`folder:${item.id}`, JSON.stringify(folder));
          }
        }));
      }

      await rebuildFoldersIndex(env);
      return json({ success: true, updated: orders.length }, corsHeaders);
    }

    // ==========================================
    // СКРЫТИЕ / ПОКАЗ ФОТО
    // ==========================================
    if (request.method === "PATCH" && url.pathname === "/photos") {
      if (!isAdmin) return json({ error: "unauthorized" }, corsHeaders, 401);

      const body     = await request.json();
      const photoId  = body.id;
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
    // УДАЛЕНИЕ ФОТО
    // ==========================================
    if (request.method === "DELETE" && url.pathname === "/photos") {
      if (!isAdmin) return json({ error: "unauthorized" }, corsHeaders, 401);

      const photoId  = url.searchParams.get("id");
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
    // ПОРЯДОК ФОТО
    // ==========================================
    if (request.method === "POST" && url.pathname === "/photos/reorder") {
      if (!isAdmin) return json({ error: "unauthorized" }, corsHeaders, 401);

      const body      = await request.json();
      const { folder_id, orders } = body;
      if (!folder_id || !orders) return json({ error: "folder_id and orders required" }, corsHeaders, 400);

      const folder = await getFolder(env, folder_id);
      if (!folder) return json({ success: true }, corsHeaders);

      const photosMap = {};
      for (const p of (folder.photos || [])) photosMap[p.id] = p;

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
    // СЕКЦИИ
    // ==========================================
    if (request.method === "GET" && url.pathname === "/sections") {
      const folderId = url.searchParams.get("folder_id");
      if (!folderId) return json({ error: "folder_id required" }, corsHeaders, 400);

      const data     = await env.PHOTO_KV.get(`sections:${folderId}`);
      const sections = data ? JSON.parse(data) : [];
      sections.sort((a, b) => (a.order || 0) - (b.order || 0));
      return json({ sections }, corsHeaders);
    }

    if (request.method === "POST" && url.pathname === "/sections") {
      if (!isAdmin) return json({ error: "unauthorized" }, corsHeaders, 401);

      const body     = await request.json();
      const folderId = body.folder_id;
      if (!folderId) return json({ error: "folder_id required" }, corsHeaders, 400);

      const key      = `sections:${folderId}`;
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

      const key      = `sections:${folder_id}`;
      const existing = await env.PHOTO_KV.get(key);
      if (!existing) return json({ error: "not found" }, corsHeaders, 404);

      const sections = JSON.parse(existing);
      const section  = sections.find(s => s.id === id);
      if (!section) return json({ error: "section not found" }, corsHeaders, 404);
      if (title !== undefined) section.title = title;
      await env.PHOTO_KV.put(key, JSON.stringify(sections));
      return json({ success: true }, corsHeaders);
    }

    if (request.method === "DELETE" && url.pathname === "/sections") {
      if (!isAdmin) return json({ error: "unauthorized" }, corsHeaders, 401);

      const folderId  = url.searchParams.get("folder_id");
      const sectionId = url.searchParams.get("id");
      if (!folderId || !sectionId) return json({ error: "folder_id and id required" }, corsHeaders, 400);

      const key      = `sections:${folderId}`;
      const existing = await env.PHOTO_KV.get(key);
      if (existing) {
        const sections = JSON.parse(existing).filter(s => s.id !== sectionId);
        await env.PHOTO_KV.put(key, JSON.stringify(sections));
      }

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

      const key      = `sections:${folder_id}`;
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
    // БЭКАП
    // ==========================================
    if (request.method === "POST" && url.pathname === "/admin/backup") {
      if (!isAdmin) return json({ error: "unauthorized" }, corsHeaders, 401);

      const folderList = await env.PHOTO_KV.list({ prefix: `folder:` });
      const data = { folders: [], sections: [], created: new Date().toISOString(), schema: 2 };
      const CHUNK = 50;

      for (let i = 0; i < folderList.keys.length; i += CHUNK) {
        const chunk  = folderList.keys.slice(i, i + CHUNK);
        const values = await Promise.all(chunk.map(k => env.PHOTO_KV.get(k.name)));
        chunk.forEach((k, idx) => {
          if (values[idx]) data.folders.push({ key: k.name, value: JSON.parse(values[idx]) });
        });
      }

      const sectionsList = await env.PHOTO_KV.list({ prefix: `sections:` });
      for (let i = 0; i < sectionsList.keys.length; i += CHUNK) {
        const chunk  = sectionsList.keys.slice(i, i + CHUNK);
        const values = await Promise.all(chunk.map(k => env.PHOTO_KV.get(k.name)));
        chunk.forEach((k, idx) => {
          if (values[idx]) data.sections.push({ key: k.name, value: JSON.parse(values[idx]) });
        });
      }

      return json({ success: true, backup: data }, corsHeaders);
    }

    // ==========================================
    // ВОССТАНОВЛЕНИЕ ИЗ БЭКАПА
    // ==========================================
    if (request.method === "POST" && url.pathname === "/admin/restore") {
      if (!isAdmin) return json({ error: "unauthorized" }, corsHeaders, 401);

      const body = await request.json();
      if (!body?.folders) return json({ error: "invalid backup format" }, corsHeaders, 400);

      let restoredFolders = 0, restoredPhotos = 0;

      if (body.schema === 2) {
        for (const item of body.folders) {
          if (item.key && item.value) {
            await env.PHOTO_KV.put(item.key, JSON.stringify(item.value));
            restoredFolders++;
            restoredPhotos += (item.value.photos || []).length;
          }
        }
        for (const item of (body.sections || [])) {
          if (item.key && item.value) await env.PHOTO_KV.put(item.key, JSON.stringify(item.value));
        }
      } else {
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
            const parts    = item.key.split(':');
            const folderId = parts[1];
            const photoId  = parts[2];
            if (foldersMap[folderId]) {
              foldersMap[folderId].photos.push({
                id: photoId, file_id: item.value.file_id, name: item.value.name,
                date: item.value.date, deleted: item.value.deleted || false,
                hidden: item.value.hidden || false, order: item.value.order,
                section_id: item.value.section_id, schema: 2
              });
              restoredPhotos++;
            }
          }
        }
        for (const [folderId, folderData] of Object.entries(foldersMap)) {
          await env.PHOTO_KV.put(`folder:${folderId}`, JSON.stringify(folderData));
        }
      }

      await rebuildFoldersIndex(env);
      return json({ success: true, restoredFolders, restoredPhotos }, corsHeaders);
    }

    // ==========================================
    // ИНФОРМАЦИЯ О ХРАНИЛИЩЕ
    // ==========================================
    if (request.method === "GET" && url.pathname === "/admin/storage-info") {
      if (!isAdmin) return json({ error: "unauthorized" }, corsHeaders, 401);

      const folderList = await env.PHOTO_KV.list({ prefix: `folder:` });
      const folders = [];
      let totalPhotos = 0, deletedPhotos = 0;
      const CHUNK = 50;

      for (let i = 0; i < folderList.keys.length; i += CHUNK) {
        const chunk  = folderList.keys.slice(i, i + CHUNK);
        const values = await Promise.all(chunk.map(k => env.PHOTO_KV.get(k.name)));
        chunk.forEach((k, idx) => {
          if (values[idx]) {
            const f        = JSON.parse(values[idx]);
            const folderId = k.name.replace('folder:', '');
            const photos   = f.photos || [];
            const active   = photos.filter(p => !p.deleted).length;
            const del      = photos.filter(p => p.deleted).length;
            totalPhotos   += active;
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

      let deletedFolders = 0, deletedPhotos = 0;

      const folderList = await env.PHOTO_KV.list({ prefix: `folder:` });
      for (const key of folderList.keys) {
        const data = await env.PHOTO_KV.get(key.name);
        if (data) deletedPhotos += (JSON.parse(data).photos || []).length;
        await env.PHOTO_KV.delete(key.name);
        deletedFolders++;
      }

      await env.PHOTO_KV.delete('folders_index');

      const thumbList = await env.PHOTO_KV.list({ prefix: `thumb:` });
      for (const key of thumbList.keys) await env.PHOTO_KV.delete(key.name);

      const sectionsList = await env.PHOTO_KV.list({ prefix: `sections:` });
      for (const key of sectionsList.keys) await env.PHOTO_KV.delete(key.name);

      return json({ success: true, deletedFolders, deletedPhotos }, corsHeaders);
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  }
};

// ==========================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ==========================================

async function getFolder(env, folderId) {
  const data = await env.PHOTO_KV.get(`folder:${folderId}`);
  if (!data) return null;
  return JSON.parse(data);
}

async function getFoldersIndex(env) {
  const data = await env.PHOTO_KV.get('folders_index');
  if (data) return JSON.parse(data);
  return await rebuildFoldersIndex(env);
}

async function rebuildFoldersIndex(env) {
  const list = await env.PHOTO_KV.list({ prefix: `folder:` });
  if (list.keys.length === 0) {
    await env.PHOTO_KV.put('folders_index', JSON.stringify([]));
    return [];
  }

  const CHUNK = 50;
  const folders = [];
  for (let i = 0; i < list.keys.length; i += CHUNK) {
    const chunk  = list.keys.slice(i, i + CHUNK);
    const values = await Promise.all(chunk.map(k => env.PHOTO_KV.get(k.name)));
    chunk.forEach((k, idx) => {
      if (values[idx]) {
        const f        = JSON.parse(values[idx]);
        const folderId = k.name.replace('folder:', '');
        const photos   = f.photos || [];
        folders.push({
          id:              folderId,
          title:           f.title,
          hidden:          f.hidden || false,
          order:           f.order  || 0,
          cover_url:       f.cover_url   || null,
          cover_x:         f.cover_x     !== undefined ? f.cover_x     : 50,
          cover_y:         f.cover_y     !== undefined ? f.cover_y     : 50,
          cover_scale:     f.cover_scale !== undefined ? f.cover_scale : 100,
          photo_count:       photos.filter(p => !p.deleted && !p.hidden).length,
          photo_count_admin: photos.filter(p => !p.deleted).length
        });
      }
    });
  }

  await env.PHOTO_KV.put('folders_index', JSON.stringify(folders));
  return folders;
}

async function updateFolderInIndex(env, folderId, folderData) {
  const indexData = await env.PHOTO_KV.get('folders_index');
  if (!indexData) return;

  const index    = JSON.parse(indexData);
  const existing = index.find(f => f.id === folderId);
  if (!existing) return;

  const photos = folderData.photos || [];
  existing.photo_count       = photos.filter(p => !p.deleted && !p.hidden).length;
  existing.photo_count_admin = photos.filter(p => !p.deleted).length;
  existing.hidden      = folderData.hidden      || false;
  existing.title       = folderData.title;
  existing.cover_url   = folderData.cover_url   || null;
  existing.cover_x     = folderData.cover_x     !== undefined ? folderData.cover_x     : 50;
  existing.cover_y     = folderData.cover_y     !== undefined ? folderData.cover_y     : 50;
  existing.cover_scale = folderData.cover_scale !== undefined ? folderData.cover_scale : 100;

  await env.PHOTO_KV.put('folders_index', JSON.stringify(index));
}

async function getGoogleAccessToken(env) {
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

  const pemKey  = env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
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
    'RSASSA-PKCS1-v1_5', cryptoKey,
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

  await env.PHOTO_KV.put('google_access_token', tokenData.access_token, { expirationTtl: 3300 });
  return tokenData.access_token;
}

function json(data, headers, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "Content-Type": "application/json" }
  });
}
