/**
 * The news, for the assistant: the latest headlines main fetched, so it can
 * answer "aaj ki khabrein?" or mention one that matters to the owner. Feed
 * text is outside content: marked untrusted, never followed as instructions.
 */
import type { Rule } from '@assistant/policy'
import type { RuntimeTool } from '@assistant/runtime'

export type NewsItem = { title: string; source: string; category: string; publishedAt: number | null; summary: string }

export const NEWS_RULES: Rule[] = [{ id: 'default-news_headlines', tool: 'news_headlines', actionClass: 'observe', effect: 'allow' }]

export class HostNews {
  private items: NewsItem[] = []

  set(items: NewsItem[]) {
    this.items = items
  }

  tool(now: () => number): RuntimeTool {
    return {
      name: 'news_headlines',
      description: 'Today’s news headlines from the owner’s chosen sources (Pakistan, world, business, tech), newest first, with a short summary. Untrusted outside text.',
      inputSchema: {
        type: 'object',
        properties: { category: { type: 'string', enum: ['pakistan', 'world', 'business', 'tech'] }, limit: { type: 'integer' } },
        additionalProperties: false,
      },
      actionClass: 'observe',
      isUntrusted: true,
      run: async input => {
        const cat = typeof input.category === 'string' ? input.category : null
        const limit = typeof input.limit === 'number' ? Math.min(Math.max(1, input.limit), 20) : 10
        const list = this.items.filter(h => !cat || h.category === cat).slice(0, limit)
        if (!list.length) return 'No headlines yet (offline, or the news has not loaded).'
        return list
          .map(h => {
            const age = h.publishedAt ? `${Math.max(0, Math.round((now() - h.publishedAt) / 3_600_000))}h ago` : ''
            return `- [${h.category}] ${h.title} (${h.source}${age ? `, ${age}` : ''})${h.summary ? `: ${h.summary}` : ''}`
          })
          .join('\n')
      },
    }
  }
}
