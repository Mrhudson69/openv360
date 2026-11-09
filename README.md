<div align="center">

<img src="docs/assets/logo-banner.svg" alt="openv360" width="520">

### Open-source, self-hosted employee monitoring & time tracking for Windows, macOS, and Linux

A free, privacy-respecting alternative to Hubstaff, Time Doctor, Insightful, and We360.ai — that you run on your own server and fully own.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Self-hosted](https://img.shields.io/badge/deploy-self--hosted-blue.svg)](#quick-start)
[![Agent: Rust + Tauri](https://img.shields.io/badge/agent-Rust%20%2B%20Tauri%202-orange.svg)](agent/)
[![Server: Node + Fastify](https://img.shields.io/badge/server-Node%2026%20%2B%20Fastify%205-339933.svg)](server/)
[![Dashboard: React](https://img.shields.io/badge/dashboard-React%2019%20%2B%20Vite-61dafb.svg)](dashboard/)
[![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#cross-platform-agents)

[![Last commit](https://img.shields.io/github/last-commit/Mrhudson69/openv360.svg)](https://github.com/Mrhudson69/openv360/commits/main)
[![Stars](https://img.shields.io/github/stars/Mrhudson69/openv360.svg?style=social)](https://github.com/Mrhudson69/openv360/stargazers)
[![Issues](https://img.shields.io/github/issues/Mrhudson69/openv360.svg)](https://github.com/Mrhudson69/openv360/issues)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

<img src="docs/assets/demo.gif" alt="openv360 dashboard demo — team activity, timelines, and screenshots" width="760">

</div>

---

# openv360 — open-source employee monitoring & time-tracking software you self-host

**openv360** is a free, **open-source, self-hosted employee monitoring and time-tracking** platform for **Windows, macOS, and Linux**. It gives teams automatic **time tracking**, **activity and app monitoring**, configurable **screenshot monitoring**, **attendance and timesheets**, **productivity analytics**, and **workforce reporting** — without a per-seat SaaS subscription and without handing your employees' data to a third party. Deploy it on your own server in one command, keep every screenshot and activity record on infrastructure you control, and read the whole source. If you've been looking for an **open-source Hubstaff alternative**, a **self-hosted Time Doctor alternative**, or **screenshot monitoring software that is open source**, openv360 is built for exactly that.

Monitoring is **transparent by design**: the desktop agent is always visible in the system tray, only records while an employee is clocked in, and shows what is being captured. You own the data; your team can see the agent working.

> **Status:** v0.1.0 (beta). Usable and self-hostable today; expect rough edges and breaking changes before 1.0.

## Screenshots

### Team overview — live activity, productivity, and who's working now
![openv360 team overview showing per-employee activity, worked hours, and productivity for the whole team](docs/screenshots/02-team.png)

### Per-employee day view — zoomable timeline, activity log, and screenshot gallery
![openv360 employee day view with a zoomable activity timeline, filterable application log, and a screenshot gallery](docs/screenshots/03-employee-day.png)

### Reports — timesheets, productivity, and one-click CSV export
![openv360 reports screen with worked-hours and productivity summaries and CSV export](docs/screenshots/05-reports.png)

## Features

Everything you need to run **workforce analytics and employee time tracking** on your own infrastructure.

- **Automatic time & activity tracking** — Captures worked time, active application, and window title, and distinguishes active from idle time. No manual timers required; employees just clock in.
- **Screenshot monitoring (configurable)** — Periodic screenshots at an interval you choose, with optional **blur** for privacy and automatic **retention**/cleanup. Turn it off entirely per deployment.
- **Idle detection** — Separates focused work from away/idle periods so timesheets reflect real activity.
- **Per-team productivity rules** — Classify applications and sites as productive, neutral, or unproductive, with **different rules per team**, and roll it up into productivity scores.
- **Teams & roles** — Organize people into teams with role-based access: **owner** and **team-manager**, so managers see only their own team.
- **Attendance & timesheets** — Clock-in/out, worked hours, and attendance views across the day, week, and custom ranges.
- **Reports & CSV export** — Worked-hours, activity, and productivity reports you can filter and export to **CSV** for payroll or analysis.
- **Alerts** — Get notified via **Slack, webhook, or email** on the conditions you care about.
- **Scheduled email reports** — Automated recurring report emails via your own SMTP server.
- **Dashboards** — Overview, team, and per-employee **Day/Week** views with a **zoomable timeline**, a **filterable activity log**, and a **screenshot gallery**.
- **Full rebranding (white-label)** — Change the product name, colors, and logo to match your organization.
- **Cross-platform desktop agents** — One agent for **Windows, macOS, and Linux** (Ubuntu 24.04 & 26.04 first-class), built in Rust + Tauri 2 as a small native binary.
- **Auto-update** — Agents update themselves; no manual rollout across machines.
- **Offline-resilient** — The agent queues activity and screenshots locally and retries, so nothing is lost when the network drops.
- **Transparent & privacy-respecting** — Always-visible tray icon, records only while clocked in, and no covert/hidden-process behavior.
- **Self-hosted with automatic HTTPS** — One-command server setup with Docker Compose + Caddy and automatic Let's Encrypt certificates. Your data never leaves your server.

## Why openv360?

Proprietary workforce-monitoring SaaS charges per seat every month, stores your employees' screenshots and activity on their cloud, and keeps the source closed. openv360 flips that.

| | openv360 | Proprietary SaaS (Hubstaff / Time Doctor / Insightful / We360.ai) |
|---|---|---|
| **Hosting** | Self-hosted on your server | Vendor cloud |
| **Pricing** | Free, no per-seat fee | Per-user, per-month |
| **Your data** | Stays on infrastructure you own | Held by the vendor |
| **Source code** | Open (MIT), auditable | Closed |
| **Rebranding** | Full white-label included | Paid add-on or unavailable |
| **Cross-platform agent** | Windows, macOS, Linux | Varies |
| **Transparency** | Always-visible agent, open about what's captured | Varies |

## Quick start

You need a Linux server (Ubuntu 22.04 / 24.04 / 26.04 or Debian 12+) with a domain name or public IP. Everything else is installed for you.

### 1. Install the server (one command)

```sh
curl -fsSL https://raw.githubusercontent.com/Mrhudson69/openv360/main/deploy/setup-server.sh | sudo bash
```

This installs Docker, PostgreSQL, the openv360 server and dashboard, and provisions **automatic HTTPS** (Caddy + Let's Encrypt). It asks for your organization name, domain, and the first admin account, then prints your dashboard URL.

> **Already run nginx / Traefik / another reverse proxy?** Add `--no-caddy` to skip the bundled Caddy and run openv360 behind your proxy: `… | sudo bash -s -- --no-caddy`. See the [reverse-proxy deployment guide](docs/deployment/reverse-proxy.md) for nginx/Traefik examples and shared-network setup.

Prefer to run it yourself? Clone the repo and use Docker Compose:

```sh
git clone https://github.com/Mrhudson69/openv360.git
cd openv360
cp .env.example .env            # set POSTGRES_PASSWORD and other secrets
docker compose up -d            # server + PostgreSQL
# For automatic HTTPS in front of it, use the Caddy overlay:
docker compose -f docker-compose.yml -f deploy/docker-compose.caddy.yml up -d
```

### 2. Add an employee and install the agent

In the dashboard, add an employee to generate a one-time enrollment code (`XXXX-XXXX`). Then, on the employee's computer, run a single line.

**macOS / Linux:**

```sh
curl -fsSL https://YOUR-SERVER/install.sh | sh -s -- --code XXXX-XXXX
```

**Windows (PowerShell):**

```powershell
irm https://YOUR-SERVER/install.ps1 | iex; openv360-install -Code XXXX-XXXX
```

The agent downloads, installs, connects to your server, and starts tracking — always visible in the tray.

## How it works

```
┌─────────────────┐        HTTPS         ┌──────────────────┐        ┌──────────────────┐
│  Desktop agent  │   activity, apps,    │   openv360 server │        │  Admin dashboard │
│  (Rust + Tauri) │ ───screenshots────▶  │ (Node + Fastify)  │ ◀────▶ │ (React + Vite)   │
│  Win/macOS/Linux│    offline-queued    │   + PostgreSQL    │        │  teams, reports  │
└─────────────────┘                      └──────────────────┘        └──────────────────┘
```

1. The **agent** runs on each employee's device, records time/app/idle/screenshots while clocked in, and syncs to the server (queuing and retrying when offline).
2. The **server** stores activity and settings in PostgreSQL and screenshots on disk, and exposes the API.
3. The **dashboard** is where admins and team managers view activity, manage teams and rules, run reports, and configure alerts.

On Linux/Wayland the agent uses a bundled GNOME Shell extension plus `xdg-desktop-portal` to capture screenshots.

## Tech stack

| Part | Stack | Folder |
|------|-------|--------|
| Desktop agent | Rust + Tauri 2 (small native binary) | [`agent/`](agent/) |
| Server API | Node 26 + Fastify 5 + PostgreSQL | [`server/`](server/) |
| Admin dashboard | React 19 + Vite | [`dashboard/`](dashboard/) |
| Linux Wayland helper | GNOME Shell extension + xdg-desktop-portal | [`linux/gnome-extension/`](linux/) |
| Background service units | systemd / launchd / Scheduled Task | [`linux/systemd/`](linux/), [`installer/`](installer/) |
| One-command installers | shell / PowerShell | [`installer/`](installer/) |
| Server bootstrap | script, Docker Compose, Caddy | [`deploy/`](deploy/) |

## Project structure

```
openv360/
├── agent/              # Cross-platform desktop agent (Rust + Tauri 2)
│   ├── src-tauri/      # Rust backend, Tauri config, bundling
│   └── ui/             # Agent tray/status UI
├── server/             # Node 26 + Fastify 5 API
│   ├── src/            # Routes, services, data access
│   ├── migrations/     # PostgreSQL schema migrations
│   └── test/           # Vitest test suite
├── dashboard/          # React 19 + Vite admin UI
├── linux/              # GNOME Shell extension + systemd units
├── installer/          # install.sh / install.ps1 (+ uninstall)
├── deploy/             # setup-server.sh, Caddy, Compose overlays
├── docs/               # Screenshots, assets, API docs
├── docker-compose.yml  # Server + PostgreSQL
└── Dockerfile          # Server image
```

## Security & privacy

openv360 is **employee-monitoring software**, and it is built to be used transparently and lawfully.

- **Hashing & encryption** — Admin passwords use **scrypt** (random salt + constant-time compare); device and session tokens are **SHA-256-hashed**; the SMTP password is **AES-256-GCM encrypted at rest**.
- **Transport** — The deployment path provisions **automatic HTTPS** (Caddy + Let's Encrypt), so agent-to-server traffic is encrypted.
- **Transparency** — The agent is **always visible** in the system tray, records **only while clocked in**, and does **not** hide its process or capture covertly.
- **Data ownership** — Everything is stored on **your** server: activity in PostgreSQL, screenshots on disk, with configurable **retention**.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## ⚖️ Legal & responsible use

> **openv360 is for transparent, lawful workplace monitoring only. You are solely responsible for how you use it, and the maintainers accept no liability for your use.**

- **No warranty, no liability.** The software is provided "as is" under the [MIT License](LICENSE). The authors, maintainers, and contributors are **not responsible or liable** for how you deploy or use openv360, for the data you collect, or for any legal consequences, disputes, or damages arising from your use. **You use it at your own risk.**
- **Lawful use is your responsibility.** Monitoring, recording, and data-protection laws vary by country, state, and region (e.g. GDPR, CCPA/CPRA, ECPA/wiretap and two-party-consent laws, works-council rules). Many **require that you inform, and in some cases obtain consent from, the people being monitored.** You are the data controller and must comply with every law that applies to you.
- **Intended use.** Employer-managed devices, monitored employees who **know** it is running. openv360 is built to be visible on purpose.
- **Prohibited.** Covert surveillance, stalkerware, or monitoring any person/device you are not legally authorized to monitor.
- **Not legal advice.** Consult a qualified lawyer before deploying workplace monitoring.

**Full terms: [DISCLAIMER.md](DISCLAIMER.md).** By using openv360 you agree to them.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup (server, dashboard, agent), how to run the tests, coding conventions (TypeScript strict, clippy-clean Rust, Conventional Commits), and the pull-request process. Please also read our [Code of Conduct](CODE_OF_CONDUCT.md).

## Roadmap

- [x] Cross-platform agent (Windows, macOS, Linux)
- [x] Time, app, idle, and screenshot tracking
- [x] Teams, roles, and per-team productivity rules
- [x] Attendance, reports, and CSV export
- [x] Alerts (Slack / webhook / email) and scheduled reports
- [x] Full rebranding / white-label
- [x] One-command self-hosted deploy with automatic HTTPS
- [ ] 1.0 stabilization and migration guarantees
- [ ] Mobile companion / activity on mobile
- [ ] More integrations (payroll, project tools)
- [ ] Richer analytics and custom report builder
- [ ] Localization / i18n

## License

[MIT](LICENSE) © openv360 contributors.

---

<sub>**Keywords:** open source employee monitoring, self-hosted time tracking, open source Hubstaff alternative, self-hosted Time Doctor alternative, screenshot monitoring software open source, workforce analytics self hosted, employee activity tracking, open source Insightful alternative, We360.ai alternative, self-hosted productivity monitoring, time and attendance tracking, Windows macOS Linux employee monitoring agent.</sub>
