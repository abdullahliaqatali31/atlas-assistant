/**
 * The only bridge from the sandboxed renderer: a handful of named calls, no
 * raw ipcRenderer, no Node. Payloads are validated again in main.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import { AC, type ActivityBridge, type ActivityView } from '../shared/activity.ts'
import { CC, type ControlBridge, type ControlState } from '../shared/control.ts'
import { CH, type ActionNotice, type AssistantBridge, type ReplyEvent, type RuntimeStatus, type UsageView } from '../shared/ipc.ts'
import { IC, type IdentityBridge, type IdentityView } from '../shared/identity.ts'
import { LC, type LearningBridge, type LearningView } from '../shared/learning.ts'
import { BC, type BackupBridge } from '../shared/backup.ts'
import { KC, type CodeBridge, type CodeState } from '../shared/code.ts'
import { DC, type DesktopBridge, type DesktopState } from '../shared/desktop.ts'
import { FC, type FilesBridge, type FilesState } from '../shared/files.ts'
import { MC, type MapOpRequest, type MapOpsBridge } from '../shared/map.ts'
import { UC, type PageCommand, type UiBridge } from '../shared/ui.ts'
import { WLD, type WorldBridge, type WorldSnapshot } from '../shared/world.ts'
import { NC, type NewsBridge, type NewsResult } from '../shared/news.ts'
import { WC, type WakeBridge, type WakeView } from '../shared/wake.ts'
import { PC, type PersonalityBridge, type PersonalityView } from '../shared/personality.ts'
import { PJ, type ProjectsBridge } from '../shared/projects.ts'
import { PRS, type PresenceCommand, type PresenceHostBridge } from '../shared/presence.ts'
import { PCC, type PcBridge, type PcState } from '../shared/system.ts'
import { PWC, type PowerUpBridge } from '../shared/powerup.ts'

const subscribe = <T>(channel: string, cb: (v: T) => void) => {
  const listener = (_e: IpcRendererEvent, v: T) => cb(v)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const bridge: AssistantBridge = {
  status: () => ipcRenderer.invoke(CH.status),
  send: text => ipcRenderer.invoke(CH.send, text),
  sendVoice: (audio, mime) => ipcRenderer.invoke(CH.sendVoice, audio, mime),
  setSpeech: enabled => ipcRenderer.invoke(CH.setSpeech, enabled),
  stop: () => ipcRenderer.invoke(CH.stop),
  interrupt: () => ipcRenderer.invoke(CH.interrupt),
  setMode: mode => ipcRenderer.invoke(CH.setMode, mode),
  listTasks: () => ipcRenderer.invoke(CH.listTasks),
  listToday: () => ipcRenderer.invoke(CH.listToday),
  listChats: () => ipcRenderer.invoke(CH.chats, { kind: 'list' }),
  readChat: id => ipcRenderer.invoke(CH.chats, { kind: 'read', id }),
  newChat: () => ipcRenderer.invoke(CH.chats, { kind: 'new' }),
  resumeChat: id => ipcRenderer.invoke(CH.chats, { kind: 'resume', id }),
  saveSetup: input => ipcRenderer.invoke(CH.saveSetup, input),
  listModels: (provider, apiKey, baseUrl) => ipcRenderer.invoke(CH.listModels, provider, apiKey, baseUrl),
  chatModel: () => ipcRenderer.invoke(CH.chatModel),
  liveSession: name => ipcRenderer.invoke(CH.liveSession, name),
  setLiveVoice: settings => ipcRenderer.invoke(CH.setLiveVoice, settings),
  setChatModel: choice => ipcRenderer.invoke(CH.setChatModel, choice),
  usage: () => ipcRenderer.invoke(CH.usage),
  onUsage: cb => subscribe<UsageView>(CH.usageChanged, cb),
  setBudget: usd => ipcRenderer.invoke(CH.setBudget, usd),
  startup: () => ipcRenderer.invoke(CH.startup),
  setStartup: on => ipcRenderer.invoke(CH.setStartup, on),
  setPrice: (model, price) => ipcRenderer.invoke(CH.setPrice, model, price),
  answerApproval: (id, approved) => ipcRenderer.invoke(CH.answerApproval, id, approved),
  initiativeAction: (id, action) => ipcRenderer.invoke(CH.initiativeAction, id, action),
  ready: () => ipcRenderer.invoke(CH.ready),
  onReply: cb => subscribe<ReplyEvent>(CH.reply, cb),
  onSilence: cb => subscribe<null>(CH.silence, () => cb()),
  onAction: cb => subscribe<ActionNotice>(CH.action, cb),
  onStatus: cb => subscribe<RuntimeStatus>(CH.statusChanged, cb),
}

contextBridge.exposeInMainWorld('assistant', bridge)

/** Owner controls: connections, rules, activity, pause. Same validation in main. */
const controls: ControlBridge = {
  state: () => ipcRenderer.invoke(CC.state),
  onState: cb => subscribe<ControlState>(CC.changed, cb),
  setServer: (name, enabled) => ipcRenderer.invoke(CC.setServer, name, enabled),
  setTrusted: (name, trusted) => ipcRenderer.invoke(CC.setTrusted, name, trusted),
  setBrowser: setting => ipcRenderer.invoke(CC.setBrowser, setting),
  setExtensionToken: token => ipcRenderer.invoke(CC.setExtensionToken, token),
  addFolder: () => ipcRenderer.invoke(CC.addFolder),
  removeFolder: path => ipcRenderer.invoke(CC.removeFolder, path),
  addApp: () => ipcRenderer.invoke(CC.addApp),
  removeApp: id => ipcRenderer.invoke(CC.removeApp, id),
  rules: () => ipcRenderer.invoke(CC.rules),
  addRule: input => ipcRenderer.invoke(CC.addRule, input),
  removeRule: id => ipcRenderer.invoke(CC.removeRule, id),
  pickScopeFolder: () => ipcRenderer.invoke(CC.pickScopeFolder),
  activity: () => ipcRenderer.invoke(CC.activity),
  setPaused: paused => ipcRenderer.invoke(CC.setPaused, paused),
  setFullControl: (on, mode) => ipcRenderer.invoke(CC.setFullControl, on, mode ?? 'session'),
  stopAll: () => ipcRenderer.invoke(CC.stopAll),
  pickCredentials: name => ipcRenderer.invoke(CC.pickCredentials, name),
}

contextBridge.exposeInMainWorld('controls', controls)

const personality: PersonalityBridge = {
  get: () => ipcRenderer.invoke(PC.get),
  update: (patch, reason) => ipcRenderer.invoke(PC.update, patch, reason),
  undo: () => ipcRenderer.invoke(PC.undo),
  reset: () => ipcRenderer.invoke(PC.reset),
  exportFile: () => ipcRenderer.invoke(PC.exportFile),
  setOnboarded: done => ipcRenderer.invoke(PC.setOnboarded, done),
  speakPrompt: (step, language) => ipcRenderer.invoke(PC.speakPrompt, step, language),
  transcribe: (audio, mime) => ipcRenderer.invoke(PC.transcribe, audio, mime),
  welcome: () => ipcRenderer.invoke(PC.welcome),
  onChanged: cb => subscribe<PersonalityView>(PC.changed, cb),
}

contextBridge.exposeInMainWorld('personality', personality)

/** Public headlines for the Jarvis panel (fetched and parsed in main). */
const news: NewsBridge = {
  list: refresh => ipcRenderer.invoke(NC.list, refresh === true),
  sources: () => ipcRenderer.invoke(NC.sources),
  setSources: ids => ipcRenderer.invoke(NC.setSources, ids),
  saved: () => ipcRenderer.invoke(NC.saved),
  save: id => ipcRenderer.invoke(NC.save, id),
  unsave: id => ipcRenderer.invoke(NC.unsave, id),
  onChanged: cb => subscribe<NewsResult>(NC.changed, cb),
}

contextBridge.exposeInMainWorld('news', news)

/** Opt-in window tracking: the switch, excluded apps and what was observed. */
const activity: ActivityBridge = {
  get: hours => ipcRenderer.invoke(AC.get, hours),
  setEnabled: enabled => ipcRenderer.invoke(AC.setEnabled, enabled),
  addExcluded: app => ipcRenderer.invoke(AC.addExcluded, app),
  removeExcluded: app => ipcRenderer.invoke(AC.removeExcluded, app),
  clear: app => ipcRenderer.invoke(AC.clear, app),
  onChanged: cb => subscribe<ActivityView>(AC.changed, cb),
}

contextBridge.exposeInMainWorld('activity', activity)

/** Projects with their tasks and commitments. */
const projects: ProjectsBridge = {
  list: includeArchived => ipcRenderer.invoke(PJ.list, includeArchived),
  get: id => ipcRenderer.invoke(PJ.get, id),
  create: input => ipcRenderer.invoke(PJ.create, input),
  update: (id, patch) => ipcRenderer.invoke(PJ.update, id, patch),
  addTask: (projectId, input) => ipcRenderer.invoke(PJ.addTask, projectId, input),
  assignTask: (taskId, projectId) => ipcRenderer.invoke(PJ.assignTask, taskId, projectId),
  setTaskStatus: (taskId, status, evidence) => ipcRenderer.invoke(PJ.setTaskStatus, taskId, status, evidence),
  addCommitment: (projectId, input) => ipcRenderer.invoke(PJ.addCommitment, projectId, input),
  assignCommitment: (commitmentId, projectId) => ipcRenderer.invoke(PJ.assignCommitment, commitmentId, projectId),
  resolveCommitment: (commitmentId, resolution) => ipcRenderer.invoke(PJ.resolveCommitment, commitmentId, resolution),
  onChanged: cb => subscribe<string>(PJ.changed, cb),
}

contextBridge.exposeInMainWorld('projects', projects)

/** Owner check. Codes go to main for comparison; nothing secret ever comes back. */
const identity: IdentityBridge = {
  get: () => ipcRenderer.invoke(IC.get),
  verify: code => ipcRenderer.invoke(IC.verify, code),
  verifyVoice: (audio, mime) => ipcRenderer.invoke(IC.verifyVoice, audio, mime),
  setCode: (code, current) => ipcRenderer.invoke(IC.setCode, code, current),
  removeCode: current => ipcRenderer.invoke(IC.removeCode, current),
  setAskWhen: when => ipcRenderer.invoke(IC.setAskWhen, when),
  speakChallenge: language => ipcRenderer.invoke(IC.speakChallenge, language),
  onChanged: cb => subscribe<IdentityView>(IC.changed, cb),
}

contextBridge.exposeInMainWorld('identity', identity)

/** Wake word settings and the local speech model download. */
const wake: WakeBridge = {
  get: () => ipcRenderer.invoke(WC.get),
  update: patch => ipcRenderer.invoke(WC.update, patch),
  downloadModel: () => ipcRenderer.invoke(WC.downloadModel),
  deleteModel: () => ipcRenderer.invoke(WC.deleteModel),
  onChanged: cb => subscribe<WakeView>(WC.changed, cb),
}

contextBridge.exposeInMainWorld('wake', wake)

/** The Learning screen: suggestions to approve, what was learned, forget. */
const learning: LearningBridge = {
  get: () => ipcRenderer.invoke(LC.get),
  decide: (id, accept) => ipcRenderer.invoke(LC.decide, id, accept),
  forget: id => ipcRenderer.invoke(LC.forget, id),
  removeWorkflow: id => ipcRenderer.invoke(LC.removeWorkflow, id),
  dropFollowup: id => ipcRenderer.invoke(LC.dropFollowup, id),
  updateSkill: (id, patch) => ipcRenderer.invoke(LC.skillUpdate, id, patch),
  deleteSkill: id => ipcRenderer.invoke(LC.skillDelete, id),
  runSkill: id => ipcRenderer.invoke(LC.skillRun, id),
  teach: () => ipcRenderer.invoke(LC.teach),
  runNow: () => ipcRenderer.invoke(LC.runNow),
  improvementDone: id => ipcRenderer.invoke(LC.improvementDone, id),
  improvementRemove: id => ipcRenderer.invoke(LC.improvementRemove, id),
  improvementProject: name => ipcRenderer.invoke(LC.improvementProject, name),
  onChanged: cb => subscribe<LearningView>(LC.changed, cb),
}

contextBridge.exposeInMainWorld('learning', learning)

/** Encrypted backups: main shows the file dialogs and does the work. */
const backup: BackupBridge = {
  create: passphrase => ipcRenderer.invoke(BC.create, passphrase),
  restore: passphrase => ipcRenderer.invoke(BC.restore, passphrase),
}

contextBridge.exposeInMainWorld('backup', backup)

/** Code projects: folders, activity, dev servers, status files. */
const code: CodeBridge = {
  state: () => ipcRenderer.invoke(KC.state),
  onChanged: cb => subscribe<CodeState>(KC.changed, cb),
  add: path => ipcRenderer.invoke(KC.add, path),
  pick: () => ipcRenderer.invoke(KC.pick),
  remove: id => ipcRenderer.invoke(KC.remove, id),
  setAccess: (id, access) => ipcRenderer.invoke(KC.setAccess, id, access),
  dismiss: path => ipcRenderer.invoke(KC.dismiss, path),
  scan: () => ipcRenderer.invoke(KC.scan),
  start: (id, profileId) => ipcRenderer.invoke(KC.start, id, profileId),
  stop: runId => ipcRenderer.invoke(KC.stop, runId),
  stopAll: () => ipcRenderer.invoke(KC.stopAll),
  logs: runId => ipcRenderer.invoke(KC.logs, runId),
  addProfile: (id, profile) => ipcRenderer.invoke(KC.addProfile, id, profile),
  removeProfile: (id, profileId) => ipcRenderer.invoke(KC.removeProfile, id, profileId),
  createStatus: id => ipcRenderer.invoke(KC.createStatus, id),
  setAgent: (agent, enabled) => ipcRenderer.invoke(KC.setAgent, agent, enabled),
  openEditor: id => ipcRenderer.invoke(KC.openEditor, id),
  openUrl: runId => ipcRenderer.invoke(KC.openUrl, runId),
}

contextBridge.exposeInMainWorld('code', code)

const files: FilesBridge = {
  state: () => ipcRenderer.invoke(FC.state),
  pick: () => ipcRenderer.invoke(FC.pick),
  remove: id => ipcRenderer.invoke(FC.remove, id),
  setAccess: (id, access) => ipcRenderer.invoke(FC.setAccess, id, access),
  undo: batchId => ipcRenderer.invoke(FC.undo, batchId),
  reveal: path => ipcRenderer.invoke(FC.reveal, path),
  onChanged: cb => subscribe<FilesState>(FC.changed, cb),
}
contextBridge.exposeInMainWorld('files', files)

const desktop: DesktopBridge = {
  state: () => ipcRenderer.invoke(DC.state),
  installed: () => ipcRenderer.invoke(DC.installed),
  add: app => ipcRenderer.invoke(DC.add, app),
  remove: id => ipcRenderer.invoke(DC.remove, id),
  setAccess: (id, access) => ipcRenderer.invoke(DC.setAccess, id, access),
  recordStart: () => ipcRenderer.invoke(DC.recordStart),
  recordStop: () => ipcRenderer.invoke(DC.recordStop),
  onChanged: cb => subscribe<DesktopState>(DC.changed, cb),
}
contextBridge.exposeInMainWorld('desktop', desktop)

const ui: UiBridge = {
  report: state => ipcRenderer.send(UC.report, state),
  onCommand: cb => subscribe<PageCommand>(UC.command, cb),
  set: change => ipcRenderer.invoke(UC.set, change),
  state: () => ipcRenderer.invoke(UC.state),
}
contextBridge.exposeInMainWorld('ui', ui)

const mapOps: MapOpsBridge = {
  onOp: cb => subscribe<MapOpRequest>(MC.op, cb),
  reply: (requestId, result, error) => ipcRenderer.send(MC.result, { requestId, result, error }),
}
contextBridge.exposeInMainWorld('mapOps', mapOps)

const world: WorldBridge = {
  state: () => ipcRenderer.invoke(WLD.state),
  add: name => ipcRenderer.invoke(WLD.add, name),
  remove: id => ipcRenderer.invoke(WLD.remove, id),
  refresh: () => ipcRenderer.invoke(WLD.refresh),
  flights: (lat, lon, dist, fill) => ipcRenderer.invoke(WLD.flights, lat, lon, dist, fill === true),
  flightsArea: box => ipcRenderer.invoke(WLD.flightsArea, box),
  flightRoute: callsign => ipcRenderer.invoke(WLD.flightRoute, callsign),
  aircraft: hex => ipcRenderer.invoke(WLD.aircraft, hex),
  wiki: (kind, id) => ipcRenderer.invoke(WLD.wiki, kind, id),
  intelEvents: hours => ipcRenderer.invoke(WLD.intelEvents, hours),
  markets: () => ipcRenderer.invoke(WLD.markets),
  image: url => ipcRenderer.invoke(WLD.image, url),
  vip: () => ipcRenderer.invoke(WLD.vip),
  richest: () => ipcRenderer.invoke(WLD.richest),
  country: iso => ipcRenderer.invoke(WLD.country, iso),
  intelStats: hours => ipcRenderer.invoke(WLD.intelStats, hours),
  intelCountries: () => ipcRenderer.invoke(WLD.intelCountries),
  intelAlerts: () => ipcRenderer.invoke(WLD.intelAlerts),
  intelUkraine: () => ipcRenderer.invoke(WLD.intelUkraine),
  track: hex => ipcRenderer.invoke(WLD.track, hex),
  launches: () => ipcRenderer.invoke(WLD.launches),
  radio: () => ipcRenderer.invoke(WLD.radio),
  rain: () => ipcRenderer.invoke(WLD.rain),
  map3dKeys: () => ipcRenderer.invoke(WLD.map3dKeys),
  satellites: (which?: 'all') => ipcRenderer.invoke(WLD.satellites, which),
  cables: () => ipcRenderer.invoke(WLD.cables),
  cable: (id: string) => ipcRenderer.invoke(WLD.cable, id),
  ships: box => ipcRenderer.invoke(WLD.ships, box),
  setShipsKey: key => ipcRenderer.invoke(WLD.shipsKey, key),
  cameras: () => ipcRenderer.invoke(WLD.cameras),
  cameraImage: id => ipcRenderer.invoke(WLD.cameraImage, id),
  webcams: (box, zoom) => ipcRenderer.invoke(WLD.webcams, box, zoom),
  setWebcamsKey: key => ipcRenderer.invoke(WLD.webcamsKey, key),
  onChanged: cb => subscribe<WorldSnapshot>(WLD.changed, cb),
}
contextBridge.exposeInMainWorld('world', world)

/** The desktop widget's link to the conversation in this window. */
const presenceHost: PresenceHostBridge = {
  update: u => ipcRenderer.invoke(PRS.update, u),
  onCommand: cb => subscribe<PresenceCommand>(PRS.command, cb),
  when: () => ipcRenderer.invoke(PRS.getWhen),
  setWhen: when => ipcRenderer.invoke(PRS.setWhen, when),
}
contextBridge.exposeInMainWorld('presenceHost', presenceHost)

/** The This PC tab: Wi-Fi, Bluetooth, battery, and the system map. */
const pc: PcBridge = {
  state: () => ipcRenderer.invoke(PCC.state),
  onChanged: cb => subscribe<PcState>(PCC.changed, cb),
  setMap: enabled => ipcRenderer.invoke(PCC.setMap, enabled),
  rebuild: () => ipcRenderer.invoke(PCC.rebuild),
  addExcluded: () => ipcRenderer.invoke(PCC.addExcluded),
  removeExcluded: path => ipcRenderer.invoke(PCC.removeExcluded, path),
}
contextBridge.exposeInMainWorld('pc', pc)

/** Setup › Power up: set, remove and test keys; values go in, never out. */
const powerup: PowerUpBridge = {
  state: () => ipcRenderer.invoke(PWC.state),
  save: (id, key) => ipcRenderer.invoke(PWC.save, id, key),
  remove: id => ipcRenderer.invoke(PWC.remove, id),
  test: id => ipcRenderer.invoke(PWC.test, id),
}
contextBridge.exposeInMainWorld('powerup', powerup)
