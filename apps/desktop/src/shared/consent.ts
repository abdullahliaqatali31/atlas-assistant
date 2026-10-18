/**
 * Asking the owner in conversation: the question Atlas says before an action
 * that needs a yes ("Abdullah, kya main “Things to do.docx” parh loon?"), and
 * reading a short typed or spoken answer as yes or no. Anything longer or
 * unclear is not an answer; it goes to the conversation as a new message.
 */

// Urdu speakers say “kar lo na” to mean yes, so a bare “na” is never read as no.
const NO = /\b(nahi|nahin|nai|nhi|mat|no|nope|don'?t|dont|not now|ruko|ruk jao|rehne do|cancel|stop|chhoro|chorro|chodo|wait)\b|نہیں|مت|رہنے دو|رکو/i
const YES = /\b(haan|han|haa|ha|ji|jee|g|yes|yeah|yep|yup|ok|okay|okk|theek|thik|thk|sure|chalo|kar ?lo|kr ?lo|karo|kro|parh ?lo|padh ?lo|parho|dekh ?lo|allow|go ahead|do it|bilkul|zaroor|zarur|done|kar do|kr do)\b|ہاں|جی|ٹھیک|چلو|کر لو|پڑھ لو/i

export const parseConsent = (text: string): 'yes' | 'no' | null => {
  const t = text.replace(/[.!?،۔]+/g, ' ').trim()
  if (!t || t.split(/\s+/).length > 12) return null
  if (NO.test(t)) return 'no'
  if (YES.test(t)) return 'yes'
  return null
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const last = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p
const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n)}…` : s)

/** The question for one pending action, in Roman Urdu when the owner speaks Urdu, else English. */
export const approvalQuestion = (tool: string, input: Record<string, unknown>, ownerName: string, urdu: boolean): string => {
  const who = ownerName ? `${ownerName}, ` : ''
  const ur = (s: string) => `${who}${s}`
  const en = ur
  switch (tool) {
    case 'files_read':
      return urdu ? ur(`kya main “${last(str(input.path))}” parh loon?`) : en(`may I read “${last(str(input.path))}”?`)
    case 'whatsapp_download': {
      const file = str(input.file)
      return urdu
        ? ur(`kya main WhatsApp par ${str(input.chat)} ki chat se ${file ? `“${file}”` : 'akhri document'} download karke parh loon?`)
        : en(`may I download ${file ? `“${file}”` : 'the latest document'} from ${str(input.chat)}'s WhatsApp chat and read it?`)
    }
    case 'whatsapp_send':
      return urdu ? ur(`kya main WhatsApp par ${str(input.chat)} ko ye bhej doon: “${clip(str(input.text), 300)}”?`) : en(`shall I send ${str(input.chat)} this on WhatsApp: “${clip(str(input.text), 300)}”?`)
    case 'files_trash': {
      const paths = Array.isArray(input.paths) ? input.paths.map(p => last(String(p))) : []
      const list = paths.slice(0, 5).join(', ') + (paths.length > 5 ? ` aur ${paths.length - 5} aur` : '')
      return urdu ? ur(`kya main ye Recycle Bin mein daal doon: ${list}?`) : en(`shall I move these to the Recycle Bin: ${list}?`)
    }
    case 'improvement_propose':
      return urdu
        ? ur(`kya main “${clip(str(input.title))}” ko apni improvement list mein daal kar task aur brief bana doon?`)
        : en(`shall I put “${clip(str(input.title))}” on my improvement list, as a task with a brief?`)
    case 'desktop_act':
      return urdu ? ur(`kya main ${str(input.app)} mein “${str(input.label)}” daba doon?`) : en(`shall I press “${str(input.label)}” in ${str(input.app)}?`)
    case 'desktop_keys':
      return urdu ? ur(`kya main ${str(input.app)} mein ${str(input.keys)} daba doon?`) : en(`shall I press ${str(input.keys)} in ${str(input.app)}?`)
    default:
      return urdu ? ur(`kya main ye kar doon (${tool})?`) : en(`shall I go ahead (${tool})?`)
  }
}
