import spec from "./data/spec.json";

interface CodeExecutorEntrypoint {
  evaluate(
    apiToken: string
  ): Promise<{ result: unknown; err?: string; stack?: string }>;
}

interface SearchExecutorEntrypoint {
  evaluate(): Promise<{ result: unknown; err?: string; stack?: string }>;
}

export function createCodeExecutor(env: Env) {
  const apiBase = env.CLOUDFLARE_API_BASE;

  return async (
    code: string,
    accountId: string,
    apiToken: string
  ): Promise<unknown> => {
    const workerId = `cloudflare-api-${crypto.randomUUID()}`;

    const worker = env.LOADER.get(workerId, () => ({
      compatibilityDate: "2026-01-12",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "worker.js",
      modules: {
        "worker.js": `
import { WorkerEntrypoint } from "cloudflare:workers";

const apiBase = ${JSON.stringify(apiBase)};
const accountId = ${JSON.stringify(accountId)};

export default class CodeExecutor extends WorkerEntrypoint {
  async evaluate(apiToken) {
    const cloudflare = {
      async request(options) {
        const { method, path, query, body, contentType, rawBody } = options;

        const url = new URL(apiBase + path);
        if (query) {
          for (const [key, value] of Object.entries(query)) {
            if (value !== undefined) {
              url.searchParams.set(key, String(value));
            }
          }
        }

        const headers = {
          "Authorization": "Bearer " + apiToken,
        };

        if (contentType) {
          headers["Content-Type"] = contentType;
        } else if (body && !rawBody) {
          headers["Content-Type"] = "application/json";
        }

        let requestBody;
        if (rawBody) {
          requestBody = body;
        } else if (body) {
          requestBody = JSON.stringify(body);
        }

        const response = await fetch(url.toString(), {
          method,
          headers,
          body: requestBody,
        });

        const responseContentType = response.headers.get("content-type") || "";

        // Handle non-JSON responses (e.g., KV values)
        if (!responseContentType.includes("application/json")) {
          const text = await response.text();
          if (!response.ok) {
            throw new Error("Cloudflare API error: " + response.status + " " + text);
          }
          return { success: true, result: text };
        }

        const data = await response.json();

        if (!data.success) {
          const errors = data.errors.map(e => e.code + ": " + e.message).join(", ");
          throw new Error("Cloudflare API error: " + errors);
        }

        return data;
      }
    };

    try {
      const result = await (${code})();
      return { result, err: undefined };
    } catch (err) {
      return { result: undefined, err: err.message, stack: err.stack };
    }
  }
}
        `,
      },
    }));

    const entrypoint =
      worker.getEntrypoint() as unknown as CodeExecutorEntrypoint;
    const response = await entrypoint.evaluate(apiToken);

    if (response.err) {
      throw new Error(response.err);
    }

    return response.result;
  };
}

export function createSearchExecutor(env: Env) {
  const specJson = JSON.stringify(spec);

  return async (code: string): Promise<unknown> => {
    const workerId = `cloudflare-search-${crypto.randomUUID()}`;

    const worker = env.LOADER.get(workerId, () => ({
      compatibilityDate: "2026-01-12",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "worker.js",
      modules: {
        "worker.js": `
import { WorkerEntrypoint } from "cloudflare:workers";

const spec = ${specJson};

export default class SearchExecutor extends WorkerEntrypoint {
  async evaluate() {
    try {
      const result = await (${code})();
      return { result, err: undefined };
    } catch (err) {
      return { result: undefined, err: err.message, stack: err.stack };
    }
  }
}
        `,
      },
    }));

    const entrypoint =
      worker.getEntrypoint() as unknown as SearchExecutorEntrypoint;
    const response = await entrypoint.evaluate();

    if (response.err) {
      throw new Error(response.err);
    }

    return response.result;
  };
}
