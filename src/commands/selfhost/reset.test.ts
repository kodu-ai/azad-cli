import { afterEach, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LocalConfig } from "./config"
import { instanceTerraformDirectory, type Run } from "./deploy"
import { resetInstance } from "./reset"
import type { TerraformSelection } from "./terraform"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const revision = "a".repeat(40)
const noTerraform: Run = () => {
  throw new Error("Unexpected Terraform invocation")
}
const refuse = async () => {
  throw new Error("Nothing may be offered for deletion")
}

/** Terraform state JSON with `instances` per managed resource, plus one data source. */
function state(...instances: number[]) {
  return JSON.stringify({
    version: 4,
    resources: [
      ...instances.map((count, index) => ({
        mode: "managed",
        type: "fixture_resource",
        name: `r${index}`,
        instances: Array.from({ length: count }, () => ({ attributes: {} })),
      })),
      {
        mode: "data",
        type: "fixture_zone",
        name: "zone",
        instances: [{ attributes: {} }],
      },
    ],
  })
}

/**
 * An instance directory with saved settings and private files; `deployed`
 * binds it to a checkout and gives it setup's variables in its Terraform
 * directory (Neon on Cloudflare, or Google Cloud).
 */
function instance(
  options: { deployed?: boolean; target?: "cloudflare" | "gcp" } = {}
) {
  const root = mkdtempSync(join(tmpdir(), "azad-cli-reset-"))
  roots.push(root)
  const config = new LocalConfig(join(root, "instance"))
  const source = join(root, "source")
  mkdirSync(source)
  const googleCloud = options.target === "gcp"
  const drivers = join(root, "azad-terraform")
  mkdirSync(join(drivers, "scripts"), { recursive: true })
  for (const driver of ["cloudflare", "gcp", "bootstrap"])
    writeFileSync(join(drivers, "scripts", `${driver}.ts`), "// fixture")
  const terraform: TerraformSelection = { kind: "local", directory: drivers }
  config.save({
    AZAD_CLI_TARGET: googleCloud ? "gcp" : "cloudflare",
    ...(googleCloud ? {} : { AZAD_CLI_DATABASE_PROVIDER: "postgres" }),
    AZAD_CLI_WEB_HOST: "board.example.com",
    CLERK_SECRET_KEY: "fixture-clerk-secret",
    AZAD_CLI_CLERK_APP_ID: "app_fixture",
    ...(options.deployed
      ? { AZAD_CLI_SOURCE_REVISION: revision, AZAD_CLI_SOURCE: source }
      : {}),
  })
  const credential = join(config.directory, ".cloudflare-bootstrap-credential")
  mkdirSync(credential, { mode: 0o700 })
  writeFileSync(
    join(credential, ".env"),
    "CLOUDFLARE_BOOTSTRAP_API_TOKEN=fixture-admin-token\n",
    { mode: 0o600 }
  )
  writeFileSync(join(config.directory, ".realtimekit.json"), "{}")
  const files = instanceTerraformDirectory(config.directory, config.read())
  if (options.deployed) {
    mkdirSync(files, { recursive: true })
    writeFileSync(
      join(files, "terraform.tfvars.json"),
      JSON.stringify(
        googleCloud
          ? { web_host: "board.example.com", deployment: { revision } }
          : {
              cloudflare: { web_origin: "https://board.example.com" },
              deployment: { revision },
            }
      )
    )
  }
  return { root, directory: config.directory, source, terraform, files }
}

test("reset refuses while the installation's Terraform state records resources, and names the target's destroy command", async () => {
  const f = instance({ deployed: true })
  writeFileSync(join(f.files, "terraform.tfstate"), state(2, 1))
  const report = await resetInstance(
    { directory: f.directory, terraform: f.terraform, confirm: refuse },
    noTerraform
  )
  expect(report.status).toBe("live_resources")
  if (report.status !== "live_resources") return
  expect(report.states).toEqual([
    { root: f.files, state: "live", resources: 3 },
  ])
  const helper = `bun --no-env-file ${join(f.terraform.directory, "scripts", "cloudflare.ts")}`
  expect(report.commands).toEqual([
    `${helper} init --root postgres --instance-dir ${f.directory} && ${helper} destroy --root postgres --source ${f.source} --instance-dir ${f.directory}`,
  ])
  expect(report.message).toContain("azad --reset again")
  expect(report.message).not.toContain("fixture-")
  for (const path of [
    join(f.directory, ".env"),
    join(f.directory, ".cloudflare-bootstrap-credential"),
    join(f.files, "terraform.tfvars.json"),
    join(f.files, "terraform.tfstate"),
  ])
    expect(existsSync(path)).toBe(true)
})

test("on Google Cloud the refusal adds the deletion-protection step, unless the install has none", async () => {
  const f = instance({ deployed: true, target: "gcp" })
  writeFileSync(join(f.files, "terraform.tfstate"), state(40))
  const production = await resetInstance(
    { directory: f.directory, terraform: f.terraform, confirm: refuse },
    noTerraform
  )
  expect(production.status).toBe("live_resources")
  if (production.status !== "live_resources") return
  const helper = `bun --no-env-file ${join(f.terraform.directory, "scripts", "gcp.ts")}`
  expect(production.commands).toEqual([
    `${helper} init --instance-dir ${f.directory} && ${helper} destroy --source ${f.source} --instance-dir ${f.directory}`,
  ])
  expect(production.message).toContain(
    `first set "deletion_protection": false in ${join(f.files, "terraform.tfvars.json")} and run ${helper} apply --source ${f.source} --instance-dir ${f.directory}.`
  )
  writeFileSync(
    join(f.files, "terraform.tfvars.json"),
    JSON.stringify({
      web_host: "board.example.com",
      deletion_protection: false,
      deployment: { revision },
    })
  )
  const evaluation = await resetInstance(
    { directory: f.directory, terraform: f.terraform, confirm: refuse },
    noTerraform
  )
  expect(evaluation.message).not.toContain("deletion_protection")
})

test("scoped Cloudflare tokens still in their own state block a reset, even before any deploy", async () => {
  const f = instance()
  const tokenRoot = join(f.directory, "cloudflare-bootstrap", "terraform")
  mkdirSync(tokenRoot, { recursive: true })
  writeFileSync(join(tokenRoot, "terraform.tfstate"), state(2))
  const report = await resetInstance(
    { directory: f.directory, terraform: f.terraform, confirm: refuse },
    noTerraform
  )
  expect(report.status).toBe("live_resources")
  if (report.status !== "live_resources") return
  expect(report.commands).toEqual([
    "read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN",
    `terraform -chdir=${tokenRoot} destroy`,
  ])
  expect(report.message).toContain("scoped Cloudflare tokens")
  expect(existsSync(join(tokenRoot, "terraform.tfstate"))).toBe(true)
  expect(existsSync(join(f.directory, ".env"))).toBe(true)
})

test("reset deletes a never-deployed directory's settings and credentials once confirmed, and keeps everything else", async () => {
  const f = instance()
  const interrupted = join(
    f.directory,
    ".env-0b0e5f4e-8c43-4a1e-9d55-2a1f7d1c2b3a"
  )
  writeFileSync(interrupted, "CLERK_SECRET_KEY=fixture-clerk-secret\n")
  writeFileSync(join(f.directory, "notes.txt"), "the person's own file")
  let summary = ""
  const report = await resetInstance(
    {
      directory: f.directory,
      confirm: async (offered) => {
        summary = offered
        return true
      },
    },
    noTerraform
  )
  expect(report.status).toBe("reset_complete")
  const removed = [
    join(f.directory, ".env"),
    join(f.directory, ".cloudflare-bootstrap-credential"),
    join(f.directory, ".realtimekit.json"),
    interrupted,
  ]
  for (const path of removed) {
    expect(summary).toContain(path)
    expect(existsSync(path)).toBe(false)
  }
  expect(readdirSync(f.directory).toSorted()).toEqual([
    ".gitignore",
    "notes.txt",
  ])
  expect(report.message).toContain("Clerk application")
  expect(
    await resetInstance({ directory: f.directory, terraform: f.terraform }, noTerraform)
  ).toMatchObject({ status: "nothing_to_reset" })
})

test("without a confirmation reset only lists what it would delete; declining keeps it all", async () => {
  const f = instance()
  const unconfirmed = await resetInstance(
    { directory: f.directory, terraform: f.terraform },
    noTerraform
  )
  expect(unconfirmed).toMatchObject({
    status: "needs_confirmation",
    remove: [
      join(f.directory, ".env"),
      join(f.directory, ".cloudflare-bootstrap-credential"),
      join(f.directory, ".realtimekit.json"),
    ],
  })
  expect(unconfirmed.message).toContain("--yes")
  const declined = await resetInstance(
    { directory: f.directory, terraform: f.terraform, confirm: async () => false },
    noTerraform
  )
  expect(declined.status).toBe("cancelled")
  expect(existsSync(join(f.directory, ".env"))).toBe(true)
  expect(existsSync(join(f.directory, ".realtimekit.json"))).toBe(true)
})

test("after a destroy, reset also clears this instance's Terraform variables, plans and deploy state, and keeps its state", async () => {
  const f = instance({ deployed: true })
  writeFileSync(join(f.files, "terraform.tfstate"), state())
  mkdirSync(join(f.files, ".terraform"))
  writeFileSync(join(f.files, "terraform.tfplan"), "fixture-plan")
  mkdirSync(join(f.files, "installer-state"))
  const tokenRoot = join(f.directory, "cloudflare-bootstrap", "terraform")
  mkdirSync(tokenRoot, { recursive: true })
  writeFileSync(join(tokenRoot, "terraform.tfstate"), state(0))
  writeFileSync(join(f.directory, ".cloudflare-bootstrap.json"), "{}")
  const report = await resetInstance(
    { directory: f.directory, terraform: f.terraform, confirm: async () => true },
    noTerraform
  )
  expect(report.status).toBe("reset_complete")
  for (const path of [
    join(f.files, "terraform.tfvars.json"),
    join(f.files, "terraform.tfplan"),
    join(f.files, "installer-state"),
    join(f.directory, "cloudflare-bootstrap"),
    join(f.directory, ".cloudflare-bootstrap.json"),
  ])
    expect(existsSync(path)).toBe(false)
  expect(readdirSync(f.files).toSorted()).toEqual([
    ".terraform",
    "terraform.tfstate",
  ])
})

test("an instance whose Terraform working data records another backend is not verified", async () => {
  const f = instance({ deployed: true })
  mkdirSync(join(f.files, ".terraform"))
  writeFileSync(
    join(f.files, ".terraform", "terraform.tfstate"),
    JSON.stringify({ backend: { type: "s3", config: { bucket: "state" } } })
  )
  const report = await resetInstance(
    { directory: f.directory, terraform: f.terraform, confirm: refuse },
    noTerraform
  )
  expect(report).toMatchObject({
    status: "state_unverified",
    states: [{ root: f.files, state: "unverified" }],
  })
  expect(existsSync(join(f.directory, ".env"))).toBe(true)
})

test("a live installation whose checkout is gone asks for --source, and gets the destroy commands for the checkout it names", async () => {
  const f = instance({ deployed: true })
  writeFileSync(join(f.files, "terraform.tfstate"), state(1))
  rmSync(f.source, { recursive: true })
  const missing = await resetInstance(
    { directory: f.directory, terraform: f.terraform, confirm: refuse },
    noTerraform
  )
  expect(missing.status).toBe("live_resources")
  expect(missing.message).toContain(
    "Rerun with --source pointing to the Azad checkout that deployed this instance."
  )
  const moved = join(f.root, "moved-source")
  mkdirSync(moved)
  const named = await resetInstance(
    { directory: f.directory, terraform: f.terraform, source: moved, confirm: refuse },
    noTerraform
  )
  expect(named).toMatchObject({ status: "live_resources" })
  if (named.status !== "live_resources") return
  expect(named.message).not.toContain("Rerun with --source")
  expect(named.commands[0]).toEndWith(
    `destroy --root postgres --source ${moved} --instance-dir ${f.directory}`
  )
  expect(existsSync(join(f.directory, ".env"))).toBe(true)
})

test("destroy commands name the pinned azad-terraform in the cache, and how to get it when it is not there", async () => {
  const f = instance({ deployed: true })
  writeFileSync(join(f.files, "terraform.tfstate"), state(1))
  const cache = join(f.root, "cache", "azad-terraform", "0.0.1")
  const release: TerraformSelection = {
    kind: "release",
    version: "0.0.1",
    directory: cache,
    url: "https://downloads.example.com/azad-terraform-0.0.1.tar.gz",
  }
  const report = await resetInstance(
    { directory: f.directory, terraform: release, confirm: refuse },
    noTerraform
  )
  expect(report.status).toBe("live_resources")
  if (report.status !== "live_resources") return
  expect(report.commands[0]).toStartWith(
    `bun --no-env-file ${join(cache, "scripts", "cloudflare.ts")} init`
  )
  expect(report.message).toContain(
    `The destroy commands run azad-terraform 0.0.1 from ${cache}, which is not on this machine: clone https://github.com/kodu-ai/azad-terraform at tag v0.0.1`
  )
  expect(existsSync(cache)).toBe(false)
})
