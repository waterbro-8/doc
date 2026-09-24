import { z } from 'zod'
import { getUserInfo } from '@/lib/session'
import { db } from '@/db/db'
import { genSuccessData, genErrorData, genUnAuthData } from '../../utils/gen-res-data'
import { sendEmail } from '@/lib/mailer'
import { MAX_SHARE_COUNT } from '@/constants'
import { DOCUMENT_ACCESS, getDocumentAccess } from '@/lib/document-access'
import { readJsonBody } from '@/lib/read-json-body'
import { notifyCollaborationAccessRevoked } from '@/lib/collaboration-access'

const MAX_SHARE_REQUEST_BYTES = 16 * 1024
const DUPLICATE_SHARE_MESSAGE = 'Document is already shared with this user'

function isUniqueConstraintError(error: unknown) {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'P2002'
  )
}

const MAX_SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1000

const createShareRelationSchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    access: z.enum(['READ', 'WRITE']),
    docId: z.string().min(1),
    expiresAt: z.string().min(1).optional(),
  })
  .strict()

function parseShareExpiry(value: string | undefined, now = new Date()) {
  if (value == null) return null
  const expiry = new Date(value)
  if (Number.isNaN(expiry.getTime())) {
    throw new Error('invalid-expiry')
  }
  if (expiry.getTime() <= now.getTime()) {
    throw new Error('past-expiry')
  }
  if (expiry.getTime() - now.getTime() > MAX_SHARE_TTL_MS) {
    throw new Error('ttl-expiry')
  }
  return expiry
}

const deleteShareRelationSchema = z
  .object({
    id: z.string().min(1),
  })
  .strict()

const acknowledgeShareRelationSchema = z
  .object({
    id: z.string().min(1),
    noticeType: z.literal('NONE'),
  })
  .strict()

const extendShareRelationSchema = z
  .object({
    id: z.string().min(1),
    expiresAt: z.string().min(1),
  })
  .strict()

// create doc share relation
export async function POST(request: Request) {
  const user = await getUserInfo()
  if (user == null) return Response.json(genUnAuthData())

  const parsed = createShareRelationSchema.safeParse(
    await readJsonBody(request, MAX_SHARE_REQUEST_BYTES).catch(() => null)
  )
  if (!parsed.success) return Response.json(genErrorData('Share payload invalid'))
  const { email, access, docId } = parsed.data
  let expiresAt: Date | null = null
  try {
    expiresAt = parseShareExpiry(parsed.data.expiresAt)
  } catch {
    return Response.json(genErrorData('Share payload invalid'))
  }

  const documentAccess = await getDocumentAccess(docId, user.id || '')
  if (documentAccess !== DOCUMENT_ACCESS.OWNER) {
    return Response.json(genErrorData('Doc not found'))
  }

  const [doc, userByEmail] = await Promise.all([
    db.doc.findFirst({
      where: { id: docId, userId: user.id, isDeleted: false },
      select: { id: true, title: true },
    }),
    db.user.findUnique({
      where: { email },
      select: { id: true, name: true, email: true },
    }),
  ])
  if (doc == null) return Response.json(genErrorData('Doc not found'))
  if (userByEmail == null) return Response.json(genErrorData('User not found by email 根据邮箱未找到用户'))
  if (userByEmail.id === user.id) {
    return Response.json(genErrorData('You cannot share a document with yourself'))
  }

  const [existingRelation, shareCount] = await Promise.all([
    db.shareRelation.findFirst({
      where: { docId, userId: userByEmail.id },
      select: { id: true },
    }),
    db.shareRelation.count({ where: { docId } }),
  ])
  if (existingRelation != null) {
    return Response.json(genErrorData(DUPLICATE_SHARE_MESSAGE))
  }
  if (shareCount >= MAX_SHARE_COUNT) {
    return Response.json(genErrorData(`You only can share a document with up to ${MAX_SHARE_COUNT} users`))
  }

  try {
    const shareRelation = await db.shareRelation.create({
      data: {
        docId,
        authorId: user.id as string,
        userId: userByEmail.id,
        access,
        noticeType: 'NEW',
        expiresAt,
      },
    })

    void sendEmail({
      subject: `doc: "${user.name || user.email}" 分享给你一篇文档 / shared a document with you`,
      text: `Document "${doc.title}" is available at ${process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin}.`,
      toEmail: userByEmail.email || undefined,
    }).catch((error) => {
      console.error('Send document share email error', error)
    })

    return Response.json(genSuccessData({ shareRelation, userName: userByEmail.name }))
  } catch (err) {
    // The schema constraint is the source of truth when two requests pass the optimistic
    // existence check concurrently.
    if (isUniqueConstraintError(err)) {
      return Response.json(genErrorData(DUPLICATE_SHARE_MESSAGE))
    }
    console.log('Create share relation error ', err)
    return Response.json(genErrorData('Something went wrong, try again please.'))
  }
}

// delete share relation
export async function DELETE(request: Request) {
  const user = await getUserInfo()
  if (user == null) return Response.json(genUnAuthData())

  const parsed = deleteShareRelationSchema.safeParse(
    await readJsonBody(request, MAX_SHARE_REQUEST_BYTES).catch(() => null)
  )
  if (!parsed.success) return Response.json(genErrorData('Delete share payload invalid'))

  const relation = await db.shareRelation.findFirst({
    where: {
      id: parsed.data.id,
      doc: {
        userId: user.id,
      },
    },
    select: {
      id: true,
      docId: true,
      userId: true,
      doc: {
        select: { title: true },
      },
      user: {
        select: { email: true },
      },
    },
  })
  if (relation == null) {
    return Response.json(genErrorData('Share relation not found'))
  }

  try {
    // Delete by the grant identity rather than one row ID so old db-push installations cannot
    // retain access through a duplicate relation.
    await db.shareRelation.deleteMany({
      where: {
        docId: relation.docId,
        userId: relation.userId,
      },
    })

    // This eagerly closes matching sockets. The collaboration service also rechecks persisted
    // access before each message, so revocation remains fail-closed when notification is down.
    await notifyCollaborationAccessRevoked(relation.docId, relation.userId)

    void sendEmail({
      subject: `doc: "${user.name || user.email}" 取消了文档分享 / canceled a document share`,
      text: `Document "${relation.doc.title}" is no longer shared with you.`,
      toEmail: relation.user.email || undefined,
    }).catch((error) => {
      console.error('Send share cancellation email error', error)
    })

    return Response.json(genSuccessData())
  } catch (err) {
    console.log('Delete share relation error ', err)
    return Response.json(genErrorData('Something went wrong, try again please.'))
  }
}

export async function PATCH(request: Request) {
  const user = await getUserInfo()
  if (user == null) return Response.json(genUnAuthData())

  const body = await readJsonBody(request, MAX_SHARE_REQUEST_BYTES).catch(() => null)
  const acknowledged = acknowledgeShareRelationSchema.safeParse(body)
  if (acknowledged.success) {
    try {
      const result = await db.shareRelation.updateMany({
        where: {
          id: acknowledged.data.id,
          userId: user.id,
        },
        data: {
          noticeType: acknowledged.data.noticeType,
        },
      })
      if (result.count !== 1) {
        return Response.json(genErrorData('Share relation not found'))
      }
      return Response.json(genSuccessData())
    } catch (err) {
      console.log('Update share relation error ', err)
      return Response.json(genErrorData('Something went wrong, try again please.'))
    }
  }

  const extended = extendShareRelationSchema.safeParse(body)
  if (!extended.success) return Response.json(genErrorData('Update share payload invalid'))
  let expiresAt: Date | null = null
  try {
    expiresAt = parseShareExpiry(extended.data.expiresAt)
  } catch {
    return Response.json(genErrorData('Share payload invalid'))
  }

  try {
    const result = await db.shareRelation.updateMany({
      where: {
        id: extended.data.id,
        authorId: user.id,
        doc: { userId: user.id },
      },
      data: { expiresAt },
    })
    if (result.count !== 1) {
      return Response.json(genErrorData('Share relation not found'))
    }
    return Response.json(genSuccessData({ expiresAt }))
  } catch (err) {
    console.log('Extend share relation error ', err)
    return Response.json(genErrorData('Something went wrong, try again please.'))
  }
}
