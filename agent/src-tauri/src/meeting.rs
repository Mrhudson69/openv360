//! Heuristic "is the user in a live call?" detection from the foreground window.
//!
//! The goal (per product requirement): when someone is in a Zoom / Google Meet /
//! Teams / Slack huddle / Webex call and only *listening* — no keyboard or mouse
//! input — that time should still count as working, not idle. Merely having the
//! app open must NOT count; only an active meeting does.
//!
//! This is a best-effort signal based on the foreground app name + window title
//! (the title is used locally only and never uploaded when title tracking is
//! off). It errs toward counting a call as active, since that is the safer error
//! for this feature. Detecting a meeting that runs fully in the background while
//! an idle window is focused is out of scope here (a mic/camera-usage signal
//! would be the next step).

/// True when the foreground window looks like an active meeting/call.
pub fn is_meeting(app: &str, title: &str) -> bool {
    let a = app.to_lowercase();
    let t = title.to_lowercase();

    // Native desktop clients whose in-call window is distinguishable by title
    // (the app's home/lobby window does not match, so "just open" won't count).
    if a.contains("zoom") && (t.contains("meeting") || t.contains("webinar")) {
        return true;
    }
    if a.contains("teams") && (t.contains("meeting") || t.contains("| call") || t.contains("(call)")) {
        return true;
    }
    if a.contains("webex") && (t.contains("meeting") || t.contains("webex meet")) {
        return true;
    }
    if a.contains("slack") && t.contains("huddle") {
        return true;
    }
    if a.contains("goto") && t.contains("meeting") {
        return true;
    }
    // Meeting-centric apps where simply being frontmost means an active session.
    const DEDICATED: &[&str] = &["bluejeans", "amazon chime", "ringcentral", "whereby", "jitsi"];
    if DEDICATED.iter().any(|m| a.contains(m)) {
        return true;
    }

    // Browser-based calls, matched on the tab title (app is a browser).
    // Google Meet in a call sets the tab title to "Meet - <name-or-code>".
    if t.starts_with("meet - ") || t.contains(" meet - ") {
        return true;
    }
    if t.contains("jitsi meet") || t.contains("whereby") {
        return true;
    }

    false
}

#[cfg(test)]
mod tests {
    use super::is_meeting;

    #[test]
    fn active_calls_match() {
        assert!(is_meeting("zoom.us", "Zoom Meeting"));
        assert!(is_meeting("Zoom", "Zoom Webinar"));
        assert!(is_meeting("Microsoft Teams", "Meeting with Design | Microsoft Teams"));
        assert!(is_meeting("Slack", "Huddle in #general — Acme"));
        assert!(is_meeting("Google Chrome", "Meet - abc-defg-hij"));
        assert!(is_meeting("firefox", "Jitsi Meet"));
        assert!(is_meeting("Cisco Webex Meetings", "Daily Standup Meeting"));
    }

    #[test]
    fn apps_merely_open_do_not_match() {
        assert!(!is_meeting("zoom.us", "Zoom Workplace"));
        assert!(!is_meeting("Zoom", "Zoom"));
        assert!(!is_meeting("Slack", "Acme — general"));
        assert!(!is_meeting("Microsoft Teams", "Chat | Microsoft Teams"));
        assert!(!is_meeting("Google Chrome", "Google Meet"));
        assert!(!is_meeting("Code", "main.rs — project"));
        assert!(!is_meeting("Google Docs", "Team meeting notes - Google Docs"));
    }
}
