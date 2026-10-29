import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LocalConfig } from "./config"
import { CliError } from "../../error"
import {
  CancelledError,
  configure,
  validateField,
  type Questions,
} from "./wizard"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})
function fixture(provider: string) {
  const root = mkdtempSync(join(tmpdir(), "azad-cli-wizard-"))
  roots.push(root)
  const pem = join(root, "key.pem")
  writeFileSync(
    pem,
    "-----BEGIN PRIVATE KEY-----\nfixture-only\n-----END PRIVATE KEY-----\n"
  )
  const config = new LocalConfig(join(root, "instance"))
  const fields: string[] = []
  const notes: string[] = []
  const help: string[] = []
  const questions: Questions = {
    field(field, previous) {
      fields.push(field.key)
      if (field.help) help.push(field.help)
      return Promise.resolve(
        previous ??
          {
            GITHUB_APP_PRIVATE_KEY: readFileSync(pem, "utf8"),
            AZAD_CLI_WEB_HOST: "board.example.com",
            CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
            DATABASE_URL:
              provider === "neon"
                ? "postgresql://user:fixture-pass@ep-test.aws.neon.tech/azad?sslmode=require"
                : "postgresql://user:fixture-pass@db.example.com/azad?sslmode=require",
            AZAD_CLI_GCP_PROJECT: "customer-project",
            AZAD_CLI_GCP_REGION: "europe-west1",
            AZAD_CLI_RUNNER_CIDR: "203.0.113.1/32",
          }[field.key] ??
          `fixture-${field.key}`
      )
    },
    choose: (_message, _choices, _initial, key) =>
      Promise.resolve(
        (
          {
            cloudflareAuth: "manual",
            target: "cloudflare",
            storage: "default",
          } as Record<string, string>
        )[key ?? ""] ?? provider
      ),
    confirm: () => Promise.resolve(false),
    note(message) {
      notes.push(message)
    },
  }
  return { config, questions, fields, notes, help }
}

test("existing PostgreSQL setup saves a complete local credential file without regional no-op choices", async () => {
  const f = fixture("postgres")
  const values = await configure(f.config, f.questions)
  expect(values.DATABASE_URL).toBe(
    "postgresql://user:fixture-pass@db.example.com/azad?sslmode=require"
  )
  expect(values.AZAD_SELF_HOST_MINIAPPS).toBe("disabled")
  expect(values.AZAD_INSTANCE_NAME).toBe("Azad")
  expect(f.fields).not.toContain("AZAD_INSTANCE_NAME")
  expect(f.fields).not.toContain("AZAD_CLI_GCP_REGION")
  expect(f.config.read().GITHUB_APP_PRIVATE_KEY).toBe(
    "-----BEGIN PRIVATE KEY-----\nfixture-only\n-----END PRIVATE KEY-----\n"
  )
  expect(f.notes.join("\n")).not.toContain("fixture-pass")
})

test("Cloud SQL collects an explicit project, region and migration runner network", async () => {
  const f = fixture("cloudsql")
  f.config.save({ DATABASE_URL: "stale" })
  const values = await configure(f.config, f.questions)
  expect(values.AZAD_CLI_GCP_REGION).toBe("europe-west1")
  expect(values.AZAD_CLI_GCP_PROJECT).toBe("customer-project")
  expect(values.AZAD_CLI_RUNNER_CIDR).toBe("203.0.113.1/32")
  expect(values.DATABASE_URL).toBeUndefined()

  // A terminal picks the project from gcloud, as on the Google Cloud target.
  f.fields.length = 0
  f.questions.provision = async (step) =>
    step === "gcpProject"
      ? { AZAD_CLI_GCP_PROJECT: "picked-project" }
      : undefined
  const picked = await configure(f.config, f.questions)
  expect(picked.AZAD_CLI_GCP_PROJECT).toBe("picked-project")
  expect(f.fields).not.toContain("AZAD_CLI_GCP_PROJECT")
})

test("cancelling a later question retains completed secret answers for resume", async () => {
  const f = fixture("postgres")
  const original = f.questions.field
  f.questions.field = (field, previous) => {
    if (field.key === "CLERK_PUBLISHABLE_KEY") throw new CancelledError()
    return original(field, previous)
  }
  await expect(configure(f.config, f.questions)).rejects.toBeInstanceOf(
    CancelledError
  )
  expect(f.config.read().CLOUDFLARE_API_TOKEN).toBe(
    "fixture-CLOUDFLARE_API_TOKEN"
  )
  f.questions.field = original
  await configure(f.config, f.questions)
  expect(f.config.read().CLOUDFLARE_API_TOKEN).toBe(
    "fixture-CLOUDFLARE_API_TOKEN"
  )
})

test("Neon guides a direct existing connection through the PostgreSQL backend", async () => {
  const f = fixture("neon")
  const original = f.questions.field
  f.questions.field = (field, previous) => {
    if (field.key === "DATABASE_URL") {
      expect(field.label).toBe("Neon connection string")
      expect(field.secret).toBe(true)
      expect(field.open).toBe("https://console.neon.tech")
      expect(field.visibleSecret).toBe(true)
      expect(
        validateField(
          field,
          "",
          "postgresql://u:p@ep-test.aws.neon.tech/db?sslmode=require&channel_binding=require"
        )
      ).toBeUndefined()
      expect(
        validateField(
          field,
          "",
          "postgresql://u:p@ep-test.aws.neon.tech/db?sslmode=require"
        )
      ).toBeUndefined()
      // Neon's pooled URL is accepted: setup switches it to the direct host.
      expect(
        field.validate?.(
          "postgresql://u:p@ep-test-pooler.aws.neon.tech/db?sslmode=require&channel_binding=require"
        )
      ).toBeUndefined()
      expect(
        field.validate?.(
          "postgresql://u:p@ep-test.aws.neon.tech/db?sslmode=require&application_name=x"
        )
      ).toContain("only one sslmode")
      expect(
        field.validate?.("postgresql://u:p@ep-test.aws.neon.tech/db")
      ).toBeDefined()
    }
    return original(field, previous)
  }
  const values = await configure(f.config, f.questions)
  expect(values.DATABASE_URL).toBe(
    "postgresql://user:fixture-pass@ep-test.aws.neon.tech/azad?sslmode=verify-full"
  )
  expect(values.AZAD_SELF_HOST_DATABASE_CA).toBe("neon-isrg-root-x1")
  expect(values.AZAD_CLI_DATABASE_SERVICE).toBe("neon")
  expect(values.AZAD_CLI_DATABASE_PROVIDER).toBe("postgres")
  expect(f.fields[0]).toBe("DATABASE_URL")
  expect(f.fields).not.toContain("AZAD_CLI_GCP_PROJECT")
  expect(f.help.join("\n")).toContain("Connect panel")
  expect(f.notes.join("\n")).not.toContain("fixture-pass")
})

test("older PostgreSQL checkpoints keep their saved provider and secret", async () => {
  const f = fixture("postgres")
  const url =
    "postgresql://user:fixture-pass@db.example.com/azad?sslmode=require"
  f.config.save({
    AZAD_CLI_DATABASE_PROVIDER: "postgres",
    DATABASE_URL: url,
    AZAD_INSTANCE_NAME: "Existing team",
  })
  f.questions.choose = async (_message, choices, initial, key) => {
    if (key === "cloudflareAuth") return "manual"
    if (key === "target") return "cloudflare"
    if (key === "storage") return "default"
    expect(choices.map((choice) => choice.label)).toEqual([
      "Neon",
      "Google Cloud SQL",
      "Other PostgreSQL",
    ])
    expect(initial).toBe("postgres")
    return initial ?? ""
  }
  const values = await configure(f.config, f.questions)
  expect(values.DATABASE_URL).toBe(url)
  expect(values.AZAD_CLI_DATABASE_PROVIDER).toBe("postgres")
  expect(values.AZAD_CLI_DATABASE_SERVICE).toBe("postgres")
  expect(values.AZAD_INSTANCE_NAME).toBe("Existing team")
})

test("Neon defaults to certificate and hostname verification without another choice", async () => {
  const f = fixture("neon")
  f.config.save({
    DATABASE_URL:
      "postgresql://u:p@ep-test.neon.tech/db?sslmode=require&channel_binding=require",
  })
  f.questions.confirm = async (_message, _initial, key) => {
    expect(key).not.toBe("neonVerifiedTls")
    return false
  }
  const values = await configure(f.config, f.questions)
  expect(values.DATABASE_URL).toBe(
    "postgresql://u:p@ep-test.neon.tech/db?sslmode=verify-full"
  )
  expect(values.AZAD_SELF_HOST_DATABASE_CA).toBe("neon-isrg-root-x1")
  expect(f.config.read().DATABASE_URL).toBe(values.DATABASE_URL)
})

test("automatic provider steps replace their manual fields, including the Clerk webhook", async () => {
  const f = fixture("postgres")
  f.questions.choose = async (_message, _choices, _initial, key) =>
    (
      {
        cloudflareAuth: "bootstrap",
        target: "cloudflare",
        storage: "default",
      } as Record<string, string>
    )[key ?? ""] ?? "postgres"
  const steps: string[] = []
  f.questions.provision = async (
    step,
    values
  ): Promise<Record<string, string> | undefined> => {
    steps.push(step)
    if (step === "cloudflareAccount") {
      expect(values.AZAD_CLI_WEB_HOST).toBe("board.example.com")
      return { CLOUDFLARE_ACCOUNT_ID: "c".repeat(32) }
    }
    if (step === "clerk")
      return {
        CLERK_PUBLISHABLE_KEY: "pk_live_auto",
        CLERK_SECRET_KEY: "sk_live_auto",
        AZAD_CLI_CLERK_APP_ID: "app_1",
        AZAD_CLI_CLERK_INSTANCE_ID: "ins_1",
      }
    if (step === "clerkWebhook") {
      // The webhook is created with the instance key the Clerk step produced.
      expect(values.CLERK_SECRET_KEY).toBe("sk_live_auto")
      return { CLERK_WEBHOOK_SECRET: "whsec_auto" }
    }
    return {
      GITHUB_APP_ID: "77",
      GITHUB_APP_CLIENT_SECRET: "auto-client",
      GITHUB_APP_PRIVATE_KEY:
        "-----BEGIN RSA PRIVATE KEY-----\nauto\n-----END RSA PRIVATE KEY-----\n",
      GITHUB_WEBHOOK_SECRET: "auto-webhook",
    }
  }
  const values = await configure(f.config, f.questions)
  expect(steps).toEqual([
    "cloudflareAccount",
    "clerk",
    "clerkWebhook",
    "github",
  ])
  for (const key of [
    "CLOUDFLARE_ACCOUNT_ID",
    "CLERK_PUBLISHABLE_KEY",
    "CLERK_SECRET_KEY",
    "CLERK_WEBHOOK_SECRET",
    "GITHUB_APP_ID",
    "GITHUB_APP_CLIENT_SECRET",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_WEBHOOK_SECRET",
  ])
    expect(f.fields).not.toContain(key)
  expect(f.config.read().CLERK_WEBHOOK_SECRET).toBe("whsec_auto")
  expect(values.CLOUDFLARE_ACCOUNT_ID).toBe("c".repeat(32))
  expect(f.config.read().GITHUB_APP_ID).toBe("77")
  expect(f.config.read().CLERK_SECRET_KEY).toBe("sk_live_auto")
})

test("a declined automatic step falls back to the step's fields", async () => {
  const f = fixture("postgres")
  f.questions.provision = async () => undefined
  await configure(f.config, f.questions)
  for (const key of [
    "CLOUDFLARE_ACCOUNT_ID",
    "CLERK_PUBLISHABLE_KEY",
    "CLERK_SECRET_KEY",
    "CLERK_WEBHOOK_SECRET",
    "GITHUB_APP_ID",
  ])
    expect(f.fields).toContain(key)
})

test("Your Google Cloud creates its own database, asks for a project, sizing and agent machine, and runs Mini Apps on the loader provider", async () => {
  const f = fixture("postgres")
  const asked: string[] = []
  f.questions.choose = async (_message, _choices, _initial, key) => {
    asked.push(key ?? "")
    return (
      (
        {
          cloudflareAuth: "manual",
          target: "gcp",
          storage: "gcs",
          sizing: "evaluation",
          diskBackups: "hourly",
          agentMachine: "n2-standard-16",
        } as Record<string, string>
      )[key ?? ""] ?? "postgres"
    )
  }
  f.questions.confirm = async (_message, _initial, key) =>
    key === "miniapps" || key === "optionalSettings"
  const values = await configure(f.config, f.questions)
  expect(asked).not.toContain("database")
  expect(f.fields).not.toContain("DATABASE_URL")
  expect(values.AZAD_CLI_DATABASE_PROVIDER).toBeUndefined()
  expect(f.fields).toEqual(
    expect.arrayContaining([
      "AZAD_CLI_GCP_PROJECT",
      "AZAD_CLI_GCP_REGION",
      // celld takes the App's slug and client ID as given.
      "GITHUB_APP_SLUG",
      "GITHUB_APP_CLIENT_ID",
    ])
  )
  expect(values.AZAD_CLI_GCP_SIZING).toBe("evaluation")
  expect(values.AZAD_CLI_GCP_DISK_BACKUPS).toBe("hourly")
  expect(values.AZAD_CLI_GCP_AGENT_MACHINE).toBe("n2-standard-16")
  expect(values.AZAD_CLI_TARGET).toBe("gcp")
  expect(values.MINIAPP_PROVIDER).toBe("loader")
  expect(values.V3_CF_API_TOKEN).toBeUndefined()
  expect(f.fields).not.toContain("CLOUDFLARE_ARTIFACTS_API_TOKEN")
  expect(values.STORAGE_ADAPTER).toBe("gcs")
  expect(f.fields).toEqual(
    expect.arrayContaining([
      "STORAGE_BUCKET",
      "STORAGE_ACCESS_KEY_ID",
      "STORAGE_SECRET_ACCESS_KEY",
    ])
  )
})

test("Google Cloud asks only the essentials; disk backups and storage keep their defaults", async () => {
  const f = fixture("postgres")
  const asked: string[] = []
  f.questions.choose = async (_message, _choices, initial, key) => {
    asked.push(key ?? "")
    return key === "target" ? "gcp" : (initial ?? "")
  }
  f.questions.confirm = async (_message, _initial, key) => {
    asked.push(key ?? "")
    return false
  }
  const values = await configure(f.config, f.questions)
  expect(asked.filter((key) => key !== "replacePrivateKey")).toEqual([
    "target",
    "sizing",
    "agentMachine",
    "cloudflareAuth",
    "optionalSettings",
  ])
  expect(values.AZAD_CLI_GCP_SIZING).toBe("production")
  expect(values.AZAD_CLI_GCP_AGENT_MACHINE).toBe("n2-custom-8-16384")
  expect(values.AZAD_CLI_GCP_DISK_BACKUPS).toBe("daily")
  expect(values.AZAD_CLI_STORAGE).toBe("default")
  expect(values.AZAD_SELF_HOST_MINIAPPS).toBe("enabled")
  expect(f.notes.join("\n")).toContain(
    "your Google Cloud project, region, sizing and agent machine"
  )
  expect(f.notes.join("\n")).toContain("daily disk backups")
})

test("automatic Mini Apps need no question; one switch guards every optional setting", async () => {
  const f = fixture("postgres")
  f.questions.choose = async (_message, _choices, _initial, key) =>
    (
      {
        cloudflareAuth: "bootstrap",
        target: "cloudflare",
        storage: "default",
      } as Record<string, string>
    )[key ?? ""] ?? "postgres"
  const asked: string[] = []
  f.questions.confirm = async (_message, _initial, key) => {
    asked.push(key ?? "")
    return false
  }
  const values = await configure(f.config, f.questions)
  expect(asked).toEqual(["optionalSettings"])
  // Without the switch, every optional feature keeps its default.
  expect(values.AZAD_CLI_MANAGED_SOURCE).toBe("enabled")
  expect(values.AZAD_CLI_MEETINGS).toBe("enabled")
  expect(values.AZAD_CLI_STORAGE).toBe("default")
  expect(values.AZAD_SELF_HOST_MINIAPPS).toBe("enabled")
  expect(values.V3_CF_ACCOUNT_ID).toBe(values.CLOUDFLARE_ACCOUNT_ID)
  expect(f.fields).not.toContain("V3_CF_API_TOKEN")
  expect(f.fields).not.toContain("SENTRY_DSN")

  // Optional settings can still turn automatic Mini Apps off.
  asked.length = 0
  const answers: Record<string, boolean> = {
    optionalSettings: true,
    miniapps: false,
  }
  f.questions.confirm = async (_message, _initial, key) => {
    asked.push(key ?? "")
    return answers[key ?? ""] ?? false
  }
  const disabled = await configure(f.config, f.questions)
  expect(asked.filter((key) => key !== "replacePrivateKey")).toEqual([
    "optionalSettings",
    "miniapps",
    "managedSource",
    "enableMeetings",
    "optionalServices",
    "advanced",
  ])
  expect(disabled.AZAD_SELF_HOST_MINIAPPS).toBe("disabled")
  expect(disabled.V3_CF_ACCOUNT_ID).toBeUndefined()
})

test("a manual Cloudflare token still asks for Mini Apps and their runtime token", async () => {
  const f = fixture("postgres")
  const asked: string[] = []
  f.questions.confirm = async (_message, _initial, key) => {
    asked.push(key ?? "")
    return key === "miniapps"
  }
  const values = await configure(f.config, f.questions)
  expect(asked).toEqual(["miniapps", "optionalSettings"])
  expect(f.fields).toContain("V3_CF_API_TOKEN")
  expect(values.AZAD_SELF_HOST_MINIAPPS).toBe("enabled")
})

test("a pasted pooled Neon URL names the direct host it switched to, never the password", async () => {
  const f = fixture("neon")
  f.config.save({
    DATABASE_URL:
      "postgresql://user:fixture-pass@ep-test-pooler.aws.neon.tech/azad?sslmode=require&channel_binding=require",
  })
  const values = await configure(f.config, f.questions)
  expect(values.DATABASE_URL).toBe(
    "postgresql://user:fixture-pass@ep-test.aws.neon.tech/azad?sslmode=verify-full"
  )
  expect(f.notes).toContain(
    "Using Neon's direct endpoint ep-test.aws.neon.tech"
  )
  expect(f.notes.join("\n")).not.toContain("fixture-pass")

  // A direct URL needs no such line.
  f.notes.length = 0
  await configure(f.config, f.questions)
  expect(f.notes.join("\n")).not.toContain("direct endpoint")
})

test("with token bootstrap, managed project source asks nothing more", async () => {
  const f = fixture("postgres")
  f.questions.choose = async (_message, _choices, _initial, key) =>
    (
      {
        cloudflareAuth: "bootstrap",
        target: "cloudflare",
        storage: "default",
      } as Record<string, string>
    )[key ?? ""] ?? "postgres"
  f.questions.confirm = async (_message, _initial, key) =>
    key === "managedSource"
  const values = await configure(f.config, f.questions)
  expect(values.AZAD_CLI_MANAGED_SOURCE).toBe("enabled")
  // Tokens come from the bootstrap; backups go to this installation's storage.
  expect(f.fields).not.toContain("V3_CONTROL_BACKUP_GITHUB_REPO")
  expect(f.fields).not.toContain("CLOUDFLARE_ARTIFACTS_API_TOKEN")
  expect(f.fields).not.toContain("V3_CF_ARTIFACTS_NAMESPACE")
})

function bootstrapAnswers(f: ReturnType<typeof fixture>) {
  f.questions.choose = async (_message, _choices, _initial, key) =>
    (
      {
        cloudflareAuth: "bootstrap",
        target: "cloudflare",
        storage: "default",
      } as Record<string, string>
    )[key ?? ""] ?? "postgres"
}

test("with token bootstrap, meetings are on without a question and deployment creates their app", async () => {
  const f = fixture("postgres")
  bootstrapAnswers(f)
  const asked: string[] = []
  f.questions.confirm = async (_message, _initial, key) => {
    asked.push(key ?? "")
    return false
  }
  const values = await configure(f.config, f.questions)
  expect(asked).not.toContain("enableMeetings")
  expect(values.AZAD_CLI_MEETINGS).toBe("enabled")
  expect(f.fields.filter((key) => key.includes("REALTIMEKIT"))).toEqual([])
  expect(f.notes.join("\n")).toContain("meetings on (Cloudflare RealtimeKit)")

  // Turning meetings off clears the settings deployment created.
  f.config.save({
    ...f.config.read(),
    CLOUDFLARE_REALTIMEKIT_ACCOUNT_ID: "a".repeat(32),
    CLOUDFLARE_REALTIMEKIT_APP_ID: "created-app",
    CLOUDFLARE_REALTIMEKIT_API_TOKEN: "fixture-created-token",
  })
  // Optional settings turn them off.
  const defaults: Record<string, boolean | undefined> = {}
  f.questions.confirm = async (_message, initial, key) => {
    defaults[key ?? ""] = initial
    return key === "optionalSettings"
  }
  const off = await configure(f.config, f.questions)
  expect(defaults.enableMeetings).toBe(true)
  expect(off.AZAD_CLI_MEETINGS).toBe("disabled")
  expect(off.CLOUDFLARE_REALTIMEKIT_API_TOKEN).toBe("")
  expect(off.CLOUDFLARE_REALTIMEKIT_APP_ID).toBe("")
})

test("an existing RealtimeKit app under optional settings replaces the created one, and can be given back", async () => {
  const f = fixture("postgres")
  bootstrapAnswers(f)
  const answers: Record<string, boolean> = {
    enableMeetings: true,
    optionalSettings: true,
    optionalServices: true,
    meetings: true,
  }
  const labels: Record<string, string> = {}
  f.questions.confirm = async (message, _initial, key) => {
    labels[key ?? ""] = message
    return answers[key ?? ""] ?? false
  }
  const manual = await configure(f.config, f.questions)
  expect(labels.meetings).toBe(
    "Use an existing Cloudflare RealtimeKit app for meetings?"
  )
  expect(manual.AZAD_CLI_MEETINGS).toBe("existing")
  expect(manual.CLOUDFLARE_REALTIMEKIT_API_TOKEN).toBe(
    "fixture-CLOUDFLARE_REALTIMEKIT_API_TOKEN"
  )

  answers.meetings = false
  const automatic = await configure(f.config, f.questions)
  expect(automatic.AZAD_CLI_MEETINGS).toBe("enabled")
  expect(automatic.CLOUDFLARE_REALTIMEKIT_API_TOKEN).toBe("")
})

test("settings entered before the meetings choice existed stay an existing app", async () => {
  const f = fixture("postgres")
  bootstrapAnswers(f)
  f.config.save({
    CLOUDFLARE_REALTIMEKIT_ACCOUNT_ID: "a".repeat(32),
    CLOUDFLARE_REALTIMEKIT_APP_ID: "manual-app",
    CLOUDFLARE_REALTIMEKIT_API_TOKEN: "fixture-manual-token",
  })
  f.questions.confirm = async (_message, initial, key) =>
    key === "enableMeetings" ? (initial ?? false) : false
  const values = await configure(f.config, f.questions)
  expect(values.AZAD_CLI_MEETINGS).toBe("existing")
  expect(values.CLOUDFLARE_REALTIMEKIT_API_TOKEN).toBe("fixture-manual-token")
})

test("a pasted Cloudflare token keeps meetings as the optional settings it always was", async () => {
  const f = fixture("postgres")
  const asked: string[] = []
  f.questions.confirm = async (_message, _initial, key) => {
    asked.push(key ?? "")
    return ["optionalSettings", "optionalServices", "meetings"].includes(
      key ?? ""
    )
  }
  const values = await configure(f.config, f.questions)
  expect(asked).not.toContain("enableMeetings")
  expect(values.AZAD_CLI_MEETINGS).toBeUndefined()
  expect(f.fields).toContain("CLOUDFLARE_REALTIMEKIT_API_TOKEN")
})

test("the tools are checked right after the target question, before any other; Cloud SQL adds gcloud", async () => {
  const f = fixture("cloudsql")
  const events: string[] = []
  const choose = f.questions.choose
  f.questions.choose = async (message, choices, initial, key) => {
    events.push(`asked ${key}`)
    return await choose(message, choices, initial, key)
  }
  f.questions.requireTools = (needs) => {
    events.push(`tools gcloud=${needs.googleCloud} clerk=${needs.clerkCli}`)
  }
  await configure(f.config, f.questions)
  expect(events.slice(0, 4)).toEqual([
    "asked target",
    "tools gcloud=false clerk=true",
    "asked database",
    "tools gcloud=true clerk=true",
  ])
})

test("missing tools stop the wizard before its second question, with the target saved", async () => {
  const f = fixture("neon")
  const asked: (string | undefined)[] = []
  f.questions.choose = async (_message, _choices, _initial, key) => {
    asked.push(key)
    return key === "target" ? "gcp" : "neon"
  }
  f.questions.requireTools = (needs) => {
    if (needs.googleCloud)
      throw new CliError("These tools are missing or too old.")
  }
  await expect(configure(f.config, f.questions)).rejects.toThrow(
    "These tools are missing or too old."
  )
  expect(asked).toEqual(["target"])
  expect(f.fields).toEqual([])
  expect(f.config.read().AZAD_CLI_TARGET).toBe("gcp")
})

test("Sign in with Google is an opt-in that defaults to No unless it was turned on before", async () => {
  const offered: (boolean | undefined)[] = []
  const steps: string[] = []
  const saves: Record<string, string>[] = [
    {},
    { AZAD_CLI_GOOGLE_SIGN_IN: "enabled" },
    { AZAD_CLI_GOOGLE_CLIENT_ID: "1-a.apps.googleusercontent.com" },
    { AZAD_CLI_GOOGLE_SIGN_IN: "disabled" },
  ]
  for (const saved of saves) {
    const f = fixture("postgres")
    f.config.save(saved)
    f.questions.provision = async (step) => {
      steps.push(step)
      return step === "clerk"
        ? {
            CLERK_PUBLISHABLE_KEY: `pk_live_${btoa("clerk.board.example.com$")}`,
            CLERK_SECRET_KEY: "sk_live_auto",
            AZAD_CLI_CLERK_APP_ID: "app_1",
            AZAD_CLI_CLERK_INSTANCE_ID: "ins_1",
          }
        : undefined
    }
    f.questions.confirm = async (message, initial, key) => {
      if (key === "googleSignIn") {
        expect(message).toBe("Would you like to enable Sign in with Google?")
        offered.push(initial)
      }
      return key === "googleSignIn" ? (initial ?? false) : false
    }
    const values = await configure(f.config, f.questions)
    expect(values.AZAD_CLI_GOOGLE_SIGN_IN).toBe(
      offered.at(-1) ? "enabled" : "disabled"
    )
  }
  expect(offered).toEqual([false, true, true, false])
  // Only the answers that kept it on created a Google client.
  expect(steps.filter((step) => step === "googleClient")).toHaveLength(2)
})

test("Sign in with Google is not asked for Clerk keys entered by hand: nothing could apply the client to Clerk", async () => {
  const f = fixture("postgres")
  const keys: (string | undefined)[] = []
  f.questions.confirm = async (_message, _initial, key) => {
    keys.push(key)
    return false
  }
  await configure(f.config, f.questions)
  expect(keys).not.toContain("googleSignIn")
})
