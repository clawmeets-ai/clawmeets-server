import type { FileInfo } from '../../types'
import FileItem from './FileItem'

interface FileListProps {
  files: FileInfo[]
  projectId: string
  chatroomName: string
  /** Files whose content came from outside (utils/roomTrust outsideFileNames)
   *  get the "outside content" badge and open untrusted. Required: a caller
   *  that forgets it must not get a trusted default. */
  isOutsideFile: (name: string) => boolean
}

export default function FileList({ files, projectId, chatroomName, isOutsideFile }: FileListProps) {
  if (files.length === 0) {
    return (
      <div className="text-sm text-gray-500 text-center py-4">
        No files yet
      </div>
    )
  }

  // Sort files: special files first, then alphabetically
  const specialFiles = ['PARTICIPANTS.md', 'CHATS.ndjson', 'PLAN.md', 'AGENTS.md']
  const sortedFiles = [...files]
    .filter((f) => f && f.name)  // Filter out invalid entries
    .sort((a, b) => {
      const aIsSpecial = specialFiles.includes(a.name)
      const bIsSpecial = specialFiles.includes(b.name)
      if (aIsSpecial && !bIsSpecial) return -1
      if (!aIsSpecial && bIsSpecial) return 1
      return a.name.localeCompare(b.name)
    })

  return (
    <div className="space-y-1">
      {sortedFiles.map((file) => (
        <FileItem
          key={file.name}
          file={file}
          projectId={projectId}
          chatroomName={chatroomName}
          outside={isOutsideFile(file.name)}
        />
      ))}
    </div>
  )
}
