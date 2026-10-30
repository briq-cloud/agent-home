/** Serialize complete provider changes, including asynchronous process teardown.
 * Readers use run too, capturing a coherent credentials/profile/runtime snapshot.
 * Operations passed to run own the lock; internal helpers must not reacquire it.
 */
export class ProviderMutations {
  private tail: Promise<void> = Promise.resolve();
  run<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}
