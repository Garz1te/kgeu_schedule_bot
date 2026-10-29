// Админы задаются секретом ADMIN_IDS (строка "111,222", "111 222" или JSON).
// Список по умолчанию нужен только чтобы не потерять доступ, если секрет пуст.
const DEFAULT_ADMIN_IDS = [1116707989];

function getAdminIds(env) {
  const ids = new Set();
  const push = value => {
    const num = Number(String(value).trim());
    if (Number.isFinite(num) && num > 0) ids.add(num);
  };

  const raw = env?.ADMIN_IDS;
  if (Array.isArray(raw)) {
    raw.forEach(push);
  } else if (raw !== undefined && raw !== null && String(raw).trim()) {
    const text = String(raw).trim();
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) parsed.forEach(push);
      } catch (e) {}
    }
    if (!ids.size) text.split(/[,;\s]+/).forEach(push);
  }

  if (!ids.size) DEFAULT_ADMIN_IDS.forEach(push);
  return ids;
}

// Легаси-роуты /group, /teacher, /aud удалены: upstream отдаёт на них 404.
const ALLOWED_PROXY_PATHS = new Set([
  '/rasp',
  '/raspGrouplist',
  '/raspTeacherlist',
  '/raspAudlist'
]);

// Free-plan protection / deduplication. These maps live only for the lifetime
// of a Worker isolate, so they add no D1 writes and automatically reset.
const proxyInflight = new Map();
const refreshGate = new Map();
const logGate = new Map();
const userRateGate = new Map();
const listInflight = new Map();
let schemaPromise = null;

const EDGE_TTLS = {
  scheduleToday: 5 * 60,
  scheduleOther: 30 * 60,
  scheduleRangeToday: 5 * 60,
  scheduleRangeOther: 30 * 60,
  lists: 6 * 60 * 60,
  freeAuds: 300
};

const MAX_D1_CACHE_BYTES = 400_000;
const MAX_LOG_PER_KEY_MS = 5 * 60 * 1000;
const FORCE_REFRESH_COOLDOWN_MS = 15 * 1000;
const SCHEDULE_USER_LIMIT = 30;
// Догрузка групп идёт через расписание преподавателя/аудитории: это отдельный,
// более щедрый бюджет, иначе 4–8 запросов на карточку выбивали лимит 30/мин.
const DETAIL_USER_LIMIT = 90;
const RANGE_USER_LIMIT = 10;
const FREE_AUD_USER_LIMIT = 18;
const USER_SYNC_WRITE_LIMIT = 6;
const TASK_WRITE_LIMIT = 30;
const REMINDER_WRITE_LIMIT = 20;

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
    // Free-tier cadence: one background wake-up every 5 minutes.
    // Reminder lead times are validated in 5-minute steps, so this cadence is
    // consistent with the UI and leaves a large safety margin on Free.
    ctx.waitUntil((async () => {
      try {
        await ensureSchemaOnce(env);
        const jobs = [processReminders(env), processBroadcastQueue(env)];
        // Maintenance stays hourly, piggybacking on the existing trigger.
        if (new Date().getUTCMinutes() === 0) jobs.push(cleanupDatabase(env));
        await Promise.allSettled(jobs);
      } catch (e) {
        console.error('scheduled error:', e);
      }
    })());
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

  if (allowed.includes(origin)) {
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
      'Access-Control-Allow-Headers': 'Content-Type, X-Telegram-Init-Data, X-Telegram-Bot-Api-Secret-Token',
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
      'Vary': 'Origin',
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

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

// API КГЭУ сообщает об ошибках HTTP-кодом 200 и полем state: -1. Раньше такие
// ответы считались успешными и кэшировались как «пар нет».
function assertKgeuPayload(parsed, url) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
  if (!('state' in parsed)) return parsed;

  const state = Number(parsed.state);
  if (!Number.isFinite(state)) return parsed;
  if (state < 0) {
    throw new Error(`KGEU_API_ERROR: ${String(parsed.msg || 'unknown').slice(0, 120)} (${url})`);
  }
  if (parsed.data === null || parsed.data === undefined) {
    throw new Error(`KGEU_API_ERROR: ${String(parsed.msg || 'empty data').slice(0, 120)} (${url})`);
  }
  return parsed;
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 10000) {
  const res = await fetchWithTimeout(url, options, timeoutMs);
  const text = await res.text();

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}`);
  }

  const parsed = safeJsonParse(text);
  if (!parsed) {
    throw new Error(`Non-JSON response from ${url}`);
  }

  return assertKgeuPayload(parsed, url);
}

function takeUserRateSlot(userId, bucket, limit, windowMs = 60 * 1000) {
  const key = `${String(userId)}:${bucket}`;
  const now = Date.now();
  let state = userRateGate.get(key);

  if (!state || now - state.startedAt >= windowMs) {
    state = { startedAt: now, count: 0 };
    userRateGate.set(key, state);
  }

  if (state.count >= limit) return false;
  state.count += 1;

  // Prevent an unbounded in-memory map when many Telegram users hit one isolate.
  if (userRateGate.size > 5000) {
    const cutoff = now - windowMs * 2;
    for (const [entryKey, entry] of userRateGate) {
      if (entry.startedAt < cutoff) userRateGate.delete(entryKey);
      if (userRateGate.size <= 3500) break;
    }
  }

  return true;
}

async function safeLog(env, type, payload) {
  const message = String(payload || '').slice(0, 1000);
  const key = `${type}:${message.slice(0, 180)}`;
  const now = Date.now();
  const last = logGate.get(key) || 0;

  // During an upstream outage, logging every failed request would itself
  // create thousands of D1 writes. Keep console logging, sample D1 logs.
  if (now - last < MAX_LOG_PER_KEY_MS) return;
  logGate.set(key, now);

  try {
    await env.DB.prepare(
      `INSERT INTO system_logs (event_type, payload) VALUES (?, ?)`
    )
      .bind(type, message)
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

function sleepServer(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
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
  const raw = String(str).trim();
  const ranges = raw.match(/(\d{1,2})[:.](\d{2})\s*[-–—]\s*(\d{1,2})[:.](\d{2})/);
  if (ranges) {
    const start = parseInt(ranges[1], 10) * 60 + parseInt(ranges[2], 10);
    const end = parseInt(ranges[3], 10) * 60 + parseInt(ranges[4], 10);
    if (start < 1440 && end <= 1440 && end > start) return { start, end };
  }

  const times = raw.match(/\d{1,2}[:.]\d{2}/g) || [];
  if (times.length >= 2) {
    const a = times[0].match(/(\d{1,2})[:.](\d{2})/);
    const b = times[1].match(/(\d{1,2})[:.](\d{2})/);
    if (a && b) {
      const start = parseInt(a[1], 10) * 60 + parseInt(a[2], 10);
      const end = parseInt(b[1], 10) * 60 + parseInt(b[2], 10);
      if (start < 1440 && end <= 1440 && end > start) return { start, end };
    }
  }
  return null;
}

function extractLessonsServer(data) {
  if (!data || typeof data !== 'object') return [];

  // Accept both a plain lesson array and nested day/wrapper arrays.
  const queue = [{ node: data, depth: 0 }];
  const seen = new WeakSet();
  const lessons = [];

  while (queue.length && lessons.length < 5000) {
    const { node, depth } = queue.shift();
    if (!node || typeof node !== 'object' || depth > 8 || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) {
        if (!item || typeof item !== 'object') continue;
        if (isLessonLikeServer(item)) lessons.push(item);
        else queue.push({ node: item, depth: depth + 1 });
      }
      continue;
    }
    if (isLessonLikeServer(node)) lessons.push(node);
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') queue.push({ node: value, depth: depth + 1 });
    }
  }
  return lessons.length ? lessons : (isLessonLikeServer(data) ? [data] : []);
}

function isLessonLikeServer(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const hasContent = keys.some(k => /^(subject|Subject|discipline|Дисциплина|дисциплина|subjectName|disciplineName|nameDiscipline|disciplineTitle|НаименованиеДисциплины|name|Name|title|Title|название)$/u.test(k));
  const hasScheduleField = keys.some(k => /^(time|Time|time_range|timeRange|period|periodTime|pairTime|pair_time|lessonTime|LessonTime|времяПарыНомер|Время|время|времяПары|времяЗанятия|start|Start|startTime|StartTime|timeStart|TimeStart|begin|Begin|начало|Начало|ВремяНачала|времяНачала|датаНачала|DateStart|lessonStart|end|End|endTime|EndTime|timeEnd|TimeEnd|finish|Finish|конец|Конец|ВремяОкончания|времяОкончания|датаОкончания|DateEnd|lessonEnd|teacher|Teacher|teacherName|teacher_name|teacherFio|teacher_fio|ФИОПреподавателя|фИоПреподавателя|преподаватель|Преподаватель|room|Room|auditorium|aud|Аудитория|аудитория|audLine|audLineName|audName|аудиторияНомер|номерАудитории|type|Type|lesson_type|lessonType|типЗанятия|ТипЗанятия|видЗанятия|kind|Kind|дата|Дата|date|Date|lessonDate|lesson_date|day_date|day|pair|Pair|пара|номерПары|номер_пары|pairNumber|lessonNumber|№пары|subgroup|Subgroup|подгруппа|номерПодгруппы|group|Group|groupString|groupNames|groups|Groups|группа|Группа|группы|Группы|ГруппыСтрокой)$/u.test(k));
  return hasContent && hasScheduleField;
}


function normalizeServerDate(value) {
  if (value === null || value === undefined) return '';
  const raw = String(value).trim();
  if (!raw) return '';

  let m = raw.match(/(?:^|\b)(20\d{2})[-.](\d{1,2})[-.](\d{1,2})(?:\b|T|\s)/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;

  m = raw.match(/\b(\d{1,2})[./-](\d{1,2})[./-](20\d{2})\b/);
  if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return '';
}

function serverLessonDate(l) {
  const candidates = [
    l?.дата, l?.Дата, l?.date, l?.Date, l?.lessonDate, l?.lesson_date,
    l?.day_date, l?.day, l?.датаНачала, l?.датаОкончания,
    l?.DateStart, l?.dateStart, l?.startDate, l?.start_date
  ];
  for (const value of candidates) {
    const normalized = normalizeServerDate(value);
    if (normalized) return normalized;
  }
  return '';
}

function filterLessonsByDateServer(lessons, dateStr) {
  if (!Array.isArray(lessons) || !lessons.length) return [];
  const dates = lessons.map(serverLessonDate);
  const hasRecognizedDates = dates.some(Boolean);
  // For /Rasp?sdate=... the endpoint is already date-scoped. When a record's
  // date format is unknown, keep it rather than silently dropping a valid pair.
  return hasRecognizedDates
    ? lessons.filter((lesson, index) => !dates[index] || dates[index] === dateStr)
    : lessons.slice();
}

function serverLessonTime(l) {
  const direct = l?.часы ?? l?.Часы ?? l?.hours ?? l?.lessonHours ?? l?.time ?? l?.Time ?? l?.time_range ?? l?.timeRange ?? l?.period ??
    l?.Время ?? l?.время ?? l?.времяПары ?? l?.времяЗанятия ?? l?.lessonTime ?? '';
  if (typeof direct === 'object') {
    const s = extractTimeTokenServer(direct.start ?? direct.Start ?? direct.from ?? direct.begin ?? direct.начало);
    const e = extractTimeTokenServer(direct.end ?? direct.End ?? direct.to ?? direct.finish ?? direct.конец);
    if (s && e) return `${s} - ${e}`;
  }
  if (direct) {
    const raw = String(direct).trim();
    if (/\d{1,2}[:.]\d{2}/.test(raw)) return raw;
  }

  const start = [l?.start, l?.startTime, l?.timeStart, l?.TimeStart, l?.начало, l?.Начало, l?.ВремяНачала, l?.времяНачала, l?.датаНачала, l?.DateStart, l?.from];
  const end = [l?.end, l?.endTime, l?.timeEnd, l?.TimeEnd, l?.конец, l?.Конец, l?.ВремяОкончания, l?.времяОкончания, l?.датаОкончания, l?.DateEnd, l?.to];
  for (let i = 0; i < start.length; i++) {
    const s = extractTimeTokenServer(start[i]);
    const e = extractTimeTokenServer(end[i]);
    if (s && e) return `${s} - ${e}`;
  }

  const pairNumber = extractPairNumberServer(l);
  if (pairNumber && KGEU_PAIR_TIME_RANGES[pairNumber]) return KGEU_PAIR_TIME_RANGES[pairNumber];

  // Last-resort shallow scan: useful for API variants that renamed the fields.
  const rawJson = safeJsonStringify(l, 8000);
  const matches = rawJson.match(/\d{1,2}[:.]\d{2}/g) || [];
  if (matches.length >= 2) return `${matches[0]} - ${matches[1]}`;
  return rawJson.match(/\d{1,2}[:.]\d{2}/)?.[0] || '';
}

function extractPairNumberServer(l) {
  const candidates = [
    l?.pair, l?.Pair, l?.пара, l?.номерПары, l?.номер_пары, l?.pairNumber,
    l?.lessonNumber, l?.['№пары'], l?.номерЗанятия, l?.номер_занятия, l?.periodNumber, l?.period_no
  ];
  for (const value of candidates) {
    if (value === null || value === undefined || value === '') continue;
    const m = String(value).match(/\b([1-8])\b/);
    if (m) return Number(m[1]);
  }
  return 0;
}

const KGEU_PAIR_TIME_RANGES = {
  1: '08:00 - 09:30', 2: '09:40 - 11:10', 3: '11:40 - 13:10', 4: '13:20 - 14:50',
  5: '15:00 - 16:30', 6: '16:40 - 18:10', 7: '18:20 - 19:50', 8: '20:00 - 21:30'
};

function extractTimeTokenServer(value) {
  if (value === null || value === undefined) return '';
  const m = String(value).match(/(?:^|T|\s)(\d{1,2})[:.](\d{2})(?::\d{2})?/);
  if (!m) return '';
  const h = Number(m[1]), mm = Number(m[2]);
  if (h > 23 || mm > 59) return '';
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function safeJsonStringify(value, max = 8000) {
  try { return JSON.stringify(value).slice(0, max); } catch (e) { return ''; }
}

function serverRoom(l) {
  const value = l?.room ?? l?.Room ?? l?.auditorium ?? l?.aud ?? l?.аудитория ?? l?.Аудитория ?? l?.audLine ?? l?.audLineName ?? l?.audName ?? l?.аудиторияНомер ?? l?.номерАудитории ?? '';
  if (value && typeof value === 'object') return value.name ?? value.Name ?? value.title ?? value.аудитория ?? '';
  return value;
}

// initData живёт ограниченное время: сутки — компромисс между безопасностью
// (перехваченный initData нельзя переиспользовать неделю) и тем, что человек
// может держать мини-приложение открытым весь день.
const TELEGRAM_INIT_DATA_MAX_AGE_SEC = 24 * 60 * 60;
const TELEGRAM_INIT_DATA_CLOCK_SKEW_SEC = 10 * 60;

// Ключ кэшируется вместе с токеном, из которого выведен: иначе после смены
// секрета живой изолят продолжает проверять подписи старым ключом.
let telegramHmacKeyCache = { token: '', promise: null };

function getBotToken(env) {
  // BOT_TOKEN is the canonical secret. TELEGRAM_BOT_TOKEN is accepted as a
  // compatibility alias so a differently named existing secret does not break
  // authentication after an update.
  return String(env.BOT_TOKEN || env.TELEGRAM_BOT_TOKEN || '').trim();
}

async function sha256Hex(value) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(String(value || ''))
  );
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

async function getWebhookSecret(env) {
  // Explicit secret wins when configured. Otherwise derive a stable secret from
  // the existing bot token so current deployments keep working without an extra
  // required secret.
  const explicit = String(env.WEBHOOK_SECRET || '').trim();
  if (explicit) return explicit;
  const botToken = getBotToken(env);
  if (!botToken) return '';
  return sha256Hex(`${botToken}:kgeu-webhook`);
}

async function getTelegramHmacKey(env) {
  const botToken = getBotToken(env);
  if (!botToken) return null;

  // Reuse the derived key inside the same isolate to avoid importing/deriving it
  // for every request. The secret itself never leaves the Worker.
  if (telegramHmacKeyCache.token === botToken && telegramHmacKeyCache.promise) {
    return telegramHmacKeyCache.promise;
  }

  const encoder = new TextEncoder();
  const signingKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode('WebAppData'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const secret = await crypto.subtle.sign('HMAC', signingKey, encoder.encode(botToken));
  const verifyKey = await crypto.subtle.importKey(
    'raw',
    secret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  telegramHmacKeyCache = { token: botToken, promise: Promise.resolve(verifyKey) };
  return verifyKey;
}

function decodeHex(hex) {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function buildTelegramDataCheckString(params, excludeSignature = false) {
  const pairs = [];
  for (const [key, value] of params.entries()) {
    if (key === 'hash') continue;
    if (excludeSignature && key === 'signature') continue;
    pairs.push(`${key}=${value}`);
  }
  // Telegram requires alphabetical ordering of the full `key=value` lines.
  // JS default sort is deterministic code-unit ordering, matching ASCII Telegram keys.
  pairs.sort();
  return pairs.join('\n');
}

// =====================================================
// Telegram initData verification
// =====================================================

async function verifyTelegramInitData(env, initData) {
  try {
    const botToken = getBotToken(env);
    const rawInitData = String(initData || '').trim();
    if (!botToken || !rawInitData) return null;

    const params = new URLSearchParams(rawInitData);
    const receivedHash = String(params.get('hash') || '').trim().toLowerCase();
    if (!decodeHex(receivedHash)) return null;

    const authDate = Number(params.get('auth_date') || 0);
    const nowSec = Math.floor(Date.now() / 1000);
    if (!Number.isInteger(authDate) || authDate <= 0) return null;
    const age = nowSec - authDate;
    if (age > TELEGRAM_INIT_DATA_MAX_AGE_SEC || age < -TELEGRAM_INIT_DATA_CLOCK_SKEW_SEC) {
      return null;
    }

    const key = await getTelegramHmacKey(env);
    if (!key) return null;

    const encoder = new TextEncoder();
    const providedHash = decodeHex(receivedHash);
    if (!providedHash) return null;

    // Telegram's bot-side HMAC scheme: secret = HMAC_SHA256(key=WebAppData,
    // message=bot_token), then HMAC_SHA256(key=secret, message=data_check_string).
    // This is exactly the algorithm documented by Telegram.
    let valid = await crypto.subtle.verify(
      'HMAC',
      key,
      providedHash,
      encoder.encode(buildTelegramDataCheckString(params, false))
    );

    // Newer initData may contain an Ed25519 `signature` field as well. Keep a
    // compatibility fallback for clients/variants where the traditional `hash`
    // was calculated without that field. Both branches still require a valid
    // HMAC made from the real bot token.
    if (!valid && params.has('signature')) {
      valid = await crypto.subtle.verify(
        'HMAC',
        key,
        providedHash,
        encoder.encode(buildTelegramDataCheckString(params, true))
      );
    }

    if (!valid) return null;

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

function banCacheRequest(userId) {
  return new Request(`https://kgeu-internal.invalid/ban/${encodeURIComponent(userId)}`);
}

async function isUserBanned(env, userId) {
  const key = banCacheRequest(userId);
  try {
    const cached = await caches.default.match(key);
    if (cached) {
      const data = await cached.json();
      return !!data.banned;
    }
  } catch (e) {}

  let banned = false;
  try {
    const row = await env.DB.prepare(
      `SELECT banned FROM app_users WHERE telegram_id = ?`
    )
      .bind(userId)
      .first();
    banned = !!row?.banned;
  } catch (e) {}

  try {
    await caches.default.put(
      key,
      new Response(JSON.stringify({ banned }), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60'
        }
      })
    );
  } catch (e) {}

  return banned;
}

async function clearUserBanCache(userId) {
  try { await caches.default.delete(banCacheRequest(userId)); } catch (e) {}
}

async function requireUser(request, env) {
  const initData = request.headers.get('X-Telegram-Init-Data') || '';
  const user = await verifyTelegramInitData(env, initData);
  if (!user?.id) return null;

  if (await isUserBanned(env, user.id)) return null;
  return user;
}

async function requireAdmin(request, env) {
  const user = await requireUser(request, env);
  if (!user?.id) return null;
  if (!getAdminIds(env).has(Number(user.id))) return null;
  return user;
}

// =====================================================
// Telegram Bot API (server-side)
// =====================================================

const TELEGRAM_WEBHOOK_ALLOWED_UPDATES = ['message', 'edited_message'];

async function telegramApi(env, method, payload = {}) {
  const token = getBotToken(env);
  if (!token) throw new Error('NO_BOT_TOKEN');

  const res = await fetchWithTimeout(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }, 8000);

  const parsed = safeJsonParse(await res.text());
  if (!parsed) throw new Error(`TELEGRAM_NON_JSON_${res.status}`);
  if (!parsed.ok) throw new Error(`TELEGRAM_${String(parsed.description || 'ERROR').slice(0, 160)}`);
  return parsed.result;
}

// Публичный адрес этого воркера: Telegram должен стучаться именно сюда.
// Telegram/WebView агрессивно кэширует index.html: без версии в URL после
// деплоя пользователь продолжает работать со старым JS.
function webAppUrlWithVersion(env) {
  const base = String(env.WEBAPP_URL || 'https://garz1te.github.io/kgeu_schedule_bot').trim();
  const build = String(env.APP_BUILD || '').trim();
  if (!build) return base;
  return `${base}${base.includes('?') ? '&' : '?'}v=${encodeURIComponent(build)}`;
}

function webhookUrlFrom(request) {
  return `${new URL(request.url).origin}/webhook`;
}

// =====================================================
// Telegram webhook
// =====================================================

async function handleTelegramWebhook(request, env, ctx) {
  try {
    const expected = await getWebhookSecret(env);
    const provided = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
    if (!expected || provided !== expected) {
      // Telegram присылает X-Telegram-Bot-Api-Secret-Token только если вебхук
      // зарегистрирован с secret_token. Без него /start молча получает 401.
      await safeLog(env, 'WEBHOOK_AUTH_FAIL',
        `expected=${expected ? 'set' : 'none'} provided=${provided ? 'set' : 'none'}`);
      return textResponse('Unauthorized', '*', 401);
    }

    await ensureSchemaOnce(env);
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
        ).bind(userId).first().catch(() => null);
        banned = row?.banned || 0;
      }

      if (!banned && getBotToken(env)) {
        const webAppUrl = webAppUrlWithVersion(env);
        await sendTelegramMessage(
          getBotToken(env),
          update.message.chat.id,
          'Привет! Открой расписание КГЭУ ниже 👇',
          { inline_keyboard: [[{ text: '📅 Открыть расписание', web_app: { url: webAppUrl } }]] }
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
    const telegramId = Number(from?.id || 0);
    if (!telegramId) return;
    const username = String(from.username || '').slice(0, 100);
    const firstName = String(from.first_name || '').slice(0, 120);
    const lastName = String(from.last_name || '').slice(0, 120);

    await env.DB.prepare(
      `INSERT INTO app_users (
        telegram_id, username, first_name, last_name, updated_at
      ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(telegram_id) DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        updated_at = CURRENT_TIMESTAMP
      WHERE app_users.username IS NOT excluded.username
         OR app_users.first_name IS NOT excluded.first_name
         OR app_users.last_name IS NOT excluded.last_name`
    )
      .bind(telegramId, username, firstName, lastName)
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
    }, 5000);

    try { await res.text(); } catch (e) {}
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
  try {
    await ensureSchemaOnce(env);
  } catch (e) {
    console.error('Schema unavailable:', e);
  }

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
    return await handleFreeAuds(request, env, url, corsOrigin);
  }

  if (subPath === '/lists') {
    return await handleLists(request, env, ctx, corsOrigin, forceFresh);
  }

  if (subPath === '/schedule-range') {
    return await handleScheduleRange(request, env, ctx, url, corsOrigin, forceFresh);
  }

  if (ALLOWED_PROXY_PATHS.has(subPath) || subPath.toLowerCase() === '/rasp') {
    return await handleProxy(request, env, ctx, url, subPath, corsOrigin, forceFresh);
  }

  return jsonResponse({ ok: false, error: 'NOT_FOUND' }, 404, corsOrigin);
}

// =====================================================
// Free classrooms
// =====================================================
//
// API КГЭУ не отдаёт расписание всех аудиторий за один запрос и не принимает
// списки id, поэтому занятость считается по одной аудитории. Чтобы уложиться
// в лимиты Free-плана, клиент запрашивает аудитории порциями (ids=...),
// каждый ответ кэшируется на edge на неделю, повторные поиски почти бесплатны.

const FREE_AUD_CHUNK = 20;

// KGEU_HEADERS используется всеми запросами к API вуза.
function kgeuHeaders() {
  return {
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': 'https://kabinet.kgeu.ru/'
  };
}

function serverLessonTitle(l) {
  const value = l?.дисциплина ?? l?.Дисциплина ?? l?.subject ?? l?.Subject ?? l?.name ?? l?.Name ?? l?.title ?? l?.Title ?? '';
  if (value && typeof value === 'object') {
    return String(value.name ?? value.Name ?? value.title ?? value.название ?? '').trim();
  }
  return String(value || '').trim();
}

function serverLessonGroups(l) {
  const value = l?.группа ?? l?.Группа ?? l?.группы ?? l?.Группы ?? l?.ГруппыСтрокой ?? l?.group ?? l?.Group ?? '';
  if (Array.isArray(value)) {
    return value.map(item => String(item?.name ?? item ?? '').trim()).filter(Boolean);
  }
  return String(value || '')
    .split(/[,;]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

async function handleFreeAuds(request, env, url, corsOrigin) {
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ ok: false, error: 'UNAUTHORIZED' }, 401, corsOrigin);

  const date = String(url.searchParams.get('date') || '').trim();
  const start = String(url.searchParams.get('start') || '').trim();
  const end = String(url.searchParams.get('end') || '').trim();

  if (!validateISODate(date)) {
    return jsonResponse({ ok: false, error: 'BAD_DATE' }, 400, corsOrigin);
  }

  const startMin = parseHM(start);
  const endMin = parseHM(end);
  if (startMin === null || endMin === null || endMin <= startMin) {
    return jsonResponse({ ok: false, error: 'BAD_TIME' }, 400, corsOrigin);
  }

  if (!takeUserRateSlot(user.id, 'free-auds', FREE_AUD_USER_LIMIT)) {
    return jsonResponse({ ok: false, error: 'RATE_LIMITED' }, 429, corsOrigin);
  }

  let lists;
  try {
    lists = await buildLists(env, false);
  } catch (e) {
    await safeLog(env, 'ERROR', `free-auds lists: ${e?.message || e}`);
    return jsonResponse({ ok: false, error: 'NO_AUDS' }, 502, corsOrigin);
  }

  const auds = Array.isArray(lists?.Aud) ? lists.Aud : [];
  const byId = new Map();
  for (const aud of auds) {
    const id = String(aud?.id ?? '').trim();
    if (id) byId.set(id, { id, name: String(aud?.name ?? '').trim() });
  }
  if (!byId.size) return jsonResponse({ ok: false, error: 'NO_AUDS' }, 502, corsOrigin);

  // ids — порция аудиторий от клиента. Без параметра отдаём первую порцию,
  // чтобы не сломать старый клиент.
  const idsRaw = String(url.searchParams.get('ids') || '').trim();
  let requested;
  if (idsRaw) {
    requested = [...new Set(idsRaw
      .split(',')
      .map(value => String(value).trim())
      .filter(value => byId.has(value)))].slice(0, FREE_AUD_CHUNK);
    if (!requested.length) {
      return jsonResponse({ ok: false, error: 'BAD_ROOMS' }, 400, corsOrigin);
    }
  } else {
    requested = [...byId.keys()].slice(0, FREE_AUD_CHUNK);
  }

  const cacheKey = `/api/free-auds?date=${date}&start=${start}&end=${end}&ids=${requested.join(',')}`;
  const edgeKey = new Request(`https://kgeu-cache.invalid${cacheKey}`);

  try {
    const cached = await caches.default.match(edgeKey);
    if (cached) return withCors(cached, corsOrigin);
  } catch (e) {}

  // Ответ API КГЭУ всегда содержит всю неделю, поэтому фильтрация по дате
  // обязательна: без неё занятость берётся из чужого дня.
  const results = await mapServerWithConcurrency(requested, 5, async roomId => {
    const room = byId.get(roomId);
    try {
      const day = await fetchScheduleDayResult(env, 'Aud', roomId, date, false);
      const parsed = JSON.parse(day.text);
      const lessons = extractLessonsServer(parsed);
      const dayLessons = filterLessonsByDateServer(lessons, date);
      const busyLesson = dayLessons.find(lesson => {
        const time = parseTimeServer(serverLessonTime(lesson));
        return time && time.start < endMin && time.end > startMin;
      });

      if (!busyLesson) return { room, busy: false };

      return {
        room,
        busy: true,
        occupiedBy: {
          title: serverLessonTitle(busyLesson),
          time: serverLessonTime(busyLesson),
          groups: serverLessonGroups(busyLesson)
        }
      };
    } catch (e) {
      return { room, busy: null, error: true };
    }
  });

  const free = [];
  const busyRooms = [];
  let failed = 0;

  for (const item of results) {
    if (!item || item.busy === null) {
      failed += 1;
      continue;
    }
    if (item.busy) {
      busyRooms.push({
        id: item.room.id,
        name: item.room.name,
        title: item.occupiedBy?.title || '',
        time: item.occupiedBy?.time || '',
        groups: item.occupiedBy?.groups || []
      });
    } else {
      free.push(item.room);
    }
  }

  const payload = JSON.stringify({
    ok: true,
    date,
    start,
    end,
    totalRooms: byId.size,
    total: requested.length,
    busy: busyRooms.length,
    failed,
    free,
    busyRooms,
    chunkSize: FREE_AUD_CHUNK,
    nextIds: [...byId.keys()].filter(id => !requested.includes(id)).slice(0, FREE_AUD_CHUNK)
  });

  try {
    cachePutText(edgeKey, payload, 'application/json; charset=utf-8', EDGE_TTLS.freeAuds);
  } catch (e) {}

  return new Response(payload, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': corsOrigin,
      'Cache-Control': `public, max-age=${EDGE_TTLS.freeAuds}`
    }
  });
}
// =====================================================
// Lists
// =====================================================

async function handleLists(request, env, ctx, corsOrigin, forceFresh) {
  const edgeKey = new Request('https://kgeu-cache.invalid/api/lists?v=2');

  if (!forceFresh) {
    try {
      const cached = await caches.default.match(edgeKey);
      if (cached) return withCors(cached, corsOrigin);
    } catch (e) {}
  }

  try {
    const data = await buildLists(env, forceFresh);
    const text = JSON.stringify(data);
    const response = new Response(text, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': corsOrigin,
        'Cache-Control': `public, max-age=${EDGE_TTLS.lists}`
      }
    });

    // Запись в edge-кэш должна жить дольше ответа, иначе Cloudflare её отбросит.
    const put = cachePutText(edgeKey, text, 'application/json; charset=utf-8', EDGE_TTLS.lists);
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(put);

    return response;
  } catch (e) {
    console.error('Lists error:', e);
    await safeLog(env, 'ERROR', `lists: ${e?.message || e}`);

    // Единственный живой D1-фолбэк: списки действительно пишутся в schedule_cache.
    const stale = await getCache(env, '/api/lists?v=2');
    if (stale) {
      try {
        return jsonResponse(JSON.parse(stale), 200, corsOrigin);
      } catch (e2) {}
    }

    // Раньше клиент получал 200 с пустыми списками и молча ломался.
    return jsonResponse({ ok: false, error: 'LISTS_UNAVAILABLE', Group: [], Teacher: [], Aud: [] }, 503, corsOrigin);
  }
}

async function buildLists(env, forceFresh = false) {
  // v2: в списках появились faculty/facultyId, старый кэш не подходит.
  const cacheKey = '/api/lists?v=2';
  const flightKey = forceFresh ? 'force' : 'normal';
  const existing = listInflight.get(flightKey);
  if (existing) return await existing;

  const promise = (async () => {
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

    if (!result.Group.length && !result.Teacher.length && !result.Aud.length) {
      throw new Error('LISTS_UNAVAILABLE');
    }

    const payload = JSON.stringify(result);
    await saveCache(env, cacheKey, payload);
    return result;
  })();

  listInflight.set(flightKey, promise);
  try {
    return await promise;
  } finally {
    listInflight.delete(flightKey);
  }
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

  // Факультет нужен клиенту, чтобы не подмешивать чужие группы из расписания
  // преподавателя (КГЭУ перечисляет там весь поток, включая другие факультеты).
  const faculty = item.facul ?? item.faculty ?? item.Факультет ?? '';
  const facultyId = item.facultyID ?? item.facultyId ?? item.faculty_id ?? '';
  const course = item.kurs ?? item.course ?? item.Курс ?? '';

  return {
    id: cleanId,
    name: cleanName,
    ...(String(faculty).trim() ? { faculty: String(faculty).trim() } : {}),
    ...(String(facultyId).trim() ? { facultyId: String(facultyId).trim() } : {}),
    ...(String(course).trim() ? { course: String(course).trim() } : {})
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
      if (!incoming.has(to) && incoming.has(from)) incoming.set(to, incoming.get(from) || '');
      incoming.delete(from);
    }
  }

  // Любой прокси-роут требует авторизации: раньше списки были открыты и
  // превращали воркер в бесплатный прокси к API вуза с произвольным query.
  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ ok: false, error: 'UNAUTHORIZED' }, 401, corsOrigin);

  // /Rasp — канонический день. День, неделя и месяц идут через один helper,
  // поэтому у них общий edge-ключ, общий stale-фолбэк и одинаковый контракт.
  if (targetPath.toLowerCase() === '/rasp') {
    const scheduleType = incoming.has('idTeacher') ? 'Teacher' : incoming.has('idAudLine') ? 'Aud' : 'Group';
    const scheduleId = String(incoming.get(scheduleIdParam(scheduleType)) || '').trim();
    const scheduleDate = String(incoming.get('sdate') || '').trim();

    if (!scheduleId || !validateISODate(scheduleDate)) {
      return jsonResponse({ ok: false, error: 'BAD_REQUEST' }, 400, corsOrigin);
    }
    const rateBucket = scheduleType === 'Group' ? 'schedule' : 'schedule-detail';
    const rateLimit = scheduleType === 'Group' ? SCHEDULE_USER_LIMIT : DETAIL_USER_LIMIT;
    if (!takeUserRateSlot(user.id, rateBucket, rateLimit)) {
      return jsonResponse({ ok: false, error: 'RATE_LIMITED' }, 429, corsOrigin);
    }

    try {
      const result = await fetchScheduleDayResult(env, scheduleType, scheduleId, scheduleDate, forceFresh);
      return makeProxyResponse(result, corsOrigin, getScheduleEdgeTtl(scheduleDate));
    } catch (e) {
      await safeLog(env, 'ERROR', `proxy /Rasp ${scheduleType}:${scheduleId}:${scheduleDate}: ${e?.message || e}`);
      return jsonResponse({ ok: false, error: 'EXTERNAL_API_UNAVAILABLE' }, 502, corsOrigin);
    }
  }

  if (!takeUserRateSlot(user.id, 'schedule', SCHEDULE_USER_LIMIT)) {
    return jsonResponse({ ok: false, error: 'RATE_LIMITED' }, 429, corsOrigin);
  }

  const targetSearch = incoming.toString();
  const cacheKey = `/api${targetPath}${targetSearch ? `?${targetSearch}` : ''}`;
  const edgeKey = new Request(`https://kgeu-cache.invalid${cacheKey}`);
  const ttl = EDGE_TTLS.lists;

  if (!forceFresh) {
    try {
      const cached = await caches.default.match(edgeKey);
      if (cached) return withCors(cached, corsOrigin);
    } catch (e) {}
  } else {
    const last = refreshGate.get(cacheKey) || 0;
    if (Date.now() - last < FORCE_REFRESH_COOLDOWN_MS) {
      try {
        const cached = await caches.default.match(edgeKey);
        if (cached) return withCors(cached, corsOrigin);
      } catch (e) {}
      forceFresh = false;
    }
    if (forceFresh) refreshGate.set(cacheKey, Date.now());
  }

  const flightKey = `${forceFresh ? 'force' : 'normal'}:${cacheKey}`;
  const existing = proxyInflight.get(flightKey);
  if (existing) return makeProxyResponse(await existing, corsOrigin, ttl);

  const targetUrl = `${env.KABINET_API}${targetPath}${targetSearch ? `?${targetSearch}` : ''}`;
  const promise = (async () => {
    try {
      // fetchJsonWithTimeout проверяет state/msg API вуза: ответы вида
      // {"state":-1} больше не считаются успешными и не попадают в кэш.
      const data = await fetchJsonWithTimeout(targetUrl, { method: 'GET', headers: kgeuHeaders() }, 12000);
      const text = JSON.stringify(data);
      await cachePutText(edgeKey, text, 'application/json; charset=utf-8', ttl);
      return { status: 200, text, contentType: 'application/json; charset=utf-8' };
    } catch (e) {
      console.error('Proxy error:', e);
      await safeLog(env, 'ERROR', `proxy ${targetPath}: ${e?.message || e}`);
      return {
        status: 502,
        text: JSON.stringify({ ok: false, error: 'EXTERNAL_API_UNAVAILABLE' }),
        contentType: 'application/json; charset=utf-8'
      };
    }
  })();

  proxyInflight.set(flightKey, promise);
  try {
    return makeProxyResponse(await promise, corsOrigin, ttl);
  } finally {
    proxyInflight.delete(flightKey);
  }
}

function makeProxyResponse(result, corsOrigin, ttl) {
  return new Response(result.text, {
    status: result.status,
    headers: {
      'Content-Type': result.contentType,
      'Access-Control-Allow-Origin': corsOrigin,
      'Cache-Control': `public, max-age=${Math.max(1, ttl)}`
    }
  });
}

function withCors(response, corsOrigin) {
  const out = new Response(response.body, response);
  out.headers.set('Access-Control-Allow-Origin', corsOrigin);
  return out;
}

function cachePutText(cacheKeyRequest, text, contentType, ttlSeconds) {
  try {
    const response = new Response(text, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': `public, max-age=${Math.max(1, ttlSeconds)}`
      }
    });
    return caches.default.put(cacheKeyRequest, response).catch(() => {});
  } catch (e) {
    return Promise.resolve();
  }
}

// Пользователи в Москве (UTC+3): ночью UTC-«сегодня» — это вчерашний день,
// из-за чего «сегодня» кэшировалось как обычный день на 30 минут.
function moscowDateStr(offsetDays = 0) {
  const shifted = Date.now() + offsetDays * 24 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000;
  return new Date(shifted).toISOString().slice(0, 10);
}

function getScheduleEdgeTtl(dateStr) {
  if (!dateStr) return EDGE_TTLS.scheduleOther;
  return dateStr === moscowDateStr() ? EDGE_TTLS.scheduleToday : EDGE_TTLS.scheduleOther;
}

function validateISODate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function normalizeScheduleModeServer(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'teacher' || v === 'преподаватель' || v === 'tch') return 'Teacher';
  if (v === 'aud' || v === 'auditorium' || v === 'audline' || v === 'аудитория') return 'Aud';
  return 'Group';
}

function scheduleIdParam(type) {
  return type === 'Group' ? 'idGroup' : type === 'Teacher' ? 'idTeacher' : 'idAudLine';
}


// API КГЭУ отдаёт расписание всей недели, игнорируя sdate. Поэтому ключ кэша —
// понедельник этой недели: иначе один и тот же ответ кэшировался 5 раз, а
// запрос диапазона на 7 дней делал 7 одинаковых обращений к API вуза.
function weekStartOf(dateStr) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return String(dateStr);
  const weekday = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + (weekday === 0 ? -6 : 1 - weekday));
  return date.toISOString().slice(0, 10);
}

function buildScheduleDayCacheKey(type, id, dateStr) {
  const params = new URLSearchParams();
  params.set(scheduleIdParam(type), String(id));
  params.set('sdate', weekStartOf(dateStr));
  return `/api/Rasp?${params.toString()}`;
}

function buildScheduleDayEdgeKey(type, id, dateStr) {
  return new Request(`https://kgeu-cache.invalid${buildScheduleDayCacheKey(type, id, dateStr)}`);
}

async function fetchScheduleDayResult(env, type, id, dateStr, forceFresh = false) {
  const cacheKey = buildScheduleDayCacheKey(type, id, dateStr);
  const edgeKey = buildScheduleDayEdgeKey(type, id, dateStr);
  const ttl = getScheduleEdgeTtl(dateStr);

  // Day, week and month all use exactly the same per-day cache pipeline.
  // This prevents the range endpoint from silently bypassing the day endpoint's
  // edge cache and D1 stale fallback.
  if (!forceFresh) {
    try {
      const cached = await caches.default.match(edgeKey);
      if (cached) {
        return {
          status: cached.status || 200,
          text: await cached.text(),
          contentType: cached.headers.get('Content-Type') || 'application/json; charset=utf-8',
          fromCache: true
        };
      }
    } catch (e) {}
  }

  const flightKey = `${forceFresh ? 'force' : 'normal'}:${cacheKey}`;
  const existing = proxyInflight.get(flightKey);
  if (existing) return await existing;

  const promise = (async () => {
    const targetPath = '/Rasp';
    const targetSearch = new URLSearchParams();
    targetSearch.set(scheduleIdParam(type), String(id));
    targetSearch.set('sdate', String(dateStr));
    const targetUrl = `${env.KABINET_API}${targetPath}?${targetSearch.toString()}`;

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
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const parsed = safeJsonParse(text);
      if (!parsed) throw new Error('NON_JSON_SCHEDULE');
      assertKgeuPayload(parsed, targetUrl);

      const contentType = res.headers.get('Content-Type') || 'application/json; charset=utf-8';
      await cachePutText(edgeKey, text, contentType, ttl);

      return { status: 200, text, contentType, fromCache: false };
    } catch (e) {
      console.error('Schedule day proxy error:', e);

      // Legacy D1 schedule_cache is the last-resort stale fallback only.
      // Successful new schedule responses continue to live only at the edge.
      // Accept both the canonical /api/Rasp key and the lowercase form used by
      // an older build, so an existing database remains useful after upgrade.
      const legacyKeys = [
        cacheKey,
        cacheKey.replace('/api/Rasp?', '/api/rasp?')
      ];
      let stale = null;
      for (const legacyKey of legacyKeys) {
        stale = await getCache(env, legacyKey);
        if (stale) break;
      }
      if (stale) {
        return {
          status: 200,
          text: stale,
          contentType: 'application/json; charset=utf-8',
          stale: true
        };
      }

      throw e;
    }
  })();

  proxyInflight.set(flightKey, promise);
  try {
    return await promise;
  } finally {
    proxyInflight.delete(flightKey);
  }
}

async function handleScheduleRange(request, env, ctx, url, corsOrigin, forceFresh) {
  if (request.method !== 'GET') {
    return jsonResponse({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405, corsOrigin);
  }

  const user = await requireUser(request, env);
  if (!user) return jsonResponse({ ok: false, error: 'UNAUTHORIZED' }, 401, corsOrigin);

  const type = normalizeScheduleModeServer(url.searchParams.get('type') || 'Group');
  const id = String(url.searchParams.get('id') || '').trim();
  const start = String(url.searchParams.get('start') || '').trim();
  const daysRaw = Number(url.searchParams.get('days') || 7);
  const days = Math.max(1, Math.min(7, daysRaw));

  if (!id || !validateISODate(start) || !Number.isInteger(daysRaw)) {
    return jsonResponse({ ok: false, error: 'BAD_REQUEST' }, 400, corsOrigin);
  }

  const dateList = Array.from({ length: days }, (_, index) => {
    const d = new Date(`${start}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + index);
    return d.toISOString().slice(0, 10);
  });

  const cacheKey = `/api/schedule-range?v=4&type=${type}&id=${encodeURIComponent(id)}&start=${start}&days=${days}`;
  const edgeKey = new Request(`https://kgeu-cache.invalid${cacheKey}`);
  const today = new Date().toISOString().slice(0, 10);
  const ttl = dateList.includes(today) ? EDGE_TTLS.scheduleRangeToday : EDGE_TTLS.scheduleRangeOther;

  if (!forceFresh) {
    try {
      const cached = await caches.default.match(edgeKey);
      if (cached) return withCors(cached, corsOrigin);
    } catch (e) {}
  } else {
    const last = refreshGate.get(cacheKey) || 0;
    if (Date.now() - last < FORCE_REFRESH_COOLDOWN_MS) {
      try {
        const cached = await caches.default.match(edgeKey);
        if (cached) return withCors(cached, corsOrigin);
      } catch (e) {}
      forceFresh = false;
    }
    if (forceFresh) refreshGate.set(cacheKey, Date.now());
  }

  if (!takeUserRateSlot(user.id, 'range', RANGE_USER_LIMIT)) {
    return jsonResponse({ ok: false, error: 'RATE_LIMITED' }, 429, corsOrigin);
  }

  const flightKey = `${forceFresh ? 'force' : 'normal'}:${cacheKey}`;
  const existing = proxyInflight.get(flightKey);
  if (existing) {
    const shared = await existing;
    return new Response(shared.text, {
      status: shared.status || 200,
      headers: {
        'Content-Type': shared.contentType || 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': corsOrigin,
        'Cache-Control': shared.cacheControl || `public, max-age=${ttl}, must-revalidate`
      }
    });
  }

  const promise = (async () => {
    const result = {};
    const failures = {};
    const staleDates = {};
    const queue = [...dateList];

    // Keep upstream fan-out conservative on Free. The range endpoint still
    // produces one Worker request for 1–7 dates, while only 4 KGEU requests can
    // be in flight at once.
    const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        const dateStr = queue.shift();
        try {
          let day = null;
          let lastError = null;

          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              day = await fetchScheduleDayResult(env, type, id, dateStr, forceFresh);
              lastError = null;
              break;
            } catch (e) {
              lastError = e;
              if (attempt === 0) await sleepServer(250);
            }
          }

          if (!day) throw (lastError || new Error('SCHEDULE_DAY_UNAVAILABLE'));
          try {
            result[dateStr] = JSON.parse(day.text);
          } catch (e) {
            throw new Error(`INVALID_JSON_${dateStr}`);
          }
          if (day.stale) staleDates[dateStr] = true;
        } catch (e) {
          failures[dateStr] = true;
        }
      }
    });

    await Promise.all(workers);

    const payload = JSON.stringify({
      ok: true,
      format: 'raw-api-v4',
      type,
      id,
      start,
      days,
      data: result,
      errors: failures,
      stale: staleDates
    });

    const isPartial = Object.keys(failures).length > 0;

    // Only a complete range is persisted as a range cache entry. Individual
    // days were already cached by fetchScheduleDayResult(), so a partial range
    // never poisons the range cache.
    if (!isPartial) await cachePutText(edgeKey, payload, 'application/json; charset=utf-8', ttl);

    return {
      status: 200,
      text: payload,
      contentType: 'application/json; charset=utf-8',
      cacheControl: `public, max-age=${isPartial ? 0 : ttl}, must-revalidate`
    };
  })().catch(async e => {
    console.error('schedule-range error:', e);
    await safeLog(env, 'ERROR', `schedule-range ${type}:${id}:${start}: ${e?.message || e}`);
    return {
      status: 502,
      text: JSON.stringify({ ok: false, error: 'EXTERNAL_API_UNAVAILABLE' }),
      contentType: 'application/json; charset=utf-8',
      cacheControl: 'no-store'
    };
  });

  proxyInflight.set(flightKey, promise);
  try {
    const shared = await promise;
    return new Response(shared.text, {
      status: shared.status || 200,
      headers: {
        'Content-Type': shared.contentType || 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': corsOrigin,
        'Cache-Control': shared.cacheControl || `public, max-age=${ttl}, must-revalidate`
      }
    });
  } finally {
    proxyInflight.delete(flightKey);
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
  if (typeof data !== 'string') data = JSON.stringify(data);
  if (data.length > MAX_D1_CACHE_BYTES) {
    console.warn(`D1 cache skipped for ${key}: ${data.length} bytes`);
    return;
  }

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

    return jsonResponse({
      ...(row || {}),
      isAdmin: getAdminIds(env).has(Number(user.id))
    }, 200, corsOrigin);
  }

  if (request.method === 'POST') {
    if (!takeUserRateSlot(user.id, 'user-sync', USER_SYNC_WRITE_LIMIT)) {
      return jsonResponse({ ok: false, error: 'RATE_LIMITED' }, 429, corsOrigin);
    }
    try {
      const body = await request.json();
      const settings = body?.settings;
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        return jsonResponse({ ok: false, error: 'BAD_REQUEST' }, 400, corsOrigin);
      }

      // Частичное обновление: клиент присылает только изменённые поля, и
      // отсутствующие настройки больше не затираются значениями по умолчанию.
      const columns = [
        ['username', user.username || '', 100],
        ['first_name', user.first_name || '', 120],
        ['last_name', user.last_name || '', 120],
        ['selected_id', settings.selected_id, 100],
        ['selected_name', settings.selected_name, 200],
        ['selected_type', settings.selected_type, 20],
        ['theme', settings.theme, 80],
        ['subgroup', settings.subgroup, 10],
        ['favorites_json', settings.favorites_json, 30000],
        ['selections_json', settings.selections_json, 10000]
      ].filter(([, value]) => value !== undefined && value !== null);

      // Строка должна существовать, чтобы UPDATE не потерял остальные поля.
      await env.DB.prepare(
        `INSERT INTO app_users (telegram_id, updated_at) VALUES (?, CURRENT_TIMESTAMP)
         ON CONFLICT(telegram_id) DO NOTHING`
      ).bind(user.id).run();

      const assignments = [];
      const values = [];
      for (const [column, value, maxLength] of columns) {
        assignments.push(`${column} = ?`);
        values.push(String(value).slice(0, maxLength));
      }
      assignments.push('updated_at = CURRENT_TIMESTAMP');

      await env.DB.prepare(
        `UPDATE app_users SET ${assignments.join(', ')} WHERE telegram_id = ?`
      ).bind(...values, user.id).run();

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
    if (!takeUserRateSlot(user.id, 'task-write', TASK_WRITE_LIMIT)) {
      return jsonResponse({ ok: false, error: 'RATE_LIMITED' }, 429, corsOrigin);
    }
    try {
      const body = await request.json();

      const lessonTitle = String(body.lesson_title || '').slice(0, 200);
      const taskText = String(body.task_text || '').slice(0, 1000);
      const dueDate = String(body.due_date || '').slice(0, 20);
      const noteKey = String(body.note_key || '').slice(0, 500);
      const lessonTime = String(body.lesson_time || '').slice(0, 50);
      const lessonRoom = String(body.lesson_room || '').slice(0, 100);
      const lessonSubgroup = String(body.lesson_subgroup || '0').slice(0, 10);
      const noteType = String(body.note_type || 'note').slice(0, 20) || 'note';

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
    if (!takeUserRateSlot(user.id, 'task-write', TASK_WRITE_LIMIT)) {
      return jsonResponse({ ok: false, error: 'RATE_LIMITED' }, 429, corsOrigin);
    }
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
    ).bind(user.id).all().catch(() => ({ results: [] }));
    return jsonResponse(rows.results || [], 200, corsOrigin);
  }

  if (request.method === 'POST') {
    if (!takeUserRateSlot(user.id, 'reminder-write', REMINDER_WRITE_LIMIT)) {
      return jsonResponse({ ok: false, error: 'RATE_LIMITED' }, 429, corsOrigin);
    }
    try {
      const body = await request.json();
      const clientRemindAt = Number(body.remind_at || 0);
      const lessonStartAt = Number(body.lesson_start_at || 0);
      const leadMinutes = Number(body.lead_minutes ?? 15);
      const message = String(body.message || '').slice(0, 500);
      const reminderKeyRaw = String(body.reminder_key || '').slice(0, 500);

      if (!Number.isFinite(clientRemindAt) || clientRemindAt <= 0 || !message.trim()) {
        return jsonResponse({ ok: false, error: 'BAD_REQUEST' }, 400, corsOrigin);
      }
      if (!Number.isInteger(leadMinutes) || leadMinutes < 0 || leadMinutes > 1440 || leadMinutes % 5 !== 0) {
        return jsonResponse({ ok: false, error: 'BAD_LEAD_MINUTES' }, 400, corsOrigin);
      }
      const nowMs = Date.now();
      if (!Number.isFinite(lessonStartAt) || lessonStartAt <= 0) {
        return jsonResponse({ ok: false, error: 'BAD_LESSON_TIME' }, 400, corsOrigin);
      }
      if (lessonStartAt < nowMs) {
        return jsonResponse({ ok: false, error: 'LESSON_ALREADY_STARTED' }, 400, corsOrigin);
      }

      // Авторитетная метка считается на сервере из начала пары и выбранного
      // (кратного 5 минутам) времени.
      const lessonStartRounded = Math.round(lessonStartAt);
      const remindAt = Math.round(lessonStartRounded - leadMinutes * 60 * 1000);
      if (!Number.isFinite(remindAt) || remindAt <= 0 || remindAt < nowMs - 60 * 1000) {
        return jsonResponse({ ok: false, error: 'REMINDER_IN_PAST' }, 400, corsOrigin);
      }
      if (Math.abs(remindAt - clientRemindAt) > 2 * 60 * 1000) {
        return jsonResponse({ ok: false, error: 'REMINDER_TIME_MISMATCH' }, 400, corsOrigin);
      }
      if (remindAt > nowMs + 180 * 24 * 60 * 60 * 1000) {
        return jsonResponse({ ok: false, error: 'REMINDER_TOO_FAR' }, 400, corsOrigin);
      }

      // Пустой ключ раньше означал «только одно напоминание на пользователя».
      // Теперь ключом становится начало пары, чтобы напоминания не схлопывались.
      const reminderKey = reminderKeyRaw || `lesson:${lessonStartRounded}`;

      // Одна пара — одно напоминание: при смене «за N минут» старое заменяется,
      // иначе пользователь получал два уведомления на одну пару.
      await env.DB.prepare(
        `DELETE FROM reminders
         WHERE telegram_id = ? AND sent = 0
           AND lesson_start_at = ? AND reminder_key <> ?`
      ).bind(user.id, lessonStartRounded, reminderKey).run().catch(() => {});

      // Атомарная защита от дублей: проверка и вставка — один SQL-оператор.
      const insert = await env.DB.prepare(
        `INSERT INTO reminders (
          telegram_id, remind_at, message, sent, attempts,
          lesson_start_at, lead_minutes, reminder_key, locked_at
        )
        SELECT ?, ?, ?, 0, 0, ?, ?, ?, 0
        WHERE NOT EXISTS (
          SELECT 1 FROM reminders
          WHERE telegram_id = ? AND reminder_key = ? AND sent = 0
        )`
      ).bind(
        user.id, remindAt, message,
        lessonStartRounded, leadMinutes, reminderKey, user.id, reminderKey
      ).run();

      const changes = Number(insert?.meta?.changes ?? insert?.changes ?? 0);
      if (!changes) {
        const duplicate = await env.DB.prepare(
          `SELECT id FROM reminders
           WHERE telegram_id = ? AND reminder_key = ? AND sent = 0
           ORDER BY id ASC LIMIT 1`
        ).bind(user.id, reminderKey).first().catch(() => null);
        return jsonResponse({ ok: true, duplicate: true, id: duplicate?.id || null }, 200, corsOrigin);
      }

      return jsonResponse({ ok: true, id: insert?.meta?.last_row_id ?? insert?.lastRowId ?? null }, 200, corsOrigin);
    } catch (e) {
      console.error('Reminder save error:', e);
      return jsonResponse({ ok: false, error: 'BAD_REQUEST' }, 400, corsOrigin);
    }
  }

  if (request.method === 'DELETE') {
    if (!takeUserRateSlot(user.id, 'reminder-write', REMINDER_WRITE_LIMIT)) {
      return jsonResponse({ ok: false, error: 'RATE_LIMITED' }, 429, corsOrigin);
    }
    if (url.searchParams.get('all') === '1') {
      await env.DB.prepare(`DELETE FROM reminders WHERE telegram_id = ? AND sent = 0`).bind(user.id).run().catch(() => {});
      return jsonResponse({ ok: true }, 200, corsOrigin);
    }

    const id = Number(url.searchParams.get('id') || 0);
    if (!id) return jsonResponse({ ok: false, error: 'BAD_REQUEST' }, 400, corsOrigin);

    await env.DB.prepare(`DELETE FROM reminders WHERE id = ? AND telegram_id = ?`).bind(id, user.id).run().catch(() => {});
    return jsonResponse({ ok: true }, 200, corsOrigin);
  }

  return jsonResponse({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405, corsOrigin);
}

async function processReminders(env) {
  try {
    const now = Date.now();
    const staleLock = now - 10 * 60 * 1000;
    const due = await env.DB.prepare(
      `SELECT r.*
       FROM reminders r
       LEFT JOIN app_users u ON u.telegram_id = r.telegram_id
       WHERE (r.sent = 0 OR (r.sent = -1 AND r.locked_at < ?))
         AND r.attempts < 3
         AND r.remind_at <= ?
         AND IFNULL(u.banned, 0) = 0
       ORDER BY r.remind_at ASC
       LIMIT 25`
    ).bind(staleLock, now).all().catch(() => ({ results: [] }));

    let rows = due.results || [];
    if (!rows.length) return;

    // Claim rows before sending so overlapping cron invocations cannot send the
    // same reminder twice. A stale claim is automatically reclaimable after 10m.
    const claimed = [];
    for (const row of rows) {
      const result = await env.DB.prepare(
        `UPDATE reminders SET sent = -1, locked_at = ?
         WHERE id = ? AND (sent = 0 OR (sent = -1 AND locked_at < ?))`
      ).bind(now, row.id, staleLock).run().catch(() => null);
      if (result?.meta?.changes || result?.changes) claimed.push(row);
    }
    rows = claimed;
    if (!rows.length) return;

    const results = await mapServerWithConcurrency(rows, 5, async row => {
      const botToken = getBotToken(env);
      if (!botToken) return { id: row.id, ok: false };
      const ok = await sendTelegramMessage(botToken, row.telegram_id, row.message);
      return { id: row.id, ok };
    });

    const sentIds = results.filter(r => r.ok).map(r => r.id);
    const failedIds = results.filter(r => !r.ok).map(r => r.id);
    const statements = [];

    if (sentIds.length) {
      const marks = sentIds.map(() => '?').join(',');
      statements.push(env.DB.prepare(
        `UPDATE reminders SET sent = 1, locked_at = 0 WHERE id IN (${marks}) AND sent = -1`
      ).bind(...sentIds));
    }
    if (failedIds.length) {
      const marks = failedIds.map(() => '?').join(',');
      statements.push(env.DB.prepare(
        `UPDATE reminders
         SET attempts = attempts + 1,
             sent = CASE WHEN attempts + 1 >= 3 THEN 2 ELSE 0 END,
             locked_at = 0
         WHERE id IN (${marks}) AND sent = -1`
      ).bind(...failedIds));
    }
    if (statements.length) await env.DB.batch(statements);
  } catch (e) {
    console.error('processReminders error:', e);
  }
}

async function mapServerWithConcurrency(items, limit, workerFn) {
  const results = new Array(items.length);
  let next = 0;
  async function runner() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await workerFn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

const BROADCAST_FILL_CHUNK = 200;

// D1 не даёт вставить тысячи строк в одном invocation, поэтому очередь
// наполняется порциями (200 за тик крона), а не обрезается лимитом.
async function fillBroadcastQueue(env, jobId, total, limit = BROADCAST_FILL_CHUNK) {
  const limitNum = Math.max(1, Number(limit) || BROADCAST_FILL_CHUNK);
  const totalNum = Math.max(0, Number(total) || 0);
  if (!jobId || !totalNum) return 0;

  const queuedRow = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM broadcast_queue WHERE job_id = ?`
  ).bind(jobId).first().catch(() => null);
  let queued = Number(queuedRow?.c || 0);

  let inserted = 0;
  while (queued < totalNum && inserted < limitNum) {
    const batchSize = Math.min(100, totalNum - queued, limitNum - inserted);
    const page = await env.DB.prepare(
      `SELECT telegram_id FROM app_users
       WHERE IFNULL(banned, 0) = 0 AND updated_at >= datetime('now', '-30 days')
       ORDER BY telegram_id ASC
       LIMIT ? OFFSET ?`
    ).bind(batchSize, queued).all().catch(() => ({ results: [] }));

    const recipients = page.results || [];
    if (!recipients.length) break;

    const statements = recipients.map(row =>
      env.DB.prepare(`INSERT INTO broadcast_queue (job_id, telegram_id) VALUES (?, ?)`)
        .bind(jobId, row.telegram_id)
    );
    await env.DB.batch(statements);

    queued += recipients.length;
    inserted += recipients.length;
    if (recipients.length < batchSize) break;
  }

  return queued;
}

async function refillBroadcastQueues(env) {
  const jobs = await env.DB.prepare(
    `SELECT id, total FROM broadcast_jobs
     WHERE status IN ('queued', 'sending') AND finished_at IS NULL
     ORDER BY id ASC LIMIT 5`
  ).all().catch(() => ({ results: [] }));

  for (const job of jobs.results || []) {
    const total = Number(job.total || 0);
    if (!total) continue;
    const queued = await fillBroadcastQueue(env, job.id, total).catch(() => 0);
    if (queued > 0) {
      await env.DB.prepare(
        `UPDATE broadcast_jobs SET status = 'sending' WHERE id = ? AND status = 'queued'`
      ).bind(job.id).run().catch(() => {});
    }
  }
}

async function processBroadcastQueue(env) {
  try {
    // Сначала догоняем очередь текущих рассылок, потом отправляем.
    await refillBroadcastQueues(env);

    const rowsResult = await env.DB.prepare(
      `SELECT q.id, q.job_id, q.telegram_id, q.attempts, j.message
       FROM broadcast_queue q
       JOIN broadcast_jobs j ON j.id = q.job_id
       WHERE q.sent = 0 AND q.attempts < 3 AND j.status IN ('queued', 'sending')
       ORDER BY q.id ASC
       LIMIT 20`
    )
      .all()
      .catch(() => ({ results: [] }));

    const rows = rowsResult.results || [];
    const botToken = getBotToken(env);
    if (!rows.length || !botToken) return;

    const activeJobIds = [...new Set(rows.map(row => row.job_id))];
    for (const jobId of activeJobIds) {
      await env.DB.prepare(
        `UPDATE broadcast_jobs SET status = 'sending' WHERE id = ? AND status = 'queued'`
      ).bind(jobId).run().catch(() => {});
    }

    const results = await mapServerWithConcurrency(rows, 5, async row => {
      const ok = await sendTelegramMessage(botToken, row.telegram_id, row.message);
      return { id: row.id, jobId: row.job_id, ok };
    });

    const sentIds = results.filter(r => r.ok).map(r => r.id);
    const failedIds = results.filter(r => !r.ok).map(r => r.id);

    const statements = [];
    if (sentIds.length) {
      const marks = sentIds.map(() => '?').join(',');
      statements.push(
        env.DB.prepare(`UPDATE broadcast_queue SET sent = 1, sent_at = CURRENT_TIMESTAMP WHERE id IN (${marks})`).bind(...sentIds)
      );
    }
    if (failedIds.length) {
      const marks = failedIds.map(() => '?').join(',');
      statements.push(
        env.DB.prepare(`UPDATE broadcast_queue SET attempts = attempts + 1 WHERE id IN (${marks})`).bind(...failedIds)
      );
    }
    if (statements.length) await env.DB.batch(statements);

    const jobIds = [...new Set(results.map(r => r.jobId))];
    for (const jobId of jobIds) {
      const pending = await env.DB.prepare(
        `SELECT\n           SUM(CASE WHEN sent = 1 THEN 1 ELSE 0 END) AS sent_count,\n           SUM(CASE WHEN sent = 0 AND attempts >= 3 THEN 1 ELSE 0 END) AS failed_count,\n           SUM(CASE WHEN sent = 0 AND attempts < 3 THEN 1 ELSE 0 END) AS pending_count\n         FROM broadcast_queue WHERE job_id = ?`
      ).bind(jobId).first().catch(() => null);

      const sentCount = Number(pending?.sent_count || 0);
      const failedCount = Number(pending?.failed_count || 0);
      const pendingCount = Number(pending?.pending_count || 0);

      if (pendingCount === 0) {
        const status = failedCount ? 'finished_with_errors' : 'finished';
        await env.DB.prepare(
          `UPDATE broadcast_jobs SET status = ?, sent = ?, failed = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`
        ).bind(status, sentCount, failedCount, jobId).run().catch(() => {});
      } else {
        await env.DB.prepare(
          `UPDATE broadcast_jobs SET sent = ?, failed = ? WHERE id = ?`
        ).bind(sentCount, failedCount, jobId).run().catch(() => {});
      }
    }
  } catch (e) {
    console.error('processBroadcastQueue error:', e);
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

  if (subPath === '/admin/users' && request.method === 'GET') {
    const params = new URL(request.url).searchParams;
    const query = String(params.get('q') || '').trim().toLowerCase().slice(0, 100);
    const filter = String(params.get('filter') || 'all').toLowerCase();
    const page = Math.max(1, Math.min(200, Number(params.get('page') || 1) || 1));
    const pageSize = Math.max(5, Math.min(50, Number(params.get('pageSize') || 20) || 20));

    // Кириллица в SQLite не сворачивается регистром в LIKE, поэтому выборка
    // берётся ограниченным срезом, а поиск и фильтр считаются в JS.
    const USERS_SCAN_LIMIT = 3000;

    const counts = await env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN IFNULL(banned, 0) = 1 THEN 1 ELSE 0 END) AS banned
       FROM app_users`
    ).first().catch(() => null);

    const rows = await env.DB.prepare(
      `SELECT telegram_id, username, first_name, last_name, banned,
              selected_name, selected_type, updated_at, created_at
       FROM app_users
       ORDER BY updated_at DESC
       LIMIT ${USERS_SCAN_LIMIT}`
    ).all().catch(() => ({ results: [] }));

    const needle = query.replace(/^@/, '');
    const matchesQuery = user => {
      if (!needle) return true;
      const haystack = [user.first_name, user.last_name, user.username, String(user.telegram_id)]
        .map(value => String(value || '').toLowerCase())
        .join(' ');
      if (haystack.includes(needle)) return true;
      // «иван петров» должно находить «Иван Петров» без учёта пробелов.
      return haystack.replace(/\s+/g, '').includes(needle.replace(/\s+/g, ''));
    };

    const users = rows.results || [];
    const filtered = users.filter(user => {
      if (!matchesQuery(user)) return false;
      const isBanned = Number(user.banned) === 1;
      if (filter === 'banned') return isBanned;
      if (filter === 'active') return !isBanned;
      return true;
    });

    const offset = (page - 1) * pageSize;
    const items = filtered.slice(offset, offset + pageSize).map(user => ({
      telegram_id: Number(user.telegram_id),
      username: user.username || '',
      first_name: user.first_name || '',
      last_name: user.last_name || '',
      banned: Number(user.banned) === 1 ? 1 : 0,
      selected_name: user.selected_name || '',
      selected_type: user.selected_type || '',
      updated_at: user.updated_at || '',
      created_at: user.created_at || ''
    }));

    return jsonResponse({
      ok: true,
      items,
      total: filtered.length,
      page,
      pageSize,
      databaseTotal: Number(counts?.total || 0),
      bannedTotal: Number(counts?.banned || 0),
      truncated: users.length >= USERS_SCAN_LIMIT
    }, 200, corsOrigin);
  }

  if (subPath === '/admin/webhook' && request.method === 'GET') {
    const secret = await getWebhookSecret(env);
    const expectedUrl = webhookUrlFrom(request);

    let info = null;
    let error = null;
    try {
      info = await telegramApi(env, 'getWebhookInfo');
    } catch (e) {
      error = String(e?.message || e);
    }

    const secretOk = !!info?.url && !!info?.has_custom_certificate === false && !info?.last_error_message;
    return jsonResponse({
      ok: !error,
      error,
      expectedUrl,
      urlMatches: !info?.url || info.url === expectedUrl,
      secretConfigured: !!secret,
      telegram: info,
      healthy: !error && info?.url === expectedUrl && !info?.last_error_message
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

  if (request.method === 'POST') {
    let body = {};

    try {
      body = await request.json();
    } catch (e) {}

    if (subPath === '/admin/webhook') {
      const secret = await getWebhookSecret(env);
      if (!secret) {
        return jsonResponse({ ok: false, error: 'NO_BOT_TOKEN', message: 'Не задан BOT_TOKEN' }, 400, corsOrigin);
      }

      const url = webhookUrlFrom(request);
      try {
        await telegramApi(env, 'setWebhook', {
          url,
          secret_token: secret,
          allowed_updates: TELEGRAM_WEBHOOK_ALLOWED_UPDATES,
          drop_pending_updates: false
        });
        const info = await telegramApi(env, 'getWebhookInfo');
        await logAdmin(env, admin.id, 'setWebhook', { url });
        return jsonResponse({
          ok: true,
          message: `Вебхук переустановлен на ${url}`,
          telegram: info
        }, 200, corsOrigin);
      } catch (e) {
        return jsonResponse({
          ok: false,
          error: 'TELEGRAM_ERROR',
          message: String(e?.message || e)
        }, 502, corsOrigin);
      }
    }

    if (subPath === '/admin/clearOldCache') {
      await env.DB.prepare(
        `DELETE FROM schedule_cache
         WHERE cache_key <> '/api/lists'
           AND updated_at < datetime('now', '-14 days')`
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

      await clearUserBanCache(targetId);
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

      const countRow = await env.DB.prepare(
        `SELECT COUNT(*) AS c FROM app_users
         WHERE IFNULL(banned, 0) = 0 AND updated_at >= datetime('now', '-30 days')`
      ).first().catch(() => null);
      const total = Number(countRow?.c || 0);

      if (!total) {
        return jsonResponse({ ok: true, message: 'Нет активных пользователей для рассылки' }, 200, corsOrigin);
      }

      const job = await env.DB.prepare(
        `INSERT INTO broadcast_jobs (admin_id, message, total, status)
         VALUES (?, ?, ?, 'queued')`
      )
        .bind(admin.id, message, total)
        .run();

      const jobId = Number(job?.meta?.last_row_id || job?.lastRowId || 0);
      if (!jobId) {
        return jsonResponse({ ok: false, message: 'Не удалось создать задачу рассылки' }, 500, corsOrigin);
      }

      // Первую порцию ставим сразу, остальное догоняет крон: раньше LIMIT 1000
      // молча отрезал всех, кто не влез в лимит.
      const queued = await fillBroadcastQueue(env, jobId, total).catch(() => 0);

      await logAdmin(env, admin.id, 'broadcast_queued', { jobId, total, queued, length: message.length });

      return jsonResponse({
        ok: true,
        message: `Рассылка создана: ${total} получателей, в очереди ${queued}. Остальные добавятся автоматически.`,
        jobId,
        total,
        queued
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
    `CREATE TABLE IF NOT EXISTS users (
      telegram_id INTEGER PRIMARY KEY,
      selected_id TEXT DEFAULT '14456',
      selected_name TEXT DEFAULT 'ИПК-1-25',
      selected_type TEXT DEFAULT 'group',
      theme TEXT DEFAULT 'glass_dark',
      custom_bg_url TEXT,
      accent_color TEXT DEFAULT '#3b82f6',
      favorites_json TEXT DEFAULT '[]',
      tasks_json TEXT DEFAULT '[]',
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS schedule_cache (
      cache_key TEXT PRIMARY KEY,
      schedule_data TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS system_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT,
      payload TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
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
      lesson_start_at INTEGER DEFAULT 0,
      lead_minutes INTEGER DEFAULT 15,
      reminder_key TEXT DEFAULT '',
      locked_at INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS admin_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      payload TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS broadcast_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER NOT NULL,
      message TEXT NOT NULL,
      total INTEGER DEFAULT 0,
      sent INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0,
      status TEXT DEFAULT 'queued',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      finished_at TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS broadcast_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      telegram_id INTEGER NOT NULL,
      sent INTEGER DEFAULT 0,
      attempts INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      sent_at TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(telegram_id)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_note_key ON tasks(telegram_id, note_key)`,
    `CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(sent, remind_at)`,
    `CREATE INDEX IF NOT EXISTS idx_reminders_key ON reminders(telegram_id, reminder_key, sent)`,
    `CREATE INDEX IF NOT EXISTS idx_reminders_user ON reminders(telegram_id)`,
    `CREATE INDEX IF NOT EXISTS idx_reminders_lesson ON reminders(telegram_id, sent, lesson_start_at)`,
    `CREATE INDEX IF NOT EXISTS idx_app_users_updated ON app_users(updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_app_users_selected ON app_users(selected_type, selected_name)`,
    `CREATE INDEX IF NOT EXISTS idx_cache_updated ON schedule_cache(updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_schedule_cache_key_updated ON schedule_cache(cache_key, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_logs_created ON system_logs(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_admin_events_created ON admin_events(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_broadcast_queue_pending ON broadcast_queue(sent, attempts, id)`,
    `CREATE INDEX IF NOT EXISTS idx_broadcast_queue_job ON broadcast_queue(job_id, sent)`,
    `CREATE INDEX IF NOT EXISTS idx_broadcast_queue_created ON broadcast_queue(created_at, sent, attempts)`,
    `CREATE INDEX IF NOT EXISTS idx_broadcast_jobs_status ON broadcast_jobs(status, created_at)`
  ];

  for (const sql of statements) {
    try { await env.DB.prepare(sql).run(); } catch (e) {}
  }

  for (const ddl of [
    `ALTER TABLE tasks ADD COLUMN note_type TEXT DEFAULT 'note'`,
    `ALTER TABLE tasks ADD COLUMN note_key TEXT DEFAULT ''`,
    `ALTER TABLE tasks ADD COLUMN lesson_time TEXT DEFAULT ''`,
    `ALTER TABLE tasks ADD COLUMN lesson_room TEXT DEFAULT ''`,
    `ALTER TABLE tasks ADD COLUMN lesson_subgroup TEXT DEFAULT '0'`,
    `ALTER TABLE app_users ADD COLUMN selections_json TEXT DEFAULT '{}'`,
    `ALTER TABLE reminders ADD COLUMN lesson_start_at INTEGER DEFAULT 0`,
    `ALTER TABLE reminders ADD COLUMN lead_minutes INTEGER DEFAULT 15`,
    `ALTER TABLE reminders ADD COLUMN reminder_key TEXT DEFAULT ''`,
    `ALTER TABLE reminders ADD COLUMN locked_at INTEGER DEFAULT 0`
  ]) {
    try { await env.DB.prepare(ddl).run(); } catch (e) {}
  }
}

async function ensureSchemaOnce(env) {
  if (!schemaPromise) {
    schemaPromise = ensureSchema(env).catch(e => {
      schemaPromise = null;
      throw e;
    });
  }
  return schemaPromise;
}

async function cleanupDatabase(env) {
  try {
    // Schedule responses are now stored in Workers Cache, not D1. These deletes
    // gradually remove legacy schedule-cache rows after the new version is live.
    await env.DB.prepare(
      `DELETE FROM schedule_cache
       WHERE cache_key <> '/api/lists'
         AND updated_at < datetime('now', '-12 hours')`
    ).run().catch(() => {});

    await env.DB.prepare(
      `DELETE FROM system_logs WHERE created_at < datetime('now', '-7 days')`
    ).run().catch(() => {});

    await env.DB.prepare(
      `DELETE FROM admin_events WHERE created_at < datetime('now', '-30 days')`
    ).run().catch(() => {});

    await env.DB.prepare(
      `DELETE FROM reminders WHERE sent != 0 AND sent != -1 AND created_at < datetime('now', '-7 days')`
    ).run().catch(() => {});

    await env.DB.prepare(
      `DELETE FROM broadcast_queue
       WHERE (sent = 1 OR attempts >= 3)
         AND created_at < datetime('now', '-7 days')`
    ).run().catch(() => {});

    await env.DB.prepare(
      `DELETE FROM broadcast_jobs
       WHERE finished_at IS NOT NULL AND finished_at < datetime('now', '-30 days')`
    ).run().catch(() => {});
  } catch (e) {
    console.error('cleanupDatabase error:', e);
  }
}
