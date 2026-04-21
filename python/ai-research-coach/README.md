# AI Research Coach Python Package

HTTP server for executing Python/shell scripts inside student- and project-scoped workspace directories. Designed to back the AI Research Coach frontend.

## Installation

From the `python/ai-research-coach` directory:

```bash
pip install -e .
```

## Usage

### Starting the Server

```bash
ai-research-coach start-server --passcode <secret> --working-dir /srv/ai-research-coach
```

Each request from the frontend includes a `student_id` and `project_id`. The server creates and uses:

```
<working-dir>/workspaces/<student_id>/<project_id>/
```

as the per-session working directory for that request, with a `tmp/<timestamp>/` script directory inside it.

#### Options

```bash
ai-research-coach start-server \
  --host 0.0.0.0 \
  --port 3339 \
  --working-dir /srv/ai-research-coach \
  --passcode <secret>
```

- `--host`: Host to bind to (default: `127.0.0.1`; use `0.0.0.0` to expose externally)
- `--port`: Port to bind to (default: `3339`)
- `--working-dir`: Server working directory root (default: current directory)
- `--passcode` (required): Shared secret for client authentication
- `--allow-origin` (repeatable): Additional CORS origins to allow (in addition to the bundled defaults)

## License

MIT
