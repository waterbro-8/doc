import 'server-only'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { sendEmail } from '@/lib/mailer'

export interface AIInstance {
  name: string
  provider: ReturnType<typeof createOpenAICompatible>
  model: string
  isError: boolean
}

interface ProviderPreset {
  name: string
  apiKey: string
  baseURL: string
  model: string
}

function configuredSecret(value: string | undefined) {
  const trimmed = value?.trim() || ''
  return trimmed && !trimmed.startsWith('replace-with-') ? trimmed : ''
}

function readPresets(env: NodeJS.ProcessEnv = process.env): ProviderPreset[] {
  const presets: ProviderPreset[] = []
  const genericKey = configuredSecret(env.DOC_AI_API_KEY)
  const genericBase = env.DOC_AI_BASE_URL?.trim() || ''
  if (genericKey && genericBase) {
    presets.push({
      name: env.DOC_AI_NAME?.trim() || 'openai-compatible',
      apiKey: genericKey,
      baseURL: genericBase,
      model: env.DOC_AI_MODEL?.trim() || 'gpt-4o-mini',
    })
  }

  const deepseek = configuredSecret(env.DEEP_SEEK_API_KEY)
  if (deepseek) {
    presets.push({
      name: 'deepseek',
      apiKey: deepseek,
      baseURL: 'https://api.deepseek.com',
      model: 'deepseek-chat',
    })
  }

  const deepbricks = configuredSecret(env.DEEP_BRICKS_API_KEY)
  if (deepbricks) {
    presets.push({
      name: 'deepbricks',
      apiKey: deepbricks,
      baseURL: 'https://api.deepbricks.ai/v1/',
      model: 'gpt-3.5-turbo',
    })
  }

  return presets
}

function toInstance(preset: ProviderPreset): AIInstance {
  return {
    name: preset.name,
    provider: createOpenAICompatible({
      name: preset.name,
      apiKey: preset.apiKey,
      baseURL: preset.baseURL,
      includeUsage: true,
    }),
    model: preset.model,
    isError: false,
  }
}

let instanceList: AIInstance[] = readPresets().map(toInstance)
let index = 0

export function resetAIInstancesForTests(env?: NodeJS.ProcessEnv) {
  instanceList = readPresets(env || process.env).map(toInstance)
  index = 0
}

export function getAIInstance(): AIInstance | null {
  const total = instanceList.length
  if (total === 0) return null
  for (let i = 0; i < total; i++) {
    const candidate = instanceList[index % total]
    index++
    if (!candidate.isError) return candidate
  }
  instanceList.forEach((ins) => {
    ins.isError = false
  })
  sendEmail({ subject: 'All AI instances failed', text: 'Reset all configured providers.' })
  index = 0
  return instanceList[0] ?? null
}
