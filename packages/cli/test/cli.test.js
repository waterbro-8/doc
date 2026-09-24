import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { chmod, mkdtemp, mkdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { resolveAuthConfiguration } from '../src/auth-config.js'
import { runCli } from '../src/cli.js'
import { resolveConfigPaths } from '../src/config.js'
import { readSecretToken } from '../src/input.js'
import { parseEnv } from '../src/project.js'

function outputStream() {
  let content = ''
  return {
    write(chunk) {
      content += chunk
    },
    read() {
      return content
    },
  }
}

function fakeRunner(overrides = {}) {
  const calls = []
  return {
    calls,
    async run(command, args, options) {
      calls.push({ type: 'run', command, args, options })
      return overrides.run?.(command, args, options) || { code: 0 }
    },
    async capture(command, args, options) {
      calls.push({ type: 'capture', command, args, options })
      return (
        overrides.capture?.(command, args, options) || {
          code: 0,
          stdout:
            command === 'docker'
              ? args[0] === '--version'
                ? 'Docker version 28.0.0\n'
                : 'Docker Compose v2.35.0\n'
              : '11.8.0\n',
          stderr: '',
        }
      )
    },
  }
}

async function createProject() {
  const root = await mkdtemp(join(tmpdir(), 'doc-cli-'))
  await mkdir(join(root, 'prisma'), { recursive: true })
  await mkdir(join(root, 'services', 'collaboration'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@fullstack-ai-infra/doc', version: '0.1.0' }))
  await writeFile(join(root, 'docker-compose.yml'), 'services: {}\n')
  await writeFile(join(root, 'prisma', 'schema.prisma'), 'generator client { provider = "prisma-client-js" }\n')
  await writeFile(
    join(root, '.env.example'),
    [
      'DOC_WEB_PORT=3100',
      'DOC_COLLABORATION_PORT=1234',
      'DOC_POSTGRES_PORT=5432',
      'DOC_MAILPIT_SMTP_PORT=1025',
      'DOC_MAILPIT_UI_PORT=8025',
      'DOC_MAILPIT_URL=http://localhost:8025',
      'NEXT_PUBLIC_APP_URL=http://localhost:3100',
      'AUTH_SECRET=replace-with-a-random-secret',
      'DATABASE_URL=postgresql://doc:doc@localhost:5432/doc?schema=public',
      'EMAIL_FROM=doc@example.test',
      'EMAIL_HOST=127.0.0.1',
      'EMAIL_PORT=1025',
      'EMAIL_CONTAINER_HOST=mailpit',
      'EMAIL_CONTAINER_PORT=1025',
      'EMAIL_SECURE=false',
      'COLLABORATE_EDIT_HTTP_URL=http://localhost:1234',
      'COLLABORATE_API_AUTH_KEY=replace-with-a-shared-token-key',
      'COLLABORATE_INTERNAL_API_KEY=replace-with-an-internal-service-key',
      '',
    ].join('\n')
  )
  await writeFile(
    join(root, 'services', 'collaboration', '.env.example'),
    [
      'PORT=1234',
      'DATABASE_URL=postgresql://doc:doc@localhost:5432/doc?schema=public',
      'API_AUTH_KEY=replace-with-a-shared-token-key',
      'INTERNAL_API_KEY=replace-with-an-internal-service-key',
      '',
    ].join('\n')
  )
  return realpath(root)
}

async function invoke(args, options = {}) {
  const stdout = outputStream()
  const stderr = outputStream()
  const code = await runCli(args, {
    cwd: options.cwd,
    runner: options.runner,
    fetch: options.fetch,
    smtpProbe: options.smtpProbe,
    env: options.env ?? {},
    stdin: options.stdin,
    readToken: options.readToken,
    homeDirectory: options.homeDirectory,
    apiTimeoutMs: options.apiTimeoutMs,
    apiMaxResponseBytes: options.apiMaxResponseBytes,
    platform: options.platform,
    stdout,
    stderr,
  })
  return { code, stdout: stdout.read(), stderr: stderr.read() }
}

async function createConfigHome() {
  return mkdtemp(join(tmpdir(), 'doc-cli-config-'))
}

function apiResponse(data, options = {}) {
  return new Response(JSON.stringify(data), {
    status: options.status || 200,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  })
}

function authenticatedResponse(userId = 'user-1') {
  return apiResponse({
    data: {
      authenticated: true,
      userId,
      scopes: ['documents:read', 'documents:write'],
    },
  })
}

function documentDto(overrides = {}) {
  return {
    id: 'doc-1',
    title: 'Example',
    icon: null,
    parentId: null,
    starred: false,
    deleted: false,
    access: 'owner',
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
    ...overrides,
  }
}

test('help exposes the operator command surface', async () => {
  const result = await invoke(['--help'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /\n  init\s/)
  assert.match(result.stdout, /\n  doctor\s/)
  assert.match(result.stdout, /\n  up \[service\.\.\.\]/)
})

test('capabilities emits structured JSON without a project checkout', async () => {
  const result = await invoke(['capabilities', '--json'], { cwd: tmpdir() })
  assert.equal(result.code, 0)
  const payload = JSON.parse(result.stdout)
  assert.ok(payload.summary.available > 0)
  assert.ok(payload.groups.some((group) => group.id === 'collaboration'))
  assert.ok(payload.groups.some((group) => group.id === 'operations'))
})

test('init creates private files with distinct generated secrets', async () => {
  const root = await createProject()
  const result = await invoke(['init', '--root', root], { cwd: tmpdir() })
  assert.equal(result.code, 0)

  const rootEnv = parseEnv(await readFile(join(root, '.env'), 'utf8'))
  const collaborationEnv = parseEnv(await readFile(join(root, 'services', 'collaboration', '.env'), 'utf8'))
  assert.ok(rootEnv.AUTH_SECRET.length >= 32)
  assert.ok(rootEnv.COLLABORATE_API_AUTH_KEY.length >= 32)
  assert.ok(rootEnv.COLLABORATE_INTERNAL_API_KEY.length >= 32)
  assert.notEqual(rootEnv.AUTH_SECRET, rootEnv.COLLABORATE_API_AUTH_KEY)
  assert.notEqual(rootEnv.COLLABORATE_API_AUTH_KEY, rootEnv.COLLABORATE_INTERNAL_API_KEY)
  assert.equal(collaborationEnv.API_AUTH_KEY, rootEnv.COLLABORATE_API_AUTH_KEY)
  assert.equal(collaborationEnv.INTERNAL_API_KEY, rootEnv.COLLABORATE_INTERNAL_API_KEY)
  assert.equal(rootEnv.NEXT_PUBLIC_APP_URL, 'http://localhost:3100')
  assert.equal(rootEnv.EMAIL_HOST, '127.0.0.1')
  assert.equal(rootEnv.EMAIL_PORT, '1025')
  assert.equal(rootEnv.EMAIL_FROM, 'doc@example.test')
  assert.equal((await stat(join(root, '.env'))).mode & 0o777, 0o600)
  assert.match(await readFile(join(root, '.doc', 'instance-id'), 'utf8'), /^[a-f0-9]{20}\n$/)
})

test('init is idempotent and does not overwrite by default', async () => {
  const root = await createProject()
  await invoke(['init', '--root', root], { cwd: tmpdir() })
  const before = await readFile(join(root, '.env'), 'utf8')
  const result = await invoke(['init', '--root', root], { cwd: tmpdir() })
  const after = await readFile(join(root, '.env'), 'utf8')

  assert.equal(result.code, 0)
  assert.equal(after, before)
  assert.match(result.stdout, /kept \.env/)
})

test('init requires explicit confirmation before overwrite', async () => {
  const root = await createProject()
  const result = await invoke(['init', '--force', '--root', root], { cwd: tmpdir() })
  assert.equal(result.code, 2)
  assert.match(result.stderr, /--force requires --yes/)
})

test('init repairs a placeholder root file and creates a matching service file', async () => {
  const root = await createProject()
  await writeFile(join(root, '.env'), await readFile(join(root, '.env.example'), 'utf8'))

  const result = await invoke(['init', '--root', root], { cwd: tmpdir() })

  assert.equal(result.code, 0)
  const rootEnv = parseEnv(await readFile(join(root, '.env'), 'utf8'))
  const collaborationEnv = parseEnv(await readFile(join(root, 'services', 'collaboration', '.env'), 'utf8'))
  assert.ok(rootEnv.AUTH_SECRET.length >= 32)
  assert.equal(collaborationEnv.API_AUTH_KEY, rootEnv.COLLABORATE_API_AUTH_KEY)
})

test('init repairs a placeholder service file and creates a matching root file', async () => {
  const root = await createProject()
  await writeFile(
    join(root, 'services', 'collaboration', '.env'),
    await readFile(join(root, 'services', 'collaboration', '.env.example'), 'utf8')
  )

  const result = await invoke(['init', '--root', root], { cwd: tmpdir() })

  assert.equal(result.code, 0)
  const rootEnv = parseEnv(await readFile(join(root, '.env'), 'utf8'))
  const collaborationEnv = parseEnv(await readFile(join(root, 'services', 'collaboration', '.env'), 'utf8'))
  assert.equal(collaborationEnv.INTERNAL_API_KEY, rootEnv.COLLABORATE_INTERNAL_API_KEY)
})

test('init merges missing local defaults without replacing existing values', async () => {
  const root = await createProject()
  await invoke(['init', '--root', root], { cwd: tmpdir() })
  const envPath = join(root, '.env')
  const before = parseEnv(await readFile(envPath, 'utf8'))
  const legacy = (await readFile(envPath, 'utf8'))
    .split('\n')
    .filter(
      (line) =>
        !line.startsWith('DOC_WEB_PORT=') &&
        !line.startsWith('DOC_MAILPIT_URL=') &&
        !line.startsWith('EMAIL_CONTAINER_HOST=')
    )
    .join('\n')
    .replace('NEXT_PUBLIC_APP_URL=http://localhost:3100', 'NEXT_PUBLIC_APP_URL=https://docs.example.test')
  await writeFile(envPath, legacy)

  const result = await invoke(['init', '--root', root], { cwd: tmpdir() })
  const after = parseEnv(await readFile(envPath, 'utf8'))

  assert.equal(result.code, 0)
  assert.match(result.stdout, /updated \.env \(merged missing defaults\)/)
  assert.equal(after.DOC_WEB_PORT, '3100')
  assert.equal(after.DOC_MAILPIT_URL, 'http://localhost:8025')
  assert.equal(after.EMAIL_CONTAINER_HOST, 'mailpit')
  assert.equal(after.NEXT_PUBLIC_APP_URL, 'https://docs.example.test')
  assert.equal(after.AUTH_SECRET, before.AUTH_SECRET)

  await writeFile(
    envPath,
    (await readFile(envPath, 'utf8'))
      .split('\n')
      .filter((line) => !line.startsWith('DOC_MAILPIT_URL='))
      .join('\n')
  )
  const forced = await invoke(['init', '--force', '--yes', '--root', root], { cwd: tmpdir() })
  const forcedValues = parseEnv(await readFile(envPath, 'utf8'))
  assert.equal(forced.code, 0)
  assert.equal(forcedValues.DOC_MAILPIT_URL, 'http://localhost:8025')
  assert.equal(forcedValues.NEXT_PUBLIC_APP_URL, 'https://docs.example.test')
  assert.notEqual(forcedValues.AUTH_SECRET, before.AUTH_SECRET)
})

test('init does not add local SMTP defaults to complete external authentication', async () => {
  const root = await createProject()
  await invoke(['init', '--root', root], { cwd: tmpdir() })
  const envPath = join(root, '.env')
  const withoutLocalSmtp = (await readFile(envPath, 'utf8'))
    .split('\n')
    .filter((line) => !/^EMAIL_(?:FROM|HOST|PORT|CONTAINER_HOST|CONTAINER_PORT|USERNAME|PASSWORD|SECURE)=/.test(line))
    .join('\n')
  await writeFile(envPath, `${withoutLocalSmtp}\nAUTH_GITHUB_ID=github-id\nAUTH_GITHUB_SECRET=github-secret\n`)

  const result = await invoke(['init', '--root', root], { cwd: tmpdir() })
  const after = parseEnv(await readFile(envPath, 'utf8'))

  assert.equal(result.code, 0)
  assert.equal(after.AUTH_GITHUB_ID, 'github-id')
  assert.equal(after.EMAIL_HOST, undefined)
})

test('init refuses paths outside the checkout and symbolic-link targets', async () => {
  const root = await createProject()
  const absoluteResult = await invoke(['init', '--env-file', join(tmpdir(), '.env-doc'), '--root', root], {
    cwd: tmpdir(),
  })
  assert.equal(absoluteResult.code, 2)
  assert.match(absoluteResult.stderr, /relative to the project root/)

  const outside = join(await mkdtemp(join(tmpdir(), 'doc-cli-outside-')), 'target.env')
  await writeFile(outside, 'do-not-overwrite\n')
  await symlink(outside, join(root, '.env'))
  const symlinkResult = await invoke(['init', '--force', '--yes', '--root', root], { cwd: tmpdir() })
  assert.equal(symlinkResult.code, 2)
  assert.match(symlinkResult.stderr, /must not be a symbolic link/)
  assert.equal(await readFile(outside, 'utf8'), 'do-not-overwrite\n')
})

test('forced init rotates secrets without resetting optional configuration', async () => {
  const root = await createProject()
  await invoke(['init', '--root', root], { cwd: tmpdir() })
  const envPath = join(root, '.env')
  const original = await readFile(envPath, 'utf8')
  const before = parseEnv(original)
  const customized = original
    .replace('http://localhost:3100', 'https://docs.example.com')
    .replace(`AUTH_SECRET=${before.AUTH_SECRET}`, `export AUTH_SECRET = ${before.AUTH_SECRET}`)
  await writeFile(envPath, customized)

  const result = await invoke(['init', '--force', '--yes', '--root', root], { cwd: tmpdir() })
  const after = parseEnv(await readFile(envPath, 'utf8'))

  assert.equal(result.code, 0)
  assert.equal(after.NEXT_PUBLIC_APP_URL, 'https://docs.example.com')
  assert.notEqual(after.AUTH_SECRET, before.AUTH_SECRET)
  assert.notEqual(after.COLLABORATE_API_AUTH_KEY, before.COLLABORATE_API_AUTH_KEY)
  const rotatedContent = await readFile(envPath, 'utf8')
  assert.equal(rotatedContent.match(/^AUTH_SECRET=/gm)?.length, 1)
  assert.equal(rotatedContent.includes(before.AUTH_SECRET), false)
})

test('doctor validates configuration without exposing secret values', async () => {
  const root = await createProject()
  await invoke(['init', '--root', root], { cwd: tmpdir() })
  const runner = fakeRunner()
  const result = await invoke(['doctor', '--json', '--root', root], { cwd: tmpdir(), runner })

  assert.equal(result.code, 0)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.ok, true)
  assert.equal(payload.checks.find((item) => item.id === 'env:collaboration-keys').status, 'pass')
  assert.equal(payload.checks.find((item) => item.id === 'env:auth').status, 'pass')
  assert.equal(payload.checks.find((item) => item.id === 'env:permissions').status, 'pass')
  const env = parseEnv(await readFile(join(root, '.env'), 'utf8'))
  assert.equal(result.stdout.includes(env.AUTH_SECRET), false)
  assert.equal(result.stdout.includes(env.COLLABORATE_API_AUTH_KEY), false)
})

test('doctor redacts every configured credential from Compose failures', async () => {
  const root = await createProject()
  await invoke(['init', '--root', root], { cwd: tmpdir() })
  const envPath = join(root, '.env')
  const credentials = {
    AUTH_GITHUB_SECRET: 'github-client-secret',
    EMAIL_PASSWORD: 'smtp-password',
    RESEND_API_KEY: 'resend-api-key',
  }
  await writeFile(
    envPath,
    `${await readFile(envPath, 'utf8')}AUTH_GITHUB_ID=github-id\n${Object.entries(credentials)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`
  )
  const databaseUrl = parseEnv(await readFile(envPath, 'utf8')).DATABASE_URL
  const runner = fakeRunner({
    capture(command, args) {
      if (command === 'docker' && args.includes('config')) {
        return { code: 1, stdout: '', stderr: `${Object.values(credentials).join(' ')} ${databaseUrl}` }
      }
    },
  })

  const result = await invoke(['doctor', '--json', '--root', root], { cwd: tmpdir(), runner })

  assert.equal(result.code, 1)
  for (const credential of [...Object.values(credentials), databaseUrl]) {
    assert.equal(result.stdout.includes(credential), false)
  }
  assert.match(result.stdout, /\[redacted\]/)
})

test('doctor rejects environment files readable by other users', async () => {
  const root = await createProject()
  await invoke(['init', '--root', root], { cwd: tmpdir() })
  await chmod(join(root, '.env'), 0o644)

  const result = await invoke(['doctor', '--json', '--root', root], {
    cwd: tmpdir(),
    runner: fakeRunner(),
  })
  const payload = JSON.parse(result.stdout)

  assert.equal(result.code, 1)
  assert.equal(payload.checks.find((item) => item.id === 'env:permissions').status, 'fail')
})

test('doctor fails instead of reporting healthy when no authentication path is usable', async () => {
  const root = await createProject()
  await invoke(['init', '--root', root], { cwd: tmpdir() })
  const envPath = join(root, '.env')
  const withoutAuth = (await readFile(envPath, 'utf8'))
    .replace('EMAIL_FROM=doc@example.test', 'EMAIL_FROM=')
    .replace('EMAIL_HOST=127.0.0.1', 'EMAIL_HOST=')
  await writeFile(envPath, withoutAuth)

  const result = await invoke(['doctor', '--json', '--root', root], {
    cwd: tmpdir(),
    runner: fakeRunner(),
  })
  const payload = JSON.parse(result.stdout)

  assert.equal(result.code, 1)
  assert.equal(payload.checks.find((item) => item.id === 'env:auth').status, 'fail')
})

test('doctor surfaces an unresolvable web UI import instead of reporting healthy', async () => {
  const root = await createProject()
  await invoke(['init', '--root', root], { cwd: tmpdir() })
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(
    join(root, 'src', 'uses-ui.tsx'),
    "import { Button } from '@fullstack-ai-infra/ui'\nexport default Button\n"
  )

  const broken = await invoke(['doctor', '--json', '--root', root], { cwd: tmpdir(), runner: fakeRunner() })
  const brokenPayload = JSON.parse(broken.stdout)

  assert.equal(broken.code, 1)
  const brokenGate = brokenPayload.checks.find((item) => item.id === 'web:build-deps')
  assert.equal(brokenGate.status, 'fail')
  assert.match(brokenGate.detail, /cannot be resolved/)

  const uiDir = join(root, 'node_modules', '@fullstack-ai-infra', 'ui')
  await mkdir(uiDir, { recursive: true })
  await writeFile(
    join(uiDir, 'package.json'),
    JSON.stringify({ name: '@fullstack-ai-infra/ui', version: '0.2.0', main: 'index.js' })
  )
  await writeFile(join(uiDir, 'index.js'), 'module.exports = {}\n')

  const healed = await invoke(['doctor', '--json', '--root', root], { cwd: tmpdir(), runner: fakeRunner() })
  const healedPayload = JSON.parse(healed.stdout)
  const healedGate = healedPayload.checks.find((item) => item.id === 'web:build-deps')

  assert.equal(healedGate.status, 'pass')
})

test('live doctor checks database-aware readiness endpoints', async () => {
  const root = await createProject()
  await invoke(['init', '--root', root], { cwd: tmpdir() })
  const urls = []
  const smtpCalls = []
  const result = await invoke(['doctor', '--live', '--json', '--root', root], {
    cwd: tmpdir(),
    runner: fakeRunner(),
    smtpProbe: async ({ host, port }) => {
      smtpCalls.push(`${host}:${port}`)
    },
    fetch: async (url) => {
      urls.push(url)
      return {
        ok: true,
        status: 200,
        async json() {
          if (url.endsWith('/api/auth/providers')) {
            return { nodemailer: { id: 'nodemailer', type: 'email' } }
          }
          return url.endsWith('/ready')
            ? { service: 'doc-collaboration', status: 'ok', checks: { database: 'ok' } }
            : { service: 'doc-web', status: 'ok', checks: { database: 'ok' } }
        },
      }
    },
  })

  assert.equal(result.code, 0)
  assert.deepEqual(smtpCalls, ['127.0.0.1:1025'])
  assert.deepEqual(urls, [
    'http://localhost:3100/api/health',
    'http://localhost:3100/api/auth/providers',
    'http://localhost:8025/readyz',
    'http://localhost:1234/ready',
  ])
})

test('live doctor reports SMTP and Mailpit failures independently', async () => {
  const root = await createProject()
  await invoke(['init', '--root', root], { cwd: tmpdir() })
  const fetchHealth = (mailpitOk) => async (url) => ({
    ok: !url.endsWith('/readyz') || mailpitOk,
    status: url.endsWith('/readyz') && !mailpitOk ? 503 : 200,
    async json() {
      if (url.endsWith('/api/auth/providers')) return { nodemailer: { id: 'nodemailer', type: 'email' } }
      return url.endsWith('/ready')
        ? { service: 'doc-collaboration', status: 'ok', checks: { database: 'ok' } }
        : { service: 'doc-web', status: 'ok', checks: { database: 'ok' } }
    },
  })

  const smtpFailure = await invoke(['doctor', '--live', '--json', '--root', root], {
    cwd: tmpdir(),
    runner: fakeRunner(),
    smtpProbe: async () => {
      throw new Error('connection refused')
    },
    fetch: fetchHealth(true),
  })
  const smtpPayload = JSON.parse(smtpFailure.stdout)
  assert.equal(smtpFailure.code, 1)
  assert.equal(smtpPayload.checks.find((item) => item.id === 'live:smtp').status, 'fail')
  assert.equal(smtpPayload.checks.find((item) => item.id === 'live:mailpit').status, 'pass')

  const mailpitFailure = await invoke(['doctor', '--live', '--json', '--root', root], {
    cwd: tmpdir(),
    runner: fakeRunner(),
    smtpProbe: async () => {},
    fetch: fetchHealth(false),
  })
  const mailpitPayload = JSON.parse(mailpitFailure.stdout)
  assert.equal(mailpitFailure.code, 1)
  assert.equal(mailpitPayload.checks.find((item) => item.id === 'live:smtp').status, 'pass')
  assert.equal(mailpitPayload.checks.find((item) => item.id === 'live:mailpit').status, 'fail')
})

test('doctor fails when the environment has not been initialized', async () => {
  const root = await createProject()
  const result = await invoke(['doctor', '--json', '--root', root], {
    cwd: tmpdir(),
    runner: fakeRunner(),
  })

  assert.equal(result.code, 1)
  assert.equal(JSON.parse(result.stdout).ok, false)
})

test('up uses an isolated Compose project and waits for health', async () => {
  const root = await createProject()
  await invoke(['init', '--root', root], { cwd: tmpdir() })
  const runner = fakeRunner()
  const result = await invoke(['up', '--build', '--root', root], { cwd: tmpdir(), runner })

  assert.equal(result.code, 0)
  const call = runner.calls.find((item) => item.type === 'run')
  assert.equal(call.command, 'docker')
  assert.ok(call.args.includes('--project-name'))
  assert.ok(call.args.includes('--project-directory'))
  assert.ok(call.args.includes('--build'))
  assert.ok(call.args.includes('--wait'))
  assert.equal(call.options.cwd, root)
  assert.ok(call.options.env.AUTH_SECRET)
})

test('Compose exposes parameterized loopback ports and a pinned Mailpit service', async () => {
  const compose = await readFile(new URL('../../../docker-compose.yml', import.meta.url), 'utf8')

  assert.match(compose, /axllent\/mailpit:v1\.30\.0/)
  for (const variable of [
    'DOC_WEB_PORT',
    'DOC_COLLABORATION_PORT',
    'DOC_POSTGRES_PORT',
    'DOC_MAILPIT_SMTP_PORT',
    'DOC_MAILPIT_UI_PORT',
  ]) {
    assert.match(compose, new RegExp(`127\\.0\\.0\\.1:\\$\\{${variable}`))
  }
  assert.match(compose, /EMAIL_HOST: \$\{EMAIL_CONTAINER_HOST:-\$\{EMAIL_HOST:-mailpit\}\}/)
  assert.match(compose, /EMAIL_PORT: \$\{EMAIL_CONTAINER_PORT:-\$\{EMAIL_PORT:-1025\}\}/)
  assert.match(compose, /depends_on:[\s\S]*?mailpit:\n\s+condition: service_healthy/)
})

test('down never deletes volumes and bypasses missing or malformed project environments', async () => {
  const root = await createProject()
  await writeFile(join(root, '.env'), 'BROKEN=${\n')
  const runner = fakeRunner()
  const result = await invoke(['down', '--root', root], { cwd: tmpdir(), runner })

  assert.equal(result.code, 0)
  const call = runner.calls.find((item) => item.type === 'run')
  assert.ok(call.args.includes('down'))
  assert.equal(call.args.includes('--volumes'), false)
  assert.equal(call.args.includes('-v'), false)
  const envFileIndex = call.args.indexOf('--env-file')
  assert.notEqual(envFileIndex, -1)
  assert.match(call.args[envFileIndex + 1], /packages[/\\]cli[/\\]assets[/\\]control\.env$/)
  assert.notEqual(call.args[envFileIndex + 1], join(root, '.env'))
  assert.equal(call.options.env.AUTH_SECRET, 'doc-control-command-only')
})

test('status parses newline-delimited Compose JSON', async () => {
  const root = await createProject()
  const runner = fakeRunner({
    capture() {
      return {
        code: 0,
        stdout: '{"Name":"doc-web","State":"running"}\n{"Name":"doc-postgres","State":"running"}\n',
        stderr: '',
      }
    },
  })
  const result = await invoke(['status', '--json', '--root', root], { cwd: tmpdir(), runner })

  assert.equal(result.code, 0)
  const payload = JSON.parse(result.stdout)
  assert.match(payload.project, /^doc-/)
  assert.equal(payload.services.length, 2)
  assert.deepEqual(payload.services[0], {
    name: 'doc-web',
    service: null,
    state: 'running',
    health: null,
    status: null,
  })
})

test('db push refuses non-local databases before spawning npm', async () => {
  const root = await createProject()
  await invoke(['init', '--root', root], { cwd: tmpdir() })
  const envPath = join(root, '.env')
  const content = (await readFile(envPath, 'utf8')).replace(
    'postgresql://doc:doc@localhost:5432/doc?schema=public',
    'postgresql://doc:doc@database.example.com:5432/doc'
  )
  await writeFile(envPath, content)
  const runner = fakeRunner()
  const result = await invoke(['db', 'push', '--root', root], { cwd: tmpdir(), runner })

  assert.equal(result.code, 2)
  assert.match(result.stderr, /only accept.*localhost/)
  assert.equal(
    runner.calls.some((item) => item.type === 'run'),
    false
  )
})

test('db generate does not require a runtime environment file', async () => {
  const root = await createProject()
  const runner = fakeRunner()
  const result = await invoke(['db', 'generate', '--root', root], { cwd: tmpdir(), runner })

  assert.equal(result.code, 0)
  const call = runner.calls.find((item) => item.type === 'run')
  assert.equal(call.command, 'npm')
  assert.deepEqual(call.args, ['exec', '--', 'prisma', 'generate'])
})

test('dev passes the selected environment and parameterized Web port to local processes', async () => {
  const root = await createProject()
  await invoke(['init', '--root', root], { cwd: tmpdir() })
  const runner = fakeRunner()
  const result = await invoke(['dev', '--skip-infra', '--root', root], { cwd: tmpdir(), runner })

  assert.equal(result.code, 0)
  const call = runner.calls.find((item) => item.type === 'run')
  assert.deepEqual(call.args, ['run', 'dev', '--', '--port', '3100'])
  assert.ok(call.options.env.AUTH_SECRET)
  assert.equal(call.options.env.DATABASE_URL, 'postgresql://doc:doc@localhost:5432/doc?schema=public')
})

test('dev accepts a custom Web port without editing Compose', async () => {
  const root = await createProject()
  await invoke(['init', '--root', root], { cwd: tmpdir() })
  const runner = fakeRunner()
  const result = await invoke(['dev', '--skip-infra', '--root', root], {
    cwd: tmpdir(),
    runner,
    env: { DOC_WEB_PORT: '4100' },
  })

  assert.equal(result.code, 0)
  const call = runner.calls.find((item) => item.type === 'run')
  assert.deepEqual(call.args, ['run', 'dev', '--', '--port', '4100'])
})

test('dev starts Mailpit with the other local infrastructure', async () => {
  const root = await createProject()
  await invoke(['init', '--root', root], { cwd: tmpdir() })
  const runner = fakeRunner()
  const result = await invoke(['dev', '--root', root], { cwd: tmpdir(), runner })

  assert.equal(result.code, 0)
  const infrastructure = runner.calls.find(
    (item) => item.type === 'run' && item.command === 'docker' && item.args.includes('up')
  )
  assert.ok(infrastructure.args.includes('mailpit'))
})

test('authentication paths require complete provider configuration', () => {
  assert.deepEqual(resolveAuthConfiguration({ AUTH_GITHUB_ID: 'partial' }).providerIds, [])
  assert.deepEqual(resolveAuthConfiguration({ AUTH_GITHUB_ID: 'id', AUTH_GITHUB_SECRET: 'secret' }).providerIds, [
    'github',
  ])
  assert.deepEqual(
    resolveAuthConfiguration({
      EMAIL_FROM: 'doc@example.test',
      EMAIL_HOST: '127.0.0.1',
      EMAIL_PORT: '1025',
    }).providerIds,
    ['nodemailer']
  )
  assert.deepEqual(
    resolveAuthConfiguration({ EMAIL_FROM: 'doc@example.test', RESEND_API_KEY: 'resend-key' }).providerIds,
    ['resend']
  )
})

test('dev refuses a remote database before starting infrastructure', async () => {
  const root = await createProject()
  await invoke(['init', '--root', root], { cwd: tmpdir() })
  const envPath = join(root, '.env')
  await writeFile(
    envPath,
    (await readFile(envPath, 'utf8')).replace(
      'postgresql://doc:doc@localhost:5432/doc?schema=public',
      'postgresql://doc:doc@database.example.com:5432/doc'
    )
  )
  const runner = fakeRunner()
  const result = await invoke(['dev', '--root', root], { cwd: tmpdir(), runner })

  assert.equal(result.code, 2)
  assert.match(result.stderr, /only accept.*localhost/)
  assert.equal(
    runner.calls.some((item) => item.type === 'run'),
    false
  )
})

test('shell configuration overrides the selected file consistently', async () => {
  const root = await createProject()
  await invoke(['init', '--root', root], { cwd: tmpdir() })
  const runner = fakeRunner()
  const shellEnv = {
    AUTH_SECRET: 'a'.repeat(32),
    COLLABORATE_API_AUTH_KEY: 'b'.repeat(32),
    COLLABORATE_INTERNAL_API_KEY: 'c'.repeat(32),
  }
  const result = await invoke(['up', '--root', root], {
    cwd: tmpdir(),
    runner,
    env: shellEnv,
  })

  assert.equal(result.code, 0)
  const call = runner.calls.find((item) => item.type === 'run')
  assert.equal(call.options.env.AUTH_SECRET, shellEnv.AUTH_SECRET)
  assert.equal(call.options.env.COLLABORATE_API_AUTH_KEY, shellEnv.COLLABORATE_API_AUTH_KEY)
})

test('child process failures are normalized to the public exit-code contract', async () => {
  const root = await createProject()
  const failed = await invoke(['check', '--root', root], {
    cwd: tmpdir(),
    runner: fakeRunner({ run: () => ({ code: 42 }) }),
  })
  const missing = await invoke(['check', '--root', root], {
    cwd: tmpdir(),
    runner: fakeRunner({ run: () => ({ code: 127 }) }),
  })

  assert.equal(failed.code, 1)
  assert.equal(missing.code, 5)
})

test('config path precedence follows DOC_CONFIG_HOME, XDG_CONFIG_HOME, then the user config directory', () => {
  const explicitHome = resolve(tmpdir(), 'private-doc-config')
  const xdgHome = resolve(tmpdir(), 'private-xdg')
  const userHome = resolve(tmpdir(), 'users-doc')
  assert.equal(
    resolveConfigPaths({ DOC_CONFIG_HOME: explicitHome, XDG_CONFIG_HOME: resolve(tmpdir(), 'ignored') }, userHome).file,
    join(explicitHome, 'config.json')
  )
  assert.equal(resolveConfigPaths({ XDG_CONFIG_HOME: xdgHome }, userHome).file, join(xdgHome, 'doc', 'config.json'))
  assert.equal(resolveConfigPaths({}, userHome).file, join(userHome, '.config', 'doc', 'config.json'))
  assert.throws(
    () => resolveConfigPaths({ DOC_CONFIG_HOME: '.doc-credentials' }, userHome),
    /DOC_CONFIG_HOME must be an absolute path/
  )
  assert.throws(
    () => resolveConfigPaths({ XDG_CONFIG_HOME: '.config' }, userHome),
    /XDG_CONFIG_HOME must be an absolute path/
  )
})

test('auth login reads a token outside argv and writes private atomic configuration', async () => {
  const configHome = join(await createConfigHome(), 'credentials')
  const token = 'doc_pat_login_secret'
  const result = await invoke(['auth', 'login', '--url', 'https://docs.example.com', '--json'], {
    cwd: tmpdir(),
    env: { DOC_CONFIG_HOME: configHome },
    readToken: async () => token,
    fetch: async (url) => {
      assert.equal(String(url), 'https://docs.example.com/api/v1/me')
      return authenticatedResponse()
    },
  })

  assert.equal(result.code, 0)
  assert.equal(JSON.parse(result.stdout).authenticated, true)
  assert.equal(JSON.parse(result.stdout).userId, 'user-1')
  assert.equal(result.stdout.includes(token), false)
  assert.equal(result.stderr.includes(token), false)
  assert.equal((await stat(configHome)).mode & 0o777, 0o700)
  assert.equal((await stat(join(configHome, 'config.json'))).mode & 0o777, 0o600)
  const config = JSON.parse(await readFile(join(configHome, 'config.json'), 'utf8'))
  assert.deepEqual(config, {
    schemaVersion: 1,
    url: 'https://docs.example.com',
    token,
  })
})

test('auth login verifies the token before creating or replacing saved credentials', async () => {
  const invalidToken = 'doc_pat_invalid_login'
  const absentConfigHome = join(await createConfigHome(), 'absent')
  const invalid = await invoke(['auth', 'login', '--url', 'https://docs.example.com', '--json'], {
    cwd: tmpdir(),
    env: { DOC_CONFIG_HOME: absentConfigHome },
    readToken: async () => invalidToken,
    fetch: async () =>
      apiResponse(
        {
          error: {
            code: 'invalid_token',
            message: `Invalid token ${invalidToken}`,
          },
          requestId: 'login-invalid',
        },
        { status: 401 }
      ),
  })

  assert.equal(invalid.code, 1)
  assert.equal(invalid.stdout, '')
  assert.equal(invalid.stderr.includes(invalidToken), false)
  await assert.rejects(readFile(join(absentConfigHome, 'config.json'), 'utf8'), { code: 'ENOENT' })

  const existingConfigHome = join(await createConfigHome(), 'existing')
  await invoke(['auth', 'login', '--url', 'https://old.example.com'], {
    cwd: tmpdir(),
    env: { DOC_CONFIG_HOME: existingConfigHome },
    readToken: async () => 'doc_pat_existing',
    fetch: async () => authenticatedResponse('existing-user'),
  })
  const before = await readFile(join(existingConfigHome, 'config.json'), 'utf8')
  const replacement = await invoke(['auth', 'login', '--url', 'https://new.example.com'], {
    cwd: tmpdir(),
    env: { DOC_CONFIG_HOME: existingConfigHome },
    readToken: async () => invalidToken,
    fetch: async () => apiResponse({ error: { code: 'invalid_token', message: 'Unauthorized' } }, { status: 401 }),
  })

  assert.equal(replacement.code, 1)
  assert.equal(await readFile(join(existingConfigHome, 'config.json'), 'utf8'), before)
})

test('auth login reads non-TTY stdin and never accepts a token option', async () => {
  const configHome = join(await createConfigHome(), 'credentials')
  const piped = await invoke(['auth', 'login', '--url', 'http://localhost:3000'], {
    cwd: tmpdir(),
    env: { DOC_CONFIG_HOME: configHome },
    stdin: Readable.from(['doc_pat_from_stdin\n']),
    fetch: async () => authenticatedResponse(),
  })
  assert.equal(piped.code, 0)

  const rejected = await invoke(
    ['auth', 'login', '--url', 'https://docs.example.com', '--token', 'must-not-enter-argv'],
    {
      cwd: tmpdir(),
      env: { DOC_CONFIG_HOME: join(await createConfigHome(), 'credentials') },
      readToken: async () => {
        throw new Error('should not read token')
      },
    }
  )
  assert.equal(rejected.code, 2)
  assert.match(rejected.stderr, /Unknown option: --token/)
})

test('auth login refuses plaintext credential persistence on Windows', async () => {
  let fetched = false
  const result = await invoke(['auth', 'login', '--url', 'https://docs.example.com'], {
    cwd: tmpdir(),
    platform: 'win32',
    env: { DOC_CONFIG_HOME: join(await createConfigHome(), 'credentials') },
    readToken: async () => 'doc_pat_windows',
    fetch: async () => {
      fetched = true
    },
  })

  assert.equal(result.code, 2)
  assert.match(result.stderr, /not supported on Windows/)
  assert.equal(fetched, false)
})

test('interactive token input disables echo and restores terminal raw mode', async () => {
  class FakeTty extends EventEmitter {
    isTTY = true
    isRaw = false
    rawModes = []

    setEncoding() {}

    setRawMode(value) {
      this.isRaw = value
      this.rawModes.push(value)
    }

    resume() {}

    pause() {}
  }

  const stdin = new FakeTty()
  const prompt = outputStream()
  const tokenPromise = readSecretToken(stdin, prompt)
  stdin.emit('data', 'doc_pat_hidden')
  stdin.emit('data', '\r')

  assert.equal(await tokenPromise, 'doc_pat_hidden')
  assert.deepEqual(stdin.rawModes, [true, false])
  assert.equal(prompt.read(), 'API token: \n')
  assert.equal(prompt.read().includes('doc_pat_hidden'), false)
})

test('auth status redacts tokens and logout removes only the saved token', async () => {
  const configHome = join(await createConfigHome(), 'credentials')
  const token = 'doc_pat_status_secret'
  await invoke(['auth', 'login', '--url', 'https://docs.example.com'], {
    cwd: tmpdir(),
    env: { DOC_CONFIG_HOME: configHome },
    readToken: async () => token,
    fetch: async () => authenticatedResponse(),
  })

  const statusResult = await invoke(['auth', 'status', '--json'], {
    cwd: tmpdir(),
    env: { DOC_CONFIG_HOME: configHome },
    fetch: async (url) => {
      assert.equal(String(url), 'https://docs.example.com/api/v1/me')
      return authenticatedResponse()
    },
  })
  const statusPayload = JSON.parse(statusResult.stdout)
  assert.equal(statusResult.code, 0)
  assert.equal(statusPayload.authenticated, true)
  assert.equal(statusPayload.userId, 'user-1')
  assert.deepEqual(statusPayload.scopes, ['documents:read', 'documents:write'])
  assert.equal(statusPayload.tokenSource, 'config')
  assert.equal(statusResult.stdout.includes(token), false)

  const logoutResult = await invoke(['auth', 'logout', '--json'], {
    cwd: tmpdir(),
    env: { DOC_CONFIG_HOME: configHome },
  })
  assert.equal(logoutResult.code, 0)
  assert.equal(JSON.parse(logoutResult.stdout).removed, true)
  assert.deepEqual(JSON.parse(await readFile(join(configHome, 'config.json'), 'utf8')), {
    schemaVersion: 1,
    url: 'https://docs.example.com',
  })
})

test('auth status honors complete environment credentials without reading broken saved config', async () => {
  const configHome = join(await createConfigHome(), 'credentials')
  await mkdir(configHome, { mode: 0o700 })
  await writeFile(join(configHome, 'config.json'), '{broken', { mode: 0o600 })

  const result = await invoke(['auth', 'status', '--json'], {
    cwd: tmpdir(),
    env: {
      DOC_CONFIG_HOME: configHome,
      DOC_API_URL: 'https://environment.example.com',
      DOC_API_TOKEN: 'doc_pat_environment',
    },
    fetch: async (_url, options) => {
      assert.equal(options.headers.authorization, 'Bearer doc_pat_environment')
      return authenticatedResponse()
    },
  })

  assert.equal(result.code, 0)
  assert.equal(JSON.parse(result.stdout).tokenSource, 'environment')
})

test('auth and remote commands reject symbolic links and non-private configuration', async () => {
  const parent = await createConfigHome()
  const target = join(parent, 'target')
  const linked = join(parent, 'linked')
  await mkdir(target, { mode: 0o700 })
  await symlink(target, linked)
  const symlinkResult = await invoke(['auth', 'status'], {
    cwd: tmpdir(),
    env: { DOC_CONFIG_HOME: linked },
  })
  assert.equal(symlinkResult.code, 2)
  assert.match(symlinkResult.stderr, /must not be a symbolic link/)

  const insecure = join(await createConfigHome(), 'credentials')
  await mkdir(insecure, { mode: 0o700 })
  await writeFile(
    join(insecure, 'config.json'),
    JSON.stringify({ schemaVersion: 1, url: 'https://docs.example.com', token: 'doc_pat_insecure' }),
    { mode: 0o644 }
  )
  const insecureResult = await invoke(['ls'], {
    cwd: tmpdir(),
    env: { DOC_CONFIG_HOME: insecure },
  })
  assert.equal(insecureResult.code, 2)
  assert.match(insecureResult.stderr, /mode 0600/)
})

test('remote credential precedence is explicit URL, environment URL, then saved configuration', async () => {
  const configHome = join(await createConfigHome(), 'credentials')
  await invoke(['auth', 'login', '--url', 'https://config.example.com'], {
    cwd: tmpdir(),
    env: { DOC_CONFIG_HOME: configHome },
    readToken: async () => 'doc_pat_config',
    fetch: async () => authenticatedResponse(),
  })

  const calls = []
  const result = await invoke(['ls', '--url', 'https://argument.example.com', '--json'], {
    cwd: tmpdir(),
    env: {
      DOC_CONFIG_HOME: configHome,
      DOC_API_URL: 'https://environment.example.com',
      DOC_API_TOKEN: 'doc_pat_environment',
    },
    fetch: async (url, options) => {
      calls.push({ url: String(url), options })
      return apiResponse({ data: [], meta: { nextCursor: null } })
    },
  })

  assert.equal(result.code, 0)
  assert.equal(calls[0].url, 'https://argument.example.com/api/v1/documents')
  assert.equal(calls[0].options.headers.authorization, 'Bearer doc_pat_environment')
  assert.equal(calls[0].options.redirect, 'error')
})

test('never sends a saved token to a different selected origin', async () => {
  const configHome = join(await createConfigHome(), 'credentials')
  const savedToken = 'doc_pat_saved_production'
  await invoke(['auth', 'login', '--url', 'https://production.example.com'], {
    cwd: tmpdir(),
    env: { DOC_CONFIG_HOME: configHome },
    readToken: async () => savedToken,
    fetch: async () => authenticatedResponse(),
  })

  let fetched = false
  const result = await invoke(['ls', '--url', 'https://other.example.com', '--json'], {
    cwd: tmpdir(),
    env: { DOC_CONFIG_HOME: configHome },
    fetch: async () => {
      fetched = true
    },
  })

  assert.equal(result.code, 2)
  assert.equal(fetched, false)
  assert.equal(result.stderr.includes(savedToken), false)
  assert.match(JSON.parse(result.stderr).error, /different origin/)
})

test('remote commands work outside a checkout and list encodes filters with stable JSON', async () => {
  const calls = []
  const listedDocument = documentDto({
    title: 'Design notes',
  })
  const result = await invoke(
    ['ls', '--query', 'design notes', '--starred', '--trash', '--limit', '25', '--cursor', 'next/value', '--json'],
    {
      cwd: await mkdtemp(join(tmpdir(), 'not-a-doc-checkout-')),
      env: {
        DOC_API_URL: 'http://localhost:3000',
        DOC_API_TOKEN: 'doc_pat_list',
      },
      fetch: async (url, options) => {
        calls.push({ url: String(url), options })
        return apiResponse({
          data: [listedDocument],
          meta: { nextCursor: 'page-2' },
        })
      },
    }
  )

  assert.equal(result.code, 0)
  const requestUrl = new URL(calls[0].url)
  assert.equal(requestUrl.pathname, '/api/v1/documents')
  assert.equal(requestUrl.searchParams.get('query'), 'design notes')
  assert.equal(requestUrl.searchParams.get('starred'), 'true')
  assert.equal(requestUrl.searchParams.get('trash'), 'true')
  assert.equal(requestUrl.searchParams.get('limit'), '25')
  assert.equal(requestUrl.searchParams.get('cursor'), 'next/value')
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    documents: [listedDocument],
    meta: { nextCursor: 'page-2' },
  })
})

test('remote commands require credentials and reject non-loopback plain HTTP before fetch', async () => {
  let fetched = false
  const missing = await invoke(['ls', '--json'], {
    cwd: tmpdir(),
    env: { DOC_CONFIG_HOME: join(await createConfigHome(), 'missing') },
    fetch: async () => {
      fetched = true
    },
  })
  assert.equal(missing.code, 2)
  assert.equal(fetched, false)

  const insecure = await invoke(['ls', '--url', 'http://docs.example.com', '--json'], {
    cwd: tmpdir(),
    env: { DOC_API_TOKEN: 'doc_pat_insecure_url' },
    fetch: async () => {
      fetched = true
    },
  })
  assert.equal(insecure.code, 2)
  assert.equal(JSON.parse(insecure.stderr).code, 'insecure_api_url')
  assert.equal(fetched, false)

  const pathBase = await invoke(['ls', '--url', 'https://docs.example.com/tenant', '--json'], {
    cwd: tmpdir(),
    env: { DOC_API_TOKEN: 'doc_pat_path_base' },
    fetch: async () => {
      fetched = true
    },
  })
  assert.equal(pathBase.code, 2)
  assert.equal(JSON.parse(pathBase.stderr).code, 'invalid_api_url')
})

test('get encodes document ids, reads ETag, and supports content-only output', async () => {
  const calls = []
  const fetchDocument = async (url) => {
    calls.push(String(url))
    return apiResponse(
      {
        data: {
          ...documentDto({ id: 'folder/doc' }),
          content: { type: 'doc', content: [] },
        },
      },
      { headers: { etag: '"doc:revision-1"' } }
    )
  }
  const options = {
    cwd: tmpdir(),
    env: { DOC_API_URL: 'https://docs.example.com', DOC_API_TOKEN: 'doc_pat_get' },
    fetch: fetchDocument,
  }
  const jsonResult = await invoke(['get', 'folder/doc', '--json'], options)
  assert.equal(jsonResult.code, 0)
  assert.equal(calls[0], 'https://docs.example.com/api/v1/documents/folder%2Fdoc')
  assert.equal(JSON.parse(jsonResult.stdout).etag, '"doc:revision-1"')

  const contentResult = await invoke(['get', 'folder/doc', '--content-only'], options)
  assert.deepEqual(JSON.parse(contentResult.stdout), { type: 'doc', content: [] })
})

test('human-readable document output strips terminal control sequences', async () => {
  const result = await invoke(['get', 'doc-1'], {
    cwd: tmpdir(),
    env: { DOC_API_URL: 'https://docs.example.com', DOC_API_TOKEN: 'doc_pat_terminal' },
    fetch: async () =>
      apiResponse(
        {
          data: {
            ...documentDto({
              title: 'Safe\u001b]52;c;YXR0YWNr\u0007Title',
              icon: '\u001b[31m📘\u001b[0m',
            }),
            content: { type: 'doc', content: [] },
          },
        },
        { headers: { etag: '"safe-etag"' } }
      ),
  })

  assert.equal(result.code, 0)
  assert.equal(/[\u001b\u0007]/.test(result.stdout), false)
  assert.match(result.stdout, /Safe]52;c;YXR0YWNrTitle/)
})

test('create validates TipTap input before posting the exact API body', async () => {
  const inputDirectory = await mkdtemp(join(tmpdir(), 'doc-cli-content-'))
  const contentPath = join(inputDirectory, 'content.json')
  await writeFile(contentPath, JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] }))
  const calls = []
  const result = await invoke(
    ['create', '--title', 'Agent doc', '--parent', 'parent-1', '--content-file', contentPath, '--json'],
    {
      cwd: tmpdir(),
      env: { DOC_API_URL: 'https://docs.example.com', DOC_API_TOKEN: 'doc_pat_create' },
      fetch: async (url, options) => {
        calls.push({ url: String(url), options })
        return apiResponse(
          {
            data: {
              ...documentDto({
                id: 'created-1',
                title: 'Agent doc',
                parentId: 'parent-1',
              }),
              content: { type: 'doc', content: [{ type: 'paragraph' }] },
            },
          },
          { status: 201, headers: { etag: '"created-1"' } }
        )
      },
    }
  )

  assert.equal(result.code, 0)
  assert.equal(calls[0].options.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    title: 'Agent doc',
    parentId: 'parent-1',
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  })

  const invalid = await invoke(['create', '--title', 'Invalid', '--content-file', '-'], {
    cwd: tmpdir(),
    env: { DOC_API_URL: 'https://docs.example.com', DOC_API_TOKEN: 'doc_pat_create' },
    stdin: Readable.from(['{"type":"paragraph"}']),
    fetch: async () => {
      throw new Error('must not fetch')
    },
  })
  assert.equal(invalid.code, 2)
  assert.match(invalid.stderr, /TipTap document object/)

  const oversizedPath = join(inputDirectory, 'oversized.json')
  await writeFile(
    oversizedPath,
    JSON.stringify({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(1_000_000) }] }],
    })
  )
  const oversized = await invoke(['create', '--title', 'Too large', '--content-file', oversizedPath], {
    cwd: tmpdir(),
    env: { DOC_API_URL: 'https://docs.example.com', DOC_API_TOKEN: 'doc_pat_create' },
    fetch: async () => {
      throw new Error('must not fetch')
    },
  })
  assert.equal(oversized.code, 2)
  assert.match(oversized.stderr, /exceeds 1000000 bytes/)
})

test('create converts markdown files and rejects raw HTML', async () => {
  const inputDirectory = await mkdtemp(join(tmpdir(), 'doc-cli-md-'))
  const markdownPath = join(inputDirectory, 'notes.md')
  await writeFile(markdownPath, '# Runbook\n\nFirst response steps.\n')
  const calls = []
  const result = await invoke(
    ['create', '--title', 'Runbook', '--markdown-file', markdownPath, '--json'],
    {
      cwd: tmpdir(),
      env: { DOC_API_URL: 'https://docs.example.com', DOC_API_TOKEN: 'doc_pat_md' },
      fetch: async (url, options) => {
        calls.push({ url: String(url), options })
        const body = JSON.parse(options.body)
        return apiResponse(
          {
            data: {
              ...documentDto({ id: 'md-1', title: 'Runbook' }),
              content: body.content,
            },
          },
          { status: 201, headers: { etag: '"md-1"' } }
        )
      },
    }
  )
  assert.equal(result.code, 0)
  const posted = JSON.parse(calls[0].options.body)
  assert.equal(posted.content.type, 'doc')
  assert.equal(posted.content.content[0].type, 'heading')

  const html = await invoke(['create', '--title', 'Bad', '--markdown-file', '-'], {
    cwd: tmpdir(),
    env: { DOC_API_URL: 'https://docs.example.com', DOC_API_TOKEN: 'doc_pat_md' },
    stdin: Readable.from(['<div>nope</div>']),
    fetch: async () => {
      throw new Error('must not fetch')
    },
  })
  assert.equal(html.code, 2)
  assert.match(html.stderr, /Raw HTML/)
})

test('versions lists and gets document history', async () => {
  const listed = await invoke(['versions', 'doc-1', '--json'], {
    cwd: tmpdir(),
    env: { DOC_API_URL: 'https://docs.example.com', DOC_API_TOKEN: 'doc_pat_ver' },
    fetch: async (url) => {
      assert.match(String(url), /\/api\/v1\/documents\/doc-1\/versions$/)
      return apiResponse({
        data: [{ id: 'v1', title: 'Runbook', authorId: 'user-1', kind: 'snapshot', createdAt: '2026-09-24T00:00:00.000Z' }],
        meta: { nextCursor: null },
      })
    },
  })
  assert.equal(listed.code, 0)
  assert.equal(JSON.parse(listed.stdout).versions[0].id, 'v1')

  const got = await invoke(['versions', 'get', 'doc-1', 'v1', '--json'], {
    cwd: tmpdir(),
    env: { DOC_API_URL: 'https://docs.example.com', DOC_API_TOKEN: 'doc_pat_ver' },
    fetch: async (url) => {
      assert.match(String(url), /\/api\/v1\/documents\/doc-1\/versions\/v1$/)
      return apiResponse({
        data: {
          id: 'v1',
          title: 'Runbook',
          authorId: 'user-1',
          kind: 'snapshot',
          createdAt: '2026-09-24T00:00:00.000Z',
          content: { type: 'doc', content: [] },
        },
      })
    },
  })
  assert.equal(got.code, 0)
  assert.equal(JSON.parse(got.stdout).version.id, 'v1')
})

test('update validates changes and sends metadata with an ETag precondition', async () => {
  const calls = []
  const options = {
    cwd: tmpdir(),
    env: { DOC_API_URL: 'https://docs.example.com', DOC_API_TOKEN: 'doc_pat_update' },
    fetch: async (url, fetchOptions) => {
      calls.push({ url: String(url), options: fetchOptions })
      return apiResponse(
        { data: documentDto({ title: 'Renamed', starred: true }) },
        { headers: { etag: '"revision-2"' } }
      )
    },
  }
  const result = await invoke(
    ['update', 'doc-1', '--title', 'Renamed', '--clear-icon', '--star', '--if-match', '"revision-1"', '--json'],
    options
  )

  assert.equal(result.code, 0)
  assert.equal(calls[0].options.method, 'PATCH')
  assert.equal(calls[0].options.headers['if-match'], '"revision-1"')
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    title: 'Renamed',
    icon: null,
    isStar: true,
  })

  const forced = await invoke(['update', 'doc-1', '--unstar', '--force'], options)
  assert.equal(forced.code, 0)
  assert.equal(calls[1].options.headers['if-match'], '*')
  assert.match(forced.stdout, /etag: "revision-2"/)

  const noChanges = await invoke(['update', 'doc-1', '--force'], options)
  assert.equal(noChanges.code, 2)
  const conflicting = await invoke(['update', 'doc-1', '--star', '--unstar'], options)
  assert.equal(conflicting.code, 2)
  const noPrecondition = await invoke(['update', 'doc-1', '--star'], options)
  assert.equal(noPrecondition.code, 2)
  assert.equal(calls.length, 2)
})

test('document commands reject incomplete API envelopes and missing ETags', async () => {
  const baseOptions = {
    cwd: tmpdir(),
    env: { DOC_API_URL: 'https://docs.example.com', DOC_API_TOKEN: 'doc_pat_contract' },
  }

  const badMeta = await invoke(['ls', '--json'], {
    ...baseOptions,
    fetch: async () => apiResponse({ data: [documentDto()], meta: 'not-an-object' }),
  })
  assert.equal(badMeta.code, 1)
  assert.equal(JSON.parse(badMeta.stderr).code, 'invalid_api_response')

  const missingContent = await invoke(['get', 'doc-1', '--json'], {
    ...baseOptions,
    fetch: async () => apiResponse({ data: documentDto() }, { headers: { etag: '"revision-1"' } }),
  })
  assert.equal(missingContent.code, 1)
  assert.equal(JSON.parse(missingContent.stderr).code, 'invalid_api_response')

  const missingEtag = await invoke(['get', 'doc-1', '--json'], {
    ...baseOptions,
    fetch: async () =>
      apiResponse({
        data: {
          ...documentDto(),
          content: { type: 'doc', content: [] },
        },
      }),
  })
  assert.equal(missingEtag.code, 1)
  assert.equal(JSON.parse(missingEtag.stderr).code, 'invalid_api_response')
})

test('API errors, malformed responses, size limits, and timeouts are stable and redact tokens', async () => {
  const token = 'doc_pat_never_print_this'
  const baseOptions = {
    cwd: tmpdir(),
    env: { DOC_API_URL: 'https://docs.example.com', DOC_API_TOKEN: token },
  }
  const unauthorized = await invoke(['ls', '--json'], {
    ...baseOptions,
    fetch: async () =>
      apiResponse(
        {
          error: { code: 'invalid_token', message: `Invalid token ${token}` },
          requestId: 'request-1',
        },
        { status: 401 }
      ),
  })
  assert.equal(unauthorized.code, 1)
  assert.deepEqual(JSON.parse(unauthorized.stderr), {
    error: 'Invalid token [redacted]',
    code: 'invalid_token',
    status: 401,
    requestId: 'request-1',
    exitCode: 1,
  })
  assert.equal(unauthorized.stderr.includes(token), false)

  const splitToken = `${token.slice(0, 12)}\u001b${token.slice(12)}`
  const splitTokenPayload = {
    error: {
      code: `failed_${splitToken}`,
      message: `failed ${splitToken}`,
    },
    requestId: `request-${splitToken}`,
  }
  const splitTokenHuman = await invoke(['ls'], {
    ...baseOptions,
    fetch: async () => apiResponse(splitTokenPayload, { status: 500 }),
  })
  assert.equal(splitTokenHuman.code, 1)
  assert.equal(splitTokenHuman.stderr.includes(token), false)
  assert.doesNotMatch(splitTokenHuman.stderr, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/)
  assert.match(splitTokenHuman.stderr, /error: failed \[redacted\]/)
  assert.match(splitTokenHuman.stderr, /request id: request-\[redacted\]/)

  const splitTokenJson = await invoke(['ls', '--json'], {
    ...baseOptions,
    fetch: async () => apiResponse(splitTokenPayload, { status: 500 }),
  })
  assert.equal(splitTokenJson.code, 1)
  assert.equal(splitTokenJson.stderr.includes(token), false)
  assert.deepEqual(JSON.parse(splitTokenJson.stderr), {
    error: 'failed [redacted]',
    code: 'failed_[redacted]',
    status: 500,
    requestId: 'request-[redacted]',
    exitCode: 1,
  })

  const terminalInjection = await invoke(['ls'], {
    ...baseOptions,
    fetch: async () =>
      apiResponse(
        {
          error: {
            code: 'server_error',
            message: `failure\u001b]52;c;Y2xpcGJvYXJk\u0007\u202eevil`,
          },
          requestId: `request\u001b[31m-red\u001b[0m\u2066`,
        },
        { status: 500 }
      ),
  })
  assert.equal(terminalInjection.code, 1)
  assert.doesNotMatch(terminalInjection.stderr, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/)
  assert.match(terminalInjection.stderr, /error: failure\]52;c;Y2xpcGJvYXJkevil/)
  assert.match(terminalInjection.stderr, /request id: request\[31m-red\[0m/)

  const malformed = await invoke(['ls', '--json'], {
    ...baseOptions,
    fetch: async () => new Response('not json', { status: 200 }),
  })
  assert.equal(malformed.code, 1)
  assert.equal(JSON.parse(malformed.stderr).code, 'invalid_api_response')

  const oversized = await invoke(['ls', '--json'], {
    ...baseOptions,
    apiMaxResponseBytes: 8,
    fetch: async () => apiResponse({ data: [] }),
  })
  assert.equal(oversized.code, 1)
  assert.equal(JSON.parse(oversized.stderr).code, 'response_too_large')

  const timedOut = await invoke(['ls', '--json'], {
    ...baseOptions,
    apiTimeoutMs: 5,
    fetch: async (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      }),
  })
  assert.equal(timedOut.code, 1)
  assert.equal(JSON.parse(timedOut.stderr).code, 'api_timeout')
})
