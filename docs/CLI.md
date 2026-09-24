# doc CLI

`doc` is both an authenticated document client and the local operations interface for a self-hosted
checkout. Remote document commands work from any directory; container and development commands
discover the nearest `doc` checkout or accept `--root <path>`.

## Install

From the repository:

```bash
npm ci
npm install --global ./packages/cli
doc --help
```

For repository-local use without a global install:

```bash
npm run doc -- --help
```

The CLI requires Node.js 24.

## Authenticate

Create a scoped personal access token in the Web application, then store it without placing the
secret in shell history or the process list:

```bash
printf '%s\n' "$TOKEN" | doc auth login --url https://docs.example.com
doc auth status
```

When run in an interactive terminal, `auth login` prompts for the token without echoing it. When
stdin is piped, it reads one token from stdin. The CLI validates the token through `/api/v1/me`
before writing anything; failed authentication leaves existing credentials unchanged. There is
deliberately no `--token` option.

Saved credentials use:

1. `DOC_CONFIG_HOME`, when set to an absolute path.
2. `$XDG_CONFIG_HOME/doc`, when `XDG_CONFIG_HOME` is absolute.
3. `~/.config/doc`.

The configuration directory has mode `0700` and `config.json` has mode `0600`. Writes are atomic,
and symbolic links or broader permissions are rejected. `doc auth logout` removes the saved token
while retaining the instance URL.

Runtime precedence is:

- URL: explicit `--url`, then `DOC_API_URL`, then saved configuration.
- Token: `DOC_API_TOKEN`, then saved configuration.

Plain HTTP is accepted only for localhost and loopback addresses. Use HTTPS for every remote
deployment.

A saved token is bound to the saved URL origin. Selecting another origin with `--url` or
`DOC_API_URL` requires `DOC_API_TOKEN`; the CLI never sends a saved token to a different origin.
The configured API URL must be an origin such as `https://docs.example.com`, without a path,
query, fragment, or embedded credentials.

Windows does not provide equivalent protection through POSIX file modes, so `auth login` refuses
to persist a plaintext PAT there. Set `DOC_API_URL` and inject `DOC_API_TOKEN` from the Windows
credential mechanism used by your shell or automation environment.

## Document commands

```bash
# List owned documents. These commands do not require a checkout.
doc ls
doc ls --query architecture --starred --limit 25
doc ls --trash --json

# Read a document and retain its ETag for guarded updates.
doc get <id>
doc get <id> --json
doc get <id> --content-only

# Create an empty document or provide TipTap JSON.
doc create --title "Agent notes"
doc create --title "Child" --parent <parent-id> --content-file content.json
doc create --title "From stdin" --content-file - < content.json
doc create --title "From markdown" --markdown-file notes.md

# Read-only version history. Restore remains in the UI.
doc versions <id>
doc versions get <id> <versionId>

# Comments never rewrite document content.
doc comments <id>
doc comments add <id> --body "Please check the rollback steps"

# Updates are metadata-only in this release.
doc update <id> --title "New title" --if-match '"doc:..."'
doc update <id> --icon "📘" --star --if-match '"doc:..."'
doc update <id> --clear-icon --unstar --force
```

`--content-file` accepts a TipTap document object whose root has `"type": "doc"`. Markdown is not
sniffed on that path. `--markdown-file` converts a bounded CommonMark subset (headings, paragraphs,
lists, tasks, fenced code, http/https/mailto links) and rejects raw HTML, images, tables, and
`javascript:` URLs. Input is limited to 1,000,000 bytes.

`doc update` requires at least one of `--title`, `--icon`, `--clear-icon`, `--star`, or `--unstar`.
It also requires the ETag returned by `doc get` through `--if-match`, or an explicit `--force`.
`--force` sends `If-Match: *` and intentionally bypasses optimistic concurrency.

The remote client always calls the versioned `/api/v1/documents` surface with a Bearer token. It
does not reuse browser session routes or access the database directly.

## Local stack quick start

```bash
doc init
doc doctor
doc up --build
doc doctor --live
npm run verify:local-loop
doc status
```

Open <http://localhost:3100>. Email magic links are captured by the zero-credential Mailpit inbox
at <http://localhost:8025>.

`doc init` writes `.env` and `services/collaboration/.env` with mode `0600`. It creates independent
random values for:

- `AUTH_SECRET`
- `COLLABORATE_API_AUTH_KEY`
- `COLLABORATE_INTERNAL_API_KEY`

It also writes loopback-only host ports and a safe local SMTP path through Mailpit. Re-running
`doc init` merges missing non-secret defaults without replacing configured values. `doc doctor`
requires at least one complete GitHub, SMTP, or Resend provider, while `doc doctor --live` verifies
the providers exposed by the running Web service, the configured SMTP endpoint, local Mailpit when
applicable, and the database-aware Web and collaboration health endpoints.

Secret values are never printed. Existing configured values are kept during a normal merge.
Forced initialization requires both `--force` and `--yes`; it preserves non-secret configuration
and rotates all three generated secrets.

`npm run verify:local-loop` is the repeatable end-to-end check for a running local stack. It uses
Mailpit to establish a browser-equivalent email session, creates and updates a document, re-reads
the persisted state, then removes the generated document. It does not emit the magic link, session
cookie, or token.

## Command surface

| Command                                                           | Purpose                                                                    |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `doc auth login --url URL`                                        | Privately store a remote instance URL and PAT                              |
| `doc auth status [--json]`                                        | Validate credentials through `/api/v1/me` without exposing the token       |
| `doc auth logout [--json]`                                        | Remove the saved PAT                                                       |
| `doc ls [filters] [--json]`                                       | List documents with cursor pagination                                      |
| `doc get ID [--content-only] [--json]`                            | Read one accessible document and its ETag                                  |
| `doc create --title TITLE [--parent ID] [--content-file FILE\|-]` | Create a document                                                          |
| `doc update ID [fields] (--if-match ETAG\|--force)`               | Guarded metadata update                                                    |
| `doc capabilities [--json]`                                       | Print the delivered/experimental capability inventory                      |
| `doc init [--dry-run] [--force --yes]`                            | Create or merge private environments; explicitly rotate generated secrets  |
| `doc doctor [--live] [--json]`                                    | Validate dependencies, configuration, Compose, and optional live endpoints |
| `doc up [service...] [--build] [--foreground]`                    | Start the full stack or selected services, including local Mailpit         |
| `doc down`                                                        | Stop the stack without deleting PostgreSQL data                            |
| `doc status [--json]`                                             | Inspect services in this checkout's isolated Compose project               |
| `doc logs [service] [-f] [--tail N]`                              | Read service logs                                                          |
| `doc dev [--skip-infra]`                                          | Start local dependencies, apply the development schema, and run Next.js    |
| `doc db generate`                                                 | Generate the Prisma client                                                 |
| `doc db push`                                                     | Explicitly push schema to a loopback-only development database             |
| `doc check`                                                       | Run the repository quality gate                                            |
| `doc config path`                                                 | Print the selected local environment path without reading values           |
| `doc version [--json]`                                            | Print CLI, project, and Node versions                                      |

Global options:

```text
--url <url>         Remote doc origin
--root <path>       Explicit checkout for local operations
--env-file <path>   Selected local environment file
--json              Machine-readable output where supported
```

Local runtime configuration precedence remains shell environment, then the selected environment
file, then template defaults. Diagnostics report the source of configured values without printing
them.

`doc init` creates a private `.doc/instance-id`. The stable identity follows a moved checkout and
prevents separate clones from controlling each other's Compose containers. `down`, `status`, and
`logs` remain usable if the runtime environment file is missing or damaged.

## Machine-readable output

Document commands use a versioned CLI envelope. List output contains `schemaVersion`, `documents`,
and API pagination `meta`. Single-document output contains `schemaVersion`, `document`, and `etag`.
HTTP failures are written to stderr with `error`, `code`, `status`, optional `requestId`, and
`exitCode`.

## Safety contract

- Tokens are read from hidden terminal input, stdin, the environment, or a private config file;
  they are origin-bound, redacted from errors, and never accepted in argv.
- Remote requests use native `fetch`, a finite timeout, `redirect: error`, bounded JSON responses,
  and the fixed versioned API.
- Human-readable remote output removes terminal control sequences; JSON output retains values with
  standard JSON escaping.
- Child processes use argument arrays with `shell: false`.
- `doc down` never deletes volumes.
- `doc dev` and `doc db push` refuse non-loopback database hosts and never add
  `--accept-data-loss`.
- Diagnostics redact secrets and do not source environment files as shell code.
- Exit code `0` is success, `1` is an operation/API failure, `2` is invalid usage or
  configuration, and `5` means a required executable is unavailable.

## Deferred document commands

Permanent deletion, trash restoration, version restore, publishing, and workspace import/export
remain deferred. They need explicit confirmation semantics and versioned formats that preserve
TipTap JSON, Yjs binary state, and document snapshots.
