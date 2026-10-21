import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { FileInfo } from '../../types'
import { useFileContent, isBinaryFile } from '../../hooks/useFiles'
import FileViewerModal from './FileViewerModal'
import OutsideBadge from '../chatroom/OutsideBadge'
import { OUTSIDE_COPY } from '../../utils/agentAccessCopy'

interface FileItemProps {
  file: FileInfo
  projectId: string
  chatroomName: string
  /** Came from outside the owner's account (utils/roomTrust). Required: no
   *  trusted default. */
  outside: boolean
}

function getFileIcon(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'md':
      return '📝'
    case 'json':
    case 'ndjson':
      return '📋'
    case 'txt':
      return '📄'
    case 'py':
      return '🐍'
    case 'js':
    case 'ts':
    case 'tsx':
      return '💻'
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'svg':
      return '🖼️'
    case 'pdf':
      return '📕'
    default:
      return '📎'
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function FileItem({ file, projectId, chatroomName, outside }: FileItemProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const isTextFile = /\.(md|txt|json|ndjson|py|js|ts|tsx|css|html|yaml|yml)$/i.test(file.name)
  const isViewable = isTextFile || isBinaryFile(file.name)

  // Only fetch content when expanded
  const { data: content, isLoading, error } = useFileContent(
    projectId,
    chatroomName,
    file.name,
    isExpanded && isTextFile
  )

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation()
    setIsExpanded(!isExpanded)
  }

  const handleOpenModal = () => {
    if (isViewable) {
      setIsModalOpen(true)
    }
  }

  return (
    <>
      <div className="rounded-md hover:bg-gray-50 transition-colors">
        <div
          className={`
            w-full flex items-center gap-2 px-3 py-2
            ${isViewable ? 'cursor-pointer' : 'cursor-default'}
          `}
        >
          <span className="flex-shrink-0">{getFileIcon(file.name)}</span>
          <span
            className="flex-1 min-w-0 truncate text-sm hover:text-blue-600 hover:underline"
            onClick={handleOpenModal}
            title="Click to open in viewer"
          >
            {file.name}
          </span>
          {outside && <OutsideBadge label={OUTSIDE_COPY.fileBadge} title={OUTSIDE_COPY.fileBadgeTitle} />}
          <span className="text-xs text-gray-400 flex-shrink-0">
            {formatSize(file.size)}
          </span>
          {isTextFile && (
            <button
              onClick={handleToggle}
              className="text-gray-400 text-xs hover:text-gray-600 p-1"
              title={isExpanded ? 'Collapse' : 'Expand inline'}
            >
              {isExpanded ? '▼' : '▶'}
            </button>
          )}
        </div>

        {isExpanded && (
          <div className="px-3 pb-2">
            {isLoading ? (
              <div className="text-sm text-gray-500">Loading...</div>
            ) : error ? (
              <div className="text-sm text-red-500">Error loading file: {String(error)}</div>
            ) : (
              <pre className="text-xs bg-gray-100 p-2 rounded overflow-x-auto max-h-64 overflow-y-auto">
                {content}
              </pre>
            )}
          </div>
        )}
      </div>

      {isModalOpen && createPortal(
        <FileViewerModal
          projectId={projectId}
          chatroomName={chatroomName}
          filename={file.name}
          untrusted={outside}
          onClose={() => setIsModalOpen(false)}
        />,
        document.body
      )}
    </>
  )
}
