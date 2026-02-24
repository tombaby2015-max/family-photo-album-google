// СЕРВЕРНАЯ ЧАСТЬ САЙТА — Google Drive версия

export default {
  async fetch(request, env, ctx) {
    console.log('=== Запрос:', request.method, request.url);

    // Разрешаем сайту обращаться к серверу
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (!env.PHOTO_KV) {
      return json({ error: "KV not bound" }, corsHeaders, 500);
    }

    // Проверяем, залогинен ли администратор
    const authHeader = request.headers.get("Authorization");
    const token = authHeader ? authHeader.replace("Bearer ", "") : null;
    const isAdmin = token ? !!(await env.PHOTO_KV.get(`admin_token:${token}`)) : false;

    // ==========================================
    // СИНХРОНИЗАЦИЯ С GOOGLE DRIVE
    // ==========================================
    // Читает папки и фото из вашего Google Drive
    // и сохраняет их в KV-хранилище
    if (request.method === "POST" && url.pathname === "/sync") {
      if (!isAdmin) return json({ error: "unauthorized" }, corsHeaders, 401);

      try {
        // Получаем токен доступа к Google Drive
        const accessToken = await getGoogleAccessToken(env);

        // Получаем список папок внутри главной папки
        const foldersResp = await fetch(
          `https://www.googleapis.com/drive/v3/files?q='${env.DRIVE_FOLDER_ID}'+in+parents+and+mimeType='application/vnd.google-apps.folder'+and+trashed=false&fields=files(id,name)&orderBy=name`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const foldersData = await foldersResp.json();
        const driveFolders = foldersData.files || [];

        let syncedFolders = 0;
        let syncedPhotos = 0;

        for (const driveFolder of driveFolders) {
          // Проверяем, есть ли уже эта папка в нашем хранилище
          const folderKey = `folder:${driveFolder.id}`;
          const existing = await env.PHOTO_KV.get(folderKey);

          if (!existing) {
            // Новая папка — создаём запись
            const folderData = {
              title: driveFolder.name,
              hidden: false,
              order: 0,
              cover_url: null,
              cover_x: 50,
              cover_y: 50,
              cover_scale: 100,
              schema: 1
            };
            await env.PHOTO_KV.put(folderKey, JSON.stringify(folderData));
            syncedFolders++;
          }

          // Получаем фото из этой папки
          let pageToken = null;
          do {
            let photosUrl = `https://www.googleapis.com/drive/v3/files?q='${driveFolder.id}'+in+parents+and+(mimeType='image/jpeg'+or+mimeType='image/png'+or+mimeType='image/heic'+or+mimeType='image/webp')+and+trashed=false&fields=files(id,name,mimeType,createdTime)&orderBy=createdTime&pageSize=100`;
            if (pageToken) photosUrl += `&pageToken=${pageToken}`;

            const photosResp = await fetch(photosUrl, {
              headers: { Authorization: `Bearer ${accessToken}` }
            });
            const photosData = await photosResp.json();
            const drivePhotos = photosData.files || [];

            for (const drivePhoto of drivePhotos) {
              const photoKey = `photo:${driveFolder.id}:${drivePhoto.id}`;
              const existingPhoto = await env.PHOTO_KV.get(photoKey);

              if (!existingPhoto) {
                const photoData = {
                  file_id: drivePhoto.id,
                  name: drivePhoto.name,
                  date: drivePhoto.createdTime,
                  deleted: false,
                  hidden: false,
                  schema: 1
                };
                await env.PHOTO_KV.put(photoKey, JSON.stringify(photoData));
                syncedPhotos++;
              }
            }

            pageToken = photosData.nextPageToken || null;
          } while (pageToken);
        }

        return json({ success: true, syncedFolders, syncedPhotos }, corsHeaders);

      } catch (e) {
        console.error('Ошибка синхронизации:', e);
        return json({ error: e.message }, corsHeaders, 500);
      }
    }

    // ==========================================
    // СПИСОК ПАПОК
    // ==========================================
    if (request.method === "GET" && url.pathname === "/folders") {
      const list = await env.PHOTO_KV.list({ prefix: `folder:` });
      let folders = [];

      for (const key of list.keys) {
        const data = await env.PHOTO_KV.get(key.name);
        if (data) {
          const folder = JSON.parse(data);
          const folderId = key.name.replace('folder:', '');
          folders.push({ id: folderId, ...folder });
        }
      }

      folders.sort((a, b) => (a.order || 0) - (b.order || 0));

      if (!isAdmin) {
        folders = folders.filter(f => !f.hidden);
      }

      return json({ folders }, corsHeaders);
    }

    // ==========================================
    // СПИСОК ФОТО В ПАПКЕ
    // ==========================================
    if (request.method === "GET" && url.pathname === "/photos/list") {
      const folderId = url.searchParams.get("folder_id");
      if (!folderId) return json({ error: "folder_id required" }, corsHeaders, 400);

      const list = await env.PHOTO_KV.list({ prefix: `photo:${folderId}:` });
      let photos = [];

      for (const key of list.keys) {
        const data = await env.PHOTO_KV.get(key.name);
        if (data) {
          const photo = JSON.parse(data);
          if (!photo.deleted && (isAdmin || !photo.hidden)) {
            const photoId = key.name.split(':')[2];
            photos.push({ id: photoId, ...photo });
          }
        }
      }

      photos.sort((a, b) => new Date(a.date) - new Date(b.date));

      return json({ photos }, corsHeaders);
    }

    // ==========================================
    // ССЫЛКИ НА ФОТО (через Google Drive)
    // ==========================================
    // Возвращает прямые ссылки на оригинальные фото
    if (request.method === "POST" && url.pathname === "/photos/urls") {
      const body = await request.json();
      const photos = body.photos || [];

      const urls = {};
      for (const photo of photos) {
        // Прямая ссылка на скачивание оригинала из Google Drive
        urls[photo.id] = `https://drive.google.com/uc?export=download&id=${photo.file_id}`;
      }

      return json({ urls }, corsHeaders);
    }

    // ==========================================
    // ССЫЛКИ ДЛЯ ПРОСМОТРА (уменьшенные, быстрые)
    // ==========================================
    if (request.method === "POST" && url.pathname === "/photos/thumbnails") {
      const body = await request.json();
      const photos = body.photos || [];

      const urls = {};
      for (const photo of photos) {
        // Ссылка для быстрого просмотра (Google сам отдаёт уменьшенную копию)
        urls[photo.id] = `https://drive.google.com/thumbnail?id=${photo.file_id}&sz=w800`;
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
    // ИЗМЕНЕНИЕ ПАПКИ (название, скрытость, обложка, порядок)
    // ==========================================
    if (request.method === "PATCH" && url.pathname === "/folders") {
      if (!isAdmin) return json({ error: "unauthorized" }, corsHeaders, 401);

      const body = await request.json();
      const folderId = body.id;
      if (!folderId) return json({ error: "id required" }, corsHeaders, 400);

      const key = `folder:${folderId}`;
      const existing = await env.PHOTO_KV.get(key);
      if (!existing) return json({ error: "folder not found" }, corsHeaders, 404);

      const folder = JSON.parse(existing);
      if (body.title !== undefined) folder.title = body.title;
      if (body.hidden !== undefined) folder.hidden = body.hidden;
      if (body.order !== undefined) folder.order = body.order;
      if (body.cover_url !== undefined) folder.cover_url = body.cover_url;
      if (body.cover_x !== undefined) folder.cover_x = body.cover_x;
      if (body.cover_y !== undefined) folder.cover_y = body.cover_y;
      if (body.cover_scale !== undefined) folder.cover_scale = body.cover_scale;

      await env.PHOTO_KV.put(key, JSON.stringify(folder));
      return json({ id: folderId, ...folder }, corsHeaders);
    }

    // ==========================================
    // ИЗМЕНЕНИЕ ПОРЯДКА ПАПОК
    // ==========================================
    if (request.method === "POST" && url.pathname === "/folders/reorder") {
      if (!isAdmin) return json({ error: "unauthorized" }, corsHeaders, 401);

      const body = await request.json();
      const orders = body.orders || [];

      for (const item of orders) {
        const key = `folder:${item.id}`;
        const existing = await env.PHOTO_KV.get(key);
        if (existing) {
          const folder = JSON.parse(existing);
          folder.order = item.order;
          await env.PHOTO_KV.put(key, JSON.stringify(folder));
        }
      }

      return json({ success: true, updated: orders.length }, corsHeaders);
    }

    // ==========================================
    // СКРЫТИЕ / ПОКАЗ ФОТО
    // ==========================================
    if (request.method === "PATCH" && url.pathname === "/photos") {
      if (!isAdmin) return json({ error: "unauthorized" }, corsHeaders, 401);

      const body = await request.json();
      const photoId = body.id;
      const folderId = body.folder_id;
      if (!photoId || !folderId) return json({ error: "id and folder_id required" }, corsHeaders, 400);

      const key = `photo:${folderId}:${photoId}`;
      const existing = await env.PHOTO_KV.get(key);
      if (!existing) return json({ error: "photo not found" }, corsHeaders, 404);

      const photo = JSON.parse(existing);
      if (body.hidden !== undefined) photo.hidden = body.hidden;
      await env.PHOTO_KV.put(key, JSON.stringify(photo));

      return json({ success: true, id: photoId, hidden: photo.hidden }, corsHeaders);
    }

    // ==========================================
    // УДАЛЕНИЕ ФОТО (помечаем как удалённое)
    // ==========================================
    if (request.method === "DELETE" && url.pathname === "/photos") {
      if (!isAdmin) return json({ error: "unauthorized" }, corsHeaders, 401);

      const photoId = url.searchParams.get("id");
      const folderId = url.searchParams.get("folder_id");
      if (!photoId || !folderId) return json({ error: "id and folder_id required" }, corsHeaders, 400);

      const key = `photo:${folderId}:${photoId}`;
      const existing = await env.PHOTO_KV.get(key);
      if (existing) {
        const photo = JSON.parse(existing);
        photo.deleted = true;
        await env.PHOTO_KV.put(key, JSON.stringify(photo));
      }

      return json({ success: true }, corsHeaders);
    }

    // ==========================================
    // ИНФОРМАЦИЯ О ХРАНИЛИЩЕ
    // ==========================================
    if (request.method === "GET" && url.pathname === "/admin/storage-info") {
      if (!isAdmin) return json({ error: "unauthorized" }, corsHeaders, 401);

      const folders = [];
      const photos = [];

      const folderList = await env.PHOTO_KV.list({ prefix: `folder:` });
      for (const key of folderList.keys) {
        const data = await env.PHOTO_KV.get(key.name);
        if (data) {
          const folder = JSON.parse(data);
          const folderId = key.name.replace('folder:', '');
          folders.push({ id: folderId, ...folder });
        }
      }

      const photoList = await env.PHOTO_KV.list({ prefix: `photo:` });
      for (const key of photoList.keys) {
        const data = await env.PHOTO_KV.get(key.name);
        if (data) {
          const photo = JSON.parse(data);
          const parts = key.name.split(':');
          photos.push({ id: parts[2], folder_id: parts[1], ...photo });
        }
      }

      return json({ success: true, folders, photos }, corsHeaders);
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
        await env.PHOTO_KV.delete(key.name);
        deletedFolders++;
      }

      const photoList = await env.PHOTO_KV.list({ prefix: `photo:` });
      for (const key of photoList.keys) {
        await env.PHOTO_KV.delete(key.name);
        deletedPhotos++;
      }

      return json({ success: true, deletedFolders, deletedPhotos }, corsHeaders);
    }

    // ==========================================
    // БЭКАП
    // ==========================================
    if (request.method === "POST" && url.pathname === "/admin/backup") {
      if (!isAdmin) return json({ error: "unauthorized" }, corsHeaders, 401);

      const list = await env.PHOTO_KV.list();
      const data = { folders: [], photos: [], created: new Date().toISOString() };

      for (const key of list.keys) {
        if (key.name.startsWith('folder:')) {
          const value = await env.PHOTO_KV.get(key.name);
          if (value) data.folders.push({ key: key.name, value: JSON.parse(value) });
        } else if (key.name.startsWith('photo:')) {
          const value = await env.PHOTO_KV.get(key.name);
          if (value) data.photos.push({ key: key.name, value: JSON.parse(value) });
        }
      }

      return json({ success: true, backup: data }, corsHeaders);
    }

    // ==========================================
    // ВОССТАНОВЛЕНИЕ ИЗ БЭКАПА
    // ==========================================
    if (request.method === "POST" && url.pathname === "/admin/restore") {
      if (!isAdmin) return json({ error: "unauthorized" }, corsHeaders, 401);

      const body = await request.json();
      if (!body || !body.folders || !body.photos) {
        return json({ error: "invalid backup format" }, corsHeaders, 400);
      }

      let restoredFolders = 0;
      let restoredPhotos = 0;

      for (const item of body.folders) {
        if (item.key && item.value) {
          await env.PHOTO_KV.put(item.key, JSON.stringify(item.value));
          restoredFolders++;
        }
      }

      for (const item of body.photos) {
        if (item.key && item.value) {
          await env.PHOTO_KV.put(item.key, JSON.stringify(item.value));
          restoredPhotos++;
        }
      }

      return json({ success: true, restoredFolders, restoredPhotos }, corsHeaders);
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  }
};

// ==========================================
// ПОЛУЧЕНИЕ ТОКЕНА GOOGLE (технический блок)
// ==========================================
async function getGoogleAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);

  const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const claim = btoa(JSON.stringify({
    iss: env.GOOGLE_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const signingInput = `${header}.${claim}`;

  // Готовим ключ
  const pemKey = env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
  const keyBody = pemKey.replace('-----BEGIN PRIVATE KEY-----', '')
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
  if (!tokenData.access_token) throw new Error('Не удалось получить токен Google: ' + JSON.stringify(tokenData));

  return tokenData.access_token;
}

function json(data, headers, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "Content-Type": "application/json" }
  });
}
