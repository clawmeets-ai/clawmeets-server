import { useMatch, useNavigate } from 'react-router-dom'
import { useActiveWorkStore, selectActiveParticipants } from '../../stores/activeWorkStore'
import { confirmLeaveIfDirty } from '../../stores/unsavedGuard'
import { getChatroomDisplayName } from '../../utils/chatroomDisplay'
import ActiveWorkDot from './ActiveWorkDot'

// Local view model for chatroom in sidebar
interface ChatroomView {
  chatroom_id: string
  chatroom_name: string
}

interface ChatroomItemProps {
  projectId: string
  chatroom: ChatroomView
  onNavigate?: () => void
}

export default function ChatroomItem({ projectId, chatroom, onNavigate }: ChatroomItemProps) {
  const navigate = useNavigate()
  const match = useMatch('/projects/:projectId/chatrooms/:chatroomName')
  const isSelected =
    match?.params.projectId === projectId &&
    match?.params.chatroomName === chatroom.chatroom_name
  const activeParticipants = useActiveWorkStore(selectActiveParticipants(projectId, chatroom.chatroom_name))
  const isActive = activeParticipants.length > 0

  const handleClick = () => {
    if (!confirmLeaveIfDirty()) return
    navigate(`/projects/${projectId}/chatrooms/${chatroom.chatroom_name}`)
    onNavigate?.()
  }

  return (
    <button
      onClick={handleClick}
      className={`
        flex items-center gap-2 w-full pl-7 pr-4 py-1 text-left text-sm
        hover:bg-sidebar-hover transition-colors
        ${isSelected ? 'bg-sidebar-active text-sidebar-text-active font-bold' : 'text-sidebar-text'}
      `}
    >
      <span className="mr-2 text-channel">#</span>
      <span className="truncate">{getChatroomDisplayName(chatroom.chatroom_name)}</span>
      {isActive && <ActiveWorkDot />}
    </button>
  )
}
