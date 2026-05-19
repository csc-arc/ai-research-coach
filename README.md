# AI Research Coach

An AI assistant for student research coaching. The frontend is a React/Vite single-page app; the backend is a FastAPI server that executes student- and project-scoped Python/shell scripts on a remote host.

Forked from [magland/chatgeneral](https://github.com/magland/chatgeneral).

## Architecture

```
+---------------------------+        HTTPS         +---------------------------+
| Browser (GitHub Pages)    |  /api/run-script ─▶  | FastAPI on droplet        |
| https://arc-csc.github.io |  /files/...      ─▶  | airesearchcoach-server    |
| /ai-research-coach/       |  /api/completion ─▶  | .airesearchcoach.org      |
|                           |  /health         ─▶  |                           |
+---------------------------+                      +-------------+-------------+
                                                                 │ OPENROUTER_API_KEY (server-side)
                                                                 ▼
                                                   https://openrouter.ai/api/v1/chat/completions
```

LLM completions are proxied through the droplet's own `/api/completion` endpoint.
The OpenRouter API key lives exclusively in the server's environment — the browser
never sees it. The model is fixed to `anthropic/claude-4.5-sonnet`.

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

Vite dev server runs at `http://localhost:5173/ai-research-coach/`. CORS for that origin is allowed by the backend by default.

### Build

```bash
npm run build
```

Static output is in `dist/`. The Vite `base` is `/ai-research-coach/`, so deploying to `https://arc-csc.github.io/ai-research-coach/` works out of the box.

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

1. Provision a droplet (e.g., Ubuntu 22.04). Point DNS `airesearchcoach-server.airesearchcoach.org` at the droplet's IP.
2. Install Python 3.10+ and this package:

   ```bash
   git clone https://github.com/arc-csc/ai-research-coach.git
   cd ai-research-coach/python/ai-research-coach
   pip install -e .
   ```

3. Create a secrets file readable only by root, then create a `systemd` unit:

   ```bash
   sudo mkdir -p /etc/ai-research-coach
   sudo tee /etc/ai-research-coach/secrets.env > /dev/null <<'EOF'
   AIRC_PASSCODE=replace-me
   OPENROUTER_API_KEY=sk-or-v1-...
   EOF
   sudo chmod 600 /etc/ai-research-coach/secrets.env
   sudo chown root:root /etc/ai-research-coach/secrets.env
   ```

   ```ini
   # /etc/systemd/system/ai-research-coach.service
   [Unit]
   Description=AI Research Coach script execution server
   After=network.target

   [Service]
   Type=simple
   User=arc
   WorkingDirectory=/srv/ai-research-coach
   EnvironmentFile=/etc/ai-research-coach/secrets.env
   ExecStart=/usr/local/bin/ai-research-coach start-server \
     --host 127.0.0.1 \
     --port 3339 \
     --working-dir /srv/ai-research-coach \
     --passcode ${AIRC_PASSCODE} \
     --allow-origin https://airesearchcoach.org
   Restart=on-failure

   [Install]
   WantedBy=multi-user.target
   ```

   Use `EnvironmentFile=` rather than inline `Environment=` — the latter
   shows the key value in `systemctl show` output. To rotate the key, edit
   `secrets.env` and run `sudo systemctl restart ai-research-coach`.

4. Put **Caddy** (or nginx) in front to terminate TLS:

   ```caddy
   airesearchcoach-server.airesearchcoach.org {
       reverse_proxy 127.0.0.1:3339
   }
   ```

   Caddy auto-issues a Let's Encrypt cert for the domain.

5. Open port 443 in the droplet firewall; keep 3339 closed externally.

6. Verify:

   ```bash
   curl https://airesearchcoach-server.airesearchcoach.org/health
   ```

## Deploying the frontend to GitHub Pages

The included `.github/workflows/deploy.yml` builds the Vite app and publishes `dist/` on push to `main`. In the GitHub repository settings, set **Pages → Source → GitHub Actions**.

The published URL will be `https://arc-csc.github.io/ai-research-coach/`.

## URL parameters

Inherited from the upstream project; all still work here:

- `?instructions=<url>` — load instructions from a URL (GitHub blob URLs auto-rewritten to raw)
- `?student_id=...&project_id=...` — pre-fill identity (also persisted)
- `?auto-approve=1` — auto-approve script executions (use with care)
- `?hide-output-panel=1` — hide the right-hand output panel
- `?hide-tool-details=1` — hide tool call/result expanders

## License

MIT
