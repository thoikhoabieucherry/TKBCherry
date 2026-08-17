use rusqlite::{Connection, Result, Transaction, TransactionBehavior};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn new(path: PathBuf) -> Result<Self> {
        let conn = Connection::open(path)?;
        // Rolling restarts can briefly leave two API processes writing the
        // same SQLite file. Give short accounting/config transactions time to
        // serialize instead of failing immediately with SQLITE_BUSY.
        conn.busy_timeout(Duration::from_secs(5))?;
        // The ledger is written by the API coordinator and may be touched by
        // an overlapping process during a restart. WAL plus a bounded busy
        // timeout avoids turning a transient writer collision into a lost
        // reservation while keeping SQLite's atomic transaction semantics.
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")?;
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

    /// Runs a database mutation under SQLite's `BEGIN IMMEDIATE` lock.
    ///
    /// A process-local mutex is not sufficient for quota/accounting updates:
    /// production can briefly have an old and a new API process sharing the
    /// same database during a rolling restart.  `IMMEDIATE` serializes those
    /// writers before either process reads a budget balance, preventing both
    /// from admitting work against the same final dollars.
    pub(crate) fn with_immediate_transaction<T, F>(&self, operation: F) -> Result<T>
    where
        F: FnOnce(&Transaction<'_>) -> Result<T>,
    {
        let mut conn = self.conn.lock().unwrap();
        let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = operation(&transaction)?;
        transaction.commit()?;
        Ok(result)
    }
}
