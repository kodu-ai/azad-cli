import { lstatSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { parse } from "dotenv"
import { z } from "zod"
import {
  cloudflareRoot,
  driverArguments,
  instanceTerraformDirectory,
  type Run,
} from "./deploy"
import { CliError } from "../../error"
import { spawnToolSync } from "../../process"
import {
  AZAD_TERRAFORM_REPOSITORY,
  selectTerraform,
  terraformReady,
  type TerraformSelection,
} from "./terraform"

/** What one Terraform state records. */
export type StateCheck = {
  /** The directory that holds the state: a Terraform root, or the instance's directory for one. */
  root: string
  /** `live`: it records resources; `unverified`: it could not be read. */
  state: "empty" | "live" | "unverified"
  /** Resource instances in the state, when it was read. */
  resources?: number
  /** Why the state could not be read. */
  reason?: string
}

/** One `azad --reset` outcome; `message` is the text a person reads. */
export type ResetReport =
  | { status: "reset_complete"; removed: string[]; message: string }
  | { status: "nothing_to_reset"; message: string }
  | {
      status: "needs_confirmation" | "cancelled"
      remove: string[]
      message: string
    }
  | {
      status: "live_resources" | "state_unverified"
      states: StateCheck[]
      commands: string[]
      message: string
    }

/** Lstat without following a link; undefined when nothing is there. */
const present = (path: string) =>
  lstatSync(path, { throwIfNoEntry: false }) !== undefined

const stateFileSchema = z.looseObject({
  resources: z
    .array(
      z.looseObject({
        mode: z.string().optional(),
        instances: z.array(z.unknown()).optional(),
      })
    )
    .optional(),
})

/** Managed resource instances in a local state file; data sources are reads, not resources. */
function localResources(path: string): number {
  const state = stateFileSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  return (state.resources ?? [])
    .filter((resource) => resource.mode !== "data")
    .reduce((total, resource) => total + (resource.instances?.length ?? 0), 0)
}

const backendRecordSchema = z.looseObject({
  backend: z
    .looseObject({
      type: z.string(),
      config: z.looseObject({ path: z.string().nullish() }).nullish(),
    })
    .nullish(),
})

/**
 * The backend a root uses: the one `terraform init` recorded, else one its
 * configuration declares (not yet initialized here), else undefined for
 * Terraform's default local backend.
 */
function configuredBackend(
  root: string
): { type: string; path?: string; initialized: boolean } | undefined {
  const recorded = join(root, ".terraform", "terraform.tfstate")
  if (present(recorded)) {
    const { backend } = backendRecordSchema.parse(
      JSON.parse(readFileSync(recorded, "utf8"))
    )
    if (backend)
      return {
        type: backend.type,
        path: backend.config?.path ?? undefined,
        initialized: true,
      }
  }
  for (const name of readdirSync(root)) {
    if (!name.endsWith(".tf")) continue
    const text = readFileSync(join(root, name), "utf8")
    const declared =
      /^\s*backend\s+"([^"]+)"/mu.exec(text)?.[1] ??
      (/^\s*cloud\s*\{/mu.test(text) ? "cloud" : undefined)
    if (declared) return { type: declared, initialized: false }
  }
  return undefined
}

/**
 * Lists a state through Terraform with the person's own environment, which
 * holds the credentials of a backend they configured. Only resource
 * addresses are read; output is captured, never printed.
 */
const listState: Run = (command, args, cwd) => {
  const result = spawnToolSync(command, args, {
    cwd,
    env: { ...process.env, TF_INPUT: "0", CHECKPOINT_DISABLE: "1" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  return { status: result.status, stdout: result.stdout ?? "" }
}

/**
 * Reads what the Terraform state of `root` records, without credentials or
 * provider calls: the local state file (and any local workspaces) directly,
 * or, for a configured remote backend, `terraform state list`. Anything it
 * cannot read is `unverified`, never `empty`.
 */
export function inspectState(
  root: string,
  execute: Run = listState
): StateCheck {
  let backend: ReturnType<typeof configuredBackend>
  try {
    backend = configuredBackend(root)
    if (!backend || backend.type === "local") {
      const files = [resolve(root, backend?.path ?? "terraform.tfstate")]
      const workspaces = join(root, "terraform.tfstate.d")
      if (!backend?.path && present(workspaces))
        for (const name of readdirSync(workspaces))
          files.push(join(workspaces, name, "terraform.tfstate"))
      const resources = files
        .filter(present)
        .reduce((total, file) => total + localResources(file), 0)
      return { root, state: resources ? "live" : "empty", resources }
    }
  } catch {
    return {
      root,
      state: "unverified",
      reason: "its Terraform state could not be read",
    }
  }
  const listed = execute(
    "terraform",
    [`-chdir=${root}`, "state", "list"],
    root,
    true
  )
  if (listed.status !== 0)
    return {
      root,
      state: "unverified",
      reason: `Terraform could not read its ${backend.type} backend; run terraform init there, then retry`,
    }
  const resources = listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/(?:^|\.)data\./u.test(line)).length
  return { root, state: resources ? "live" : "empty", resources }
}

/**
 * What the installation's state in the instance directory records. The
 * drivers keep it in the local backend at `<files>/terraform.tfstate`
 * (non-default workspaces under `<files>/workspaces`), which moves with the
 * directory; Terraform's record of the backend in `<files>/.terraform` is
 * only checked to be local.
 */
function inspectInstanceState(files: string): StateCheck {
  try {
    const record = join(files, ".terraform", "terraform.tfstate")
    const backend = present(record)
      ? backendRecordSchema.parse(JSON.parse(readFileSync(record, "utf8")))
          .backend
      : undefined
    if (backend && backend.type !== "local")
      return {
        root: files,
        state: "unverified",
        reason: `it records a ${backend.type} backend, which the installer does not read`,
      }
    const states = [join(files, "terraform.tfstate")]
    const workspaces = join(files, "workspaces")
    if (present(workspaces))
      for (const name of readdirSync(workspaces))
        states.push(join(workspaces, name, "terraform.tfstate"))
    const resources = states
      .filter(present)
      .reduce((total, file) => total + localResources(file), 0)
    return { root: files, state: resources ? "live" : "empty", resources }
  } catch {
    return {
      root: files,
      state: "unverified",
      reason: "its Terraform state could not be read",
    }
  }
}

const varsSchema = z.looseObject({
  deletion_protection: z.boolean().optional(),
  gcp: z
    .looseObject({ deletion_protection: z.boolean().optional() })
    .optional(),
})

/** A directory's terraform.tfvars.json, or undefined when it has none it can read. */
function readVars(directory: string): z.infer<typeof varsSchema> | undefined {
  try {
    return varsSchema.parse(
      JSON.parse(readFileSync(join(directory, "terraform.tfvars.json"), "utf8"))
    )
  } catch {
    return undefined
  }
}

/** A path as one shell word. */
function shellWord(value: string): string {
  return /^[\w@%+=:,./-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`
}

type Removal = { path: string; what: string }

const INSTANCE_FILES: [name: string, what: string][] = [
  [".env", "saved answers and private settings"],
  [".cloudflare-bootstrap-credential", "the Cloudflare token you pasted"],
  [".cloudflare-bootstrap.json", "the scoped Cloudflare token record"],
  [
    "cloudflare-bootstrap",
    "the scoped tokens' credentials, receipt and empty Terraform state",
  ],
  [".realtimekit.json", "the meetings app record"],
]

/** Temporary files an interrupted private write leaves behind; they may hold settings. */
const INTERRUPTED_WRITE =
  /^\.(?:env-|bootstrap-input-|cloudflare-bootstrap\.json\.)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?:\.json|\.tmp)?$/u

function describe(removals: Removal[]): string {
  return removals.map((item) => `  ${item.path} (${item.what})`).join("\n")
}

/** The azad-terraform driver command that runs this instance's Terraform, as one shell line. */
function driver(workload: Workload): (command: string) => string {
  return (command) =>
    [
      "bun",
      ...driverArguments(
        workload.terraform,
        workload.googleCloud ? "gcp" : "cloudflare",
        [command],
        {
          root: workload.root,
          source: workload.source,
          instance: workload.directory,
        }
      ),
    ]
      .map(shellWord)
      .join(" ")
}

/** A deployed installation whose resources the reset found, and how to reach its drivers. */
type Workload = {
  /** Cloudflare's azad-terraform root name; undefined on Google Cloud. */
  root?: string
  source: string
  terraform: string
  directory: string
  files: string
  googleCloud: boolean
}

/**
 * Commands and explanation that remove what the blocking states record: the
 * installation's own destroy (with the deletion-protection step for Google
 * Cloud and Cloud SQL) and, last, because the destroy still uses them, the
 * scoped Cloudflare tokens through their own state.
 */
function removalSteps(
  workload: Workload | undefined,
  tokens: StateCheck | undefined
) {
  const commands: string[] = []
  const lines: string[] = []
  if (workload) {
    const { files, googleCloud } = workload
    const run = driver(workload)
    const vars = readVars(files)
    const variables = join(files, "terraform.tfvars.json")
    commands.push(`${run("init")} && ${run("destroy")}`)
    lines.push(
      `${lines.length + 1}. Destroy the installation:`,
      `     ${run("init")}`,
      `     ${run("destroy")}`
    )
    if (googleCloud && vars?.deletion_protection !== false)
      lines.push(
        `   Production installs keep deletion protection on: first set "deletion_protection": false in ${variables} and run ${run("apply")}.`
      )
    else if (vars?.gcp && vars.gcp.deletion_protection !== false)
      lines.push(
        `   Cloud SQL keeps deletion protection on: first set "deletion_protection": false under "gcp" in ${variables} and run ${run("apply")}.`
      )
  }
  if (tokens && tokens.state !== "empty") {
    const paste = "read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN"
    const destroy = `terraform -chdir=${shellWord(tokens.root)} destroy`
    commands.push(paste, destroy)
    lines.push(
      `${workload ? 2 : 1}. Revoke this instance's scoped Cloudflare tokens${workload ? " last: the destroy above uses them" : ""}. The first command waits, without echoing, for a Cloudflare token that can edit API tokens (the one you gave the installer, or a new one from the same form); the second destroys the scoped tokens through their own state:`,
      `     ${paste}`,
      `     ${destroy}`
    )
  }
  return { commands, lines }
}

/**
 * `azad --reset`: clears an instance directory so the next run starts from
 * scratch, only once no Terraform state of the instance records resources.
 *
 * It reads two states: the installation's, in the instance's Terraform
 * directory (see {@link instanceTerraformDirectory}), and the scoped
 * Cloudflare tokens' in `<directory>/cloudflare-bootstrap/terraform`. While
 * either records resources, or cannot be read, it removes nothing and reports
 * the exact commands that remove them: the azad-terraform drivers of
 * `options.terraform` with the source it was deployed from (`options.source`,
 * else the saved `AZAD_CLI_SOURCE`). It never downloads, runs a destroy or
 * calls a provider.
 *
 * Otherwise it deletes, after `options.confirm` agrees (without it, it only
 * reports what it would delete): the saved answers and private settings, the
 * Cloudflare bootstrap credential, the token records and their empty state,
 * the meetings record and leftovers of interrupted writes in the directory,
 * and, in its Terraform directory, the variables, saved plans and the deploy
 * step's state and keys. Files are deleted, not backed up: they hold
 * credentials that must not linger. The Terraform state files and their
 * backups, Terraform's working data and the directory's `.gitignore` stay.
 *
 * @throws CliError when the directory is not one the current user owns,
 * or a Cloudflare token operation holds its lock.
 */
export async function resetInstance(
  options: {
    directory: string
    source?: string
    /** The drivers the destroy commands run; defaults to the pinned release. */
    terraform?: TerraformSelection
    /** Agrees to delete the files `summary` lists; without it nothing is deleted. */
    confirm?: (summary: string) => Promise<boolean>
    /** The command that starts this instance over, for the final message. */
    rerun?: string
  },
  execute: Run = listState
): Promise<ResetReport> {
  const directory = resolve(options.directory)
  const stat = lstatSync(directory, { throwIfNoEntry: false })
  if (!stat)
    return {
      status: "nothing_to_reset",
      message: `${directory} does not exist; there is nothing to reset.`,
    }
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid()))
    throw new CliError(
      "Choose an instance directory owned by the current user."
    )
  if (present(join(directory, ".cloudflare-bootstrap-cli.lock")))
    throw new CliError(
      "A Cloudflare token operation may be running for this instance. Wait for it to finish, then reset."
    )
  const blocking: StateCheck[] = []
  const envPath = join(directory, ".env")
  let saved: Record<string, string> = {}
  try {
    const file = lstatSync(envPath, { throwIfNoEntry: false })
    if (file) {
      if (!file.isFile()) throw new Error("Not a regular file")
      saved = parse(readFileSync(envPath))
    }
  } catch {
    blocking.push({
      root: directory,
      state: "unverified",
      reason: "its saved settings could not be read",
    })
  }
  const source = options.source
    ? resolve(options.source)
    : saved.AZAD_CLI_SOURCE
  const selection = options.terraform ?? selectTerraform()
  const googleCloud = saved.AZAD_CLI_TARGET === "gcp"
  // Workload resources exist only once a deployment has started.
  const deployed = Boolean(saved.AZAD_CLI_SOURCE_REVISION)
  const files = deployed
    ? instanceTerraformDirectory(directory, saved)
    : undefined
  const workload =
    files && present(files) ? inspectInstanceState(files) : undefined
  if (workload && workload.state !== "empty") blocking.push(workload)
  const tokenRoot = join(directory, "cloudflare-bootstrap", "terraform")
  const tokens = present(tokenRoot)
    ? inspectState(tokenRoot, execute)
    : undefined
  if (tokens && tokens.state !== "empty") blocking.push(tokens)

  if (blocking.length) {
    const live = blocking.some((check) => check.state === "live")
    const liveWorkload =
      files !== undefined && workload !== undefined && workload.state !== "empty"
    // The destroy deploys from the checkout that deployed this instance.
    const sourcePresent = source !== undefined && present(source)
    const steps = removalSteps(
      liveWorkload && source && sourcePresent
        ? {
            root: googleCloud ? undefined : cloudflareRoot(saved),
            source,
            terraform: selection.directory,
            directory,
            files,
            googleCloud,
          }
        : undefined,
      tokens
    )
    const missingSource = liveWorkload && !sourcePresent
    const missingTerraform =
      liveWorkload && sourcePresent && !terraformReady(selection)
    const message = [
      live
        ? "Nothing was removed: Terraform still records resources for this instance."
        : "Nothing was removed: this instance's Terraform state could not be checked.",
      ...blocking.map(
        (check) =>
          `  ${check.root}: ${
            check.state === "live"
              ? `${check.resources} resource${check.resources === 1 ? "" : "s"}${check === tokens ? " (this instance's scoped Cloudflare tokens)" : ""}`
              : `not verified (${check.reason})`
          }`
      ),
      ...(missingSource
        ? [
            "Rerun with --source pointing to the Azad checkout that deployed this instance.",
          ]
        : []),
      ...(missingTerraform
        ? [
            selection.kind === "release"
              ? `The destroy commands run azad-terraform ${selection.version} from ${selection.directory}, which is not on this machine: clone https://github.com/${AZAD_TERRAFORM_REPOSITORY} at tag v${selection.version}, run bun install --frozen-lockfile in it, and rerun with --terraform-dir pointing to the clone.`
              : `${selection.directory} is not an azad-terraform checkout; rerun with --terraform-dir pointing to one.`,
          ]
        : []),
      ...(steps.lines.length
        ? ["Remove them, then run azad --reset again:", ...steps.lines]
        : []),
    ].join("\n")
    return {
      status: live ? "live_resources" : "state_unverified",
      states: blocking,
      commands: steps.commands,
      message,
    }
  }

  const removals: Removal[] = INSTANCE_FILES.flatMap(([name, what]) =>
    present(join(directory, name))
      ? [{ path: join(directory, name), what }]
      : []
  )
  for (const name of readdirSync(directory))
    if (INTERRUPTED_WRITE.test(name))
      removals.push({
        path: join(directory, name),
        what: "an interrupted write",
      })
  if (files && present(files))
    for (const name of readdirSync(files).sort()) {
      const what =
        name === "terraform.tfvars.json"
          ? "this instance's Terraform variables"
          : name.endsWith(".tfplan")
            ? "a saved Terraform plan"
            : name === (googleCloud ? "celld-install" : "installer-state")
              ? "the deploy step's state and keys"
              : undefined
      if (what) removals.push({ path: join(files, name), what })
    }
  if (!removals.length)
    return {
      status: "nothing_to_reset",
      message: `${directory} has no saved settings to remove.`,
    }
  const remove = removals.map((item) => item.path)
  const summary = [
    `Reset ${directory}: delete these files so the next run starts from scratch.`,
    describe(removals),
    "They hold credentials, so they are deleted, not backed up. Nothing in your cloud accounts changes.",
    ...(files && present(files)
      ? [
          `The Terraform state and its backups in ${files} stay; delete them yourself once nothing they record exists.`,
        ]
      : []),
  ].join("\n")
  if (!options.confirm)
    return {
      status: "needs_confirmation",
      remove,
      message: `${summary}\nRerun with --yes to delete them.`,
    }
  if (!(await options.confirm(summary)))
    return { status: "cancelled", remove, message: "Nothing was removed." }
  for (const path of remove) rmSync(path, { recursive: true, force: true })
  return {
    status: "reset_complete",
    removed: remove,
    message: [
      `Deleted this instance's saved settings and credentials:`,
      describe(removals),
      `Run ${options.rerun ?? `azad --directory ${shellWord(directory)}`} to start over.`,
      ...(saved.AZAD_CLI_CLERK_APP_ID || saved.GITHUB_APP_ID
        ? [
            "Nothing in your accounts changed. Delete the Clerk application and GitHub App the installer created in their dashboards if you no longer need them; a new Clerk production instance for the same hostname needs the old application deleted first.",
          ]
        : []),
    ].join("\n"),
  }
}
