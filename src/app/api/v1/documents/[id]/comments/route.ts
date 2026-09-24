import { authenticatePersonalAccessToken } from '@/lib/personal-access-token'
import { apiError, apiRequestId, apiSuccess, readApiJson } from '@/lib/api-v1'
import {
  createDocumentComment,
  listDocumentComments,
  parseCreateComment,
} from '@/lib/api-v1-comments'
import { resolveRouteParams, type RouteParams } from '@/lib/route-params'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request, { params }: { params: RouteParams<{ id: string }> }) {
  const requestId = apiRequestId(request)
  try {
    const principal = await authenticatePersonalAccessToken(request, 'documents:read')
    const { id } = await resolveRouteParams(params)
    const includeResolved = new URL(request.url).searchParams.get('include') === 'resolved'
    const comments = await listDocumentComments(principal.userId, id, includeResolved)
    return apiSuccess(comments, { requestId })
  } catch (error) {
    return apiError(error, requestId)
  }
}

export async function POST(request: Request, { params }: { params: RouteParams<{ id: string }> }) {
  const requestId = apiRequestId(request)
  try {
    const principal = await authenticatePersonalAccessToken(request, 'documents:write')
    const { id } = await resolveRouteParams(params)
    const input = parseCreateComment(await readApiJson(request))
    const comment = await createDocumentComment(principal.userId, id, input)
    return apiSuccess(comment, { requestId, status: 201 })
  } catch (error) {
    return apiError(error, requestId)
  }
}
