import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { listFiles, downloadFile, downloadFileAsBlob } from '../api/endpoints'
import { isIsolationUnavailable, retryUnlessIsolated } from '../utils/agentAccessCopy'

export function isBinaryFile(filename: string): boolean {
  // HTML is included so it flows through useFileBlobUrl and can be rendered
  // via <iframe src={blob:...}> instead of shown as source text. Audio/video
  // flow through the same blob path so the viewer can play them inline.
  return /\.(png|jpg|jpeg|gif|svg|webp|bmp|ico|pdf|html|htm|mp3|wav|m4a|ogg|opus|aac|flac|mp4|webm|mov|m4v)$/i.test(filename)
}

export function useFiles(projectId: string, chatroomName: string) {
  return useQuery({
    queryKey: ['files', projectId, chatroomName],
    queryFn: () => listFiles(projectId, chatroomName),
    enabled: !!projectId && !!chatroomName,
    refetchInterval: (q) => (isIsolationUnavailable(q.state.error) ? false : 10000), // Poll every 10 seconds for file updates
    retry: retryUnlessIsolated,
  })
}

export function useFileContent(
  projectId: string,
  chatroomName: string,
  filename: string,
  enabled: boolean = true
) {
  return useQuery({
    queryKey: ['fileContent', projectId, chatroomName, filename],
    queryFn: () => downloadFile(projectId, chatroomName, filename),
    enabled: !!projectId && !!chatroomName && !!filename && enabled,
    staleTime: 0, // Always consider stale so invalidation triggers refetch
  })
}

export function useFileBlobUrl(
  projectId: string,
  chatroomName: string,
  filename: string,
  enabled: boolean = true
) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)

  const query = useQuery({
    queryKey: ['fileBlobContent', projectId, chatroomName, filename],
    queryFn: () => downloadFileAsBlob(projectId, chatroomName, filename),
    enabled: !!projectId && !!chatroomName && !!filename && enabled,
    staleTime: 0,
  })

  useEffect(() => {
    if (query.data) {
      const url = URL.createObjectURL(query.data)
      setBlobUrl(url)
      return () => URL.revokeObjectURL(url)
    }
  }, [query.data])

  return { ...query, blobUrl }
}

/**
 * The local-file twin of `useFileContent` + `useFileBlobUrl`, for a file that
 * is still in the user's browser (a staged attachment not yet sent). Same
 * split as the server pair: text files are read as text, binary ones become an
 * object URL — so `FileViewerModal` renders both sources through one path.
 */
export function useLocalFileView(file: File | null, binary: boolean) {
  const [content, setContent] = useState<string | undefined>(undefined)
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [isLoading, setIsLoading] = useState(!!file)

  useEffect(() => {
    if (!file) return
    if (binary) {
      const url = URL.createObjectURL(file)
      setBlobUrl(url)
      setIsLoading(false)
      return () => URL.revokeObjectURL(url)
    }
    setIsLoading(true)
    const reader = new FileReader()
    reader.onload = () => {
      setContent(String(reader.result ?? ''))
      setIsLoading(false)
    }
    reader.onerror = () => {
      setError(reader.error)
      setIsLoading(false)
    }
    reader.readAsText(file)
    return () => reader.abort()
  }, [file, binary])

  return { content, blobUrl, error, isLoading }
}
