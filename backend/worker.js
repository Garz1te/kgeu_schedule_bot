export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Content-Type': 'application/json;charset=UTF-8'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // 1. ПОЛУЧЕНИЕ РАСПИСАНИЯ C KABINET.KGEU.RU С КЭШИРОВАНИЕМ В D1
    if (url.pathname === '/api/schedule') {
      const id = url.searchParams.get('id') || '14456';
      const type = url.searchParams.get('type') || 'group';
      const sdate = url.searchParams.get('sdate') || new Date().toISOString().split('T')[0];
      const cacheKey = `${type}_${id}_${sdate}`;

      try {
        const cached = await env.DB.prepare('SELECT schedule_data FROM schedule_cache WHERE cache_key = ?')
          .bind(cacheKey)
          .first();
        if (cached && cached.schedule_data) {
          return new Response(cached.schedule_data, { headers: corsHeaders });
        }
      } catch (e) {}

      let paramName = 'idGroup';
      if (type === 'teacher') paramName = 'idTeacher';
      if (type === 'room') paramName = 'idAudLine';

      const targetUrl = `${env.KABINET_API}/Rasp?${paramName}=${id}&sdate=${sdate}`;

      try {
        const res = await fetch(targetUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*'
          }
        });

        if (res.ok) {
          const rawData = await res.json();
          const jsonStr = JSON.stringify(rawData);

          try {
            await env.DB.prepare('INSERT OR REPLACE INTO schedule_cache (cache_key, schedule_data) VALUES (?, ?)')
              .bind(cacheKey, jsonStr)
              .run();
          } catch (e) {}

          return new Response(jsonStr, { headers: corsHeaders });
        }
      } catch (err) {}

      return new Response(JSON.stringify([]), { headers: corsHeaders });
    }

    // 2. ГЛОБАЛЬНЫЙ ПОИСК (ГРУППЫ / ПРЕПОДАВАТЕЛИ / АУДИТОРИИ)
    if (url.pathname === '/api/search') {
      const type = url.searchParams.get('type') || 'group';
      const query = (url.searchParams.get('q') || '').toLowerCase().trim();

      let targetApi = `${env.KABINET_API}/GetGroups`;
      if (type === 'teacher') targetApi = `${env.KABINET_API}/GetTeachers`;
      if (type === 'room') targetApi = `${env.KABINET_API}/GetAuditories`;

      try {
        const res = await fetch(targetApi, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });

        if (res.ok) {
          const items = await res.json();
          const filtered = items.filter(item => {
            const name = item.name || item.text || item.label || item.fio || '';
            return name.toLowerCase().includes(query);
          }).slice(0, 30);

          return new Response(JSON.stringify(filtered), { headers: corsHeaders });
        }
      } catch (e) {}

      // Резервные тестовые данные, если официальный API КГЭУ временно недоступен
      const fallbackData = [
        { id: '14456', name: 'ИПК-1-25', type: 'group' },
        { id: '14457', name: 'ИЭЭ-1-23', type: 'group' },
        { id: '14458', name: 'ЭЭ-1-24', type: 'group' },
        { id: '101', name: 'Иванов И.И.', type: 'teacher' },
        { id: '102', name: 'Петров П.П.', type: 'teacher' },
        { id: '201', name: 'В-201', type: 'room' },
        { id: '304', name: 'Д-304', type: 'room' }
      ].filter(i => i.type === type && i.name.toLowerCase().includes(query));

      return new Response(JSON.stringify(fallbackData), { headers: corsHeaders });
    }

    // 3. СОХРАНЕНИЕ ПРОФИЛЯ ПОЛЬЗОВАТЕЛЯ И ЗАДАЧ
    if (url.pathname === '/api/user' && request.method === 'POST') {
      try {
        const body = await request.json();
        await env.DB.prepare(`
          INSERT INTO users (telegram_id, selected_id, selected_name, selected_type, favorites_json, tasks_json)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(telegram_id) DO UPDATE SET
            selected_id=excluded.selected_id,
            selected_name=excluded.selected_name,
            selected_type=excluded.selected_type,
            favorites_json=excluded.favorites_json,
            tasks_json=excluded.tasks_json,
            updated_at=CURRENT_TIMESTAMP
        `).bind(
          body.telegram_id,
          body.selected_id || '14456',
          body.selected_name || 'ИПК-1-25',
          body.selected_type || 'group',
          JSON.stringify(body.favorites || []),
          JSON.stringify(body.tasks || [])
        ).run();

        return new Response(JSON.stringify({ status: 'success' }), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ status: 'error', message: e.message }), { headers: corsHeaders });
      }
    }

    // 4. ЗАГРУЗКА ПРОФИЛЯ ПОЛЬЗОВАТЕЛЯ
    if (url.pathname === '/api/user' && request.method === 'GET') {
      const tgId = url.searchParams.get('telegram_id');
      if (tgId) {
        try {
          const user = await env.DB.prepare('SELECT * FROM users WHERE telegram_id = ?').bind(tgId).first();
          if (user) {
            return new Response(JSON.stringify({
              selected_id: user.selected_id,
              selected_name: user.selected_name,
              selected_type: user.selected_type,
              favorites: JSON.parse(user.favorites_json || '[]'),
              tasks: JSON.parse(user.tasks_json || '[]')
            }), { headers: corsHeaders });
          }
        } catch (e) {}
      }
      return new Response(JSON.stringify({
        selected_id: '14456',
        selected_name: 'ИПК-1-25',
        selected_type: 'group',
        favorites: [],
        tasks: []
      }), { headers: corsHeaders });
    }

    // 5. ВЕБХУК ТЕЛЕГРАМ БОТА
    if (url.pathname === '/telegram-webhook' && request.method === 'POST') {
      try {
        const update = await request.json();
        if (update.message && update.message.text) {
          const chatId = update.message.chat.id;
          const text = update.message.text;

          let replyText = '👋 **Добро пожаловать в сервис расписания КГЭУ!**\n\nНажмите кнопку ниже, чтобы открыть веб-приложение:';
          
          if (text === '/help') {
            replyText = 'ℹ️ **Справка**\nБот позволяет просматривать расписание групп, преподавателей и аудиторий КГЭУ, а также вести список задач и дедлайнов.';
          }

          await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: replyText,
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [[
                  { text: '📅 Открыть расписание', web_app: { url: env.WEBAPP_URL } }
                ]]
              }
            })
          });
        }
      } catch (e) {}
      return new Response('OK', { status: 200 });
    }

    return new Response(JSON.stringify({ status: 'online', service: 'KGEU Schedule Backend' }), { headers: corsHeaders });
  }
};