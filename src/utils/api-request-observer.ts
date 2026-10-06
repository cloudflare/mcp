import { env, exports, WorkerEntrypoint } from 'cloudflare:workers'

export type ApiDispatch = {
  sequence: number
  method: string
  pathTemplate: string
  status?: number
}
export type ApiDispatchSnapshot = { dispatches: ApiDispatch[]; overflow: boolean }

declare class ObserverEntrypoint extends WorkerEntrypoint {
  initialize(nonce: string): Promise<boolean>
  beginDispatch(nonce: string, method: string, pathTemplate: string): Promise<number | null>
  finishDispatch(nonce: string, sequence: number, status: number): Promise<boolean>
  snapshot(nonce: string): Promise<ApiDispatchSnapshot | null>
}

export type ApiRequestObserver = Fetcher<ApiRequestObserverEntrypoint>

/**
 * One trusted disposable isolate per execute invocation, containing no user code,
 * credentials or outbound access. Its service capability can cross Loader props;
 * RpcTarget references cannot. The nonce makes a reset fail closed.
 */
function observerWorker(workerId: string) {
  const worker = env.LOADER.get(workerId, () => ({
    compatibilityDate: '2026-01-12',
    globalOutbound: null,
    mainModule: 'observer.js',
    modules: {
      'observer.js': `
import { WorkerEntrypoint } from "cloudflare:workers";
// This module belongs to exactly one invocation, never a shared server isolate.
let initializedNonce;
const dispatches = [];
let nextSequence = 0;
function check(nonce) {
  return initializedNonce && nonce === initializedNonce;
}
export default class Observer extends WorkerEntrypoint {
  initialize(nonce) {
    if (initializedNonce) return false;
    initializedNonce = nonce;
    return true;
  }
  beginDispatch(nonce, method, pathTemplate) {
    if (!check(nonce) || typeof method !== "string" || !/^[A-Z]{1,16}$/.test(method) ||
      typeof pathTemplate !== "string" || new TextEncoder().encode(pathTemplate).length > 256) return null;
    const sequence = nextSequence++;
    if (dispatches.length < 64) dispatches.push({ sequence, method, pathTemplate });
    return sequence;
  }
  finishDispatch(nonce, sequence, status) {
    if (!check(nonce)) return false;
    const dispatch = dispatches.find(entry => entry.sequence === sequence);
    if (dispatch) dispatch.status = status;
    return true;
  }
  snapshot(nonce) {
    if (!check(nonce)) return null;
    return { dispatches, overflow: nextSequence > 64 };
  }
}`
    }
  }))
  return worker.getEntrypoint<ObserverEntrypoint>()
}

// Dynamic entrypoints cannot themselves cross Loader props. This reloadable
// parent service forwards to the invocation's trusted, uniquely named isolate.
export class ApiRequestObserverEntrypoint extends WorkerEntrypoint<Env, { workerId: string }> {
  async initialize(nonce: string): Promise<boolean> {
    return await observerWorker(this.ctx.props.workerId).initialize(nonce)
  }
  async beginDispatch(nonce: string, method: string, pathTemplate: string): Promise<number | null> {
    return await observerWorker(this.ctx.props.workerId).beginDispatch(nonce, method, pathTemplate)
  }
  async finishDispatch(nonce: string, sequence: number, status: number): Promise<boolean> {
    return await observerWorker(this.ctx.props.workerId).finishDispatch(nonce, sequence, status)
  }
  async snapshot(nonce: string): Promise<ApiDispatchSnapshot | null> {
    return await observerWorker(this.ctx.props.workerId).snapshot(nonce)
  }
}

export async function createApiRequestObserver(): Promise<{
  observer: ApiRequestObserver
  nonce: string
}> {
  const nonce = crypto.randomUUID()
  const observer = exports.ApiRequestObserverEntrypoint({
    props: { workerId: `api-observer-${crypto.randomUUID()}` }
  })
  if (!(await observer.initialize(nonce))) throw new Error('API observer initialization failed')
  return { observer, nonce }
}
