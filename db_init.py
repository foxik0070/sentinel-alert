import os
import sqlite3

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "data", "alerts.db")


def _ensure_column(cur, table, col, ddl):
    cur.execute(f"PRAGMA table_info({table})")
    if col not in {r[1] for r in cur.fetchall()}:
        cur.execute(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")


def init():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS devices (
            mac        TEXT PRIMARY KEY,
            ip         TEXT,
            hostname   TEXT,
            vendor     TEXT,
            first_seen DATETIME,
            last_seen  DATETIME,
            is_online  INTEGER DEFAULT 0
        )
    """)
    _ensure_column(cur, "devices", "ports", "TEXT")
    _ensure_column(cur, "devices", "ports_checked_at", "DATETIME")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS ban_history (
            ip        TEXT,
            country   TEXT,
            lat       REAL,
            lon       REAL,
            isp       TEXT,
            timestamp DATETIME
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS attacks (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            ts         DATETIME,
            src_ip     TEXT,
            dst_port   INTEGER,
            protocol   TEXT,
            payload    TEXT,
            country    TEXT,
            lat        REAL,
            lon        REAL,
            isp        TEXT
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_attacks_ts ON attacks(ts)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_attacks_src ON attacks(src_ip)")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS active_users (
            username  TEXT,
            ip        TEXT,
            node      TEXT,
            cluster   TEXT,
            country   TEXT,
            lat       REAL,
            lon       REAL,
            isp       TEXT,
            timestamp TEXT
        )
    """)

    conn.commit()
    conn.close()
    print(f"DB initialized at {DB_PATH}")


if __name__ == "__main__":
    init()
