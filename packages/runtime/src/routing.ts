/**
 * Which model answers an owner message: the quick, cheap one for short and
 * simple messages ("salam", "theek hai", "shukriya", "kya haal hai"), the
 * main one for anything that asks for work, reasoning or the outside world.
 * No model call: a few plain rules. When in doubt, main. And if the quick
 * model still reaches for a tool, the turn is handed to the main model
 * (Assistant.turn), so a wrong guess costs one cheap call, not a bad answer.
 */

/** Words (English and Roman Urdu) that mean the message asks for work, tools or thought. */
const NEEDS_MAIN =
  /\b(map|news|khabar\w*|search|dhoond\w*|find|look ?up|open|khol\w*|browse|website|web|e-?mail|mail|message|bhej\w*|send|whatsapp|call|file|folder|document|code|project|task|remind\w*|yaad|schedule|calendar|meeting|appointment|write|likh\w*|draft|translate|tarjum\w*|summar\w*|explain|samjh?a\w*|why|kyun|kyon|how|kaise|compare|plan\w*|analy\w*|fix|debug|price|cost|buy|order|weather|mausam|story|tour|focus|pin|flight|plane|ship|satellite|camera|skill|learn|sikh\w*|research|report|list|budget|money|paisa|time ?table|tomorrow|kal|today|aaj)\b/i

export type Route = 'quick' | 'main'

export const routeMessage = (text: string): Route => {
  const t = text.trim()
  if (!t || t.length > 140 || /\n/.test(t) || t.split(/\s+/).length > 24) return 'main'
  if (NEEDS_MAIN.test(t)) return 'main'
  // Numbers, links and code-like text usually mean a task.
  if (/https?:\/\/|\d{3,}|[{}<>=`]/.test(t)) return 'main'
  return 'quick'
}
