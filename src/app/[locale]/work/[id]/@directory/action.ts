'use server'

import { db } from '@/db/db'
import { getUserInfo } from '@/lib/session'
import { sendEmail } from '@/lib/mailer'

export async function getDocList() {
  try {
    const user = await getUserInfo()
    if (user == null || user.id === '') return []
    const list = await db.doc.findMany({
      select: {
        id: true,
        icon: true,
        title: true,
        parentId: true,
        sortOrder: true,
        isStar: true,
        userId: true,
        createdAt: true,
        updatedAt: true,
      },
      where: {
        userId: user.id,
        isDeleted: false,
      },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    })
    return list || []
  } catch (err: any) {
    console.error('getDocList error: ', err)
    sendEmail({ subject: 'getDocList error', text: err.message || 'error' })
    return []
  }
}

export async function getShareRelations() {
  const user = await getUserInfo()
  if (user == null || user.id === '') return []

  const shareRelations = await db.shareRelation.findMany({
    where: {
      userId: user.id,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    include: {
      doc: {
        select: {
          id: true,
          icon: true,
          title: true,
          isDeleted: true,
          updatedAt: true,
          createdAt: true,
        },
      },
      author: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
    },
  })

  return shareRelations
}

export async function getMyShareRelations() {
  const user = await getUserInfo()
  if (user == null || user.id === '') return []

  const myShareRelations = await db.shareRelation.findMany({
    where: {
      authorId: user.id,
    },
    include: {
      doc: {
        select: {
          id: true,
          icon: true,
          title: true,
          isDeleted: true,
          updatedAt: true,
          createdAt: true,
        },
      },
      user: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
    },
  })
  return myShareRelations
}

export async function getPubDocs() {
  const user = await getUserInfo()
  if (user == null || user.id === '') return []

  const list = await db.pubDoc.findMany({
    where: {
      userId: user.id,
    },
    orderBy: {
      updatedAt: 'desc',
    },
    select: {
      publishId: true,
      title: true,
      docId: true,
      status: true,
      statusReason: true,
    },
  })
  return list
}
