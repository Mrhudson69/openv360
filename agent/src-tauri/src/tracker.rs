//! Turns periodic samples (foreground window + idle time) into activity segments.
//!
//! Pure logic — no OS calls — so it can be unit-tested.

use crate::store::Segment;

/// Longest a single segment may grow before it is closed and queued for upload
/// (keeps the dashboard close to real time and bounds data lost on a hard kill).
pub const MAX_SEGMENT_MS: i64 = 60 * 1000;
/// If two samples are further apart than this (sleep, suspend, crash) the
/// gap is not counted as tracked time.
pub const MAX_GAP_MS: i64 = 30 * 1000;
/// Input within this window counts as "the user is actively working right now".
const RECENT_INPUT_MS: i64 = 10 * 1000;

#[derive(Debug, Clone, PartialEq)]
pub struct Sample {
    pub at: i64,
    pub idle_ms: i64,
    pub app: String,
    pub title: String,
    /// The foreground app is a live meeting/call — treat as active even with no input.
    pub meeting: bool,
}

#[derive(Default)]
pub struct SegmentBuilder {
    current: Option<Segment>,
}

impl SegmentBuilder {
    /// Feed one sample. Returns segments that are finished and should be stored.
    pub fn push(&mut self, s: &Sample, idle_threshold_ms: i64) -> Vec<Segment> {
        let mut done = Vec::new();
        // A live call keeps the user "active" even past the idle threshold.
        let is_idle = s.idle_ms >= idle_threshold_ms && !s.meeting;
        let (app, title) = if is_idle {
            (String::new(), String::new())
        } else {
            (non_empty(&s.app), s.title.clone())
        };

        if let Some(mut cur) = self.current.take() {
            let gap = s.at - cur.end;
            if !(0..=MAX_GAP_MS).contains(&gap) {
                // Clock jumped or machine slept: close what we had, start fresh.
                done.push(cur);
            } else if cur.idle == is_idle && cur.app == app && cur.title == title {
                cur.end = s.at;
                // Don't close an active segment while input has paused: the user
                // may be about to cross the idle threshold, and the idle period
                // must then be carved out of this (not yet stored) segment.
                let input_paused = !is_idle && s.idle_ms > RECENT_INPUT_MS;
                if cur.end - cur.start >= MAX_SEGMENT_MS && !input_paused {
                    done.push(cur);
                    self.current = Some(new_segment(s.at, s.at, is_idle, app, title));
                    return done;
                }
                self.current = Some(cur);
                return done;
            } else {
                // State changed. When the user just went idle, the idle period
                // really began `idle_ms` ago — move that time out of the
                // active segment.
                let mut boundary = s.at;
                if is_idle && !cur.idle {
                    boundary = (s.at - s.idle_ms).max(cur.start);
                }
                cur.end = boundary;
                if cur.end > cur.start {
                    done.push(cur);
                }
                self.current = Some(new_segment(boundary, s.at, is_idle, app, title));
                return done;
            }
        }
        self.current = Some(new_segment(s.at, s.at, is_idle, app, title));
        done
    }

    /// Close the in-progress segment (on clock-out / quit).
    pub fn flush(&mut self) -> Option<Segment> {
        self.current.take().filter(|s| s.end > s.start)
    }

    /// The in-progress segment, for live totals.
    pub fn current(&self) -> Option<&Segment> {
        self.current.as_ref()
    }
}

fn non_empty(app: &str) -> String {
    let a = app.trim();
    if a.is_empty() { "unknown".into() } else { a.into() }
}

fn new_segment(start: i64, end: i64, idle: bool, app: String, title: String) -> Segment {
    Segment {
        id: uuid::Uuid::new_v4().to_string(),
        start,
        end,
        idle,
        app,
        title,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: i64 = 60_000; // idle threshold

    fn sample(at: i64, idle_ms: i64, app: &str) -> Sample {
        Sample {
            at,
            idle_ms,
            app: app.into(),
            title: "t".into(),
            meeting: false,
        }
    }

    #[test]
    fn meeting_overrides_idle() {
        let mut b = SegmentBuilder::default();
        let mut s = sample(0, 999_000, "zoom.us"); // idle far past threshold
        s.meeting = true;
        b.push(&s, T);
        let cur = b.current().unwrap();
        assert!(!cur.idle, "a live meeting must count as active");
        assert_eq!(cur.app, "zoom.us");
    }

    #[test]
    fn merges_same_window() {
        let mut b = SegmentBuilder::default();
        for i in 0..5 {
            assert!(b.push(&sample(i * 5000, 0, "code"), T).is_empty());
        }
        let s = b.flush().unwrap();
        assert_eq!((s.start, s.end, s.app.as_str()), (0, 20_000, "code"));
    }

    #[test]
    fn splits_on_app_change() {
        let mut b = SegmentBuilder::default();
        b.push(&sample(0, 0, "code"), T);
        b.push(&sample(5000, 0, "code"), T);
        let done = b.push(&sample(10_000, 0, "firefox"), T);
        assert_eq!(done.len(), 1);
        assert_eq!((done[0].start, done[0].end), (0, 10_000));
        assert_eq!(b.current().unwrap().app, "firefox");
    }

    #[test]
    fn idle_is_backdated() {
        let mut b = SegmentBuilder::default();
        let mut t = 0;
        // Last input at 105 s; samples keep coming every 5 s.
        while t < 165_000 {
            b.push(&sample(t, (t - 105_000).max(0), "code"), T);
            t += 5000;
        }
        // At 170s the user has been idle for 65s (> 60s threshold) -> idle started at 105s.
        let done = b.push(&sample(170_000, 65_000, "code"), T);
        // Active time before the pause was stored in full minutes, then held open.
        assert_eq!(done.last().unwrap().end, 105_000);
        let cur = b.current().unwrap();
        assert!(cur.idle);
        assert_eq!(cur.start, 105_000);
        assert_eq!(cur.app, "");
    }

    #[test]
    fn gap_is_not_counted() {
        let mut b = SegmentBuilder::default();
        b.push(&sample(0, 0, "code"), T);
        b.push(&sample(5000, 0, "code"), T);
        let done = b.push(&sample(5000 + MAX_GAP_MS + 1, 0, "code"), T);
        assert_eq!(done[0].end, 5000);
        assert_eq!(b.current().unwrap().start, 5000 + MAX_GAP_MS + 1);
    }

    #[test]
    fn long_segments_are_split() {
        let mut b = SegmentBuilder::default();
        let mut finished = vec![];
        let mut t = 0;
        while t <= MAX_SEGMENT_MS + 10_000 {
            finished.extend(b.push(&sample(t, 0, "code"), T));
            t += 5000;
        }
        assert_eq!(finished.len(), 1);
        assert_eq!(finished[0].end - finished[0].start, MAX_SEGMENT_MS);
    }

    #[test]
    fn empty_app_becomes_unknown() {
        let mut b = SegmentBuilder::default();
        b.push(&sample(0, 0, "  "), T);
        assert_eq!(b.current().unwrap().app, "unknown");
    }
}
