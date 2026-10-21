import typography from '@tailwindcss/typography'

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./landing.html",
    "./private-beta-announcement.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    "./app/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Sidebar palette — remapped from Slack dark to the ClawMeets
        // token palette so existing `bg-sidebar` / `text-channel` classes
        // throughout the sidebar pick up the new light-lavender look.
        'sidebar': '#f3edf7',          // --bg-sidebar
        'sidebar-hover': '#ebe3f1',    // --bg-sidebar-section
        'sidebar-active': '#e4d6ef',   // --accent-soft
        'sidebar-text': '#433859',     // --ink-2
        'sidebar-text-active': '#52217b', // --accent-deep
        'channel': '#7a6e8c',          // --ink-3
        'channel-active': '#1f1826',   // --ink-1
        'border': '#dfd4e6',           // --line-2
        // ClawMeets purple accent
        accent: {
          DEFAULT: '#6b2aa0',
          deep: '#52217b',
          soft: '#e4d6ef',
          softer: '#f1e6fa',
          on: '#ffffff',
        },
        // Ink scale (text hierarchy)
        ink: {
          1: '#1f1826',
          2: '#433859',
          3: '#7a6e8c',
          4: '#a79bb7',
          'on-accent': '#ffffff',
        },
        // Inbox source colors (proposal-card left strip, source chips).
        // Values mirror --src-* in tokens.css.
        src: {
          email:   '#3b6fd1',
          sms:     '#2aa37a',
          chat:    '#b4458d',
          dm:      '#6b2aa0',
          mention: '#c07a1a',
          notif:   '#6f6f7a',
        },
        // Priority fg/bg pairs. Mirror --prio-* in tokens.css.
        prio: {
          'urgent-fg': '#9a2540', 'urgent-bg': '#f8dde4',
          'quick-fg':  '#0d6d57', 'quick-bg':  '#d9efe5',
          'normal-fg': '#433859', 'normal-bg': '#ece3f3',
          'low-fg':    '#6a6274', 'low-bg':    '#ececf0',
          'later-fg':  '#8a8294', 'later-bg':  '#f3f2f5',
        },
        // Interrupt banner (live-mode high-urgency arrival). Mirrors --interrupt-* in tokens.css.
        interrupt: {
          DEFAULT: '#c83358',
          bg: '#fff5f7',
          border: '#f3c9d2',
        },
        // Avatar background tints. Mirror --av-* in tokens.css.
        av: {
          pink:   '#e63b8a',
          teal:   '#0fb3a2',
          green:  '#2fbf5a',
          amber:  '#d48a1c',
          indigo: '#4b58c2',
          slate:  '#6f6f7a',
        },
      },
      fontFamily: {
        sans: ['Nunito', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 0 rgba(31,24,38,.04), 0 1px 2px rgba(31,24,38,.04)',
      },
    },
  },
  plugins: [typography],
}
