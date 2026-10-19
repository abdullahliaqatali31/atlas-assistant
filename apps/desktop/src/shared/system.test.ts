import { describe, expect, it } from 'vitest'

import { describeSystem, deviceKind, diffSnapshots, interpretProbe, parseWlan } from './system.ts'

const WLAN_EN = `
There is 1 interface on the system:

    Name                   : Wi-Fi
    Description            : Intel(R) Wi-Fi 6 AX201 160MHz
    State                  : connected
    SSID                   : Home-5G
    BSSID                  : aa:bb:cc:dd:ee:ff
    Network type           : Infrastructure
    Radio type             : 802.11ax
    Band                   : 5 GHz
    Channel                : 44
    Receive rate (Mbps)    : 1201
    Signal                 : 86%
    Profile                : Home-5G
`
// Labels are translated on other Windows languages; values keep their shape.
const WLAN_DE = `
    Name                   : WLAN
    Status                 : Verbunden
    SSID                   : Büro
    BSSID                  : 11:22:33:44:55:66
    Band                   : 2,4 GHz
    Signal                 : 54 %
`

const PROBE = {
  radios: [
    { kind: 'Bluetooth', on: true },
    { kind: 'WiFi', on: true },
  ],
  bluetooth: [
    { name: 'WH-1000XM4', connected: true, kind: 'AudioVideo', minor: 'WearableHeadset', le: false },
    { name: 'MX Master 3', connected: false, kind: '15', le: true },
    { name: 'Pixel 8', connected: false, kind: 'Phone', le: false },
    { name: 'WH-1000XM4', connected: false, kind: '0', le: true },
  ],
  network: {
    profiles: [{ name: 'Home-5G', alias: 'Wi-Fi', ipv4: 'Internet', ipv6: 'NoTraffic' }],
    adapters: [
      { name: 'Wi-Fi', description: 'Intel(R) Wi-Fi 6 AX201', media: 'Native 802.11', physical: true },
      { name: 'ProtonVPN', description: 'WireGuard Tunnel', media: 'Unspecified', physical: false },
    ],
    wlan: 'Network shell commands need location permission to access WLAN information. … ms-settings:privacy-location … error 5',
    wlanOk: false,
  },
  battery: { percent: 65, status: 1 },
}

describe('system awareness', () => {
  it('reads netsh by the shape of its values, in any language', () => {
    expect(parseWlan(WLAN_EN)).toEqual({ ssid: 'Home-5G', signal: 86, band: '5 GHz' })
    expect(parseWlan(WLAN_DE)).toMatchObject({ ssid: 'Büro', signal: 54 })
  })

  it('turns the probe into what the PC is connected to', () => {
    const s = interpretProbe(PROBE, 1000)
    expect(s.wifi).toMatchObject({ on: true, connected: true, name: 'Home-5G', internet: 'internet', signal: null, locationBlocked: true })
    expect(s.vpn).toBe('WireGuard Tunnel')
    expect(s.battery).toEqual({ percent: 65, charging: false })
    // Classic and low-energy entries of one device are one device, connected.
    expect(s.bluetooth.devices).toEqual([
      { name: 'WH-1000XM4', kind: 'headphones', connected: true },
      { name: 'MX Master 3', kind: 'mouse', connected: false },
      { name: 'Pixel 8', kind: 'phone', connected: false },
    ])
    expect(describeSystem(s)).toBe('Wi-Fi: Home-5G · VPN: WireGuard Tunnel · Bluetooth: WH-1000XM4 (headphones) connected · battery 65%')
  })

  it('names device kinds the way people say them', () => {
    expect(deviceKind('AudioVideo', 'Loudspeaker', 'Living room')).toBe('speaker')
    expect(deviceKind('Peripheral', 'Keyboard', 'K380')).toBe('keyboard')
    expect(deviceKind('0', '', 'Galaxy Buds2')).toBe('headphones')
    expect(deviceKind('0', '', 'Something')).toBe('other')
  })

  it('says what changed: devices, Wi-Fi, internet, power, low battery', () => {
    const a = interpretProbe(PROBE, 1000)
    const b = interpretProbe(
      {
        ...PROBE,
        bluetooth: [
          { name: 'WH-1000XM4', connected: false, kind: 'AudioVideo' },
          { name: 'MX Master 3', connected: true, kind: '15', le: true },
        ],
        network: { ...PROBE.network, profiles: [{ name: 'Office', alias: 'Wi-Fi', ipv4: 'LocalNetwork' }], adapters: [] },
        battery: { percent: 19, status: 1 },
      },
      2000,
    )
    const a20 = { ...a, battery: { percent: 21, charging: false } }
    expect(diffSnapshots(a20, b).map(c => c.text)).toEqual([
      'WH-1000XM4 (headphones) disconnected',
      'MX Master 3 (mouse) connected',
      'Wi-Fi switched to Office',
      'Internet lost',
      'Battery at 19%',
      'VPN off',
    ])
    expect(diffSnapshots(null, a)).toEqual([])
    const charging = interpretProbe({ ...PROBE, battery: { percent: 66, status: 2 } }, 3000)
    expect(diffSnapshots(a, charging).map(c => c.text)).toEqual(['Charger plugged in (66%)'])
  })
})
