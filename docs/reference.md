# azad self-hosting reference

How `azad` (and `azad selfhost`, the same command) sets up, deploys and
maintains a self-hosted Azad, in detail. Start with the
[README](../README.md) and the install guides for
[Cloudflare](install-cloudflare.md) and [Google Cloud](install-google-cloud.md).

## Setup flow

The wizard asks only what it cannot decide; everything else has a default.
Answers are saved after each prompt in the instance's private `.env` (0600);
rerun the same command to resume. After the first question it lists what it
will ask for.

1. **Where should Azad run?** Cloudflare, or your Google Cloud (Cloudflare
   stays in front for DNS). Right after it, before any other question, the
   wizard checks the tools it needs (see [Tools](#tools)) and, if any is
   missing or too old, lists each with its minimum version and official
   download page and stops. With a saved target the check comes before the
   first question.
2. **Database** (Cloudflare only; on Google Cloud, Terraform creates Cloud
   SQL): Neon, Google Cloud SQL or other PostgreSQL. A pasted Neon pooled URL
   is switched to its direct endpoint, and the wizard prints that host (never
   the password). Cloud SQL picks the project from `gcloud projects list`,
   then asks the region and the detected runner IPv4.
3. **Google Cloud project, region, sizing and agent machine** (Google Cloud
   only): the project is picked from `gcloud projects list`, after
   `gcloud auth login --update-adc` when needed. Evaluation sizing uses Spot
   nodes, the smallest database and no backups; production keeps backups and
   deletion protection.
4. **Hostname and one Cloudflare token.** The token page opens as
   Cloudflare's token form pre-filled with User → API Tokens → Edit (the
   "Create additional tokens" template's permission) and a name for the
   installation. The account is found from the hostname's zone with a
   ten-minute Zone Read token that is revoked afterwards. A rejected token
   (HTTP status shown, never the value) is asked for again.
5. **Clerk** through the official Clerk CLI (`npx clerk@4.0.0`): browser
   sign-in, then the application, production instance, email-code sign-in,
   native redirects and allowed origins. When the CLI cannot start (offline,
   or the npm registry is blocked), the wizard says so and asks for the keys
   instead.
6. **GitHub App** through GitHub's App manifest flow: the owning organization
   (Enter for your account), then a local page posts the manifest, and GitHub
   returns the App ID, client secret, private key and webhook secret.
7. **Would you like to enable Sign in with Google?** (opt-in, default no) and
   **Will people use the Azad desktop or mobile apps?** (default yes). Both
   are asked only when the wizard created the Clerk app. Automation answers
   them with the `googleSignIn` and `nativeApps` choices.
8. **Configure optional settings?** (default no), after a line listing the
   defaults that apply without it: Mini Apps on, meetings on (the deploy finds
   or creates the Cloudflare RealtimeKit app `azad-<first label of the
   hostname>` and a token limited to Realtime; its value-free record is
   `.realtimekit.json` in the instance directory), managed project source on
   Cloudflare Artifacts (Cloudflare only), daily disk backups (Google Cloud),
   and this installation's bucket for files. Yes asks for each of those, then
   email, an existing RealtimeKit app, media, branding and runtime settings.

The Clerk webhook for user sync is created automatically through Clerk's
Backend API and the instance's Svix app. If any step is refused, the wizard
copies the endpoint URL, opens the Webhooks page and asks for the secret.

Still manual:

- **Two clicks on GitHub:** "Create GitHub App" on the pre-filled page the
  wizard opens, then, after the deploy, "Install" on the App's install page;
  the wizard confirms the installation through GitHub's API.
- **Google sign-in (optional):** Google has no API that creates a Web
  application OAuth client, so you create one on the page the wizard opens
  (Clerk's redirect URI is on the clipboard) and click **Download JSON**. The
  wizard reads the client from your Downloads folder, deletes the file, checks
  the client with Google's token endpoint and configures Clerk.
- **Clerk Native API** for the desktop and mobile apps: no API turns it on;
  the wizard opens the instance's Native applications page.
- **Cloudflare token:** one click on Cloudflare's pre-filled token form, then
  pasting the token.
- **Neon:** you paste the connection string from an existing project.

Provider pages open after a cancellable three-second countdown; Ctrl+C stops
before the browser opens. Valid saved answers keep with Enter and do not
reopen pages. A complete saved configuration needs one confirmation to deploy
(or keep); answering No walks the questions again.

## Deploy

With `--source`, the wizard deploys after its questions:

1. Checks the deployment tools again and, for Google Cloud and Cloud SQL,
   Google Application Default Credentials.
2. Checks that `--source` is a Git checkout with a readable commit, that it is
   the commit the instance is bound to (if a deploy already started), and that
   it contains the features the saved settings need (verified database TLS,
   automatic Neon certificate registration, token bootstrap) with
   `git merge-base --is-ancestor`.
3. Prepares azad-terraform (see [azad-terraform](#azad-terraform)).
4. Creates the scoped Cloudflare tokens after a confirmation, through
   azad-terraform's `scripts/bootstrap.ts`, then the RealtimeKit app when
   meetings are on.
5. Runs the target's driver: `setup` once (it writes the instance's
   `terraform.tfvars.json`), `init`, `plan`, and, only after a confirmation
   that defaults to No, `apply` of exactly that saved plan. A first Google
   Cloud install has two plans, the cluster and Clerk's DNS records, then
   everything else; each is shown and confirmed on its own.
6. During each apply, asks Clerk to recheck its DNS every two minutes, then
   waits until sign-in works and opens the GitHub App's install page.

Once a deployment has started (`AZAD_CLI_SOURCE_REVISION` is saved), a rerun
asks **Resume the deployment with saved settings** (default) or **Change
settings, then deploy**. Settings the deploy fixed are printed as read-only
lines and never asked: the target, database and connection, Google Cloud
project and region, Cloud SQL runner network, hostname, Cloudflare account and
access mode, storage, Google Cloud sizing, agent machine and disk backups, and
on Cloudflare Mini Apps and managed source. Changing one would replace
infrastructure or move data, so it takes a destroy and `--reset`.
Noninteractive runs never change a deployed instance: every difference is a
`bound_instance` issue, and a fixed setting is also reported as `immutable`.

## azad-terraform

The Terraform roots, modules and drivers live in
[kodu-ai/azad-terraform](https://github.com/kodu-ai/azad-terraform). Each
`azad` release pins one azad-terraform version, in one constant
(`AZAD_TERRAFORM_VERSION` in `src/commands/selfhost/terraform.ts`).

- **Download.** The first deploy (or `--create-tokens`, `--plan`, `--apply`)
  downloads `azad-terraform-<version>.tar.gz` and its `.sha256` file from
  `https://github.com/kodu-ai/azad-terraform/releases/download/v<version>/`,
  checks the tarball's SHA-256 against both that file and the digest this
  `azad` pins (`AZAD_TERRAFORM_SHA256`; a version without a pin is never
  downloaded), checks that it holds one
  `azad-terraform-<version>/` directory with the three drivers, extracts it to
  `~/.azad/cache/azad-terraform/<version>/` and runs
  `bun install --frozen-lockfile` there once. A marker file records a
  completed preparation; anything interrupted is redone from the download.
  Offline, an unpublished release and a checksum mismatch each stop with a
  message, and nothing partial is ever used.
- **Override.** `--terraform-dir PATH` (or `AZAD_TERRAFORM_DIR`) runs a local
  azad-terraform checkout instead, for development; `azad` installs its
  dependencies once if it has no `node_modules`.
- **`--doctor`** prints which azad-terraform a deploy would use and whether it
  is ready; it never downloads.

The drivers run from the azad-terraform directory with `bun --no-env-file`,
so nothing depends on the working directory. `azad` passes the app source as
`--source` to the commands that deploy (`setup`, `refresh`, `plan`, `apply`,
`destroy`), never to read-only ones (`init`, `show`, `output`, `state`,
`phase`), and the instance directory last:

```sh
bun --no-env-file $TF/scripts/cloudflare.ts setup --database-provider postgres|cloudsql \
  --web-host HOST --credentials INSTANCE/.env --account-id ID \
  [--project-id ID --runner-cidr CIDR] --root postgres|cloudsql --source APP --instance-dir INSTANCE
bun --no-env-file $TF/scripts/cloudflare.ts init --root postgres|cloudsql --instance-dir INSTANCE
bun --no-env-file $TF/scripts/cloudflare.ts plan -out=terraform.tfplan --root … --source APP --instance-dir INSTANCE
bun --no-env-file $TF/scripts/cloudflare.ts apply terraform.tfplan --root … --source APP --instance-dir INSTANCE

bun --no-env-file $TF/scripts/gcp.ts setup --credentials INSTANCE/.env --project-id ID --region REGION \
  --web-host HOST --account-id ID [--evaluation] [--disk-backups …] [--agent-machine …] --source APP --instance-dir INSTANCE
bun --no-env-file $TF/scripts/gcp.ts init -input=false --instance-dir INSTANCE
bun --no-env-file $TF/scripts/gcp.ts phase --instance-dir INSTANCE
bun --no-env-file $TF/scripts/gcp.ts plan -input=false -out=terraform.tfplan --source APP --instance-dir INSTANCE
bun --no-env-file $TF/scripts/gcp.ts apply -input=false terraform.tfplan --source APP --instance-dir INSTANCE

bun --no-env-file $TF/scripts/bootstrap.ts plan|apply --config PRIVATE_JSON \
  --bootstrap-file PRIVATE_ENV --state-dir INSTANCE/cloudflare-bootstrap --source APP
```

`azad` owns the prompts, local credential entry, packaging and source
selection; azad-terraform owns provider lookup, Terraform, the deploy step and
its state, and validates the source itself. `azad` never duplicates that
logic.

## The Azad app source

Deploys need `--source`, a Git checkout of the Azad app source, until app
release artifacts are published. The first deploy saves its path
(`AZAD_CLI_SOURCE`) and its commit (`AZAD_CLI_SOURCE_REVISION`) in the
instance; later runs reuse the saved path, and refuse a checkout at another
commit. Update a running installation to a new commit with the drivers'
`refresh`, `plan` and `apply` (see the install guides). If the source has no
`node_modules`, the deploy runs `bun install --frozen-lockfile` in it first.

## Instances

Each installation has its own instance directory, created private (0700,
files 0600): `~/.azad/instances/NAME`, under the home folder
(`%USERPROFILE%\.azad\instances\NAME` on Windows). Without `--instance` the
name is `default`; names are letters, digits, `-` and `_`. `--directory PATH`
(relative to the working directory, `~` expanded) selects any other
directory; the two flags are not combined. Every command that reads an
instance (`--doctor`, `--status`, `--reset`, `--non-interactive`) takes the
same flag.

| | Instance directory (`~/.azad/instances/NAME`) |
| --- | --- |
| Both targets | `.env` (answers and credentials; the deploy reads it), `.cloudflare-bootstrap-credential/`, `.cloudflare-bootstrap.json`, `cloudflare-bootstrap/` (scoped tokens and their local Terraform state), `.realtimekit.json` |
| Cloudflare | `terraform/postgres/` (Neon, other PostgreSQL) or `terraform/cloudsql/` (Cloud SQL): `terraform.tfstate`, `terraform.tfvars.json`, `terraform.tfplan`, `.terraform/` (Terraform's working data), `installer-state/` |
| Google Cloud | `terraform/gcp-celld/`: `terraform.tfstate`, `terraform.tfvars.json`, `terraform.tfplan`, `.terraform/`, `celld-install/` (instance keys and deploy log) |

`~/.azad` is shared with other Azad tools: azad-terraform downloads are cached
in `~/.azad/cache/azad-terraform/`, which holds no instance data.

## Tools

The `azad` executable embeds its runtime, but the wizard runs the Clerk CLI
through npx, so it needs Node.js 20+ and npm (npx), unless Clerk keys entered
by hand are already saved. The Google Cloud target and Cloud SQL need gcloud.
Deploys also need Git, Bun 1.4.4+, Node.js 26.12.1+ and Terraform 1.13.4+.
The wizard checks these right after the target question and stops with one
line per missing or too-old tool:

```text
These tools are missing or too old. Please install them, then run azad again:
- Node.js 26.12.1 or newer (found 22.11.0): https://nodejs.org/en/download
- Terraform 1.13.4 or newer (not installed): https://developer.hashicorp.com/terraform/install
```

`azad --doctor [--instance NAME]` checks the wizard's and the deploy's tools
for the saved target the same way and exits 1 while one is missing; without
saved settings it lists gcloud separately, as needed only for Google Cloud and
Cloud SQL.

## Windows, macOS and Linux

Paths are built with the platform's separators, and a typed path (the GitHub
App key, `--directory`, `--config`, `--credentials`, `--source`) may start
with `~` and may be quoted, as Windows' "Copy as path" does. On Windows:

- Tools are found on `PATH` with `PATHEXT`. An `.exe` starts directly; npx,
  npm and gcloud are `.cmd` shims, which run through `cmd.exe /d /s /c` with
  each argument escaped for cmd.
- Pages open through the URL protocol handler, text goes to the clipboard
  with `clip`, and Clerk's DNS rechecks during a deploy run in PowerShell. On
  Linux the browser opener is `xdg-open`, then WSL's `wslview`; the clipboard
  is `wl-copy`, `xclip`, `xsel`, then WSL's `clip.exe`.
- Files have no POSIX modes: an instance under the profile folder inherits
  its access list, which admits only your account, Administrators and SYSTEM.
- The deploy needs a Linux shell (its Terraform steps run bash, and Google
  Cloud's `celld` has no Windows build): configure on Windows if you like,
  but deploy from WSL, with the checkout and instance in WSL's own file
  system.

Linux builds target glibc; Alpine/musl is not supported. x64 builds use Bun's
baseline runtime (no AVX2 needed). A Google Cloud deploy runs `celld`, which
has no Intel macOS build: deploy that target from Apple silicon macOS or Linux.

## Provider API endpoints

The wizard's own API requests honor the variable each provider's tooling
reads, for networks that reach a provider through a gateway:
`CLOUDFLARE_API_BASE_URL` (including `/client/v4`), `CLERK_API_URL`,
`GITHUB_API_URL` and `CLOUDSDK_AUTH_TOKEN_HOST`. Each must be an `https://`
URL, or `http://127.0.0.1`, without credentials, query or fragment; an invalid
value stops before the first question. The drivers keep their own endpoints.
The terminal tests point these at local fakes.

## Meetings for a running installation

```sh
azad --provision-meetings --web-host HOST --bootstrap-file PRIVATE_ENV --settings-file PRIVATE_ENV
```

finds or creates the installation's RealtimeKit app and a Realtime-only
token, and writes the three `CLOUDFLARE_REALTIMEKIT_*` settings into each
`--settings-file` (repeat it to update several; `--account-id` when the first
file has no `CLOUDFLARE_ACCOUNT_ID`). It prints names and ids only, and a
rerun changes nothing that is already in place. Redeploy to apply them.

## Start over

`azad --reset [--instance NAME | --directory PATH] [--source CHECKOUT]
[--terraform-dir PATH]` clears an instance so the next run starts from
scratch. It first reads the installation's state in `terraform/<root>/` and
the scoped tokens' state in `cloudflare-bootstrap/terraform`: local state
files directly, a configured remote backend of the tokens through
`terraform state list`. While either records resources, or cannot be read, it
deletes nothing, exits 1 and prints the commands that remove them: the
target's `init` and `destroy` with this `azad`'s azad-terraform and the saved
source (or `--source` when it moved), with the deletion-protection step for
production Google Cloud and Cloud SQL, then the tokens'
`terraform -chdir=<instance>/cloudflare-bootstrap/terraform destroy` with a
token that can edit API tokens. It never downloads, runs a destroy or calls a
provider. Otherwise it lists the files and asks (default No); without a
terminal it needs `--yes`, and `--json` prints one status: `reset_complete`,
`needs_confirmation`, `live_resources`, `state_unverified` or
`nothing_to_reset`.

It deletes the instance's `.env`, the bootstrap credential, the token records
and their empty state, the meetings record and leftovers of interrupted
writes, plus, in `terraform/<root>/`, the `terraform.tfvars.json`, saved plans
and the deploy's state (`installer-state/` or `celld-install/`). These hold
credentials, so they are deleted, not moved to a backup where secrets would
linger. The Terraform state, its backups, `.terraform/` and `.gitignore` stay,
and nothing in any provider account changes.

## One Cloudflare bootstrap token

The wizard opens Cloudflare's API Tokens page pre-filled with **User → API
Tokens → Edit** (the **Create additional tokens** template). That token is not
a deployment token; Cloudflare still enforces the creator's account and zone
access. The terminal masks it and saves it separately at
`<instance>/.cloudflare-bootstrap-credential/.env` (private directory and 0600
file); the instance's `.env` holds only its path.

During a deploy, azad-terraform's `scripts/bootstrap.ts` (with its
`roots/bootstrap`) creates the scoped deployment token and, as selected, the
Mini Apps runtime token and the Artifacts and Queues tokens for managed
project source. `azad` writes the non-secret request to a private temporary
file, passes the bootstrap token's file path (never the value), checks the
helper's value-free result, receipt, Terraform token IDs and values, and
merges only the derived credentials into the instance's `.env`. Missing or
inconsistent evidence stops before replacement tokens can be minted; a failed
invocation cannot reuse an old success receipt. A completed bootstrap resumes
without the administrator token, which may be revoked.

## Automation

```sh
azad --schema
azad --status --config setup.json --credentials /private/azad.env
azad --non-interactive --config setup.json --credentials /private/azad.env --json
azad --non-interactive --create-tokens --source ~/azad-source --json
azad --non-interactive --plan --source ~/azad-source --json
azad --non-interactive --apply --source ~/azad-source --json
```

Each prints one JSON status. `--schema` lists every field and choice, marks
secrets and gives defaults. The config holds only non-secret `fields` and
`choices`; secrets come from the private `--credentials` dotenv (never
arguments). For the token bootstrap, `choices.cloudflareAuth: "bootstrap"`
with the non-secret field `AZAD_CLI_CLOUDFLARE_BOOTSTRAP_FILE` pointing to a
separate private dotenv holding only `CLOUDFLARE_BOOTSTRAP_API_TOKEN`.

`--create-tokens` creates only the scoped credentials and returns
`bootstrap_complete`. On a fresh bootstrap, `--plan` returns
`bootstrap_planned`: a read-only permission preview, not a workload plan.
`--apply` authorizes both the bootstrap and the workload apply; every plan it
applies is made in the same run right before its apply, so a plan saved by an
earlier run is never applied. The optional-settings switch `optionalSettings`
guards `diskBackups`, `miniapps`, `managedSource`, `enableMeetings`,
`storage`, `optionalServices` and `advanced`; a config that sets any of those
keys without it turns the switch on.

## Security

- Secrets are typed into masked prompts or read from private dotenv files
  (owned by you, readable only by you, not a link), and saved only in 0600
  files inside the private (0700) instance directory. One exception is on
  screen by
  design: the Neon connection string is a visible field, so you can see and
  edit the URL you paste, and changing settings shows it again.
- Secrets are never command-line arguments. The drivers get file paths
  (`--credentials`, `--bootstrap-file`), and Clerk API request bodies, such
  as the Google OAuth client secret, go to the Clerk CLI in a temporary
  0600 file.
- Reports, errors and `--status` output name fields, never values, and
  provider and parser errors are not echoed, since they may contain input
  values. A mistyped option is not repeated either.
- The Cloudflare token you paste is kept apart from the deployment settings
  and used only to create narrowly scoped tokens.
- The tools the wizard and deploy run get a minimal environment (`PATH`,
  home and temp folders, proxies, CA bundles and Google credentials), with
  telemetry off. Only `--reset`'s `terraform state list` of a remote token
  backend gets your full environment, which holds that backend's
  credentials.
- `install.sh` downloads over HTTPS only and installs nothing unless the
  executable matches the release's `SHA256SUMS`; the azad-terraform tarball
  must match its release checksum and this `azad`'s pin.
- Every Terraform apply is shown as a plan first and needs an explicit yes;
  `--reset` never destroys anything itself.

Keep the instance directory private and backed up: it holds credentials and
Terraform state.

## Neon connection security

Neon setup defaults to certificate and hostname verification. For supported
direct Neon URLs, setup selects `sslmode=verify-full` and omits
`channel_binding=require` from its effective configuration (Hyperdrive cannot
enforce mandatory channel binding). Pooled endpoints are switched to the
direct host; unknown options and unsupported security settings are rejected.
For a fresh Neon `verify-full` connection, setup records
`AZAD_SELF_HOST_DATABASE_CA=neon-isrg-root-x1` and the workload Terraform
registers the CA with Cloudflare; other PostgreSQL providers with
`verify-full` need an explicit `AZAD_SELF_HOST_DATABASE_CA_CERT_ID`.
