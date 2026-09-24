import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/db/db', () => ({
  db: {
    doc: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    docVersion: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
  },
}))
vi.mock('@/lib/tiptap-codec', () => ({
  encodeTiptapDocument: vi.fn((content: unknown) => ({
    content,
    contentJson: JSON.stringify(content),
    contentBinary: Buffer.from('encoded-binary'),
  })),
  EMPTY_TIPTAP_DOCUMENT: { type: 'doc', content: [] },
}))

import { db } from '@/db/db'
import {
  mutateDocumentContent,
  listDocumentVersions,
  restoreDocumentVersion,
  parseMutateContent,
  parseRestoreVersion,
} from '@/lib/api-v1-mutations'

const mockDb = vi.mocked(db, { deep: true })

describe('api-v1-mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('parseMutateContent', () => {
    it('accepts valid mutation payload', () => {
      const result = parseMutateContent({
        content: { type: 'doc', content: [] },
        baseVersion: '"doc:abc:xyz"',
      })
      expect(result.content).toEqual({ type: 'doc', content: [] })
      expect(result.baseVersion).toBe('"doc:abc:xyz"')
    })

    it('accepts wildcard base version', () => {
      const result = parseMutateContent({
        content: { type: 'doc', content: [] },
        baseVersion: '*',
      })
      expect(result.baseVersion).toBe('*')
    })

    it('rejects missing content', () => {
      expect(() => parseMutateContent({ baseVersion: '*' })).toThrow()
    })

    it('rejects empty baseVersion', () => {
      expect(() => parseMutateContent({ content: { type: 'doc' }, baseVersion: '' })).toThrow()
    })

    it('accepts optional idempotencyKey', () => {
      const result = parseMutateContent({
        content: { type: 'doc', content: [] },
        baseVersion: '*',
        idempotencyKey: 'op-1',
      })
      expect(result.idempotencyKey).toBe('op-1')
    })
  })

  describe('parseRestoreVersion', () => {
    it('accepts valid restore payload', () => {
      const result = parseRestoreVersion({ versionId: 'ver-123' })
      expect(result.versionId).toBe('ver-123')
    })

    it('rejects empty versionId', () => {
      expect(() => parseRestoreVersion({ versionId: '' })).toThrow()
    })
  })

  describe('mutateDocumentContent', () => {
    it('rejects when document not found', async () => {
      mockDb.doc.findFirst.mockResolvedValue(null)

      await expect(
        mutateDocumentContent('user-1', 'doc-1', {
          content: { type: 'doc', content: [] },
          baseVersion: '*',
        })
      ).rejects.toThrow('Document not found')
    })

    it('rejects stale base version with conflict error', async () => {
      mockDb.doc.findFirst.mockResolvedValue({
        id: 'doc-1',
        title: 'Test',
        content: '{}',
        contentBinary: Buffer.from(''),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      } as any)

      await expect(
        mutateDocumentContent('user-1', 'doc-1', {
          content: { type: 'doc', content: [] },
          baseVersion: '"stale-etag"',
        })
      ).rejects.toThrow('Document has been modified')
    })

    it('serializes mutation through collaboration authority', async () => {
      const mockCollabMutate = vi.fn().mockResolvedValue(undefined)
      mockDb.doc.findFirst
        .mockResolvedValueOnce({
          id: 'doc-1',
          title: 'Test',
          content: '{}',
          contentBinary: Buffer.from('old'),
          updatedAt: new Date('2026-01-01T00:00:00Z'),
        } as any)
        .mockResolvedValueOnce({
          updatedAt: new Date('2026-01-01T00:00:01Z'),
        } as any)
      mockDb.docVersion.create.mockResolvedValue({ id: 'snap-1' } as any)

      const result = await mutateDocumentContent(
        'user-1',
        'doc-1',
        { content: { type: 'doc', content: [] }, baseVersion: '*' },
        { callCollabMutate: mockCollabMutate }
      )

      expect(mockCollabMutate).toHaveBeenCalledWith('doc-1', expect.any(String))
      expect(result.documentId).toBe('doc-1')
      expect(result.versionId).toBe('snap-1')
      expect(result.operationId).toContain('mutate:doc-1:')
    })

    it('idempotent retry does not duplicate mutation', async () => {
      const mockCollabMutate = vi.fn().mockResolvedValue(undefined)
      mockDb.doc.findFirst
        .mockResolvedValueOnce({
          id: 'doc-1',
          title: 'Test',
          content: '{}',
          contentBinary: Buffer.from('old'),
          updatedAt: new Date('2026-01-01T00:00:00Z'),
        } as any)
        .mockResolvedValueOnce({ updatedAt: new Date('2026-01-01T00:00:01Z') } as any)
      mockDb.docVersion.create.mockResolvedValue({ id: 'snap-2' } as any)

      const input = {
        content: { type: 'doc', content: [] },
        baseVersion: '*',
        idempotencyKey: 'unique-key-1',
      }

      const result1 = await mutateDocumentContent('user-1', 'doc-1', input, {
        callCollabMutate: mockCollabMutate,
      })

      // Second call with same idempotency key should return cached result
      const result2 = await mutateDocumentContent('user-1', 'doc-1', input, {
        callCollabMutate: mockCollabMutate,
      })

      expect(result1).toEqual(result2)
      expect(mockCollabMutate).toHaveBeenCalledTimes(1)
    })
  })

  describe('listDocumentVersions', () => {
    it('returns versions for owned document', async () => {
      mockDb.doc.findFirst.mockResolvedValue({ id: 'doc-1', userId: 'user-1', shareRelations: [] } as any)
      mockDb.docVersion.findMany.mockResolvedValue([
        { id: 'v1', title: 'T1', createdAt: new Date('2026-01-01'), userId: 'user-1' },
        { id: 'v2', title: 'T2', createdAt: new Date('2026-01-02'), userId: 'user-1' },
      ] as any)

      const result = await listDocumentVersions('user-1', 'doc-1', new URLSearchParams())
      expect(result.versions).toHaveLength(2)
      expect(result.versions[0].id).toBe('v1')
      expect(result.versions[0].authorId).toBe('user-1')
      expect(result.nextCursor).toBeNull()
    })

    it('rejects when document not found', async () => {
      mockDb.doc.findFirst.mockResolvedValue(null)

      await expect(listDocumentVersions('user-1', 'doc-1', new URLSearchParams())).rejects.toThrow('Document not found')
    })
  })

  describe('restoreDocumentVersion', () => {
    it('preserves snapshot before restore and calls collaboration', async () => {
      const mockCollabRestore = vi.fn().mockResolvedValue(undefined)
      mockDb.doc.findFirst.mockResolvedValue({
        id: 'doc-1',
        title: 'Current',
        content: '{"type":"doc"}',
        contentBinary: Buffer.from('current-binary'),
        updatedAt: new Date(),
      } as any)
      mockDb.docVersion.findFirst.mockResolvedValue({
        id: 'ver-target',
        title: 'Old Title',
        content: '{"type":"doc","content":[]}',
        contentBinary: Buffer.from('target-binary'),
      } as any)
      mockDb.docVersion.create.mockResolvedValue({ id: 'recovery-snap' } as any)
      mockDb.doc.update.mockResolvedValue({} as any)

      const result = await restoreDocumentVersion(
        'user-1',
        'doc-1',
        { versionId: 'ver-target' },
        { callCollabRestore: mockCollabRestore }
      )

      expect(mockDb.docVersion.create).toHaveBeenCalled()
      expect(mockCollabRestore).toHaveBeenCalledWith('doc-1', expect.any(String))
      expect(result.restoredVersionId).toBe('ver-target')
      expect(result.recoverySnapshotId).toBe('recovery-snap')
      expect(result.title).toBe('Old Title')
    })

    it('rejects when target version not found', async () => {
      mockDb.doc.findFirst.mockResolvedValue({ id: 'doc-1' } as any)
      mockDb.docVersion.findFirst.mockResolvedValue(null)

      await expect(restoreDocumentVersion('user-1', 'doc-1', { versionId: 'missing' })).rejects.toThrow(
        'Version not found'
      )
    })

    it('idempotent restore does not create duplicate snapshots', async () => {
      const mockCollabRestore = vi.fn().mockResolvedValue(undefined)
      mockDb.doc.findFirst.mockResolvedValue({
        id: 'doc-1',
        title: 'Current',
        content: '{}',
        contentBinary: Buffer.from('bin'),
        updatedAt: new Date(),
      } as any)
      mockDb.docVersion.findFirst.mockResolvedValue({
        id: 'ver-1',
        title: 'Old',
        content: '{}',
        contentBinary: Buffer.from('old'),
      } as any)
      mockDb.docVersion.create.mockResolvedValue({ id: 'snap-r' } as any)
      mockDb.doc.update.mockResolvedValue({} as any)

      const input = { versionId: 'ver-1', idempotencyKey: 'restore-idem-1' }

      const r1 = await restoreDocumentVersion('user-1', 'doc-1', input, {
        callCollabRestore: mockCollabRestore,
      })
      const r2 = await restoreDocumentVersion('user-1', 'doc-1', input, {
        callCollabRestore: mockCollabRestore,
      })

      expect(r1).toEqual(r2)
      expect(mockCollabRestore).toHaveBeenCalledTimes(1)
    })
  })
})
