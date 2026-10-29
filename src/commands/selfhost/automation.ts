import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { z } from "zod"
import { LocalConfig, readPrivateEnv } from "./config"
import { commandEnvironment } from "../../command-environment"
import { spawnToolSync } from "../../process"
import { deployInstance, type Run } from "./deploy"
import { selectTerraform, type TerraformSelection } from "./terraform"
import { fixedSettingChanges, fixedSettingsMessage } from "./deployed-settings"
import { CliError } from "../../error"
import { validateBootstrapFile } from "./bootstrap-credentials"
import { verifyCompletedBootstrap } from "./cloudflare-bootstrap"
import {
  configure,
  OPTIONAL_SETTING_KEYS,
  validateField,
  type Field,
  type Questions,
} from "./wizard"

const inputSchema = z.strictObject({
  fields: z.record(z.string(), z.string()).default({}),
  choices: z.record(z.string(), z.union([z.string(), z.boolean()])).default({}),
})

type Input = z.infer<typeof inputSchema>
type Choice = { label: string; values?: string[]; initial?: string | boolean }
type PublicField = {
  label: string
  secret: boolean
  optional: boolean
  default?: string
}
type Definition = { fields: Map<string, Field>; choices: Map<string, Choice> }
type Issue = {
  field: string
  problem:
    | "missing"
    | "invalid"
    | "secret_in_config"
    | "unknown"
    | "inactive"
    | "bound_instance"
    | "immutable"
}
export type AutomationAction =
  | "schema"
  | "status"
  | "configure"
  | "bootstrap"
  | "plan"
  | "apply"

/** Walks the wizard's question graph for one hosting target and database. */
async function definitions(
  provider?: string,
  target = "cloudflare"
): Promise<Definition> {
  const fields = new Map<string, Field>()
  const choices = new Map<string, Choice>()
  for (const auth of ["manual", "bootstrap"]) {
    const seed = {
      GITHUB_APP_PRIVATE_KEY: "schema-only",
      AZAD_SELF_HOST_DATABASE_CA_CERT_ID: auth === "manual" ? "schema-ca" : "",
    }
    await configure(
      {
        read: () => ({ ...seed }),
        save: () => {},
      },
      {
        async field(field) {
          fields.set(field.key, field)
          // Visit the conditional CA field without reading a credential or connecting.
          if (field.key === "DATABASE_URL")
            return provider === "postgres"
              ? "postgresql://schema:schema@db.invalid/schema?sslmode=verify-full"
              : "postgresql://schema:schema@ep-schema.neon.tech/schema?sslmode=require&channel_binding=require"
          return ""
        },
        async choose(label, options, initial, key) {
          if (!key)
            throw new CliError("An installer choice has no input key.")
          choices.set(key, {
            label,
            values: options.map((option) => option.value),
            initial,
          })
          // S3-compatible storage visits every bucket field the other
          // storage choices ask, so they are known inputs too.
          return key === "target"
            ? target
            : key === "database"
              ? (provider ?? initial ?? options[0].value)
              : key === "cloudflareAuth"
                ? auth
                : key === "storage"
                  ? "s3"
                  : (initial ?? options[0].value)
        },
        async confirm(label, initial, key) {
          if (!key)
            throw new CliError("An installer choice has no input key.")
          choices.set(key, { label, initial })
          return true
        },
        note() {},
      }
    )
  }
  return { fields, choices }
}

/** One target's (and database's) inputs, as `--schema` publishes them. */
type PublicDefinition = {
  fields: Record<string, PublicField>
  choices: Record<string, Choice>
}

function describe(schema: Definition): PublicDefinition {
  return {
    fields: Object.fromEntries(
      [...schema.fields].map(([key, field]) => {
        const description: PublicField = {
          label: field.privateKeyFile
            ? "GitHub App PEM private key"
            : field.label,
          secret: field.secret ?? false,
          optional: field.optional ?? false,
        }
        if (!field.secret && field.initial !== undefined)
          description.default = field.initial
        return [key, description]
      })
    ),
    choices: Object.fromEntries(schema.choices),
  }
}

/**
 * Derives machine-readable input descriptions from the same question graph as
 * the human wizard: one entry per database for the Cloudflare target
 * (`providers`), and `googleCloud` for `choices.target = "gcp"`, which creates
 * its own database.
 */
export async function automationSchema() {
  const base = await definitions()
  const providers = base.choices.get("database")?.values ?? []
  const output: Record<string, PublicDefinition> = {}
  for (const provider of providers)
    output[provider] = describe(await definitions(provider))
  return {
    status: "schema",
    providers: output,
    googleCloud: describe(await definitions(undefined, "gcp")),
  }
}

function readInput(path?: string): Input {
  if (!path) return { fields: {}, choices: {} }
  try {
    return inputSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    throw new CliError(
      "Config must be JSON with fields (string values) and choices (strings or booleans). No input values were displayed."
    )
  }
}

/** Suppresses provider output; only explicitly requested tool-version and Git results are captured internally. */
export const quietRun: Run = (command, args, cwd, capture = false) => {
  const result = spawnToolSync(command, args, {
    cwd,
    env: commandEnvironment(),
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "ignore",
  })
  return {
    status: result.status,
    stdout: capture ? (result.stdout ?? "") : "",
    stderr: capture ? (result.stderr ?? "") : "",
  }
}

/**
 * Configures, inspects or explicitly deploys without prompts; reports names
 * and phases, never credential values. Once a deploy has started it changes
 * no setting: any difference is a `bound_instance` issue, and each setting the
 * deploy fixed that the input would change is also an `immutable` issue,
 * explained by the report's `message`.
 */
export async function runAutomation(
  options: {
    directory: string
    configPath?: string
    credentialsPath?: string
    /** The Azad app source checkout to deploy; defaults to the instance's saved one. */
    source?: string
    /** The azad-terraform drivers a deploy runs; defaults to the pinned release. */
    terraform?: TerraformSelection
    action: Exclude<AutomationAction, "schema">
  },
  execute: Run = quietRun
) {
  const envPath = resolve(options.directory, ".env")
  const existing = existsSync(envPath) ? readPrivateEnv(envPath) : {}
  const input = readInput(options.configPath)
  const credentials = options.credentialsPath
    ? readPrivateEnv(options.credentialsPath)
    : {}
  const requestedProvider =
    input.choices.database ??
    existing.AZAD_CLI_DATABASE_SERVICE ??
    existing.AZAD_CLI_DATABASE_PROVIDER
  const target = String(
    input.choices.target ?? existing.AZAD_CLI_TARGET ?? "cloudflare"
  )
  const googleCloud = target === "gcp"
  const base = await definitions()
  const providers = base.choices.get("database")?.values ?? []
  const issues: Issue[] = []
  if (!googleCloud && !providers.some((value) => value === requestedProvider))
    issues.push({
      field: "database",
      problem: requestedProvider === undefined ? "missing" : "invalid",
    })
  const provider =
    providers.find((value) => value === requestedProvider) ?? providers[0]
  const schema = googleCloud
    ? await definitions(undefined, "gcp")
    : await definitions(provider)
  for (const key of Object.keys(input.fields)) {
    const field = schema.fields.get(key)
    if (!field) issues.push({ field: "config", problem: "unknown" })
    else if (field.secret)
      issues.push({ field: key, problem: "secret_in_config" })
  }
  for (const key of Object.keys(credentials))
    if (!schema.fields.has(key))
      issues.push({ field: "credentials", problem: "unknown" })
  for (const [key, value] of Object.entries(input.choices)) {
    const choice = schema.choices.get(key)
    if (!choice) issues.push({ field: "choices", problem: "unknown" })
    else if (
      choice.values
        ? !choice.values.includes(String(value))
        : value !== true && value !== false
    )
      issues.push({ field: key, problem: "invalid" })
  }
  const supplied = { ...credentials, ...input.fields }
  if (issues.length) return { status: "needs_input", issues }
  const seed = { ...existing, ...credentials, ...input.fields }
  const usedFields = new Set<string>()
  const usedChoices = new Set<string>()
  const questions: Questions = {
    async field(field, previous) {
      usedFields.add(field.key)
      let value = seed[field.key] ?? previous ?? field.initial ?? ""
      if (field.bootstrapTokenFile) {
        if (verifyCompletedBootstrap(options.directory, existing)) {
          // The administrator credential is no longer needed or changed after completion.
          value = existing[field.key] ?? ""
        } else if (!value) {
          issues.push({ field: field.key, problem: "missing" })
        } else {
          value = resolve(value)
          try {
            validateBootstrapFile(value)
          } catch {
            issues.push({ field: field.key, problem: "invalid" })
          }
        }
      }
      // Validate the resolved saved value too, rather than relying on blank-input retention.
      const error = validateField(field, value)
      if (error)
        issues.push({
          field: field.key,
          problem: value.trim() ? "invalid" : "missing",
        })
      return value
    },
    async choose(_message, _choices, initial, key) {
      if (!key)
        throw new CliError("An installer choice has no input key.")
      usedChoices.add(key)
      return String(
        input.choices[key] ?? (key === "database" ? requestedProvider : initial)
      )
    },
    async confirm(_message, initial, key) {
      if (!key)
        throw new CliError("An installer choice has no input key.")
      usedChoices.add(key)
      if (input.choices[key] !== undefined) return input.choices[key] === true
      // Configs written before the optional-settings switch answer its nested
      // choices directly; any of them turns the switch on.
      if (key === "optionalSettings")
        return OPTIONAL_SETTING_KEYS.some(
          (nested) => input.choices[nested] !== undefined
        )
      return initial ?? false
    },
    note() {},
  }
  const values = await configure(
    { read: () => ({ ...seed }), save() {} },
    questions
  )
  // Compare the complete effective configuration after applying the Neon policy,
  // still in memory and before any write or backend invocation. Automation
  // never changes a deployed instance; a setting the deploy fixed is also
  // named, since changing it means destroying the installation.
  const fixed = existing.AZAD_CLI_SOURCE_REVISION
    ? fixedSettingChanges(existing, values)
    : []
  for (const field of fixed) issues.push({ field, problem: "immutable" })
  if (
    existing.AZAD_CLI_SOURCE_REVISION &&
    [...new Set([...Object.keys(existing), ...Object.keys(values)])].some(
      (key) => existing[key] !== values[key]
    )
  )
    issues.push({ field: "instance", problem: "bound_instance" })
  // A supplied private key is consumed directly; configure does not ask to read it again.
  if (seed.GITHUB_APP_PRIVATE_KEY) {
    usedFields.add("GITHUB_APP_PRIVATE_KEY")
    const field = schema.fields.get("GITHUB_APP_PRIVATE_KEY")
    if (field && validateField(field, seed.GITHUB_APP_PRIVATE_KEY))
      issues.push({ field: field.key, problem: "invalid" })
  }
  for (const key of Object.keys(supplied))
    if (!usedFields.has(key)) issues.push({ field: key, problem: "inactive" })
  for (const key of Object.keys(input.choices))
    if (!usedChoices.has(key)) issues.push({ field: key, problem: "inactive" })
  if (issues.length)
    return fixed.length
      ? { status: "needs_input", issues, message: fixedSettingsMessage(fixed) }
      : { status: "needs_input", issues }
  if (values.AZAD_CLI_CLOUDFLARE_AUTH === "bootstrap")
    verifyCompletedBootstrap(options.directory, values)
  if (options.action === "status")
    return { status: "configuration_ready", issues: [] }
  if (
    options.action !== "configure" &&
    !options.source &&
    !existing.AZAD_CLI_SOURCE
  )
    return { status: "backend_unavailable", issues: [] }
  const config = new LocalConfig(options.directory)
  if (!existing.AZAD_CLI_SOURCE_REVISION) config.save(values)
  if (options.action === "configure")
    return { status: "configuration_saved", issues: [] }
  const outcome = await deployInstance(
    config,
    {
      source: options.source ?? existing.AZAD_CLI_SOURCE,
      terraform: options.terraform ?? selectTerraform(),
    },
    {
      ...questions,
      async confirm(_message, _initial, key) {
        return (
          ((key === "apply" || key === "bootstrap") &&
            options.action === "apply") ||
          (key === "bootstrap" && options.action === "bootstrap")
        )
      },
    },
    execute,
    { bootstrapOnly: options.action === "bootstrap" }
  )
  return { status: outcome, issues: [] }
}

/**
 * True when the saved configuration in `directory` answers every required
 * question validly, checked like `--status`: no prompts, writes, browser or
 * network. Any error counts as incomplete, so the wizard walks the questions
 * and reports the problem where it belongs.
 */
export async function savedConfigurationReady(
  directory: string
): Promise<boolean> {
  try {
    const report = await runAutomation({ directory, action: "status" })
    return report.status === "configuration_ready"
  } catch {
    return false
  }
}

/**
 * Saves the effective form of a ready configuration, as noninteractive
 * `configure` would: unanswered optional choices take their defaults. Returns
 * false, writing nothing, if it is no longer complete.
 */
export async function completeSavedConfiguration(
  directory: string
): Promise<boolean> {
  const report = await runAutomation({ directory, action: "configure" })
  return report.status === "configuration_saved"
}
