import { describe, expect, it } from 'vitest'
import { resolveLocale } from '../src/mcp-apps/app-shell/locale'

describe('resolveLocale', () => {
  it.each([
    // The copy is English: an Arabic or Hebrew host keeps English, left to right, with its own formats.
    ['en-US', { lang: 'en', dir: 'ltr', formats: 'en-US' }],
    ['de-DE', { lang: 'en', dir: 'ltr', formats: 'en-DE' }],
    ['ar-EG', { lang: 'en', dir: 'ltr', formats: 'en-EG' }],
    ['he', { lang: 'en', dir: 'ltr', formats: 'en' }],
    // Pseudo-locales: the same copy laid out right to left, in that language's formats.
    ['ar-XB', { lang: 'en', dir: 'rtl', formats: 'ar' }],
    ['he-XB', { lang: 'en', dir: 'rtl', formats: 'he' }],
    // Nothing, or something that isn't BCP 47: the default.
    [undefined, { lang: 'en', dir: 'ltr', formats: 'en' }],
    ['not a locale!', { lang: 'en', dir: 'ltr', formats: 'en' }]
  ])('%s with English copy', (requested, expected) => {
    expect(resolveLocale(requested, ['en'])).toEqual(expected)
  })

  it('turns right to left once the App has copy in the host language', () => {
    expect(resolveLocale('ar-EG', ['en', 'ar'])).toEqual({
      lang: 'ar',
      dir: 'rtl',
      formats: 'ar-EG'
    })
    expect(resolveLocale('he-IL', ['en', 'he'])).toEqual({
      lang: 'he',
      dir: 'rtl',
      formats: 'he-IL'
    })
    expect(resolveLocale('fa-IR', ['en', 'fa'])).toEqual({
      lang: 'fa',
      dir: 'rtl',
      formats: 'fa-IR'
    })
    expect(resolveLocale('ja-JP', ['en', 'ja'])).toEqual({
      lang: 'ja',
      dir: 'ltr',
      formats: 'ja-JP'
    })
  })
})
