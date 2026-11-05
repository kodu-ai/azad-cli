import { createHash } from "node:crypto"
import { z } from "zod"
import type { StoreSelection } from "../update/installation"
import type { KubernetesCall, StoreReader } from "./cloud"

/** The label every updater Job carries; the starter lists Jobs by it. */
export const UPDATER_LABEL = "app.kubernetes.io/name"
export const UPDATER_LABEL_VALUE = "azad-updater"

/** What one starter launches: where, as whom and with which image. */
export type StarterConfig = {
  namespace: string
  serviceAccount: string
  /** The updater image as a digest reference (`…@sha256:…`). */
  image: string
  /** The installation's store, passed to every Job as `--store`. */
  store: StoreSelection
}

/** The host part of the status the API reads (`GET /status`). */
export type HostView = {
  kind: "gke-job"
  state: "idle" | "starting" | "running"
  executor: string | null
  startedAt: string | null
  exited: { at: string; detail: string | null } | null
}

/** `GET /status`: the host and the store's records as stored. */
export type StatusBody = {
  host: HostView
  operation: unknown
  receipt: unknown
  deployment: unknown
}

/** One updater Job as the starter sees it. */
type JobView = {
  name: string
  createdAt: string
  /** Neither Complete nor Failed yet (pending pods included). */
  active: boolean
  finished: { at: string; detail: string | null } | null
}

const conditionSchema = z.looseObject({
  type: z.string(),
  status: z.string(),
  reason: z.string().optional(),
  message: z.string().optional(),
  lastTransitionTime: z.string().optional(),
})
const jobListSchema = z.looseObject({
  items: z.array(
    z.looseObject({
      metadata: z.looseObject({
        name: z.string(),
        creationTimestamp: z.string(),
      }),
      status: z
        .looseObject({
          completionTime: z.string().optional(),
          conditions: z.array(conditionSchema).optional(),
        })
        .optional(),
    })
  ),
})

/** The record fields a start decision reads; the record itself is returned as stored. */
const operationSchema = z.looseObject({
  id: z.string(),
  kind: z.string(),
  status: z.enum(["running", "stopped", "finished"]),
  target: z.looseObject({ version: z.string() }).nullable(),
  holder: z.looseObject({ executor: z.string(), host: z.string() }).nullable(),
})

function jobView(item: z.infer<typeof jobListSchema>["items"][number]): JobView {
  const done = item.status?.conditions?.find(
    (condition) =>
      (condition.type === "Complete" || condition.type === "Failed") &&
      condition.status === "True"
  )
  return {
    name: item.metadata.name,
    createdAt: item.metadata.creationTimestamp,
    active: !done,
    finished: done
      ? {
          at:
            done.lastTransitionTime ??
            item.status?.completionTime ??
            item.metadata.creationTimestamp,
          detail:
            done.type === "Complete"
              ? "succeeded"
              : `failed${done.reason ? `: ${done.reason}` : ""}${done.message ? `: ${done.message}` : ""}`.slice(
                  0,
                  500
                ),
        }
      : null,
  }
}

/** A refusal of `POST /start`, answered as `{error:{code,message}}`. */
export class StartRefused extends Error {
  constructor(
    readonly status: 400 | 409 | 503,
    readonly code: "invalid" | "busy" | "pending" | "unavailable",
    message: string
  ) {
    super(message)
    this.name = "StartRefused"
  }
}

const startSchema = z.strictObject({
  version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  acceptMaintenance: z.boolean(),
})

/**
 * The Job that runs the updater once: the updater image as the installation's
 * updater service account (Workload Identity gives it the store, its secrets,
 * Cloud SQL and the fleet buckets), no Kubernetes token, never retried (a
 * failed run leaves its operation stopped, and the next start resumes it).
 */
export function updaterJob(
  config: StarterConfig,
  input: {
    name: string
    version: string
    acceptMaintenance: boolean
    confirmStopped?: string
  }
) {
  const labels = {
    [UPDATER_LABEL]: UPDATER_LABEL_VALUE,
    "app.kubernetes.io/component": "release-update",
  }
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: input.name,
      namespace: config.namespace,
      labels,
      annotations: { "azad.pro/target-version": input.version },
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 7 * 24 * 3600,
      activeDeadlineSeconds: 6 * 3600,
      template: {
        metadata: { labels },
        spec: {
          serviceAccountName: config.serviceAccount,
          automountServiceAccountToken: false,
          restartPolicy: "Never",
          // The updater stops its operation cleanly on SIGTERM.
          terminationGracePeriodSeconds: 120,
          // GKE Autopilot schedules amd64 nodes and taints by architecture.
          nodeSelector: { "kubernetes.io/arch": "amd64" },
          tolerations: [
            {
              key: "kubernetes.io/arch",
              operator: "Equal",
              value: "amd64",
              effect: "NoSchedule",
            },
          ],
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 65532,
            runAsGroup: 65532,
            fsGroup: 65532,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "updater",
              image: config.image,
              args: [
                "update",
                "--host",
                "gke-job",
                "--store",
                JSON.stringify(config.store),
                "--version",
                input.version,
                "--executor",
                input.name,
                "--work",
                "/work",
                ...(input.acceptMaintenance ? ["--accept-maintenance"] : []),
                ...(input.confirmStopped
                  ? ["--confirm-stopped", input.confirmStopped]
                  : []),
              ],
              env: [{ name: "HOME", value: "/work" }],
              resources: {
                requests: {
                  cpu: "1",
                  memory: "2Gi",
                  "ephemeral-storage": "10Gi",
                },
                limits: { memory: "2Gi", "ephemeral-storage": "10Gi" },
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
              },
              volumeMounts: [{ name: "work", mountPath: "/work" }],
            },
          ],
          volumes: [{ name: "work", emptyDir: { sizeLimit: "9Gi" } }],
        },
      },
    },
  }
}

/**
 * The Google Cloud updater host: the starter in the API pods. It reads the
 * install store and the updater Jobs, and starts one Job per update. It does
 * not check releases (the API did, and the updater checks again) and never
 * holds deploy credentials: the Job's own service account has them.
 */
export function gkeStarter(
  config: StarterConfig,
  kubernetes: KubernetesCall,
  store: StoreReader,
  now: () => Date = () => new Date()
) {
  const jobsPath = `/apis/batch/v1/namespaces/${encodeURIComponent(config.namespace)}/jobs`
  async function jobs(): Promise<JobView[]> {
    const response = await kubernetes(
      "GET",
      `${jobsPath}?labelSelector=${encodeURIComponent(`${UPDATER_LABEL}=${UPDATER_LABEL_VALUE}`)}`
    )
    if (response.status !== 200)
      throw new StartRefused(
        503,
        "unavailable",
        `Kubernetes refused to list the updater Jobs (HTTP ${response.status}).`
      )
    return jobListSchema
      .parse(response.body)
      .items.map(jobView)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  function hostView(
    list: JobView[],
    holder: string | null
  ): HostView {
    const active = list.filter((job) => job.active)
    const current =
      active.find((job) => job.name === holder) ?? active[0] ?? undefined
    const exited = list
      .flatMap((job) => (job.finished ? [job.finished] : []))
      .sort((a, b) => b.at.localeCompare(a.at))[0]
    return {
      kind: "gke-job",
      state: current
        ? current.name === holder
          ? "running"
          : "starting"
        : "idle",
      executor: current?.name ?? null,
      startedAt: current?.createdAt ?? null,
      exited: exited ?? null,
    }
  }

  const runningHolder = (operation: StoredOperation) =>
    operation?.parsed.status === "running"
      ? (operation.parsed.holder?.executor ?? null)
      : null

  type StoredOperation =
    | { parsed: z.infer<typeof operationSchema>; version: string }
    | undefined
  async function operation(): Promise<{
    stored: Awaited<ReturnType<StoreReader>>
    view: StoredOperation
  }> {
    const stored = await store("operation")
    if (!stored) return { stored, view: undefined }
    const parsed = operationSchema.safeParse(stored.value)
    if (!parsed.success)
      throw new StartRefused(
        503,
        "unavailable",
        "The installation's operation record is not readable."
      )
    return { stored, view: { parsed: parsed.data, version: stored.version } }
  }

  return {
    /** `GET /status`. */
    async status(): Promise<StatusBody> {
      const [list, record, receipt, deployment] = await Promise.all([
        jobs(),
        operation(),
        store("receipt"),
        store("deployment"),
      ])
      return {
        host: hostView(list, runningHolder(record.view)),
        operation: record.stored?.value ?? null,
        receipt: receipt?.value ?? null,
        deployment: deployment?.value ?? null,
      }
    },

    /**
     * `POST /start`: starts the updater Job for `version`, resuming the
     * unfinished operation when it has the same target. A record running on
     * this host whose Job no longer runs is confirmed stopped by the starter
     * itself; one running elsewhere (a laptop) is never taken over from here.
     *
     * @throws {StartRefused} 400 for bad input, 409 when an update runs or a
     *   different operation is unfinished.
     */
    async start(body: unknown): Promise<{ host: HostView }> {
      const input = startSchema.safeParse(body)
      if (!input.success)
        throw new StartRefused(
          400,
          "invalid",
          "Send {version: \"x.y.z\", acceptMaintenance: boolean}."
        )
      const [list, record] = await Promise.all([jobs(), operation()])
      const active = list.find((job) => job.active)
      if (active)
        throw new StartRefused(
          409,
          "busy",
          `The updater Job ${active.name} is still running.`
        )
      let confirmStopped: string | undefined
      const current = record.view?.parsed
      if (current && current.status !== "finished") {
        const what = `${current.kind}${current.target ? ` to ${current.target.version}` : ""}`
        if (
          current.kind !== "release-update" ||
          current.target?.version !== input.data.version
        )
          throw new StartRefused(
            409,
            "pending",
            `The unfinished operation ${current.id} (${what}) must finish first.`
          )
        if (current.status === "running") {
          if (current.holder?.host !== "gke-job")
            throw new StartRefused(
              409,
              "busy",
              `Operation ${current.id} (${what}) is running on ${current.holder?.host} ${current.holder?.executor}.`
            )
          // No updater Job is active, so the one holding it has stopped.
          confirmStopped = current.holder.executor
        }
      }
      // Two starters seeing the same state choose the same name, so only
      // one Job is created; a new attempt follows a finished Job.
      const name = `azad-update-${createHash("sha256")
        .update(
          [
            record.view?.version ?? "none",
            input.data.version,
            String(input.data.acceptMaintenance),
            list[0]?.name ?? "",
          ].join("|")
        )
        .digest("hex")
        .slice(0, 12)}`
      const created = await kubernetes(
        "POST",
        jobsPath,
        updaterJob(config, {
          name,
          version: input.data.version,
          acceptMaintenance: input.data.acceptMaintenance,
          confirmStopped,
        })
      )
      if (created.status === 409)
        throw new StartRefused(
          409,
          "busy",
          `The updater Job ${name} was just started.`
        )
      if (created.status !== 201 && created.status !== 200)
        throw new StartRefused(
          503,
          "unavailable",
          `Kubernetes refused to create the updater Job (HTTP ${created.status}).`
        )
      return {
        host: {
          kind: "gke-job",
          state: "starting",
          executor: name,
          startedAt: now().toISOString(),
          exited: hostView(list, null).exited,
        },
      }
    },
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })

/** The starter's HTTP surface: `GET /status` and `POST /start`. */
export function starterHandler(
  starter: ReturnType<typeof gkeStarter>,
  log: (message: string) => void = (message) => {
    process.stderr.write(`${message}\n`)
  }
) {
  return async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url)
    try {
      if (pathname === "/status") {
        if (request.method !== "GET")
          return json(405, { error: { code: "invalid", message: "Use GET." } })
        return json(200, await starter.status())
      }
      if (pathname === "/start") {
        if (request.method !== "POST")
          return json(405, { error: { code: "invalid", message: "Use POST." } })
        const body: unknown = await request.json().catch(() => undefined)
        const started = await starter.start(body)
        log(`Started updater Job ${started.host.executor}.`)
        return json(202, started)
      }
      return json(404, { error: { code: "not_found", message: "Not found." } })
    } catch (error) {
      if (error instanceof StartRefused)
        return json(error.status, {
          error: { code: error.code, message: error.message },
        })
      const message =
        error instanceof Error ? error.message : "The starter failed."
      log(message)
      return json(503, { error: { code: "unavailable", message } })
    }
  }
}
