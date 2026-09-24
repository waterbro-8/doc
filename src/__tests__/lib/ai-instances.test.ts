import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/mailer', () => ({ sendEmail: vi.fn() }))
vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: vi.fn((options: { name: string; apiKey: string; baseURL: string }) => {
    return () => ({ name: options.name, baseURL: options.baseURL, hasKey: Boolean(options.apiKey) })
  }),
}))

import { getAIInstance, resetAIInstancesForTests } from '@/lib/ai-instances'

describe('getAIInstance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns null when no provider is configured', () => {
    resetAIInstancesForTests({} as NodeJS.ProcessEnv)
    expect(getAIInstance()).toBeNull()
  })

  it('uses the generic OpenAI-compatible endpoint when configured', () => {
    resetAIInstancesForTests({
      DOC_AI_BASE_URL: 'https://llm.example/v1',
      DOC_AI_API_KEY: 'sk-test',
      DOC_AI_MODEL: 'demo-model',
      DOC_AI_NAME: 'demo',
    } as NodeJS.ProcessEnv)
    const instance = getAIInstance()
    expect(instance?.name).toBe('demo')
    expect(instance?.model).toBe('demo-model')
  })

  it('keeps DeepSeek when only that preset key is set', () => {
    resetAIInstancesForTests({
      DEEP_SEEK_API_KEY: 'sk-deepseek',
    } as NodeJS.ProcessEnv)
    expect(getAIInstance()?.name).toBe('deepseek')
  })
})
