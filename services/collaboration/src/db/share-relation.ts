import type { QueryResultRow } from 'pg'

import { pgClient, reconnect } from './client.js'

export type DocumentAccess = 'ADMIN' | 'READ' | 'WRITE'

interface AccessRow extends QueryResultRow {
  access: DocumentAccess
}

export interface ShareAccessDeps {
  query: (sql: string, values: string[]) => Promise<{ rowCount: number | null; rows: AccessRow[] }>
  reconnect: () => void | Promise<void>
}

const defaultShareAccessDeps: ShareAccessDeps = {
  query: (sql, values) => pgClient.query<AccessRow>(sql, values),
  reconnect,
}

/**
 * Get share relation
 * @param {string} docId doc id
 * @param {string} userId user id
 * @returns {string | null} 'ADMIN' | 'READ' | 'WRITE' | null
 */
export async function getShareRelationAccess(
  docId: string,
  userId: string,
  deps: ShareAccessDeps = defaultShareAccessDeps
): Promise<DocumentAccess | null> {
  try {
    // check if the doc is mine
    const getDocSQL = `select id from "Doc" where id = $1 and "userId" = $2 and "isDeleted" = false`
    const getDocValues = [docId, userId]
    const getDocResult = await deps.query(getDocSQL, getDocValues)
    // console.log('getDocResult...', getDocResult.rowCount)
    if ((getDocResult.rowCount ?? 0) > 0) {
      return 'ADMIN'
    }

    // If not mine, check share relation
    const getShareRelationSQL = `
      select relation.access
      from "ShareRelation" relation
      inner join "Doc" doc on doc.id = relation."docId"
      where relation."docId" = $1
        and relation."userId" = $2
        and relation."authorId" = doc."userId"
        and doc."isDeleted" = false
        and (relation."expiresAt" is null or relation."expiresAt" > now())
      limit 1
    `
    const getShareRelationValues = [docId, userId]
    const getShareRelationResult = await deps.query(getShareRelationSQL, getShareRelationValues)
    // console.log('getShareRelationResult...', getShareRelationResult.rows[0])
    return getShareRelationResult.rows[0]?.access || null
  } catch {
    console.error('hocuspocus db getShareRelationAccess error')
    void deps.reconnect()
    return null
  }
}

/**
 * update share relation notice type to 'UPDATE'
 * @param {string} docId doc id
 * @param {string} userId user id
 */
export async function updateShareRelationNoticeType(docId: string, userId: string): Promise<void> {
  const sql = `
    update "ShareRelation" relation
    set "noticeType" = 'UPDATE'
    from "Doc" doc
    where relation."docId" = $1
      and relation."userId" <> $2
      and relation."docId" = doc.id
      and relation."authorId" = doc."userId"
  `
  const values = [docId, userId]
  try {
    await pgClient.query(sql, values)
  } catch {
    console.error('hocuspocus db updateShareRelationNoticeType error')
    void reconnect()
  }
}
