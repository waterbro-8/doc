// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { TiptapTransformer } from '@hocuspocus/transformer'
import * as Y from 'yjs'

import type { StoredDocumentRow } from '../src/db/doc.js'
import { getShareRelationAccess, type ShareAccessDeps } from '../src/db/share-relation.js'
import { dbFetch, dbStore, onAuthenticate } from '../src/hocuspocus/index.js'
import { createTargetYdocFromBinary, replaceDocumentContent } from '../src/hocuspocus/restore.js'

function storedDocument(overrides: Partial<StoredDocumentRow> = {}): StoredDocumentRow {
  return {
    content: null,
    contentBinary: null,
    ...overrides,
  }
}

describe('typed collaboration behavior baseline', () => {
  it('keeps READ authentication read-only and WRITE authentication mutable', async () => {
    const decryptToken = vi.fn(() => ({ userId: 'member', dt: Date.now() }))
    const readConnection = { readOnly: false, isAuthenticated: false, requiresAuthentication: true }
    const writeConnection = { readOnly: false, isAuthenticated: false, requiresAuthentication: true }

    await expect(
      onAuthenticate(
        { documentName: 'doc-1', token: 'opaque-token', connection: readConnection },
        { decryptToken, getShareRelationAccess: vi.fn(async () => 'READ' as const) }
      )
    ).resolves.toEqual({ userId: 'member' })
    expect(readConnection.readOnly).toBe(true)

    await expect(
      onAuthenticate(
        { documentName: 'doc-1', token: 'opaque-token', connection: writeConnection },
        { decryptToken, getShareRelationAccess: vi.fn(async () => 'WRITE' as const) }
      )
    ).resolves.toEqual({ userId: 'member' })
    expect(writeConnection.readOnly).toBe(false)
  })

  it('rejects invalid tokens and missing persisted access', async () => {
    const connection = { readOnly: false, isAuthenticated: false, requiresAuthentication: true }

    await expect(
      onAuthenticate(
        { documentName: 'doc-1', token: 'invalid', connection },
        { decryptToken: vi.fn(() => null), getShareRelationAccess: vi.fn(async () => 'WRITE' as const) }
      )
    ).rejects.toThrow('Token is invalid or expired')

    await expect(
      onAuthenticate(
        { documentName: 'doc-1', token: 'opaque-token', connection },
        {
          decryptToken: vi.fn(() => ({ userId: 'member', dt: Date.now() })),
          getShareRelationAccess: vi.fn(async () => null),
        }
      )
    ).rejects.toThrow('You do not have access to this document')
  })

  it('preserves binary-first persistence and stores Yjs updates unchanged', async () => {
    const source = new Y.Doc()
    source.getText('content').insert(0, 'binary state')
    const binary = Y.encodeStateAsUpdate(source)
    const getDocById = vi.fn(async () => storedDocument({ contentBinary: Buffer.from(binary) }))
    const updateDocBinary = vi.fn(async () => 1)

    await expect(dbFetch({ documentName: 'doc-1' }, { getDocById })).resolves.toEqual(Buffer.from(binary))
    await dbStore({ documentName: 'doc-1', state: Buffer.from(binary) }, { updateDocBinary })

    expect(updateDocBinary).toHaveBeenCalledWith('doc-1', Buffer.from(binary))
  })

  it('keeps JSON fallback loading and active-room replacement compatible', async () => {
    const content = JSON.stringify({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'restored' }] }],
    })
    const update = await dbFetch(
      { documentName: 'doc-1' },
      { getDocById: vi.fn(async () => storedDocument({ content })) }
    )
    expect(update).not.toBeNull()

    const target = createTargetYdocFromBinary(update as Uint8Array)
    const active = TiptapTransformer.toYdoc({ type: 'doc', content: [{ type: 'paragraph' }] }, 'default')
    replaceDocumentContent(active, target)

    expect(TiptapTransformer.fromYdoc(active, 'default')).toEqual(JSON.parse(content))
  })

  it('uses the real persisted auth function for an owner-authored active share', async () => {
    const query = vi
      .fn<ShareAccessDeps['query']>()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ access: 'WRITE' }] })

    await expect(getShareRelationAccess('doc-1', 'writer', { query, reconnect: vi.fn() })).resolves.toBe('WRITE')
  })

  it.each(['soft-delete', 'owner-transfer'] as const)(
    'fails real persisted auth closed when a %s commits between its owner and relation reads',
    async (boundaryChange) => {
      let queryCount = 0
      const query = vi.fn<ShareAccessDeps['query']>(async (sql) => {
        queryCount += 1
        if (queryCount === 1) {
          expect(sql).toContain('"isDeleted" = false')
          // The lifecycle mutation commits after the owner lookup but before the share lookup.
          return { rowCount: 0, rows: [] }
        }
        expect(sql).toContain('relation."authorId" = doc."userId"')
        expect(sql).toContain('doc."isDeleted" = false')
        expect(sql).toContain('relation."expiresAt"')
        expect(boundaryChange === 'soft-delete' || boundaryChange === 'owner-transfer').toBe(true)
        return { rowCount: 0, rows: [] }
      })
      const reconnect = vi.fn()

      await expect(getShareRelationAccess('doc-1', 'former-owner', { query, reconnect })).resolves.toBeNull()

      expect(query).toHaveBeenCalledTimes(2)
      expect(reconnect).not.toHaveBeenCalled()
    }
  )

  it('fails persisted auth closed when either database read errors', async () => {
    const query = vi.fn<ShareAccessDeps['query']>().mockRejectedValueOnce(new Error('transaction unavailable'))
    const reconnect = vi.fn()

    await expect(getShareRelationAccess('doc-1', 'former-owner', { query, reconnect })).resolves.toBeNull()

    expect(reconnect).toHaveBeenCalledTimes(1)
  })
})
