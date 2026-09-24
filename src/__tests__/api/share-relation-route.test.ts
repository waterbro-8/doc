import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getUserInfo: vi.fn(),
  docFindFirst: vi.fn(),
  userFindUnique: vi.fn(),
  relationFindFirst: vi.fn(),
  relationCount: vi.fn(),
  relationCreate: vi.fn(),
  relationDeleteMany: vi.fn(),
  relationUpdateMany: vi.fn(),
  sendEmail: vi.fn(),
  notifyCollaborationAccessRevoked: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/session', () => ({ getUserInfo: mocks.getUserInfo }))
vi.mock('@/db/db', () => ({
  db: {
    doc: {
      findFirst: mocks.docFindFirst,
    },
    user: {
      findUnique: mocks.userFindUnique,
    },
    shareRelation: {
      findFirst: mocks.relationFindFirst,
      count: mocks.relationCount,
      create: mocks.relationCreate,
      deleteMany: mocks.relationDeleteMany,
      updateMany: mocks.relationUpdateMany,
    },
  },
}))
vi.mock('@/lib/mailer', () => ({ sendEmail: mocks.sendEmail }))
vi.mock('@/lib/collaboration-access', () => ({
  notifyCollaborationAccessRevoked: mocks.notifyCollaborationAccessRevoked,
}))

import { DELETE, PATCH, POST } from '@/app/api/doc/share-relation/route'

function jsonRequest(method: string, body: unknown) {
  return new Request('http://doc.test/api/doc/share-relation', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('/api/doc/share-relation permissions', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset())
    mocks.getUserInfo.mockResolvedValue({
      id: 'owner',
      email: 'owner@example.com',
      name: 'Owner',
    })
    mocks.sendEmail.mockResolvedValue(undefined)
    mocks.notifyCollaborationAccessRevoked.mockResolvedValue(true)
  })

  it('rejects past or invalid expiresAt before database access', async () => {
    const past = await POST(
      jsonRequest('POST', {
        email: 'reader@example.com',
        access: 'READ',
        docId: 'doc-1',
        expiresAt: '2000-01-01T00:00:00.000Z',
      })
    )
    await expect(past.json()).resolves.toEqual({
      errno: -1,
      msg: 'Share payload invalid',
    })

    const invalid = await POST(
      jsonRequest('POST', {
        email: 'reader@example.com',
        access: 'READ',
        docId: 'doc-1',
        expiresAt: 'not-a-date',
      })
    )
    await expect(invalid.json()).resolves.toEqual({
      errno: -1,
      msg: 'Share payload invalid',
    })
    expect(mocks.docFindFirst).not.toHaveBeenCalled()
  })

  it('strictly rejects undeclared create fields', async () => {
    const response = await POST(
      jsonRequest('POST', {
        email: 'reader@example.com',
        access: 'READ',
        docId: 'doc-1',
        authorId: 'attacker',
      })
    )

    await expect(response.json()).resolves.toEqual({
      errno: -1,
      msg: 'Share payload invalid',
    })
    expect(mocks.docFindFirst).not.toHaveBeenCalled()
  })

  it('rejects oversized share requests before database access', async () => {
    const request = jsonRequest('POST', {
      email: 'reader@example.com',
      access: 'READ',
      docId: 'doc-1',
    })
    request.headers.set('content-length', String(16 * 1024 + 1))

    const response = await POST(request)

    await expect(response.json()).resolves.toEqual({
      errno: -1,
      msg: 'Share payload invalid',
    })
    expect(mocks.docFindFirst).not.toHaveBeenCalled()
  })

  it('does not let a WRITE recipient reshare the document', async () => {
    mocks.docFindFirst.mockResolvedValueOnce({
      userId: 'another-owner',
      shareRelations: [{ access: 'WRITE' }],
    })

    const response = await POST(
      jsonRequest('POST', {
        email: 'reader@example.com',
        access: 'WRITE',
        docId: 'doc-1',
      })
    )

    await expect(response.json()).resolves.toEqual({
      errno: -1,
      msg: 'Doc not found',
    })
    expect(mocks.userFindUnique).not.toHaveBeenCalled()
    expect(mocks.relationCreate).not.toHaveBeenCalled()
  })

  it('rejects sharing a document with its owner', async () => {
    mocks.docFindFirst
      .mockResolvedValueOnce({ userId: 'owner', shareRelations: [] })
      .mockResolvedValueOnce({ id: 'doc-1', title: 'Private notes' })
    mocks.userFindUnique.mockResolvedValue({
      id: 'owner',
      name: 'Owner',
      email: 'owner@example.com',
    })

    const response = await POST(
      jsonRequest('POST', {
        email: 'owner@example.com',
        access: 'READ',
        docId: 'doc-1',
      })
    )

    expect((await response.json()).msg).toBe('You cannot share a document with yourself')
    expect(mocks.relationCreate).not.toHaveBeenCalled()
  })

  it('rejects a duplicate recipient relation', async () => {
    mocks.docFindFirst
      .mockResolvedValueOnce({ userId: 'owner', shareRelations: [] })
      .mockResolvedValueOnce({ id: 'doc-1', title: 'Private notes' })
    mocks.userFindUnique.mockResolvedValue({
      id: 'reader',
      name: 'Reader',
      email: 'reader@example.com',
    })
    mocks.relationFindFirst.mockResolvedValue({ id: 'relation-1' })
    mocks.relationCount.mockResolvedValue(1)

    const response = await POST(
      jsonRequest('POST', {
        email: 'reader@example.com',
        access: 'READ',
        docId: 'doc-1',
      })
    )

    expect((await response.json()).msg).toBe('Document is already shared with this user')
    expect(mocks.relationCreate).not.toHaveBeenCalled()
  })

  it('creates a validated relation owned by the authenticated user', async () => {
    mocks.docFindFirst
      .mockResolvedValueOnce({ userId: 'owner', shareRelations: [] })
      .mockResolvedValueOnce({ id: 'doc-1', title: 'Private notes' })
    mocks.userFindUnique.mockResolvedValue({
      id: 'reader',
      name: 'Reader',
      email: 'reader@example.com',
    })
    mocks.relationFindFirst.mockResolvedValue(null)
    mocks.relationCount.mockResolvedValue(0)
    mocks.relationCreate.mockResolvedValue({
      id: 'relation-1',
      docId: 'doc-1',
      authorId: 'owner',
      userId: 'reader',
      access: 'READ',
      noticeType: 'NEW',
    })

    const response = await POST(
      jsonRequest('POST', {
        email: 'reader@example.com',
        access: 'READ',
        docId: 'doc-1',
      })
    )

    expect((await response.json()).errno).toBe(0)
    expect(mocks.relationCreate).toHaveBeenCalledWith({
      data: {
        docId: 'doc-1',
        authorId: 'owner',
        userId: 'reader',
        access: 'READ',
        noticeType: 'NEW',
        expiresAt: null,
      },
    })
  })

  it('returns a duplicate error when concurrent creates reach the database constraint', async () => {
    mocks.docFindFirst
      .mockResolvedValueOnce({ userId: 'owner', shareRelations: [] })
      .mockResolvedValueOnce({ userId: 'owner', shareRelations: [] })
      .mockResolvedValue({ id: 'doc-1', title: 'Private notes' })
    mocks.userFindUnique.mockResolvedValue({
      id: 'reader',
      name: 'Reader',
      email: 'reader@example.com',
    })
    mocks.relationFindFirst.mockResolvedValue(null)
    mocks.relationCount.mockResolvedValue(0)

    let relationCreated = false
    mocks.relationCreate.mockImplementation(async () => {
      await Promise.resolve()
      if (relationCreated) {
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
      }
      relationCreated = true
      return {
        id: 'relation-1',
        docId: 'doc-1',
        authorId: 'owner',
        userId: 'reader',
        access: 'READ',
        noticeType: 'NEW',
      }
    })

    const requests = [
      POST(
        jsonRequest('POST', {
          email: 'reader@example.com',
          access: 'READ',
          docId: 'doc-1',
        })
      ),
      POST(
        jsonRequest('POST', {
          email: 'reader@example.com',
          access: 'READ',
          docId: 'doc-1',
        })
      ),
    ]
    const payloads = await Promise.all(requests.map(async (request) => (await request).json()))

    expect(payloads.filter((payload) => payload.errno === 0)).toHaveLength(1)
    expect(payloads.filter((payload) => payload.msg === 'Document is already shared with this user')).toHaveLength(1)
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1)
  })

  it('does not reveal or delete a relation the user does not own', async () => {
    mocks.relationFindFirst.mockResolvedValue(null)

    const response = await DELETE(jsonRequest('DELETE', { id: 'relation-1' }))

    await expect(response.json()).resolves.toEqual({
      errno: -1,
      msg: 'Share relation not found',
    })
    expect(mocks.relationFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'relation-1',
          doc: {
            userId: 'owner',
          },
        },
      })
    )
    expect(mocks.relationDeleteMany).not.toHaveBeenCalled()
  })

  it('removes every legacy duplicate for the same document and recipient', async () => {
    mocks.relationFindFirst.mockResolvedValue({
      id: 'relation-2',
      docId: 'doc-1',
      userId: 'reader',
      doc: { title: 'Private notes' },
      user: { email: 'reader@example.com' },
    })
    mocks.relationDeleteMany.mockResolvedValue({ count: 2 })

    const response = await DELETE(jsonRequest('DELETE', { id: 'relation-2' }))

    expect((await response.json()).errno).toBe(0)
    expect(mocks.relationDeleteMany).toHaveBeenCalledWith({
      where: {
        docId: 'doc-1',
        userId: 'reader',
      },
    })
    expect(mocks.notifyCollaborationAccessRevoked).toHaveBeenCalledWith('doc-1', 'reader')
  })

  it('keeps revocation successful when eager collaboration invalidation is unavailable', async () => {
    mocks.relationFindFirst.mockResolvedValue({
      id: 'relation-2',
      docId: 'doc-1',
      userId: 'reader',
      doc: { title: 'Private notes' },
      user: { email: 'reader@example.com' },
    })
    mocks.relationDeleteMany.mockResolvedValue({ count: 1 })
    mocks.notifyCollaborationAccessRevoked.mockResolvedValue(false)

    const response = await DELETE(jsonRequest('DELETE', { id: 'relation-2' }))

    expect((await response.json()).errno).toBe(0)
    expect(mocks.relationDeleteMany).toHaveBeenCalledTimes(1)
    expect(mocks.notifyCollaborationAccessRevoked).toHaveBeenCalledTimes(1)
  })

  it('only allows a recipient to acknowledge its own notice as NONE', async () => {
    mocks.relationUpdateMany.mockResolvedValue({ count: 1 })

    const response = await PATCH(
      jsonRequest('PATCH', {
        id: 'relation-1',
        noticeType: 'NONE',
      })
    )

    expect((await response.json()).errno).toBe(0)
    expect(mocks.relationUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'relation-1',
        userId: 'owner',
      },
      data: {
        noticeType: 'NONE',
      },
    })
  })

  it('rejects attempts to set another notification state', async () => {
    const response = await PATCH(
      jsonRequest('PATCH', {
        id: 'relation-1',
        noticeType: 'UPDATE',
      })
    )

    await expect(response.json()).resolves.toEqual({
      errno: -1,
      msg: 'Update share payload invalid',
    })
    expect(mocks.relationUpdateMany).not.toHaveBeenCalled()
  })
})
