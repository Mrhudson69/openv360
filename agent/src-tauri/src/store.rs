//! Local SQLite queue so nothing is lost while offline.

use rusqlite::{Connection, params};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Segment {
    pub id: String,
    pub start: i64,
    pub end: i64,
    pub idle: bool,
    pub app: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionEvent {
    pub id: String,
    pub kind: String,
    pub at: i64,
}

#[derive(Debug, Clone)]
pub struct QueuedScreenshot {
    pub id: String,
    pub taken_at: i64,
    pub path: String,
}

pub struct Store {
    conn: Connection,
}

impl Store {
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        Self::init(Connection::open(path)?)
    }

    #[cfg(test)]
    pub fn in_memory() -> anyhow::Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> anyhow::Result<Self> {
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS segments (
               id TEXT PRIMARY KEY, start INTEGER NOT NULL, end INTEGER NOT NULL,
               idle INTEGER NOT NULL, app TEXT NOT NULL, title TEXT NOT NULL,
               uploaded INTEGER NOT NULL DEFAULT 0);
             CREATE INDEX IF NOT EXISTS segments_pending ON segments(uploaded, start);
             CREATE TABLE IF NOT EXISTS sessions (
               id TEXT PRIMARY KEY, kind TEXT NOT NULL, at INTEGER NOT NULL,
               uploaded INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE IF NOT EXISTS screenshots (
               id TEXT PRIMARY KEY, taken_at INTEGER NOT NULL, path TEXT NOT NULL,
               uploaded INTEGER NOT NULL DEFAULT 0);",
        )?;
        Ok(Self { conn })
    }

    pub fn insert_segment(&self, s: &Segment) -> anyhow::Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO segments (id,start,end,idle,app,title,uploaded)
             VALUES (?1,?2,?3,?4,?5,?6,0)",
            params![s.id, s.start, s.end, s.idle, s.app, s.title],
        )?;
        Ok(())
    }

    pub fn insert_session(&self, e: &SessionEvent) -> anyhow::Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO sessions (id,kind,at) VALUES (?1,?2,?3)",
            params![e.id, e.kind, e.at],
        )?;
        Ok(())
    }

    pub fn insert_screenshot(&self, s: &QueuedScreenshot) -> anyhow::Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO screenshots (id,taken_at,path) VALUES (?1,?2,?3)",
            params![s.id, s.taken_at, s.path],
        )?;
        Ok(())
    }

    pub fn pending_segments(&self, limit: usize) -> anyhow::Result<Vec<Segment>> {
        let mut st = self.conn.prepare(
            "SELECT id,start,end,idle,app,title FROM segments WHERE uploaded=0 ORDER BY start LIMIT ?1",
        )?;
        let rows = st.query_map([limit as i64], |r| {
            Ok(Segment {
                id: r.get(0)?,
                start: r.get(1)?,
                end: r.get(2)?,
                idle: r.get(3)?,
                app: r.get(4)?,
                title: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn pending_sessions(&self) -> anyhow::Result<Vec<SessionEvent>> {
        let mut st = self
            .conn
            .prepare("SELECT id,kind,at FROM sessions WHERE uploaded=0 ORDER BY at LIMIT 500")?;
        let rows = st.query_map([], |r| {
            Ok(SessionEvent {
                id: r.get(0)?,
                kind: r.get(1)?,
                at: r.get(2)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn pending_screenshots(&self, limit: usize) -> anyhow::Result<Vec<QueuedScreenshot>> {
        let mut st = self.conn.prepare(
            "SELECT id,taken_at,path FROM screenshots WHERE uploaded=0 ORDER BY taken_at LIMIT ?1",
        )?;
        let rows = st.query_map([limit as i64], |r| {
            Ok(QueuedScreenshot {
                id: r.get(0)?,
                taken_at: r.get(1)?,
                path: r.get(2)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn mark_uploaded(&self, table: Table, ids: &[String]) -> anyhow::Result<()> {
        let sql = format!("UPDATE {} SET uploaded=1 WHERE id=?1", table.name());
        let tx = self.conn.unchecked_transaction()?;
        {
            let mut st = tx.prepare(&sql)?;
            for id in ids {
                st.execute([id])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn pending_count(&self) -> anyhow::Result<i64> {
        Ok(self.conn.query_row(
            "SELECT (SELECT COUNT(*) FROM segments WHERE uploaded=0)
                  + (SELECT COUNT(*) FROM sessions WHERE uploaded=0)
                  + (SELECT COUNT(*) FROM screenshots WHERE uploaded=0)",
            [],
            |r| r.get(0),
        )?)
    }

    /// Active (non-idle) milliseconds recorded since `since` (epoch ms).
    pub fn active_ms_since(&self, since: i64) -> anyhow::Result<i64> {
        Ok(self.conn.query_row(
            "SELECT COALESCE(SUM(end - MAX(start, ?1)), 0) FROM segments WHERE idle=0 AND end > ?1",
            [since],
            |r| r.get(0),
        )?)
    }

    /// Drop uploaded rows older than `before` (epoch ms) to keep the queue small.
    pub fn prune(&self, before: i64) -> anyhow::Result<()> {
        self.conn.execute("DELETE FROM segments WHERE uploaded=1 AND end < ?1", [before])?;
        self.conn.execute("DELETE FROM sessions WHERE uploaded=1 AND at < ?1", [before])?;
        self.conn.execute("DELETE FROM screenshots WHERE uploaded=1", [])?;
        Ok(())
    }

    pub fn clear(&self) -> anyhow::Result<()> {
        self.conn
            .execute_batch("DELETE FROM segments; DELETE FROM sessions; DELETE FROM screenshots;")?;
        Ok(())
    }
}

#[derive(Clone, Copy)]
pub enum Table {
    Segments,
    Sessions,
    Screenshots,
}

impl Table {
    fn name(self) -> &'static str {
        match self {
            Table::Segments => "segments",
            Table::Sessions => "sessions",
            Table::Screenshots => "screenshots",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(id: &str, start: i64, end: i64, idle: bool) -> Segment {
        Segment {
            id: id.into(),
            start,
            end,
            idle,
            app: "code".into(),
            title: "".into(),
        }
    }

    #[test]
    fn queue_roundtrip_and_totals() {
        let s = Store::in_memory().unwrap();
        s.insert_segment(&seg("a", 0, 1000, false)).unwrap();
        s.insert_segment(&seg("b", 1000, 5000, true)).unwrap();
        s.insert_segment(&seg("c", 5000, 7000, false)).unwrap();
        assert_eq!(s.pending_segments(10).unwrap().len(), 3);
        assert_eq!(s.active_ms_since(0).unwrap(), 3000);
        // A segment straddling the boundary only counts the part after it.
        assert_eq!(s.active_ms_since(500).unwrap(), 2500);

        s.mark_uploaded(Table::Segments, &["a".into(), "b".into()]).unwrap();
        assert_eq!(s.pending_segments(10).unwrap().len(), 1);
        assert_eq!(s.pending_count().unwrap(), 1);
        s.prune(6000).unwrap();
        assert_eq!(s.active_ms_since(0).unwrap(), 2000);
    }

    #[test]
    fn replacing_a_segment_updates_its_end() {
        let s = Store::in_memory().unwrap();
        s.insert_segment(&seg("a", 0, 1000, false)).unwrap();
        s.insert_segment(&seg("a", 0, 4000, false)).unwrap();
        let p = s.pending_segments(10).unwrap();
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].end, 4000);
    }
}
