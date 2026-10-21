import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { BrandName } from '../common'
import Loading from '../common/Loading'
import { getShareInfo, joinSharedProject } from '../../api/endpoints'

export default function AcceptSharePage() {
  const { token } = useParams<{ token: string }>()
  const navigate = useNavigate()
  const [projectName, setProjectName] = useState<string | null>(null)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [joining, setJoining] = useState(false)
  const [alreadyAdded, setAlreadyAdded] = useState(false)
  const [isOwner, setIsOwner] = useState(false)

  useEffect(() => {
    if (!token) return

    // Clear the returnTo since we've arrived
    sessionStorage.removeItem('returnTo')

    getShareInfo(token)
      .then((data) => {
        setProjectName(data.project_name)
        setProjectId(data.project_id)
        setAlreadyAdded(data.already_added)
        setIsOwner(data.is_owner)
      })
      .catch((err) => setError(err.message || 'Invalid or expired share link'))
      .finally(() => setLoading(false))
  }, [token])

  const handleJoin = async () => {
    if (!token) return
    setJoining(true)
    try {
      const result = await joinSharedProject(token)
      navigate(`/projects/${result.project_id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to join project')
      setJoining(false)
    }
  }

  const handleGoToProject = () => {
    if (projectId) {
      navigate(`/projects/${projectId}`)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-sidebar to-purple-900">
      <div className="bg-white rounded-lg shadow-xl p-8 w-full max-w-md text-center">
        <h1 className="text-3xl font-bold mb-2">
          <BrandName className="text-gray-900" />
        </h1>

        {loading && (
          <div className="py-8">
            <Loading size="lg" />
          </div>
        )}

        {error && (
          <div className="py-6">
            <p className="text-red-600 mb-4">{error}</p>
            <button
              onClick={() => navigate('/projects')}
              className="text-purple-600 hover:text-purple-800 font-medium"
            >
              Go to projects
            </button>
          </div>
        )}

        {!loading && !error && projectName && (
          <div className="py-6">
            {isOwner ? (
              <>
                <p className="text-gray-600 mb-2">This is your project</p>
                <p className="text-xl font-semibold text-gray-900 mb-6">
                  {projectName}
                </p>
                <button
                  onClick={handleGoToProject}
                  className="w-full py-3 px-4 bg-accent text-white font-bold rounded-lg hover:bg-accent-deep transition-colors"
                >
                  Go to project
                </button>
              </>
            ) : alreadyAdded ? (
              <>
                <p className="text-gray-600 mb-2">
                  You already have access to
                </p>
                <p className="text-xl font-semibold text-gray-900 mb-6">
                  {projectName}
                </p>
                <button
                  onClick={handleGoToProject}
                  className="w-full py-3 px-4 bg-accent text-white font-bold rounded-lg hover:bg-accent-deep transition-colors"
                >
                  Open project
                </button>
              </>
            ) : (
              <>
                <p className="text-gray-600 mb-2">
                  You've been invited to view
                </p>
                <p className="text-xl font-semibold text-gray-900 mb-6">
                  {projectName}
                </p>
                <p className="text-sm text-gray-500 mb-6">
                  You'll be able to see messages, files, and participants in
                  read-only mode.
                </p>
                <button
                  onClick={handleJoin}
                  disabled={joining}
                  className="w-full py-3 px-4 bg-accent text-white font-bold rounded-lg hover:bg-accent-deep disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {joining ? (
                    <span className="flex items-center justify-center gap-2">
                      <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      Joining...
                    </span>
                  ) : (
                    'Add to my projects'
                  )}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
