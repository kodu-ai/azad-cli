import { spawnSync } from "node:child_process"
import { createHash, createPublicKey, verify } from "node:crypto"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { CliError } from "../../error"
import type { Fetcher } from "../../http"

/**
 * The keys `azad update` trusts for Azad release manifests, pinned here and
 * never read from the origin it downloads from: the Agent Connect release
 * key, as the app's `scripts/updater/trust.ts` pins it. A rotation adds the
 * new key in a CLI release before releases are signed with it.
 */
export const RELEASE_TRUST: readonly { id: string; publicKey: string }[] = [
  {
    id: "branch-las-vegas",
    publicKey: "FIbhE6k8lpf/5POFajznY5EPniXGNYgKpwxiVWXb8o8=",
  },
]

/** Where production publishes public releases. */
export const RELEASE_ORIGIN = "https://api.azad.pro"

/** The updater entry point inside an unpacked payload. */
export const UPDATER_ENTRY = join("updater", "updater.js")

export const semverSchema = z.string().regex(/^\d+\.\d+\.\d+$/u)
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const sourceShaSchema = z.string().regex(/^[a-f0-9]{40}$/u)

/** `channels/latest.json`: the release azad.pro runs now. */
const pointerSchema = z.strictObject({
  format: z.literal(1),
  version: semverSchema,
  sourceSha: sourceShaSchema,
  manifestSha256: sha256Schema,
})

const fileSchema = z.object({
  path: z.string().regex(/^[A-Za-z0-9._-]+$/u),
  sha256: sha256Schema,
  size: z.number().int().nonnegative(),
})

/**
 * The fields of a signed release manifest this CLI reads. The signature
 * covers the whole manifest as published; everything else in it is the
 * updater payload's business, so unknown fields are kept, not refused.
 */
const manifestSchema = z.looseObject({
  format: z.literal(1),
  type: z.literal("azad-release"),
  version: semverSchema,
  sourceSha: sourceShaSchema,
  publishedAt: z.string(),
  artifacts: z.looseObject({ updater: fileSchema }),
  keyId: z.string().min(1),
  signature: z.string().min(1),
})
export type ReleaseManifest = z.infer<typeof manifestSchema>

/** Any value JSON can produce. */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

function isJsonObject(
  value: JsonValue | undefined
): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * The canonical JSON a release signature covers: object keys sorted, no
 * whitespace. It must stay byte-identical to the app's `canonical`
 * (hosts/agent-connect/release/release.ts), which signs.
 */
export function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (isJsonObject(value))
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`
  return JSON.stringify(value)
}

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex")

const jsonValueSchema: z.ZodType<JsonValue> = z.json()

/**
 * Parses and verifies signed manifest bytes: Ed25519 over the canonical JSON
 * of the manifest without `signature`, by a pinned key.
 *
 * @throws CliError When the bytes are not a release manifest, the key is not
 *   trusted or the signature is invalid.
 */
export function verifyManifest(
  bytes: Uint8Array,
  trust: readonly { id: string; publicKey: string }[] = RELEASE_TRUST
): ReleaseManifest {
  let raw: JsonValue
  try {
    raw = jsonValueSchema.parse(JSON.parse(new TextDecoder().decode(bytes)))
  } catch {
    throw new CliError("The release manifest is not JSON.")
  }
  const parsed = manifestSchema.safeParse(raw)
  if (!parsed.success || !isJsonObject(raw))
    throw new CliError("The release manifest is not an Azad release.")
  const manifest = parsed.data
  const key = trust.find((candidate) => candidate.id === manifest.keyId)
  if (!key)
    throw new CliError(
      `The release manifest is signed with key ${manifest.keyId}, which this azad does not trust. Update azad.`
    )
  const publicKey = Uint8Array.fromBase64(key.publicKey)
  if (publicKey.byteLength !== 32)
    throw new CliError("A trusted release key must be raw Ed25519.")
  const { signature: _signature, ...unsigned } = raw
  const valid = verify(
    null,
    new TextEncoder().encode(canonical(unsigned)),
    createPublicKey({
      key: {
        kty: "OKP",
        crv: "Ed25519",
        x: publicKey.toBase64({ alphabet: "base64url", omitPadding: true }),
      },
      format: "jwk",
    }),
    Uint8Array.fromBase64(manifest.signature)
  )
  if (!valid) throw new CliError("The release manifest signature is invalid.")
  return manifest
}

/** A verified release: its manifest and the manifest's digest. */
export type VerifiedRelease = {
  manifest: ReleaseManifest
  manifestSha256: string
}

/** Reads the public release routes of `origin`, verifying everything. */
export function releaseClient(options: {
  origin?: string
  fetcher?: Fetcher
  trust?: readonly { id: string; publicKey: string }[]
}) {
  const origin = options.origin ?? RELEASE_ORIGIN
  const fetcher = options.fetcher ?? fetch
  const get = async (path: string, timeoutMs = 60_000) => {
    const url = new URL(`/api/v3/releases/${path}`, origin).href
    let response: Response
    try {
      response = await fetcher(url, {
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      throw new CliError(`Could not reach ${url}. Check the network and retry.`)
    }
    if (!response.ok)
      throw new CliError(
        response.status === 404
          ? `${url} does not exist. Check the version.`
          : `${url} answered HTTP ${response.status}. Retry later.`
      )
    return new Uint8Array(await response.arrayBuffer())
  }
  const manifestOf = async (version: string, expectedSha256?: string) => {
    const bytes = await get(`${version}/manifest.json`)
    const digest = sha256(bytes)
    if (expectedSha256 && digest !== expectedSha256)
      throw new CliError(
        `The manifest of Azad ${version} differs from the digest the latest pointer names.`
      )
    const manifest = verifyManifest(bytes, options.trust)
    if (manifest.version !== version)
      throw new CliError(
        `The manifest of Azad ${version} names another version.`
      )
    return { manifest, manifestSha256: digest }
  }
  return {
    /** `latest` (the release azad.pro runs) or an exact `x.y.z`. */
    async release(version: string): Promise<VerifiedRelease> {
      if (version !== "latest") {
        if (!semverSchema.safeParse(version).success)
          throw new CliError("Use --version latest or an exact x.y.z.")
        return await manifestOf(version)
      }
      let pointer: z.infer<typeof pointerSchema>
      try {
        pointer = pointerSchema.parse(
          JSON.parse(new TextDecoder().decode(await get("latest.json")))
        )
      } catch (error) {
        if (error instanceof CliError) throw error
        throw new CliError("The latest release pointer is not valid.")
      }
      const resolved = await manifestOf(pointer.version, pointer.manifestSha256)
      if (resolved.manifest.sourceSha !== pointer.sourceSha)
        throw new CliError("The latest release pointer names another source.")
      return resolved
    },
    /**
     * Downloads the release's updater payload into the new private directory
     * `directory`, checks its size and digest against the signed manifest and
     * unpacks it there.
     *
     * @returns The path of the payload's `updater/updater.js`.
     */
    async updater(manifest: ReleaseManifest, directory: string) {
      const file = manifest.artifacts.updater
      const bytes = await get(`${manifest.version}/${file.path}`, 600_000)
      if (bytes.byteLength !== file.size || sha256(bytes) !== file.sha256)
        throw new CliError(
          `The updater of Azad ${manifest.version} does not match its signed manifest.`
        )
      return unpackPayload(bytes, file.path, directory)
    },
  }
}

/**
 * Writes `archive` into a fresh private `directory` and unpacks it there
 * (`tar -xzf --no-same-owner`).
 *
 * @returns The path of `updater/updater.js` inside it.
 * @throws CliError When tar fails or the payload has no updater.
 */
export function unpackPayload(
  archive: Uint8Array,
  name: string,
  directory: string
): string {
  rmSync(directory, { recursive: true, force: true })
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, name)
  writeFileSync(path, archive, { mode: 0o600 })
  const payload = join(directory, "payload")
  mkdirSync(payload, { mode: 0o700 })
  const result = spawnSync(
    "tar",
    ["-xzf", path, "-C", payload, "--no-same-owner"],
    { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" }
  )
  if (result.status !== 0)
    throw new CliError(
      `Unpacking ${name} failed${result.error ? " (is tar installed?)" : ""}.`
    )
  rmSync(path, { force: true })
  const entry = join(payload, UPDATER_ENTRY)
  if (!existsSync(entry))
    throw new CliError(`${name} has no ${UPDATER_ENTRY}.`)
  return entry
}
