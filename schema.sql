CREATE TABLE IF NOT EXISTS holdings (
  symbol TEXT PRIMARY KEY,
  shares REAL NOT NULL,
  currency TEXT
);
