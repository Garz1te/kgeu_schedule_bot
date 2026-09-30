CREATE TABLE IF NOT EXISTS users (
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
);

CREATE TABLE IF NOT EXISTS app_users (
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
);

CREATE TABLE IF NOT EXISTS schedule_cache (
    cache_key TEXT PRIMARY KEY,
    schedule_data TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS system_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT,
    payload TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tasks (
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
);

CREATE TABLE IF NOT EXISTS reminders (
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
);

CREATE TABLE IF NOT EXISTS admin_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    payload TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Очередь рассылок нужна, чтобы 1000 пользователей не превращались
-- в 1000 Telegram-запросов внутри одного Worker invocation.
CREATE TABLE IF NOT EXISTS broadcast_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER NOT NULL,
    message TEXT NOT NULL,
    total INTEGER DEFAULT 0,
    sent INTEGER DEFAULT 0,
    failed INTEGER DEFAULT 0,
    status TEXT DEFAULT 'queued',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS broadcast_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    telegram_id INTEGER NOT NULL,
    sent INTEGER DEFAULT 0,
    attempts INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    sent_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_app_users_updated ON app_users(updated_at);
CREATE INDEX IF NOT EXISTS idx_app_users_selected ON app_users(selected_type, selected_name);
CREATE INDEX IF NOT EXISTS idx_cache_updated ON schedule_cache(updated_at);
CREATE INDEX IF NOT EXISTS idx_schedule_cache_key_updated ON schedule_cache(cache_key, updated_at);
CREATE INDEX IF NOT EXISTS idx_logs_created ON system_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(telegram_id);
CREATE INDEX IF NOT EXISTS idx_tasks_note_key ON tasks(telegram_id, note_key);
CREATE INDEX IF NOT EXISTS idx_reminders_user ON reminders(telegram_id);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(sent, remind_at);
CREATE INDEX IF NOT EXISTS idx_reminders_key ON reminders(telegram_id, reminder_key, sent);
CREATE INDEX IF NOT EXISTS idx_admin_events_created ON admin_events(created_at);
CREATE INDEX IF NOT EXISTS idx_broadcast_queue_pending ON broadcast_queue(sent, attempts, id);
CREATE INDEX IF NOT EXISTS idx_broadcast_queue_job ON broadcast_queue(job_id, sent);
CREATE INDEX IF NOT EXISTS idx_broadcast_queue_created ON broadcast_queue(created_at, sent, attempts);
CREATE INDEX IF NOT EXISTS idx_broadcast_jobs_status ON broadcast_jobs(status, created_at);
