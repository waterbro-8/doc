'use client'

import { useTransition, useEffect, useState } from 'react'
import { Github } from 'lucide-react'
import { signIn, getProviders } from 'next-auth/react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
// import { Link } from '@/i18n/routing'
import HomeNav from '@/components/home-nav'
import { useTranslations } from 'next-intl'

export default function SignInPage() {
  const [providers, setProviders] = useState<Awaited<ReturnType<typeof getProviders>>>()
  const [authError, setAuthError] = useState('')

  useEffect(() => {
    let active = true
    getProviders()
      .then((configuredProviders) => {
        if (active) setProviders(configuredProviders)
      })
      .catch(() => {
        if (active) setProviders(null)
      })
    return () => {
      active = false
    }
  }, [])

  // get url query `callbackUrl`
  const [callbackUrl, setCallbackUrl] = useState<string | null>(null)
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search)
    const url = urlParams.get('callbackUrl')
    if (url) {
      setCallbackUrl(decodeURIComponent(url))
    }
  }, [])

  // handle github sign in
  const [isGithubSignInPending, startGithubSignInTransition] = useTransition()
  const handleGitHubSignIn = () => {
    startGithubSignInTransition(async () => {
      setAuthError('')
      try {
        await signIn('github', { callbackUrl: callbackUrl || '/' })
      } catch {
        setAuthError(t('signInFailed'))
      }
    })
  }

  // handle email sign in
  const [email, setEmail] = useState('')
  const [emailError, setEmailError] = useState('')
  const [isEmailSignInPending, setIsEmailSignInPending] = useState(false)
  const emailProviderId = providers?.resend ? 'resend' : providers?.nodemailer ? 'nodemailer' : null
  const handleEmailSignIn = async (e: React.FormEvent) => {
    e.preventDefault()
    const normalizedEmail = email.trim()
    if (!normalizedEmail) {
      setEmailError(t('requiredEmail'))
      return
    }
    if (!validateEmail(normalizedEmail)) {
      setEmailError(t('invalidEmail'))
      return
    }
    setAuthError('')
    setEmailError('')
    setIsEmailSignInPending(true)
    if (!emailProviderId) {
      setIsEmailSignInPending(false)
      return
    }
    try {
      await signIn(emailProviderId, { email: normalizedEmail, callbackUrl: callbackUrl || '/' })
    } catch {
      setEmailError(t('signInFailed'))
    } finally {
      setIsEmailSignInPending(false)
    }
  }

  function validateEmail(email: string) {
    const regex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/
    return regex.test(email)
  }

  const t = useTranslations('signin')
  const hasGitHub = Boolean(providers?.github)
  const hasEmail = Boolean(emailProviderId)

  return (
    <main className="doc-grid flex min-h-screen items-center justify-center bg-canvas px-4 py-16">
      <HomeNav />
      <Card className="w-full max-w-md bg-surface-raised shadow-md">
        <CardHeader className="items-center pb-2 text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">doc workspace</p>
          <CardTitle className="text-2xl">{t('title')}</CardTitle>
          <CardDescription>
            {t(
              hasGitHub && hasEmail
                ? 'subTitle'
                : hasEmail
                  ? 'emailSubTitle'
                  : hasGitHub
                    ? 'githubSubTitle'
                    : 'signInSubtitle'
            )}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-6">
          {hasGitHub && (
            <Button
              variant="outline"
              className="w-full"
              size="lg"
              onClick={handleGitHubSignIn}
              disabled={isGithubSignInPending}
            >
              <Github className="h-4 w-4" />
              {t('withGithub')}
            </Button>
          )}

          {hasGitHub && hasEmail && (
            <div className="relative" aria-hidden="true">
              <div className="absolute inset-0 flex items-center">
                <Separator className="w-full" />
              </div>
              <div className="relative flex justify-center text-xs uppercase tracking-wide">
                <span className="bg-surface-raised px-2 text-foreground-subtle">{t('others')}</span>
              </div>
            </div>
          )}

          {hasEmail && (
            <form className="space-y-4" noValidate onSubmit={handleEmailSignIn}>
              <div className="space-y-2">
                <Label htmlFor="email" className="block text-left text-sm font-medium text-foreground-muted">
                  {t('email')}
                </Label>
                <Input
                  id="email"
                  type="email"
                  placeholder={t('enterYourEmail')}
                  aria-invalid={Boolean(emailError)}
                  aria-describedby={emailError ? 'signin-email-error' : undefined}
                  required
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value)
                    if (emailError) setEmailError('')
                  }}
                />
                {emailError && (
                  <p id="signin-email-error" role="alert" aria-live="polite" className="text-sm text-danger">
                    {emailError}
                  </p>
                )}
              </div>

              <Button type="submit" className="w-full" size="lg" disabled={isEmailSignInPending}>
                {t('withEmail')}
              </Button>
            </form>
          )}

          {authError && (
            <p
              role="alert"
              aria-live="polite"
              className="rounded-md bg-danger-soft p-3 text-center text-sm text-danger"
            >
              {authError}
            </p>
          )}

          {providers === undefined && <p className="text-center text-sm text-foreground-muted">{t('loading')}</p>}
          {providers === null || (providers !== undefined && !hasGitHub && !hasEmail) ? (
            <p
              role="alert"
              aria-live="polite"
              className="rounded-md bg-danger-soft p-3 text-center text-sm text-danger"
            >
              {t('unavailable')}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </main>
  )
}
