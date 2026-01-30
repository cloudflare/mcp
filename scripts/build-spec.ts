/**
 * Build script to fetch the Cloudflare OpenAPI spec and generate TypeScript types.
 * Run with: npx tsx scripts/build-spec.ts
 */

import { writeFile, mkdir } from "node:fs/promises";
import type { OpenAPIV3 } from "openapi-types";

const OPENAPI_SPEC_URL =
  "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json";
const OUTPUT_DIR = "src/data";

/**
 * Extract product from path - the segment after {account_id} or {zone_id}
 * e.g. /accounts/{account_id}/workers/scripts → "workers"
 * e.g. /zones/{zone_id}/dns_records → "dns_records"
 */
function extractProduct(path: string): string | undefined {
  const accountMatch = path.match(/\/accounts\/\{[^}]+\}\/([^/]+)/);
  if (accountMatch) return accountMatch[1];

  const zoneMatch = path.match(/\/zones\/\{[^}]+\}\/([^/]+)/);
  if (zoneMatch) return zoneMatch[1];

  return undefined;
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

function resolveRefs(obj: unknown, spec: OpenAPIV3.Document, seen = new Set<string>()): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(item => resolveRefs(item, spec, seen));

  const record = obj as Record<string, unknown>;

  if ('$ref' in record && typeof record.$ref === 'string') {
    const ref = record.$ref;
    if (seen.has(ref)) return { $circular: ref };
    seen.add(ref);

    const parts = ref.replace('#/', '').split('/');
    let resolved: unknown = spec;
    for (const part of parts) {
      resolved = (resolved as Record<string, unknown>)?.[part];
    }
    return resolveRefs(resolved, spec, seen);
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = resolveRefs(value, spec, seen);
  }
  return result;
}

function generateSpecFile(spec: OpenAPIV3.Document): string {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const [path, pathItem] of Object.entries(spec.paths || {})) {
    if (!pathItem) continue;
    paths[path] = {};

    for (const method of HTTP_METHODS) {
      const op = (pathItem as Record<string, OpenAPIV3.OperationObject>)[method];
      if (op) {
        const product = extractProduct(path);
        const tags = op.tags ? [...op.tags] : [];
        if (product && !tags.some(t => t.toLowerCase() === product.toLowerCase())) {
          tags.unshift(product);
        }
        paths[path][method] = {
          summary: op.summary,
          description: op.description,
          tags,
          parameters: resolveRefs(op.parameters, spec),
          requestBody: resolveRefs(op.requestBody, spec),
          responses: resolveRefs(op.responses, spec),
        };
      }
    }
  }

  return JSON.stringify({ paths }, null, 2);
}

async function main() {
  console.log("Fetching OpenAPI spec from:", OPENAPI_SPEC_URL);

  const response = await fetch(OPENAPI_SPEC_URL);
  if (!response.ok) {
    throw new Error("Failed to fetch OpenAPI spec: " + response.status);
  }

  const spec = (await response.json()) as OpenAPIV3.Document;
  const pathKeys = Object.keys(spec.paths).sort();
  const version = spec.openapi + " | " + spec.info.title + " v" + spec.info.version;

  console.log("Found " + pathKeys.length + " paths");

  // Count endpoints
  let endpointCount = 0;
  for (const path of pathKeys) {
    const pathItem = spec.paths[path];
    if (!pathItem) continue;
    for (const method of HTTP_METHODS) {
      if (pathItem[method]) endpointCount++;
    }
  }
  console.log("Found " + endpointCount + " endpoints");

  // Ensure output directory exists
  await mkdir(OUTPUT_DIR, { recursive: true });

  // Write spec.json for search tool
  const specJson = generateSpecFile(spec);
  const specFile = OUTPUT_DIR + "/spec.json";
  await writeFile(specFile, specJson);
  console.log("Wrote spec to " + specFile + " (" + (specJson.length / 1024).toFixed(0) + " KB)");

  // Generate products list (extracted from paths)
  const products = new Map<string, number>();
  for (const path of pathKeys) {
    const product = extractProduct(path);
    if (product) {
      products.set(product, (products.get(product) || 0) + 1);
    }
  }
  const sortedProducts = [...products.entries()].sort((a, b) => b[1] - a[1]);
  const productsFile = OUTPUT_DIR + "/products.ts";
  await writeFile(productsFile, `// Auto-generated list of Cloudflare products\nexport const PRODUCTS = ${JSON.stringify(sortedProducts.map(([p]) => p))} as const;\nexport type Product = typeof PRODUCTS[number];\n`);
  console.log("Wrote products to " + productsFile + " (" + sortedProducts.length + " products)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
