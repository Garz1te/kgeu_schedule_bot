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