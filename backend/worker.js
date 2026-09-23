export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (request.method === 'OPTIONS') {
            return handleCors();
        }

        // Логирование запросов в таблицу system_logs
        if (env.DB) {
            ctx.waitUntil(
                env.DB.prepare("INSERT INTO system_logs (event_type, payload) VALUES (?, ?)")
                    .bind('REQUEST', `${request.method} ${url.pathname}`)
                    .run().catch(e => console.error("System log error:", e))
            );
        }

        try {
            if (url.pathname === '/webhook' && request.method === 'POST') {
                return await handleTelegramWebhook(request, env);
            }

            if (url.pathname.startsWith('/api/')) {
                return await handleApiProxy(request, env, url, ctx);
            }

            return new Response('KGEU Schedule Bot Worker is running!', {
                status: 200,
                headers: { 'Content-Type': 'text/plain; charset=utf-8' }
            });

        } catch (err) {
            return jsonResponse({ error: err.message }, 500);
        }
    }
};

async function handleTelegramWebhook(request, env) {
    try {
        const update = await request.json();

        if (update.message && update.message.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text.trim();

            if (text.startsWith('/start')) {
                const webAppUrl = env.WEBAPP_URL || 'https://garz1te.github.io/kgeu_schedule_bot';

                await sendTelegramMessage(env.BOT_TOKEN, chatId, "Привет! Добро пожаловать в расписание КГЭУ. Нажми кнопку ниже, чтобы открыть приложение:", {
                    inline_keyboard: [[
                        { text: "📅 Открыть расписание", web_app: { url: webAppUrl } }
                    ]]
                }).catch(err => console.error("Webhook send message error:", err));
            }
        }
    } catch (e) {
        console.error("Webhook parse error:", e);
    }

    return new Response('OK', { status: 200 });
}

async function sendTelegramMessage(token, chatId, text, replyMarkup) {
    if (!token) return;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text: text,
            reply_markup: replyMarkup
        })
    }).catch(err => console.error("Telegram API fetch error:", err));
}

async function handleApiProxy(request, env, url, ctx) {
    const subPath = url.pathname.replace(/^\/api/, '');
    const forceFresh = url.searchParams.get('fresh') === '1';
    const canonicalUrl = new URL(url.toString());
    canonicalUrl.searchParams.delete('fresh');
    const cacheKey = canonicalUrl.pathname + canonicalUrl.search;

    let targetUrl = '';
    const yearParam = 'year=2026-2027';

    if (subPath === '/lists') {
        try {
            const [grpRes, tchRes, audRes] = await Promise.all([
                fetch(`${env.KABINET_API}/raspGrouplist?${yearParam}`).then(r => r.json()).catch(() => ({})),
                fetch(`${env.KABINET_API}/raspTeacherlist?${yearParam}`).then(r => r.json()).catch(() => ({})),
                fetch(`${env.KABINET_API}/raspAudlist?${yearParam}`).then(r => r.json()).catch(() => ({}))
            ]);

            const normalizeItem = (item) => {
                if (item === null || item === undefined) return null;

                if (typeof item === 'string' || typeof item === 'number') {
                    const value = String(item).trim();
                    return value ? { id: value, name: value } : null;
                }

                const name = item.name ?? item.Name ?? item.title ?? item.Title ?? item.text ??
                    item.label ?? item.group ?? item.groupName ?? item.teacherName ?? item.auditoriumName ??
                    item.Группа ?? item.наименование ?? item.Наименование ?? item.Text ?? item.textValue ?? item.value;
                const id = item.id ?? item.Id ?? item.ID ?? item.idGroup ?? item.idTeacher ?? item.idAudLine ??
                    item.groupId ?? item.teacherId ?? item.auditoriumId ?? item.audId ?? item.код ??
                    item.кодГруппы ?? item.кодПреподавателя ?? item.кодАудитории ?? item.Код ?? item.code ??
                    item.Code ?? item.key ?? item.Key ?? item.Value ?? item.value;

                if (name === undefined || name === null) return null;

                const cleanName = String(name).trim();
                if (!cleanName) return null;

                return {
                    id: id === undefined || id === null ? cleanName : String(id).trim(),
                    name: cleanName
                };
            };

            const unwrapList = (res) => {
                if (Array.isArray(res)) return res;

                if (res && typeof res === 'object') {
                    const candidates = [
                        res.items,
                        res.data?.items,
                        res.data?.groups,
                        res.data?.teachers,
                        res.data?.auditoriums,
                        res.data?.result,
                        res.result,
                        res.groups,
                        res.teachers,
                        res.auditoriums,
                        res.data
                    ];

                    for (const candidate of candidates) {
                        if (Array.isArray(candidate)) return candidate;
                    }
                }

                return [];
            };

            const parseList = (res) => unwrapList(res).map(normalizeItem).filter(Boolean);

            const formattedData = {
                Group: parseList(grpRes),
                Teacher: parseList(tchRes),
                Aud: parseList(audRes)
            };

            if (env.DB) {
                ctx.waitUntil(
                    env.DB.prepare("INSERT OR REPLACE INTO schedule_cache (cache_key, schedule_data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
                        .bind(cacheKey, JSON.stringify(formattedData))
                        .run().catch(e => console.error("Cache write error:", e))
                );
            }

            return jsonResponse(formattedData);
        } catch (err) {
            if (env.DB) {
                const cached = await env.DB.prepare("SELECT schedule_data FROM schedule_cache WHERE cache_key = ?").bind(cacheKey).first().catch(() => null);
                if (cached && cached.schedule_data) return jsonResponse(JSON.parse(cached.schedule_data));
            }
            return jsonResponse({ Group: [], Teacher: [], Aud: [] }, 200);
        }
    } else {
        targetUrl = `${env.KABINET_API}${subPath}${canonicalUrl.search}`;
    }

    // Короткий server-side cache: при быстрых переключениях день/неделя/месяц
    // не заставляем кабинет КГЭУ повторно отдавать один и тот же день.
    if (env.DB && request.method === 'GET' && !forceFresh) {
        const fresh = await env.DB.prepare(
            "SELECT schedule_data FROM schedule_cache WHERE cache_key = ? AND updated_at >= datetime('now', '-90 seconds')"
        ).bind(cacheKey).first().catch(() => null);
        if (fresh && fresh.schedule_data) {
            return new Response(fresh.schedule_data, {
                status: 200,
                headers: {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'public, max-age=60'
                }
            });
        }
    }

    try {
        const apiResponse = await fetch(targetUrl, {
            method: request.method,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'KGEU-Schedule-Bot/1.0'
            }
        });

        const responseBody = await apiResponse.arrayBuffer();
        
        if (apiResponse.ok && env.DB) {
            const textData = new TextDecoder().decode(responseBody);
            ctx.waitUntil(
                env.DB.prepare("INSERT OR REPLACE INTO schedule_cache (cache_key, schedule_data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
                    .bind(cacheKey, textData)
                    .run().catch(e => console.error("Cache write error:", e))
            );
        }

        return new Response(responseBody, {
            status: apiResponse.status,
            headers: {
                'Content-Type': apiResponse.headers.get('Content-Type') || 'application/json; charset=utf-8',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=60'
            }
        });
    } catch (err) {
        if (env.DB) {
            const cached = await env.DB.prepare("SELECT schedule_data FROM schedule_cache WHERE cache_key = ?").bind(cacheKey).first().catch(() => null);
            if (cached && cached.schedule_data) {
                return new Response(cached.schedule_data, {
                    status: 200,
                    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
                });
            }
        }
        return jsonResponse({ error: 'External API unavailable and no cache found' }, 502);
    }
}

function handleCors() {
    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        }
    });
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
        }
    });
}