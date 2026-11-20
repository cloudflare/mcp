/**
 * The Workers usage alert's arithmetic, now the shared threshold alert model
 * (`src/threshold-alert/model.ts`) with its rolling 7 days as the default,
 * and its policy from the `workers-requests-monitor` preset. This path stays
 * for existing imports.
 */
export * from '../threshold-alert/model'
export { monitorPolicy, monitorQuery } from '../threshold-alert/presets'
