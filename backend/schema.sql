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
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER NOT NULL,
    remind_at INTEGER NOT NULL,
    message TEXT NOT NULL,
    sent INTEGER DEFAULT 0,
    attempts INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admin_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    payload TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_app_users_updated ON app_users(updated_at);
CREATE INDEX IF NOT EXISTS idx_app_users_selected ON app_users(selected_type, selected_name);
CREATE INDEX IF NOT EXISTS idx_cache_updated ON schedule_cache(updated_at);
CREATE INDEX IF NOT EXISTS idx_logs_created ON system_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(telegram_id);
CREATE INDEX IF NOT EXISTS idx_reminders_user ON reminders(telegram_id);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(sent, remind_at);
CREATE INDEX IF NOT EXISTS idx_admin_events_created ON admin_events(created_at);