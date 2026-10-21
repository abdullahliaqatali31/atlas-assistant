/**
 * Every bridge the main window uses, written once against a transport: the
 * preload passes Electron's IPC, the web interface a WebSocket to the same
 * handlers in main. Payloads are validated again in main either way.
 */
import { AC, type ActivityBridge, type ActivityView } from './activity.ts'
import { CC, type ControlBridge, type ControlState } from './control.ts'
import { CH, type ActionNotice, type AssistantBridge, type ReplyEvent, type RuntimeStatus, type UsageView } from './ipc.ts'
import { IC, type IdentityBridge, type IdentityView } from './identity.ts'
import { LC, type LearningBridge, type LearningView } from './learning.ts'
import { BC, type BackupBridge } from './backup.ts'
import { KC, type CodeBridge, type CodeState } from './code.ts'
import { DC, type DesktopBridge, type DesktopState } from './desktop.ts'
import { FC, type FilesBridge, type FilesState } from './files.ts'
import { MC, type MapOpRequest, type MapOpsBridge } from './map.ts'
import { UC, type PageCommand, type UiBridge } from './ui.ts'
import { WLD, type WorldBridge, type WorldSnapshot } from './world.ts'
import { NC, type NewsBridge, type NewsResult } from './news.ts'
import { WC, type WakeBridge, type WakeView } from './wake.ts'
import { PC, type PersonalityBridge, type PersonalityView } from './personality.ts'
import { PJ, type ProjectsBridge } from './projects.ts'
import { PRS, type PresenceCommand, type PresenceHostBridge } from './presence.ts'
import { PCC, type PcBridge, type PcState } from './system.ts'
import { BR, type BrainBridge, type MemoryUseWhy } from './brain.ts'
import { PWC, type PowerUpBridge } from './powerup.ts'
import { BRT, type BrowserTabsBridge, type BrowserTabsState } from './browser.ts'
import { HB, type HabitsBridge, type HabitsView } from './habits.ts'
import { SCT, type ShortcutsView } from './shortcuts.ts'
import { WA, type WebAccessBridge, type WebAccessView } from './web.ts'
import { TM, type TimersBridge, type TimersView } from './timers.ts'

/** How a bridge reaches main: a call with an answer, a one-way message, and events. */
export interface Transport {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke(channel: string, ...args: unknown[]): Promise<any>
  send(channel: string, payload: unknown): void
  on<T>(channel: string, cb: (v: T) => void): () => void
}

export const buildBridges = (t: Transport) => {
  const bridge: AssistantBridge = {
    status: () => t.invoke(CH.status),
    send: text => t.invoke(CH.send, text),
    sendVoice: (audio, mime) => t.invoke(CH.sendVoice, audio, mime),
    setSpeech: enabled => t.invoke(CH.setSpeech, enabled),
    stop: () => t.invoke(CH.stop),
    interrupt: () => t.invoke(CH.interrupt),
    setMode: mode => t.invoke(CH.setMode, mode),
    listTasks: () => t.invoke(CH.listTasks),
    listToday: () => t.invoke(CH.listToday),
    listChats: () => t.invoke(CH.chats, { kind: 'list' }),
    readChat: id => t.invoke(CH.chats, { kind: 'read', id }),
    newChat: () => t.invoke(CH.chats, { kind: 'new' }),
    resumeChat: id => t.invoke(CH.chats, { kind: 'resume', id }),
    saveSetup: input => t.invoke(CH.saveSetup, input),
    listModels: (provider, apiKey, baseUrl) => t.invoke(CH.listModels, provider, apiKey, baseUrl),
    chatModel: () => t.invoke(CH.chatModel),
    liveSession: name => t.invoke(CH.liveSession, name),
    setLiveVoice: settings => t.invoke(CH.setLiveVoice, settings),
    setChatModel: choice => t.invoke(CH.setChatModel, choice),
    usage: () => t.invoke(CH.usage),
    onUsage: cb => t.on<UsageView>(CH.usageChanged, cb),
    setBudget: usd => t.invoke(CH.setBudget, usd),
    quietHours: () => t.invoke(CH.quietHours),
    setQuietHours: range => t.invoke(CH.setQuietHours, range),
    startup: () => t.invoke(CH.startup),
    setStartup: (on, show) => t.invoke(CH.setStartup, on, show),
    setPrice: (model, price) => t.invoke(CH.setPrice, model, price),
    answerApproval: (id, approved) => t.invoke(CH.answerApproval, id, approved),
    initiativeAction: (id, action) => t.invoke(CH.initiativeAction, id, action),
    ready: () => t.invoke(CH.ready),
    onReply: cb => t.on<ReplyEvent>(CH.reply, cb),
    onSilence: cb => t.on<null>(CH.silence, () => cb()),
    onAction: cb => t.on<ActionNotice>(CH.action, cb),
    onStatus: cb => t.on<RuntimeStatus>(CH.statusChanged, cb),
  }

  /** Owner controls: connections, rules, activity, pause. Same validation in main. */
  const controls: ControlBridge = {
    state: () => t.invoke(CC.state),
    onState: cb => t.on<ControlState>(CC.changed, cb),
    setServer: (name, enabled) => t.invoke(CC.setServer, name, enabled),
    setTrusted: (name, trusted) => t.invoke(CC.setTrusted, name, trusted),
    setBrowser: setting => t.invoke(CC.setBrowser, setting),
    setExtensionToken: token => t.invoke(CC.setExtensionToken, token),
    addFolder: () => t.invoke(CC.addFolder),
    removeFolder: path => t.invoke(CC.removeFolder, path),
    addApp: () => t.invoke(CC.addApp),
    removeApp: id => t.invoke(CC.removeApp, id),
    rules: () => t.invoke(CC.rules),
    addRule: input => t.invoke(CC.addRule, input),
    removeRule: id => t.invoke(CC.removeRule, id),
    pickScopeFolder: () => t.invoke(CC.pickScopeFolder),
    activity: () => t.invoke(CC.activity),
    setPaused: paused => t.invoke(CC.setPaused, paused),
    setFullControl: (on, mode) => t.invoke(CC.setFullControl, on, mode ?? 'session'),
    stopAll: () => t.invoke(CC.stopAll),
    pickCredentials: name => t.invoke(CC.pickCredentials, name),
  }

  const personality: PersonalityBridge = {
    get: () => t.invoke(PC.get),
    update: (patch, reason) => t.invoke(PC.update, patch, reason),
    undo: () => t.invoke(PC.undo),
    reset: () => t.invoke(PC.reset),
    exportFile: () => t.invoke(PC.exportFile),
    setOnboarded: done => t.invoke(PC.setOnboarded, done),
    speakPrompt: (step, language) => t.invoke(PC.speakPrompt, step, language),
    transcribe: (audio, mime) => t.invoke(PC.transcribe, audio, mime),
    welcome: () => t.invoke(PC.welcome),
    onChanged: cb => t.on<PersonalityView>(PC.changed, cb),
  }

  /** Public headlines for the Jarvis panel (fetched and parsed in main). */
  const news: NewsBridge = {
    list: refresh => t.invoke(NC.list, refresh === true),
    sources: () => t.invoke(NC.sources),
    setSources: ids => t.invoke(NC.setSources, ids),
    saved: () => t.invoke(NC.saved),
    save: id => t.invoke(NC.save, id),
    unsave: id => t.invoke(NC.unsave, id),
    onChanged: cb => t.on<NewsResult>(NC.changed, cb),
  }

  /** Opt-in window tracking: the switch, excluded apps and what was observed. */
  const activity: ActivityBridge = {
    get: hours => t.invoke(AC.get, hours),
    setEnabled: enabled => t.invoke(AC.setEnabled, enabled),
    addExcluded: app => t.invoke(AC.addExcluded, app),
    removeExcluded: app => t.invoke(AC.removeExcluded, app),
    clear: app => t.invoke(AC.clear, app),
    onChanged: cb => t.on<ActivityView>(AC.changed, cb),
  }

  /** Projects with their tasks and commitments. */
  const projects: ProjectsBridge = {
    list: includeArchived => t.invoke(PJ.list, includeArchived),
    get: id => t.invoke(PJ.get, id),
    create: input => t.invoke(PJ.create, input),
    update: (id, patch) => t.invoke(PJ.update, id, patch),
    addTask: (projectId, input) => t.invoke(PJ.addTask, projectId, input),
    assignTask: (taskId, projectId) => t.invoke(PJ.assignTask, taskId, projectId),
    setTaskStatus: (taskId, status, evidence) => t.invoke(PJ.setTaskStatus, taskId, status, evidence),
    addCommitment: (projectId, input) => t.invoke(PJ.addCommitment, projectId, input),
    assignCommitment: (commitmentId, projectId) => t.invoke(PJ.assignCommitment, commitmentId, projectId),
    resolveCommitment: (commitmentId, resolution) => t.invoke(PJ.resolveCommitment, commitmentId, resolution),
    onChanged: cb => t.on<string>(PJ.changed, cb),
  }

  /** Owner check. Codes go to main for comparison; nothing secret ever comes back. */
  const identity: IdentityBridge = {
    get: () => t.invoke(IC.get),
    verify: code => t.invoke(IC.verify, code),
    verifyVoice: (audio, mime) => t.invoke(IC.verifyVoice, audio, mime),
    setCode: (code, current) => t.invoke(IC.setCode, code, current),
    removeCode: current => t.invoke(IC.removeCode, current),
    setAskWhen: when => t.invoke(IC.setAskWhen, when),
    speakChallenge: language => t.invoke(IC.speakChallenge, language),
    onChanged: cb => t.on<IdentityView>(IC.changed, cb),
    hello: () => t.invoke(IC.hello),
    setHello: on => t.invoke(IC.setHello, on),
  }

  /** Wake word settings and the local speech model download. */
  const wake: WakeBridge = {
    get: () => t.invoke(WC.get),
    update: patch => t.invoke(WC.update, patch),
    downloadModel: () => t.invoke(WC.downloadModel),
    deleteModel: () => t.invoke(WC.deleteModel),
    onChanged: cb => t.on<WakeView>(WC.changed, cb),
  }

  /** The Learning screen: suggestions to approve, what was learned, forget. */
  const learning: LearningBridge = {
    get: () => t.invoke(LC.get),
    decide: (id, accept) => t.invoke(LC.decide, id, accept),
    forget: id => t.invoke(LC.forget, id),
    removeWorkflow: id => t.invoke(LC.removeWorkflow, id),
    dropFollowup: id => t.invoke(LC.dropFollowup, id),
    updateSkill: (id, patch) => t.invoke(LC.skillUpdate, id, patch),
    deleteSkill: id => t.invoke(LC.skillDelete, id),
    runSkill: id => t.invoke(LC.skillRun, id),
    teach: () => t.invoke(LC.teach),
    runNow: () => t.invoke(LC.runNow),
    improvementDone: id => t.invoke(LC.improvementDone, id),
    improvementRemove: id => t.invoke(LC.improvementRemove, id),
    improvementProject: name => t.invoke(LC.improvementProject, name),
    onChanged: cb => t.on<LearningView>(LC.changed, cb),
  }

  /** Encrypted backups: main shows the file dialogs and does the work. */
  const backup: BackupBridge = {
    create: passphrase => t.invoke(BC.create, passphrase),
    restore: passphrase => t.invoke(BC.restore, passphrase),
  }

  /** Code projects: folders, activity, dev servers, status files. */
  const code: CodeBridge = {
    state: () => t.invoke(KC.state),
    onChanged: cb => t.on<CodeState>(KC.changed, cb),
    add: path => t.invoke(KC.add, path),
    pick: () => t.invoke(KC.pick),
    remove: id => t.invoke(KC.remove, id),
    setAccess: (id, access) => t.invoke(KC.setAccess, id, access),
    dismiss: path => t.invoke(KC.dismiss, path),
    scan: () => t.invoke(KC.scan),
    start: (id, profileId) => t.invoke(KC.start, id, profileId),
    stop: runId => t.invoke(KC.stop, runId),
    stopAll: () => t.invoke(KC.stopAll),
    logs: runId => t.invoke(KC.logs, runId),
    addProfile: (id, profile) => t.invoke(KC.addProfile, id, profile),
    removeProfile: (id, profileId) => t.invoke(KC.removeProfile, id, profileId),
    createStatus: id => t.invoke(KC.createStatus, id),
    setAgent: (agent, enabled) => t.invoke(KC.setAgent, agent, enabled),
    openEditor: id => t.invoke(KC.openEditor, id),
    openUrl: runId => t.invoke(KC.openUrl, runId),
  }

  const files: FilesBridge = {
    state: () => t.invoke(FC.state),
    pick: () => t.invoke(FC.pick),
    remove: id => t.invoke(FC.remove, id),
    setAccess: (id, access) => t.invoke(FC.setAccess, id, access),
    undo: batchId => t.invoke(FC.undo, batchId),
    reveal: path => t.invoke(FC.reveal, path),
    onChanged: cb => t.on<FilesState>(FC.changed, cb),
  }

  const desktop: DesktopBridge = {
    state: () => t.invoke(DC.state),
    installed: () => t.invoke(DC.installed),
    add: app => t.invoke(DC.add, app),
    remove: id => t.invoke(DC.remove, id),
    setAccess: (id, access) => t.invoke(DC.setAccess, id, access),
    recordStart: () => t.invoke(DC.recordStart),
    recordStop: () => t.invoke(DC.recordStop),
    onChanged: cb => t.on<DesktopState>(DC.changed, cb),
  }

  const ui: UiBridge = {
    report: state => t.send(UC.report, state),
    onCommand: cb => t.on<PageCommand>(UC.command, cb),
    set: change => t.invoke(UC.set, change),
    state: () => t.invoke(UC.state),
    setSolid: (solid, color) => t.invoke(UC.solid, solid, color),
  }

  const brain: BrainBridge = {
    view: () => t.invoke(BR.view),
    forget: id => t.invoke(BR.forget, id),
    find: refresh => t.invoke(BR.find, refresh === true),
    onUsed: cb => t.on<{ ids: string[]; why: MemoryUseWhy }>(BR.used, cb),
  }

  const mapOps: MapOpsBridge = {
    onOp: cb => t.on<MapOpRequest>(MC.op, cb),
    reply: (requestId, result, error) => t.send(MC.result, { requestId, result, error }),
  }

  const world: WorldBridge = {
    state: () => t.invoke(WLD.state),
    add: name => t.invoke(WLD.add, name),
    remove: id => t.invoke(WLD.remove, id),
    refresh: () => t.invoke(WLD.refresh),
    flights: (lat, lon, dist, fill) => t.invoke(WLD.flights, lat, lon, dist, fill === true),
    flightsArea: box => t.invoke(WLD.flightsArea, box),
    flightRoute: callsign => t.invoke(WLD.flightRoute, callsign),
    aircraft: hex => t.invoke(WLD.aircraft, hex),
    wiki: (kind, id) => t.invoke(WLD.wiki, kind, id),
    intelEvents: hours => t.invoke(WLD.intelEvents, hours),
    markets: () => t.invoke(WLD.markets),
    image: url => t.invoke(WLD.image, url),
    vip: () => t.invoke(WLD.vip),
    richest: () => t.invoke(WLD.richest),
    country: iso => t.invoke(WLD.country, iso),
    intelStats: hours => t.invoke(WLD.intelStats, hours),
    intelCountries: () => t.invoke(WLD.intelCountries),
    intelAlerts: () => t.invoke(WLD.intelAlerts),
    intelUkraine: () => t.invoke(WLD.intelUkraine),
    track: hex => t.invoke(WLD.track, hex),
    launches: () => t.invoke(WLD.launches),
    fires: () => t.invoke(WLD.fires),
    trafficFlow: (box, zoom) => t.invoke(WLD.trafficFlow, box, zoom),
    trafficIncidents: box => t.invoke(WLD.trafficIncidents, box),
    radio: () => t.invoke(WLD.radio),
    rain: () => t.invoke(WLD.rain),
    map3dKeys: () => t.invoke(WLD.map3dKeys),
    satellites: (which?: 'all') => t.invoke(WLD.satellites, which),
    cables: () => t.invoke(WLD.cables),
    cable: (id: string) => t.invoke(WLD.cable, id),
    ships: box => t.invoke(WLD.ships, box),
    setShipsKey: key => t.invoke(WLD.shipsKey, key),
    cameras: () => t.invoke(WLD.cameras),
    cameraImage: id => t.invoke(WLD.cameraImage, id),
    webcams: (box, zoom) => t.invoke(WLD.webcams, box, zoom),
    setWebcamsKey: key => t.invoke(WLD.webcamsKey, key),
    onChanged: cb => t.on<WorldSnapshot>(WLD.changed, cb),
  }

  /** The desktop widget's link to the conversation in this window. */
  const presenceHost: PresenceHostBridge = {
    update: u => t.invoke(PRS.update, u),
    onCommand: cb => t.on<PresenceCommand>(PRS.command, cb),
    when: () => t.invoke(PRS.getWhen),
    setWhen: when => t.invoke(PRS.setWhen, when),
  }

  /** The This PC tab: Wi-Fi, Bluetooth, battery, and the system map. */
  const pc: PcBridge = {
    state: () => t.invoke(PCC.state),
    onChanged: cb => t.on<PcState>(PCC.changed, cb),
    setMap: enabled => t.invoke(PCC.setMap, enabled),
    setNotifications: enabled => t.invoke(PCC.setNotifications, enabled),
    rebuild: () => t.invoke(PCC.rebuild),
    addExcluded: () => t.invoke(PCC.addExcluded),
    removeExcluded: path => t.invoke(PCC.removeExcluded, path),
  }

  /** Setup › Power up: set, remove and test keys; values go in, never out. */
  const powerup: PowerUpBridge = {
    state: () => t.invoke(PWC.state),
    save: (id, key) => t.invoke(PWC.save, id, key),
    remove: id => t.invoke(PWC.remove, id),
    test: id => t.invoke(PWC.test, id),
    previewVoice: (provider, voice) => t.invoke(PWC.preview, provider, voice),
  }

  /** Atlas's browser tabs: the list, the owner's clicks, and each tab's page reporting in. */
  const atlasTabs: BrowserTabsBridge = {
    get: () => t.invoke(BRT.get),
    onState: cb => t.on<BrowserTabsState>(BRT.state, cb),
    act: a => t.invoke(BRT.act, a),
    report: r => void t.invoke(BRT.report, r).catch(() => undefined),
    picture: (id, width) => t.invoke(BRT.picture, id, width),
    input: (id, input) => t.invoke(BRT.input, id, input),
  }

  /** The Profiles tab: browser profiles and habits (read on this PC). */
  const habits: HabitsBridge = {
    state: () => t.invoke(HB.state),
    onChanged: cb => t.on<HabitsView>(HB.changed, cb),
    setEnabled: on => t.invoke(HB.setEnabled, on),
    setProfile: (key, change) => t.invoke(HB.setProfile, key, change),
    setWorkHours: w => t.invoke(HB.setWorkHours, w),
    refresh: () => t.invoke(HB.refresh),
  }

  /** Settings › Web access: the browser interface, pairing and paired devices. */
  const webAccess: WebAccessBridge = {
    state: () => t.invoke(WA.state),
    set: change => t.invoke(WA.set, change),
    newCode: () => t.invoke(WA.newCode),
    revoke: id => t.invoke(WA.revoke, id),
    open: () => t.invoke(WA.open),
    onChanged: cb => t.on<WebAccessView>(WA.changed, cb),
  }

  /** Timers and alarms: the ringing card's Stop and Snooze, and the list. */
  const timers: TimersBridge = {
    state: () => t.invoke(TM.state),
    stop: () => t.invoke(TM.stop),
    snooze: minutes => t.invoke(TM.snooze, minutes),
    cancel: id => t.invoke(TM.cancel, id),
    onChanged: cb => t.on<TimersView>(TM.changed, cb),
  }

  return {
    assistant: bridge,
    controls,
    personality,
    news,
    activity,
    projects,
    identity,
    wake,
    learning,
    backup,
    code,
    files,
    desktop,
    ui,
    brain,
    mapOps,
    world,
    presenceHost,
    pc,
    powerup,
    atlasTabs,
    habits,
    webAccess,
    timers,
    /** The shortcut board: which global shortcuts Windows gave Atlas. */
    shortcuts: { list: (): Promise<ShortcutsView> => t.invoke(SCT.list) },
  }
}

export type Bridges = ReturnType<typeof buildBridges>
