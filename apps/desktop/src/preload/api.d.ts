import type { ActivityBridge } from '../shared/activity.ts'
import type { BackupBridge } from '../shared/backup.ts'
import type { CodeBridge } from '../shared/code.ts'
import type { ControlBridge } from '../shared/control.ts'
import type { IdentityBridge } from '../shared/identity.ts'
import type { LearningBridge } from '../shared/learning.ts'
import type { AssistantBridge } from '../shared/ipc.ts'
import type { NewsBridge } from '../shared/news.ts'
import type { PersonalityBridge } from '../shared/personality.ts'
import type { ProjectsBridge } from '../shared/projects.ts'
import type { WakeBridge } from '../shared/wake.ts'

declare global {
  interface Window {
    assistant: AssistantBridge
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
  }
}
