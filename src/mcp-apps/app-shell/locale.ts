/**
 * Which language an App shows, which way it runs, and how it formats numbers
 * and dates, from the host's `locale` (BCP 47, in the host context). No
 * catalog: the copy is the App's, the formats are the browser's `Intl`.
 *
 * - **Language and direction** follow the copy the App actually has. English
 *   copy is `lang="en"`, left to right, in an Arabic host too: mirroring
 *   English text would misdeclare it to screen readers. When an App gains
 *   copy in a right-to-left language, the same host locale turns it around.
 * - **Formats** follow the host's region (`de-DE` → `en-DE`: "1,35B"), so
 *   every number is the user's while the words stay in one language.
 * - **`-XB` pseudo-locales** (`ar-XB`, `he-XB`), as Android and Chromium use
 *   them: the App's own copy laid out right to left, with that language's
 *   formats ("١٫٣٥ مليار"), to test mirroring and bidirectional text without
 *   translations.
 */
export interface AppLocale {
  /** The copy's language, for `lang`. */
  readonly lang: string
  readonly dir: 'ltr' | 'rtl'
  /** The locale numbers and dates are formatted in. */
  readonly formats: string
}

/** Scripts written right to left, by ISO 15924 code. */
const RTL_SCRIPTS = new Set([
  'Adlm',
  'Arab',
  'Hebr',
  'Mand',
  'Nkoo',
  'Rohg',
  'Samr',
  'Syrc',
  'Thaa'
])
const PSEUDO = 'XB'

const directionOf = (tag: string): AppLocale['dir'] =>
  RTL_SCRIPTS.has(new Intl.Locale(tag).maximize().script ?? '') ? 'rtl' : 'ltr'

function parse(tag: string | undefined): Intl.Locale | undefined {
  try {
    return tag ? new Intl.Locale(tag) : undefined
  } catch {
    return undefined
  }
}

/**
 * @param requested the host's `locale`, if it sent one
 * @param languages the languages the App has copy for, the default first
 */
export function resolveLocale(
  requested: string | undefined,
  languages: readonly [string, ...string[]]
): AppLocale {
  const host = parse(requested)
  const fallback = languages[0]
  if (host?.region === PSEUDO)
    return { lang: fallback, dir: directionOf(host.language), formats: host.language }
  const lang = host && languages.includes(host.language) ? host.language : fallback
  return { lang, dir: directionOf(lang), formats: host?.region ? `${lang}-${host.region}` : lang }
}
