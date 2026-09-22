import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// Vitest globals are intentionally disabled, so React Testing Library cannot
// auto-register its own cleanup hook. Unmount every rendered tree before the
// JSDOM environment is torn down; pending React 19 transitions can otherwise
// try to commit against an already-disposed window.
afterEach(cleanup)

vi.mock('next/router', () => require('next-router-mock'))
vi.mock('@/i18n/routing', () => ({
  ...require('next-router-mock'),
  usePathname() {
    return ''
  },
}))
