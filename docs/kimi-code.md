# Kimi Code Provider

Kanna can use [Kimi Code](https://github.com/MoonshotAI/KimiCode) as an agentic
chat provider alongside Claude Code, Codex, Cursor, and Pi. The integration
talks to Kimi Code's local experimental Server API (`kimi web`) instead of
parsing terminal output or embedding Kimi's own web UI.

## Requirements

- [Bun](https://bun.sh/) 1.3.5+
- Kimi Code CLI (`kimi`) installed and on `PATH`
- A signed-in Kimi Code account (run `kimi login` in the sandbox terminal if
  the setup wizard reports that auth is missing)

Install the Kimi Code CLI via npm if you do not have it:

```bash
npm install -g @moonshot-ai/kimi-code
```

## Deployment modes

Kanna supports two ways to reach the Kimi Code runtime. Both keep the Kimi
server bound to a loopback interface; the browser never sees the Kimi bearer
token.

### Mode A: Kanna spawns `kimi web`

Kanna starts `kimi web --no-open` itself when the first Kimi turn is requested.
This is the self-contained default and works well for local development or when
the sandbox does not already manage Kimi.

```text
Kanna backend
    |
    | spawns
    v
kimi web --no-open  (127.0.0.1)
```

No extra environment variables are required. Kanna reads the local URL and
token from Kimi's startup stdout.

### Mode B: Sandbox supervisor owns the Kimi runtime

Use this mode when the company sandbox orchestrator already starts and manages
provider runtimes. The supervisor launches `kimi web` and passes the URL and
bearer token to Kanna through environment variables.

```text
Sandbox orchestrator
    |
    | starts
    v
kimi web --no-open  (127.0.0.1)
    |
    | KANNA_KIMI_SERVER_URL / KANNA_KIMI_SERVER_TOKEN
    v
Kanna backend
```

Required environment variables:

```bash
KANNA_KIMI_SERVER_URL=http://127.0.0.1:<port>
KANNA_KIMI_SERVER_TOKEN=<bearer-token>
```

Both must be set together. Kanna rejects half-configured external mode. The URL
must be loopback (`127.0.0.1`, `localhost`, or `::1`); Kanna refuses non-
loopback hosts to keep the token inside the sandbox.

Mode B is recommended for the company web-platform architecture when the
sandbox orchestrator already owns process lifetime. Mode A is simpler for local
development and self-contained deployments.

## Security boundary

- The Kimi server token stays server-side. It is never sent to the browser,
  stored in Kanna snapshots, or written to the EventStore.
- Kanna does not pass `--host 0.0.0.0` or `--dangerous-bypass-auth` to Kimi.
- The Kimi server must remain loopback-only from the sandbox's point of view.
  Only Kanna's authenticated WebSocket/API is exposed to the company frontend.
- Kanna does not proxy generic Kimi filesystem endpoints (for example
  `/api/v1/fs:content`) to the browser. Attachment access follows Kanna's
  existing project/upload path policy.

## Setup in the UI

1. Open Kanna Settings → Providers.
2. Click **Set up** next to **Kimi Code**.
3. If Kanna is in Mode A, the setup wizard will wait for `kimi web` to start
  and report readiness. In Mode B, readiness is checked against the provided
  `KANNA_KIMI_SERVER_URL`.
4. Complete Kimi authentication if prompted (the wizard shows a device-code
  /login URL when the installed Kimi server supports OAuth endpoints; otherwise
  it instructs you to run `kimi login` in the sandbox terminal).
5. Select the desired model and reasoning effort. K3 is the cold-start default;
  the model list is discovered live from Kimi.

## Model and effort selection

Kimi models and reasoning efforts are fetched from `GET /api/v1/models` at
runtime. K3 typically advertises a single `max` effort. If you configure a
custom Kimi model that reports `support_efforts`, Kanna shows a model-specific
effort picker instead of a hard-coded list.

Context-window size also comes from the model catalog (`max_context_size`).
During a live session, Kanna prefers the runtime session's
`max_context_tokens` if it differs from the catalog.

## Opt-in smoke test

Run the isolated smoke test against a real Kimi runtime:

```bash
KANNA_KIMI_SMOKE=1 bun run test:kimi-smoke
```

By default the smoke test creates a temporary Kimi home so it does not mutate
your normal sessions. To reuse a specific home:

```bash
KANNA_KIMI_SMOKE=1 KIMI_CODE_HOME=/path/to/test/home bun run test:kimi-smoke
```

The smoke test:

1. starts/attaches to `kimi web --no-open`,
2. checks protocol compatibility,
3. creates a temporary session in a temporary git repo,
4. asks Kimi to create `hello.txt`,
5. verifies the file content,
6. runs a second prompt in the same session,
7. cancels a third prompt,
8. shuts down without printing the bearer token.

This test is manual and never runs in CI by default.

## Environment variables reference

| Variable | Required | Description |
|---|---|---|
| `KANNA_KIMI_SMOKE` | for smoke test | Set to `1` to enable the opt-in smoke script. |
| `KIMI_CODE_HOME` | optional | Kimi Code config/session home. Defaults to a temp directory in smoke mode. |
| `KANNA_KIMI_SERVER_URL` | Mode B only | Loopback URL of an externally managed Kimi server. |
| `KANNA_KIMI_SERVER_TOKEN` | Mode B only | Bearer token for the externally managed Kimi server. |

## Troubleshooting

- **"Kimi Code server has been stopped" / spawn errors**: make sure `kimi` is
  on `PATH` and `kimi web --no-open` can start in the sandbox.
- **"Sign in to Kimi Code to use this provider"**: run `kimi login` in the
  sandbox terminal, or complete OAuth through the setup wizard if supported by
  the installed Kimi version.
- **"External Kimi Code server URL must be loopback-only"**: Mode B URLs must
  use `127.0.0.1`, `localhost`, or `::1`. Do not bind Kimi to `0.0.0.0`.
- **Missing API surface warnings**: Kimi's local Server API is experimental.
  Kanna checks the live `/openapi.json` and `/asyncapi.json` at startup.
  Upgrade/downgrade Kimi Code if required paths are missing.

## Architecture notes

```text
React Kanna UI
      |
      v
Kanna shared protocol / snapshots
      |
      v
AgentCoordinator
      |
      +-- KimiCodeManager
              |
              +-- Kimi REST API
              +-- Kimi WS events
                      |
                      v
                 kimi web
```

- One Kimi server connection per Kanna backend/sandbox by default.
- Many Kanna chats map to many Kimi sessions over that one server.
- One shared Kimi WebSocket multiplexes subscriptions for all sessions.
- Browser disconnect never kills the Kimi runtime; Kanna reconnects and
  replays durable events using `seq`/`epoch` cursors.
- A missing Kimi native session triggers Kanna's existing `session_restored`
  boundary and rebuilds context through the handoff/restore mechanism.
