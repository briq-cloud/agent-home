export const EMBEDDING_MODEL: string;
export const EMBEDDING_CANONICAL: string;
export const EMBEDDING_QUERY_PREFIX: string;
export const DECISION_MODEL: string;
export function createLiveMeterRecorder(resultsDir: string): ((entry: Record<string, unknown>) => void) & { close(): void; path: string };
export function createLiveClients(onPaidCall: ((entry: Record<string, unknown>) => void)): Promise<{
  embeddingClient: { generate(input: unknown): Promise<unknown> };
  decisionClient: { create(input: unknown, options: unknown): Promise<unknown> };
  metadata: Record<string, any>;
}>;
export function runMemoryRetrievalBenchmark(options?: {
  embeddingClient?: { generate(input: unknown): Promise<unknown> };
  decisionClient?: { create(input: unknown, options: unknown): Promise<unknown> };
  live?: boolean;
  metadata?: Record<string, unknown>;
  onPaidCall?: ((entry: Record<string, unknown>) => void);
}): Promise<Record<string, any>>;
export function runMemoryRetrievalConfirmation(options?: {
  embeddingClient?: { generate(input: unknown): Promise<unknown> };
  decisionClient?: { create(input: unknown, options: unknown): Promise<unknown> };
  live?: boolean;
  metadata?: Record<string, unknown>;
  onPaidCall?: ((entry: Record<string, unknown>) => void);
  repetitions?: number;
}): Promise<Record<string, any>>;
