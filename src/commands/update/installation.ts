import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { CliError } from "../../error"
import { readPrivateEnv } from "../selfhost/config"
import { instanceTerraformDirectory } from "../selfhost/instance"
import type { RunUpdater } from "./run"

/**
 * Where an installation keeps its state in its own cloud, as azad-terraform
 * creates it (the app's `installStoreSelectionSchema`): a GCS bucket on Google
 * Cloud, an R2 bucket on Cloudflare.
 */
export const storeSelectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("gcs"),
    bucket: z.string().regex(/^[a-z0-9][a-z0-9_.-]{1,61}[a-z0-9]$/u),
    project_id: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u),
  }),
  z.strictObject({
    kind: z.literal("r2"),
    bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u),
    account_id: z.string().regex(/^[a-f0-9]{32}$/u),
  }),
])
export type StoreSelection = z.infer<typeof storeSelectionSchema>

/**
 * Parses a `--store` value.
 *
 * @throws CliError naming the problem, never the value.
 */
export function parseStore(text: string): StoreSelection {
  try {
    return storeSelectionSchema.parse(JSON.parse(text))
  } catch {
    throw new CliError(
      'Pass --store as the installation\'s store: {"kind":"gcs","bucket":…,"project_id":…} or {"kind":"r2","bucket":…,"account_id":…}.'
    )
  }
}

const backendRecordSchema = z.looseObject({ store: storeSelectionSchema })
const varsSchema = z.looseObject({
  deployment: z.looseObject({
    env_file: z.string().min(1),
    state_directory: z.string().min(1),
  }),
})

/** What a laptop update of one instance runs with. */
export type LocalInstallation = {
  store: StoreSelection
  /** The installer settings file the deploy reads (the store's `settings`). */
  settingsFile: string
  /** The deploy's cache of the keys and receipts, shared with the updater. */
  stateDirectory: string
  /** The cached `handoff` secret, when the deploy left one. */
  handoffFile?: string
  /** The updater's private working directory: payloads and web builds. */
  work: string
}

/**
 * Reads what `azad update` needs from an instance directory: the store that
 * azad-terraform's `init` recorded (`terraform/<root>/backend.json`), the
 * settings file and the deploy's cache directory its variables name
 * (`terraform.tfvars.json`). The updater shares that cache with deploys, so
 * the keys it holds are used and refreshed in place.
 *
 * @throws CliError When the instance was never deployed.
 */
export function localInstallation(directory: string): LocalInstallation {
  const envPath = join(directory, ".env")
  const values = existsSync(envPath) ? readPrivateEnv(envPath) : undefined
  if (!values?.AZAD_CLI_SOURCE_REVISION)
    throw new CliError(
      `${directory} has no deployed installation. Deploy it first: azad --source CHECKOUT.`
    )
  const terraform = instanceTerraformDirectory(directory, values)
  const backend = join(terraform, "backend.json")
  const vars = join(terraform, "terraform.tfvars.json")
  if (!existsSync(backend) || !existsSync(vars))
    throw new CliError(
      `${terraform} has no state bucket configured. Run azad --source CHECKOUT once to move the installation's state into its cloud, then update.`
    )
  let store: StoreSelection
  let deployment: z.infer<typeof varsSchema>["deployment"]
  try {
    store = backendRecordSchema.parse(
      JSON.parse(readFileSync(backend, "utf8"))
    ).store
    deployment = varsSchema.parse(JSON.parse(readFileSync(vars, "utf8")))
      .deployment
  } catch {
    throw new CliError(
      `${backend} or ${vars} is not what azad-terraform writes. Restore them, or rerun azad --source CHECKOUT.`
    )
  }
  const handoff = join(deployment.state_directory, "handoff.json")
  return {
    store,
    settingsFile: deployment.env_file,
    stateDirectory: deployment.state_directory,
    handoffFile: existsSync(handoff) ? handoff : undefined,
    work: join(directory, "update"),
  }
}

/** What the updater's `status` prints: the receipt, the current or last operation. */
export const statusSchema = z.looseObject({
  operation: z
    .looseObject({
      id: z.string(),
      kind: z.string(),
      status: z.string(),
      outcome: z.string().nullable(),
      target: z.looseObject({ version: z.string() }).nullable(),
      holder: z
        .looseObject({
          executor: z.string(),
          host: z.string(),
          heartbeatAt: z.string(),
        })
        .nullable(),
      error: z.string().nullable(),
      updatedAt: z.string(),
    })
    .nullable(),
  release: z
    .looseObject({ version: z.string().nullable(), sourceSha: z.string() })
    .nullable(),
  infrastructure: z.unknown(),
})
export type InstallationStatus = z.infer<typeof statusSchema>

/**
 * Reads the installation's receipt and operation record from its store with
 * the updater at `entry` (`updater.js status`); changes nothing.
 *
 * @throws CliError When the updater fails or prints a status this azad cannot read.
 */
export async function readInstallationStatus(
  installation: LocalInstallation,
  entry: string,
  run: RunUpdater
): Promise<InstallationStatus> {
  mkdirSync(installation.work, { recursive: true, mode: 0o700 })
  const result = await run(
    [
      entry,
      "status",
      "--store",
      JSON.stringify(installation.store),
      "--settings",
      installation.settingsFile,
    ],
    { cwd: installation.work, capture: true }
  )
  if (result.status !== 0)
    throw new CliError(
      "Reading the installation's status failed; the reason is above."
    )
  try {
    return statusSchema.parse(JSON.parse(result.stdout))
  } catch {
    throw new CliError("The updater printed a status this azad cannot read.")
  }
}
