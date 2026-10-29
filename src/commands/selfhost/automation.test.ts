import { afterEach, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "dotenv"
import {
  automationSchema,
  completeSavedConfiguration,
  quietRun,
  runAutomation,
  savedConfigurationReady,
} from "./automation"
import { readPrivateEnv, serializeEnv, upsertPrivateEnv } from "./config"
import type { Run } from "./deploy"
import type { TerraformSelection } from "./terraform"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})
const privateKey =
  "-----BEGIN PRIVATE KEY-----\nfixture-pem-never-log\n-----END PRIVATE KEY-----\n"
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "azad-automation-"))
  roots.push(root)
  const directory = join(root, "instance")
  const configPath = join(root, "config.json")
  const credentialsPath = join(root, "private.env")
  const input = {
    choices: { database: "postgres", miniapps: false },
    fields: {
      AZAD_CLI_WEB_HOST: "board.example.com",
      CLOUDFLARE_ACCOUNT_ID: "b".repeat(32),
      CLERK_PUBLISHABLE_KEY: "pk_fixture",
      GITHUB_APP_ID: "123",
    },
  }
  const credentials = {
    CLOUDFLARE_API_TOKEN: "fixture-token-never-log",
    DATABASE_URL:
      "postgresql://user:fixture-password@db.example.com/azad?sslmode=require",
    CLERK_SECRET_KEY: "fixture-clerk",
    CLERK_WEBHOOK_SECRET: "fixture-webhook",
    GITHUB_APP_CLIENT_SECRET: "fixture-client-secret",
    GITHUB_APP_PRIVATE_KEY: privateKey,
  }
  writeFileSync(configPath, JSON.stringify(input))
  writeFileSync(credentialsPath, serializeEnv(credentials), { mode: 0o600 })
  // A local azad-terraform checkout, so no test downloads the pinned release;
  // backend() gives it its drivers.
  const terraform: TerraformSelection = {
    kind: "local",
    directory: join(root, "azad-terraform"),
  }
  return {
    root,
    directory,
    configPath,
    credentialsPath,
    input,
    credentials,
    terraform,
  }
}

const noBackend: Run = () => {
  throw new Error("Unexpected backend invocation")
}

test("schema and status are read-only and label private key material as secret", async () => {
  const f = fixture()
  const schema = await automationSchema()
  expect(schema.providers.postgres.fields.GITHUB_APP_PRIVATE_KEY.secret).toBe(
    true
  )
  expect(schema.providers.neon.fields.DATABASE_URL.secret).toBe(true)
  expect(schema.providers.neon.choices.database.values).toEqual([
    "neon",
    "cloudsql",
    "postgres",
  ])
  const before = statSync(f.credentialsPath)
  expect(await runAutomation({ ...f, action: "status" }, noBackend)).toEqual({
    status: "configuration_ready",
    issues: [],
  })
  expect(existsSync(f.directory)).toBe(false)
  expect(statSync(f.credentialsPath).mode).toBe(before.mode)
  expect(statSync(f.credentialsPath).mtimeMs).toBe(before.mtimeMs)
  expect(JSON.stringify(schema)).not.toContain("schema-only")
})

test("missing or invalid credentials never write configuration or call the backend", async () => {
  const f = fixture()
  for (const credentials of [
    {},
    {
      ...f.credentials,
      DATABASE_URL:
        "postgresql://user:secret@db.example.com/azad?sslmode=disable",
    },
  ]) {
    writeFileSync(f.credentialsPath, serializeEnv(credentials), { mode: 0o600 })
    const result = await runAutomation(
      { ...f, action: "apply", source: f.root },
      noBackend
    )
    expect(result.status).toBe("needs_input")
    expect(result.issues).toContainEqual({
      field: "DATABASE_URL",
      problem: Object.keys(credentials).length ? "invalid" : "missing",
    })
    expect(JSON.stringify(result)).not.toContain("secret@")
    expect(existsSync(f.directory)).toBe(false)
  }
})

test("noninteractive configuration shares provider validation and keeps values out of the result", async () => {
  const f = fixture()
  f.input.choices.database = "neon"
  writeFileSync(f.configPath, JSON.stringify(f.input))
  expect(
    (await runAutomation({ ...f, action: "configure" }, noBackend)).status
  ).toBe("needs_input")
  f.credentials.DATABASE_URL =
    "postgresql://user:fixture-password@ep-one.aws.neon.tech/azad?sslmode=require"
  writeFileSync(f.credentialsPath, serializeEnv(f.credentials))
  const result = await runAutomation({ ...f, action: "configure" }, noBackend)
  expect(result).toEqual({ status: "configuration_saved", issues: [] })
  const saved = parse(readFileSync(join(f.directory, ".env")))
  expect(saved.AZAD_CLI_DATABASE_SERVICE).toBe("neon")
  expect(saved.AZAD_CLI_DATABASE_PROVIDER).toBe("postgres")
  expect(saved.GITHUB_APP_PRIVATE_KEY).toBe(privateKey)
  expect(statSync(join(f.directory, ".env")).mode & 0o777).toBe(0o600)
  expect(JSON.stringify(result)).not.toContain("fixture")
})

test("secret values in public config and unknown field names are rejected without echoing input", async () => {
  const f = fixture()
  writeFileSync(
    f.configPath,
    JSON.stringify({
      ...f.input,
      fields: {
        ...f.input.fields,
        CLOUDFLARE_API_TOKEN: "secret-in-wrong-place",
        "secret-as-a-key": "x",
      },
    })
  )
  const result = await runAutomation({ ...f, action: "configure" }, noBackend)
  expect(result.issues).toContainEqual({
    field: "CLOUDFLARE_API_TOKEN",
    problem: "secret_in_config",
  })
  expect(result.issues).toContainEqual({ field: "config", problem: "unknown" })
  expect(JSON.stringify(result)).not.toContain("secret-in-wrong-place")
  expect(JSON.stringify(result)).not.toContain("secret-as-a-key")
  expect(existsSync(f.directory)).toBe(false)
})

test("status refuses unsafe credential files without changing permissions or following a link", async () => {
  const f = fixture()
  chmodSync(f.credentialsPath, 0o644)
  await expect(
    runAutomation({ ...f, action: "status" }, noBackend)
  ).rejects.toThrow("private regular file")
  expect(statSync(f.credentialsPath).mode & 0o777).toBe(0o644)
  chmodSync(f.credentialsPath, 0o600)
  const link = join(f.root, "link.env")
  symlinkSync(f.credentialsPath, link)
  await expect(
    runAutomation({ ...f, credentialsPath: link, action: "status" }, noBackend)
  ).rejects.toThrow("private regular file")
  expect(existsSync(f.directory)).toBe(false)
})

/**
 * An app source checkout and azad-terraform drivers whose Cloudflare driver
 * keeps the installation's files in the instance directory
 * (`terraform/postgres`) and adds what setup derives to the instance's
 * settings file.
 */
function backend(f: ReturnType<typeof fixture>) {
  const source = join(f.root, "source")
  const files = join(f.directory, "terraform", "postgres")
  mkdirSync(join(source, "node_modules"), { recursive: true })
  const drivers = f.terraform.directory
  mkdirSync(join(drivers, "scripts"), { recursive: true })
  mkdirSync(join(drivers, "node_modules"))
  for (const driver of ["cloudflare", "gcp", "bootstrap"])
    writeFileSync(
      join(drivers, "scripts", `${driver}.ts`),
      "// azad-terraform driver fixture"
    )
  const operations: string[] = []
  let sourceRevision = "a".repeat(40)
  const execute: Run = (command, args) => {
    expect(args.join(" ")).not.toContain("fixture-token-never-log")
    if (command === "git" && args[0] === "rev-parse")
      return { status: 0, stdout: sourceRevision }
    if (args[0] === "--version" || args[0] === "version")
      return { status: 0, stdout: "99.0.0" }
    const operation = args[2]
    operations.push(operation)
    if (operation === "setup") {
      mkdirSync(files, { recursive: true })
      writeFileSync(
        join(files, "terraform.tfvars.json"),
        JSON.stringify({
          cloudflare: {
            account_id: "b".repeat(32),
            web_origin: "https://board.example.com",
          },
          deployment: { revision: sourceRevision },
        })
      )
      upsertPrivateEnv(join(f.directory, ".env"), {
        GITHUB_WEBHOOK_SECRET: "fixture-generated-secret",
      })
    }
    if (operation === "apply")
      writeFileSync(join(files, "terraform.tfstate"), "customer-state")
    return { status: 0, stdout: "secret-bearing-backend-output" }
  }
  return {
    source,
    files,
    execute,
    operations,
    changeRevision() {
      sourceRevision = "c".repeat(40)
    },
  }
}

test("explicit plan and apply reuse the backend, source binding and generated keys", async () => {
  const f = fixture()
  const b = backend(f)
  expect(
    await runAutomation({ ...f, source: b.source, action: "plan" }, b.execute)
  ).toEqual({ status: "planned", issues: [] })
  expect(b.operations).toEqual(["setup", "init", "plan"])
  const saved = parse(readFileSync(join(f.directory, ".env")))
  expect(saved.GITHUB_WEBHOOK_SECRET).toBe("fixture-generated-secret")
  // Ordinary automation must not deploy just because a source was saved.
  expect(
    await runAutomation(
      { directory: f.directory, action: "configure" },
      noBackend
    )
  ).toEqual({ status: "configuration_saved", issues: [] })
  expect(await runAutomation({ ...f, action: "apply" }, b.execute)).toEqual({
    status: "applied",
    issues: [],
  })
  expect(b.operations.filter((op) => op === "setup")).toHaveLength(1)
  expect(readFileSync(join(b.files, "terraform.tfstate"), "utf8")).toBe(
    "customer-state"
  )
  b.changeRevision()
  await expect(
    runAutomation(
      { directory: f.directory, terraform: f.terraform, action: "apply" },
      b.execute
    )
  ).rejects.toThrow("another source revision")
  expect(readFileSync(join(b.files, "terraform.tfstate"), "utf8")).toBe(
    "customer-state"
  )
})

test("bound instance settings cannot be silently changed by a new config file", async () => {
  const f = fixture()
  const b = backend(f)
  await runAutomation({ ...f, source: b.source, action: "plan" }, b.execute)
  const before = readFileSync(join(f.directory, ".env"), "utf8")
  f.input.fields.AZAD_CLI_WEB_HOST = "different.example.com"
  writeFileSync(f.configPath, JSON.stringify(f.input))
  const result = await runAutomation({ ...f, action: "configure" }, noBackend)
  expect(result.issues).toContainEqual({
    field: "instance",
    problem: "bound_instance",
  })
  // The hostname is fixed by the deploy: the report names it and the way out.
  expect(result).toMatchObject({ status: "needs_input" })
  expect(result.issues).toContainEqual({
    field: "AZAD_CLI_WEB_HOST",
    problem: "immutable",
  })
  expect("message" in result && result.message).toContain(
    "AZAD_CLI_WEB_HOST cannot change after a deploy has started"
  )
  expect("message" in result && result.message).toContain("azad --reset")
  expect(JSON.stringify(result)).not.toContain("different.example.com")
  expect(readFileSync(join(f.directory, ".env"), "utf8")).toBe(before)
})

test("failed backend commands discard provider output and preserve private checkpoints", async () => {
  const f = fixture()
  const b = backend(f)
  const fail: Run = (command, args, cwd, capture) =>
    args[2] === "init"
      ? { status: 1, stdout: "fixture-leaked-token" }
      : b.execute(command, args, cwd, capture)
  await expect(
    runAutomation({ ...f, source: b.source, action: "apply" }, fail)
  ).rejects.toThrow("deployment helper stopped")
  expect(
    parse(readFileSync(join(f.directory, ".env"))).GITHUB_APP_PRIVATE_KEY
  ).toBe(privateKey)
  const child = quietRun(
    "sh",
    [
      "-c",
      "printf fixture-leaked-token; printf fixture-secret-stderr >&2; exit 7",
    ],
    f.root
  )
  expect(child).toEqual({ status: 7, stdout: "", stderr: "" })
})

test("Neon defaults to verified TLS and automatic CA without changing supplied credentials", async () => {
  const f = fixture()
  f.input.choices.database = "neon"
  f.credentials.DATABASE_URL =
    "postgresql://user:fixture-password@ep-one.aws.neon.tech/azad?sslmode=require&channel_binding=require"
  writeFileSync(f.configPath, JSON.stringify(f.input))
  writeFileSync(f.credentialsPath, serializeEnv(f.credentials))
  const original = readFileSync(f.credentialsPath, "utf8")
  const input = f.input
  const automatic = await runAutomation(
    { ...f, action: "configure" },
    noBackend
  )
  expect(automatic.status).toBe("configuration_saved")
  const automaticallySaved = parse(readFileSync(join(f.directory, ".env")))
  expect(automaticallySaved.AZAD_SELF_HOST_DATABASE_CA).toBe(
    "neon-isrg-root-x1"
  )
  expect(automaticallySaved.AZAD_SELF_HOST_DATABASE_CA_CERT_ID).toBeUndefined()
  writeFileSync(
    f.configPath,
    JSON.stringify({
      ...input,
      fields: {
        ...input.fields,
        AZAD_SELF_HOST_DATABASE_CA_CERT_ID: "fixture-ca_123",
      },
    })
  )
  expect(await runAutomation({ ...f, action: "configure" }, noBackend)).toEqual(
    {
      status: "configuration_saved",
      issues: [],
    }
  )
  const saved = parse(readFileSync(join(f.directory, ".env")))
  expect(saved.DATABASE_URL).toBe(
    "postgresql://user:fixture-password@ep-one.aws.neon.tech/azad?sslmode=verify-full"
  )
  expect(saved.AZAD_SELF_HOST_DATABASE_CA_CERT_ID).toBe("fixture-ca_123")
  expect(saved.AZAD_SELF_HOST_DATABASE_CA).toBeUndefined()
  expect(readFileSync(f.credentialsPath, "utf8")).toBe(original)
})

test("CA IDs are discoverable for verified PostgreSQL and cannot be silently ignored", async () => {
  const f = fixture()
  const schema = await automationSchema()
  expect(
    schema.providers.postgres.fields.AZAD_SELF_HOST_DATABASE_CA_CERT_ID.secret
  ).toBe(false)
  expect(schema.providers.neon.choices.neonVerifiedTls).toBeUndefined()
  writeFileSync(
    f.configPath,
    JSON.stringify({
      ...f.input,
      fields: {
        ...f.input.fields,
        AZAD_SELF_HOST_DATABASE_CA_CERT_ID: "fixture-ca_123",
      },
    })
  )
  const invalid = await runAutomation({ ...f, action: "status" }, noBackend)
  expect(invalid.issues).toContainEqual({
    field: "AZAD_SELF_HOST_DATABASE_CA_CERT_ID",
    problem: "invalid",
  })
  f.credentials.DATABASE_URL =
    "postgresql://user:fixture-password@db.example.com/azad?sslmode=verify-full"
  writeFileSync(f.credentialsPath, serializeEnv(f.credentials))
  expect(await runAutomation({ ...f, action: "status" }, noBackend)).toEqual({
    status: "configuration_ready",
    issues: [],
  })
  expect(existsSync(f.directory)).toBe(false)
})

test("bound Neon setup compares effective settings without weakening the source lock", async () => {
  const f = fixture()
  const input = {
    choices: { ...f.input.choices, database: "neon" },
    fields: {
      ...f.input.fields,
      AZAD_SELF_HOST_DATABASE_CA_CERT_ID: "fixture-ca_123",
    },
  }
  f.credentials.DATABASE_URL =
    "postgresql://user:fixture-password@ep-one.aws.neon.tech/azad?sslmode=require&channel_binding=require"
  writeFileSync(f.configPath, JSON.stringify(input))
  writeFileSync(f.credentialsPath, serializeEnv(f.credentials))
  await runAutomation({ ...f, action: "configure" }, noBackend)
  const envPath = join(f.directory, ".env")
  const saved = parse(readFileSync(envPath))
  saved.AZAD_CLI_SOURCE_REVISION = "a".repeat(40)
  writeFileSync(envPath, serializeEnv(saved))
  const before = readFileSync(envPath, "utf8")
  expect(await runAutomation({ ...f, action: "status" }, noBackend)).toEqual({
    status: "configuration_ready",
    issues: [],
  })
  input.fields.AZAD_SELF_HOST_DATABASE_CA_CERT_ID = "changed-ca"
  writeFileSync(f.configPath, JSON.stringify(input))
  const changed = await runAutomation({ ...f, action: "configure" }, noBackend)
  expect(changed.issues).toContainEqual({
    field: "instance",
    problem: "bound_instance",
  })
  expect(readFileSync(envPath, "utf8")).toBe(before)
})

test("a pooled Neon URL is saved as its direct, certificate-verified endpoint", async () => {
  const f = fixture()
  writeFileSync(
    f.configPath,
    JSON.stringify({
      choices: { ...f.input.choices, database: "neon" },
      fields: f.input.fields,
    })
  )
  writeFileSync(
    f.credentialsPath,
    serializeEnv({
      ...f.credentials,
      DATABASE_URL:
        "postgresql://user:fixture-password@ep-one-pooler.us-east-2.aws.neon.tech/azad?sslmode=require&channel_binding=require",
    })
  )
  const result = await runAutomation({ ...f, action: "configure" }, noBackend)
  expect(result).toEqual({ status: "configuration_saved", issues: [] })
  expect(readPrivateEnv(join(f.directory, ".env")).DATABASE_URL).toBe(
    "postgresql://user:fixture-password@ep-one.us-east-2.aws.neon.tech/azad?sslmode=verify-full"
  )
})

test("default verified TLS still rejects extra options and invalid CA IDs", async () => {
  const f = fixture()
  const direct =
    "postgresql://user:fixture-password@ep-one.neon.tech/azad?sslmode=require&channel_binding=require"
  for (const [url, certificate, field] of [
    [direct + "&application_name=unrequested", "fixture-ca", "DATABASE_URL"],
    [direct + "&channel_binding=require", "fixture-ca", "DATABASE_URL"],
    [
      direct.replace("channel_binding=require", "channel_binding=disable"),
      "fixture-ca",
      "DATABASE_URL",
    ],
    [
      direct.replace("sslmode=require", "sslmode=disable"),
      "fixture-ca",
      "DATABASE_URL",
    ],
    [direct, "x".repeat(37), "AZAD_SELF_HOST_DATABASE_CA_CERT_ID"],
    [direct, "../certificate", "AZAD_SELF_HOST_DATABASE_CA_CERT_ID"],
  ]) {
    writeFileSync(
      f.configPath,
      JSON.stringify({
        choices: {
          ...f.input.choices,
          database: "neon",
        },
        fields: {
          ...f.input.fields,
          AZAD_SELF_HOST_DATABASE_CA_CERT_ID: certificate,
        },
      })
    )
    writeFileSync(
      f.credentialsPath,
      serializeEnv({ ...f.credentials, DATABASE_URL: url })
    )
    const result = await runAutomation({ ...f, action: "configure" }, noBackend)
    expect(result.issues).toContainEqual({ field, problem: "invalid" })
    expect(JSON.stringify(result)).not.toContain("fixture-password")
    expect(existsSync(f.directory)).toBe(false)
  }
})

test("one bootstrap credential stays in its own private file during configuration", async () => {
  const f = fixture()
  const bootstrapPath = join(f.root, "bootstrap.env")
  writeFileSync(
    bootstrapPath,
    "CLOUDFLARE_BOOTSTRAP_API_TOKEN=fixture-root-secret\n",
    { mode: 0o600 }
  )
  writeFileSync(
    f.configPath,
    JSON.stringify({
      choices: {
        database: "postgres",
        cloudflareAuth: "bootstrap",
        miniapps: true,
      },
      fields: {
        ...f.input.fields,
        AZAD_CLI_CLOUDFLARE_BOOTSTRAP_FILE: bootstrapPath,
      },
    })
  )
  const credentials: Record<string, string> = { ...f.credentials }
  delete credentials.CLOUDFLARE_API_TOKEN
  writeFileSync(f.credentialsPath, serializeEnv(credentials))
  const before = statSync(bootstrapPath)
  expect(await runAutomation({ ...f, action: "status" }, noBackend)).toEqual({
    status: "configuration_ready",
    issues: [],
  })
  expect(existsSync(f.directory)).toBe(false)
  expect(statSync(bootstrapPath).mtimeMs).toBe(before.mtimeMs)
  expect(await runAutomation({ ...f, action: "configure" }, noBackend)).toEqual(
    { status: "configuration_saved", issues: [] }
  )
  const saved = parse(readFileSync(join(f.directory, ".env")))
  expect(saved.AZAD_CLI_CLOUDFLARE_BOOTSTRAP_FILE).toBe(bootstrapPath)
  expect(saved.CLOUDFLARE_BOOTSTRAP_API_TOKEN).toBeUndefined()
  expect(saved.CLOUDFLARE_API_TOKEN).toBeUndefined()
  expect(saved.V3_CF_API_TOKEN).toBeUndefined()
  expect(saved.V3_CF_ACCOUNT_ID).toBe(f.input.fields.CLOUDFLARE_ACCOUNT_ID)
  expect(readFileSync(join(f.directory, ".env"), "utf8")).not.toContain(
    "fixture-root-secret"
  )
})

test("administrator tokens are refused in the ordinary credential input", async () => {
  const f = fixture()
  writeFileSync(
    f.credentialsPath,
    serializeEnv({
      ...f.credentials,
      CLOUDFLARE_BOOTSTRAP_API_TOKEN: "fixture-root-secret",
    })
  )
  const result = await runAutomation({ ...f, action: "configure" }, noBackend)
  expect(result.issues).toContainEqual({
    field: "credentials",
    problem: "unknown",
  })
  expect(existsSync(f.directory)).toBe(false)
  expect(JSON.stringify(result)).not.toContain("fixture-root-secret")
})

test("older bound manual-token configurations need no new authentication choice", async () => {
  const f = fixture()
  await runAutomation({ ...f, action: "configure" }, noBackend)
  const envPath = join(f.directory, ".env")
  const saved = parse(readFileSync(envPath))
  delete saved.AZAD_CLI_CLOUDFLARE_AUTH
  saved.AZAD_CLI_SOURCE_REVISION = "a".repeat(40)
  writeFileSync(envPath, serializeEnv(saved))
  const before = readFileSync(envPath, "utf8")
  expect(await runAutomation({ ...f, action: "status" }, noBackend)).toEqual({
    status: "configuration_ready",
    issues: [],
  })
  expect(readFileSync(envPath, "utf8")).toBe(before)
})

test("noninteractive apply authorizes token bootstrap while plan remains a permission preview", async () => {
  const f = fixture()
  const b = backend(f)
  const bootstrapPath = join(f.root, "bootstrap.env")
  writeFileSync(
    bootstrapPath,
    "CLOUDFLARE_BOOTSTRAP_API_TOKEN=fixture-root-secret\n",
    { mode: 0o600 }
  )
  writeFileSync(
    f.configPath,
    JSON.stringify({
      choices: { ...f.input.choices, cloudflareAuth: "bootstrap" },
      fields: {
        ...f.input.fields,
        AZAD_CLI_CLOUDFLARE_BOOTSTRAP_FILE: bootstrapPath,
      },
    })
  )
  const credentials: Record<string, string> = { ...f.credentials }
  delete credentials.CLOUDFLARE_API_TOKEN
  writeFileSync(f.credentialsPath, serializeEnv(credentials))
  let applied = false
  const execute: Run = (command, args, cwd, capture) => {
    if (command === "git" && args[0] === "merge-base")
      return { status: 0, stdout: "" }
    if (args[1]?.endsWith("/scripts/bootstrap.ts")) {
      if (args[2] === "apply") {
        applied = true
        return { status: 1, stdout: "fixture-root-secret" }
      }
      const input = JSON.parse(
        readFileSync(args[args.indexOf("--config") + 1], "utf8")
      )
      return {
        status: 0,
        stdout: JSON.stringify({
          version: 1,
          accountId: input.accountId,
          sourceRevision: input.revision,
          zonesResolvedDuringApply: true,
        }),
      }
    }
    return b.execute(command, args, cwd, capture)
  }
  expect(
    await runAutomation({ ...f, source: b.source, action: "plan" }, execute)
  ).toEqual({ status: "bootstrap_planned", issues: [] })
  expect(applied).toBe(false)
  await expect(
    runAutomation({ ...f, source: b.source, action: "apply" }, execute)
  ).rejects.toThrow("Cloudflare token setup stopped")
  expect(applied).toBe(true)
  applied = false
  await expect(
    runAutomation({ ...f, source: b.source, action: "bootstrap" }, execute)
  ).rejects.toThrow("Cloudflare token setup stopped")
  expect(applied).toBe(true)
})

test("configs written before the optional-settings switch keep their meaning", async () => {
  const f = fixture()
  const bootstrapPath = join(f.root, "bootstrap.env")
  writeFileSync(
    bootstrapPath,
    "CLOUDFLARE_BOOTSTRAP_API_TOKEN=fixture-root-secret\n",
    { mode: 0o600 }
  )
  const credentials: Record<string, string> = {
    ...f.credentials,
    RESEND_API_KEY: "fixture-resend",
  }
  delete credentials.CLOUDFLARE_API_TOKEN
  writeFileSync(f.credentialsPath, serializeEnv(credentials))
  const configure = async (choices: Record<string, string | boolean>) => {
    writeFileSync(
      f.configPath,
      JSON.stringify({
        choices: {
          database: "postgres",
          cloudflareAuth: "bootstrap",
          ...choices,
        },
        fields: {
          ...f.input.fields,
          AZAD_CLI_CLOUDFLARE_BOOTSTRAP_FILE: bootstrapPath,
          EMAIL_FROM: "board@example.com",
          SENTRY_ENVIRONMENT: "production",
        },
      })
    )
    rmSync(f.directory, { recursive: true, force: true })
    return await runAutomation({ ...f, action: "configure" }, noBackend)
  }
  const saved = () => parse(readFileSync(join(f.directory, ".env")))
  // Older keys answer the nested choices directly; the switch follows them.
  const legacy = await configure({
    miniapps: false,
    optionalServices: true,
    email: true,
    advanced: true,
  })
  expect(legacy).toEqual({ status: "configuration_saved", issues: [] })
  expect(saved().AZAD_SELF_HOST_MINIAPPS).toBe("disabled")
  expect(saved().RESEND_API_KEY).toBe("fixture-resend")
  expect(saved().SENTRY_ENVIRONMENT).toBe("production")
  // An explicit "off" switch makes the nested answers inactive.
  const off = await configure({ optionalSettings: false, miniapps: false })
  expect(off.issues).toContainEqual({
    field: "miniapps",
    problem: "inactive",
  })
  const schema = await automationSchema()
  expect(schema.providers.neon.choices.optionalSettings).toMatchObject({
    initial: false,
  })
  expect(Object.keys(schema.providers.neon.choices)).toEqual(
    expect.arrayContaining(["miniapps", "optionalServices", "advanced"])
  )
})

test("a complete saved configuration is recognized and completed without prompts", async () => {
  const f = fixture()
  expect(await savedConfigurationReady(f.directory)).toBe(false)
  expect(existsSync(join(f.directory, ".env"))).toBe(false)
  await runAutomation({ ...f, action: "configure" }, noBackend)
  const envPath = join(f.directory, ".env")
  const saved = parse(readFileSync(envPath))
  // As if the person stopped at the storage question.
  delete saved.AZAD_CLI_STORAGE
  writeFileSync(envPath, serializeEnv(saved), { mode: 0o600 })
  expect(await savedConfigurationReady(f.directory)).toBe(true)
  expect(parse(readFileSync(envPath)).AZAD_CLI_STORAGE).toBeUndefined()
  expect(await completeSavedConfiguration(f.directory)).toBe(true)
  // The unanswered choice took its default.
  expect(parse(readFileSync(envPath)).AZAD_CLI_STORAGE).toBe("default")
  delete saved.CLERK_SECRET_KEY
  writeFileSync(envPath, serializeEnv(saved), { mode: 0o600 })
  expect(await savedConfigurationReady(f.directory)).toBe(false)
})

test("your own bucket is configurable without prompts, its keys only from the private file", async () => {
  const f = fixture()
  writeFileSync(
    f.configPath,
    JSON.stringify({
      choices: { ...f.input.choices, storage: "s3" },
      fields: {
        ...f.input.fields,
        STORAGE_BUCKET: "azad-files",
        STORAGE_REGION: "eu-central-1",
      },
    })
  )
  writeFileSync(
    f.credentialsPath,
    serializeEnv({
      ...f.credentials,
      STORAGE_ACCESS_KEY_ID: "fixture-access-key",
      STORAGE_SECRET_ACCESS_KEY: "fixture-storage-secret",
    }),
    { mode: 0o600 }
  )
  const schema = await automationSchema()
  expect(
    schema.providers.postgres.fields.STORAGE_SECRET_ACCESS_KEY
  ).toMatchObject({ secret: true })
  expect(schema.googleCloud.fields.STORAGE_BUCKET).toMatchObject({
    secret: false,
  })
  const result = await runAutomation({ ...f, action: "configure" }, noBackend)
  expect(result).toEqual({ status: "configuration_saved", issues: [] })
  const saved = parse(readFileSync(join(f.directory, ".env")))
  expect(saved.STORAGE_ADAPTER).toBe("s3")
  expect(saved.STORAGE_BUCKET).toBe("azad-files")
  expect(saved.STORAGE_SECRET_ACCESS_KEY).toBe("fixture-storage-secret")
  expect(JSON.stringify(result)).not.toContain("fixture-storage-secret")
})
