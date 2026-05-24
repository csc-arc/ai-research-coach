# AI Research Coach

An AI assistant for student research coaching. The frontend is a React/Vite single-page app; the backend is a FastAPI server that executes student- and project-scoped Python/shell scripts on a remote host.

Forked from [magland/chatgeneral](https://github.com/magland/chatgeneral).

## Architecture

```
+---------------------------+        HTTPS         +---------------------------+
| Browser (GitHub Pages)    |  /api/run-script ─▶  | FastAPI on droplet        |
| https://airesearchcoach   |  /files/...      ─▶  | airesearchcoach-server    |
| .org                      |  /api/completion ─▶  | .airesearchcoach.org      |
|                           |  /health         ─▶  |                           |
+---------------------------+                      +-------------+-------------+
                                                                 │ OPENROUTER_API_KEY (server-side)
                                                                 ▼
                                                   https://openrouter.ai/api/v1/chat/completions
```

LLM completions are proxied through the droplet's own `/api/completion` endpoint.
The OpenRouter API key lives exclusively in the server's environment — the browser
never sees it.

Each student is identified by a `student_id` and a `project_id`. The backend creates and uses:

```
<server-root>/workspaces/<student_id>/<project_id>/
```

as the per-session working directory. Scripts run inside `tmp/<timestamp>/` underneath that.

## Frontend

### Local development

```bash
npm install
npm run dev
```

Vite dev server runs at `http://localhost:5173/`. CORS for that origin is allowed by the backend by default.

### Build

```bash
npm run build
```

Static output is in `dist/`. The Vite `base` is `/`, deploying to `https://airesearchcoach.org`.

### Settings the user must enter

- **Student ID** and **Project ID** (required before any script can run). Allowed pattern: `^[A-Za-z0-9_-]{1,64}$`. Persisted in `localStorage`. Can be pre-filled via URL params: `?student_id=jane-doe&project_id=intro-2026`.
- **Server passcode**: prompted on first use; stored in `sessionStorage` per server URL. Used for both script execution and LLM completions.

### Default server

The frontend defaults to `https://airesearchcoach-server.airesearchcoach.org`. For development you can switch to `http://localhost:3339` via the "Try Local Server" button shown when the default is unreachable.

## Backend (Python)

### Install

```bash
cd python/ai-research-coach
pip install -e .
```

### Run

```bash
OPENROUTER_API_KEY=sk-or-... ai-research-coach start-server \
  --host 0.0.0.0 \
  --port 3339 \
  --working-dir /srv/ai-research-coach \
  --passcode <secret>
```

Flags:

- `--host` — bind address (use `0.0.0.0` to expose externally)
- `--port` — default `3339`
- `--working-dir` — directory under which `workspaces/<student_id>/<project_id>/` is created
- `--passcode` *(required)* — shared secret for client authentication
- `--allow-origin` — repeatable; add additional CORS origins beyond the bundled defaults (`https://arc-csc.github.io` and `http://localhost:5173`)
- `--openrouter-api-key` — OpenRouter key for LLM completions (prefer the `OPENROUTER_API_KEY` env var over this flag to keep the key out of `ps aux`)

### API

| Endpoint | Method | Notes |
|---|---|---|
| `/health` | GET | Returns `{status, workingDir, service}` |
| `/api/run-script` | POST | Body must include `student_id`, `project_id`, `script`, `scriptType`, `timeout`, `passcode` |
| `/api/completion` | POST | Streaming LLM proxy. Body: `{model, systemMessage, messages, tools?, passcode}`. Returns SSE. Requires `OPENROUTER_API_KEY` on the server. |
| `/files/{student_id}/{project_id}/{path}` | GET / HEAD | Serves files from inside the matching session directory; range requests supported |

### Path validation

`student_id` and `project_id` must match `^[A-Za-z0-9_-]{1,64}$`. The server also checks every resolved path stays inside the student/project session directory.

## Deploying the backend to a droplet

> **Existing deployment:** see `notes/droplet-setup.md` in the workspace for the
> canonical record of the live server configuration (paths, venv, secrets file name,
> service user). The instructions below are for a fresh install.

1. Provision a droplet (Ubuntu 22.04+). Point DNS `airesearchcoach-server.airesearchcoach.org` at the droplet's IP.

2. Install dependencies and clone the repo:

   ```bash
   sudo apt install -y python3 python3-pip python3-venv git nginx certbot python3-certbot-nginx
   sudo install -d -o deploy -g deploy /opt/ai-research-coach /opt/arc-venv
   git clone git@github.com:csc-arc/ai-research-coach.git /opt/ai-research-coach
   python3 -m venv /opt/arc-venv
   /opt/arc-venv/bin/pip install -e /opt/ai-research-coach/python/ai-research-coach
   ```

   **Never use bare `pip`** — always `/opt/arc-venv/bin/pip`.

3. Create the workspace root and secrets file:

   ```bash
   sudo mkdir -p /srv/ai-research-coach && sudo chown deploy:deploy /srv/ai-research-coach
   sudo tee /etc/ai-research-coach.env > /dev/null <<'EOF'
   ARC_PASSCODE=replace-me
   OPENROUTER_API_KEY=sk-or-v1-...
   EOF
   sudo chmod 600 /etc/ai-research-coach.env
   sudo chown deploy:deploy /etc/ai-research-coach.env
   ```

   `OPENROUTER_API_KEY` is read from the environment — it is not passed as a CLI flag.
   If missing, the service starts but completions return 503. The startup log prints
   `OpenRouter key: configured` or `NOT SET` to confirm.

4. Create the systemd unit at `/etc/systemd/system/ai-research-coach.service`:

   ```ini
   [Unit]
   Description=AI Research Coach FastAPI backend
   After=network.target

   [Service]
   Type=simple
   User=deploy
   WorkingDirectory=/srv/ai-research-coach
   EnvironmentFile=/etc/ai-research-coach.env
   ExecStart=/opt/arc-venv/bin/ai-research-coach start-server \
     --host 127.0.0.1 \
     --port 3339 \
     --working-dir /srv/ai-research-coach \
     --passcode ${ARC_PASSCODE} \
     --allow-origin https://airesearchcoach.org
   Restart=on-failure
   RestartSec=5

   [Install]
   WantedBy=multi-user.target
   ```

   ```bash
   sudo systemctl daemon-reload && sudo systemctl enable --now ai-research-coach
   curl http://localhost:3339/health
   ```

5. Put **nginx** in front to terminate TLS (certbot handles the cert):

   ```bash
   sudo certbot --nginx -d airesearchcoach-server.airesearchcoach.org
   sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
   ```

6. Verify:

   ```bash
   curl https://airesearchcoach-server.airesearchcoach.org/health
   ```

## Deploying the frontend to GitHub Pages

The included `.github/workflows/deploy.yml` builds the Vite app and publishes `dist/` on push to `main`. In the GitHub repository settings, set **Pages → Source → GitHub Actions** and custom domain to `airesearchcoach.org`.

The published URL is `https://airesearchcoach.org`.

## URL parameters

Inherited from the upstream project; all still work here:

- `?instructions=<url>` — load instructions from a URL (GitHub blob URLs auto-rewritten to raw)
- `?student_id=...&project_id=...` — pre-fill identity (also persisted)
- `?auto-approve=1` — auto-approve script executions (use with care)
- `?hide-output-panel=1` — hide the right-hand output panel
- `?hide-tool-details=1` — hide tool call/result expanders

## License

MIT
