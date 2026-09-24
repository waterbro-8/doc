import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getDocumentAccess: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/document-access', () => ({
  DOCUMENT_ACCESS: { OWNER: 'OWNER', WRITE: 'WRITE', READ: 'READ', NONE: 'NONE' },
  getDocumentAccess: mocks.getDocumentAccess,
}))
vi.mock('@/db/db', () => ({
  db: {
    docComment: {
      findMany: mocks.findMany,
      create: mocks.create,
      findFirst: mocks.findFirst,
      update: mocks.update,
    },
  },
}))

import { DOCUMENT_ACCESS } from '@/lib/document-access'
import {
  createDocumentComment,
  listDocumentComments,
  parseCreateComment,
  resolveDocumentComment,
} from '@/lib/api-v1-comments'

describe('document comments', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset())
  })

  it('parses a bounded comment body and rejects extras', () => {
    expect(parseCreateComment({ body: 'Looks good' }).body).toBe('Looks good')
    expect(() => parseCreateComment({ body: 'x', extra: true })).toThrow()
  })

  it('lets WRITE create comments without touching document rows', async () => {
    mocks.getDocumentAccess.mockResolvedValue(DOCUMENT_ACCESS.WRITE)
    mocks.create.mockResolvedValue({
      id: 'c1',
      docId: 'doc-1',
      userId: 'writer',
      body: 'Please check',
      anchor: null,
      resolvedAt: null,
      createdAt: new Date('2026-09-24T00:00:00.000Z'),
    })

    const created = await createDocumentComment('writer', 'doc-1', parseCreateComment({ body: 'Please check' }))
    expect(created.authorId).toBe('writer')
    expect(created.body).toBe('Please check')
    expect(mocks.create).toHaveBeenCalled()
  })

  it('hides resolved comments unless include=resolved', async () => {
    mocks.getDocumentAccess.mockResolvedValue(DOCUMENT_ACCESS.READ)
    mocks.findMany.mockResolvedValue([])
    await listDocumentComments('reader', 'doc-1', false)
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { docId: 'doc-1', resolvedAt: null },
      })
    )
  })

  it('404s strangers', async () => {
    mocks.getDocumentAccess.mockResolvedValue(DOCUMENT_ACCESS.NONE)
    await expect(listDocumentComments('stranger', 'doc-1')).rejects.toThrow('Document not found')
  })

  it('resolves an existing comment', async () => {
    mocks.getDocumentAccess.mockResolvedValue(DOCUMENT_ACCESS.OWNER)
    mocks.findFirst.mockResolvedValue({
      id: 'c1',
      docId: 'doc-1',
      resolvedAt: null,
    })
    mocks.update.mockResolvedValue({
      id: 'c1',
      docId: 'doc-1',
      userId: 'owner',
      body: 'Please check',
      anchor: null,
      resolvedAt: new Date('2026-09-24T01:00:00.000Z'),
      createdAt: new Date('2026-09-24T00:00:00.000Z'),
    })
    const resolved = await resolveDocumentComment('owner', 'doc-1', 'c1')
    expect(resolved.resolvedAt).toBe('2026-09-24T01:00:00.000Z')
  })
})
