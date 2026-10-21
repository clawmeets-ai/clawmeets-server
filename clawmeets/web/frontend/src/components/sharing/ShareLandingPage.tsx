import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { BrandName } from '../common'
import Loading from '../common/Loading'

const BASE_URL = import.meta.env.DEV ? '/api' : ''

export default function ShareLandingPage() {
  const { token } = useParams<{ token: string }>()
  const [projectName, setProjectName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!token) return

    // Save return path so login/signup can redirect back
    sessionStorage.setItem('returnTo', `/shared/${token}`)

    // Fetch public token info (no auth required)
    fetch(`${BASE_URL}/shared/${token}/info`, {
      headers: { 'bypass-tunnel-reminder': 'true' },
    })
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => null)
          throw new Error(data?.detail || 'Invalid or expired share link')
        }
        return res.json()
      })
      .then((data) => setProjectName(data.project_name))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [token])

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
            <Link
              to="/"
              className="text-purple-600 hover:text-purple-800 font-medium"
            >
              Go to home page
            </Link>
          </div>
        )}

        {!loading && !error && projectName && (
          <div className="py-6">
            <p className="text-gray-600 mb-2">You've been invited to view</p>
            <p className="text-xl font-semibold text-gray-900 mb-6">
              {projectName}
            </p>
            <p className="text-gray-500 mb-6">
              Sign in or create an account to view this project.
            </p>
            <div className="space-y-3">
              <Link
                to="/login"
                className="block w-full py-3 px-4 bg-accent text-white font-bold rounded-lg hover:bg-accent-deep transition-colors"
              >
                Sign in
              </Link>
              <Link
                to="/signup"
                className="block w-full py-3 px-4 border border-gray-300 text-gray-700 font-medium rounded-lg hover:bg-gray-50 transition-colors"
              >
                Create account
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
