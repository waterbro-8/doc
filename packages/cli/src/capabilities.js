export const capabilitySchemaVersion = 1

export const capabilityGroups = [
  {
    id: 'document',
    title: 'Document lifecycle',
    capabilities: [
      {
        id: 'document-tree',
        name: 'Document tree',
        status: 'available',
        detail: 'Create, rename, duplicate, move, sort, favorite, search, trash, and restore documents.',
      },
      {
        id: 'rich-text',
        name: 'Rich-text editing',
        status: 'available',
        detail: 'Tiptap editing with tables, tasks, columns, images, code, Mermaid, links, and templates.',
      },
      {
        id: 'versions',
        name: 'Version history',
        status: 'available',
        detail: 'Structured snapshots, block-aware diffs, and protected version restore.',
      },
      {
        id: 'sharing',
        name: 'Document sharing',
        status: 'experimental',
        detail:
          'Owner-scoped, database-unique read/write relations with optional expiry; expired grants fail closed on the next collaboration check.',
      },
      {
        id: 'publishing',
        name: 'Publishing',
        status: 'experimental',
        detail:
          'Owner-scoped public links, moderation, republish/unpublish, allowlist HTML sanitization, public reading, and PDF export.',
      },
    ],
  },
  {
    id: 'collaboration',
    title: 'Realtime collaboration',
    capabilities: [
      {
        id: 'realtime-editing',
        name: 'Realtime editing',
        status: 'available',
        detail: 'Yjs and Hocuspocus rooms with presence, offline state, and PostgreSQL persistence.',
      },
      {
        id: 'collaboration-auth',
        name: 'End-to-end collaboration authorization',
        status: 'experimental',
        detail:
          'HTTP and WebSocket entry points enforce active owner/read/write access; connected clients are not yet evicted immediately after revocation.',
      },
      {
        id: 'integration-tests',
        name: 'Collaboration recovery path',
        status: 'experimental',
        detail:
          'Active-room restore exists, but the service currently has syntax checks rather than automated multi-client recovery tests.',
      },
    ],
  },
  {
    id: 'ai',
    title: 'AI assistance',
    capabilities: [
      {
        id: 'ai-writing',
        name: 'AI writing tools',
        status: 'available',
        detail: 'Outline, summarize, continue, translate, explain, shorten, lengthen, and change tone.',
      },
      {
        id: 'ai-chat',
        name: 'Document-side AI chat',
        status: 'available',
        detail: 'Streaming chat, Markdown and Mermaid rendering, reusable output, and usage limits.',
      },
    ],
  },
  {
    id: 'platform',
    title: 'Platform and governance',
    capabilities: [
      {
        id: 'authentication',
        name: 'Authentication',
        status: 'available',
        detail:
          'GitHub OAuth, email sign-in, and scoped personal access tokens with expiry, revocation, and one-time secret display.',
      },
      {
        id: 'agent-api',
        name: 'Document API v1',
        status: 'available',
        detail:
          'Bearer-only token inspection, owner listing, authorized reads, canonical creation, ETag-guarded metadata updates, version list/get, and comments.',
      },
      {
        id: 'document-authorization',
        name: 'Document, share, and publishing authorization',
        status: 'experimental',
        detail:
          'Legacy browser routes, API v1, publication, and collaboration entry points enforce persisted ownership and read/write relations.',
      },
      {
        id: 'admin',
        name: 'Administration',
        status: 'available',
        detail: 'Admin overview, document governance, publication status, and user administration.',
      },
      {
        id: 'product-surface',
        name: 'Product surface',
        status: 'available',
        detail: 'Chinese and English interfaces with dark/light themes and responsive landing pages.',
      },
      {
        id: 'storage',
        name: 'Object storage',
        status: 'experimental',
        detail: 'Image upload is supported through the current OSS adapter; a provider-neutral interface is pending.',
      },
    ],
  },
  {
    id: 'operations',
    title: 'Operations',
    capabilities: [
      {
        id: 'compose',
        name: 'Container stack',
        status: 'available',
        detail: 'PostgreSQL, Prisma schema application, collaboration, and Web services run through Docker Compose.',
      },
      {
        id: 'cli',
        name: 'doc CLI',
        status: 'available',
        detail:
          'Authenticate with scoped PATs; list, read, create, and safely update documents; operate and diagnose the local stack.',
      },
      {
        id: 'health',
        name: 'Health checks',
        status: 'available',
        detail: 'Configuration diagnostics plus optional live checks for Web, database, and collaboration surfaces.',
      },
    ],
  },
]

export function capabilitySummary() {
  return capabilityGroups.reduce(
    (summary, group) => {
      for (const capability of group.capabilities) {
        summary[capability.status] = (summary[capability.status] || 0) + 1
      }
      return summary
    },
    { available: 0, experimental: 0 }
  )
}
