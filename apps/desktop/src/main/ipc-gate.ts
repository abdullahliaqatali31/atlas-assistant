/**
 * Which IPC calls need the owner. Every call that changes what Atlas may do,
 * where it sends conversations, or what it remembers is listed here, so the
 * owner lock holds for them even if a handler forgets its own check.
 * Reads that pages make while mounted under the lock screen stay open;
 * "stop all automation" and "pause" stay open on purpose.
 */
import { AC } from '../shared/activity.ts'
import { CC } from '../shared/control.ts'
import { CH } from '../shared/ipc.ts'
import { PC } from '../shared/personality.ts'
import { PJ } from '../shared/projects.ts'
import { PCC } from '../shared/system.ts'
import { BR } from '../shared/brain.ts'
import { PWC } from '../shared/powerup.ts'
import { HB } from '../shared/habits.ts'
import { IC } from '../shared/identity.ts'
import { BRT } from '../shared/browser.ts'

export const OWNER_ONLY: ReadonlySet<string> = new Set([
  // Provider, key and server address: a swap would send conversations elsewhere.
  CH.saveSetup,
  // Live voice spends money on the owner's OpenAI key.
  CH.liveSession,
  CH.setLiveVoice,
  // Past conversations are the owner's.
  CH.chats,
  // So are the memories in the brain view.
  BR.view,
  BR.forget,
  BR.find,
  CH.listModels,
  CH.answerApproval,
  CH.initiativeAction,
  CH.setMode,
  CH.setStartup,
  // Connectors, trust, folders, apps, rules and the browser token.
  CC.setServer,
  CC.setTrusted,
  CC.pickCredentials,
  CC.addFolder,
  CC.removeFolder,
  CC.addApp,
  CC.removeApp,
  CC.addRule,
  CC.removeRule,
  CC.pickScopeFolder,
  CC.setBrowser,
  CC.setExtensionToken,
  // Window activity settings.
  AC.setEnabled,
  AC.addExcluded,
  AC.removeExcluded,
  AC.clear,
  // Personality changes and export.
  PC.update,
  PC.undo,
  PC.reset,
  PC.exportFile,
  // Project changes.
  PJ.create,
  PJ.update,
  PJ.addTask,
  PJ.assignTask,
  PJ.setTaskStatus,
  PJ.addCommitment,
  PJ.assignCommitment,
  PJ.resolveCommitment,
  // What Atlas may know about the PC, and what it must never index.
  // Keys: which services Atlas may use, and whether they work.
  PWC.state,
  PWC.save,
  PWC.remove,
  PWC.test,
  PWC.preview,
  PCC.setMap,
  PCC.setNotifications,
  // Turning Windows Hello on or off changes how the owner is checked.
  IC.setHello,
  // Browsing history is the owner's alone.
  HB.state,
  HB.setEnabled,
  HB.setProfile,
  HB.setWorkHours,
  HB.refresh,
  // Seeing and driving Atlas's browser (the owner's signed-in sites) from the web interface.
  BRT.picture,
  BRT.input,
  // Full control: Atlas acting without asking.
  CC.setFullControl,
  PCC.rebuild,
  PCC.addExcluded,
  PCC.removeExcluded,
])

/** Wraps one IPC handler: our window only, and the owner for the listed channels. */
export const gateIpc =
  <E, T>(channel: string, fn: (arg: unknown, arg2: unknown, arg3?: unknown, arg4?: unknown) => T | Promise<T>, check: { fromOurWindow: (e: E) => boolean; requireOwner: () => void }) =>
  (e: E, arg: unknown, arg2: unknown, arg3: unknown, arg4?: unknown) => {
    if (!check.fromOurWindow(e)) throw new Error('Rejected IPC from an unknown frame.')
    if (OWNER_ONLY.has(channel)) check.requireOwner()
    return fn(arg, arg2, arg3, arg4)
  }
