import { AsyncLocalStorage } from "node:async_hooks";
import { ROOT_CONTEXT, type Context, type ContextManager } from "@opentelemetry/api";

/**
 * OpenTelemetry context propagation for workerd. Workers expose Node's `AsyncLocalStorage`
 * under the `nodejs_compat` flag, which is all a context manager needs: the active context
 * follows `await` through the agent loop, so spans nest without threading a parent through
 * every call. This is the `context-async-hooks` manager without the Node-only imports.
 */
export class AsyncLocalStorageContextManager implements ContextManager {
  readonly #store = new AsyncLocalStorage<Context>();

  active(): Context {
    return this.#store.getStore() ?? ROOT_CONTEXT;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    context: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.#store.run(context, () => fn.call(thisArg, ...args));
  }

  /** A function that runs with `context` active whenever it is called (its own `this` is not kept). */
  bind<T>(context: Context, target: T): T {
    if (typeof target !== "function") return target;
    const fn = target as (...a: unknown[]) => unknown;
    return ((...args: unknown[]) => this.with(context, () => fn(...args))) as T;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    this.#store.disable();
    return this;
  }
}
