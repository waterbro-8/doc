import { streamText, convertToModelMessages, type UIMessage } from 'ai'
import { getAIInstance } from '@/lib/ai-instances'
import { sendEmail } from '@/lib/mailer'
import { getUserInfo } from '@/lib/session'
import { getTokenUsage, updateTokenUsage } from '@/lib/token-usage'
import { genErrorData, genUnAuthData } from '@/app/api/utils/gen-res-data'

export async function POST(request: Request) {
  const user = await getUserInfo()
  if (user == null || !user.id) return Response.json(genUnAuthData())
  const userId = user.id

  const tokenUsage = await getTokenUsage(userId)
  if (tokenUsage.tokensLimit <= 0) {
    return Response.json(genErrorData('Token limit exceeded'))
  }

  const { messages, max_tokens }: { messages: UIMessage[]; max_tokens?: number } = await request.json()

  if (!messages || messages.length === 0) {
    return Response.json(genErrorData('messages required'))
  }

  const instance = getAIInstance()
  if (instance == null) return Response.json(genErrorData('No AI instance available'))

  try {
    const result = streamText({
      model: instance.provider(instance.model),
      // convertToModelMessages：将 UIMessage[] 转为 LLM 可接受的 ModelMessage[]
      messages: await convertToModelMessages(messages),
      maxOutputTokens: max_tokens ?? 600,
      onFinish({ usage }) {
        updateTokenUsage(userId, tokenUsage.totalTokens, tokenUsage.tokensLimit, usage.totalTokens ?? 0)
      },
      onError({ error }) {
        instance.isError = true
        sendEmail({ subject: `AI stream error`, text: String(error) })
      },
    })

    // originalMessages 让 SDK 在流结束后正确处理完整消息历史
    return result.toUIMessageStreamResponse({
      originalMessages: messages,
      messageMetadata: ({ part }) => {
        if (part.type !== 'finish') return

        return {
          totalTokens: part.totalUsage.totalTokens,
        }
      },
    })
  } catch (err: unknown) {
    instance.isError = true
    const msg = err instanceof Error ? err.message : String(err)
    sendEmail({ subject: `AI error from provider ${instance.name}`, text: msg })
    return Response.json(genErrorData(msg))
  }
}
