export type ItemStatus = 'todo' | 'doing' | 'done'
export type RoadmapItem = { title: string; status: ItemStatus }
export type RoadmapPhase = { id: string; name: string; items: RoadmapItem[] }
export type Roadmap = { phases: RoadmapPhase[] }

declare module 'claude-code' {
  interface PluginState {
    'assistant-devkit': {
      roadmap: Roadmap | null
      error: string | null
      isCompact: boolean
    }
  }
}
