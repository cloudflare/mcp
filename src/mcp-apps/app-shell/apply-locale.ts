import type { AppLocale } from './locale'

let current: AppLocale = { lang: 'en', dir: 'ltr', formats: 'en' }

/** The locale `mountMcpApp` applied; formatters read it at render time. */
export const appLocale = (): AppLocale => current

/** Set `lang` and `dir` on the document, so logical properties and `:dir()` follow. True when it changed. */
export function applyLocale(locale: AppLocale): boolean {
  const changed =
    locale.lang !== current.lang || locale.dir !== current.dir || locale.formats !== current.formats
  current = locale
  document.documentElement.lang = locale.lang
  document.documentElement.dir = locale.dir
  return changed
}
