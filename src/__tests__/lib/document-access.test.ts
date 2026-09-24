import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findFirst } = vi.hoisted(() => ({
  findFirst: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('@/db/db', () => ({
  db: {
    doc: {
      findFirst,
    },
  },
}))

import { DOCUMENT_ACCESS, getDocumentAccess, resolveDocumentAccess } from '@/lib/document-access'

describe('document access', () => {
  beforeEach(() => {
    findFirst.mockReset()
  })

  it.each([
    {
      name: 'missing document',
      record: null,
      userId: 'user-a',
      expected: DOCUMENT_ACCESS.NONE,
    },
    {
      name: 'owner',
      record: {
        userId: 'user-a',
        shareRelations: [{ access: 'READ', authorId: 'forged-author' }],
      },
      userId: 'user-a',
      expected: DOCUMENT_ACCESS.OWNER,
    },
    {
      name: 'write share',
      record: {
        userId: 'owner',
        shareRelations: [{ access: 'WRITE', authorId: 'owner' }],
      },
      userId: 'user-a',
      expected: DOCUMENT_ACCESS.WRITE,
    },
    {
      name: 'read share',
      record: {
        userId: 'owner',
        shareRelations: [{ access: 'READ', authorId: 'owner' }],
      },
      userId: 'user-a',
      expected: DOCUMENT_ACCESS.READ,
    },
    {
      name: 'duplicate relations prefer write',
      record: {
        userId: 'owner',
        shareRelations: [
          { access: 'READ', authorId: 'owner' },
          { access: 'WRITE', authorId: 'owner' },
        ],
      },
      userId: 'user-a',
      expected: DOCUMENT_ACCESS.WRITE,
    },
    {
      name: 'unrelated user',
      record: { userId: 'owner', shareRelations: [] },
      userId: 'user-a',
      expected: DOCUMENT_ACCESS.NONE,
    },
    {
      name: 'forged legacy relation',
      record: {
        userId: 'owner',
        shareRelations: [{ access: 'WRITE', authorId: 'attacker' }],
      },
      userId: 'user-a',
      expected: DOCUMENT_ACCESS.NONE,
    },
  ])('resolves $name', ({ record, userId, expected }) => {
    expect(resolveDocumentAccess(record as Parameters<typeof resolveDocumentAccess>[0], userId)).toBe(expected)
  })

  it('queries only active documents and relations for the current user', async () => {
    findFirst.mockResolvedValue({
      userId: 'owner',
      shareRelations: [{ access: 'READ', authorId: 'owner' }],
    })

    await expect(getDocumentAccess('doc-1', 'reader')).resolves.toBe(DOCUMENT_ACCESS.READ)
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: 'doc-1',
        isDeleted: false,
      },
      select: {
        userId: true,
        shareRelations: {
          where: {
            userId: 'reader',
            OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
          },
          select: { access: true, authorId: true },
        },
      },
    })
  })

  it('does not query with an empty document or user id', async () => {
    await expect(getDocumentAccess('', 'reader')).resolves.toBe(DOCUMENT_ACCESS.NONE)
    await expect(getDocumentAccess('doc-1', '')).resolves.toBe(DOCUMENT_ACCESS.NONE)
    expect(findFirst).not.toHaveBeenCalled()
  })
})
