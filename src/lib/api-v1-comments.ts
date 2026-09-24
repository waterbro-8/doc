import 'server-only'

import { z } from 'zod'
import { db } from '@/db/db'
import { ApiV1Error } from '@/lib/api-v1'
import { DOCUMENT_ACCESS, getDocumentAccess } from '@/lib/document-access'

const MAX_COMMENT_BODY = 4000
const MAX_COMMENTS_PAGE = 100

const createCommentSchema = z
  .object({
    body: z
      .string()
      .trim()
      .min(1)
      .max(MAX_COMMENT_BODY)
      .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Control characters are not allowed'),
    anchor: z
      .object({
        from: z.number().int().nonnegative().optional(),
        to: z.number().int().nonnegative().optional(),
        blockId: z.string().min(1).max(200).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

export function parseCreateComment(value: unknown) {
  const parsed = createCommentSchema.safeParse(value)
  if (!parsed.success) {
    throw new ApiV1Error(422, 'validation_error', parsed.error.issues[0]?.message || 'Comment payload is invalid')
  }
  return parsed.data
}

function toCommentDto(comment: {
  id: string
  docId: string
  userId: string
  body: string
  anchor: unknown
  resolvedAt: Date | null
  createdAt: Date
}) {
  return {
    id: comment.id,
    docId: comment.docId,
    authorId: comment.userId,
    body: comment.body,
    anchor: comment.anchor,
    resolvedAt: comment.resolvedAt?.toISOString() ?? null,
    createdAt: comment.createdAt.toISOString(),
  }
}

async function requireCommentAccess(docId: string, userId: string, write: boolean) {
  const access = await getDocumentAccess(docId, userId)
  if (access === DOCUMENT_ACCESS.NONE) {
    throw new ApiV1Error(404, 'document_not_found', 'Document not found')
  }
  if (write && access !== DOCUMENT_ACCESS.OWNER && access !== DOCUMENT_ACCESS.WRITE) {
    throw new ApiV1Error(404, 'document_not_found', 'Document not found')
  }
}

export async function listDocumentComments(userId: string, docId: string, includeResolved = false) {
  await requireCommentAccess(docId, userId, false)
  const comments = await db.docComment.findMany({
    where: {
      docId,
      ...(includeResolved ? {} : { resolvedAt: null }),
    },
    orderBy: { createdAt: 'desc' },
    take: MAX_COMMENTS_PAGE,
  })
  return comments.map(toCommentDto)
}

export async function createDocumentComment(
  userId: string,
  docId: string,
  input: ReturnType<typeof parseCreateComment>
) {
  await requireCommentAccess(docId, userId, true)
  const comment = await db.docComment.create({
    data: {
      docId,
      userId,
      body: input.body,
      anchor: input.anchor ?? undefined,
    },
  })
  return toCommentDto(comment)
}

export async function resolveDocumentComment(userId: string, docId: string, commentId: string) {
  await requireCommentAccess(docId, userId, true)
  const existing = await db.docComment.findFirst({
    where: { id: commentId, docId },
  })
  if (!existing) throw new ApiV1Error(404, 'comment_not_found', 'Comment not found')
  const comment = await db.docComment.update({
    where: { id: existing.id },
    data: { resolvedAt: existing.resolvedAt ?? new Date() },
  })
  return toCommentDto(comment)
}
