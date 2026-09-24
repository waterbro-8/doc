# doc specification

This document describes the current implementation, not an aspirational API.

## Runtime surfaces

### Web and API

- Next.js 14 App Router
- NextAuth with GitHub and email providers
- Prisma against PostgreSQL
- Tiptap editor with Yjs collaboration
- Scoped, expiring, revocable personal access tokens
- Bearer-only document API v1 under `src/app/api/v1`
- Browser-session route handlers under `src/app/api`

### Collaboration service

- Koa HTTP/WebSocket server
- Hocuspocus and Yjs document rooms
- Strict TypeScript source compiled to native Node.js ESM for local and container production starts
- Shared PostgreSQL document state
- Encrypted short-lived user tokens for WebSocket authentication
- Separate internal key for restore, active-access invalidation, and monitor operations

### Operations CLI

- Independent `@fullstack-ai-infra/doc-cli` workspace with the `doc` binary
- Private PAT login plus token validation through `/api/v1/me`
- Document list, get, canonical create, and ETag-guarded metadata update from any directory
- Project discovery with explicit `--root` override
- Private environment initialization with independent generated secrets
- Docker/Compose/configuration diagnostics with JSON output
- Isolated Compose lifecycle, status and logs per checkout
- Explicit loopback-only development schema push
- No direct document database writes

## Core records

| Record                | Role                                                                |
| --------------------- | ------------------------------------------------------------------- |
| `Doc`                 | Document tree node, current JSON/binary content and lifecycle flags |
| `DocVersion`          | Immutable document snapshot used for history and restore            |
| `ShareRelation`       | User-level read/write access to a document                          |
| `PubDoc`              | Sanitized public projection with moderation state                   |
| `PersonalAccessToken` | Hashed, scoped, expiring, revocable API credential                  |
| `TokenUsage`          | Per-user AI usage limit                                             |

The Prisma schema is the source of truth for field-level definitions.

## Trust boundaries

1. Browser sessions authenticate through NextAuth.
2. API v1 accepts only scoped Bearer PATs and never falls back to a browser session.
3. WebSocket connections use a short-lived encrypted token carrying `userId`.
4. The collaboration service checks document access in PostgreSQL at connection entry and before
   every established-connection message. A missing grant, soft-deleted document, or changed owner
   fails closed. Revocation advances a connection-local authorization epoch, and an in-flight
   lookup must still match that epoch after its database await.
5. Internal restore, exact document-user socket invalidation, and monitor calls require
   `COLLABORATE_INTERNAL_API_KEY`.
6. AI provider and object-storage credentials remain server-side.

## Version restore

1. Validate the authenticated user owns the document.
2. Validate the requested historical version belongs to that document.
3. Commit the current JSON and Yjs binary state as a new recovery version and retain its ID.
4. Persist the selected target binary and JSON projection in the collaboration service.
5. Only after persistence succeeds, replace and broadcast the active Yjs room state.
6. Update the title to the immutable target version's title.

If an active collaboration room is unavailable, the operation fails instead of reporting a false
success.

Concurrent replicas receive the active room's restored Yjs state and converge on that state. A
target-persistence failure occurs before the room mutation, so connected replicas remain unchanged.
The sequence is not globally atomic: if the body succeeds and the title update fails, the API
returns a structured partial result containing a stable `operationId`, the `recoverySnapshotId`,
and retry metadata. Repeating the same document/immutable-version restore is state-idempotent, and
each attempt retains its own recovery snapshot.

## Known gaps

- Browser IndexedDB disconnect/reconnect and access-regrant behavior needs automated integration
  coverage.
- API v1 does not yet replace existing content, delete/restore, or publish.
- API v1 version list/get and document comments are available as read/review surfaces.
- Object storage is coupled to an OSS client and needs a provider interface.
- CLI version restore, publish, and workspace import/export remain deferred.
- Production deployments need reviewed Prisma migrations instead of `db push`.
- Current production dependencies still have unresolved high-severity audit findings.
- Rate limits and audit events are incomplete.
