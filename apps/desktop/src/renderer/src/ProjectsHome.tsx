import { Code2, FolderKanban } from 'lucide-react'
import { useState } from 'react'

import { CodeProjects } from './CodeProjects.tsx'
import { Projects } from './Projects.tsx'

/** The Projects screen: coding projects (measured, runnable) and plans with tasks and commitments. */
export function ProjectsHome() {
  const [tab, setTab] = useState<'code' | 'plans'>(() => {
    try {
      return localStorage.getItem('projects.tab') === 'plans' ? 'plans' : 'code'
    } catch {
      return 'code'
    }
  })
  const choose = (t: 'code' | 'plans') => {
    setTab(t)
    try {
      localStorage.setItem('projects.tab', t)
    } catch {
      // Remembering the tab is a convenience only.
    }
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <nav className="flex gap-1 border-b border-border px-3 pt-2" role="tablist" aria-label="Projects">
        {(
          [
            ['code', 'Code', <Code2 key="c" className="size-3.5" aria-hidden />],
            ['plans', 'Plans & tasks', <FolderKanban key="p" className="size-3.5" aria-hidden />],
          ] as const
        ).map(([id, label, icon]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => choose(id)}
            className={`flex items-center gap-1.5 rounded-t-lg border-b-2 px-3 py-1.5 text-sm transition-colors ${tab === id ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-text'}`}
          >
            {icon}
            {label}
          </button>
        ))}
      </nav>
      <div className="min-h-0 flex-1">{tab === 'code' ? <CodeProjects /> : <Projects />}</div>
    </div>
  )
}
