# Worklens API contract (v1)

Single-organisation, self-hosted server. All timestamps are **Unix epoch milliseconds (UTC)**.
All JSON bodies are `application/json`. Errors: `{ "error": "message" }` with a 4xx/5xx status.

## Auth

| Caller    | Header                                   | Obtained from                    |
|-----------|------------------------------------------|----------------------------------|
| Dashboard | `Authorization: Bearer <session token>`  | `POST /api/auth/login` / `setup` |
| Agent     | `Authorization: Bearer <device token>`   | `POST /api/agent/enroll`         |

Tokens are random 32-byte hex strings; the server stores only their SHA-256 hash.

## Trust model

Enrollment codes and device tokens are the only authentication. The agent is open
source and each device stores its own token, so **a user with administrator/root on
their own computer can forge plausible data** (fake apps, times, or screenshots) by
driving the API with their token directly. The server's integrity checks (see
"Data integrity limits") are **sanity limits, not cryptographic proof**: they reject
values that are impossible or internally inconsistent (future/ancient timestamps, a
day with more active time than a day holds, absurd screenshot rates) and flag the
device, but they cannot prove that accepted data reflects what actually happened.
Treat Worklens output as cooperative self-reporting with guardrails, not as evidence.

## Data integrity limits

The agent endpoints below drop (not 400) individual items that fail these checks, and
`POST /api/agent/sessions` and `/activity` return `{ accepted, dropped }`. When
anything is dropped, the device's `flag_count` is incremented and `suspiciousAt` is set,
surfaced to admins as `suspicious: true` on the device. Good items in the same request
are still stored.

- Any timestamp more than **2 minutes in the future** (clock-skew tolerance) or **older
  than 30 days** is dropped.
- A segment is dropped when `end <= start`, `end - start > 20 minutes` (the agent caps
  segments near 60s), or `start`/`end` are not integers.
- Per device, total **non-idle** segment duration is capped at **26 hours per UTC day**
  (combining stored and incoming data). Segments that would push a day over the cap are
  dropped. Idle time never counts toward this cap.
- Screenshots are capped at **50 per device per clock hour** (by `takenAt`); extras get
  `429` with `{ accepted: 0, dropped: 1 }`. Non-image uploads are still `415`.

## Health

`GET /api/health` → `{ "ok": true, "version": "0.1.0" }`

## Admin auth

- `GET  /api/auth/status` → `{ "needsSetup": boolean, "orgName": string }` (needsSetup true when no admin exists)
- `POST /api/auth/setup` `{ name, email, password, orgName? }` → `{ token, user }` — only allowed while `needsSetup`. May also be bootstrapped from env (`ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`, `ORG_NAME`) on first start; never overwrites an existing admin.
- `POST /api/auth/login` `{ email, password }` → `{ token, user }`
- `POST /api/auth/logout` → `{ ok: true }`
- `GET  /api/auth/me` → `{ user }`  where `user = { id, name, email }`

## Agent endpoints

### `POST /api/agent/enroll` (no auth)
```json
{ "code": "ABCD-EFGH",
  "device": { "hostname": "laptop-1", "os": "linux|windows|macos",
              "osVersion": "Ubuntu 24.04", "agentVersion": "0.1.0" } }
```
→
```json
{ "deviceId": "uuid", "deviceToken": "hex",
  "employee": { "id": "uuid", "name": "Jane Doe" },
  "settings": Settings }
```
Enrollment codes are single-use, 8 chars `XXXX-XXXX` (A-Z, 2-9 without ambiguous chars), and expire after 7 days.

### `GET /api/agent/settings` → `Settings`
```json
{ "orgName": "Worklens",
  "screenshotsEnabled": true,
  "screenshotIntervalSec": 600,
  "screenshotBlur": false,
  "idleThresholdSec": 300,
  "trackWindowTitles": true }
```
(The agent may ignore `orgName`; it is primarily for the dashboard.)

### `POST /api/agent/sessions`
Clock events. Idempotent on `id`. Invalid timestamps are dropped (see "Data integrity limits").
```json
{ "events": [ { "id": "uuid", "kind": "clock_in|clock_out", "at": 1731100000000 } ] }
```
→ `{ "accepted": 1, "dropped": 0 }`

### `POST /api/agent/activity`
Activity segments. Idempotent on `id` (re-sent ids are ignored). Max 1000 per request.
Segments failing the integrity checks are dropped; response is `{ accepted, dropped }`.
```json
{ "segments": [ {
    "id": "uuid",
    "start": 1731100000000, "end": 1731100060000,
    "idle": false,
    "app": "firefox",            // process/app name, never empty ("unknown" if unavailable)
    "title": "Inbox - Mail"      // may be "" when titles disabled/unavailable
} ] }
```
→ `{ "accepted": n, "dropped": m }`

### `POST /api/agent/screenshots` (multipart/form-data)
Fields: `id` (uuid), `takenAt` (epoch ms), `file` (image/jpeg or image/png, ≤ 10 MB).
Idempotent on `id`. → `{ "accepted": 1 }`

### `GET /api/agent/me` → `{ employee: {id,name}, settings: Settings, command }`
`command` is `"none" | "stop" | "uninstall"` — the remote lifecycle instruction the
agent must act on: `stop` = clock out and go idle (keep polling, so `resume` can revive
it); `uninstall` = remove itself from the device. Returns 401 if the device was revoked
— the agent then returns to the enrollment screen.

## Dashboard endpoints (session auth)

- `GET  /api/employees` → `{ employees: [ { id, name, email, team, teamId, createdAt, lastSeenAt, devices: [ {id, hostname, os, osVersion, agentVersion, lastSeenAt, command, suspicious} ], todayActiveMs } ] }`
  (`command` = the device's current remote instruction; `suspicious` = true once the device has tripped a data-integrity check. `teamId` = the employee's team, or `null`; `team` = that team's joined name, or `null`.)
- `POST /api/employees` `{ name, email?, team?, teamId? }` → `{ employee, enrollmentCode, expiresAt }`
  (`teamId` assigns an existing team — `400` if unknown/malformed. If `teamId` is absent/null and `team` (a name string) is given, the team is resolved-or-created by that name. `employee` is `{ id, name, email, team, teamId, createdAt, lastSeenAt, devices, todayActiveMs }`; `team` is the joined team name.)
- `PATCH /api/employees/:id` `{ name?, email?, team?, teamId? }` → `{ employee: { id, name, email, team, teamId, createdAt } }`
  (`teamId: null` unassigns; a `teamId` string assigns an existing team (`400` if unknown/malformed); a `team` name string (when no `teamId` key) resolves-or-creates, or unassigns when empty. `404` on unknown employee, `400` on empty `name`.)
- `POST /api/employees/:id/enrollment-code` → `{ enrollmentCode, expiresAt }`
- `DELETE /api/employees/:id` → `{ ok: true }` (also deletes their data and revokes devices)
- `DELETE /api/devices/:id` → `{ ok: true }` (revoke: agent gets 401 on next poll and stops)
- `POST /api/devices/:id/stop` → `{ ok: true, command: "stop" }` (agent clocks out and idles, keeps polling)
- `POST /api/devices/:id/resume` → `{ ok: true, command: "none" }` (clears stop)
- `POST /api/devices/:id/uninstall` → `{ ok: true, command: "uninstall" }` (agent self-removes on next poll)
- `GET  /api/employees/:id/day?date=YYYY-MM-DD&tzOffsetMin=-330`
  (`tzOffsetMin` = JS `Date#getTimezoneOffset()` of the viewer)
  →
  ```json
  { "employee": {...},
    "segments": [ {id,start,end,idle,app,title,category} ],
    "sessions": [ {id,kind,at} ],
    "screenshots": [ {id,takenAt} ],
    "totals": { "activeMs": 0, "idleMs": 0, "productiveMs": 0, "unproductiveMs": 0, "neutralMs": 0,
                "firstSeen": null, "lastSeen": null },
    "apps": [ { "app": "code", "category": "productive", "ms": 0 } ] }
  ```
- `GET  /api/screenshots/:id/image` → image bytes (session auth; also accepts `?token=` for `<img>` tags).
- `DELETE /api/screenshots/:id` → `{ ok: true }`
- `GET  /api/reports/summary?from=YYYY-MM-DD&to=YYYY-MM-DD&tzOffsetMin=..`
  → `{ rows: [ { employeeId, name, activeMs, idleMs, productiveMs, unproductiveMs } ] }`
- `GET  /api/reports/summary.csv?...` → same as CSV
- `GET  /api/settings` → `Settings`; `PUT /api/settings` (partial `Settings`) → `Settings`
### Teams

- `GET  /api/teams` → `{ teams: [ { id, name, memberCount, ruleCount, createdAt } ] }` (sorted by name)
- `POST /api/teams` `{ name }` → `{ team: { id, name, memberCount: 0, ruleCount: 0, createdAt } }`
  (name is trimmed; `400` on empty or duplicate name)
- `PATCH /api/teams/:id` `{ name }` → `{ team: { id, name, memberCount, ruleCount, createdAt } }`
  (`404` unknown, `400` empty or duplicate)
- `DELETE /api/teams/:id` → `{ ok: true }` (members' `team_id` → null; the team's rules cascade-delete; `404` unknown)
- `GET  /api/teams/:id/members` → `{ members: [ { id, name, email } ] }` (`404` unknown team)

### App rules (global or team-scoped)

- `GET  /api/app-rules` → `{ rules: [ { id, pattern, category, teamId } ] }` — **global rules only** (`teamId: null`)
- `GET  /api/app-rules?teamId=<uuid>` → `{ rules: [ { id, pattern, category, teamId } ] }` — that team's rules (`400` on malformed `teamId`)
- `POST /api/app-rules` `{ pattern, category: "productive|unproductive|neutral", teamId? }` → `{ rule: { id, pattern, category, teamId } }`
  (`teamId` null/absent = global; a `teamId` string must reference an existing team, else `400`)
- `DELETE /api/app-rules/:id` → `{ ok: true }`

An employee is categorised with their **effective rules**: their team's rules (if any), in
creation order, evaluated first, then global rules in creation order — so a team rule overrides
a global one. `pattern` is matched case-insensitively as a substring against `app`, then against
`title` (first matching rule wins). No match → `neutral`. Idle segments have category `idle`.
Both `/api/employees/:id/day` and `/api/reports/summary(.csv)` categorise each employee with their
own team's effective rules.

## Public installer & downloads (no auth)

- `GET /install.sh`, `GET /install.ps1`, `GET /uninstall.sh`, `GET /uninstall.ps1`
  → the matching template from `INSTALLER_DIR` (default `../installer`) as
  `text/plain; charset=utf-8`, with `__WORKLENS_SERVER_URL__` and
  `__WORKLENS_RELEASE_BASE__` substituted. Server URL is `PUBLIC_URL`, else derived from
  the request (`X-Forwarded-Proto`/`X-Forwarded-Host` honoured). Release base is
  `RELEASE_BASE`, else `${serverUrl}/downloads`. `404` if the template file is missing;
  `400` if the server URL can't be determined and `PUBLIC_URL` is unset.
- `GET /downloads/:file` → streams `DOWNLOADS_DIR/:file` (default `DATA_DIR/downloads`,
  names must match `^[A-Za-z0-9._-]+$`); else `302` to `${GITHUB_RELEASES_URL}/:file`
  when set; else `404`.

Dashboard one-liners (origin = `window.location.origin`):
- Install — macOS/Linux: `curl -fsSL <origin>/install.sh | sh -s -- --code <CODE>`
- Install — Windows: `& ([scriptblock]::Create((irm <origin>/install.ps1))) -Code <CODE>`
- Uninstall — macOS/Linux: `curl -fsSL <origin>/uninstall.sh | sh`
- Uninstall — Windows: `& ([scriptblock]::Create((irm <origin>/uninstall.ps1)))`
