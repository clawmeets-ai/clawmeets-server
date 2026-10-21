import { get, getText, getFile, putFile } from '../client'
import type { FileInfo } from '../../types'

export async function listFiles(
  projectId: string,
  chatroomName: string
): Promise<FileInfo[]> {
  // Backend returns list of filenames as strings, convert to FileInfo objects
  const filenames = await get<string[]>(`/projects/${projectId}/chatrooms/${chatroomName}/files`)
  return filenames.map((name) => ({
    name,
    size: 0,  // Size not available from this endpoint
    modified: '',  // Modified date not available from this endpoint
  }))
}

export async function downloadFile(
  projectId: string,
  chatroomName: string,
  filename: string
): Promise<string> {
  return getText(`/projects/${projectId}/chatrooms/${chatroomName}/files/${encodeURIComponent(filename)}`)
}

export async function uploadFile(
  projectId: string,
  chatroomName: string,
  filename: string,
  content: Blob | ArrayBuffer
): Promise<void> {
  await putFile(
    `/projects/${projectId}/chatrooms/${chatroomName}/files/${encodeURIComponent(filename)}`,
    content
  )
}

export async function downloadFileAsBlob(
  projectId: string,
  chatroomName: string,
  filename: string
): Promise<Blob> {
  return getFile(`/projects/${projectId}/chatrooms/${chatroomName}/files/${encodeURIComponent(filename)}`)
}

export async function uploadUserFile(
  projectId: string,
  chatroomName: string,
  filename: string,
  content: Blob | ArrayBuffer
): Promise<void> {
  await putFile(
    `/projects/${projectId}/chatrooms/${chatroomName}/user-files/${encodeURIComponent(filename)}`,
    content
  )
}
