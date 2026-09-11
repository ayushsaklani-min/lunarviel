const DEFAULT_TIMEOUT_MS = 10_000;

export interface IndexerGraphqlResponseV1<TData> {
  readonly data?: TData | null;
  readonly errors?: readonly unknown[];
}

export class IndexerGraphqlError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'IndexerGraphqlError';
  }
}

/**
 * Posts one query to the indexer's public GraphQL endpoint.
 *
 * Errors are reduced to stable codes with no response body attached: an
 * indexer error payload is operator-facing diagnostics, not something to
 * forward into logs that also carry order identifiers.
 */
export async function postIndexerQueryV1<TData>(input: {
  readonly url: string;
  readonly query: string;
  readonly variables?: Readonly<Record<string, unknown>>;
  readonly codePrefix: string;
  readonly timeoutMs?: number;
}): Promise<TData> {
  const body = input.variables === undefined
    ? JSON.stringify({ query: input.query })
    : JSON.stringify({ query: input.query, variables: input.variables });

  const response = await fetch(input.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) throw new IndexerGraphqlError(`${input.codePrefix}_HTTP_${response.status}`);

  const payload = (await response.json()) as IndexerGraphqlResponseV1<TData>;
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new IndexerGraphqlError(`${input.codePrefix}_GRAPHQL_ERROR`);
  }
  if (payload.data === undefined || payload.data === null) {
    throw new IndexerGraphqlError(`${input.codePrefix}_MALFORMED`);
  }
  return payload.data;
}
