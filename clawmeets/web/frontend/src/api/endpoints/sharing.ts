import { get, post, del } from '../client'

export interface ShareLinkResponse {
  token: string
  share_url: string
}

export interface ShareTokenInfoResponse {
  project_name: string
}

export interface ShareInfoResponse {
  project_id: string
  project_name: string
  already_added: boolean
  is_owner: boolean
}

export interface JoinShareResponse {
  project_id: string
  status: string
}

export async function createShareLink(projectId: string): Promise<ShareLinkResponse> {
  return post<ShareLinkResponse>(`/projects/${projectId}/share`)
}

export async function getShareTokenInfo(token: string): Promise<ShareTokenInfoResponse> {
  return get<ShareTokenInfoResponse>(`/shared/${token}/info`)
}

export async function getShareInfo(token: string): Promise<ShareInfoResponse> {
  return get<ShareInfoResponse>(`/shared/${token}`)
}

export async function joinSharedProject(token: string): Promise<JoinShareResponse> {
  return post<JoinShareResponse>(`/shared/${token}/join`)
}

export async function removeSharedProject(projectId: string): Promise<{ status: string }> {
  return del<{ status: string }>(`/shared/projects/${projectId}`)
}
