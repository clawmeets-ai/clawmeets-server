import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { getCurrentUser, changePassword } from '../../api/endpoints/auth'
import { useAuthStore } from '../../stores/authStore'
import { PageShell, PageHeader, SectionCard, SectionHeader, InfoRow, Alert, Badge } from './primitives'
import { User, Lock, LogOut } from 'lucide-react'
import ReflectionScheduleSection from './ReflectionScheduleSection'
import KnowledgePacksSection from './KnowledgePacksSection'
import DefaultModelSection from './DefaultModelSection'
import { useLogout } from '../../hooks/useLogout'

export default function UserSettingsPage() {
  const { user } = useAuthStore()
  const logout = useLogout()

  const { data: fullUser } = useQuery({
    queryKey: ['user', 'me'],
    queryFn: getCurrentUser,
    enabled: !!user,
  })

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [validationError, setValidationError] = useState('')
  const [successMessage, setSuccessMessage] = useState('')

  const mutation = useMutation({
    mutationFn: () => changePassword(currentPassword, newPassword),
    onSuccess: (data) => {
      setSuccessMessage(data.message)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setValidationError('')
    },
    onError: (error: Error) => {
      setValidationError(error.message)
      setSuccessMessage('')
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setValidationError('')
    setSuccessMessage('')

    if (newPassword.length < 6) {
      setValidationError('New password must be at least 6 characters')
      return
    }
    if (newPassword !== confirmPassword) {
      setValidationError('Passwords do not match')
      return
    }

    mutation.mutate()
  }

  const inputClasses ="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-purple-500/20 focus:border-purple-400 transition-colors bg-gray-50/50 placeholder-gray-400"
  const labelClasses = "block text-sm font-semibold text-gray-800 mb-1.5"
  const helperClasses = "mt-1.5 text-xs text-gray-500"
  const primaryBtnClasses = "px-4 py-2 text-sm font-bold bg-accent text-white rounded-lg hover:bg-accent-deep focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-purple-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"

  return (
    <PageShell>
        <PageHeader
          title="Account Settings"
          subtitle="Manage your profile, notifications, and security"
        />

        {/* Profile */}
        <SectionCard>
          <SectionHeader title="Profile" icon={<User className="w-4 h-4" />} />
          <div className="px-6 py-5">
            <div className="grid grid-cols-2 gap-x-8 gap-y-3.5">
              <InfoRow label="Username">
                {fullUser?.username || user?.username}
              </InfoRow>
              <InfoRow label="Email">
                <span className="flex items-center gap-1.5">
                  {fullUser?.email || 'Not set'}
                  {fullUser?.email_verified && <Badge variant="success">Verified</Badge>}
                </span>
              </InfoRow>
            </div>
          </div>
        </SectionCard>

        {/* The model every new agent starts with */}
        <DefaultModelSection />

        {/* Memory & Reflection */}
        <ReflectionScheduleSection />

        {/* Knowledge Packs */}
        <KnowledgePacksSection />

        {/* Password */}
        <SectionCard>
          <SectionHeader title="Security" icon={<Lock className="w-4 h-4" />} />
          <div className="px-6 py-5">
            {successMessage && <div className="mb-4"><Alert type="success" message={successMessage} /></div>}
            {validationError && <div className="mb-4"><Alert type="error" message={validationError} /></div>}

            <form onSubmit={handleSubmit} className="space-y-3">
              <div>
                <label className={labelClasses}>Current Password</label>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  className={inputClasses}
                  required
                />
              </div>
              <div>
                <label className={labelClasses}>New Password</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className={inputClasses}
                  required
                  minLength={6}
                />
                <p className={helperClasses}>Minimum 6 characters</p>
              </div>
              <div>
                <label className={labelClasses}>Confirm New Password</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className={inputClasses}
                  required
                />
              </div>
              <div className="pt-1">
                <button
                  type="submit"
                  disabled={mutation.isPending || !currentPassword || !newPassword || !confirmPassword}
                  className={primaryBtnClasses}
                >
                  {mutation.isPending ? 'Changing...' : 'Change Password'}
                </button>
              </div>
            </form>
          </div>
        </SectionCard>

        {/* Session */}
        <SectionCard>
          <SectionHeader title="Session" icon={<LogOut className="w-4 h-4" />} />
          <div className="px-6 py-5">
            <button
              onClick={logout}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-bold text-red-600 border border-red-200 rounded-lg hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 transition-colors"
            >
              <LogOut className="w-4 h-4" />
              Log out
            </button>
            <p className="mt-2 text-xs text-gray-500">Sign out of ClawMeets on this device.</p>
          </div>
        </SectionCard>
    </PageShell>
  )
}
