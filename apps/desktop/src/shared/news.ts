/**
 * News for the home canvas and the News page, fetched in main from public
 * RSS feeds (no account, no key). Pictures come through main too, from the
 * assistant-news:// scheme, so the window itself never reaches the internet.
 */

export const NC = {
  list: 'news:list',
  sources: 'news:sources',
  setSources: 'news:set-sources',
  saved: 'news:saved',
  save: 'news:save',
  unsave: 'news:unsave',
  changed: 'news:changed',
} as const

/** Served by main from its image cache. */
export const NEWS_SCHEME = 'assistant-news'

export const CATEGORIES = ['pakistan', 'world', 'business', 'tech'] as const
export type Category = (typeof CATEGORIES)[number]
export const CATEGORY_LABEL: Record<Category, string> = { pakistan: 'Pakistan', world: 'World', business: 'Business', tech: 'Tech' }

export interface Headline {
  /** Stable id from the link. */
  id: string
  title: string
  /** https link to the article, opened in the default browser. */
  link: string
  source: string
  category: Category
  publishedAt: number | null
  /** A couple of sentences from the feed, plain text. */
  summary: string
  /** assistant-news://img/<key>, or null when the feed has no picture. */
  image: string | null
}

export interface SavedHeadline extends Headline {
  savedAt: number
}

export interface NewsResult {
  headlines: Headline[]
  /** When the feeds were last fetched successfully. */
  fetchedAt: number | null
  /** Feeds that failed on the last refresh, by source name. */
  failed: string[]
}

export interface NewsSource {
  id: string
  name: string
  category: Category
  enabled: boolean
}

export interface NewsBridge {
  list(refresh?: boolean): Promise<NewsResult>
  sources(): Promise<NewsSource[]>
  setSources(enabledIds: string[]): Promise<NewsSource[]>
  saved(): Promise<SavedHeadline[]>
  save(id: string): Promise<SavedHeadline[]>
  unsave(id: string): Promise<SavedHeadline[]>
  onChanged(cb: (r: NewsResult) => void): () => void
}
