import type { ReactNode } from 'react'

/**
 * "How to set up <channel>" on each card of Agent Settings → Channels: one
 * closed-by-default disclosure (`SetupGuide`) and the step text for every
 * channel (`SETUP_GUIDES`), kept here so the four cards share one markup and
 * the wording can be reviewed in one file.
 *
 * Written for the owner connecting their own accounts in production. Field
 * and button names in the steps are the ones the connect forms show — keep
 * them in step when a form label changes. Sources: docs/channels/
 * GOLIVE_RUNBOOK.md and docs/channels/REHEARSAL.md.
 */

export type SetupChannel = 'telegram' | 'email' | 'line' | 'whatsapp'

export interface SetupGuideContent {
  /** The disclosure's label, e.g. "How to set up Telegram". */
  title: string
  steps: ReactNode[]
}

/** An outside page, always in a new tab. */
function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-purple-700 underline hover:text-purple-800">
      {children}
    </a>
  )
}

/** A label, button or menu name exactly as it appears on screen. */
function UI({ children }: { children: ReactNode }) {
  return <b className="font-semibold text-gray-800">{children}</b>
}

function Mono({ children }: { children: ReactNode }) {
  return <code className="font-mono text-[11px] bg-gray-100 px-1 py-0.5 rounded">{children}</code>
}

export const SETUP_GUIDES: Record<SetupChannel, SetupGuideContent> = {
  telegram: {
    title: 'How to set up Telegram',
    steps: [
      <>In Telegram, open a chat with <Ext href="https://t.me/BotFather">@BotFather</Ext> (it has a blue check mark) and send <Mono>/newbot</Mono>.</>,
      <>Give the bot a display name, then a username ending in <Mono>bot</Mono> (for example <Mono>acme_helper_bot</Mono>). Use a new bot: connecting points it at ClawMeets, replacing anything else that used it.</>,
      <>BotFather replies with a token like <Mono>123456789:AA…</Mono>. Paste it into <UI>Bot token</UI> and click <UI>Connect</UI>.</>,
      <>Under <UI>Allowlist</UI>, add <i>yourself</i>: your own Telegram @username (Telegram → Settings), not the bot&apos;s. No username? Message <Ext href="https://t.me/userinfobot">@userinfobot</Ext> and add the number it replies with.</>,
      <>Click <UI>Test</UI> — the status should read <UI>Working</UI>. Then open your bot in Telegram and send it a message; the reply comes back in the same chat.</>,
      <>Anyone not on the allowlist waits in <UI>Requests</UI> until you click <UI>Allow</UI>.</>,
      <><UI>Disable</UI> pauses the bot; messages sent while it&apos;s disabled are dropped, not delivered later. <UI>Remove</UI> disconnects it and deletes its allowlist and requests; conversations stay in your threads. If the token leaks, send <Mono>/revoke</Mono> to @BotFather, then Remove and connect again.</>,
    ],
  },
  email: {
    title: 'How to set up Email',
    steps: [
      <>Click <UI>Create email address</UI>. The agent gets its own address, shaped like <Mono>yourname.agentname@…</Mono> on this server's agent mail domain — copy the exact address from this card. No password or key is needed.</>,
      <>There is nothing to set up in DNS or SendGrid yourself. Mail to that address is received by SendGrid (Inbound Parse) and handed to the agent; the platform operator sets up the MX record for the inbound domain once, for everyone.</>,
      <>Replies are sent through SendGrid from the same address. If the status reads <UI>Replies can&apos;t be sent — the sending domain isn&apos;t set up at SendGrid</UI>, the sender identity isn&apos;t verified in SendGrid yet — ask the platform operator to finish it.</>,
      <>Under <UI>Allowlist</UI>, add who may write to the agent — your own address first — or <Mono>*@yourcompany.com</Mono> for everyone at a domain.</>,
      <>A sender only counts as on the allowlist when their mail passes the SPF or DKIM check (Gmail, Outlook and most providers do this automatically). Anything else waits in <UI>Requests</UI>.</>,
      <>Click <UI>Test</UI>, then email the agent&apos;s address from your own mailbox. A thread appears, and the reply arrives in the same email conversation.</>,
      <>Automatic mail — out-of-office replies, bounces, mailing lists and noreply senders — never starts a conversation or wakes the agent; inside an existing thread it is kept, marked as an automatic reply.</>,
      <><UI>Disable</UI> pauses the address; mail sent meanwhile is not delivered later. <UI>Remove</UI> stops mail reaching the agent and deletes its allowlist and requests; conversations stay in your threads.</>,
    ],
  },
  line: {
    title: 'How to set up LINE',
    steps: [
      <>Log in to the <Ext href="https://developers.line.biz/console/">LINE Developers Console</Ext> and create a <UI>provider</UI>. Create a LINE Official Account at <Ext href="https://entry.line.biz/start/">entry.line.biz</Ext> if you don&apos;t have one.</>,
      <>In <Ext href="https://manager.line.biz/">LINE Official Account Manager</Ext>, open the account: Settings → <UI>Messaging API</UI> → <UI>Enable Messaging API</UI>, and choose your provider.</>,
      <>Still there, Settings → <UI>Response settings</UI>: <UI>Webhooks</UI> ON, <UI>Auto-response messages</UI> OFF, <UI>Greeting message</UI> OFF — otherwise people get LINE&apos;s canned reply as well as the agent&apos;s.</>,
      <>In the Developers Console, open the provider, then the channel. On <UI>Basic settings</UI>, copy the <UI>Channel secret</UI>.</>,
      <>On the <UI>Messaging API</UI> tab, under <UI>Channel access token (long-lived)</UI>, click <UI>Issue</UI> and copy the token. While there, turn off <UI>Allow bot to join group chats</UI> — group chats aren&apos;t answered.</>,
      <>Paste both into <UI>Channel secret</UI> and <UI>Channel access token</UI> and click <UI>Connect LINE</UI>. ClawMeets sets the webhook URL for you. Connecting replaces any webhook URL already set on that channel, so use a channel nothing else depends on.</>,
      <>Add the account as a friend (scan the QR code on the Messaging API tab) and send it a message. You appear in <UI>Requests</UI> — click <UI>Allow</UI>. Then click <UI>Test</UI>.</>,
      <>The agent&apos;s answers are push messages, which count against the account&apos;s monthly free allowance (the size depends on your plan and region); the <UI>Push messages</UI> meter on this card tracks it. The acknowledgement doesn&apos;t use any.</>,
      <>After <UI>Remove</UI>, LINE keeps calling the old webhook until you turn <UI>Webhooks</UI> off in Response settings.</>,
    ],
  },
  whatsapp: {
    title: 'How to set up WhatsApp',
    steps: [
      <>At <Ext href="https://developers.facebook.com/apps/">Meta for Developers</Ext>, click <UI>Create app</UI>, choose the WhatsApp use case (<UI>Connect with customers through WhatsApp</UI>, a Business app) and link it to your business portfolio. Add your business phone number under <UI>WhatsApp → API Setup</UI>.</>,
      <>On <UI>WhatsApp → API Setup</UI>, copy the <UI>Phone number ID</UI> of your number (not the WhatsApp Business Account ID).</>,
      <>Under <UI>App settings → Basic</UI>, click <UI>Show</UI> next to <UI>App secret</UI> and copy it.</>,
      <>Create a permanent token: in <Ext href="https://business.facebook.com/settings">Business settings</Ext> → Users → <UI>System users</UI>, add an Admin system user, assign it your app and your WhatsApp account, then <UI>Generate new token</UI> with <Mono>whatsapp_business_messaging</Mono> and <Mono>whatsapp_business_management</Mono>. Don&apos;t use the temporary token on API Setup — it expires in 24 hours.</>,
      <>Make up a <UI>Verify token</UI>: any random value of at least 16 characters. Keep it — you&apos;ll paste the same value into Meta.</>,
      <>Paste <UI>Phone number ID</UI>, <UI>Access token</UI>, <UI>App secret</UI> and <UI>Verify token</UI> here and click <UI>Connect WhatsApp</UI>.</>,
      <>Copy the <UI>Callback URL</UI> shown on this card. In your Meta app, <UI>WhatsApp → Configuration</UI> → Webhook → Edit: paste it and your verify token, verify and save, then subscribe to the <Mono>messages</Mono> field.</>,
      <>Add your own number (with country code) to the <UI>Allowlist</UI>, message the business number from your phone, then click <UI>Test</UI>.</>,
      <>The agent can only reply within 24 hours of the person&apos;s last message (WhatsApp&apos;s customer-service window); later replies are held and not sent. After <UI>Remove</UI>, also delete the callback URL in Meta — we can&apos;t remove it for you.</>,
    ],
  },
}

/**
 * A closed-by-default disclosure of numbered steps, meant to sit at the bottom
 * of a SectionCard. `<details>` like the other help disclosures in Agent
 * Settings (fields.tsx `HelpDisclosure`, RuntimeSection's guides), so it is
 * keyboard- and screen-reader-operable with no state of its own.
 */
export function SetupGuide({ title, steps, testId }: SetupGuideContent & { testId?: string }) {
  return (
    <details className="group border-t border-gray-100" data-testid={testId}>
      <summary className="cursor-pointer select-none list-none px-6 py-3 flex items-center gap-2 text-sm font-semibold text-purple-700 hover:text-purple-800">
        <span className="inline-block transition-transform group-open:rotate-90" aria-hidden>▸</span>
        {title}
      </summary>
      <ol className="px-6 pb-5 pl-11 space-y-2 list-decimal text-xs text-gray-700 leading-relaxed">
        {steps.map((step, i) => <li key={i}>{step}</li>)}
      </ol>
    </details>
  )
}

export function ChannelSetupGuide({ channel }: { channel: SetupChannel }) {
  return <SetupGuide {...SETUP_GUIDES[channel]} testId={`setup-guide-${channel}`} />
}
