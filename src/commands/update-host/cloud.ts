import { readFileSync } from "node:fs"
import { z } from "zod"
import { CliError } from "../../error"
import type { Fetcher } from "../../http"

/** `fetch` with Bun's TLS options, which an in-cluster client needs for the cluster's CA. */
export type TlsFetcher = (
  url: string,
  init: BunFetchRequestInit
) => Promise<Response>

/** The objects of the install store a starter reads. */
export type StoreKey = "operation" | "receipt" | "deployment"

/** A stored object: its JSON value and the store's version of it. */
export type StoredObject = { value: unknown; version: string }

/** Reads the installation's store. */
export type StoreReader = (key: StoreKey) => Promise<StoredObject | null>

const MAGIC = new TextEncoder().encode("azad-install-store 1 ")
/** Magic, 32 hex digits of randomness and a newline (the app's `envelope`). */
const HEADER_LENGTH = MAGIC.length + 33

/**
 * The value inside the install store's envelope (the app's
 * `scripts/updater/stores/common.ts`): a one-line random header that gives
 * every write a fresh version. Bytes without it are returned as stored.
 */
export function unwrapEnvelope(stored: Uint8Array): Uint8Array {
  const wrapped =
    stored.length >= HEADER_LENGTH &&
    MAGIC.every((byte, index) => stored[index] === byte) &&
    stored[HEADER_LENGTH - 1] === 0x0a
  return wrapped ? stored.slice(HEADER_LENGTH) : stored
}

const METADATA_TOKEN =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"
const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
})

/**
 * Access tokens of the pod's Workload Identity from the GKE metadata server,
 * reused until a minute before they expire.
 */
export function metadataToken(
  fetcher: Fetcher = fetch,
  now: () => number = Date.now
): () => Promise<string> {
  let cached: { token: string; until: number } | undefined
  return async () => {
    if (cached && cached.until > now()) return cached.token
    const response = await fetcher(METADATA_TOKEN, {
      headers: { "Metadata-Flavor": "Google" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    })
    const parsed = tokenSchema.safeParse(
      response.ok ? await response.json().catch(() => undefined) : undefined
    )
    if (!parsed.success)
      throw new Error(
        `The metadata server gave no access token (HTTP ${response.status}). The API pods need GKE Workload Identity.`
      )
    cached = {
      token: parsed.data.access_token,
      until: now() + (parsed.data.expires_in - 60) * 1000,
    }
    return cached.token
  }
}

/**
 * Reads `install/<key>.json` of a GCS install store through the JSON API.
 * A missing object is null; the generation is its version.
 */
export function gcsStoreReader(options: {
  bucket: string
  token: () => Promise<string>
  fetcher?: Fetcher
}): StoreReader {
  const fetcher = options.fetcher ?? fetch
  return async (key) => {
    const name = encodeURIComponent(`install/${key}.json`)
    const response = await fetcher(
      `https://storage.googleapis.com/storage/v1/b/${options.bucket}/o/${name}?alt=media`,
      {
        headers: { Authorization: `Bearer ${await options.token()}` },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      }
    )
    if (response.status === 404) return null
    if (!response.ok)
      throw new Error(
        `GCS refused to read ${key} from ${options.bucket} (HTTP ${response.status}).`
      )
    const bytes = unwrapEnvelope(new Uint8Array(await response.arrayBuffer()))
    return {
      value: JSON.parse(new TextDecoder().decode(bytes)),
      version: response.headers.get("x-goog-generation") ?? "",
    }
  }
}

/** Where a pod reads its service account (the projected token is rotated, so it is read per request). */
export const SERVICE_ACCOUNT_DIRECTORY =
  "/var/run/secrets/kubernetes.io/serviceaccount"

/** One call to the Kubernetes API; the status code and parsed body. */
export type KubernetesCall = (
  method: "GET" | "POST",
  path: string,
  body?: unknown
) => Promise<{ status: number; body: unknown }>

/**
 * The in-cluster Kubernetes API, as the pod's service account: the API
 * server at KUBERNETES_SERVICE_HOST/PORT, verified against the cluster CA,
 * with the projected token read for every request.
 *
 * @throws When the pod runs outside a cluster.
 */
export function inClusterKubernetes(
  options: {
    env?: Record<string, string | undefined>
    directory?: string
    fetcher?: TlsFetcher
    read?: (path: string) => string
  } = {}
): KubernetesCall {
  const env = options.env ?? process.env
  const directory = options.directory ?? SERVICE_ACCOUNT_DIRECTORY
  const read = options.read ?? ((path: string) => readFileSync(path, "utf8"))
  const fetcher: TlsFetcher = options.fetcher ?? fetch
  const host = env.KUBERNETES_SERVICE_HOST
  const port = env.KUBERNETES_SERVICE_PORT ?? "443"
  if (!host)
    throw new CliError(
      "KUBERNETES_SERVICE_HOST is not set: update-host gke runs in the cluster."
    )
  const origin = `https://${host.includes(":") ? `[${host}]` : host}:${port}`
  let ca: string
  try {
    ca = read(`${directory}/ca.crt`)
  } catch {
    throw new CliError(
      `${directory}/ca.crt is not readable: mount the pod's service account token into the starter.`
    )
  }
  return async (method, path, body) => {
    const response = await fetcher(`${origin}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${read(`${directory}/token`).trim()}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      tls: { ca },
    })
    return {
      status: response.status,
      body: await response.json().catch(() => undefined),
    }
  }
}
