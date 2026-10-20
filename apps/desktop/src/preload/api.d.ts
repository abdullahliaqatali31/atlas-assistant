import type { ActivityBridge } from '../shared/activity.ts'
import type { BackupBridge } from '../shared/backup.ts'
import type { CodeBridge } from '../shared/code.ts'
import type { ControlBridge } from '../shared/control.ts'
import type { DesktopBridge } from '../shared/desktop.ts'
import type { FilesBridge } from '../shared/files.ts'
import type { MapOpsBridge } from '../shared/map.ts'
import type { UiBridge } from '../shared/ui.ts'
import type { WorldBridge } from '../shared/world.ts'
import type { IdentityBridge } from '../shared/identity.ts'
import type { LearningBridge } from '../shared/learning.ts'
import type { AssistantBridge } from '../shared/ipc.ts'
import type { NewsBridge } from '../shared/news.ts'
import type { PersonalityBridge } from '../shared/personality.ts'
import type { ProjectsBridge } from '../shared/projects.ts'
import type { WakeBridge } from '../shared/wake.ts'
import type { PresenceBridge, PresenceHostBridge } from '../shared/presence.ts'
import type { GlassBridge } from '../shared/glass.ts'
import type { PcBridge } from '../shared/system.ts'
import type { BrainBridge } from '../shared/brain.ts'
import type { PowerUpBridge } from '../shared/powerup.ts'
import type { BrowserTabsBridge } from '../shared/browser.ts'

declare global {
  interface Window {
    assistant: AssistantBridge
    presenceHost: PresenceHostBridge
    pc: PcBridge
    powerup: PowerUpBridge
    /** Only in the desktop widget's page. */
    presence: PresenceBridge
    /** Only in the glass panel's page. */
    glass: GlassBridge
    controls: ControlBridge
    personality: PersonalityBridge
    activity: ActivityBridge
    projects: ProjectsBridge
    news: NewsBridge
    identity: IdentityBridge
    wake: WakeBridge
    learning: LearningBridge
    backup: BackupBridge
    code: CodeBridge
    files: FilesBridge
    desktop: DesktopBridge
    ui: UiBridge
    brain: BrainBridge
    mapOps: MapOpsBridge
    world: WorldBridge
    atlasTabs: BrowserTabsBridge
  }
}
