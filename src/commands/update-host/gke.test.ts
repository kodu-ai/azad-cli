import { expect, test } from "bun:test"
import { CliError } from "../../error"
import type { KubernetesCall, StoreKey, StoredObject } from "./cloud"
import { unwrapEnvelope } from "./cloud"
import { loopbackListen, starterConfig } from "./command"
import { gkeStarter, starterHandler, type StarterConfig } from "./gke"

const config: StarterConfig = {
  namespace: "azad",
  serviceAccount: "azad-updater",
  image: `ghcr.io/kodu-ai/azad-updater@sha256:${"a".repeat(64)}`,
  store: { kind: "gcs", bucket: "azad-1a2b3c4d-install", project_id: "my-project" },
}

type Job = {
  metadata: { name: string; creationTimestamp: string }
  status?: { conditions?: { type: string; status: string; reason?: string; lastTransitionTime?: string }[] }
}

type Pod = { metadata: { deletionTimestamp?: string }; status: { phase: string } }

/** A cluster with the given updater Jobs (and their pods) that records created ones. */
function cluster(
  jobs: Job[],
  create: { status: number } = { status: 201 },
  pods: Record<string, Pod[]> = {}
) {
  const created: unknown[] = []
  const calls: string[] = []
  const kubernetes: KubernetesCall = async (method, path, body) => {
    calls.push(`${method} ${path}`)
    const named = /\/jobs\/([^/?]+)$/u.exec(path)?.[1]
    if (method === "GET" && named) {
      const found = jobs.find((entry) => entry.metadata.name === named)
      return found ? { status: 200, body: found } : { status: 404, body: {} }
    }
    const podsOf = /\/pods\?labelSelector=job-name%3D(.+)$/u.exec(path)?.[1]
    if (method === "GET" && podsOf)
      return { status: 200, body: { items: pods[decodeURIComponent(podsOf)] ?? [] } }
    if (method === "GET") return { status: 200, body: { items: jobs } }
    created.push(body)
    return { status: create.status, body: {} }
  }
  return { kubernetes, created, calls }
}

const storeOf =
  (objects: Partial<Record<StoreKey, StoredObject>>) =>
  async (key: StoreKey) =>
    objects[key] ?? null

const record = (fields: Record<string, unknown>) => ({
  value: {
    format: 1,
    id: "op1",
    kind: "release-update",
    status: "stopped",
    outcome: null,
    target: { version: "4.30.0", manifestSha256: "b".repeat(64) },
    holder: null,
    journal: [],
    error: null,
    createdAt: "2026-11-05T01:00:00.000Z",
    updatedAt: "2026-11-05T01:00:00.000Z",
    ...fields,
  },
  version: "17",
})

const job = (name: string, at: string, done?: "Complete" | "Failed"): Job => ({
  metadata: { name, creationTimestamp: at },
  status: done
    ? { conditions: [{ type: done, status: "True", reason: done === "Failed" ? "DeadlineExceeded" : undefined, lastTransitionTime: at }] }
    : {},
})

test("status names the Job that holds the operation as running, and reports the store's records as stored", async () => {
  const running = record({
    status: "running",
    holder: { executor: "azad-update-1", host: "gke-job", acquiredAt: "x", heartbeatAt: "y" },
  })
  const { kubernetes, calls } = cluster([
    job("azad-update-0", "2026-11-04T01:00:00Z", "Failed"),
    job("azad-update-1", "2026-11-05T01:00:00Z"),
  ])
  const receipt = { value: { format: 1, release: { version: "4.29.0" } }, version: "3" }
  const starter = gkeStarter(config, kubernetes, storeOf({ operation: running, receipt }))
  expect(await starter.status()).toEqual({
    host: {
      kind: "gke-job",
      state: "running",
      executor: "azad-update-1",
      startedAt: "2026-11-05T01:00:00Z",
      exited: { at: "2026-11-04T01:00:00Z", detail: "failed: DeadlineExceeded" },
    },
    operation: running.value,
    receipt: receipt.value,
    deployment: null,
  })
  expect(calls).toEqual([
    "GET /apis/batch/v1/namespaces/azad/jobs?labelSelector=app.kubernetes.io%2Fname%3Dazad-updater",
  ])
  // A Job that does not hold the operation yet is starting.
  const pending = gkeStarter(config, cluster([job("azad-update-2", "2026-11-05T02:00:00Z")]).kubernetes, storeOf({}))
  expect((await pending.status()).host).toMatchObject({ state: "starting", executor: "azad-update-2" })
})

test("start creates one never-retried Job of the updater image, as the updater service account, with no Kubernetes token", async () => {
  const { kubernetes, created } = cluster([])
  const starter = gkeStarter(config, kubernetes, storeOf({}), () => new Date("2026-11-05T03:00:00Z"))
  const started = await starter.start({ version: "4.30.0", acceptMaintenance: true })
  expect(started.host).toMatchObject({ kind: "gke-job", state: "starting", startedAt: "2026-11-05T03:00:00.000Z" })
  expect(created).toHaveLength(1)
  const manifest = created[0] as ReturnType<typeof import("./gke").updaterJob>
  const name = manifest.metadata.name
  expect(name).toMatch(/^azad-update-[a-f0-9]{12}$/u)
  expect(started.host.executor).toBe(name)
  const pod = manifest.spec.template.spec
  expect(manifest.spec.backoffLimit).toBe(0)
  expect(pod.serviceAccountName).toBe("azad-updater")
  expect(pod.automountServiceAccountToken).toBe(false)
  expect(pod.restartPolicy).toBe("Never")
  expect(pod.containers[0].image).toBe(config.image)
  expect(pod.containers[0].args).toEqual([
    "update",
    "--host",
    "gke-job",
    "--store",
    JSON.stringify(config.store),
    "--version",
    "4.30.0",
    "--executor",
    name,
    "--work",
    "/work",
    "--accept-maintenance",
  ])
})

test("two starters that see the same state choose the same Job name, so only one Job runs", async () => {
  const first = cluster([job("azad-update-old", "2026-11-04T01:00:00Z", "Complete")])
  const second = cluster([job("azad-update-old", "2026-11-04T01:00:00Z", "Complete")], { status: 409 })
  const input = { version: "4.30.0", acceptMaintenance: false }
  const name = (await gkeStarter(config, first.kubernetes, storeOf({})).start(input)).host.executor ?? ""
  await expect(gkeStarter(config, second.kubernetes, storeOf({})).start(input)).rejects.toMatchObject({
    status: 409,
    code: "busy",
  })
  expect((second.created[0] as { metadata: { name: string } }).metadata.name).toBe(name)
  // After that Job finishes, a new start gets a new name.
  const later = cluster([
    job(name, "2026-11-05T01:00:00Z", "Failed"),
    job("azad-update-old", "2026-11-04T01:00:00Z", "Complete"),
  ])
  expect((await gkeStarter(config, later.kubernetes, storeOf({})).start(input)).host.executor).not.toBe(name)
})

test("start refuses while a Job runs, for an unfinished update to a newer release or a CLI run, and for an update running elsewhere", async () => {
  const input = { version: "4.30.0", acceptMaintenance: false }
  const refusal = async (jobs: Job[], operation: StoredObject | undefined, body: unknown = input) => {
    try {
      await gkeStarter(config, cluster(jobs).kubernetes, storeOf({ operation })).start(body)
    } catch (error) {
      return error
    }
    return undefined
  }
  expect(await refusal([job("azad-update-1", "2026-11-05T01:00:00Z")], undefined)).toMatchObject({ status: 409, code: "busy" })
  expect(await refusal([], record({ target: { version: "4.31.0", manifestSha256: "b".repeat(64) } }))).toMatchObject({
    status: 409,
    code: "pending",
  })
  expect(await refusal([], record({ kind: "terraform", target: null }))).toMatchObject({ status: 409, code: "pending" })
  expect(
    await refusal([], record({ status: "running", holder: { executor: "cli:laptop:1", host: "cli", acquiredAt: "x", heartbeatAt: "y" } }))
  ).toMatchObject({ status: 409, code: "busy" })
  expect(await refusal([], undefined, { version: "latest", acceptMaintenance: false })).toMatchObject({ status: 400 })
})

test("a stopped operation resumes, and one this host's vanished Job still holds is confirmed stopped by the starter", async () => {
  const stopped = cluster([])
  await gkeStarter(config, stopped.kubernetes, storeOf({ operation: record({}) })).start({ version: "4.30.0", acceptMaintenance: false })
  const stoppedArgs = (stopped.created[0] as ReturnType<typeof import("./gke").updaterJob>).spec.template.spec.containers[0].args
  expect(stoppedArgs).not.toContain("--confirm-stopped")
  const crashed = cluster([job("azad-update-1", "2026-11-05T01:00:00Z", "Failed")])
  const held = record({
    status: "running",
    holder: { executor: "azad-update-1", host: "gke-job", acquiredAt: "x", heartbeatAt: "y" },
  })
  await gkeStarter(config, crashed.kubernetes, storeOf({ operation: held })).start({ version: "4.30.0", acceptMaintenance: false })
  const args = (crashed.created[0] as ReturnType<typeof import("./gke").updaterJob>).spec.template.spec.containers[0].args
  expect(args.slice(-2)).toEqual(["--confirm-stopped", "azad-update-1"])
})

test("a newer release replaces a stopped update, and one this host's vanished Job still holds after confirming it stopped", async () => {
  const older = { version: "4.29.0", manifestSha256: "b".repeat(64) }
  const stopped = cluster([])
  await gkeStarter(config, stopped.kubernetes, storeOf({ operation: record({ target: older }) })).start({
    version: "4.30.0",
    acceptMaintenance: false,
  })
  expect(stopped.created).toHaveLength(1)
  const crashed = cluster([job("azad-update-1", "2026-11-05T01:00:00Z", "Failed")])
  const held = record({
    target: older,
    status: "running",
    holder: { executor: "azad-update-1", host: "gke-job", acquiredAt: "x", heartbeatAt: "y" },
  })
  await gkeStarter(config, crashed.kubernetes, storeOf({ operation: held })).start({ version: "4.30.0", acceptMaintenance: false })
  const args = (crashed.created[0] as ReturnType<typeof import("./gke").updaterJob>).spec.template.spec.containers[0].args
  expect(args).toContain("4.30.0")
  expect(args.slice(-2)).toEqual(["--confirm-stopped", "azad-update-1"])
})

test("a holder is confirmed stopped only by Kubernetes reads made after the record, never by an older Job list", async () => {
  const held = record({
    status: "running",
    holder: { executor: "azad-update-a", host: "gke-job", acquiredAt: "x", heartbeatAt: "y" },
  })
  const input = { version: "4.30.0", acceptMaintenance: false }
  const attempt = async (network: ReturnType<typeof cluster>) => {
    const store = async (key: StoreKey) => {
      network.calls.push(`store ${key}`)
      return key === "operation" ? held : null
    }
    try {
      return await gkeStarter(config, network.kubernetes, store).start(input)
    } catch (error) {
      return error
    }
  }
  // The holder's Job still runs: busy, whatever any earlier list showed.
  const live = cluster([job("azad-update-a", "2026-11-05T01:00:00Z")])
  expect(await attempt(live)).toMatchObject({ status: 409, code: "busy" })
  expect(live.created).toEqual([])
  // Its Job failed, but its pod is still terminating.
  const terminating = cluster([job("azad-update-a", "2026-11-05T01:00:00Z", "Failed")], undefined, {
    "azad-update-a": [{ metadata: { deletionTimestamp: "2026-11-05T01:10:00Z" }, status: { phase: "Running" } }],
  })
  expect(await attempt(terminating)).toMatchObject({ status: 409, code: "busy" })
  expect(terminating.created).toEqual([])
  // Its Job is gone and no pod of it is left: confirmed, after reading the record.
  const gone = cluster([])
  const started = await attempt(gone)
  expect(started).toMatchObject({ host: { state: "starting" } })
  const args = (gone.created[0] as ReturnType<typeof import("./gke").updaterJob>).spec.template.spec.containers[0].args
  expect(args.slice(-2)).toEqual(["--confirm-stopped", "azad-update-a"])
  expect(gone.calls.slice(0, 4)).toEqual([
    "store operation",
    "GET /apis/batch/v1/namespaces/azad/jobs?labelSelector=app.kubernetes.io%2Fname%3Dazad-updater",
    "GET /apis/batch/v1/namespaces/azad/jobs/azad-update-a",
    "GET /api/v1/namespaces/azad/pods?labelSelector=job-name%3Dazad-update-a",
  ])
})

test("the HTTP surface answers the host protocol and errors as {error:{code,message}}", async () => {
  const handler = starterHandler(
    gkeStarter(config, cluster([job("azad-update-1", "2026-11-05T01:00:00Z")]).kubernetes, storeOf({})),
    () => {}
  )
  const status = await handler(new Request("http://127.0.0.1:8095/status"))
  expect(status.status).toBe(200)
  expect(await status.json()).toMatchObject({ host: { state: "starting" }, operation: null })
  const busy = await handler(
    new Request("http://127.0.0.1:8095/start", {
      method: "POST",
      body: JSON.stringify({ version: "4.30.0", acceptMaintenance: false }),
    })
  )
  expect(busy.status).toBe(409)
  expect(await busy.json()).toEqual({
    error: { code: "busy", message: "The updater Job azad-update-1 is still running." },
  })
  expect((await handler(new Request("http://127.0.0.1:8095/start"))).status).toBe(405)
  expect((await handler(new Request("http://127.0.0.1:8095/other"))).status).toBe(404)
  const broken = starterHandler(
    gkeStarter(config, cluster([]).kubernetes, async () => {
      throw new Error("GCS refused to read operation (HTTP 403).")
    }),
    () => {}
  )
  const failed = await broken(new Request("http://127.0.0.1:8095/status"))
  expect(failed.status).toBe(503)
  expect(await failed.json()).toEqual({
    error: { code: "unavailable", message: "GCS refused to read operation (HTTP 403)." },
  })
})

test("the starter listens on loopback only and needs a digest-pinned image and a GCS store", () => {
  expect(loopbackListen(undefined)).toEqual({ hostname: "127.0.0.1", port: 8095 })
  expect(loopbackListen("[::1]:9000")).toEqual({ hostname: "::1", port: 9000 })
  expect(() => loopbackListen("0.0.0.0:8095")).toThrow(CliError)
  expect(() => loopbackListen("10.0.0.5:8095")).toThrow(CliError)
  const env = {
    AZAD_UPDATER_IMAGE: config.image,
    AZAD_INSTALL_STORE: JSON.stringify(config.store),
  }
  expect(starterConfig(env, () => "azad\n")).toEqual(config)
  expect(() => starterConfig({ ...env, AZAD_UPDATER_IMAGE: "ghcr.io/kodu-ai/azad-updater:0.2.0" }, () => "azad")).toThrow(
    "by digest"
  )
  expect(() =>
    starterConfig(
      { ...env, AZAD_INSTALL_STORE: JSON.stringify({ kind: "r2", bucket: "azad-x-install", account_id: "f".repeat(32) }) },
      () => "azad"
    )
  ).toThrow("GCS store")
})

test("store objects are read through the install store's envelope", () => {
  const value = new TextEncoder().encode('{"format":1}')
  const header = new TextEncoder().encode(`azad-install-store 1 ${"0".repeat(32)}\n`)
  expect(new TextDecoder().decode(unwrapEnvelope(new Uint8Array([...header, ...value])))).toBe('{"format":1}')
  expect(unwrapEnvelope(value)).toEqual(value)
})
