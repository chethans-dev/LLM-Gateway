import { LLMError } from "@openllm/core";

/**
 * Await a promise that must reject, and return the error as an `LLMError`.
 *
 * `promise.catch(e => e as LLMError)` gives back a union with the success type,
 * so every subsequent assertion has to be narrowed. This also fails loudly when
 * the promise unexpectedly resolves, instead of asserting against a value that
 * happens not to have the property being checked.
 */
export async function rejection(promise: Promise<unknown>): Promise<LLMError> {
  try {
    await promise;
  } catch (error) {
    if (!LLMError.is(error)) {
      throw new Error(`expected an LLMError but got: ${String(error)}`);
    }
    return error;
  }

  throw new Error("expected the promise to reject, but it resolved");
}

/** Synchronous counterpart of `rejection`. */
export function thrown(fn: () => unknown): LLMError {
  try {
    fn();
  } catch (error) {
    if (!LLMError.is(error)) {
      throw new Error(`expected an LLMError but got: ${String(error)}`);
    }
    return error;
  }

  throw new Error("expected the call to throw, but it returned");
}
