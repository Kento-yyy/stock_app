CREATE TABLE IF NOT EXISTS holdings (
  symbol TEXT PRIMARY KEY,
  shares REAL NOT NULL,
  currency TEXT,
  company_name TEXT
);

-- simplified quotes table storing only original currency prices and baselines
CREATE TABLE IF NOT EXISTS quotes (
  symbol TEXT PRIMARY KEY,
  price REAL,
  currency TEXT,
  updated_at TEXT,
  price_1d REAL,
  updated_1d_at TEXT,
  price_1m REAL,
  updated_1m_at TEXT,
  price_1y REAL,
  updated_1y_at TEXT
);

-- table dedicated to USD/JPY exchange rates
CREATE TABLE IF NOT EXISTS usd_jpy (
  id INTEGER PRIMARY KEY,
  price REAL,
  updated_at TEXT,
  price_1d REAL,
  updated_1d_at TEXT,
  price_1m REAL,
  updated_1m_at TEXT,
  price_1y REAL,
  updated_1y_at TEXT
);
