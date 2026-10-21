/**
 * App-level legal document URLs, referenced anywhere we need to link a user to
 * the Privacy Policy / Terms of Service (e.g. the OAuth pre-consent modal).
 *
 * These mirror the anchors already used on the signup screen
 * (`components/auth/SignupPage.tsx` → `/tos`, `/privacy`), which are the same
 * documents Google renders on its consent screen today. Kept in one place so a
 * future move to a marketing-site URL is a single edit.
 */
export const PRIVACY_POLICY_URL = '/privacy'
export const TERMS_URL = '/tos'
