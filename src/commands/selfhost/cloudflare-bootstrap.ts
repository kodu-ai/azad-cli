import { randomUUID } from "node:crypto"
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { join, resolve } from "node:path"
import { stripVTControlCharacters } from "node:util"
import { z } from "zod"
import {
  LocalConfig,
  ownerOnly,
  readPrivateEnv,
  readPrivateText,
} from "./config"
import { CliError } from "../../error"
import { validateBootstrapFile } from "./bootstrap-credentials"
import type { Run } from "./deploy"
import { driverPath } from "./terraform"

/** The checkouts a token operation runs: the app source it binds to, and the azad-terraform directory whose driver runs. */
export type BootstrapSources = { source: string; terraform: string }

const id = z.string().regex(/^[a-f0-9]{32}$/u)
const revision = z.string().regex(/^[a-f0-9]{40}$/u)
const hostname = z
  .string()
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/u)
const configSchema = z.strictObject({
  version: z.literal(1),
  accountId: id,
  webHost: hostname,
  apiHost: hostname,
  revision,
  miniApps: z.boolean(),
  verifyDatabaseCertificate: z.boolean(),
  registerDatabaseCertificate: z.boolean().optional(),
  /** Artifacts and Queues tokens for managed project source (Cloudflare target). */
  managedSource: z.boolean().optional(),
  target: z.enum(["cloudflare", "gcp"]).optional(),
})
type BootstrapConfig = z.infer<typeof configSchema>
const markerSchema = z.strictObject({
  version: z.literal(1),
  phase: z.enum(["pending", "complete"]),
  config: configSchema,
})
const resultSchema = z.strictObject({
  version: z.literal(1),
  accountId: id,
  sourceRevision: revision,
  zoneIds: z.array(id).min(1),
  tokenIds: z.strictObject({
    deployment: id,
    miniapps: id.optional(),
    "managed-source": id.optional(),
    "managed-events": id.optional(),
  }),
  credentialsFile: z.string(),
})
const receiptSchema = z.strictObject({
  version: z.literal(1),
  phase: z.literal("complete"),
  config: configSchema,
  zoneIds: z.array(id).min(1),
})
const credentialsSchema = z.strictObject({
  CLOUDFLARE_API_TOKEN: z.string().min(1),
  V3_CF_API_TOKEN: z.string().min(1).optional(),
  CLOUDFLARE_ARTIFACTS_API_TOKEN: z.string().min(1).optional(),
  CLOUDFLARE_ARTIFACTS_EVENTS_API_TOKEN: z.string().min(1).optional(),
})
const stateSchema = z.object({
  resources: z.array(
    z.object({
      type: z.literal("cloudflare_api_token"),
      name: z.literal("scoped"),
      instances: z.array(
        z.object({
          index_key: z.enum([
            "deployment",
            "miniapps",
            "managed-source",
            "managed-events",
          ]),
          attributes: z.object({ id, value: z.string().min(1) }),
        })
      ),
    })
  ),
})
type Marker = z.infer<typeof markerSchema>

function paths(directory: string) {
  const state = resolve(directory, "cloudflare-bootstrap")
  return { state, marker: resolve(directory, ".cloudflare-bootstrap.json") }
}

function sameConfig(a: BootstrapConfig, b: BootstrapConfig): boolean {
  return (
    a.accountId === b.accountId &&
    a.webHost === b.webHost &&
    a.apiHost === b.apiHost &&
    a.revision === b.revision &&
    a.miniApps === b.miniApps &&
    a.verifyDatabaseCertificate === b.verifyDatabaseCertificate &&
    Boolean(a.registerDatabaseCertificate) ===
      Boolean(b.registerDatabaseCertificate) &&
    Boolean(a.managedSource) === Boolean(b.managedSource) &&
    (a.target ?? "cloudflare") === (b.target ?? "cloudflare")
  )
}

function configFor(
  values: Record<string, string>,
  sourceRevision: string
): BootstrapConfig {
  let verifyDatabaseCertificate = false
  if (values.DATABASE_URL) {
    try {
      verifyDatabaseCertificate =
        new URL(values.DATABASE_URL).searchParams.get("sslmode") ===
        "verify-full"
    } catch {
      throw new CliError("The saved database URL is invalid.")
    }
  }
  if (
    values.AZAD_SELF_HOST_DATABASE_CA &&
    (values.AZAD_SELF_HOST_DATABASE_CA !== "neon-isrg-root-x1" ||
      !verifyDatabaseCertificate)
  )
    throw new CliError(
      "Automatic Neon certificate registration requires the supported verified TLS configuration."
    )
  try {
    const input = configSchema.parse({
      version: 1,
      accountId: values.CLOUDFLARE_ACCOUNT_ID,
      webHost: values.AZAD_CLI_WEB_HOST,
      apiHost: `api.${values.AZAD_CLI_WEB_HOST}`,
      revision: sourceRevision,
      miniApps: values.AZAD_SELF_HOST_MINIAPPS === "enabled",
      verifyDatabaseCertificate,
    })
    // On Google Cloud the deployment token only serves DNS and TLS: Mini Apps
    // run on the Worker Loader, project repositories on the cluster's Forgejo,
    // and the database connection needs no Cloudflare CA.
    if (values.AZAD_CLI_TARGET === "gcp")
      return {
        ...input,
        miniApps: false,
        verifyDatabaseCertificate: false,
        target: "gcp",
      }
    if (values.AZAD_SELF_HOST_DATABASE_CA === "neon-isrg-root-x1")
      input.registerDatabaseCertificate = true
    // Sent only when chosen, so helpers that predate it still accept the config.
    if (values.AZAD_CLI_MANAGED_SOURCE === "enabled") input.managedSource = true
    return input
  } catch {
    throw new CliError(
      "Complete the account, hostname and feature settings before creating Cloudflare tokens."
    )
  }
}

function saveMarker(path: string, marker: Marker): void {
  if (existsSync(path)) readPrivateText(path)
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(marker), {
      mode: 0o600,
      flag: "wx",
    })
    renameSync(temporary, path)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

function readMarker(path: string): Marker | undefined {
  if (!existsSync(path)) return undefined
  try {
    return markerSchema.parse(JSON.parse(readPrivateText(path)))
  } catch {
    throw new CliError(
      "The Cloudflare bootstrap record is invalid. Restore its private state before continuing."
    )
  }
}

function privateDirectory(path: string): void {
  const stat = lstatSync(path)
  if (
    !stat.isDirectory() ||
    !ownerOnly(stat) ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error("Not a private owned directory")
}

function completedCredentials(
  directory: string,
  marker: Marker,
  values: Record<string, string>
) {
  try {
    const { state } = paths(directory)
    privateDirectory(state)
    privateDirectory(join(state, "terraform"))
    if (marker.phase !== "complete") throw new Error("Not complete")
    // Credential-creation revision is immutable; a workload upgrade has its own revision.
    if (!sameConfig(marker.config, configFor(values, marker.config.revision)))
      throw new Error("Configuration changed")
    const receipt = receiptSchema.parse(
      JSON.parse(readPrivateText(join(state, "receipt.json")))
    )
    const result = resultSchema.parse(
      JSON.parse(readPrivateText(join(state, "result.json")))
    )
    const credentialsFile = join(state, "credentials.env")
    if (
      !sameConfig(receipt.config, marker.config) ||
      result.accountId !== marker.config.accountId ||
      result.sourceRevision !== marker.config.revision ||
      resolve(result.credentialsFile) !== credentialsFile ||
      JSON.stringify(receipt.zoneIds) !== JSON.stringify(result.zoneIds) ||
      Boolean(result.tokenIds.miniapps) !== marker.config.miniApps
    )
      throw new Error("Receipt mismatch")
    const credentials = credentialsSchema.parse(readPrivateEnv(credentialsFile))
    const managed = Boolean(marker.config.managedSource)
    // Artifacts push events need a Cloudflare queue, which Google Cloud lacks.
    const managedEvents = managed && marker.config.target !== "gcp"
    if (
      Boolean(credentials.V3_CF_API_TOKEN) !== marker.config.miniApps ||
      Boolean(credentials.CLOUDFLARE_ARTIFACTS_API_TOKEN) !== managed ||
      Boolean(credentials.CLOUDFLARE_ARTIFACTS_EVENTS_API_TOKEN) !==
        managedEvents
    )
      throw new Error("Credential mismatch")
    const stateData = stateSchema.parse(
      JSON.parse(readPrivateText(join(state, "terraform", "terraform.tfstate")))
    )
    const tokens = stateData.resources.flatMap((resource) => resource.instances)
    const deployment = tokens.filter(
      (token) => token.index_key === "deployment"
    )
    const miniapps = tokens.filter((token) => token.index_key === "miniapps")
    const managedTokens = (["managed-source", "managed-events"] as const).map(
      (key) => ({
        key,
        state: tokens.filter((token) => token.index_key === key),
        value:
          key === "managed-source"
            ? credentials.CLOUDFLARE_ARTIFACTS_API_TOKEN
            : credentials.CLOUDFLARE_ARTIFACTS_EVENTS_API_TOKEN,
      })
    )
    const expected = {
      "managed-source": managed,
      "managed-events": managedEvents,
    }
    if (
      managedTokens.some(
        (token) =>
          token.state.length !== (expected[token.key] ? 1 : 0) ||
          (expected[token.key] &&
            (token.state[0].attributes.id !== result.tokenIds[token.key] ||
              token.state[0].attributes.value !== token.value))
      )
    )
      throw new Error("State mismatch")
    if (
      deployment.length !== 1 ||
      miniapps.length !== (marker.config.miniApps ? 1 : 0) ||
      deployment[0].attributes.id !== result.tokenIds.deployment ||
      deployment[0].attributes.value !== credentials.CLOUDFLARE_API_TOKEN ||
      (marker.config.miniApps &&
        (miniapps[0].attributes.id !== result.tokenIds.miniapps ||
          miniapps[0].attributes.value !== credentials.V3_CF_API_TOKEN))
    )
      throw new Error("State mismatch")
    return credentials
  } catch {
    throw new CliError(
      "Cloudflare bootstrap completion cannot be verified. Restore its private receipt, credentials and Terraform state; no replacement tokens were created."
    )
  }
}

/**
 * The token helper's own diagnostic, which it prints to stderr without
 * credential values: the last non-empty line, without terminal control
 * sequences, capped at 240 characters. `secrets` are redacted as a second
 * guard. Returns undefined when the helper printed nothing.
 */
export function helperDiagnostic(
  stderr: string | undefined,
  secrets: string[] = []
): string | undefined {
  const text = stripVTControlCharacters(stderr ?? "").trimEnd()
  let line = text
    .slice(text.lastIndexOf("\n") + 1)
    .replaceAll(/\p{Cc}/gu, "")
    .trim()
  if (!line) return undefined
  for (const secret of secrets)
    if (secret) line = line.replaceAll(secret, "[redacted]")
  return line.length > 240 ? `${line.slice(0, 239)}…` : line
}

/** Checks local completion evidence only; never requires the administrator token or calls Cloudflare. */
export function verifyCompletedBootstrap(
  directory: string,
  values: Record<string, string>
): boolean {
  const marker = readMarker(paths(directory).marker)
  if (!marker) return false
  if (marker.phase !== "complete") return false
  const credentials = completedCredentials(directory, marker, values)
  if (
    values.CLOUDFLARE_API_TOKEN !== credentials.CLOUDFLARE_API_TOKEN ||
    values.V3_CF_API_TOKEN !== credentials.V3_CF_API_TOKEN ||
    values.CLOUDFLARE_ARTIFACTS_API_TOKEN !==
      credentials.CLOUDFLARE_ARTIFACTS_API_TOKEN
  )
    throw new CliError(
      "The saved deployment credentials differ from the completed bootstrap. Restore the matching private configuration."
    )
  return true
}

/**
 * Runs only azad-terraform's token driver (`scripts/bootstrap.ts`, with its
 * `roots/bootstrap`); consumes a current successful handoff and keeps root
 * credentials separate.
 */
async function performBootstrap(
  config: LocalConfig,
  sources: BootstrapSources,
  sourceRevision: string,
  action: "plan" | "apply",
  execute: Run
): Promise<"complete" | "bootstrap_planned"> {
  const values = config.read()
  const location = paths(config.directory)
  const existing = readMarker(location.marker)
  if (existing?.phase === "complete") {
    if (!verifyCompletedBootstrap(config.directory, values))
      throw new CliError("Cloudflare bootstrap is incomplete.")
    return "complete"
  }
  const input = configFor(values, sourceRevision)
  if (existing && !sameConfig(existing.config, input))
    throw new CliError(
      "Resume Cloudflare bootstrap with its original source and instance settings."
    )
  if (!existing && existsSync(location.state))
    throw new CliError(
      "Cloudflare bootstrap state has no matching installer record. Restore the original record; no replacement tokens were created."
    )
  validateBootstrapFile(values.AZAD_CLI_CLOUDFLARE_BOOTSTRAP_FILE ?? "")
  const bootstrapToken = readPrivateEnv(
    values.AZAD_CLI_CLOUDFLARE_BOOTSTRAP_FILE
  ).CLOUDFLARE_BOOTSTRAP_API_TOKEN
  const inputPath = join(
    config.directory,
    `.bootstrap-input-${randomUUID()}.json`
  )
  try {
    writeFileSync(inputPath, JSON.stringify(input), { mode: 0o600, flag: "wx" })
    if (action === "apply")
      saveMarker(location.marker, {
        version: 1,
        phase: "pending",
        config: input,
      })
    const result = execute(
      "bun",
      [
        "--no-env-file",
        driverPath(sources.terraform, "bootstrap"),
        action,
        "--config",
        inputPath,
        "--bootstrap-file",
        values.AZAD_CLI_CLOUDFLARE_BOOTSTRAP_FILE,
        "--state-dir",
        location.state,
        "--source",
        sources.source,
      ],
      sources.terraform,
      true
    )
    if (result.status !== 0) {
      const cause = helperDiagnostic(result.stderr, [bootstrapToken])
      throw new CliError(
        `Cloudflare token setup stopped${cause ? `: ${cause}` : "."}\nIts private state was retained; no previous result was accepted as success.`
      )
    }
    if (action === "plan") {
      const report = z
        .object({
          version: z.literal(1),
          accountId: id,
          sourceRevision: revision,
          zonesResolvedDuringApply: z.literal(true),
        })
        .safeParse(JSON.parse(result.stdout))
      if (
        !report.success ||
        report.data.accountId !== input.accountId ||
        report.data.sourceRevision !== input.revision
      )
        throw new CliError(
          "The bootstrap permission preview was invalid. No workload plan was produced."
        )
      return "bootstrap_planned"
    }
    const report = resultSchema.parse(JSON.parse(result.stdout))
    const marker: Marker = { version: 1, phase: "complete", config: input }
    const recorded = resultSchema.parse(
      JSON.parse(readPrivateText(join(location.state, "result.json")))
    )
    if (JSON.stringify(report) !== JSON.stringify(recorded))
      throw new Error("Current handoff mismatch")
    const credentials = completedCredentials(config.directory, marker, values)
    Object.assign(values, credentials)
    config.save(values)
    saveMarker(location.marker, marker)
    return "complete"
  } catch (error) {
    if (error instanceof CliError) throw error
    throw new CliError(
      "Cloudflare token setup returned an invalid private handoff. State was retained and no completion was recorded."
    )
  } finally {
    if (existsSync(inputPath)) unlinkSync(inputPath)
  }
}

/** Serializes the private marker/handoff boundary around the maintained helper's own Terraform lock. */
export async function runCloudflareBootstrap(
  config: LocalConfig,
  sources: BootstrapSources,
  sourceRevision: string,
  action: "plan" | "apply",
  execute: Run
): Promise<"complete" | "bootstrap_planned"> {
  const lock = join(config.directory, ".cloudflare-bootstrap-cli.lock")
  let fd: number
  try {
    fd = openSync(lock, "wx", 0o600)
  } catch {
    throw new CliError(
      "Another Cloudflare token operation may be running. Wait for it to finish; retain the private state."
    )
  }
  try {
    writeFileSync(fd, String(process.pid))
    return await performBootstrap(
      config,
      sources,
      sourceRevision,
      action,
      execute
    )
  } finally {
    closeSync(fd)
    unlinkSync(lock)
  }
}
