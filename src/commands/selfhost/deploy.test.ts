import { afterEach, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  unlinkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "dotenv"
import { LocalConfig, serializeEnv, upsertPrivateEnv } from "./config"
import { saveBootstrapToken } from "./bootstrap-credentials"
import type { Run } from "../../process"
import {
  deployInstance,
  instanceTerraformDirectory,
  type DeploySources,
} from "./deploy"
import { fakeCloudflare } from "./realtimekit-fixture"
import type { Questions } from "./wizard"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})
const revision = "a".repeat(40)

/**
 * The app source checkout (its Git commit comes from the fake `git`) and a
 * local azad-terraform checkout with the three drivers, both with
 * dependencies installed.
 */
function checkouts(root: string): DeploySources {
  const source = join(root, "source")
  mkdirSync(join(source, "node_modules"), { recursive: true })
  const terraform = join(root, "azad-terraform")
  mkdirSync(join(terraform, "scripts"), { recursive: true })
  mkdirSync(join(terraform, "node_modules"))
  for (const driver of ["cloudflare", "gcp", "bootstrap"])
    writeFileSync(
      join(terraform, "scripts", `${driver}.ts`),
      "// azad-terraform driver fixture"
    )
  return { source, terraform: { kind: "local", directory: terraform } }
}

/** True when `args` run the named azad-terraform driver. */
const runs = (args: string[], driver: string) =>
  args[1]?.endsWith(`/scripts/${driver}.ts`) === true

/** A driver call's command and Terraform arguments, without the driver's own options. */
const operation = (args: string[]) =>
  args.slice(
    2,
    args.findIndex((arg) =>
      ["--root", "--source", "--instance-dir"].includes(arg)
    )
  )

function fixture(provider: "cloudsql" | "postgres", adc = true) {
  const root = mkdtempSync(join(tmpdir(), "azad-cli-deploy-"))
  roots.push(root)
  const sources = checkouts(root)
  const config = new LocalConfig(join(root, "instance"))
  config.save({
    AZAD_CLI_DATABASE_PROVIDER: provider,
    AZAD_CLI_WEB_HOST: "board.example.com",
    CLOUDFLARE_ACCOUNT_ID: "b".repeat(32),
    CLOUDFLARE_API_TOKEN: "fixture-secret",
    AZAD_CLI_GCP_PROJECT: "customer-project",
    AZAD_CLI_GCP_REGION: "europe-west1",
    AZAD_CLI_RUNNER_CIDR: "203.0.113.1/32",
  })
  const files = instanceTerraformDirectory(config.directory, config.read())
  const notes: string[] = []
  const operations: string[] = []
  const argv: string[][] = []
  const questions: Questions = {
    field: () => Promise.resolve(""),
    choose: () => Promise.resolve(""),
    confirm: () => Promise.resolve(true),
    note(message) {
      notes.push(message)
    },
  }
  const execute: Run = (command, args) => {
    argv.push(args)
    if (command === "git" && args[0] === "rev-parse")
      return { status: 0, stdout: revision }
    if (args[0] === "--version" || args[0] === "version")
      return { status: 0, stdout: "999.0.0" }
    if (command === "gcloud") return { status: adc ? 0 : 1, stdout: "" }
    const operation = args[2]
    operations.push(operation)
    expect(args.slice(-2)).toEqual(["--instance-dir", config.directory])
    if (operation === "setup") {
      // Setup writes the instance's variables and adds what it derives to the
      // instance's own settings file, which the deploy reads.
      mkdirSync(files, { recursive: true })
      writeFileSync(
        join(files, "terraform.tfvars.json"),
        JSON.stringify({
          cloudflare: {
            account_id: "b".repeat(32),
            web_origin: "https://board.example.com",
          },
          deployment: { revision },
          gcp:
            provider === "cloudsql"
              ? {
                  project_id: "customer-project",
                  authorized_networks: { runner: "203.0.113.1/32" },
                }
              : undefined,
        })
      )
      upsertPrivateEnv(config.envPath, {
        GITHUB_WEBHOOK_SECRET: "fixture-generated-webhook",
      })
    }
    if (operation === "apply")
      writeFileSync(join(files, "terraform.tfstate"), "preserved-state")
    return { status: 0, stdout: "" }
  }
  return {
    root,
    sources,
    files,
    config,
    notes,
    operations,
    argv,
    execute,
    questions,
  }
}

test("Cloud SQL handoff preserves generated settings and selected region, with secrets outside argv", async () => {
  const f = fixture("cloudsql")
  await deployInstance(f.config, f.sources, f.questions, f.execute)
  const vars = JSON.parse(
    readFileSync(join(f.files, "terraform.tfvars.json"), "utf8")
  )
  expect(vars.gcp).toEqual({
    project_id: "customer-project",
    authorized_networks: { runner: "203.0.113.1/32" },
    region: "europe-west1",
  })
  expect(f.config.read().GITHUB_WEBHOOK_SECRET).toBe(
    "fixture-generated-webhook"
  )
  expect(f.argv.flat().join(" ")).not.toContain("fixture-secret")
  expect(f.notes.join(" ")).not.toContain("fixture-generated-webhook")
})

test("a deploy stops before any helper runs while a deployment tool is missing, and names it", async () => {
  const f = fixture("postgres")
  const execute: Run = (command, args, cwd, capture) =>
    command === "terraform"
      ? { status: null, stdout: "" }
      : f.execute(command, args, cwd, capture)
  const outcome = await deployInstance(f.config, f.sources, f.questions, execute)
  expect(outcome).toBe("missing_prerequisites")
  expect(f.notes).toEqual([
    "These tools are missing or too old. Please install them, then run azad again:\n- Terraform 1.13.4 or newer (not installed): https://developer.hashicorp.com/terraform/install",
  ])
  expect(f.operations).toEqual([])
})

test("Cloud SQL without Application Default Credentials stops before any helper runs", async () => {
  const f = fixture("cloudsql", false)
  const outcome = await deployInstance(
    f.config,
    f.sources,
    f.questions,
    f.execute
  )
  expect(outcome).toBe("missing_prerequisites")
  expect(f.notes.join("\n")).toContain("gcloud auth application-default login")
  expect(f.operations).toEqual([])
})

test("resuming PostgreSQL reuses setup and existing state instead of generating another instance", async () => {
  const f = fixture("postgres")
  await deployInstance(f.config, f.sources, f.questions, f.execute)
  await deployInstance(f.config, f.sources, f.questions, f.execute)
  expect(
    f.operations.filter((operation) => operation === "setup")
  ).toHaveLength(1)
  expect(readFileSync(join(f.files, "terraform.tfstate"), "utf8")).toBe(
    "preserved-state"
  )
  // The plan applied is the one this run saved, in the instance.
  expect(
    f.argv
      .filter((args) => args[2] === "plan" || args[2] === "apply")
      .map((args) => args.slice(2, 4))
  ).toEqual([
    ["plan", "-out=terraform.tfplan"],
    ["apply", "terraform.tfplan"],
    ["plan", "-out=terraform.tfplan"],
    ["apply", "terraform.tfplan"],
  ])
})

test("declining a plan retains configuration and does not apply", async () => {
  const f = fixture("postgres")
  f.questions.confirm = (message) =>
    Promise.resolve(!message.startsWith("Apply"))
  await deployInstance(f.config, f.sources, f.questions, f.execute)
  expect(f.operations).not.toContain("apply")
  expect(f.config.read().AZAD_CLI_SOURCE_REVISION).toBe(revision)
})

test("a changed source revision cannot reset a previously configured instance", async () => {
  const f = fixture("postgres")
  f.config.save({
    ...f.config.read(),
    AZAD_CLI_SOURCE_REVISION: "c".repeat(40),
  })
  await expect(
    deployInstance(f.config, f.sources, f.questions, f.execute)
  ).rejects.toThrow("another source revision")
  expect(f.operations).toEqual([])
})

test("verified database TLS refuses a backend without the reviewed CA support before setup", async () => {
  const f = fixture("postgres")
  f.config.save({
    ...f.config.read(),
    AZAD_SELF_HOST_DATABASE_CA_CERT_ID: "fixture-ca",
  })
  const before = readFileSync(f.config.envPath, "utf8")
  const oldBackend: Run = (command, args, cwd, capture) =>
    command === "git" && args[0] === "merge-base"
      ? { status: 1, stdout: "" }
      : f.execute(command, args, cwd, capture)
  await expect(
    deployInstance(f.config, f.sources, f.questions, oldBackend)
  ).rejects.toThrow("certificate-verified database TLS")
  expect(f.operations).toEqual([])
  expect(readFileSync(f.config.envPath, "utf8")).toBe(before)
})

function bootstrapFixture() {
  const f = fixture("postgres")
  const bootstrapFile = saveBootstrapToken(
    f.config.directory,
    "fixture-root-secret"
  )
  f.config.save({
    ...f.config.read(),
    AZAD_CLI_CLOUDFLARE_AUTH: "bootstrap",
    AZAD_CLI_CLOUDFLARE_BOOTSTRAP_FILE: bootstrapFile,
    AZAD_SELF_HOST_MINIAPPS: "disabled",
    CLERK_SECRET_KEY: "fixture-clerk-secret",
  })
  const execute: Run = (command, args, cwd, capture) => {
    expect(args.join(" ")).not.toContain("fixture-root-secret")
    if (command === "git" && args[0] === "merge-base")
      return { status: 0, stdout: "" }
    if (!runs(args, "bootstrap")) {
      if (args[2] === "setup") {
        const credentials = readFileSync(
          args[args.indexOf("--credentials") + 1],
          "utf8"
        )
        expect(credentials).toContain("fixture-derived-deployment")
        expect(credentials).not.toContain("fixture-root-secret")
      }
      return f.execute(command, args, cwd, capture)
    }
    const input = JSON.parse(
      readFileSync(args[args.indexOf("--config") + 1], "utf8")
    )
    if (args[2] === "plan")
      return {
        status: 0,
        stdout: JSON.stringify({
          version: 1,
          accountId: input.accountId,
          sourceRevision: input.revision,
          zonesResolvedDuringApply: true,
        }),
      }
    const state = args[args.indexOf("--state-dir") + 1]
    mkdirSync(join(state, "terraform"), { recursive: true, mode: 0o700 })
    const credentialsFile = join(state, "credentials.env")
    writeFileSync(
      credentialsFile,
      serializeEnv({ CLOUDFLARE_API_TOKEN: "fixture-derived-deployment" }),
      { mode: 0o600 }
    )
    const result = {
      version: 1,
      accountId: input.accountId,
      sourceRevision: input.revision,
      zoneIds: ["e".repeat(32)],
      tokenIds: { deployment: "d".repeat(32) },
      credentialsFile,
    }
    writeFileSync(join(state, "result.json"), JSON.stringify(result), {
      mode: 0o600,
    })
    writeFileSync(
      join(state, "receipt.json"),
      JSON.stringify({
        version: 1,
        phase: "complete",
        config: input,
        zoneIds: result.zoneIds,
      }),
      { mode: 0o600 }
    )
    writeFileSync(
      join(state, "terraform", "terraform.tfstate"),
      JSON.stringify({
        resources: [
          {
            type: "cloudflare_api_token",
            name: "scoped",
            instances: [
              {
                index_key: "deployment",
                attributes: {
                  id: "d".repeat(32),
                  value: "fixture-derived-deployment",
                },
              },
            ],
          },
        ],
      }),
      { mode: 0o600 }
    )
    return { status: 0, stdout: JSON.stringify(result) }
  }
  return { ...f, execute, bootstrapFile }
}

test("declining token creation returns only a bootstrap preview without workload planning", async () => {
  const f = bootstrapFixture()
  f.questions.confirm = async (_message, _initial, key) => key !== "bootstrap"
  expect(await deployInstance(f.config, f.sources, f.questions, f.execute)).toBe(
    "bootstrap_planned"
  )
  expect(f.operations).toEqual([])
  expect(existsSync(join(f.config.directory, "cloudflare-bootstrap"))).toBe(
    false
  )
  expect(f.config.read().CLOUDFLARE_API_TOKEN).toBe("fixture-secret")
})

test("explicit token setup hands derived credentials to the normal pipeline and resumes without root", async () => {
  const f = bootstrapFixture()
  expect(await deployInstance(f.config, f.sources, f.questions, f.execute)).toBe(
    "applied"
  )
  expect(f.config.read().CLOUDFLARE_API_TOKEN).toBe(
    "fixture-derived-deployment"
  )
  expect(f.config.read().CLERK_SECRET_KEY).toBe("fixture-clerk-secret")
  expect(f.config.read().GITHUB_WEBHOOK_SECRET).toBe(
    "fixture-generated-webhook"
  )
  expect(f.notes.join(" ")).not.toContain("fixture-root-secret")
  unlinkSync(f.bootstrapFile)
  const resumed: Run = (command, args, cwd, capture) => {
    if (runs(args, "bootstrap"))
      throw new Error("Unexpected administrator-token reuse")
    return f.execute(command, args, cwd, capture)
  }
  expect(await deployInstance(f.config, f.sources, f.questions, resumed)).toBe(
    "applied"
  )
})

test("an occupied backend checkout is refused before any bootstrap token operation", async () => {
  const f = bootstrapFixture()
  mkdirSync(f.files, { recursive: true })
  writeFileSync(
    join(f.files, "terraform.tfvars.json"),
    JSON.stringify({
      cloudflare: {
        web_origin: "https://other.example.com",
        account_id: "c".repeat(32),
      },
      deployment: { revision },
    })
  )
  await expect(
    deployInstance(f.config, f.sources, f.questions, f.execute)
  ).rejects.toThrow("different installation")
  expect(
    existsSync(join(f.config.directory, ".cloudflare-bootstrap.json"))
  ).toBe(false)
  expect(f.operations).toEqual([])
})

test("creating tokens alone returns before workload setup or apply", async () => {
  const f = bootstrapFixture()
  expect(
    await deployInstance(f.config, f.sources, f.questions, f.execute, {
      bootstrapOnly: true,
    })
  ).toBe("bootstrap_complete")
  expect(f.operations).toEqual([])
  expect(existsSync(join(f.files, "terraform.tfvars.json"))).toBe(false)
  expect(f.config.read().CLOUDFLARE_API_TOKEN).toBe(
    "fixture-derived-deployment"
  )
})

test("automatic Neon CA refuses an older backend before token or workload setup", async () => {
  const f = fixture("postgres")
  f.config.save({
    ...f.config.read(),
    DATABASE_URL:
      "postgresql://u:p@ep-fixture.neon.tech/db?sslmode=verify-full",
    AZAD_SELF_HOST_DATABASE_CA: "neon-isrg-root-x1",
  })
  const old: Run = (command, args, cwd, capture) =>
    command === "git" && args[0] === "merge-base"
      ? { status: 1, stdout: "" }
      : f.execute(command, args, cwd, capture)
  await expect(
    deployInstance(f.config, f.sources, f.questions, old)
  ).rejects.toThrow("automatic Neon certificate registration")
  expect(f.operations).toEqual([])
})

/**
 * A Google Cloud instance whose checkout's `gcp.ts` reports `phases` (the
 * cluster first, then everything else, on a first install) and records each
 * call.
 */
function googleCloudFixture(adc = true) {
  const root = mkdtempSync(join(tmpdir(), "azad-cli-gcp-"))
  roots.push(root)
  const sources = checkouts(root)
  const config = new LocalConfig(join(root, "instance"))
  config.save({
    AZAD_CLI_TARGET: "gcp",
    AZAD_CLI_GCP_PROJECT: "customer-project",
    AZAD_CLI_GCP_REGION: "me-central1",
    AZAD_CLI_GCP_SIZING: "evaluation",
    AZAD_CLI_WEB_HOST: "board.example.com",
    CLOUDFLARE_ACCOUNT_ID: "b".repeat(32),
    CLOUDFLARE_API_TOKEN: "fixture-secret",
  })
  const files = instanceTerraformDirectory(config.directory, config.read())
  const notes: string[] = []
  const calls: { command: string; args: string[] }[] = []
  /** Whether the cluster exists: a first install creates it with the first plan. */
  let cluster = false
  const questions: Questions = {
    field: () => Promise.resolve(""),
    choose: () => Promise.resolve(""),
    confirm: () => Promise.resolve(true),
    note(message) {
      notes.push(message)
    },
  }
  const execute: Run = (command, args) => {
    calls.push({ command, args })
    if (command === "git" && args[0] === "rev-parse")
      return { status: 0, stdout: revision }
    if (args[0] === "--version" || args[0] === "version")
      return { status: 0, stdout: "Google Cloud SDK 591.0.0" }
    if (command === "gcloud") return { status: adc ? 0 : 1, stdout: "" }
    expect(args.slice(-2)).toEqual(["--instance-dir", config.directory])
    if (args[2] === "setup") {
      mkdirSync(files, { recursive: true })
      writeFileSync(
        join(files, "terraform.tfvars.json"),
        JSON.stringify({
          project_id: "customer-project",
          region: "me-central1",
          web_host: "board.example.com",
          deployment: { revision, env_file: config.envPath },
        })
      )
    }
    if (args[2] === "phase")
      return { status: 0, stdout: cluster ? "full\n" : "cluster\n" }
    if (args[2] === "apply") cluster = true
    return { status: 0, stdout: "" }
  }
  return { sources, files, config, notes, calls, execute, questions }
}

test("Google Cloud: setup writes the variables, then each plan is shown and applied as saved once confirmed", async () => {
  const f = googleCloudFixture()
  const asked: { message: string; initial?: boolean }[] = []
  const outcome = await deployInstance(
    f.config,
    f.sources,
    {
      ...f.questions,
      confirm: async (message, initial) => {
        asked.push({ message, initial })
        return true
      },
    },
    f.execute,
    { waitForClerk: false }
  )
  expect(outcome).toBe("applied")
  const helper = f.calls.filter(
    (call) => runs(call.args, "gcp")
  )
  expect(
    helper.map((call) => operation(call.args).join(" "))
  ).toEqual([
    expect.stringMatching(/^setup /u),
    "init -input=false",
    "phase",
    "plan -input=false -out=terraform.tfplan",
    "apply -input=false terraform.tfplan",
    "plan -input=false -out=terraform.tfplan",
    "apply -input=false terraform.tfplan",
  ])
  // Two plans, each confirmed separately, defaulting to No.
  expect(asked.map((question) => question.initial)).toEqual([false, false])
  expect(asked[0].message).toContain("plan 1 of 2")
  expect(asked[1].message).toContain("plan 2 of 2")
  expect(f.notes.join("\n")).toContain(
    "the second appears after the first is created"
  )
  expect(helper[0].args).toEqual(
    expect.arrayContaining([
      "--credentials",
      f.config.envPath,
      "--project-id",
      "customer-project",
      "--region",
      "me-central1",
      "--web-host",
      "board.example.com",
      "--evaluation",
    ])
  )
  expect(JSON.stringify(f.calls)).not.toContain("-auto-approve")
  expect(JSON.stringify(f.calls)).not.toContain("fixture-secret")
  expect(f.config.read().AZAD_CLI_SOURCE_REVISION).toBe(revision)
  expect(f.notes.at(-1)).toContain("https://board.example.com")
  expect(f.notes.at(-1)).toContain(`Back up ${f.config.directory}`)
})

test("Google Cloud: declining the first plan applies nothing, and the next run plans the same step again", async () => {
  const f = googleCloudFixture()
  const declined = await deployInstance(
    f.config,
    f.sources,
    { ...f.questions, confirm: async () => false },
    f.execute,
    { waitForClerk: false }
  )
  expect(declined).toBe("planned")
  const operations = () =>
    f.calls
      .filter((call) => runs(call.args, "gcp"))
      .map((call) => call.args[2])
  expect(operations()).not.toContain("apply")
  expect(operations().at(-1)).toBe("plan")
})

test("the GitHub App is installed only once Azad is live, so GitHub's webhook and redirect reach it", async () => {
  const f = googleCloudFixture()
  f.config.save({ ...f.config.read(), GITHUB_APP_SLUG: "azad-board" })
  const steps: string[] = []
  const declined = await deployInstance(
    f.config,
    f.sources,
    {
      ...f.questions,
      confirm: () => Promise.resolve(false),
      provision: async (step) => {
        steps.push(step)
        return {}
      },
    },
    f.execute,
    { waitForClerk: false }
  )
  expect(declined).toBe("planned")
  expect(steps).toEqual([])

  const applied = await deployInstance(
    f.config,
    f.sources,
    {
      ...f.questions,
      provision: async (step) => {
        steps.push(`${step} after ${f.calls.at(-1)?.args[2]}`)
        return {}
      },
    },
    f.execute,
    { waitForClerk: false }
  )
  expect(applied).toBe("applied")
  expect(steps).toEqual(["githubInstall after apply"])

  // Without a terminal, the install page is named instead.
  const automated = googleCloudFixture()
  automated.config.save({
    ...automated.config.read(),
    GITHUB_APP_SLUG: "azad-board",
  })
  await deployInstance(
    automated.config,
    automated.sources,
    automated.questions,
    automated.execute,
    { waitForClerk: false }
  )
  expect(automated.notes).toContain(
    "Install the GitHub App on your organization: https://github.com/apps/azad-board/installations/new"
  )
})

test("Google Cloud without Application Default Credentials stops before any helper runs", async () => {
  const f = googleCloudFixture(false)
  const outcome = await deployInstance(
    f.config,
    f.sources,
    f.questions,
    f.execute
  )
  expect(outcome).toBe("missing_prerequisites")
  expect(f.notes.join("\n")).toContain("gcloud auth application-default login")
  expect(
    f.calls.some((call) => runs(call.args, "gcp"))
  ).toBe(false)
})

test("Google Cloud variables of another project are never reused", async () => {
  const f = googleCloudFixture()
  mkdirSync(f.files, { recursive: true })
  writeFileSync(
    join(f.files, "terraform.tfvars.json"),
    JSON.stringify({
      project_id: "other-project",
      region: "me-central1",
      web_host: "board.example.com",
      deployment: { revision, env_file: f.config.envPath },
    })
  )
  await expect(
    deployInstance(f.config, f.sources, f.questions, f.execute)
  ).rejects.toThrow("belong to a different installation")
  expect(
    f.calls.some((call) => runs(call.args, "gcp"))
  ).toBe(false)
})

test("with meetings on, token setup also creates the RealtimeKit app before workload setup, and a resume needs neither", async () => {
  const f = bootstrapFixture()
  f.config.save({ ...f.config.read(), AZAD_CLI_MEETINGS: "enabled" })
  const api = fakeCloudflare("fixture-root-secret")
  let handedOver: Record<string, string> = {}
  const execute: Run = (command, args, cwd, capture) => {
    if (args[2] === "setup")
      handedOver = parse(
        readFileSync(args[args.indexOf("--credentials") + 1], "utf8")
      )
    return f.execute(command, args, cwd, capture)
  }
  expect(
    await deployInstance(f.config, f.sources, f.questions, execute, {
      fetcher: api.fetcher,
    })
  ).toBe("applied")
  expect(api.apps.map((app) => app.name)).toEqual(["azad-board"])
  expect(handedOver.CLOUDFLARE_REALTIMEKIT_APP_ID).toBe(api.apps[0].id)
  expect(handedOver.CLOUDFLARE_REALTIMEKIT_API_TOKEN).toBe(api.tokens[0].value)
  expect(f.notes.join("\n")).not.toContain(api.tokens[0].value)

  unlinkSync(f.bootstrapFile)
  api.calls.length = 0
  expect(
    await deployInstance(f.config, f.sources, f.questions, execute, {
      fetcher: api.fetcher,
    })
  ).toBe("applied")
  expect(api.calls).toEqual([])
})

test("meetings turned on after setup reach the settings file the deploy reads; a plan creates nothing", async () => {
  const f = bootstrapFixture()
  const api = fakeCloudflare("fixture-root-secret")
  await deployInstance(f.config, f.sources, f.questions, f.execute)
  f.config.save({ ...f.config.read(), AZAD_CLI_MEETINGS: "enabled" })
  const planOnly = {
    ...f.questions,
    confirm: async (_message: string, _initial?: boolean, key?: string) =>
      key !== "bootstrap" && key !== "apply",
  }
  expect(
    await deployInstance(f.config, f.sources, planOnly, f.execute, {
      fetcher: api.fetcher,
    })
  ).toBe("planned")
  expect(api.calls.filter((call) => call.method !== "GET")).toEqual([])

  await deployInstance(f.config, f.sources, f.questions, f.execute, {
    fetcher: api.fetcher,
  })
  const settings = parse(readFileSync(f.config.envPath))
  expect(settings.GITHUB_WEBHOOK_SECRET).toBe("fixture-generated-webhook")
  expect(settings.CLOUDFLARE_REALTIMEKIT_APP_ID).toBe(api.apps[0].id)
})

test("Cloudflare drivers run from azad-terraform with the root name, and --source only where they deploy", async () => {
  const cases = [
    { provider: "postgres", f: bootstrapFixture() },
    { provider: "cloudsql", f: fixture("cloudsql") },
  ]
  for (const { provider, f } of cases) {
    const terraform = f.sources.terraform.directory
    const calls: { args: string[]; cwd: string }[] = []
    const execute: Run = (command, args, cwd, capture) => {
      if (command === "bun" && args[0] === "--no-env-file")
        calls.push({ args, cwd })
      return f.execute(command, args, cwd, capture)
    }
    expect(
      await deployInstance(f.config, f.sources, f.questions, execute)
    ).toBe("applied")
    for (const call of calls) {
      expect(call.cwd).toBe(terraform)
      expect(call.args[1].startsWith(join(terraform, "scripts"))).toBe(true)
    }
    const workload = calls.filter((call) => runs(call.args, "cloudflare"))
    expect(workload.map((call) => call.args[2])).toEqual([
      "setup",
      "init",
      "plan",
      "apply",
    ])
    for (const call of workload) {
      expect(call.args.slice(-2)).toEqual([
        "--instance-dir",
        f.config.directory,
      ])
      expect(call.args[call.args.indexOf("--root") + 1]).toBe(provider)
      const deploying = call.args[2] !== "init"
      expect(call.args.includes("--source")).toBe(deploying)
      if (deploying)
        expect(call.args[call.args.indexOf("--source") + 1]).toBe(
          f.sources.source
        )
    }
    const bootstrap = calls.filter((call) => runs(call.args, "bootstrap"))
    expect(bootstrap.map((call) => call.args[2])).toEqual(
      provider === "postgres" ? ["plan", "apply"] : []
    )
    for (const call of bootstrap)
      expect(call.args.slice(-2)).toEqual(["--source", f.sources.source])
  }
})

test("Google Cloud drivers take no --root, and --source only for setup, plan and apply", async () => {
  const f = googleCloudFixture()
  await deployInstance(f.config, f.sources, f.questions, f.execute, {
    waitForClerk: false,
  })
  const helper = f.calls.filter((call) => runs(call.args, "gcp"))
  for (const call of helper) {
    expect(call.args).not.toContain("--root")
    expect(call.args.includes("--source")).toBe(
      ["setup", "plan", "apply"].includes(call.args[2])
    )
  }
  expect(f.notes.at(-1)).not.toContain("agent_machine")
  f.config.save({ ...f.config.read(), AZAD_CLI_GCP_AGENT_MACHINE: "e2-standard-8" })
  await deployInstance(f.config, f.sources, f.questions, f.execute, {
    waitForClerk: false,
  })
  expect(f.notes.at(-1)).toContain(
    `bun --no-env-file ${join(f.sources.terraform.directory, "scripts", "gcp.ts")} output --instance-dir ${f.config.directory} agent_machine`
  )
})

test("a --source that is not a Git checkout stops before azad-terraform is prepared or any driver runs", async () => {
  const f = fixture("postgres")
  const calls: string[][] = []
  const notGit: Run = (command, args, cwd, capture) => {
    calls.push([command, ...args])
    return command === "git" && args[0] === "rev-parse"
      ? { status: 128, stdout: "" }
      : f.execute(command, args, cwd, capture)
  }
  const release: DeploySources = {
    source: f.sources.source,
    terraform: {
      kind: "release",
      version: "0.0.1",
      directory: join(f.root, "cache", "0.0.1"),
      url: "https://downloads.example.com/azad-terraform-0.0.1.tar.gz",
    },
  }
  await expect(
    deployInstance(f.config, release, f.questions, notGit, {
      fetcher: () => {
        throw new Error("Unexpected download")
      },
    })
  ).rejects.toThrow("must be a Git checkout with a readable commit")
  expect(
    calls.filter(
      ([command, first]) =>
        command === "tar" || (command === "bun" && first !== "--version")
    )
  ).toEqual([])
  await expect(
    deployInstance(
      f.config,
      { ...f.sources, source: join(f.root, "missing") },
      f.questions,
      f.execute
    )
  ).rejects.toThrow("must be a Git checkout")
  expect(f.operations).toEqual([])
})
