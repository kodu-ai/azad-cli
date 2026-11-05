import { readFileSync } from "node:fs"
import { isIP } from "node:net"
import type { Command } from "../command"
import { CliError } from "../../error"
import { VERSION } from "../../version"
import { parseStore } from "../update/installation"
import {
  gcsStoreReader,
  inClusterKubernetes,
  metadataToken,
  SERVICE_ACCOUNT_DIRECTORY,
} from "./cloud"
import { gkeStarter, starterHandler, type StarterConfig } from "./gke"

const HELP = [
  `azad ${VERSION} update-host: the update starter of a self-hosted installation`,
  "",
  "Usage:",
  "  azad update-host gke",
  "",
  "Runs beside the API in each API pod on Google Cloud (a native sidecar) and starts the installation's update Job when the API asks. It listens only on the pod's loopback address: GET /status reads the install store and the updater Jobs; POST /start {version, acceptMaintenance} creates the Job. azad-terraform configures it; you do not run it by hand.",
  "",
  "Environment:",
  "  AZAD_UPDATER_LISTEN           host:port to listen on (default 127.0.0.1:8095; loopback only)",
  "  AZAD_UPDATER_IMAGE            the updater image the Job runs, by digest (…@sha256:…)",
  "  AZAD_UPDATER_NAMESPACE        the Jobs' namespace (default: the pod's)",
  "  AZAD_UPDATER_SERVICE_ACCOUNT  the Jobs' service account (default azad-updater)",
  "  AZAD_INSTALL_STORE            the installation's GCS store as JSON",
  "",
].join("\n")

/**
 * Parses AZAD_UPDATER_LISTEN; only a loopback address is accepted, since the
 * starter's callers are the API Workers in its own pod.
 *
 * @throws CliError for any other address.
 */
export function loopbackListen(value: string | undefined): {
  hostname: string
  port: number
} {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/u.exec(
    value ?? "127.0.0.1:8095"
  )
  const hostname = match?.[1] ?? match?.[2] ?? ""
  const port = Number(match?.[3])
  const loopback =
    hostname === "localhost" ||
    hostname === "::1" ||
    (isIP(hostname) === 4 && hostname.startsWith("127."))
  if (!match || !loopback || !(port > 0 && port < 65536))
    throw new CliError(
      "AZAD_UPDATER_LISTEN must be a loopback host:port, such as 127.0.0.1:8095."
    )
  return { hostname, port }
}

/**
 * The starter's configuration from its environment.
 *
 * @throws CliError naming the missing or invalid setting.
 */
export function starterConfig(
  env: Record<string, string | undefined>,
  readNamespace: () => string = () =>
    readFileSync(`${SERVICE_ACCOUNT_DIRECTORY}/namespace`, "utf8")
): StarterConfig {
  const image = env.AZAD_UPDATER_IMAGE ?? ""
  if (!/^[a-z0-9.-]+(?::\d+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/u.test(image))
    throw new CliError(
      "AZAD_UPDATER_IMAGE must name the updater image by digest (registry/name@sha256:…)."
    )
  const store = parseStore(env.AZAD_INSTALL_STORE ?? "")
  if (store.kind !== "gcs")
    throw new CliError("AZAD_INSTALL_STORE must be the installation's GCS store.")
  const namespace = (env.AZAD_UPDATER_NAMESPACE ?? readNamespace()).trim()
  const serviceAccount = env.AZAD_UPDATER_SERVICE_ACCOUNT ?? "azad-updater"
  const name = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/u
  if (!name.test(namespace) || !name.test(serviceAccount))
    throw new CliError(
      "AZAD_UPDATER_NAMESPACE and AZAD_UPDATER_SERVICE_ACCOUNT must be Kubernetes names."
    )
  return { namespace, serviceAccount, image, store }
}

/** `azad update-host gke`: serves the starter until the pod stops it. */
export const updateHost: Command = {
  name: "update-host",
  async run(argv) {
    if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
      process.stdout.write(HELP)
      return argv.length === 0 ? 2 : 0
    }
    try {
      if (argv.length !== 1 || argv[0] !== "gke")
        throw new CliError("Usage: azad update-host gke")
      const listen = loopbackListen(process.env.AZAD_UPDATER_LISTEN)
      const config = starterConfig(process.env)
      const starter = gkeStarter(
        config,
        inClusterKubernetes(),
        gcsStoreReader({ bucket: config.store.bucket, token: metadataToken() })
      )
      const server = Bun.serve({
        hostname: listen.hostname,
        port: listen.port,
        fetch: starterHandler(starter),
      })
      process.stderr.write(
        `The update starter listens on ${listen.hostname}:${server.port}.\n`
      )
      await new Promise<void>((resolve) => {
        process.once("SIGTERM", resolve)
        process.once("SIGINT", resolve)
      })
      await server.stop()
      return 0
    } catch (error) {
      process.stderr.write(
        `${error instanceof CliError ? error.message : "The update starter stopped."}\n`
      )
      return 1
    }
  },
}
