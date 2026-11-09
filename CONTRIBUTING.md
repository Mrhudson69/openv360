# Contributing to openv360

Thanks for your interest in improving **openv360** — the open-source, self-hosted employee monitoring and time-tracking platform. This guide covers how to set up the project locally, run the tests, the coding conventions we follow, and how to get a pull request merged.

By participating, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Repository layout

openv360 is a monorepo with three main parts:

- `agent/` — the cross-platform desktop agent (Rust + Tauri 2). The Rust code lives in `agent/src-tauri`, the tray/status UI in `agent/ui`.
- `server/` — the API (Node 26 + Fastify 5 + PostgreSQL).
- `dashboard/` — the admin UI (React 19 + Vite).

Supporting pieces: `deploy/` (server bootstrap, Caddy, Compose), `installer/` (one-line installers), `linux/` (GNOME Shell extension + systemd units), and `docs/`.

## Prerequisites

- **Node.js 20+** and npm
- **Rust** (stable toolchain, via [rustup](https://rustup.rs/)) for the agent
- **PostgreSQL 17** for the server (or Docker)
- Tauri's system dependencies for building the agent on your OS — see the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). On Ubuntu 24.04/26.04:

  ```sh
  sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev \
    libayatana-appindicator3-dev librsvg2-dev patchelf libxdo-dev \
    build-essential pkg-config
  ```

## Local setup

### Server

```sh
cd server
npm ci
# Point DATABASE_URL at a local Postgres (or run one with Docker):
#   docker run -d --name openv360-db -e POSTGRES_USER=openv360 \
#     -e POSTGRES_PASSWORD=openv360 -e POSTGRES_DB=openv360 -p 5432:5432 postgres:17
export DATABASE_URL=postgres://openv360:openv360@localhost:5432/openv360
export PGPASSWORD=openv360
npm run dev          # starts the API with hot reload
```

### Dashboard

```sh
cd dashboard
npm ci
npm run dev          # Vite dev server; point it at your local server API
```

### Agent

```sh
cd agent
npm ci
npm run dev          # tauri dev — builds the Rust backend and opens the agent
```

## Running the tests

Run the checks for whatever you changed before opening a PR. CI runs all three on every pull request.

```sh
# Server — typecheck and tests (needs a Postgres reachable via DATABASE_URL)
cd server && npx tsc -p tsconfig.json --noEmit && npm test

# Dashboard — typecheck + production build
cd dashboard && npm run build

# Agent — Rust tests and lint
cd agent/src-tauri && cargo test && cargo clippy --all-targets -- -D warnings
```

## Coding conventions

- **TypeScript (server & dashboard):** `strict` mode is on and must stay green — no `tsc` errors, and avoid `any`. Keep the existing module/formatting style of the file you're editing.
- **Rust (agent):** keep it **clippy-clean** — `cargo clippy --all-targets -- -D warnings` must pass. Format with `cargo fmt`.
- **Commits:** use [Conventional Commits](https://www.conventionalcommits.org/) — e.g. `feat: add per-team idle threshold`, `fix(server): retry failed screenshot uploads`, `docs: clarify retention settings`. This keeps history readable and helps with changelogs.
- **Scope:** keep PRs focused. Small, reviewable changes merge faster than large ones.
- **Tests:** add or update tests for behavior you change, especially in the server.

## Pull request process

1. **Fork** the repository and create a branch from `main` (e.g. `feat/team-alerts`).
2. Make your change, following the conventions above.
3. Make sure the relevant tests, typechecks, and clippy pass locally.
4. Open a **pull request to `main`**, fill in the PR template, and link any related issue.
5. **CI must pass** — the `server`, `dashboard`, and `agent` checks are required.
6. A maintainer will review; **at least one approving review** is required to merge. Address feedback by pushing more commits to your branch.

## Reporting bugs and requesting features

- **Bugs & features:** open an issue using the [issue templates](https://github.com/Mrhudson69/openv360/issues/new/choose).
- **Security issues:** do **not** open a public issue — follow [SECURITY.md](SECURITY.md).
- **Questions & ideas:** start a thread in [GitHub Discussions](https://github.com/Mrhudson69/openv360/discussions).

Thanks for contributing!
