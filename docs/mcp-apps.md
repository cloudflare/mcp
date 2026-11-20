# MCP Apps

An MCP App is a tool whose result an [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) host (ChatGPT, Claude) renders with a static HTML resource. Clients without Apps read the same result as JSON text and `structuredContent`, so an App never hides information from the model.

Every App is served in both tool modes: Code Mode registers it next to `search` and `execute`, and `?codemode=false` lists it after `docs` and `whoami`, before the generated tools.

## Layout

```
src/mcp-apps/
  define.ts         defineMcpApp(): tool + resource + result shaping for one App
  api-read.ts       apiReader(): bounded, read-only Cloudflare API and GraphQL reads
  registry.ts       MCP_APPS: the one list every App is added to
  app-shell/        browser side, shared by every App's HTML
    mount.tsx       mountMcpApp(): host connection, theme, locale, validated results, fallback states
    locale.ts       resolveLocale(): the host's locale → lang, dir and the format locale (pure, tested)
    apply-locale.ts sets lang/dir on the document; appLocale() for formatters
    base.css        Kumo + Tailwind base
src/<app>/
  contract.ts       input and output zod schemas, tool name, description
  tool.ts           defineMcpApp({...}) with the collector
  app/index.html    the App's entry; anything with this file is built
  app/*.tsx, *.css  the React/Kumo view
  app-html.generated.ts   written by npm run app:build; never edit
scripts/build-mcp-apps.ts   Vite + Tailwind single-file build for every App
```

## Adding an App

1. `src/<app>/contract.ts`: the input schema (`z.strictObject`) and the output schema. The output is the whole contract with the view and the model: give it a `kind` literal, and keep it to what the collector established. Anything it could not establish goes in a `limitations` list rather than being guessed.
2. `src/<app>/tool.ts`: `export const myApp = defineMcpApp({ name, title, description, annotations, input, output, resource: { uri: 'ui://cloudflare/<app>.html', name, html: appHtml }, run })`. `run` returns `{ ok: true, value }` or `{ ok: false, text }`, and passes a refused read's `_meta` through so the client can step up.
3. `src/<app>/app/`: `index.html` loading a `.tsx` that calls `mountMcpApp({ name, output, render })` (optionally `renderPending` while the tool runs, and `renderError(text, retry)` for a tool error, where `retry` calls the tool again with the same arguments when the host has `serverTools`), and a CSS file that starts with `@import '../../mcp-apps/app-shell/base.css';` and `@source './<file>.tsx';`.
4. Add the App to `MCP_APPS` in `src/mcp-apps/registry.ts`, then `npm run app:build`.
5. Tests: the collector against MSW, both tool modes through `exports.default.fetch`, and the tool-name lists that name every local tool (search the tests for `'whoami'`).

## Rules

- **Read-only unless the user clicks for a write.** Collectors read with `apiReader`: GETs to fixed paths and GraphQL Analytics queries, with the request's credential, from this Worker. An App that offers a write (creating an alert, say) shows exactly what it will send, and the click is the confirmation: the view calls the generated tool for that operation with `callServerTool`, once. The App's tool stays read-only, and the App itself never holds a token.
- **Writes use the generated tools, not new ones.** Name each generated tool the view calls in `appTools` (`defineMcpApp`), imported from its group's `tools.ts` in `src/generated/forge-mcp`, never the index, which pulls in every generated tool. The direct tools list every generated tool already. Code Mode lists only these, with the direct tools' Cloudflare policy and `_meta.ui.visibility: ['app']`, so hosts keep them from the model, and serves them as the direct tools do: planned and checked against the input schema by the forge tools service, sent with the session's token, with the same refusal explanations and step-up (`registerAppGeneratedTools`). Never write through `execute`: OpenAI's directory guidelines refuse writes through a generic executor. After a write, tell the model what happened with `updateModelContext`, so it doesn't confirm or repeat it, and keep the `sendMessage` hand-off for hosts without `serverTools`.
- **No network from the App.** Its CSP allows no connect or resource domains. Everything it renders comes from the tool result, and `mountMcpApp` refuses a result that fails the output schema.
- **Bounded.** One read is at most 1 MB (`MAX_READ_BYTES`); collectors bound their own pagination and say what they skipped.
- **Refusals are explained, not hidden.** `apiReader` throws `ApiReadError` with the same explanation and step-up `_meta` the direct tools give. A GraphQL error with no data is a refusal only when its message names the analytics permission; a quota or query error passes through as Cloudflare's message.
- **Locale and direction, no catalog.** The host's `locale` (host context) decides two things, kept apart: the language and direction follow the copy the App has (`languages`, default `['en']`), and the number and date formats follow the host's region (`de-DE` → `en-DE`, "1,35B"). So an Arabic host gets English copy left to right with its formats; mirroring English text would misdeclare it to screen readers. Format with `Intl` against `appLocale().formats`, never a hand-written format. The `-XB` pseudo-locales (`ar-XB`, `he-XB`) lay the same copy out right to left to test mirroring, as Android and Chromium use them. Style with logical properties (`inset-inline-start`, `margin-inline-end`, `text-align: start`) and `:dir(rtl)` for what has no logical form (a transform, a gradient angle); isolate formatted values and user-typed text (`<bdi>`, `unicode-bidi: isolate`). Anything stored, such as a policy's name, stays in one fixed format. If an App's copy is ever translated, the copy should arrive with the result, not as a catalog in the bundle.
- **Public repository.** Keep real customer prompts, account output and host screenshots out of it.

## Build and check

`npm run app:build` builds every App (`npm run app:build -- <app>` for one). `npm run check` runs `app:check`, which fails when a committed `app-html.generated.ts` is stale, and type-checks the browser code with `tsconfig.app.json`.
