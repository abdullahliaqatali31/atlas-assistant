/** Headlines for the Jarvis panel, fetched in main from public RSS feeds (no account, no key). */

export const NC = {
  list: 'news:list',
} as const

export interface Headline {
  title: string
  /** https link to the article, opened in the default browser. */
  link: string
  source: string
  publishedAt: number | null
}

export interface NewsResult {
  headlines: Headline[]
  /** When the feeds were last fetched successfully. */
  fetchedAt: number | null
  /** Feeds that failed on the last refresh, by source name. */
  failed: string[]
}

export interface NewsBridge {
  list(refresh?: boolean): Promise<NewsResult>
}
