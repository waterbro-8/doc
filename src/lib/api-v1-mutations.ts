import 'server-only'

import { createHash, randomUUID } from 'node:crypto'
import { db } from '@/db/db'
import { ApiV1Error } from '@/lib/api-v1'
import { encodeTiptapDocument } from '@/lib/tiptap-codec'
import { z } from 'zod'

// --- Schemas ---

export const mutateContentSchema = z
  .object({
    content: z.record(z.unknown()),
    baseVersion: z.string().min(1).max(200),
    idempotencyKey: z.string().min(1).max(128).optional(),
  })
  .strict()

export const restoreVersionSchema = z
  .object({
    versionId: z.string().min(1),
    idempotencyKey: z.string().min(1).max(128).optional(),
  })
  .strict()

// --- Types ---

export interface MutationResult {
  documentId: string
  versionId: string
  etag: string
  operationId: string
}

export interface RestoreResult {
  documentId: string
  restoredVersionId: string
  recoverySnapshotId: string
  operationId: string
  title: string
}

export interface MutationDeps {
  callCollabMutate?: (docId: string, contentBinaryBase64: string) => Promise<void>
  callCollabRestore?: (docId: string, contentBinaryBase64: string) => Promise<void>
}

// --- Helpers ---

function computeDocEtag(docId: string, updatedAt: Date): string {
  const revision = createHash('sha256').update(`${docId}:${updatedAt.toISOString()}`).digest('base64url').slice(0, 24)
  return `"doc:${docId}:${revision}"`
}

async function callCollabMutateDefault(docId: string, contentBinaryBase64: string): Promise<void> {
  const baseUrl = process.env.COLLABORATE_EDIT_HTTP_URL || ''
  const internalKey = process.env.COLLABORATE_INTERNAL_API_KEY || ''
  if (!baseUrl) throw new Error('COLLABORATE_EDIT_HTTP_URL required')
  if (!internalKey) throw new Error('COLLABORATE_INTERNAL_API_KEY required')

  const res = await fetch(`${baseUrl}/collab/documents/${docId}/restore`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-doc-internal-key': internalKey,
    },
    body: JSON.stringify({ contentBinaryBase64 }),
  })

  const data = await res.json()
  if (!res.ok || data.success === false) {
    throw new Error(data.msg || 'collaboration mutation failed')
  }
}

// --- Idempotency ---

const recentOperations = new Map<string, { result: MutationResult | RestoreResult; expiresAt: number }>()
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000

function getIdempotentResult(key: string): MutationResult | RestoreResult | null {
  const entry = recentOperations.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    recentOperations.delete(key)
    return null
  }
  return entry.result
}

function setIdempotentResult(key: string, result: MutationResult | RestoreResult): void {
  recentOperations.set(key, { result, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS })
}

// Cleanup expired entries periodically
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of recentOperations) {
      if (now > entry.expiresAt) recentOperations.delete(key)
    }
  }, 60_000).unref?.()
}

// --- Parse ---

export function parseMutateContent(value: unknown) {
  const parsed = mutateContentSchema.safeParse(value)
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message || 'Invalid mutation payload'
    throw new ApiV1Error(422, 'validation_error', message)
  }
  return parsed.data
}

export function parseRestoreVersion(value: unknown) {
  const parsed = restoreVersionSchema.safeParse(value)
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message || 'Invalid restore payload'
    throw new ApiV1Error(422, 'validation_error', message)
  }
  return parsed.data
}

// --- Content mutation ---

export async function mutateDocumentContent(
  userId: string,
  docId: string,
  input: { content: Record<string, unknown>; baseVersion: string; idempotencyKey?: string },
  deps: MutationDeps = {}
): Promise<MutationResult> {
  const idempotencyKey = input.idempotencyKey ? `mutate:${userId}:${docId}:${input.idempotencyKey}` : null

  if (idempotencyKey) {
    const existing = getIdempotentResult(idempotencyKey)
    if (existing && 'etag' in existing) return existing
  }

  // Verify ownership and base version
  const doc = await db.doc.findFirst({
    where: { id: docId, userId, isDeleted: false },
    select: { id: true, title: true, content: true, contentBinary: true, updatedAt: true },
  })
  if (!doc) throw new ApiV1Error(404, 'document_not_found', 'Document not found')

  const currentEtag = computeDocEtag(docId, doc.updatedAt)
  if (input.baseVersion !== '*' && input.baseVersion !== currentEtag) {
    throw new ApiV1Error(409, 'version_conflict', 'Document has been modified since the specified base version')
  }

  // Encode the new content through Tiptap validation
  const encoded = encodeTiptapDocument(input.content)

  // Create a version snapshot of current state before mutation
  const snapshot = await db.docVersion.create({
    data: {
      docId,
      userId,
      title: doc.title,
      content: doc.content,
      contentBinary: doc.contentBinary || Buffer.from(''),
    },
    select: { id: true },
  })

  // Send mutation through the collaboration authority (active room)
  const collabMutate = deps.callCollabMutate || callCollabMutateDefault
  const contentBinaryBase64 = encoded.contentBinary.toString('base64')
  await collabMutate(docId, contentBinaryBase64)

  // Fetch updated document for etag
  const updated = await db.doc.findFirst({
    where: { id: docId },
    select: { updatedAt: true },
  })
  const newEtag = updated ? computeDocEtag(docId, updated.updatedAt) : currentEtag

  const operationId = `mutate:${docId}:${snapshot.id}`
  const result: MutationResult = {
    documentId: docId,
    versionId: snapshot.id,
    etag: newEtag,
    operationId,
  }

  if (idempotencyKey) setIdempotentResult(idempotencyKey, result)
  return result
}

// --- Version listing ---

function encodeVersionCursor(cursor: { createdAt: string; id: string }) {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeVersionCursor(value: string) {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>
    if (typeof decoded.createdAt !== 'string' || typeof decoded.id !== 'string' || !decoded.id) {
      throw new Error('invalid')
    }
    return { createdAt: new Date(decoded.createdAt).toISOString(), id: decoded.id }
  } catch {
    throw new ApiV1Error(400, 'invalid_cursor', 'Cursor is invalid')
  }
}

async function requireReadableDocument(userId: string, docId: string) {
  const doc = await db.doc.findFirst({
    where: { id: docId, isDeleted: false },
    select: {
      id: true,
      userId: true,
      shareRelations: {
        where: {
          userId,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        select: { access: true, authorId: true },
      },
    },
  })
  if (!doc) throw new ApiV1Error(404, 'document_not_found', 'Document not found')
  const relation = doc.shareRelations.find((candidate) => candidate.authorId === doc.userId)
  const allowed = doc.userId === userId || relation?.access === 'WRITE' || relation?.access === 'READ'
  if (!allowed) throw new ApiV1Error(404, 'document_not_found', 'Document not found')
  return doc
}

export async function listDocumentVersions(userId: string, docId: string, params: URLSearchParams) {
  await requireReadableDocument(userId, docId)

  const rawLimit = params.get('limit')
  if (rawLimit != null && !/^\d+$/.test(rawLimit)) {
    throw new ApiV1Error(400, 'invalid_query', 'limit must be an integer')
  }
  const limit = Math.min(Math.max(Number(rawLimit) || 20, 1), 100)
  const cursorValue = params.get('cursor')
  const cursor = cursorValue ? decodeVersionCursor(cursorValue) : null

  const versions = await db.docVersion.findMany({
    where: {
      docId,
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: new Date(cursor.createdAt) } },
              { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      title: true,
      createdAt: true,
      userId: true,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  })

  const page = versions.slice(0, limit)
  const last = page[page.length - 1]
  return {
    versions: page.map((v) => ({
      id: v.id,
      title: v.title,
      authorId: v.userId,
      kind: 'snapshot' as const,
      createdAt: v.createdAt.toISOString(),
    })),
    nextCursor:
      versions.length > limit && last
        ? encodeVersionCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null,
  }
}

export async function getDocumentVersion(userId: string, docId: string, versionId: string) {
  await requireReadableDocument(userId, docId)
  const version = await db.docVersion.findFirst({
    where: { id: versionId, docId },
    select: {
      id: true,
      title: true,
      createdAt: true,
      userId: true,
      content: true,
    },
  })
  if (!version) throw new ApiV1Error(404, 'version_not_found', 'Version not found')

  let content: unknown
  try {
    content = JSON.parse(version.content)
  } catch {
    throw new ApiV1Error(500, 'invalid_stored_content', 'Stored version content is not valid JSON')
  }
  if (
    content == null ||
    Array.isArray(content) ||
    typeof content !== 'object' ||
    (content as { type?: unknown }).type !== 'doc'
  ) {
    throw new ApiV1Error(500, 'invalid_stored_content', 'Stored version content is not valid JSON')
  }

  return {
    id: version.id,
    title: version.title,
    authorId: version.userId,
    kind: 'snapshot' as const,
    createdAt: version.createdAt.toISOString(),
    content,
  }
}

// --- Restore ---

export async function restoreDocumentVersion(
  userId: string,
  docId: string,
  input: { versionId: string; idempotencyKey?: string },
  deps: MutationDeps = {}
): Promise<RestoreResult> {
  const idempotencyKey = input.idempotencyKey ? `restore:${userId}:${docId}:${input.idempotencyKey}` : null

  if (idempotencyKey) {
    const existing = getIdempotentResult(idempotencyKey)
    if (existing && 'recoverySnapshotId' in existing) return existing
  }

  // Verify ownership
  const doc = await db.doc.findFirst({
    where: { id: docId, userId, isDeleted: false },
    select: { id: true, title: true, content: true, contentBinary: true, updatedAt: true },
  })
  if (!doc) throw new ApiV1Error(404, 'document_not_found', 'Document not found')

  // Fetch target version
  const targetVersion = await db.docVersion.findFirst({
    where: { id: input.versionId, docId, userId },
    select: { id: true, title: true, content: true, contentBinary: true },
  })
  if (!targetVersion) throw new ApiV1Error(404, 'version_not_found', 'Version not found')

  // Preserve current state
  const recoverySnapshot = await db.docVersion.create({
    data: {
      docId,
      userId,
      title: doc.title,
      content: doc.content,
      contentBinary: doc.contentBinary || Buffer.from(''),
    },
    select: { id: true },
  })

  // Restore through collaboration authority
  const collabRestore = deps.callCollabRestore || callCollabMutateDefault
  const targetBinaryBase64 = Buffer.from(targetVersion.contentBinary).toString('base64')
  await collabRestore(docId, targetBinaryBase64)

  // Update title
  await db.doc.update({
    where: { id: docId },
    data: { title: targetVersion.title },
  })

  const operationId = `restore:${docId}:${targetVersion.id}`
  const result: RestoreResult = {
    documentId: docId,
    restoredVersionId: targetVersion.id,
    recoverySnapshotId: recoverySnapshot.id,
    operationId,
    title: targetVersion.title,
  }

  if (idempotencyKey) setIdempotentResult(idempotencyKey, result)
  return result
}
