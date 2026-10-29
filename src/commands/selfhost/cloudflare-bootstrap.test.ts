import { afterEach, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LocalConfig, serializeEnv } from "./config"
import { saveBootstrapToken } from "./bootstrap-credentials"
import {
  runCloudflareBootstrap,
  verifyCompletedBootstrap,
} from "./cloudflare-bootstrap"
import type { Run } from "../../process"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})
const revision = "a".repeat(40)
/** The app source and azad-terraform directories under `root`; the fake helper never reads them. */
const sources = (root: string) => ({
  source: join(root, "azad"),
  terraform: join(root, "azad-terraform"),
})
function fixture(miniApps = false, managedSource = false) {
  const root = mkdtempSync(join(tmpdir(), "azad-bootstrap-handoff-"))
  roots.push(root)
  const config = new LocalConfig(join(root, "instance"))
  const bootstrapFile = saveBootstrapToken(
    config.directory,
    "fixture-root-token"
  )
  config.save({
    CLOUDFLARE_ACCOUNT_ID: "b".repeat(32),
    AZAD_CLI_WEB_HOST: "board.example.com",
    AZAD_SELF_HOST_MINIAPPS: miniApps ? "enabled" : "disabled",
    AZAD_CLI_CLOUDFLARE_BOOTSTRAP_FILE: bootstrapFile,
    CLERK_SECRET_KEY: "fixture-clerk-secret",
    DATABASE_URL: "postgresql://u:p@db.example.com/db?sslmode=require",
    ...(managedSource ? { AZAD_CLI_MANAGED_SOURCE: "enabled" } : {}),
  })
  const state = join(config.directory, "cloudflare-bootstrap")
  const marker = join(config.directory, ".cloudflare-bootstrap.json")
  const execute: Run = (_command, args) => {
    expect(args.join(" ")).not.toContain("fixture-root-token")
    const inputPath = args[args.indexOf("--config") + 1]
    const input = JSON.parse(readFileSync(inputPath, "utf8"))
    expect(JSON.stringify(input)).not.toContain("fixture-root-token")
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
    mkdirSync(join(state, "terraform"), { recursive: true, mode: 0o700 })
    const tokens = [
      {
        index_key: "deployment",
        attributes: { id: "c".repeat(32), value: "fixture-derived-deployment" },
      },
      ...(miniApps
        ? [
            {
              index_key: "miniapps",
              attributes: {
                id: "d".repeat(32),
                value: "fixture-derived-runtime",
              },
            },
          ]
        : []),
      ...(managedSource
        ? [
            {
              index_key: "managed-source",
              attributes: { id: "1".repeat(32), value: "fixture-artifacts" },
            },
            {
              index_key: "managed-events",
              attributes: { id: "2".repeat(32), value: "fixture-events" },
            },
          ]
        : []),
    ]
    const credentialsFile = join(state, "credentials.env")
    writeFileSync(
      credentialsFile,
      serializeEnv({
        CLOUDFLARE_API_TOKEN: "fixture-derived-deployment",
        ...(miniApps ? { V3_CF_API_TOKEN: "fixture-derived-runtime" } : {}),
        ...(managedSource
          ? {
              CLOUDFLARE_ARTIFACTS_API_TOKEN: "fixture-artifacts",
              CLOUDFLARE_ARTIFACTS_EVENTS_API_TOKEN: "fixture-events",
            }
          : {}),
      }),
      { mode: 0o600 }
    )
    const result = {
      version: 1,
      accountId: input.accountId,
      sourceRevision: input.revision,
      zoneIds: ["e".repeat(32)],
      tokenIds: {
        deployment: "c".repeat(32),
        ...(miniApps ? { miniapps: "d".repeat(32) } : {}),
        ...(managedSource
          ? {
              "managed-source": "1".repeat(32),
              "managed-events": "2".repeat(32),
            }
          : {}),
      },
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
          { type: "cloudflare_api_token", name: "scoped", instances: tokens },
        ],
      }),
      { mode: 0o600 }
    )
    return { status: 0, stdout: JSON.stringify(result) }
  }
  return { root, config, bootstrapFile, state, marker, execute }
}
const unexpected: Run = () => {
  throw new Error("Unexpected token helper invocation")
}

test("bootstrap permission preview does not create tokens, completion or workload credentials", async () => {
  const f = fixture()
  const before = readFileSync(f.config.envPath, "utf8")
  expect(
    await runCloudflareBootstrap(f.config, sources(f.root), revision, "plan", f.execute)
  ).toBe("bootstrap_planned")
  expect(existsSync(f.marker)).toBe(false)
  expect(existsSync(f.state)).toBe(false)
  expect(readFileSync(f.config.envPath, "utf8")).toBe(before)
})

test("successful bootstrap merges only derived credentials and resumes after root revocation", async () => {
  const f = fixture(true)
  expect(
    await runCloudflareBootstrap(f.config, sources(f.root), revision, "apply", f.execute)
  ).toBe("complete")
  const values = f.config.read()
  expect(values.CLOUDFLARE_API_TOKEN).toBe("fixture-derived-deployment")
  expect(values.V3_CF_API_TOKEN).toBe("fixture-derived-runtime")
  expect(values.CLERK_SECRET_KEY).toBe("fixture-clerk-secret")
  expect(readFileSync(f.config.envPath, "utf8")).not.toContain(
    "fixture-root-token"
  )
  unlinkSync(f.bootstrapFile)
  expect(verifyCompletedBootstrap(f.config.directory, values)).toBe(true)
  expect(
    await runCloudflareBootstrap(
      f.config,
      sources(f.root),
      "f".repeat(40),
      "apply",
      unexpected
    )
  ).toBe("complete")
  expect(JSON.parse(readFileSync(f.marker, "utf8")).config.revision).toBe(
    revision
  )
})

test("a failed invocation cannot use a stale successful handoff or clear pending status", async () => {
  const f = fixture()
  const failing: Run = (command, args, cwd, capture) => {
    f.execute(command, args, cwd, capture)
    return { status: 1, stdout: "fixture-root-token" }
  }
  const before = readFileSync(f.config.envPath, "utf8")
  await expect(
    runCloudflareBootstrap(f.config, sources(f.root), revision, "apply", failing)
  ).rejects.toThrow("no previous result")
  expect(JSON.parse(readFileSync(f.marker, "utf8")).phase).toBe("pending")
  expect(verifyCompletedBootstrap(f.config.directory, f.config.read())).toBe(
    false
  )
  expect(readFileSync(f.config.envPath, "utf8")).toBe(before)
  expect(
    await runCloudflareBootstrap(f.config, sources(f.root), revision, "apply", f.execute)
  ).toBe("complete")
})

test("a helper failure names its own diagnostic in one line, never a credential", async () => {
  const f = fixture()
  const failing: Run = () => ({
    status: 1,
    stdout: "",
    stderr:
      "bun: warning\n\u001b[31mCloudflare token bootstrap lookup failed (HTTP 403) for fixture-root-token.\u001b[0m\n\n",
  })
  const failure = runCloudflareBootstrap(
    f.config,
    sources(f.root),
    revision,
    "plan",
    failing
  )
  await expect(failure).rejects.toThrow(
    "Cloudflare token setup stopped: Cloudflare token bootstrap lookup failed (HTTP 403) for [redacted].\n"
  )
  await expect(failure).rejects.not.toThrow("fixture-root-token")
  await expect(
    runCloudflareBootstrap(f.config, sources(f.root), revision, "plan", () => ({
      status: 1,
      stdout: "",
    }))
  ).rejects.toThrow("Cloudflare token setup stopped.\n")
})

test("lost state prevents automatic credential recreation", async () => {
  const f = fixture()
  await runCloudflareBootstrap(f.config, sources(f.root), revision, "apply", f.execute)
  unlinkSync(join(f.state, "terraform", "terraform.tfstate"))
  await expect(
    runCloudflareBootstrap(f.config, sources(f.root), revision, "apply", unexpected)
  ).rejects.toThrow("Restore its private")
  expect(() =>
    verifyCompletedBootstrap(f.config.directory, f.config.read())
  ).toThrow("Restore its private")
})

test("completion rejects mismatched retained credentials and unexpected administrator keys", async () => {
  const f = fixture()
  await runCloudflareBootstrap(f.config, sources(f.root), revision, "apply", f.execute)
  writeFileSync(
    join(f.state, "credentials.env"),
    serializeEnv({
      CLOUDFLARE_API_TOKEN: "fixture-derived-deployment",
      CLOUDFLARE_BOOTSTRAP_API_TOKEN: "fixture-root-token",
    }),
    { mode: 0o600 }
  )
  await expect(
    runCloudflareBootstrap(f.config, sources(f.root), revision, "apply", unexpected)
  ).rejects.toThrow("Restore its private")
  expect(readFileSync(f.config.envPath, "utf8")).not.toContain(
    "fixture-root-token"
  )
})

test("automatic certificate registration requests its precise permission and preserves the selector", async () => {
  const f = fixture()
  f.config.save({
    ...f.config.read(),
    DATABASE_URL:
      "postgresql://u:p@ep-fixture.neon.tech/db?sslmode=verify-full",
    AZAD_SELF_HOST_DATABASE_CA: "neon-isrg-root-x1",
  })
  const execute: Run = (command, args, cwd, capture) => {
    const input = JSON.parse(
      readFileSync(args[args.indexOf("--config") + 1], "utf8")
    )
    expect(input.verifyDatabaseCertificate).toBe(true)
    expect(input.registerDatabaseCertificate).toBe(true)
    return f.execute(command, args, cwd, capture)
  }
  await runCloudflareBootstrap(f.config, sources(f.root), revision, "apply", execute)
  expect(f.config.read().AZAD_SELF_HOST_DATABASE_CA).toBe("neon-isrg-root-x1")
  expect(f.config.read().AZAD_SELF_HOST_DATABASE_CA_CERT_ID).toBeUndefined()
  expect(verifyCompletedBootstrap(f.config.directory, f.config.read())).toBe(
    true
  )
})

test("managed project source takes its Artifacts and Queues tokens from the same bootstrap", async () => {
  const f = fixture(false, true)
  const inputs: string[] = []
  const execute: Run = (command, args, cwd, capture) => {
    inputs.push(readFileSync(args[args.indexOf("--config") + 1], "utf8"))
    return f.execute(command, args, cwd, capture)
  }
  await runCloudflareBootstrap(f.config, sources("/work"), revision, "apply", execute)
  expect(JSON.parse(inputs[0])).toMatchObject({ managedSource: true })
  const values = f.config.read()
  expect(values.CLOUDFLARE_ARTIFACTS_API_TOKEN).toBe("fixture-artifacts")
  expect(values.CLOUDFLARE_ARTIFACTS_EVENTS_API_TOKEN).toBe("fixture-events")
  expect(verifyCompletedBootstrap(f.config.directory, values)).toBe(true)
})

test("without managed source the helper config omits it, so older helpers accept it", async () => {
  const f = fixture()
  const inputs: string[] = []
  const execute: Run = (command, args, cwd, capture) => {
    inputs.push(readFileSync(args[args.indexOf("--config") + 1], "utf8"))
    return f.execute(command, args, cwd, capture)
  }
  await runCloudflareBootstrap(f.config, sources("/work"), revision, "plan", execute)
  expect(JSON.parse(inputs[0])).not.toHaveProperty("managedSource")
})
