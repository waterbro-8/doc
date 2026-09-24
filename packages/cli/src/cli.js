import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { relative } from 'node:path'
import { ApiClientError, createApiClient, normalizeApiBaseUrl, stripTerminalControlCharacters } from './api-client.js'
import { hasUsableAuthPath } from './auth-config.js'
import { capabilityGroups, capabilitySchemaVersion, capabilitySummary } from './capabilities.js'
import {
  composeArgs,
  composeProjectName,
  controlComposeArgs,
  normalizeComposeServices,
  parseComposePs,
} from './compose.js'
import {
  CliConfigurationError,
  readCliConfig,
  resolveApiCredentials,
  resolveConfigPaths,
  validateToken,
  writeCliConfig,
} from './config.js'
import { checkDockerReadiness } from './docker-readiness.js'
import { runDoctor } from './doctor.js'
import { InputError, readDocumentInput, readMarkdownInput, readSecretToken } from './input.js'
import { markdownToTiptap } from './markdown-to-tiptap.js'
import { createProcessRunner } from './process.js'
import {
  exists,
  initializeEnvironment,
  isConfiguredSecret,
  ProjectConfigurationError,
  readEnv,
  resolveEnvPath,
  resolveProjectRoot,
} from './project.js'

const require = createRequire(import.meta.url)
const { version: CLI_VERSION } = require('../package.json')

const EXIT = {
  success: 0,
  failure: 1,
  usage: 2,
  dependency: 5,
}

const COMPOSE_SERVICES = new Set(['postgres', 'mailpit', 'migrate', 'collaboration', 'web'])
const JSON_COMMANDS = new Set([
  'auth',
  'capabilities',
  'create',
  'doctor',
  'get',
  'init',
  'ls',
  'status',
  'update',
  'version',
  'versions',
  'comments',
])
const REMOTE_COMMANDS = new Set(['auth', 'create', 'get', 'ls', 'update', 'versions', 'comments'])
const CONFIGURATION_API_ERRORS = new Set(['insecure_api_url', 'invalid_api_url'])
const CONTROL_COMPOSE_ENV = {
  AUTH_SECRET: 'doc-control-command-only',
  COLLABORATE_API_AUTH_KEY: 'doc-control-collaboration-only',
  COLLABORATE_INTERNAL_API_KEY: 'doc-control-internal-only',
}

class UsageError extends Error {}

function write(stream, value = '') {
  stream.write(`${value}\n`)
}

function optionName(value) {
  return value.slice(2).split('=', 1)[0]
}

function extractGlobalOptions(argv) {
  const args = [...argv]
  const options = { json: false }
  const remaining = []

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === '--json') {
      options.json = true
      continue
    }
    if (value === '--root' || value === '--env-file' || value === '--url') {
      const next = args[index + 1]
      if (!next || next.startsWith('-')) throw new UsageError(`${value} requires a value`)
      options[value.slice(2).replace('-', '_')] = next
      index += 1
      continue
    }
    if (value.startsWith('--root=') || value.startsWith('--env-file=') || value.startsWith('--url=')) {
      const [name, ...parts] = value.slice(2).split('=')
      const optionValue = parts.join('=')
      if (!optionValue) throw new UsageError(`--${name} requires a value`)
      options[name.replace('-', '_')] = optionValue
      continue
    }
    remaining.push(value)
  }

  return { options, remaining }
}

function parseCommandOptions(args, definition = {}) {
  const flags = {}
  const positionals = []
  const aliases = definition.aliases || {}

  for (let index = 0; index < args.length; index += 1) {
    let value = args[index]
    if (aliases[value]) value = aliases[value]

    if (!value.startsWith('--')) {
      if (value.startsWith('-')) throw new UsageError(`Unknown option: ${value}`)
      positionals.push(value)
      continue
    }

    const name = optionName(value)
    const type = definition[name]
    if (!type) throw new UsageError(`Unknown option: --${name}`)

    if (type === 'boolean') {
      if (value.includes('=')) throw new UsageError(`--${name} does not accept a value`)
      flags[name] = true
      continue
    }

    const inlineValue = value.includes('=') ? value.slice(value.indexOf('=') + 1) : undefined
    const next = inlineValue ?? args[index + 1]
    if (!next || (inlineValue === undefined && next.startsWith('-') && !(type === 'value-or-stdin' && next === '-'))) {
      throw new UsageError(`--${name} requires a value`)
    }
    flags[name] = next
    if (inlineValue === undefined) index += 1
  }

  return { flags, positionals }
}

function globalHelp() {
  return `doc ${CLI_VERSION} — document and local operations for doc

Usage:
  doc [--url <url>] [--root <path>] [--env-file <path>] [--json] <command> [options]

Commands:
  auth <command>        Store, inspect, or remove remote API credentials
  ls                    List documents through the authenticated API
  get <id>              Get one document through the authenticated API
  create                Create a document through the authenticated API
  update <id>           Update document metadata through the authenticated API
  versions              List or get document versions through the authenticated API
  comments              List or create document comments through the authenticated API
  capabilities          List delivered and experimental product capabilities
  init                  Create or safely merge private environment files
  doctor                Check local dependencies, configuration, and optional live services
  up [service...]       Build and start the container stack
  down                  Stop the container stack without deleting data
  status                Show container service status
  logs [service]        Read container logs
  dev                   Start dependencies and run the Web app in development mode
  db <generate|push>    Run explicit local Prisma tasks
  check                 Run the repository quality gate
  config path           Print the active environment file path
  version               Print CLI, project, and Node versions
  help [command]        Show command help

Global options:
  --url <url>           Remote doc origin (overrides DOC_API_URL and saved configuration)
  --root <path>         doc checkout to operate on (default: discover from cwd)
  --env-file <path>     Environment file relative to the project root (default: .env)
  --json                Emit machine-readable output when supported
  -h, --help            Show help
  -v, --version         Show version

Exit codes:
  0 success · 1 operation/check failed · 2 usage/configuration error · 5 dependency unavailable`
}

const commandHelp = {
  auth: `Usage:
  doc auth login --url <url>
  doc auth status [--json]
  doc auth logout [--json]

login reads a token without echo from a terminal, or from stdin when piped.
Tokens are never accepted as command-line options.`,
  ls: `Usage: doc ls [--query <text>] [--starred] [--trash] [--limit <1-100>] [--cursor <cursor>] [--json]

List documents from /api/v1/documents. This command does not require a local checkout.`,
  get: `Usage: doc get <id> [--content-only] [--json]

Get a document accessible to the authenticated principal.`,
  create: `Usage: doc create --title <title> [--parent <id>] [--content-file <path|-> | --markdown-file <path|->] [--json]

Create a document. --content-file accepts TipTap JSON only. --markdown-file converts a bounded
CommonMark subset (headings, paragraphs, lists, tasks, fenced code, links). They are mutually exclusive.`,
  versions: `Usage:
  doc versions <id> [--limit <1-100>] [--cursor <cursor>] [--json]
  doc versions get <id> <versionId> [--json]

List or get document versions. Restore remains a UI/collaboration action.`,
  comments: `Usage:
  doc comments <id> [--include-resolved] [--json]
  doc comments add <id> --body <text> [--json]

List or create document comments. Comments never rewrite document content.`,
  update: `Usage: doc update <id> [--title <title>] [--icon <icon> | --clear-icon]
                     [--star | --unstar] [--if-match <etag> | --force] [--json]

Update document metadata. --force sends If-Match: * and is mutually exclusive with --if-match.`,
  capabilities: `Usage: doc capabilities [--json]

List the current product capability inventory. Experimental surfaces are labeled explicitly.`,
  init: `Usage: doc init [--force --yes] [--dry-run]

Create .env and services/collaboration/.env with three independent random secrets and local Mailpit SMTP defaults.
Missing safe defaults are merged into existing files without replacing configured values.
Forced initialization preserves non-secret values and rotates all generated secrets.`,
  doctor: `Usage: doc doctor [--live] [--json]

Check Node.js, Docker, Compose, environment values, and Compose configuration.
Use --live to also probe Web, authentication, SMTP, local Mailpit, and collaboration health.`,
  up: `Usage: doc up [postgres|mailpit|migrate|collaboration|web ...] [--build] [--foreground]

Start the full stack by default. In detached mode Compose waits for healthy services.`,
  down: `Usage: doc down

Stop the stack. This command never deletes the PostgreSQL volume.`,
  status: `Usage: doc status [--json]

Show status for this checkout's isolated Compose project.`,
  logs: `Usage: doc logs [postgres|mailpit|migrate|collaboration|web] [--follow] [--tail <lines>]

Read service logs. --follow can be shortened to -f.`,
  dev: `Usage: doc dev [--skip-infra]

Start PostgreSQL, Mailpit, and collaboration in containers, push the local schema, then run Next.js.`,
  db: `Usage: doc db <generate|push>

Run Prisma generation or an explicit local schema push. db push refuses non-local database hosts.`,
  check: `Usage: doc check

Run formatting, lint, tests, collaboration checks, and the production build.`,
  config: `Usage: doc config path

Print the resolved environment file path without reading secret values.`,
  version: `Usage: doc version [--json]

Print CLI and project versions.`,
}

function ensureNoPositionals(positionals, command) {
  if (positionals.length > 0) throw new UsageError(`${command} does not accept positional arguments`)
}

async function requireRuntimeEnv(envPath, processEnv) {
  if (!(await exists(envPath))) throw new UsageError(`Missing ${envPath}. Run "doc init" first.`)
  const env = { ...(await readEnv(envPath)), ...processEnv }
  const missing = ['AUTH_SECRET', 'DATABASE_URL', 'COLLABORATE_API_AUTH_KEY', 'COLLABORATE_INTERNAL_API_KEY'].filter(
    (key) => (key.includes('SECRET') || key.includes('KEY') ? !isConfiguredSecret(env[key]) : !env[key])
  )
  if (missing.length > 0) throw new UsageError(`Missing or placeholder configuration: ${missing.join(', ')}`)
  const secrets = [env.AUTH_SECRET, env.COLLABORATE_API_AUTH_KEY, env.COLLABORATE_INTERNAL_API_KEY]
  if (new Set(secrets).size !== secrets.length) {
    throw new UsageError('AUTH_SECRET and both collaboration keys must all be different')
  }
  if (!hasUsableAuthPath(env)) {
    throw new UsageError('No usable authentication path; configure complete GitHub, SMTP, or Resend settings')
  }
  return env
}

function assertLocalDatabase(env) {
  if (!databaseIsLocal(env.DATABASE_URL)) {
    throw new UsageError('Local schema operations only accept localhost or loopback DATABASE_URL values')
  }
}

function normalizedProcessExit(result) {
  if (result.code === 0) return EXIT.success
  if (result.code === 127) return EXIT.dependency
  return EXIT.failure
}

function formatCapabilitiesText() {
  const lines = []
  for (const group of capabilityGroups) {
    lines.push(group.title)
    for (const item of group.capabilities) {
      lines.push(`  ${item.status === 'available' ? '✓' : '△'} ${item.name} [${item.status}]`)
      lines.push(`    ${item.detail}`)
    }
    lines.push('')
  }
  const summary = capabilitySummary()
  lines.push(`${summary.available} available · ${summary.experimental} experimental`)
  return lines.join('\n')
}

function formatDoctorText(result) {
  const lines = result.checks.map((item) => {
    const marker = item.status === 'pass' ? '✓' : item.status === 'warn' ? '!' : '✗'
    const guidance = item.guidance ? `\n    ${item.guidance}` : ''
    return `${marker} ${item.label}: ${item.detail}${guidance}`
  })
  lines.push(result.ok ? 'doctor: healthy' : 'doctor: action required')
  return lines.join('\n')
}

function npmCommand(platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm'
}

function validateServices(services) {
  for (const service of services) {
    if (!COMPOSE_SERVICES.has(service)) throw new UsageError(`Unknown service: ${service}`)
  }
}

function databaseIsLocal(databaseUrl) {
  try {
    const hostname = new URL(databaseUrl).hostname
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
  } catch {
    return false
  }
}

function localWebPort(env) {
  const value = env.DOC_WEB_PORT || '3100'
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new UsageError('DOC_WEB_PORT must be an integer between 1 and 65535')
  }
  return value
}

function validateDocumentId(value) {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  ) {
    throw new UsageError('Document id must be a non-empty value of at most 256 characters')
  }
  return value
}

function validateTitle(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UsageError('--title must not be empty')
  }
  if (value.length > 100) throw new UsageError('--title must not exceed 100 characters')
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new UsageError('--title must not contain control characters')
  }
  return value
}

function invalidDocument() {
  throw new ApiClientError('API returned an invalid document', {
    code: 'invalid_api_response',
  })
}

function assertDocument(value, { requireContent = false } = {}) {
  if (
    value == null ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    typeof value.id !== 'string' ||
    value.id.trim() === '' ||
    typeof value.title !== 'string' ||
    (value.icon !== null && typeof value.icon !== 'string') ||
    (value.parentId !== null && typeof value.parentId !== 'string') ||
    typeof value.starred !== 'boolean' ||
    typeof value.deleted !== 'boolean' ||
    !['owner', 'write', 'read'].includes(value.access) ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    invalidDocument()
  }
  if (
    requireContent &&
    (value.content == null ||
      Array.isArray(value.content) ||
      typeof value.content !== 'object' ||
      value.content.type !== 'doc')
  ) {
    invalidDocument()
  }
  return value
}

function assertEtag(value) {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  ) {
    throw new ApiClientError('API response is missing a valid document ETag', {
      code: 'invalid_api_response',
    })
  }
  return value
}

function assertListMeta(value) {
  if (
    value == null ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    (value.nextCursor !== null && typeof value.nextCursor !== 'string')
  ) {
    throw new ApiClientError('API returned invalid document pagination metadata', {
      code: 'invalid_api_response',
    })
  }
  return value
}

function terminalText(value) {
  return stripTerminalControlCharacters(value)
}

function compactText(value) {
  return terminalText(value).replace(/\s+/g, ' ').trim()
}

function writeDocumentText(stdout, action, document, etag) {
  if (action) {
    write(stdout, `${action} ${terminalText(document.id)}${document.title ? ` · ${compactText(document.title)}` : ''}`)
    write(stdout, `etag: ${terminalText(etag)}`)
    return
  }
  write(stdout, `id: ${terminalText(document.id)}`)
  write(stdout, `title: ${compactText(document.title)}`)
  if (document.icon != null) write(stdout, `icon: ${terminalText(document.icon)}`)
  if (document.parentId != null) write(stdout, `parent: ${terminalText(document.parentId)}`)
  write(stdout, `starred: ${document.starred}`)
  write(stdout, `deleted: ${document.deleted}`)
  write(stdout, `access: ${terminalText(document.access)}`)
  write(stdout, `updated: ${terminalText(document.updatedAt)}`)
  write(stdout, `etag: ${terminalText(etag)}`)
  if (document.content !== undefined) {
    write(stdout, 'content:')
    write(stdout, JSON.stringify(document.content, null, 2))
  }
}

function singleDocumentJson(document, etag) {
  return {
    schemaVersion: 1,
    document,
    etag,
  }
}

function assertPrincipal(value) {
  if (
    value == null ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    value.authenticated !== true ||
    typeof value.userId !== 'string' ||
    value.userId.trim() === '' ||
    !Array.isArray(value.scopes) ||
    !value.scopes.every((scope) => typeof scope === 'string' && scope.trim() !== '')
  ) {
    throw new ApiClientError('API returned an invalid authentication status', {
      code: 'invalid_api_response',
    })
  }
  return value
}

async function handleAuthCommand({
  commandArgs,
  globalOptions,
  processEnv,
  configPaths,
  readToken,
  fetchImpl,
  timeoutMs,
  maxResponseBytes,
  stdout,
  platform,
}) {
  const { positionals } = parseCommandOptions(commandArgs)
  if (positionals.length !== 1 || !['login', 'logout', 'status'].includes(positionals[0])) {
    throw new UsageError('auth requires exactly one subcommand: login, status, or logout')
  }

  const subcommand = positionals[0]
  if (subcommand === 'login') {
    if (!globalOptions.url) throw new UsageError('auth login requires --url <url>')
    if (platform === 'win32') {
      throw new CliConfigurationError(
        'Saved API tokens are not supported on Windows; use DOC_API_TOKEN from a protected credential source'
      )
    }
    const url = normalizeApiBaseUrl(globalOptions.url)
    const token = validateToken(await readToken())
    const client = createApiClient({
      baseUrl: url,
      token,
      fetchImpl,
      timeoutMs,
      maxResponseBytes,
    })
    const principal = assertPrincipal((await client.me()).payload.data)
    const config = await readCliConfig(configPaths, platform)
    await writeCliConfig(configPaths, { ...config, url, token }, platform)
    const result = {
      schemaVersion: 1,
      saved: true,
      authenticated: true,
      url,
      tokenSource: 'config',
      userId: principal.userId,
      scopes: principal.scopes,
      configPath: configPaths.file,
    }
    write(stdout, globalOptions.json ? JSON.stringify(result, null, 2) : `saved credentials for ${url}`)
    return EXIT.success
  }

  if (subcommand === 'logout') {
    const config = await readCliConfig(configPaths, platform)
    const removed = Boolean(config.token)
    if (removed) {
      const remaining = { ...config }
      delete remaining.token
      await writeCliConfig(configPaths, remaining, platform)
    }
    const environmentToken = Boolean(processEnv.DOC_API_TOKEN?.trim())
    const result = {
      schemaVersion: 1,
      removed,
      environmentTokenActive: environmentToken,
      configPath: configPaths.file,
    }
    if (globalOptions.json) {
      write(stdout, JSON.stringify(result, null, 2))
    } else {
      write(stdout, removed ? 'removed saved API token' : 'no saved API token')
      if (environmentToken) write(stdout, 'DOC_API_TOKEN remains active in the environment')
    }
    return EXIT.success
  }

  const credentials = await resolveApiCredentials({
    explicitUrl: globalOptions.url,
    env: processEnv,
    paths: configPaths,
    allowIncomplete: true,
    platform,
  })
  const normalizedUrl = credentials.url ? normalizeApiBaseUrl(credentials.url) : null
  let principal = null
  if (normalizedUrl && credentials.token) {
    const client = createApiClient({
      baseUrl: normalizedUrl,
      token: credentials.token,
      fetchImpl,
      timeoutMs,
      maxResponseBytes,
    })
    principal = assertPrincipal((await client.me()).payload.data)
  }
  const result = {
    schemaVersion: 1,
    authenticated: principal?.authenticated === true,
    url: normalizedUrl,
    urlSource: normalizedUrl ? credentials.urlSource : null,
    tokenConfigured: Boolean(credentials.token),
    tokenSource: credentials.tokenSource,
    userId: principal?.userId || null,
    scopes: principal?.scopes || [],
    configPath: configPaths.file,
  }
  if (globalOptions.json) {
    write(stdout, JSON.stringify(result, null, 2))
  } else if (result.authenticated) {
    write(
      stdout,
      `authenticated to ${terminalText(result.url)} as ${terminalText(result.userId)} (${terminalText(
        result.tokenSource
      )} token)`
    )
    write(stdout, `scopes: ${result.scopes.map(terminalText).join(', ') || 'none'}`)
  } else {
    write(stdout, 'not authenticated')
  }
  return EXIT.success
}

async function handleRemoteCommand({
  command,
  commandArgs,
  globalOptions,
  processEnv,
  configPaths,
  fetchImpl,
  stdout,
  cwd,
  stdin,
  timeoutMs,
  maxResponseBytes,
  platform,
}) {
  let operation

  if (command === 'ls') {
    const { flags, positionals } = parseCommandOptions(commandArgs, {
      query: 'value',
      starred: 'boolean',
      trash: 'boolean',
      limit: 'value',
      cursor: 'value',
    })
    ensureNoPositionals(positionals, command)
    if (flags.limit && (!/^\d+$/.test(flags.limit) || Number(flags.limit) < 1 || Number(flags.limit) > 100)) {
      throw new UsageError('--limit must be an integer between 1 and 100')
    }
    if (flags.query && flags.query.length > 200) throw new UsageError('--query must not exceed 200 characters')
    operation = async (client) => {
      const result = await client.list({
        query: flags.query,
        starred: flags.starred,
        trash: flags.trash,
        limit: flags.limit && Number(flags.limit),
        cursor: flags.cursor,
      })
      if (!Array.isArray(result.payload.data)) {
        throw new ApiClientError('API returned an invalid document list', { code: 'invalid_api_response' })
      }
      const documents = result.payload.data.map(assertDocument)
      const meta = assertListMeta(result.payload.meta)
      if (globalOptions.json) {
        write(
          stdout,
          JSON.stringify(
            {
              schemaVersion: 1,
              documents,
              meta,
            },
            null,
            2
          )
        )
      } else if (documents.length === 0) {
        write(stdout, 'No documents.')
      } else {
        write(stdout, 'ID\tUPDATED\tTITLE')
        for (const document of documents) {
          write(
            stdout,
            `${terminalText(document.id)}\t${terminalText(document.updatedAt)}\t${compactText(document.title)}`
          )
        }
        if (meta.nextCursor) write(stdout, `next cursor: ${terminalText(meta.nextCursor)}`)
      }
    }
  }

  if (command === 'get') {
    const { flags, positionals } = parseCommandOptions(commandArgs, { 'content-only': 'boolean' })
    if (positionals.length !== 1) throw new UsageError('get requires exactly one document id')
    if (flags['content-only'] && globalOptions.json) {
      throw new UsageError('--content-only and --json are mutually exclusive')
    }
    const id = validateDocumentId(positionals[0])
    operation = async (client) => {
      const result = await client.get(id)
      const document = assertDocument(result.payload.data, { requireContent: true })
      const etag = assertEtag(result.etag)
      if (flags['content-only']) {
        write(stdout, JSON.stringify(document.content, null, 2))
      } else if (globalOptions.json) {
        write(stdout, JSON.stringify(singleDocumentJson(document, etag), null, 2))
      } else {
        writeDocumentText(stdout, null, document, etag)
      }
    }
  }

  if (command === 'create') {
    const { flags, positionals } = parseCommandOptions(commandArgs, {
      title: 'value',
      parent: 'value',
      'content-file': 'value-or-stdin',
      'markdown-file': 'value-or-stdin',
    })
    ensureNoPositionals(positionals, command)
    if (!flags.title) throw new UsageError('create requires --title <title>')
    if (flags['content-file'] && flags['markdown-file']) {
      throw new UsageError('--content-file and --markdown-file are mutually exclusive')
    }
    const body = { title: validateTitle(flags.title) }
    if (flags.parent) body.parentId = validateDocumentId(flags.parent)
    if (flags['content-file']) body.content = await readDocumentInput(flags['content-file'], cwd, stdin)
    if (flags['markdown-file']) {
      const markdown = await readMarkdownInput(flags['markdown-file'], cwd, stdin)
      body.content = markdownToTiptap(markdown)
    }
    operation = async (client) => {
      const result = await client.create(body)
      const document = assertDocument(result.payload.data, { requireContent: true })
      const etag = assertEtag(result.etag)
      if (globalOptions.json) {
        write(stdout, JSON.stringify(singleDocumentJson(document, etag), null, 2))
      } else {
        writeDocumentText(stdout, 'created', document, etag)
      }
    }
  }

  if (command === 'versions') {
    const { flags, positionals } = parseCommandOptions(commandArgs, {
      limit: 'value',
      cursor: 'value',
    })
    if (positionals[0] === 'get') {
      if (positionals.length !== 3) throw new UsageError('versions get requires a document id and a version id')
      const documentId = validateDocumentId(positionals[1])
      const versionId = validateDocumentId(positionals[2])
      operation = async (client) => {
        const result = await client.getVersion(documentId, versionId)
        const version = result.payload.data
        if (globalOptions.json) {
          write(stdout, JSON.stringify({ schemaVersion: 1, version }, null, 2))
        } else {
          write(stdout, `id: ${terminalText(version.id)}`)
          write(stdout, `title: ${compactText(version.title)}`)
          write(stdout, `author: ${terminalText(version.authorId)}`)
          write(stdout, `created: ${terminalText(version.createdAt)}`)
          write(stdout, 'content:')
          write(stdout, JSON.stringify(version.content, null, 2))
        }
      }
    } else {
      if (positionals.length !== 1) throw new UsageError('versions requires exactly one document id')
      if (flags.limit && (!/^\d+$/.test(flags.limit) || Number(flags.limit) < 1 || Number(flags.limit) > 100)) {
        throw new UsageError('--limit must be an integer between 1 and 100')
      }
      const id = validateDocumentId(positionals[0])
      operation = async (client) => {
        const result = await client.listVersions(id, {
          limit: flags.limit && Number(flags.limit),
          cursor: flags.cursor,
        })
        const versions = result.payload.data
        const meta = result.payload.meta || { nextCursor: null }
        if (!Array.isArray(versions)) {
          throw new ApiClientError('API returned an invalid version list', { code: 'invalid_api_response' })
        }
        if (globalOptions.json) {
          write(stdout, JSON.stringify({ schemaVersion: 1, versions, meta }, null, 2))
        } else if (versions.length === 0) {
          write(stdout, 'No versions.')
        } else {
          write(stdout, 'ID\tCREATED\tAUTHOR\tTITLE')
          for (const version of versions) {
            write(
              stdout,
              `${terminalText(version.id)}\t${terminalText(version.createdAt)}\t${terminalText(version.authorId)}\t${compactText(version.title)}`
            )
          }
          if (meta.nextCursor) write(stdout, `next cursor: ${terminalText(meta.nextCursor)}`)
        }
      }
    }
  }

  if (command === 'comments') {
    const { flags, positionals } = parseCommandOptions(commandArgs, {
      body: 'value',
      'include-resolved': 'boolean',
    })
    if (positionals[0] === 'add') {
      if (positionals.length !== 2) throw new UsageError('comments add requires a document id')
      if (!flags.body || !flags.body.trim()) throw new UsageError('comments add requires --body <text>')
      if (flags.body.length > 4000) throw new UsageError('--body must not exceed 4000 characters')
      const id = validateDocumentId(positionals[1])
      operation = async (client) => {
        const result = await client.createComment(id, { body: flags.body })
        const comment = result.payload.data
        if (globalOptions.json) {
          write(stdout, JSON.stringify({ schemaVersion: 1, comment }, null, 2))
        } else {
          write(stdout, `created ${terminalText(comment.id)}`)
        }
      }
    } else {
      if (positionals.length !== 1) throw new UsageError('comments requires exactly one document id')
      const id = validateDocumentId(positionals[0])
      operation = async (client) => {
        const result = await client.listComments(id, { includeResolved: flags['include-resolved'] })
        const comments = result.payload.data
        if (!Array.isArray(comments)) {
          throw new ApiClientError('API returned an invalid comment list', { code: 'invalid_api_response' })
        }
        if (globalOptions.json) {
          write(stdout, JSON.stringify({ schemaVersion: 1, comments }, null, 2))
        } else if (comments.length === 0) {
          write(stdout, 'No comments.')
        } else {
          for (const comment of comments) {
            const resolved = comment.resolvedAt ? ' resolved' : ''
            write(
              stdout,
              `${terminalText(comment.id)}\t${terminalText(comment.authorId)}${resolved}\t${compactText(comment.body)}`
            )
          }
        }
      }
    }
  }

  if (command === 'update') {
    const { flags, positionals } = parseCommandOptions(commandArgs, {
      title: 'value',
      icon: 'value',
      'clear-icon': 'boolean',
      star: 'boolean',
      unstar: 'boolean',
      'if-match': 'value',
      force: 'boolean',
    })
    if (positionals.length !== 1) throw new UsageError('update requires exactly one document id')
    if (flags.icon && flags['clear-icon']) throw new UsageError('--icon and --clear-icon are mutually exclusive')
    if (flags.star && flags.unstar) throw new UsageError('--star and --unstar are mutually exclusive')
    if (flags['if-match'] && flags.force) throw new UsageError('--if-match and --force are mutually exclusive')
    if (!flags['if-match'] && !flags.force) {
      throw new UsageError('update requires --if-match <etag> or --force')
    }
    if (flags.icon && flags.icon.length > 32) throw new UsageError('--icon must not exceed 32 characters')
    const id = validateDocumentId(positionals[0])
    const body = {}
    if (flags.title) body.title = validateTitle(flags.title)
    if (flags.icon) body.icon = flags.icon
    if (flags['clear-icon']) body.icon = null
    if (flags.star) body.isStar = true
    if (flags.unstar) body.isStar = false
    if (Object.keys(body).length === 0) {
      throw new UsageError('update requires at least one of --title, --icon, --clear-icon, --star, or --unstar')
    }
    operation = async (client) => {
      const result = await client.update(id, body, {
        ifMatch: flags['if-match'],
        force: flags.force,
      })
      const document = assertDocument(result.payload.data)
      const etag = assertEtag(result.etag)
      if (globalOptions.json) {
        write(stdout, JSON.stringify(singleDocumentJson(document, etag), null, 2))
      } else {
        writeDocumentText(stdout, 'updated', document, etag)
      }
    }
  }

  const credentials = await resolveApiCredentials({
    explicitUrl: globalOptions.url,
    env: processEnv,
    paths: configPaths,
    platform,
  })
  const client = createApiClient({
    baseUrl: credentials.url,
    token: credentials.token,
    fetchImpl,
    timeoutMs,
    maxResponseBytes,
  })
  await operation(client)
  return EXIT.success
}

async function projectVersion(root) {
  const project = require(`${root}/package.json`)
  return project.version
}

export async function runCli(argv, overrides = {}) {
  const stdout = overrides.stdout || process.stdout
  const stderr = overrides.stderr || process.stderr
  const stdin = overrides.stdin || process.stdin
  const cwd = overrides.cwd || process.cwd()
  const platform = overrides.platform || process.platform
  const processEnv = overrides.env || process.env
  const runner = overrides.runner || createProcessRunner(processEnv)
  const fetchImpl = overrides.fetch || fetch
  const configPaths = resolveConfigPaths(processEnv, overrides.homeDirectory)
  const readToken = overrides.readToken || (() => readSecretToken(stdin, stderr))

  try {
    const { options: globalOptions, remaining } = extractGlobalOptions(argv)
    if (remaining.length === 0 || remaining[0] === '--help' || remaining[0] === '-h') {
      write(stdout, globalHelp())
      return EXIT.success
    }
    if (remaining[0] === '--version' || remaining[0] === '-v') {
      write(stdout, CLI_VERSION)
      return EXIT.success
    }

    let command = remaining[0]
    let commandArgs = remaining.slice(1)
    if (command === 'help') {
      command = commandArgs[0]
      if (!command) {
        write(stdout, globalHelp())
        return EXIT.success
      }
      if (!commandHelp[command]) throw new UsageError(`Unknown command: ${command}`)
      write(stdout, commandHelp[command])
      return EXIT.success
    }
    if (!commandHelp[command] && command !== 'capabilities') throw new UsageError(`Unknown command: ${command}`)
    if (commandArgs.includes('--help') || commandArgs.includes('-h')) {
      write(stdout, commandHelp[command])
      return EXIT.success
    }

    if (command === 'capabilities') {
      const { positionals } = parseCommandOptions(commandArgs)
      ensureNoPositionals(positionals, command)
      if (globalOptions.json) {
        write(
          stdout,
          JSON.stringify(
            {
              schemaVersion: capabilitySchemaVersion,
              product: 'doc',
              summary: capabilitySummary(),
              groups: capabilityGroups,
            },
            null,
            2
          )
        )
      } else {
        write(stdout, formatCapabilitiesText())
      }
      return EXIT.success
    }
    if (globalOptions.json && !JSON_COMMANDS.has(command)) {
      throw new UsageError(`--json is not supported by ${command}`)
    }

    if (command === 'auth') {
      return await handleAuthCommand({
        commandArgs,
        globalOptions,
        processEnv,
        configPaths,
        readToken,
        fetchImpl,
        timeoutMs: overrides.apiTimeoutMs,
        maxResponseBytes: overrides.apiMaxResponseBytes,
        stdout,
        platform,
      })
    }

    if (REMOTE_COMMANDS.has(command)) {
      return await handleRemoteCommand({
        command,
        commandArgs,
        globalOptions,
        processEnv,
        configPaths,
        fetchImpl,
        stdout,
        cwd,
        stdin,
        timeoutMs: overrides.apiTimeoutMs,
        maxResponseBytes: overrides.apiMaxResponseBytes,
        platform,
      })
    }

    const root = await resolveProjectRoot(cwd, globalOptions.root)
    const envPath = resolveEnvPath(root, globalOptions.env_file)
    const compose = composeArgs(root, (await exists(envPath)) ? envPath : undefined)
    const controlCompose = controlComposeArgs(root)

    if (command === 'init') {
      const { flags, positionals } = parseCommandOptions(commandArgs, {
        force: 'boolean',
        yes: 'boolean',
        'dry-run': 'boolean',
      })
      ensureNoPositionals(positionals, command)
      if (flags.force && !flags.yes) throw new UsageError('--force requires --yes')
      const result = await initializeEnvironment(root, {
        envFile: globalOptions.env_file,
        force: flags.force,
        dryRun: flags['dry-run'],
      })
      if (globalOptions.json) {
        write(stdout, JSON.stringify(result, null, 2))
      } else {
        for (const path of result.created)
          write(stdout, `${result.dryRun ? 'would create' : 'created'} ${relative(root, path)}`)
        for (const path of result.overwritten) {
          write(stdout, `${result.dryRun ? 'would overwrite' : 'overwrote'} ${relative(root, path)}`)
        }
        for (const path of result.updated) {
          write(
            stdout,
            `${result.dryRun ? 'would update' : 'updated'} ${relative(root, path)} (merged missing defaults)`
          )
        }
        for (const path of result.skipped) write(stdout, `kept ${relative(root, path)} (already exists)`)
        write(stdout, result.dryRun ? 'init: dry run complete' : 'init: configuration ready')
      }
      return EXIT.success
    }

    if (command === 'doctor') {
      const { flags, positionals } = parseCommandOptions(commandArgs, { live: 'boolean' })
      ensureNoPositionals(positionals, command)
      const result = await runDoctor({
        root,
        envPath,
        runner,
        live: flags.live,
        npmExecutable: npmCommand(platform),
        fetchImpl,
        smtpProbe: overrides.smtpProbe,
        platform,
        processEnv,
        homeDir: overrides.homeDirectory,
      })
      write(stdout, globalOptions.json ? JSON.stringify(result, null, 2) : formatDoctorText(result))
      return result.ok ? EXIT.success : EXIT.failure
    }

    if (command === 'up') {
      const { flags, positionals: services } = parseCommandOptions(commandArgs, {
        build: 'boolean',
        foreground: 'boolean',
      })
      validateServices(services)
      const env = await requireRuntimeEnv(envPath, processEnv)
      // Environment readiness verdict before the first pull/build side effect (doc#28).
      const readiness = await checkDockerReadiness({
        runner,
        platform,
        homeDir: overrides.homeDirectory,
        cwd: root,
      })
      if (!readiness.ok) {
        write(stderr, `docker readiness failed: ${readiness.code}`)
        if (readiness.detail) write(stderr, readiness.detail)
        if (readiness.guidance) write(stderr, readiness.guidance)
        return EXIT.failure
      }
      const args = [...compose, 'up']
      if (!flags.foreground) args.push('-d', '--wait', '--wait-timeout', '90')
      if (flags.build) args.push('--build')
      args.push(...services)
      const result = await runner.run('docker', args, { cwd: root, env })
      return normalizedProcessExit(result)
    }

    if (command === 'down') {
      const { positionals } = parseCommandOptions(commandArgs)
      ensureNoPositionals(positionals, command)
      const result = await runner.run('docker', [...controlCompose, 'down', '--remove-orphans'], {
        cwd: root,
        env: CONTROL_COMPOSE_ENV,
      })
      return normalizedProcessExit(result)
    }

    if (command === 'status') {
      const { positionals } = parseCommandOptions(commandArgs)
      ensureNoPositionals(positionals, command)
      if (globalOptions.json) {
        const result = await runner.capture('docker', [...controlCompose, 'ps', '--format', 'json'], {
          cwd: root,
          env: CONTROL_COMPOSE_ENV,
        })
        if (result.code !== 0) {
          const exitCode = normalizedProcessExit(result)
          write(
            stderr,
            JSON.stringify({
              error: result.stderr.trim() || 'Unable to read Compose status',
              exitCode,
            })
          )
          return exitCode
        }
        write(
          stdout,
          JSON.stringify(
            {
              project: composeProjectName(root),
              services: normalizeComposeServices(parseComposePs(result.stdout)),
            },
            null,
            2
          )
        )
        return EXIT.success
      }
      const result = await runner.run('docker', [...controlCompose, 'ps'], {
        cwd: root,
        env: CONTROL_COMPOSE_ENV,
      })
      return normalizedProcessExit(result)
    }

    if (command === 'logs') {
      const { flags, positionals } = parseCommandOptions(commandArgs, {
        follow: 'boolean',
        tail: 'value',
        aliases: { '-f': '--follow' },
      })
      if (positionals.length > 1) throw new UsageError('logs accepts at most one service')
      validateServices(positionals)
      if (flags.tail && (!/^\d+$/.test(flags.tail) || Number(flags.tail) < 1 || Number(flags.tail) > 10000)) {
        throw new UsageError('--tail must be an integer between 1 and 10000')
      }
      const args = [...controlCompose, 'logs']
      if (flags.follow) args.push('--follow')
      if (flags.tail) args.push('--tail', flags.tail)
      args.push(...positionals)
      const result = await runner.run('docker', args, { cwd: root, env: CONTROL_COMPOSE_ENV })
      return normalizedProcessExit(result)
    }

    if (command === 'dev') {
      const { flags, positionals } = parseCommandOptions(commandArgs, { 'skip-infra': 'boolean' })
      ensureNoPositionals(positionals, command)
      const env = await requireRuntimeEnv(envPath, processEnv)
      assertLocalDatabase(env)
      if (!flags['skip-infra']) {
        const infrastructure = await runner.run(
          'docker',
          [...compose, 'up', '-d', '--wait', '--wait-timeout', '60', 'postgres', 'mailpit', 'collaboration'],
          { cwd: root, env }
        )
        if (infrastructure.code !== 0) {
          return normalizedProcessExit(infrastructure)
        }
        const schema = await runner.run(npmCommand(platform), ['run', 'db:push'], { cwd: root, env })
        if (schema.code !== 0) return normalizedProcessExit(schema)
      }
      const result = await runner.run(npmCommand(platform), ['run', 'dev', '--', '--port', localWebPort(env)], {
        cwd: root,
        env,
      })
      return normalizedProcessExit(result)
    }

    if (command === 'db') {
      const { positionals } = parseCommandOptions(commandArgs)
      if (positionals.length !== 1 || !['generate', 'push'].includes(positionals[0])) {
        throw new UsageError('db requires exactly one subcommand: generate or push')
      }
      let env
      if (positionals[0] === 'push') {
        env = await requireRuntimeEnv(envPath, processEnv)
        assertLocalDatabase(env)
      }
      const args = positionals[0] === 'generate' ? ['exec', '--', 'prisma', 'generate'] : ['run', 'db:push']
      const result = await runner.run(npmCommand(platform), args, { cwd: root, env })
      return normalizedProcessExit(result)
    }

    if (command === 'check') {
      const { positionals } = parseCommandOptions(commandArgs)
      ensureNoPositionals(positionals, command)
      const result = await runner.run(npmCommand(platform), ['run', 'check'], { cwd: root })
      return normalizedProcessExit(result)
    }

    if (command === 'config') {
      const { positionals } = parseCommandOptions(commandArgs)
      if (positionals.length !== 1 || positionals[0] !== 'path') {
        throw new UsageError('config currently supports exactly one subcommand: path')
      }
      write(stdout, envPath)
      return EXIT.success
    }

    if (command === 'version') {
      const { positionals } = parseCommandOptions(commandArgs)
      ensureNoPositionals(positionals, command)
      const versions = { cli: CLI_VERSION, project: await projectVersion(root), node: process.version }
      write(
        stdout,
        globalOptions.json
          ? JSON.stringify(versions, null, 2)
          : `doc CLI ${versions.cli} · project ${versions.project} · Node ${versions.node}`
      )
      return EXIT.success
    }

    throw new UsageError(`Unknown command: ${command}`)
  } catch (error) {
    if (
      error instanceof UsageError ||
      error instanceof ProjectConfigurationError ||
      error instanceof CliConfigurationError ||
      error instanceof InputError ||
      (error instanceof ApiClientError && CONFIGURATION_API_ERRORS.has(error.code)) ||
      /No doc project found|Not a doc project/.test(error.message)
    ) {
      if (argv.includes('--json')) {
        write(
          stderr,
          JSON.stringify({
            error: error.message,
            ...(error.code ? { code: error.code } : {}),
            exitCode: EXIT.usage,
          })
        )
      } else write(stderr, `error: ${compactText(error.message)}`)
      return EXIT.usage
    }
    if (argv.includes('--json')) {
      write(
        stderr,
        JSON.stringify({
          error: error.message,
          ...(error.code ? { code: error.code } : {}),
          ...(error.status ? { status: error.status } : {}),
          ...(error.requestId ? { requestId: error.requestId } : {}),
          exitCode: EXIT.failure,
        })
      )
    } else {
      write(stderr, `error: ${compactText(error.message)}`)
      if (error.requestId) write(stderr, `request id: ${compactText(error.requestId)}`)
    }
    return EXIT.failure
  }
}
