// Shared no-restricted-syntax entries. An override replaces a rule's options
// rather than merging them, so each block below lists every entry it needs.
const noRawHtml = (message) => [
  { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message },
  { selector: "Property[key.name='dangerouslySetInnerHTML']", message },
]
// Components ask hooks/useRoomTrust, which joins the whole-room rule with the
// per-author rule; calling useUntrustedBodies alone is how outside authors
// rendered trusted on the DM view, the Activity feed and the My Desk card.
const askRoomTrust = {
  selector: "CallExpression[callee.name='useUntrustedBodies']",
  message: 'Ask hooks/useRoomTrust: it joins the whole-room and per-author trust rules.',
}
// Every MarkdownBody that draws a room body states its trust on the element
// itself, and never as a literal false. (`:has(> …)` only looks at the
// element's own attributes, not at an element nested in a prop.)
const statedTrust = [
  {
    selector: "JSXOpeningElement[name.name='MarkdownBody']:not(:has(> JSXAttribute[name.name='untrusted']))",
    message: 'A room body passes untrusted (computed by hooks/useRoomTrust).',
  },
  {
    selector: "JSXOpeningElement[name.name='MarkdownBody'] > JSXAttribute[name.name='untrusted'] > JSXExpressionContainer > Literal[value=false]",
    message: 'A room body never passes untrusted={false}; pass the value from hooks/useRoomTrust.',
  },
]
// Every file list, file row and file viewer on a room surface states whether
// the file came from outside, and never as a literal "trusted": a FileList
// without isOutsideFile is how the DM Files sidebar opened another account's
// HTML file with the app's origin. A FileViewerModal of a staged local `file`
// is the user's own and needs no answer.
const statedFileTrust = [
  {
    selector: "JSXOpeningElement[name.name='FileList']:not(:has(> JSXAttribute[name.name='isOutsideFile']))",
    message: 'A FileList passes isOutsideFile (utils/roomTrust outsideFileNames).',
  },
  {
    selector: "JSXOpeningElement[name.name='FileItem']:not(:has(> JSXAttribute[name.name='outside']))",
    message: 'A FileItem passes outside (utils/roomTrust).',
  },
  {
    selector: "JSXOpeningElement[name.name='FileViewerModal']:not(:has(> JSXAttribute[name.name='untrusted'])):not(:has(> JSXAttribute[name.name='file']))",
    message: 'A chatroom FileViewerModal passes untrusted (hooks/useRoomTrust).',
  },
  {
    selector: "JSXOpeningElement[name.name=/^(FileViewerModal|FileItem)$/] > JSXAttribute[name.name=/^(untrusted|outside)$/] > JSXExpressionContainer > Literal[value=false]",
    message: 'A room file never passes a literal false; pass the value from utils/roomTrust.',
  },
  {
    selector: "JSXOpeningElement[name.name='FileList'] > JSXAttribute[name.name='isOutsideFile'] > JSXExpressionContainer > ArrowFunctionExpression > Literal[value=false]",
    message: 'A FileList never answers a literal false; pass outsideFileNames from utils/roomTrust.',
  },
]

module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2021,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  env: { browser: true, es2021: true, node: true },
  ignorePatterns: [
    'dist',
    'node_modules',
    'coverage',
    '*.config.ts',
    '*.config.js',
    '*.cjs',
    'public',
  ],
  overrides: [
    // A message body is drawn through shared/MarkdownBody, whose untrusted mode
    // is the one place remote Markdown is fenced. A new bare ReactMarkdown is
    // how a Hub body last reached the page with images on (ActivityFeed).
    // The files below draw text that never comes from a message:
    //   PlanBody: a project's PLAN.md (a Hub thread has no plan);
    //   SampleRequestBody: the server's own template text;
    //   FilePreview: a file's trusted render; its untrusted path is MarkdownBody.
    // Later overrides restate react-markdown in their own pattern lists, since
    // an override replaces a rule's options rather than merging them.
    {
      files: ['src/**/*.ts', 'src/**/*.tsx'],
      excludedFiles: [
        'src/**/*.test.ts',
        'src/**/*.test.tsx',
        'src/components/shared/MarkdownBody.tsx',
        'src/components/project/plan/PlanBody.tsx',
        'src/components/sample-request/SampleRequestBody.tsx',
        'src/components/files/FilePreview.tsx',
      ],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              {
                name: 'react-markdown',
                message: 'Draw message bodies with shared/MarkdownBody (untrusted for remote bodies).',
              },
            ],
          },
        ],
      },
    },
    // Every component asks hooks/useRoomTrust for a room's trust.
    {
      files: ['src/components/**'],
      excludedFiles: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
      rules: { 'no-restricted-syntax': ['error', askRoomTrust, ...statedFileTrust] },
    },
    // Text from another server reaches these files. It renders as React text
    // nodes only; the one Markdown path is HubMessageBody (untrusted mode).
    // `npm run lint` runs with --no-inline-config, so no comment can lift this.
    {
      files: [
        'src/components/hub/**',
        'src/components/settings/agent/HubChannelCard.tsx',
        'src/components/settings/agent/HubTurnOffDialog.tsx',
        'src/components/settings/agent/BlockedDeploymentsCard.tsx',
        // Outside the hub folder, these draw hub names and labels too.
        'src/components/sidebar/PublicPanel.tsx',
        'src/components/sidebar/FrontDeskPanel.tsx',
        'src/components/settings/agent/ChannelsSection.tsx',
      ],
      rules: {
        'no-restricted-syntax': ['error', ...noRawHtml('Remote hub text renders as plain text only.'), askRoomTrust, ...statedFileTrust],
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['**/MarkdownBody', '**/MarkdownBody.tsx', 'react-markdown'],
                message: 'Render remote message bodies with components/hub/HubMessageBody.',
              },
            ],
          },
        ],
      },
    },
    // The surfaces that draw room bodies of outside authors (stand-ins, other
    // accounts, requesters) next to trusted ones, decided per message by
    // hooks/useRoomTrust. Every MarkdownBody here states which it is.
    {
      files: [
        'src/components/chatroom/**',
        'src/components/dm/**',
        'src/components/project/ActivityFeed.tsx',
        'src/components/desk/UpdateCard.tsx',
        'src/components/files/**',
      ],
      excludedFiles: [
        'src/**/*.test.ts',
        'src/**/*.test.tsx',
        // Its code blocks are highlight.js's escaped HTML (the block below).
        'src/components/files/HighlightedCode.tsx',
      ],
      rules: {
        'no-restricted-syntax': [
          'error',
          ...noRawHtml('A room body renders through MarkdownBody, never raw HTML.'),
          ...statedTrust,
          askRoomTrust,
          ...statedFileTrust,
        ],
      },
    },
    {
      files: ['src/components/files/HighlightedCode.tsx'],
      rules: { 'no-restricted-syntax': ['error', ...statedTrust, askRoomTrust, ...statedFileTrust] },
    },
    {
      files: ['src/components/hub/HubMessageBody.tsx'],
      rules: {
        'no-restricted-imports': [
          'error',
          { paths: [{ name: 'react-markdown', message: 'HubMessageBody draws through MarkdownBody untrusted.' }] },
        ],
      },
    },
  ],
}
