import { describe, expect, it } from 'vitest'

import { CC } from '../shared/control.ts'
import { CH } from '../shared/ipc.ts'
import { IC } from '../shared/identity.ts'
import { PC } from '../shared/personality.ts'
import { gateIpc, OWNER_ONLY } from './ipc-gate.ts'

const setup = (opts: { ours?: boolean; locked?: boolean } = {}) => {
  const ran: string[] = []
  const check = {
    fromOurWindow: () => opts.ours ?? true,
    requireOwner: () => {
      if (opts.locked) throw new Error('Please confirm it is you first.')
    },
  }
  const call = (channel: string) => gateIpc(channel, () => ran.push(channel), check)({}, undefined, undefined, undefined)
  return { ran, call }
}

describe('gateIpc', () => {
  it('rejects calls from any other frame, locked or not', () => {
    const { ran, call } = setup({ ours: false })
    expect(() => call(CH.status)).toThrow('unknown frame')
    expect(ran).toEqual([])
  })

  it('blocks owner-only calls while locked', () => {
    const { ran, call } = setup({ locked: true })
    for (const channel of [CH.saveSetup, CH.listModels, CH.answerApproval, CC.setTrusted, CC.addRule, CC.setExtensionToken, PC.reset, PC.exportFile]) {
      expect(() => call(channel), channel).toThrow('confirm it is you')
    }
    expect(ran).toEqual([])
  })

  it('keeps unlocking, status and the emergency stop open while locked', () => {
    const { ran, call } = setup({ locked: true })
    for (const channel of [CH.status, IC.get, IC.verify, CC.stopAll, CC.setPaused, CC.state]) call(channel)
    expect(ran).toEqual([CH.status, IC.get, IC.verify, CC.stopAll, CC.setPaused, CC.state])
  })

  it('runs owner-only calls once the owner is confirmed', () => {
    const { ran, call } = setup({ locked: false })
    call(CH.saveSetup)
    expect(ran).toEqual([CH.saveSetup])
  })

  it('never lists a channel the lock screen itself needs', () => {
    for (const channel of [CH.status, CH.ready, CH.stop, CH.interrupt, IC.get, IC.verify, IC.verifyVoice, CC.stopAll]) {
      expect(OWNER_ONLY.has(channel), channel).toBe(false)
    }
  })
})
