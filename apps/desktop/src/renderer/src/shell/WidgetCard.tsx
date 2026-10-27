/**
 * Settings › Appearance › Desktop widget: Atlas in a small glass window
 * outside the browser. On or off, above other windows, following a newly
 * connected display, its size and corner, and the displays it knows.
 */
import { AppWindow, MonitorSmartphone } from 'lucide-react'
import { useEffect, useState } from 'react'

import { CORNERS, displayLabel, WIDGET_MODES, type Corner, type WidgetMode, type WidgetSettings, type WidgetView } from '../../../shared/widget.ts'
import { nameOf } from '../ui/assistantName.ts'

const MODE_LABEL: Record<WidgetMode, string> = { orb: 'Orb', bar: 'Bar', chat: 'Chat', glass: 'Glass' }
const CORNER_LABEL: Record<Corner, string> = { 'top-right': 'Top right', 'top-left': 'Top left', 'bottom-right': 'Bottom right', 'bottom-left': 'Bottom left', center: 'Centre' }

export function WidgetCard() {
  const [view, setView] = useState<WidgetView | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    void window.widget.get().then(setView, () => undefined)
    return window.widget.onChanged(setView)
  }, [])
  if (!view) return null
  const set = (change: Partial<WidgetSettings>) =>
    void window.widget.set(change).then(setView, e => setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Could not change it.'))

  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <AppWindow className="size-4 text-accent" aria-hidden /> Desktop widget
      </h3>
      {!view.available ? (
        <p className="text-xs text-muted">The desktop widget works on Windows for now; on a Mac it comes with the menu-bar helper.</p>
      ) : (
        <>
          <p className="text-xs text-muted">
            {nameOf()} in a small glass window above your apps: talk, type, see what it says, answer its questions, without opening the browser. Drag it anywhere: it stays where you put it. In the orb, point at it to get buttons that open it again. Ask {nameOf()} to move it (“widget dusri screen pe le jao”) or make it bigger.
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={view.enabled} onChange={e => set({ enabled: e.target.checked })} /> Show the widget
            {view.enabled && <span className="text-xs text-muted">· {view.running ? 'showing' : 'starting…'}</span>}
          </label>
          {view.enabled && (
            <div className="space-y-2 pl-6">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={view.onTop} onChange={e => set({ onTop: e.target.checked })} /> Above other windows
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={view.followNewDisplays} onChange={e => set({ followNewDisplays: e.target.checked })} /> Move to a display when it is connected (and show it)
              </label>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted">Look</span>
                {([['clear', 'Clear (see-through)'], ['frosted', 'Frosted glass']] as const).map(([l, label]) => (
                  <button key={l} type="button" onClick={() => set({ look: l })} className={`rounded-full border px-2.5 py-0.5 text-xs ${view.look === l ? 'border-accent text-accent' : 'border-border text-muted hover:text-text'}`}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted">Size</span>
                {WIDGET_MODES.map(m => (
                  <button key={m} type="button" onClick={() => set({ mode: m })} className={`rounded-full border px-2.5 py-0.5 text-xs ${view.mode === m ? 'border-accent text-accent' : 'border-border text-muted hover:text-text'}`}>
                    {MODE_LABEL[m]}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted">Corner</span>
                {CORNERS.map(c => (
                  <button key={c} type="button" onClick={() => set({ corner: c })} className={`rounded-full border px-2.5 py-0.5 text-xs ${view.corner === c ? 'border-accent text-accent' : 'border-border text-muted hover:text-text'}`}>
                    {CORNER_LABEL[c]}
                  </button>
                ))}
              </div>
              {view.displays.length > 0 && (
                <ul className="space-y-0.5 text-xs text-muted">
                  {view.displays.map(d => (
                    <li key={d.id} className="flex items-center gap-1.5">
                      <MonitorSmartphone className="size-3.5" aria-hidden /> {displayLabel(d, view.displays)}
                      {view.on === d.id && <span className="text-accent">· the widget is here</span>}
                    </li>
                  ))}
                </ul>
              )}
              {view.look === 'frosted' && !view.acrylic && view.running && <p className="text-xs text-muted">Frosted glass needs Windows 11; here it has its own dark background.</p>}
            </div>
          )}
          {(error || view.error) && <p className="text-xs text-danger">{error || view.error}</p>}
        </>
      )}
    </section>
  )
}
