/** The command palette's search: every typed word must appear somewhere in the command. */
export interface Searchable {
  label: string
  group: string
  keywords?: string | undefined
  hint?: string | undefined
}

export const searchCommands = <T extends Searchable>(all: T[], query: string, limit = 40): T[] => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return all.slice(0, limit)
  return all.filter(c => words.every(w => `${c.label} ${c.group} ${c.keywords ?? ''} ${c.hint ?? ''}`.toLowerCase().includes(w))).slice(0, limit)
}
