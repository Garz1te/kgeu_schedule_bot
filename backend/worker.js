const ADMIN_IDS = [1116707989];

const ALLOWED_PROXY_PATHS = new Set([
  '/rasp',
  '/raspGrouplist',
  '/raspTeacherlist',
  '/raspAudlist',
  '/group',
  '/teacher',
  '/aud'
]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const corsOrigin = getAllowedOrigin(env, origin);

    if (request.method === 'OPTIONS') {
      return handleCors(corsOrigin);
    }

    try {
      if (url.pathname === '/webhook' && request.method === 'POST') {
        return await handleTelegramWebhook(request, env, ctx);
      }

      if (url.pathname === '/' || url.pathname === '') {
        return textResponse('KGEU Schedule Bot Worker is running.', corsOrigin);
      }

      if (url.pathname === '/api/health') {
        return jsonResponse({ ok: true, time: new Date().toISOString() }, 200, corsOrigin);
      }

      if (url.pathname.startsWith('/api/')) {
        return await handleApi(request, env, ctx, url, corsOrigin);
      }

      return textResponse('Not found', corsOrigin, 404);
    } catch (err) {
      console.error('Worker error:', err);
      await safeLog(env, 'ERROR', String(err?.message || err));
      return jsonResponse({ ok: false, error: 'INTERNAL_ERROR' }, 500, corsOrigin);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(ensureSchema(env));
    ctx.waitUntil(processReminders(env));
    ctx.waitUntil(cleanupDatabase(env));
    ctx.waitUntil(buildLists(env, false));
  }
};

// =====================================================
// CORS / responses
// =====================================================

function getAllowedOrigin(env, origin) {
  if (!origin) return '*';

  const allowed = [
    'https://garz1te.github.io',
    'https://web.telegram.org',
    'https://telegram.org'
  ];

  try {
    if (env.WEBAPP_URL) {
      allowed.push(new URL(env.WEBAPP_URL).origin);
    }
  } catch (e) {}

  if (allowed.some(item => origin.startsWith(item))) {
    return origin;
  }

  return 'null';
}

function handleCors(corsOrigin) {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Telegram-Init-Data',
      'Access-Control-Max-Age': '86400'
    }
  });
}

function jsonResponse(data, status = 200, corsOrigin = '*') {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': corsOrigin,
      'Cache-Control': 'no-store'
    }
  });
}

function textResponse(text, corsOrigin = '*', status = 200) {
  return new Response(text, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Access-Control-Allow-Origin': corsOrigin
    }
  });
}

// =====================================================
// Utils
// =====================================================

function getAcademicYearParam() {
  const now = new Date();
  const year = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  return `year=${year}-${year + 1}`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 10000) {
  const res = await fetchWithTimeout(url, options, timeoutMs);
  const text = await res.text();

  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Non-JSON response from ${url}`);
  }
}

async function safeLog(env, type, payload) {
  try {
    await env.DB.prepare(
      `INSERT INTO system_logs (event_type, payload) VALUES (?, ?)`
    )
      .bind(type, String(payload || '').slice(0, 1000))
      .run();
  } catch (e) {
    console.error('safeLog error:', e);
  }
}

async function logAdmin(env, adminId, action, payload = '') {
  try {
    await env.DB.prepare(
      `INSERT INTO admin_events (admin_id, action, payload) VALUES (?, ?, ?)`
    )
      .bind(adminId, action, typeof payload === 'string' ? payload : JSON.stringify(payload))
      .run();
  } catch (e) {
    console.error('logAdmin error:', e);
  }
}

function parseHM(v) {
  const m = String(v || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = +m[1];
  const mm = +m[2];
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
}

function parseTimeServer(str) {
  if (!str) return null;
  const m = String(str).match(/(\d{1,2})[:.](\d{2})\s*[-–—]\s*(\d{1,2})[:.](\d{2})/);
  if (!m) return null;
  return {
    start: parseInt(m[1], 10) * 60 + parseInt(m[2], 10),
    end: parseInt(m[3], 10) * 60 + parseInt(m[4], 10)
  };
}

function extractLessonsServer(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.data?.rasp)) return data.data.rasp;
  if (Array.isArray(data.rasp)) return data.rasp;
  for (const k of ['data', 'items', 'lessons', 'schedule', 'result']) {
    if (Array.isArray(data[k])) return data[k];
  }
  return [];
}

function serverLessonTime(l) {
  return l.time || l.Time || l.time_range || l.period || l.Время || l.время || l['датаНачала'] || '';

}

function serverRoom(l) {
  return l.room || l.Room || l.auditorium || l.aud || l.Аудитория || l.аудитория || '';

}

// =====================================================
// Telegram initData verification
// =====================================================

async function verifyTelegramInitData(env, initData) {
  try {
    if (!env.BOT_TOKEN || !initData) return null;

    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;

    params.delete('hash');

    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (authDate && (Date.now() / 1000 - authDate) > 86400) {
      return null;
    }

    const pairs = [];
    for (const [key, value] of params.entries()) {
      pairs.push(`${key}=${value}`);
    }
    pairs.sort();

    const dataCheckString = pairs.join('\n');
    const encoder = new TextEncoder();

    const webAppKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode('WebAppData'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const secret = await crypto.subtle.sign(
      'HMAC',
      webAppKey,
      encoder.encode(env.BOT_TOKEN)
    );

    const key = await crypto.subtle.importKey(
      'raw',
      secret,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signature = await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(dataCheckString)
    );

    const hex = [...new Uint8Array(signature)]
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    if (hex !== hash) return null;

    const userRaw = params.get('user');
    if (!userRaw) return null;

    const user = JSON.parse(userRaw);
    if (!user?.id) return null;

    return user;
  } catch (e) {
    console.error('verifyTelegramInitData error:', e);
    return null;
  }
}

async function requireUser(request, env) {
  const initData = request.headers.get('X-Telegram-Init-Data') || '';
  const user = await verifyTelegramInitData(env, initData);
  if (!user?.id) return null;

  try {
    const row = await env.DB.prepare(
      `SELECT banned FROM app_users WHERE telegram_id = ?`
    )
      .bind(user.id)
      .first();

    if (row?.banned) return null;
  } catch (e) {}

  return user;
}

async function requireAdmin(request, env) {
  const user = await requireUser(request, env);
  if (!user?.id) return null;
  if (!ADMIN_IDS.includes(Number(user.id))) return null;
  return user;
}

// =====================================================
// Telegram webhook
// =====================================================

async function handleTelegramWebhook(request, env, ctx) {
  try {
    const update = await request.json();

    const from = update?.message?.from;
    const text = update?.message?.text || '';

    if (from?.id) {
      await upsertUserFromTelegram(env, from);
    }

    if (text.trim().startsWith('/start') && update?.message?.chat?.id) {
      const userId = from?.id;

      let banned = 0;
      if (userId) {
        const row = await env.DB.prepare(
          `SELECT banned FROM app_users WHERE telegram_id = ?`
        )
          .bind(userId)
          .first()
          .catch(() => null);

        banned = row?.banned || 0;
      }

      if (!banned) {
        const webAppUrl = env.WEBAPP_URL || 'https://garz1te.github.io/kgeu_schedule_bot';

        await sendTelegramMessage(
          env.BOT_TOKEN,
          update.message.chat.id,
          'Привет! Открой расписание КГЭУ ниже 👇',
          {
            inline_keyboard: [
              [
                {
                  text: '📅 Открыть расписание',
                  web_app: { url: webAppUrl }
                }
              ]
            ]
          }
        );
      }
    }

    return textResponse('OK');
  } catch (e) {
    console.error('Webhook error:', e);
    return textResponse('OK');
  }
}

async function upsertUserFromTelegram(env, from) {
  try {
    await env.DB.prepare(
      `INSERT INTO app_users (
        telegram_id, username, first_name, last_name, updated_at
      ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(telegram_id) DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        updated_at = CURRENT_TIMESTAMP`
    )
      .bind(
        from.id,
        from.username || '',
        from.first_name || '',
        from.last_name || ''
      )
      .run();
  } catch (e) {
    console.error('upsertUserFromTelegram error:', e);
  }
}

async function sendTelegramMessage(token, chatId, text, replyMarkup = null) {
  if (!token || !chatId || !text) return false;

  const body = {
    chat_id: chatId,
    text
  };

  if (replyMarkup) body.reply_markup = replyMarkup;

  try {
    const res = await fetchWithTimeout(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, 10000);

    return res.ok;
  } catch (e) {
    console.error('sendTelegramMessage error:', e);
    return false;
  }
}

// =====================================================
// API router
// =====================================================

async function handleApi(request, env, ctx, url, corsOrigin) {
  const subPath = url.pathname.replace(/^\/api/, '') || '/';
  const forceFresh = url.searchParams.get('fresh') === '1';

  if (subPath === '/user/sync') {
    return await handleUserSync(request, env, corsOrigin);
  }

  if (subPath.startsWith('/tasks')) {
    return await handleTasks(request, env, url, corsOrigin);
  }

  if (subPath.startsWith('/reminders')) {
    return await handleReminders(request, env, url, corsOrigin);
  }

  if (subPath.startsWith('/admin')) {
    return await handleAdmin(request, env, subPath, corsOrigin);
  }

  if (subPath === '/free-auds') {
    return await handleFreeAuds(env, url, corsOrigin);
  }

  if (subPath === '/lists') {
    return await handleLists(request, env, ctx, corsOrigin, forceFresh);
  }

  if (ALLOWED_PROXY_PATHS.has(subPath) || subPath.toLowerCase() === '/rasp') {
    return await handleProxy(request, env, ctx, url, subPath, corsOrigin, forceFresh);
  }

  return jsonResponse({ ok: false, error: 'NOT_FOUND' }, 404, corsOrigin);
}

// =====================================================
// Free classrooms
// =====================================================

async function handleFreeAuds(env, url, corsOrigin) {
  const date = url.searchParams.get('date') || '';
  const start = url.searchParams.get('start') || '';
  const end = url.searchParams.get('end') || '';

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return jsonResponse({ ok: false, error: 'BAD_DATE' }, 400, corsOrigin);
  }

  const startMin = parseHM(start);
  const endMin = parseHM(end);

  if (startMin === null || endMin === null || endMin <= startMin) {
    return jsonResponse({ ok: false, error: 'BAD_TIME' }, 400, corsOrigin);
  }

  const cacheKey = `/api/free-auds?date=${date}&start=${start}&end=${end}`;

  const fresh = await env.DB.prepare(
    `SELECT schedule_data FROM schedule_cache
     WHERE cache_key = ? AND updated_at >= datetime('now', '-90 seconds')`
  )
    .bind(cacheKey)
    .first()
    .catch(() => null);

  if (fresh?.schedule_data) {
    try {
      return jsonResponse(JSON.parse(fresh.schedule_data), 200, corsOrigin);
    } catch (e) {}
  }

  const lists = await buildLists(env, false);
  const auds = lists.Aud || [];

  if (!auds.length) {
    return jsonResponse({ ok: false, error: 'NO_AUDS' }, 502, corsOrigin);
  }

  let lessons = [];

  try {
    const data = await fetchJsonWithTimeout(
      `${env.KABINET_API}/Rasp?date=${encodeURIComponent(date)}`,
      {
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://kabinet.kgeu.ru/'
        }
      },
      15000
    );

    lessons = extractLessonsServer(data);
  } catch (e) {
    console.error('free-auds external error:', e);
    return jsonResponse({
      ok: false,
      error: 'EXTERNAL_API_UNAVAILABLE'
    }, 502, corsOrigin);
  }

  const busyNames = new Set();
  const busyIds = new Set();

  for (const l of lessons) {
    const t = parseTimeServer(serverLessonTime(l));
    if (!t) continue;

    if (t.start < endMin && t.end > startMin) {
      const room = String(serverRoom(l) || '').trim();
      if (room) busyNames.add(room.toLowerCase());

      const roomId = l.audId ?? l.aud_id ?? l.idAud ?? null;
      if (roomId !== null && roomId !== undefined) busyIds.add(String(roomId));
    }
  }

  const free = auds.filter(a => {
    const name = String(a.name || '').trim().toLowerCase();
    const id = String(a.id || '');
    return !busyNames.has(name) && !busyIds.has(id);
  });

  const result = {
    ok: true,
    date,
    start,
    end,
    total: auds.length,
    busy: auds.length - free.length,
    free: free.slice(0, 100)
  };

  await saveCache(env, cacheKey, JSON.stringify(result));

  return jsonResponse(result, 200, corsOrigin);
}

// =====================================================
// Lists
// =====================================================

async function handleLists(request, env, ctx, corsOrigin, forceFresh) {
  try {
    const data = await buildLists(env, forceFresh);
    return jsonResponse(data, 200, corsOrigin);
  } catch (e) {
    console.error('Lists error:', e);
    await safeLog(env, 'ERROR', `lists: ${e?.message || e}`);

    const stale = await getCache(env, '/api/lists');
    if (stale) {
      try {
        return jsonResponse(JSON.parse(stale), 200, corsOrigin);
      } catch (e2) {}
    }

    return jsonResponse({ Group: [], Teacher: [], Aud: [] }, 200, corsOrigin);
  }
}

async function buildLists(env, forceFresh = false) {
  const cacheKey = '/api/lists';

  if (!forceFresh) {
    const row = await env.DB.prepare(
      `SELECT schedule_data FROM schedule_cache
       WHERE cache_key = ? AND updated_at >= datetime('now', '-6 hours')`
    )
      .bind(cacheKey)
      .first()
      .catch(() => null);

    if (row?.schedule_data) {
      try {
        return JSON.parse(row.schedule_data);
      } catch (e) {}
    }
  }

  const yearParam = getAcademicYearParam();

  const [groupsRes, teachersRes, audsRes] = await Promise.allSettled([
    fetchJsonWithTimeout(`${env.KABINET_API}/raspGrouplist?${yearParam}`),
    fetchJsonWithTimeout(`${env.KABINET_API}/raspTeacherlist?${yearParam}`),
    fetchJsonWithTimeout(`${env.KABINET_API}/raspAudlist?${yearParam}`)
  ]);

  const result = {
    Group: normalizeList(groupsRes.status === 'fulfilled' ? groupsRes.value : []),
    Teacher: normalizeList(teachersRes.status === 'fulfilled' ? teachersRes.value : []),
    Aud: normalizeList(audsRes.status === 'fulfilled' ? audsRes.value : [])
  };

  await saveCache(env, cacheKey, JSON.stringify(result));

  return result;
}

function normalizeList(raw) {
  const items = unwrapList(raw);
  if (!Array.isArray(items)) return [];

  return items
    .map(normalizeListItem)
    .filter(Boolean);
}

function unwrapList(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;

  return (
    raw.items ||
    raw.data?.items ||
    raw.data?.list ||
    raw.list ||
    raw.result ||
    raw.data ||
    []
  );
}

function normalizeListItem(item) {
  if (!item) return null;

  if (typeof item === 'string' || typeof item === 'number') {
    const value = String(item).trim();
    if (!value) return null;
    return { id: value, name: value };
  }

  const name =
    item.name ??
    item.Name ??
    item.title ??
    item.label ??
    item.value ??
    item.Группа ??
    item.наименование ??
    item.ФИО ??
    item.Аудитория;

  const id =
    item.id ??
    item.Id ??
    item.ID ??
    item.idGroup ??
    item.idTeacher ??
    item.idAud ??
    item.код ??
    item.code ??
    item.value ??
    name;

  if (!name) return null;

  const cleanName = String(name).trim();
  const cleanId = String(id ?? cleanName).trim();

  if (!cleanName) return null;

  return {
    id: cleanId,
    name: cleanName
  };
}

// =====================================================
// Proxy to KGEU API
// =====================================================

async function handleProxy(request, env, ctx, url, subPath, corsOrigin, forceFresh) {
  if (request.method !== 'GET') {
    return jsonResponse({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405, corsOrigin);
  }

  const incoming = new URLSearchParams(url.search);
  incoming.delete('fresh');

  let targetPath = subPath;

  if (subPath.toLowerCase() === '/rasp') {
    targetPath = '/Rasp';

    const legacyMap = [
      ['group', 'idGroup'],
      ['teacher', 'idTeacher'],
      ['aud', 'idAudLine'],
      ['date', 'sdate']
    ];

    for (const [from, to] of legacyMap) {
      if (!incoming.has(to) && incoming.has(from)) {
        incoming.set(to, incoming.get(from) || '');
      }
      incoming.delete(from);
    }
  }

  const targetSearch = incoming.toString();
  const cacheKey = `/api${targetPath}${targetSearch ? `?${targetSearch}` : ''}`;

  if (!forceFresh) {
    const fresh = await env.DB.prepare(
      `SELECT schedule_data FROM schedule_cache
       WHERE cache_key = ? AND updated_at >= datetime('now', '-90 seconds')`
    )
      .bind(cacheKey)
      .first()
      .catch(() => null);

    if (fresh?.schedule_data) {
      return new Response(fresh.schedule_data, {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': corsOrigin,
          'Cache-Control': 'public, max-age=60'
        }
      });
    }
  }

  const targetUrl = `${env.KABINET_API}${targetPath}${targetSearch ? `?${targetSearch}` : ''}`;

  try {
    const res = await fetchWithTimeout(targetUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://kabinet.kgeu.ru/'
      }
    }, 12000);

    const text = await res.text();

    if (res.ok) {
      await saveCache(env, cacheKey, text);
    }

    return new Response(text, {
      status: res.status,
      headers: {
        'Content-Type': res.headers.get('Content-Type') || 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': corsOrigin,
        'Cache-Control': 'public, max-age=60'
      }
    });
  } catch (e) {
    console.error('Proxy error:', e);
    await safeLog(env, 'ERROR', `proxy ${targetPath}: ${e?.message || e}`);

    const stale = await getCache(env, cacheKey);
    if (stale) {
      return new Response(stale, {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': corsOrigin,
          'Cache-Control': 'public, max-age=60'
        }
      });
    }

    return jsonResponse({ ok: false, error: 'EXTERNAL_API_UNAVAILABLE' }, 502, corsOrigin);
  }
}

// =====================================================
// Cache
// =====================================================

async function getCache(env, key) {
  try {
    const row = await env.DB.prepare(
      `SELECT schedule_data FROM schedule_cache WHERE cache_key = ?`
    )
      .bind(key)
      .first();

    return row?.schedule_data || null;
  } catch (e) {
    return null;
  }
}

async function saveCache(env, key, data) {
  try {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO schedule_cache (cache_key, schedule_data, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)`
    )
      .bind(key, data)
      .run();
  } catch (e) {
    console.error('saveCache error:', e);
  }
}

// =====================================================
// User sync
// =====================================================

async function handleUserSync(request, env, corsOrigin) {
  const user = await requireUser(request, env);
  if (!user) {
    return jsonResponse({ ok: false, error: 'UNAUTHORIZED' }, 401, corsOrigin);
  }

  if (request.method === 'GET') {
    const row = await env.DB.prepare(
      `SELECT * FROM app_users WHERE telegram_id = ?`
    )
      .bind(user.id)
      .first()
      .catch(() => null);

    return jsonResponse(row || {}, 200, corsOrigin);
  }

  if (request.method === 'POST') {
    try {
      const body = await request.json();
      const settings = body?.settings || {};

      // Гарантируем миграцию selections_json непосредственно перед первым сохранением,
      // даже если cron ещё не успел выполнить ensureSchema после деплоя.
      await ensureSchema(env);

      await env.DB.prepare(
        `INSERT INTO app_users (
          telegram_id,
          username,
          first_name,
          last_name,
          selected_id,
          selected_name,
          selected_type,
          theme,
          subgroup,
          favorites_json,
          selections_json,
          banned,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
        ON CONFLICT(telegram_id) DO UPDATE SET
          username = excluded.username,
          first_name = excluded.first_name,
          last_name = excluded.last_name,
          selected_id = excluded.selected_id,
          selected_name = excluded.selected_name,
          selected_type = excluded.selected_type,
          theme = excluded.theme,
          subgroup = excluded.subgroup,
          favorites_json = excluded.favorites_json,
          selections_json = excluded.selections_json,
          updated_at = CURRENT_TIMESTAMP`
      )
        .bind(
          user.id,
          user.username || '',
          user.first_name || '',
          user.last_name || '',
          String(settings.selected_id || ''),
          String(settings.selected_name || ''),
          String(settings.selected_type || 'Group'),
          String(settings.theme || 'theme-purple'),
          String(settings.subgroup || '0'),
          String(settings.favorites_json || '[]'),
          String(settings.selections_json || '{}')
        )
        .run();

      return jsonResponse({ ok: true }, 200, corsOrigin);
    } catch (e) {
      console.error('User sync error:', e);
      return jsonResponse({ ok: false, error: 'BAD_REQUEST' }, 400, corsOrigin);
    }
  }

  return jsonResponse({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405, corsOrigin);
}

// =====================================================
// Notes (ex-ДЗ)
// =====================================================

async function handleTasks(request, env, url, corsOrigin) {
  const user = await requireUser(request, env);
  if (!user) {
    return jsonResponse({ ok: false, error: 'UNAUTHORIZED' }, 401, corsOrigin);
  }

  if (request.method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT * FROM tasks WHERE telegram_id = ? ORDER BY created_at DESC LIMIT 500`
    )
      .bind(user.id)
      .all()
      .catch(() => ({ results: [] }));

    return jsonResponse(rows.results || [], 200, corsOrigin);
  }

  if (request.method === 'POST') {
    try {
      const body = await request.json();

      const lessonTitle = String(body.lesson_title || '').slice(0, 200);
      const taskText = String(body.task_text || '').slice(0, 1000);
      const dueDate = String(body.due_date || '').slice(0, 20);
      const noteKey = String(body.note_key || '').slice(0, 500);
      const lessonTime = String(body.lesson_time || '').slice(0, 50);
      const lessonRoom = String(body.lesson_room || '').slice(0, 100);
      const lessonSubgroup = String(body.lesson_subgroup || '0').slice(0, 10);
      const noteType = 'note';

      if (!taskText.trim()) {
        return jsonResponse({ ok: false, error: 'EMPTY_TASK' }, 400, corsOrigin);
      }

      let row = null;
      if (noteKey) {
        row = await env.DB.prepare(
          `SELECT id FROM tasks WHERE telegram_id = ? AND note_key = ? LIMIT 1`
        )
          .bind(user.id, noteKey)
          .first()
          .catch(() => null);
      }

      if (row?.id) {
        try {
          await env.DB.prepare(
            `UPDATE tasks
             SET lesson_title = ?, task_text = ?, due_date = ?, note_type = ?,
                 lesson_time = ?, lesson_room = ?, lesson_subgroup = ?
             WHERE id = ? AND telegram_id = ?`
          )
            .bind(lessonTitle, taskText, dueDate, noteType, lessonTime, lessonRoom, lessonSubgroup, row.id, user.id)
            .run();
        } catch (e) {
          await env.DB.prepare(
            `UPDATE tasks
             SET lesson_title = ?, task_text = ?, due_date = ?, note_type = ?
             WHERE id = ? AND telegram_id = ?`
          )
            .bind(lessonTitle, taskText, dueDate, noteType, row.id, user.id)
            .run();
        }

        return jsonResponse({ ok: true, id: row.id, note: { id: row.id, note_key: noteKey, lesson_title: lessonTitle, task_text: taskText, due_date: dueDate, lesson_time: lessonTime, lesson_room: lessonRoom, lesson_subgroup: lessonSubgroup } }, 200, corsOrigin);
      }

      let result;
      try {
        result = await env.DB.prepare(
          `INSERT INTO tasks (telegram_id, lesson_title, task_text, due_date, note_type, note_key, lesson_time, lesson_room, lesson_subgroup)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(user.id, lessonTitle, taskText, dueDate, noteType, noteKey, lessonTime, lessonRoom, lessonSubgroup)
          .run();
      } catch (e) {
        // Совместимость со старой БД до авто-миграции всех новых колонок.
        result = await env.DB.prepare(
          `INSERT INTO tasks (telegram_id, lesson_title, task_text, due_date, note_type)
           VALUES (?, ?, ?, ?, ?)`
        )
          .bind(user.id, lessonTitle, taskText, dueDate, noteType)
          .run();
      }

      let savedRow = null;
      if (noteKey) {
        savedRow = await env.DB.prepare(
          `SELECT * FROM tasks WHERE telegram_id = ? AND note_key = ? ORDER BY id DESC LIMIT 1`
        ).bind(user.id, noteKey).first().catch(() => null);
      }

      return jsonResponse({
        ok: true,
        id: savedRow?.id || result?.meta?.last_row_id || result?.lastRowId || null,
        note: savedRow || {
          id: result?.meta?.last_row_id || null,
          note_key: noteKey,
          lesson_title: lessonTitle,
          task_text: taskText,
          due_date: dueDate,
          lesson_time: lessonTime,
          lesson_room: lessonRoom,
          lesson_subgroup: lessonSubgroup
        }
      }, 200, corsOrigin);
    } catch (e) {
      console.error('Task save error:', e);
      return jsonResponse({ ok: false, error: 'BAD_REQUEST' }, 400, corsOrigin);
    }
  }

  if (request.method === 'DELETE') {
    if (url.searchParams.get('all') === '1') {
      await env.DB.prepare(`DELETE FROM tasks WHERE telegram_id = ?`).bind(user.id).run().catch(() => {});
      return jsonResponse({ ok: true }, 200, corsOrigin);
    }

    const id = Number(url.searchParams.get('id') || 0);
    if (!id) {
      return jsonResponse({ ok: false, error: 'BAD_REQUEST' }, 400, corsOrigin);
    }

    await env.DB.prepare(
      `DELETE FROM tasks WHERE id = ? AND telegram_id = ?`
    )
      .bind(id, user.id)
      .run()
      .catch(() => {});

    return jsonResponse({ ok: true }, 200, corsOrigin);
  }

  return jsonResponse({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405, corsOrigin);
}

// =====================================================
// Reminders
// =====================================================

async function handleReminders(request, env, url, corsOrigin) {
  const user = await requireUser(request, env);
  if (!user) {
    return jsonResponse({ ok: false, error: 'UNAUTHORIZED' }, 401, corsOrigin);
  }

  if (request.method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT * FROM reminders
       WHERE telegram_id = ? AND sent = 0
       ORDER BY remind_at ASC
       LIMIT 200`
    )
      .bind(user.id)
      .all()
      .catch(() => ({ results: [] }));

    return jsonResponse(rows.results || [], 200, corsOrigin);
  }

  if (request.method === 'POST') {
    try {
      const body = await request.json();

      const remindAt = Number(body.remind_at || 0);
      const message = String(body.message || '').slice(0, 500);

      if (!remindAt || !message.trim()) {
        return jsonResponse({ ok: false, error: 'BAD_REQUEST' }, 400, corsOrigin);
      }

      await env.DB.prepare(
        `INSERT INTO reminders (telegram_id, remind_at, message)
         VALUES (?, ?, ?)`
      )
        .bind(user.id, remindAt, message)
        .run();

      return jsonResponse({ ok: true }, 200, corsOrigin);
    } catch (e) {
      return jsonResponse({ ok: false, error: 'BAD_REQUEST' }, 400, corsOrigin);
    }
  }

  if (request.method === 'DELETE') {
    if (url.searchParams.get('all') === '1') {
      await env.DB.prepare(`DELETE FROM reminders WHERE telegram_id = ? AND sent = 0`).bind(user.id).run().catch(() => {});
      return jsonResponse({ ok: true }, 200, corsOrigin);
    }

    const id = Number(url.searchParams.get('id') || 0);
    if (!id) {
      return jsonResponse({ ok: false, error: 'BAD_REQUEST' }, 400, corsOrigin);
    }

    await env.DB.prepare(
      `DELETE FROM reminders WHERE id = ? AND telegram_id = ?`
    )
      .bind(id, user.id)
      .run()
      .catch(() => {});

    return jsonResponse({ ok: true }, 200, corsOrigin);
  }

  return jsonResponse({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405, corsOrigin);
}

async function processReminders(env) {
  try {
    const now = Date.now();

    const due = await env.DB.prepare(
      `SELECT r.*
       FROM reminders r
       LEFT JOIN app_users u ON u.telegram_id = r.telegram_id
       WHERE r.sent = 0
         AND r.attempts < 3
         AND r.remind_at <= ?
         AND IFNULL(u.banned, 0) = 0
       ORDER BY r.remind_at ASC
       LIMIT 20`
    )
      .bind(now)
      .all()
      .catch(() => ({ results: [] }));

    const rows = due.results || [];

    for (const row of rows) {
      if (!env.BOT_TOKEN) {
        await env.DB.prepare(
          `UPDATE reminders SET sent = 1 WHERE id = ?`
        )
          .bind(row.id)
          .run()
          .catch(() => {});
        continue;
      }

      const ok = await sendTelegramMessage(
        env.BOT_TOKEN,
        row.telegram_id,
        row.message
      );

      if (ok) {
        await env.DB.prepare(
          `UPDATE reminders SET sent = 1 WHERE id = ?`
        )
          .bind(row.id)
          .run()
          .catch(() => {});
      } else {
        await env.DB.prepare(
          `UPDATE reminders SET attempts = attempts + 1 WHERE id = ?`
        )
          .bind(row.id)
          .run()
          .catch(() => {});
      }

      await new Promise(resolve => setTimeout(resolve, 50));
    }
  } catch (e) {
    console.error('processReminders error:', e);
  }
}

// =====================================================
// Admin
// =====================================================

async function handleAdmin(request, env, subPath, corsOrigin) {
  const admin = await requireAdmin(request, env);
  if (!admin) {
    return jsonResponse({ ok: false, error: 'FORBIDDEN' }, 403, corsOrigin);
  }

  if (subPath === '/admin/stats' && request.method === 'GET') {
    const usersCount = await countTable(env, 'app_users');
    const bannedCount = await countWhere(env, 'app_users', 'banned = 1');
    const tasksCount = await countTable(env, 'tasks');
    const remindersCount = await countWhere(env, 'reminders', 'sent = 0');
    const cacheCount = await countTable(env, 'schedule_cache');
    const logsCount = await countTable(env, 'system_logs');

    const topGroups = await env.DB.prepare(
      `SELECT selected_name AS name, COUNT(*) AS count
       FROM app_users
       WHERE selected_type = 'Group' AND selected_name != ''
       GROUP BY selected_name
       ORDER BY count DESC
       LIMIT 10`
    )
      .all()
      .catch(() => ({ results: [] }));

    return jsonResponse({
      ok: true,
      usersCount,
      bannedCount,
      tasksCount,
      remindersCount,
      cacheCount,
      logsCount,
      topGroups: topGroups.results || []
    }, 200, corsOrigin);
  }

  if (subPath === '/admin/test' && request.method === 'GET') {
    const started = Date.now();

    try {
      const lists = await buildLists(env, true);

      return jsonResponse({
        ok: true,
        ms: Date.now() - started,
        Group: lists.Group.length,
        Teacher: lists.Teacher.length,
        Aud: lists.Aud.length
      }, 200, corsOrigin);
    } catch (e) {
      return jsonResponse({
        ok: false,
        ms: Date.now() - started,
        error: String(e?.message || e)
      }, 500, corsOrigin);
    }
  }

  if (subPath === '/admin/users' && request.method === 'GET') {
    const qRaw = String(new URL(request.url).searchParams.get('q') || '').trim().replace(/^@/, '');
    const q = qRaw.toLowerCase();
    const like = `%${q}%`;

    const rows = await env.DB.prepare(
      `SELECT telegram_id, username, first_name, last_name, selected_name, selected_type, banned, updated_at
       FROM app_users
       WHERE (? = ''
          OR CAST(telegram_id AS TEXT) LIKE ?
          OR LOWER(COALESCE(username, '')) LIKE ?
          OR LOWER(COALESCE(first_name, '')) LIKE ?
          OR LOWER(COALESCE(last_name, '')) LIKE ?
          OR LOWER(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, ''))) LIKE ?
          OR LOWER(COALESCE(selected_name, '')) LIKE ?)
       ORDER BY banned DESC, updated_at DESC
       LIMIT 30`
    )
      .bind(q, like, like, like, like, like, like)
      .all()
      .catch(() => ({ results: [] }));

    return jsonResponse({ ok: true, users: rows.results || [] }, 200, corsOrigin);
  }

  if (request.method === 'POST') {
    let body = {};

    try {
      body = await request.json();
    } catch (e) {}

    if (subPath === '/admin/clearOldCache') {
      await env.DB.prepare(
        `DELETE FROM schedule_cache WHERE updated_at < datetime('now', '-14 days')`
      ).run().catch(() => {});

      await logAdmin(env, admin.id, 'clearOldCache');
      return jsonResponse({ ok: true, message: 'Старый кэш очищен' }, 200, corsOrigin);
    }

    if (subPath === '/admin/clearAllCache') {
      await env.DB.prepare(`DELETE FROM schedule_cache`).run().catch(() => {});
      await logAdmin(env, admin.id, 'clearAllCache');
      return jsonResponse({ ok: true, message: 'Весь кэш очищен' }, 200, corsOrigin);
    }

    if (subPath === '/admin/clearLogs') {
      await env.DB.prepare(`DELETE FROM system_logs`).run().catch(() => {});
      await env.DB.prepare(`DELETE FROM admin_events`).run().catch(() => {});
      await logAdmin(env, admin.id, 'clearLogs');
      return jsonResponse({ ok: true, message: 'Логи очищены' }, 200, corsOrigin);
    }

    if (subPath === '/admin/refreshLists') {
      try {
        await buildLists(env, true);
        await logAdmin(env, admin.id, 'refreshLists');
        return jsonResponse({ ok: true, message: 'Списки обновлены' }, 200, corsOrigin);
      } catch (e) {
        return jsonResponse({ ok: false, message: 'Ошибка обновления списков' }, 500, corsOrigin);
      }
    }

    if (subPath === '/admin/ban') {
      const targetId = Number(body.target_id || 0);
      const banned = Number(body.banned || 0);

      if (!targetId) {
        return jsonResponse({ ok: false, message: 'Нет target_id' }, 400, corsOrigin);
      }

      await env.DB.prepare(
        `INSERT INTO app_users (telegram_id, banned, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(telegram_id) DO UPDATE SET
           banned = excluded.banned,
           updated_at = CURRENT_TIMESTAMP`
      )
        .bind(targetId, banned ? 1 : 0)
        .run()
        .catch(() => {});

      await logAdmin(env, admin.id, banned ? 'ban' : 'unban', { targetId });

      return jsonResponse({
        ok: true,
        message: banned ? 'Пользователь забанен' : 'Пользователь разбанен'
      }, 200, corsOrigin);
    }

    if (subPath === '/admin/broadcast') {
      const message = String(body.message || '').slice(0, 1000);

      if (!message.trim()) {
        return jsonResponse({ ok: false, message: 'Пустое сообщение' }, 400, corsOrigin);
      }

      const users = await env.DB.prepare(
        `SELECT telegram_id
         FROM app_users
         WHERE banned = 0 AND updated_at >= datetime('now', '-30 days')
         LIMIT 500`
      )
        .all()
        .catch(() => ({ results: [] }));

      let sent = 0;

      for (const row of users.results || []) {
        const ok = await sendTelegramMessage(env.BOT_TOKEN, row.telegram_id, message);
        if (ok) sent++;
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      await logAdmin(env, admin.id, 'broadcast', { sent, length: message.length });

      return jsonResponse({
        ok: true,
        message: `Отправлено: ${sent}`
      }, 200, corsOrigin);
    }
  }

  return jsonResponse({ ok: false, error: 'NOT_FOUND' }, 404, corsOrigin);
}

async function countTable(env, table) {
  try {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${table}`).first();
    return row?.c || 0;
  } catch (e) {
    return 0;
  }
}

async function countWhere(env, table, where) {
  try {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`).first();
    return row?.c || 0;
  } catch (e) {
    return 0;
  }
}

// =====================================================
// Auto-migration / cleanup
// =====================================================

async function ensureSchema(env) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS app_users (
      telegram_id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      selected_id TEXT DEFAULT '',
      selected_name TEXT DEFAULT '',
      selected_type TEXT DEFAULT 'Group',
      theme TEXT DEFAULT 'theme-purple',
      subgroup TEXT DEFAULT '0',
      favorites_json TEXT DEFAULT '[]',
      selections_json TEXT DEFAULT '{}',
      banned INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      lesson_title TEXT DEFAULT '',
      task_text TEXT NOT NULL,
      due_date TEXT DEFAULT '',
      note_type TEXT DEFAULT 'note',
      note_key TEXT DEFAULT '',
      lesson_time TEXT DEFAULT '',
      lesson_room TEXT DEFAULT '',
      lesson_subgroup TEXT DEFAULT '0',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      remind_at INTEGER NOT NULL,
      message TEXT NOT NULL,
      sent INTEGER DEFAULT 0,
      attempts INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS admin_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      payload TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(telegram_id)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_note_key ON tasks(telegram_id, note_key)`,
    `CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(sent, remind_at)`,
    `CREATE INDEX IF NOT EXISTS idx_app_users_updated ON app_users(updated_at)`
  ];

  for (const sql of statements) {
    try {
      await env.DB.prepare(sql).run();
    } catch (e) {}
  }

  try { await env.DB.prepare(`ALTER TABLE app_users ADD COLUMN selections_json TEXT DEFAULT '{}'`).run(); } catch (e) {}

  // Авто-миграция старой БД: добавляем колонку типа заметки, если её нет
  try {
    await env.DB.prepare(`ALTER TABLE tasks ADD COLUMN note_type TEXT DEFAULT 'note'`).run();
  } catch (e) {}
  for (const [column, ddl] of [
    ['note_key', `ALTER TABLE tasks ADD COLUMN note_key TEXT DEFAULT ''`],
    ['lesson_time', `ALTER TABLE tasks ADD COLUMN lesson_time TEXT DEFAULT ''`],
    ['lesson_room', `ALTER TABLE tasks ADD COLUMN lesson_room TEXT DEFAULT ''`],
    ['lesson_subgroup', `ALTER TABLE tasks ADD COLUMN lesson_subgroup TEXT DEFAULT '0'`]
  ]) {
    try { await env.DB.prepare(ddl).run(); } catch (e) {}
  }
  try { await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_note_key ON tasks(telegram_id, note_key)`).run(); } catch (e) {}
}

async function cleanupDatabase(env) {
  try {
    await env.DB.prepare(
      `DELETE FROM schedule_cache WHERE updated_at < datetime('now', '-14 days')`
    ).run().catch(() => {});

    await env.DB.prepare(
      `DELETE FROM system_logs WHERE created_at < datetime('now', '-7 days')`
    ).run().catch(() => {});

    await env.DB.prepare(
      `DELETE FROM admin_events WHERE created_at < datetime('now', '-30 days')`
    ).run().catch(() => {});

    await env.DB.prepare(
      `DELETE FROM reminders WHERE sent = 1 AND created_at < datetime('now', '-7 days')`
    ).run().catch(() => {});
  } catch (e) {
    console.error('cleanupDatabase error:', e);
  }
}
