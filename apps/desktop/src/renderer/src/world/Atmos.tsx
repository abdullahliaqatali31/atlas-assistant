/**
 * The World map's own skin, the same on the flat map and in 3D: a faint hex
 * grid that drifts, fine scanlines, a soft scan light that passes now and
 * then, film grain, a breathing Atlas mark and a vignette, all tinted by the
 * theme's accent. CSS only (compositor animations), nothing to pick, and
 * still in Lite mode or when the system asks for less motion.
 */
import logo from '../assets/logo.svg'

export function Atmos({ dim = false }: { dim?: boolean }) {
  return (
    <div className={`atmos ${dim ? 'atmos-dim' : ''}`} aria-hidden>
      <div className="atmos-hex" />
      <div className="atmos-lines" />
      <div className="atmos-sweep" />
      <div className="atmos-grain" />
      <img src={logo} alt="" className="atmos-mark" draggable={false} />
      <div className="atmos-vignette" />
    </div>
  )
}
