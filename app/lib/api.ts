export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json();
    throw new Error(body.error ?? `Request failed (${response.status}).`);
  }
  return response.json() as Promise<T>;
}
/** Window event fired after a mutation outside the queue page changes the task queue. */
export const QUEUE_CHANGED = "queue-changed";
