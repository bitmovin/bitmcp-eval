# bitmcp-eval

[![CI](https://github.com/bitmovin-engineering/bitmcp_eval/actions/workflows/ci.yml/badge.svg)](https://github.com/bitmovin-engineering/bitmcp_eval/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

**Evaluate how LLM agents actually use your MCP server.**

You wrote an MCP server — but do agents _use_ it the way you intended? Do they pick the
right tool for a given question? Every time, or only in 7 out of 10 runs?

`bitmcp-eval` answers that. It runs your prompts through a real chat agent, intercepts all
traffic to your MCP server with a recording proxy, and validates the observed tool calls
against your expectations — multiple times per prompt, because agent behavior has spread.

```
┌─────────────┐  prompt  ┌─────────────┐   MCP (StreamableHTTP)   ┌─────────────────┐        ┌────────────────┐
│ bitmcp-eval │ ───────▶ │ chat agent  │ ───────────────────────▶ │ recording proxy │ ─────▶ │ your MCP       │
│    (TUI)    │          │ (claude -p) │ ◀─────────────────────── │  tools/call ✓   │ ◀───── │ server         │
└─────────────┘          └─────────────┘                          └─────────────────┘        └────────────────┘
       │                                                                   │
       └───────────── validate expected vs. recorded tool calls ◀──────────┘
                      → live TUI results + static HTML report
```

The proxy operates on the transport layer, so it needs **zero changes to your server**:
anything that speaks the MCP StreamableHTTP protocol can be put under test — running
locally or remote, with authentication headers injected transparently.

## Requirements

- macOS or Linux (Windows is untested)
- Node.js ≥ 20 with corepack enabled (Yarn Berry)
- A chat agent CLI, installed and authenticated — a **recent version**, since the harness
  relies on newer flags (claude: `--strict-mcp-config`, headless `--resume`; codex:
  `exec resume`, `--json`):
  - [Claude Code](https://claude.com/claude-code) (`claude`) — the default; tested with 2.1.x
  - [OpenAI Codex](https://github.com/openai/codex) (`codex`, `npm install -g @openai/codex`) —
    tested with 0.142.x; select via `run.agents: [codex]` or run both for comparison
- **The MCP server you want to evaluate**, reachable over StreamableHTTP (running locally
  or remote, auth headers supported). The bundled demo weather server exists only to
  verify your toolchain setup end-to-end — evaluating it tells you nothing about your own
  server's tool design.

> **Cost note:** every iteration is a real agent conversation billed against your
> Anthropic/OpenAI account or subscription quota. A run executes
> `test cases × iterations × agents` conversations — plus one extra turn per scripted
> answer that gets used.

## Quickstart (2 minutes, bundled demo server)

```sh
corepack enable
yarn install
yarn build

# terminal 1: start the demo weather MCP server on :3210
yarn demo-server

# terminal 2: run the evaluation against it
yarn start -c examples/eval.yaml
```

You'll watch every test case execute live, and at the end you get a link to a
self-contained HTML report:

```
✓ compare two forecasts  ✓✓ (2/2 passed)
✓ current weather lookup ✓✓ (2/2 passed)
✓ list supported cities  ✓✓ (2/2 passed)

╭──────────────────────────────────────────────────────────────────╮
│ Run finished                                                     │
│ 3 test cases · 6 iterations · 6 passed · 0 failed · 100% pass    │
│ Report: file:///…/reports/bitmcp-eval-2026-07-06T10-00-00.html   │
╰──────────────────────────────────────────────────────────────────╯
```

## Evaluating your own MCP server

### 1. Write test cases

A test case is one YAML file in a directory:

```yaml
# testcases/current-weather.yaml
name: current weather lookup # optional, defaults to the file name
prompt: 'What is the current weather in Vienna?'
expectedTools:
  - get_current_weather
```

**Validation semantics**

- Every tool in `expectedTools` must be called **successfully** at least once per
  iteration. A call whose result is an error — a JSON-RPC error or an MCP result with
  `isError` (e.g. an upstream 401 wrapped by the server) — does not count; it is shown in
  the report as a failed call instead.
- Listing a name N times means "at least N successful calls" — e.g. `get_forecast` twice
  for a two-city comparison prompt.
- Extra calls of expected tools are fine. Calls of unlisted tools are reported in the
  HTML report but don't fail the iteration — agents legitimately explore.

**Answering clarifying questions (`answers`)**

Well-designed MCP servers often instruct the agent to ask the user before acting
("which license should I query?"). In a headless eval that question would end the
conversation and the test would fail even though the server behaves correctly. Give the
test case scripted replies:

```yaml
prompt: 'Show me the ad completion funnel for last week.'
expectedTools:
  - peekAllLicenses
  - query
answers:
  - 'Use the license with the highest play volume, no need to ask me again.'
```

After each agent turn the harness checks the expectations; while they are unmet and
answers remain, it sends the next answer **into the same agent session** (full
conversation context) and re-validates. Answers that aren't needed are never sent. The
HTML report shows the complete conversation for multi-turn iterations.

### 2. Write a config

```yaml
# eval.yaml
envFile: ./.env # optional; defaults to a .env next to this config, when present

mcp:
  url: http://127.0.0.1:3210/mcp # your server (local or remote)
  headers: # injected into every request by the proxy
    - name: x-api-key
      value: ${MY_API_KEY} # ${VAR} pulls from the environment / envFile

testcases:
  source: filesystem
  path: ./testcases # relative to this config file

run:
  iterations: 3 # run each test case 3× to see the behavioral spread
  agents: [claude] # add codex to compare agents: [claude, codex]
  timeoutSeconds: 300

report:
  outDir: ./reports
```

### 3. Run

```sh
yarn start -c eval.yaml          # full run
yarn start -c eval.yaml -i 10    # override iterations from the CLI
yarn start -c eval.yaml --debug  # additionally log every proxied request's headers
#                                  to <report.outDir>/bitmcp-eval-debug.log — useful for
#                                  diagnosing auth issues. Contains secrets, do not share.
```

The process exits non-zero when the run itself fails (bad config, unreachable server).
Evaluation outcomes — pass rates per test case and iteration — are in the TUI summary
and the HTML report, which includes each iteration's recorded tool calls with arguments,
durations, missing expectations, and the agent's full conversation.

The report is written **incrementally**: after the first finished test case the TUI
shows a "Live report" link you can open right away — the page carries an in-progress
banner and auto-refreshes every 10 seconds until the run completes.

## Configuration reference

| Key                  | Type                        | Default                           | Description                                                                                                                                                                                                                    |
| -------------------- | --------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `envFile`            | string                      | `.env` next to config, if present | Dotenv file loaded before `${VAR}` interpolation. Shell environment always takes precedence.                                                                                                                                   |
| `mcp.url`            | URL, required               | —                                 | StreamableHTTP endpoint of the MCP server under test.                                                                                                                                                                          |
| `mcp.headers[]`      | `{name, value}`             | `[]`                              | Headers injected into every proxied request (e.g. API keys). `${VAR}` placeholders are interpolated.                                                                                                                           |
| `mcp.oauth`          | object                      | —                                 | Only for OAuth servers **without** dynamic client registration: `clientId`, `clientSecret` (both `${VAR}`-interpolated), optional `scopes`, `redirectPort`. OAuth itself is auto-detected — see "OAuth-protected MCP servers". |
| `testcases.source`   | `filesystem`                | `filesystem`                      | Test case provider. `s3` and `git` are planned.                                                                                                                                                                                |
| `testcases.path`     | string, required            | —                                 | Directory with `*.yaml` test cases. Relative to the config file. `~` is expanded.                                                                                                                                              |
| `run.iterations`     | int 1–100                   | `3`                               | Executions per test case, to measure behavioral spread.                                                                                                                                                                        |
| `run.agents`         | list of `claude` \| `codex` | `[claude]`                        | Agents to evaluate — the whole suite runs once per agent, with per-agent pass rates in the report. `run.agent: <name>` works as a single-agent alias.                                                                          |
| `run.timeoutSeconds` | int                         | `300`                             | Hard limit per agent invocation.                                                                                                                                                                                               |
| `report.outDir`      | string                      | `./reports`                       | Output directory for the HTML report. Relative to the config file.                                                                                                                                                             |

## Choosing the agents

Agents are a property of the run (`run.agents` in `eval.yaml`). With more than one agent
the whole test suite executes once per agent, and both the TUI summary and the HTML
report ("Agents compared") break the pass rates down per agent — ideal for questions like
"does codex use my server as reliably as claude?".

**`claude`** (default) — each turn runs `claude -p … --strict-mcp-config`, so the server
under test is the agent's _only_ MCP server and only its tools are auto-allowed. Follow-up
`answers` resume the session via `--resume <session-id>`.

**`codex`** — each turn runs `codex exec --json …` with the proxy injected via a config
override; follow-up `answers` use `codex exec resume <thread-id>`. The harness disables
codex's built-in web search (`web_search="disabled"`) and ChatGPT apps/connectors
(`features.apps=false` — codex was observed answering from the logged-in account's
connectors, with that account's credentials, instead of the server under test), and runs
each session in a neutral temp directory with an `AGENTS.md` steering it to answer only
via the server under test.
Caveats inherent to today's codex CLI:

- `--dangerously-bypass-approvals-and-sandbox` is passed automatically because headless
  MCP tool calls are otherwise auto-cancelled
  ([openai/codex#16685](https://github.com/openai/codex/issues/16685),
  [openai/codex#24135](https://github.com/openai/codex/issues/24135)). This lifts the
  sandbox for shell commands, and codex's shell tool cannot be switched off by config —
  the `AGENTS.md` guardrail steers away from it, but that is instruction, not
  enforcement. **Only evaluate trusted test cases against trusted MCP servers, or run
  the harness in a container.**
- Because it cannot be hard-restricted, every shell command and web search codex performs
  is recorded as an **escape from the MCP binding** and shown per iteration in the HTML
  report ("⚠ Left the MCP binding"). Escapes don't fail an iteration by themselves —
  answering _instead of_ calling the expected tools already fails validation, while e.g.
  shell-based math on top of proper tool results is legitimate.
- codex has no isolation flag equivalent to `--strict-mcp-config` (its
  `--ignore-user-config` also drops the override that injects the proxy), so MCP servers
  from your own `~/.codex/config.toml` stay visible to the agent during the eval. Keep the
  eval machine's codex config clean for unpolluted results.

## OAuth-protected MCP servers

Most hosted MCP servers require OAuth. bitmcp-eval **auto-detects** this: if the server
answers the initial request with a `401` challenge, the harness runs an OAuth login and
then injects the resulting bearer token on every proxied request — the chat agent never
touches OAuth.

```sh
# Log in once (opens your browser); the token is cached and refreshed automatically.
yarn start login -c eval.yaml

# Normal runs then just work — and will prompt for login on their own if no
# valid token is cached and the terminal is interactive.
yarn start -c eval.yaml
```

- **Dynamic client registration (DCR):** if the server supports it (most do), no config is
  needed at all — the harness registers its own client on the fly.
- **No DCR:** register an OAuth client yourself, allow the redirect URI
  `http://127.0.0.1:8765/callback` (change the port with `mcp.oauth.redirectPort`), and
  supply its credentials:

  ```yaml
  mcp:
    url: https://your-mcp-server/mcp
    oauth:
      clientId: ${MCP_CLIENT_ID}
      clientSecret: ${MCP_CLIENT_SECRET} # ${VAR} — keep secrets out of the file
      # scopes: [openid, offline_access]
      # redirectPort: 8765
  ```

Tokens are cached per authorization-server + resource under `~/.bitmcp-eval/tokens/`
(mode `0600`), so one login serves every config pointing at that server, and access tokens
are refreshed silently mid-run. For CI, run `bitmcp-eval login` once on a machine with a
browser; non-interactive runs reuse and refresh the cached token, and fail with a clear
message if none exists.

> Already have a token by other means? OAuth is just a header — you can skip all of the
> above and set `Authorization: Bearer ${TOKEN}` under `mcp.headers` instead.

## How it works

`bitmcp-eval` starts a local reverse proxy in front of your MCP server and generates an
MCP configuration for the chat agent that points at the proxy. Every JSON-RPC message is
forwarded byte-for-byte — plain JSON and SSE responses alike — while a copy is parsed to
record each `tools/call`: tool name, arguments, result, error state, and duration. After
each iteration, the recorded calls are validated against the test case's expectations.

The agent runs headlessly per iteration (`claude -p … --strict-mcp-config`) with the
server under test as its **only** MCP server, so results aren't polluted by other tools
the agent might have configured.

## Repository layout

| Path                                                   | Contents                                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| [`packages/core`](packages/core)                       | Recording proxy, config/test case loading, agent invocation, validation, runner, HTML report |
| [`packages/cli`](packages/cli)                         | The `bitmcp-eval` terminal UI (Ink)                                                          |
| [`examples/demo-mcp-server`](examples/demo-mcp-server) | Small deterministic weather MCP server to try the tool                                       |
| [`examples/testcases`](examples/testcases)             | Example test cases wired to the demo server                                                  |

## Development

```sh
yarn install
yarn build          # build all workspaces
yarn test           # vitest unit tests
yarn lint           # eslint
yarn format         # prettier
yarn dev -c …       # run the TUI from TypeScript sources (tsx)
```

Contributions are welcome — please run `yarn lint && yarn format:check && yarn test`
before opening a PR (CI enforces all three).

## Roadmap

- Test case providers: S3, git repository
- More agents: local models behind OpenCode/PI-style harnesses
- stdio transport for local MCP servers
- Argument-level expectations (`expectedArguments`) and response-tone checks
- LLM-judged answer selection (pick the fitting reply instead of a fixed sequence)

## License

[MIT](LICENSE) © Bitmovin, Inc.
