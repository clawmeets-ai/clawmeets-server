import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { uploadUserFile } from '../api/endpoints/files'

export type UploadStatus = { type: 'success' | 'error'; message: string } | null

/**
 * Shared chatroom file-upload mutation: posts to {projectId}/{chatroomName},
 * surfaces a transient `uploadStatus` (success auto-clears after 3s; errors
 * persist until the next attempt), and invalidates the files query.
 */
export function useFileUpload(projectId: string, chatroomName: string) {
  const queryClient = useQueryClient()
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>(null)

  const mutation = useMutation({
    mutationFn: async (file: File) => {
      const content = await file.arrayBuffer()
      await uploadUserFile(projectId, chatroomName, file.name, content)
      return file.name
    },
    onSuccess: (filename) => {
      setUploadStatus({ type: 'success', message: `Uploaded "${filename}"` })
      window.setTimeout(() => setUploadStatus(null), 3000)
      queryClient.invalidateQueries({
        queryKey: ['files', projectId, chatroomName],
      })
    },
    onError: (error: Error) => {
      setUploadStatus({
        type: 'error',
        message: `Upload failed: ${error.message || 'Unknown error'}`,
      })
    },
  })

  return { uploadMutation: mutation, uploadStatus, setUploadStatus }
}
