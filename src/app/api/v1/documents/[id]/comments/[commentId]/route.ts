import { authenticatePersonalAccessToken } from '@/lib/personal-access-token'
import { apiError, apiRequestId, apiSuccess } from '@/lib/api-v1'
import { resolveDocumentComment } from '@/lib/api-v1-comments'
import { resolveRouteParams, type RouteParams } from '@/lib/route-params'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function PATCH(
  request: Request,
  { params }: { params: RouteParams<{ id: string; commentId: string }> }
) {
  const requestId = apiRequestId(request)
  try {
    const principal = await authenticatePersonalAccessToken(request, 'documents:write')
    const { id, commentId } = await resolveRouteParams(params)
    const comment = await resolveDocumentComment(principal.userId, id, commentId)
    return apiSuccess(comment, { requestId })
  } catch (error) {
    return apiError(error, requestId)
  }
}
