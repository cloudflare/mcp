import { z } from 'zod'
import type { SubscriptionCreate } from './policy-guards'

/**
 * The price a subscription request would add, read from Cloudflare's public
 * rate plan catalog (`GET /billing/rate_plans/{id}`), so the user confirms a
 * price and not just a plan name. The arithmetic is plain code, never a model.
 */

const Tier = z.object({
  lowerThreshold: z.number(),
  upperThreshold: z.number(),
  pricingType: z.string(),
  price: z.number()
})

const Component = z.object({
  name: z.string(),
  publicName: z.string().optional(),
  chargeType: z.string(),
  defaultQuantity: z.number().optional(),
  tiers: z.array(Tier).default([])
})

const RatePlan = z.object({
  result: z.object({
    public_name: z.string().optional(),
    currency: z.string().optional(),
    components: z.array(Component).default([])
  })
})

type CatalogComponent = z.infer<typeof Component>

/** One fixed charge line: a component, the quantity priced, and its cost. */
export interface FixedCharge {
  readonly name: string
  readonly quantity: number
  readonly amount: number
}

/** What a subscription request costs, as far as the catalog says. */
export type SubscriptionPrice =
  | {
      readonly kind: 'priced'
      readonly planName: string
      readonly currency: string
      readonly fixed: ReadonlyArray<FixedCharge>
      readonly total: number
      readonly usage: ReadonlyArray<string>
      readonly unpriced: ReadonlyArray<string>
    }
  | { readonly kind: 'unknown' }

function tierFor(tiers: CatalogComponent['tiers'], quantity: number) {
  return tiers.find(
    (tier) =>
      quantity >= tier.lowerThreshold &&
      (tier.upperThreshold === 0 || quantity <= tier.upperThreshold)
  )
}

function fixedCharge(component: CatalogComponent, quantity: number): FixedCharge | undefined {
  const tier = tierFor(component.tiers, quantity)
  if (!tier) {
    return undefined
  }
  const amount = tier.pricingType === 'fixed' ? tier.price : tier.price * quantity
  return { name: component.publicName ?? component.name, quantity, amount }
}

/** Price `subscription` against the catalog entry for its rate plan. */
export function priceFromCatalog(
  subscription: SubscriptionCreate,
  catalog: unknown
): SubscriptionPrice {
  const plan = RatePlan.safeParse(catalog)
  if (!plan.success) {
    return { kind: 'unknown' }
  }
  const { components } = plan.data.result
  const known = new Set(components.map((component) => component.name))
  const fixed: Array<FixedCharge> = []
  const unpriced: Array<string> = Object.keys(subscription.quantities).filter(
    (name) => !known.has(name)
  )
  for (const component of components) {
    if (component.chargeType !== 'subscription') {
      continue
    }
    const quantity = subscription.quantities[component.name] ?? component.defaultQuantity ?? 0
    const charge = fixedCharge(component, quantity)
    if (charge) {
      fixed.push(charge)
    } else {
      unpriced.push(component.publicName ?? component.name)
    }
  }
  return {
    kind: 'priced',
    planName: plan.data.result.public_name ?? subscription.ratePlan,
    currency: plan.data.result.currency ?? 'USD',
    fixed,
    total: fixed.reduce((sum, charge) => sum + charge.amount, 0),
    usage: components
      .filter((component) => component.chargeType === 'usage')
      .map((component) => component.publicName ?? component.name),
    unpriced
  }
}

/** Read the catalog price of `subscription`. A failed read prices nothing. */
export async function priceSubscription(
  subscription: SubscriptionCreate,
  apiBase: string
): Promise<SubscriptionPrice> {
  try {
    const url = `${apiBase.replace(/\/$/, '')}/billing/rate_plans/${encodeURIComponent(subscription.ratePlan)}`
    const response = await fetch(url, { headers: { accept: 'application/json' } })
    if (!response.ok) {
      return { kind: 'unknown' }
    }
    return priceFromCatalog(subscription, await response.json())
  } catch {
    return { kind: 'unknown' }
  }
}

function money(amount: number, currency: string): string {
  return currency === 'USD' ? `$${amount.toFixed(2)}` : `${amount.toFixed(2)} ${currency}`
}

/** The price lines of the confirmation question. */
export function describePrice(subscription: SubscriptionCreate, price: SubscriptionPrice): string {
  if (price.kind === 'unknown') {
    return 'Price: Cloudflare did not return a price for this rate plan, so it is unknown. Check the price in the dashboard before you confirm.'
  }
  const period = subscription.frequency
    ? `per ${subscription.frequency.replace(/ly$/, '')}`
    : 'per billing period'
  const lines = [
    `Fixed charge: ${money(price.total, price.currency)} ${period}.`,
    ...price.fixed.map(
      (charge) => `- ${charge.name}: ${charge.quantity} = ${money(charge.amount, price.currency)}`
    )
  ]
  if (price.usage.length > 0) {
    lines.push(`Usage charges apply: ${price.usage.join(', ')}.`)
  } else {
    lines.push('Usage charges: none.')
  }
  if (price.unpriced.length > 0) {
    lines.push(`Not priced by the catalog: ${price.unpriced.join(', ')}.`)
  }
  return lines.join('\n')
}
