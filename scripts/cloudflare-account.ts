/**
 * The account that owns this server's Workers, buckets and Analytics Engine
 * datasets in every environment, as in wrangler.jsonc. `CLOUDFLARE_ACCOUNT_ID`
 * overrides it. Scripts run account operations with the `cf` CLI, which uses
 * its own sign-in, or `CLOUDFLARE_API_TOKEN` when set.
 */
export const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? '6702657b6aa048cf3081ff3ff3c9c52f'

/** The environment for a `cf` child process, with the account selected. */
export function cfEnv(): NodeJS.ProcessEnv {
  return { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID }
}
