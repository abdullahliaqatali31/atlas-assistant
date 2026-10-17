/**
 * Curated calendar and email connectors (plan 13.1 and 13.2). Each is an
 * existing open source MCP server, started read-only: write tools are not
 * exposed by the server where it supports that, and the host drops any tool
 * not classified observe. The listed read tools are classified observe by
 * this catalogue (the owner chose the connector), everything else keeps the
 * strictest class and is therefore never offered while `readOnly` is set.
 *
 * Package names and tool names were checked against each project's README on
 * 17 October 2026; argument shapes are not yet validated against live
 * accounts (Phase 0 "one MCP server end to end").
 */
import type { ActionClass } from '@assistant/policy'

import type { BriefingCall, ServerConfig } from './index.ts'

export type { BriefingCall, ServerConfig }

export type ConnectorId = 'google-calendar' | 'gmail' | 'microsoft-365'

export interface ConnectorEntry {
  id: ConnectorId
  label: string
  kinds: ('calendar' | 'email')[]
  description: string
  /** What the owner does once before enabling (OAuth app, sign-in). */
  setup: string
  homepage: string
  /** Environment variable the server reads an OAuth client file from, picked by the owner in Connections. */
  credentialsEnv?: string
  server: ServerConfig
}

const observe = (tools: string[]): Record<string, ActionClass> => Object.fromEntries(tools.map(t => [t, 'observe' as const]))

const GOOGLE_CALENDAR_READS = ['list-calendars', 'list-events', 'get-event', 'search-events', 'get-freebusy', 'get-current-time']
const GMAIL_READS = ['search_emails', 'read_email', 'list_email_labels']
const MS365_READS = ['list-mail-messages', 'get-mail-message', 'list-calendar-events', 'get-calendar-event', 'get-calendar-view', 'list-calendars']

const calendarToday = (label: string, tool: string, args: Record<string, unknown>): BriefingCall => ({ kind: 'calendar', label, tool, args })

export const CONNECTORS: readonly ConnectorEntry[] = [
  {
    id: 'google-calendar',
    label: 'Google Calendar',
    kinds: ['calendar'],
    description: "Today's meetings and deadlines for the briefing. Read-only.",
    setup:
      'Create a Google Cloud OAuth client (Desktop app), download gcp-oauth.keys.json and set GOOGLE_OAUTH_CREDENTIALS to its path. The first start opens a Google sign-in in your browser.',
    homepage: 'https://github.com/nspady/google-calendar-mcp',
    credentialsEnv: 'GOOGLE_OAUTH_CREDENTIALS',
    server: {
      enabled: false,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@cocal/google-calendar-mcp'],
      // The server itself only exposes read tools. Add GOOGLE_OAUTH_CREDENTIALS here (see setup).
      env: { ENABLED_TOOLS: GOOGLE_CALENDAR_READS.join(',') },
      readOnly: true,
      overrides: observe(GOOGLE_CALENDAR_READS),
      briefing: [calendarToday('Google Calendar', 'list-events', { calendarId: 'primary', timeMin: '{dayStart}', timeMax: '{dayEnd}' })],
    },
  },
  {
    id: 'gmail',
    label: 'Gmail',
    kinds: ['email'],
    description: 'Unread client requests and follow-ups for the briefing. Read-only: no sending, labelling or deleting.',
    setup:
      'Put your Google OAuth gcp-oauth.keys.json in ~/.gmail-mcp/ and run `npx @gongrzhe/server-gmail-autoauth-mcp auth` once to sign in.',
    homepage: 'https://github.com/GongRzhe/Gmail-MCP-Server',
    server: {
      enabled: false,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
      readOnly: true,
      overrides: observe(GMAIL_READS),
      briefing: [{ kind: 'email', label: 'Gmail', tool: 'search_emails', args: { query: 'is:unread newer_than:2d -category:promotions -category:social', maxResults: 10 } }],
    },
  },
  {
    id: 'microsoft-365',
    label: 'Microsoft 365 (Outlook mail and calendar)',
    kinds: ['calendar', 'email'],
    description: "Outlook mail and today's calendar through Microsoft Graph. Read-only.",
    setup: 'Run `npx @softeria/ms-365-mcp-server --login` once and follow the device-code sign-in.',
    homepage: 'https://github.com/Softeria/ms-365-mcp-server',
    server: {
      enabled: false,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@softeria/ms-365-mcp-server', '--read-only'],
      readOnly: true,
      overrides: observe(MS365_READS),
      briefing: [
        calendarToday('Outlook Calendar', 'get-calendar-view', { startDateTime: '{dayStart}', endDateTime: '{dayEnd}' }),
        { kind: 'email', label: 'Outlook', tool: 'list-mail-messages', args: {} },
      ],
    },
  },
]

export const connectorById = (id: string): ConnectorEntry | undefined => CONNECTORS.find(c => c.id === id)

/** A fresh, disabled server config for a connector (a copy the owner's file can own). */
export const connectorServer = (id: ConnectorId): ServerConfig => structuredClone(connectorById(id)!.server)
