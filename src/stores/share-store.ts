import { create } from 'zustand'

export interface IShareRelationUser {
  id: string
  name: string | null
  email: string | null
}

export interface IShareRelationDoc {
  id: string
  icon: string | null
  title: string
  isDeleted: boolean
  createdAt?: Date
  updatedAt?: Date
}

export interface IShareRelation {
  id: string
  docId: string
  authorId: string
  userId: string
  doc: IShareRelationDoc
  author?: IShareRelationUser
  user?: IShareRelationUser
  access: string
  noticeType: string
  expiresAt?: string | null
}

interface IShareRelationState {
  shareRelations: IShareRelation[]
  setShareRelations: (list: IShareRelation[]) => void
  addShareRelation: (shareRelation: IShareRelation) => void
  // removeShareRelation: (id: string) => void
  updateShareRelationNoticeType: (id: string, newNoticeType: string) => void

  myShareRelations: IShareRelation[]
  setMyShareRelations: (list: IShareRelation[]) => void
  addMyShareRelation: (shareRelation: IShareRelation) => void
  removeMyShareRelation: (id: string) => void
}

export const useShareStore = create<IShareRelationState>((set) => ({
  shareRelations: [],
  setShareRelations: (shareRelations) => set({ shareRelations }),
  addShareRelation: (shareRelation) => set((state) => ({ shareRelations: [...state.shareRelations, shareRelation] })),
  // removeShareRelation: (id) => set((state) => ({ shareRelations: state.shareRelations.filter((i) => i.id !== id) })),
  updateShareRelationNoticeType: (id, newNoticeType) => {
    set((state) => ({
      shareRelations: state.shareRelations.map((i) => {
        if (i.id === id) {
          return { ...i, noticeType: newNoticeType }
        }
        return i
      }),
    }))
  },

  myShareRelations: [],
  setMyShareRelations: (myShareRelations) => set({ myShareRelations }),
  addMyShareRelation: (shareRelation) =>
    set((state) => ({ myShareRelations: [...state.myShareRelations, shareRelation] })),
  removeMyShareRelation: (id) =>
    set((state) => ({ myShareRelations: state.myShareRelations.filter((i) => i.id !== id) })),
}))
