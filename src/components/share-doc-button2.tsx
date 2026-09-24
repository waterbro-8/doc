'use client'

import { useState, useEffect, useTransition } from 'react'
import { Share, User, X as XIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import copy from 'copy-to-clipboard'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useShareStore, IShareRelation } from '@/stores/share-store'
import { useUserStore } from '@/stores/user-store'
import { useDocsStore } from '@/stores/docs-store'
import { post, del } from '@/lib/ajax'
import { MAX_SHARE_COUNT } from '@/constants'
import { useToast } from '@/components/ui/use-toast'

interface IProps {
  id: string
  disabled?: boolean
  className?: string
}

export default function ShareDocButton(props: IProps) {
  const t = useTranslations('shareDoc')
  const { toast } = useToast()
  const { id, className = '', disabled = false } = props
  const myShareRelations = useShareStore((s) => s.myShareRelations)

  // get share relations of this doc
  const [shareRelations, setShareRelations] = useState<IShareRelation[]>([])
  useEffect(() => {
    const relations = myShareRelations.filter((i) => i.docId === id)
    setShareRelations(relations)
  }, [myShareRelations, id])

  // remove relation
  const [removeLoading, setRemoveTransition] = useTransition()
  const removeMyShareRelation = useShareStore((s) => s.removeMyShareRelation)
  function removeRelationHandler(id: string) {
    if (removeLoading) return
    const c = confirm(t('confirmRemove'))
    if (!c) return

    const r = shareRelations.find((i) => i.id === id)
    if (r == null) return

    setRemoveTransition(async () => {
      const url = '/api/doc/share-relation'
      const res = await del(url, { id })
      if (res.errno !== 0) {
        toast({ variant: 'destructive', description: res.msg })
        return
      }
      removeMyShareRelation(id)
    })
  }

  // add relation
  const [email, setEmail] = useState('')
  const [access, setAccess] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [addLoading, setAddTransition] = useTransition()
  const addMyShareRelation = useShareStore((s) => s.addMyShareRelation)
  const userInfo = useUserStore((s) => s.userInfo)
  const curDoc = useDocsStore((s) => s.docs.find((i) => i.id === id))
  async function addRelation() {
    if (userInfo == null || userInfo.id == null) return
    if (email === userInfo.email) {
      toast({ variant: 'destructive', description: t('canNotShareToSelf') })
      return
    }
    if (shareRelations.some((i) => i.user?.email === email)) {
      toast({ variant: 'destructive', description: t('shareExist') })
      return
    }
    if (shareRelations.length >= MAX_SHARE_COUNT) {
      toast({ variant: 'destructive', description: t('maxShare', { maxNum: MAX_SHARE_COUNT }) })
      return
    }

    const url = '/api/doc/share-relation'
    const res = await post(url, {
      email,
      access,
      docId: id,
      ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
    })
    if (res.errno !== 0) {
      toast({ variant: 'destructive', description: res.msg })
      return
    }

    const { shareRelation, userName } = res.data
    addMyShareRelation({
      ...shareRelation,
      doc: { id, title: curDoc?.title || '', isDeleted: false },
      user: { id: shareRelation.userId, name: userName, email },
    })
    setEmail('')
    setAccess('')
    setExpiresAt('')
  }
  function addRelationHandler() {
    if (email.trim() === '') return
    if (access === '') {
      toast({ variant: 'destructive', description: t('noAccess') })
      return
    }
    if (addLoading) return
    setAddTransition(addRelation)
  }

  // copy link
  const [link, setLink] = useState('')
  useEffect(() => {
    setLink(window.location.href)
  }, [id])
  const [copied, setCopied] = useState(false)
  function handleCopy() {
    copy(link)
    setCopied(true)
    setTimeout(() => setCopied(false), 1000)
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          role="share-button"
          variant={shareRelations.length > 0 ? 'secondary' : 'ghost'}
          size="sm"
          className={cn('focus-visible:ring-transparent', className)}
          disabled={disabled}
        >
          <Share className="h-4 w-4 mr-1" />
          {shareRelations.length > 0 ? t('shared') : t('share')}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96" role="share-content">
        <div className="px-1">
          <h3 className="font-bold mb-2">{t('shareDesc')}</h3>
          <div className="max-h-72 overflow-y-auto">
            {shareRelations.length === 0 && (
              <p className="my-6 text-center text-sm text-foreground-muted">{t('notShared')}</p>
            )}
            {shareRelations.map((i) => (
              <div key={i.id} className="flex items-center justify-between py-1 my-1">
                <div className="inline-flex items-center">
                  <User className="h-4 w-4 mr-1" />
                  <p className="text-sm w-52 text-ellipsis overflow-hidden">{i.user?.name || i.user?.email}</p>
                </div>
                <Badge variant={i.access === 'WRITE' ? 'outline' : 'secondary'}>{i.access}</Badge>
                {i.expiresAt ? (
                  <span className="ml-2 text-xs text-foreground-muted">
                    {t('expires', { time: new Date(i.expiresAt).toISOString() })}
                  </span>
                ) : null}
                <button
                  type="button"
                  aria-label={`${t('confirmRemove')} ${i.user?.name || i.user?.email || ''}`}
                  className="cursor-pointer rounded-full p-1 hover:bg-active"
                  onClick={() => removeRelationHandler(i.id)}
                >
                  <XIcon className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
          <div className="mt-4">
            <p className="text-sm font-bold text-foreground-muted">{t('newShare')}</p>
            <div className="flex items-center justify-between py-2 space-x-2">
              <Input
                data-testid="share-new-email-input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t('email')}
                className="w-52 h-8"
              />
              <Select value={access} onValueChange={(v) => setAccess(v)}>
                <SelectTrigger className="h-8">
                  <SelectValue data-testid="share-new-access-trigger" placeholder={t('access')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem data-testid="share-new-access-write" value="WRITE">
                    {t('write')}
                  </SelectItem>
                  <SelectItem data-testid="share-new-access-read" value="READ">
                    {t('read')}
                  </SelectItem>
                </SelectContent>
              </Select>
              <Button
                size="sm"
                onClick={addRelationHandler}
                disabled={addLoading || !email.trim()}
                className="h-8"
                data-testid="share-new-button"
              >
                {t('share')}
              </Button>
            </div>
            <Input
              data-testid="share-new-expiry-input"
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              className="mt-2 h-8"
              aria-label={t('expiresAt')}
            />
          </div>
          <div className="mt-4">
            <p className="text-sm font-bold text-foreground-muted">{t('copyLink')}</p>
            <div className="flex items-center justify-between py-2 space-x-2">
              <Input type="url" defaultValue={link} className="h-8" />
              <Button size="sm" variant="secondary" onClick={handleCopy} disabled={copied} className="h-8">
                {copied ? t('copied') : t('copy')}
              </Button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
