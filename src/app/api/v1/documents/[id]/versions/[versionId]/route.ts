import { authenticatePersonalAccessToken } from '@/lib/personal-access-token'
import { apiError, apiRequestId, apiSuccess } from '@/lib/api-v1'
import { getDocumentVersion } from '@/lib/api-v1-mutations'
import { resolveRouteParams, type RouteParams } from '@/lib/route-params'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(
  request: Request,
  { params }: { params: RouteParams<{ id: string; versionId: string }> }
) {
  const requestId = apiRequestId(request)
  try {
    const principal = await authenticatePersonalAccessToken(request, 'documents:read')
    const { id, versionId } = await resolveRouteParams(params)
    const version = await getDocumentVersion(principal.userId, id, versionId)
    return apiSuccess(version, { requestId })
  } catch (error) {
    return apiError(error, requestId)
  }
}
