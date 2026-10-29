/**
 * The part of `fetch` the CLI uses: a URL and request options, answered with
 * a Response. The global `fetch` is one; tests pass a local stand-in.
 */
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>
