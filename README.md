# daybook

A private, self-hosted guided journal: **review yesterday and plan today in the morning → jot things down during the day → summarize in the evening.**

[中文说明 →](README.zh-CN.md)

## Features

- **Guided, fixed fields**: `day_plan` / `day_events` / `day_meals` / `evening_summary`, plus a "yesterday review" entry point.
- **Calendar backfill and per-day detail** views.
- **Incidents** are filed under a day automatically from their timestamp (timezone- and day-boundary-aware).
- **Field-level autosave** with an explicit conflict notice when a write overwrites something newer.
- **Offline drafts** kept in IndexedDB and replayed once you're back online.
- **Daily Web Push reminders** (VAPID) with per-user timezone and day boundary (the journal day starts at 04:00 local).
- **Installable PWA** — add to home screen; Web Push works on iOS 16.4+ too.
- **Optional Android APK** (a Capacitor shell); you enter your server address on first launch.
- **Registration is disabled**; accounts are created with a CLI.
- **Account deletion** has a 7-day grace period, or an immediate purge from the CLI.
- **No third-party scripts, no telemetry.**

## Quick start (Docker)

```bash
git clone https://github.com/getl-x/daybook.git
cd daybook

cp deploy/daybook.env.example .env
# Edit .env: set POSTGRES_PASSWORD and JWT_SECRET (>= 32 chars). VAPID_* is optional.

docker pull ghcr.io/getl-x/daybook:0.1.2

DAYBOOK_IMAGE=ghcr.io/getl-x/daybook:0.1.2 docker compose up -d --no-build

docker compose ps
curl -s http://127.0.0.1:8090/healthz   # {"status":"ok","db":"ok","time":"..."}
```

Create your first account (registration is off):

```bash
docker compose exec -T app sh -c "echo 'your-password' | node server/src/cli/user.ts create --username you --timezone Asia/Shanghai"
```

At this point the app only listens on `127.0.0.1:8090`. To reach it from the internet, put a reverse proxy with TLS in front of it — see [Self-hosting](#self-hosting).

> `--no-build` is not optional: `compose.yml` contains `build: .`, so without it Compose would try to rebuild locally instead of using the pulled image. Always pin an explicit version rather than `latest`, which gets overwritten by the next release.

## Self-hosting

Full, copy-pasteable steps live in [`docs/zh-CN/deployment.md`](docs/zh-CN/deployment.md) (currently in Chinese). The essentials:

- The app container **always listens on 8090**, mapped only to `127.0.0.1` on the host. You bring your own reverse proxy and TLS (nginx, caddy, …).
- The image contains **only the app** — no proxy, no TLS termination.
- The database is reachable **only on the Compose network**; no host port is published.
- **HTTPS is mandatory**: the Android app forbids cleartext traffic, and Web Push / Service Workers only work in a secure context.
- Reminders are best-effort — delivered the same day, not at an exact minute.

## Android app

1. Download the APK from the [Releases](../../releases) page (optionally verify the matching `.sha256`).
2. Allow installing apps from unknown sources in your phone settings.
3. On first launch, enter your server address (it must be `https://`); it is remembered after the first time.

- The APK bundles the front-end assets and **binds to no domain by default**. If you build your own APK, you can preset a default via the repository variable `DAYBOOK_SERVER_URL`.
- **Web Push does not work inside the APK** (a WebView limitation). In a browser PWA it works normally.

## Development

```bash
cd source
npm ci

npm test                        # 202 test cases
npm run typecheck -w @daybook/server
npm run typecheck -w @daybook/web
npm run build -w @daybook/web   # outputs web/dist

# Run the backend locally (needs DATABASE_URL and JWT_SECRET in the environment)
node server/src/db/migrate.ts && node server/src/index.ts
```

Requires **Node ≥ 24** — the backend runs TypeScript directly via built-in type stripping. On older Node you'll hit `ERR_NO_TYPESCRIPT`.

## Tech stack

- **Frontend**: React + TypeScript + Vite + Tailwind, PWA (manifest + service worker, hash routing).
- **Backend**: Node 24 running TypeScript directly (type stripping) + Fastify + `pg` (hand-written SQL).
- **Database**: PostgreSQL 16.
- **Deployment**: your own VPS + Docker (app + Postgres containers); reverse proxy of your choice.
- **Reminders**: a Postgres job table + a per-minute tick + Web Push (VAPID), idempotency key `(user, journal day, type)`.
- **Time rules**: the journal day starts at 04:00 local; the server is the single source of truth, shared with the frontend via `source/shared/src/time.ts`.

## Project layout

The repository root holds only the entry documents, the Docker build/orchestration files, and the deployment inputs; all code lives under `source/` (npm workspaces).

```text
daybook/
├── DAYBOOK-DESIGN.zh-CN.md     Product & technical design (current; v1.1 archived under docs/zh-CN/archive/)
├── README.md                   This file (English)
├── README.zh-CN.md             中文说明
├── LICENSE                     MIT
├── Dockerfile / compose.yml    Container build & orchestration (at the root)
├── .dockerignore / .gitignore  Both follow "deny by default + whitelist"
├── deploy/                     Deployment inputs: daybook.env.example, backup.sh
├── docs/zh-CN/                 Human-facing docs: development / deployment / operations
└── source/                     All application source
    ├── package.json            workspaces: shared / server / web
    ├── shared/                 Shared pure logic (zero deps): time.ts
    ├── server/                 Backend: Node 24 TS + Fastify + PostgreSQL (src/, migrations/, test/)
    ├── web/                    Frontend: React + Vite + Tailwind (PWA)
    │   ├── test/               Frontend pure-logic unit tests (e.g. server URL normalization/validation)
    │   ├── capacitor.config.ts Capacitor (Android shell) config
    │   └── android/            Generated Android project (build output not committed)
    └── scripts/                Build/asset scripts (make-icons.mjs)
```

The `.env` file lives at the **repository root** (Compose reads it); its template is `deploy/daybook.env.example`. `.env` is never committed and never baked into the image.

## Fork / self-build notes

This is a self-hosted project, so most people deploy their **own** build. A few things to change if you fork:

1. **Images**: `ghcr.io/getl-x/daybook` on GitHub Packages is the **upstream** image. After forking, build and push your own image and point `DAYBOOK_IMAGE` at it (any image reference works).
2. **Android `applicationId`** is `com.getlx.daybook`. For your own release, change it to your own id — note that this makes it a **new app identity**, so existing users must uninstall and reinstall.
3. **Sign your release builds with your own keystore** (see "一个 jks 供多个 App 复用" in [`docs/zh-CN/operations.md`](docs/zh-CN/operations.md)).
4. **Replace the example domain** `diary.example.com` in the docs with your own.
5. **Upstream publishing to GHCR / Docker Hub** uses the variable `DOCKERHUB_USERNAME` + the secret `DOCKERHUB_TOKEN`. A fork won't push by default: if either is missing the workflow simply **skips** the Docker Hub step and reports it — it does not fail.

## Security & privacy

A journal is highly private data, so the code and deployment carry these constraints (each backed by tests or a container check):

- Logs never print journal text, tokens, or push-subscription endpoints; 5xx responses return only `internal_error`, never raw database text.
- `.env` and backup files are mode 600 and excluded by both `.gitignore` and `.dockerignore`.
- PostgreSQL never listens on the public internet; the app container runs as non-root.
- Auth: scrypt password hashing, a constant-time KDF even for unknown usernames, login rate limiting (per username and per real IP), refresh-token rotation with CAS to prevent replay, and a per-request check that the account is active and the session is not revoked (logout/disable takes effect immediately).
- Backups use [`deploy/backup.sh`](deploy/backup.sh) (cron + optional rsync to off-site storage); restore steps are in the script header.

## Status & roadmap

**Shipped: v0.1.2** (Docker image + Android APK).

Next up:

- Export (Markdown / JSON).
- Review statistics.
- A conflict-merge UI.
- Native local notifications.

## License

[MIT](LICENSE).
