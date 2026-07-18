use rusqlite::{Connection, Result};
use std::path::PathBuf;
use std::sync::Mutex;

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn new(path: PathBuf) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS kvstore (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
            [],
        )?;
        Ok(Db {
            conn: Mutex::new(conn),
        })
    }

    pub fn get(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT v FROM kvstore WHERE k = ?1")?;
        let mut rows = stmt.query([key])?;
        if let Some(row) = rows.next()? {
            Ok(Some(row.get(0)?))
        } else {
            Ok(None)
        }
    }

    pub fn set(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO kvstore (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            [key, value],
        )?;
        Ok(())
    }

    /// Atomically stores `value` only when the key is absent or currently empty.
    /// This remains safe when multiple server processes share the same SQLite file.
    pub fn claim_if_empty(&self, key: &str, value: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let changed = conn.execute(
            "INSERT INTO kvstore (k, v) VALUES (?1, ?2) \
             ON CONFLICT(k) DO UPDATE SET v = excluded.v WHERE trim(kvstore.v) = ''",
            [key, value],
        )?;
        Ok(changed > 0)
    }

    /// Atomically clears a key only if it still contains the expected value.
    pub fn clear_if_matches(&self, key: &str, expected: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let changed = conn.execute(
            "UPDATE kvstore SET v = '' WHERE k = ?1 AND v = ?2",
            [key, expected],
        )?;
        Ok(changed > 0)
    }
}
