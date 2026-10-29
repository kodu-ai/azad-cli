/**
 * Only operating-system plumbing and explicitly needed Google auth reach
 * helpers. On Windows that plumbing includes the profile folders where npm,
 * gcloud and Terraform keep their caches and credentials, and how cmd.exe
 * finds and runs commands.
 */
export function commandEnvironment() {
  const entries: [string, string][] = []
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "SystemDrive",
    "windir",
    "ComSpec",
    "PATHEXT",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramData",
    "ProgramFiles",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "CLOUDSDK_CONFIG",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
  ]) {
    const value = process.env[key]
    if (value) entries.push([key, value])
  }
  return {
    ...Object.fromEntries(entries),
    WRANGLER_SEND_METRICS: "false",
    CHECKPOINT_DISABLE: "1",
    TF_INPUT: "0",
  }
}
