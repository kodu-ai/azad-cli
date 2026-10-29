# Install Azad on your Google Cloud

Azad runs in your own Google Cloud project on GKE Autopilot, with no Cloudflare
runtime. Cloudflare only serves DNS for your domain. You bring a billed Google
Cloud project, a domain on Cloudflare, a Clerk account and a GitHub account. One
`terraform apply` creates the infrastructure and deploys Azad. The `azad`
setup wizard gathers the credentials Terraform cannot create and runs that
apply with [azad-terraform](https://github.com/kodu-ai/azad-terraform).

For Azad on Cloudflare instead, see [Install Azad on Cloudflare](install-cloudflare.md).

## What gets created

| Part | Where |
| --- | --- |
| API and web app | [celld](https://github.com/denoland/celld) fleets (`azad-api`, `azad-web`) on a GKE Autopilot cluster, `<name>-celld` |
| Durable Object, queue and file state | One GCS bucket, `<name>-fleet-<suffix>`, written by celld |
| Database | Cloud SQL for PostgreSQL. Only the Cloud SQL Auth Proxy reaches it, through the API pods' IAM identity; no network is allowlisted. Google's Cloud SQL Proxy Operator (with cert-manager) injects the proxy into the API pods. Each API pod also runs PgBouncer (transaction pooling, CloudNativePG's image), which keeps warm connections through the proxy so a request does not open its own |
| Project repositories | Forgejo inside the cluster (official Forgejo Helm chart), reached only by the API. Cloudflare Artifacts is not used on this target |
| HTTPS | A GKE Gateway: a regional external Application Load Balancer in the installation's region, on a regional static IP (Premium Tier), with Google-managed regional certificates (Certificate Manager, DNS authorization). TLS ends in the region, next to the cluster. Its proxies use a proxy-only subnet in the default VPC (`10.127.0.0/23` unless `proxy_only_subnet_range` says otherwise) |
| DNS | `A` records for `<host>`, `api.<host>` and `*.apps.<host>`, the certificate validation CNAMEs and Clerk's CNAMEs, in your Cloudflare zone. The validation CNAMEs come first; the `A` records are written only once the load balancer serves all three hosts over HTTPS. Existing records are never changed |
| Mini Apps | Run inside the API fleet (Worker Loader), served at `<app>.apps.<host>`. Turned off under optional settings (`AZAD_SELF_HOST_MINIAPPS=disabled`), the API has no Mini App provider and reports Mini Apps as unconfigured; the `*.apps.<host>` record and certificate stay |
| Agent machine (optional) | One Compute Engine VM for agents, `<name>-agents`, in the size chosen at setup. It has no public address (a Cloud NAT carries its outbound traffic); only the cluster's pods reach its SSH |
| Disk backups | Backup for GKE snapshots the `azad` namespace's disks (Forgejo and the fleets) with its Kubernetes resources, on the schedule chosen at setup |

The installation name (`<name>`) is derived from the hostname, so several
installations can share one project. A VPC has one proxy-only subnet per region,
which every regional load balancer there uses: a second installation in the same
project and region sets `proxy_only_subnet_range = null` in its Terraform
variables to use the first one's. Destroy the installation that created the
subnet last. Terraform enables the Compute, GKE, Cloud SQL and Certificate
Manager APIs it needs.

Kubernetes components use official charts and operators where they exist:
cert-manager (Jetstack), Google's Cloud SQL Proxy Operator and the Forgejo
Helm chart. celld has no operator, so its fleets are StatefulSets that
Terraform manages.

Meetings run on Cloudflare RealtimeKit: the deploy creates its app and a token
limited to Realtime, unless you turn meetings off under optional settings.

## Before you start

- A Google Cloud project with billing, where you can create clusters, Cloud SQL
  instances, buckets and IAM bindings (Owner, or Editor plus Project IAM Admin).
- The domain's zone in your Cloudflare account. Any hostname depth works; for
  example, `azad.team.example.com`.
- Tools: Git, Bun 1.4.4+, Node 26.12.1+ (with npm), Terraform 1.13.4+ and the
  [gcloud CLI](https://cloud.google.com/sdk/docs/install). Run `azad --doctor` to
  list any that are missing.
- Google credentials for Terraform:

  ```sh
  gcloud auth application-default login
  ```

  Allow every access the consent screen asks for. If you skip this, `azad`
  stops before changing anything and tells you to run it.
- On Windows, install from WSL (Ubuntu), with the Azad source checkout in
  WSL's own file system rather than under `/mnt/c`: the deploy's Terraform
  steps need a Linux shell.

## Install with azad

Both targets start the same way. Install `azad` from its GitHub releases
(see the [README](../README.md#install) for pinned versions, other
directories and Windows):

```sh
curl -fsSL https://github.com/kodu-ai/azad-cli/releases/latest/download/install.sh | sh
```

Deploys run from a checkout of the Azad app source until its release
artifacts are published. Clone it (read access to the repository is needed)
and install its dependencies:

```sh
git clone git@github.com:kodu-ai/azad-ide-web.git ~/azad-source
cd ~/azad-source && bun install --frozen-lockfile
```

Then run:

```sh
azad --source ~/azad-source
```

The first deploy downloads the azad-terraform release this `azad` pins,
checks its SHA-256 and keeps it in `~/.azad/cache/azad-terraform/<version>/`
(`azad --doctor` prints the version and the directory). The commands further
down call that directory `$TF`:

```sh
TF=~/.azad/cache/azad-terraform/<version>
```

Your answers and private settings are kept in the instance directory
`~/.azad/instances/default` (`%USERPROFILE%\.azad\instances\default` on
Windows), readable only by you. For a second installation, add
`--instance NAME` (`~/.azad/instances/NAME`) to every command; `--directory
PATH` uses another directory instead.

`azad` asks only for what it cannot decide for you. It saves each
answer, so you can stop at any point and rerun the same command to continue.
In order:

1. **Where should Azad run?** Choose **Your Google Cloud**. `azad` then
   lists what it will ask for. Right after this question `azad` checks the tools it needs (Node.js
   20+ and npm for the Clerk CLI, the deployment tools above, and gcloud where
   it applies). If any is missing or too old it lists each with its minimum
   version and download page, then stops; install them and rerun.
2. **Google Cloud project**, picked from `gcloud projects list`. If gcloud is
   not signed in, `azad` runs `gcloud auth login --update-adc` first,
   which also gives Terraform its Application Default Credentials.
3. **Google Cloud region** (default `us-central1`).
4. **Sizing.**
   - **Production** (the default) uses regular nodes, database backups and
     deletion protection.
   - **Evaluation** uses Spot nodes, the smallest database and no backups. Its
     destroy also removes all data.
5. **Agent machine:** a VM for agents, from 4 vCPU · 16 GB to 32 vCPU · 128 GB
   (default 8 vCPU · 16 GB), or none.
6. **Hostname**, such as `azad.example.com`. The API is `api.<hostname>`.
7. **One Cloudflare token.**
   - `azad` opens Cloudflare's token form with **User → API Tokens →
     Edit** filled in. Click **Continue to summary**, then **Create Token**,
     and paste it. If the form shows no permission, use the **Create
     additional tokens** template instead.
   - `azad` finds your account from the hostname's zone, then uses the
     token only to create a single deployment token. That token can read your
     zone and edit its DNS records and SSL settings, and nothing else.
8. **Clerk.**
   - Sign in through the official Clerk CLI.
   - `azad` creates the application and its production instance, turns on
     sign-in by emailed code, and adds the redirect URLs and allowed origins for
     the official Azad clients.
   - Clerk Protect, Clerk's fraud screening, is set to record sign-ups without
     blocking them. Its device check otherwise blocks ordinary browsers on new
     instances. Turn enforcement on in Clerk's dashboard once you have reviewed
     its decisions.
   - It creates the webhook for user sync with the instance's secret key,
     through Clerk's Svix app as the dashboard does. Only if Clerk refuses does
     it open the Webhooks page and ask for the signing secret.
9. **GitHub App.** Enter the GitHub organization that owns the App (Enter for
   your own account), then click **Create GitHub App** on the page `azad` opens; every field is pre-filled. GitHub returns the App's
   credentials directly to `azad`. After the deploy, `azad`
   opens the App's install page: install it on your organization, and `azad` confirms it. Installing only then lets GitHub's installation
   webhook and redirect reach the live API. Agents can create repositories
   only under an organization, so choose one as the owner.
10. **Would you like to enable Sign in with Google?** (default no; asked when
    `azad` created the Clerk application). Google has no API for this
    client, so yes takes a few clicks:
    - On the page `azad` opens, create a **Web application** OAuth
      client. Paste Clerk's redirect URI from your clipboard. If asked, set up
      the consent screen first.
    - Click **Download JSON**. `azad` reads the client from your
      Downloads folder, deletes the file, checks the client with Google and
      configures Clerk. You can paste the ID and secret instead.
    - Click **Publish app** on the Audience page `azad` opens. While the
      app is in Testing, only its listed test users can sign in.
11. **Will people use the Azad desktop or mobile apps?** (default yes). `azad` opens Clerk's Native applications page: turn on **Native API**
    there. Clerk has no API for this setting.
12. **Configure optional settings?** (default no). `azad` first prints
    the defaults that apply without it:
    - Mini Apps on, run inside the API fleet.
    - Meetings on: the deploy creates a Cloudflare RealtimeKit app and a token
      limited to Realtime.
    - Daily disk backups.
    - Files in the installation's own bucket.

    Answering yes asks, in order: disk backups (hourly, daily, weekly or off),
    Mini Apps, meetings, where uploaded files go (the installation's bucket, or
    your R2, GCS or S3 bucket), email through Resend, an existing RealtimeKit
    app, OpenAI meeting titles, GIFs through Klipy, and branding, error
    reporting and runtime settings.

`azad` then deploys:

1. It creates the deployment token.
2. azad-terraform's `scripts/gcp.ts setup` writes the Terraform variables
   into the instance directory. Your credentials stay in `azad`'s private
   `.env`; Terraform never stores them.
3. It shows the Terraform plan and applies exactly that saved plan only after
   you confirm (the default is No). A first install has two plans, because
   everything but the cluster is planned against the cluster's API: plan 1 of
   2 creates the cluster and Clerk's DNS records, and plan 2 of 2, shown once
   they exist, creates everything else and deploys the app. Each is confirmed
   on its own; declining applies nothing, and the next run plans the same step
   again. The first install takes about 30 minutes, mostly for the cluster,
   the load balancer and certificate issuance. Before it writes the `A`
   records, the apply waits (`ready_timeout_minutes`, 45 by default) until the
   load balancer serves every host over HTTPS with a valid certificate.

`azad --non-interactive --apply` confirms both plans, each planned in the same
run right before its apply; `--plan` stops after showing the first.

While the apply runs, `azad` keeps asking Clerk to check its DNS. It
finishes when sign-in works, then prints your URL.

### Settings without a question

These have working defaults and no prompt. Change them in
`terraform/gcp-celld/terraform.tfvars.json` in the instance directory after
`setup`, then plan and apply:

| Variable | Default | What it changes |
| --- | --- | --- |
| `database` | `db-custom-1-3840`, 10 GB, backups on (`db-f1-micro` without backups for evaluation) | Cloud SQL tier, disk size, backups and flags |
| `api_replicas` | `2` | API fleet nodes |
| `disk_backups` | `daily` | Backup for GKE schedule and `retain_days` |
| `agent_machine.disk_size_gb` | `100` | The agent machine's disk |
| `cloudflare_proxy`, `manage_ssl_rule` | `false`, `true` | Proxy the hostnames through Cloudflare with an Origin CA certificate |
| `proxy_only_subnet_range` | `10.127.0.0/23` | The load balancer's proxy-only subnet; `null` to share one |
| `ready_timeout_minutes` | `45` | How long DNS and deploys wait for the load balancer and the new revision |
| `ssh_allowed_private_cidrs` | `[]` | More private networks the API may SSH into |
| `spot`, `deletion_protection` | `false`, `true` (`true`, `false` for evaluation) | Spot nodes; destroy protection |

`azad`'s own options are flags: `azad --doctor` checks the tools for the
saved target, and `azad --schema` lists every field and choice for
`--non-interactive` setup. Native push needs `AZAD_PUSH_RELAY_SESSION_TOKEN`
during a deploy (see [Native push for the mobile apps](#native-push-for-the-mobile-apps)).

## Install with Terraform only

Every command names an instance directory that keeps this installation's
settings, Terraform state, variables and keys; the checkout only provides
code. Put the credentials in the instance directory's `.env` (here
`~/.azad/instances/default/.env`, private to you). `azad`'s `.env` has this shape:

```sh
CLOUDFLARE_API_TOKEN=...      # Zone Read, DNS Write, SSL and Certificates Write, Config Settings Write on the zone
CLERK_PUBLISHABLE_KEY=pk_live_...
CLERK_SECRET_KEY=sk_live_...
CLERK_WEBHOOK_SECRET=whsec_... # optional until the webhook exists
# Either all five GitHub App values, or none:
GITHUB_APP_ID=...
GITHUB_APP_SLUG=...
GITHUB_APP_CLIENT_ID=...
GITHUB_APP_CLIENT_SECRET=...
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n..."
```

Then:

```sh
bun --no-env-file "$TF/scripts/gcp.ts" setup \
  --credentials ~/.azad/instances/default/.env \
  --project-id my-project --region europe-west1 \
  --web-host azad.example.com --account-id <cloudflare-account-id> \
  --source ~/azad-source --instance-dir ~/.azad/instances/default [--evaluation]
bun --no-env-file "$TF/scripts/gcp.ts" init --instance-dir ~/.azad/instances/default
bun --no-env-file "$TF/scripts/gcp.ts" plan --source ~/azad-source --instance-dir ~/.azad/instances/default -out=terraform.tfplan
bun --no-env-file "$TF/scripts/gcp.ts" apply --source ~/azad-source --instance-dir ~/.azad/instances/default terraform.tfplan
# A first install: plan and apply once more for everything else.
bun --no-env-file "$TF/scripts/gcp.ts" plan --source ~/azad-source --instance-dir ~/.azad/instances/default -out=terraform.tfplan
bun --no-env-file "$TF/scripts/gcp.ts" apply --source ~/azad-source --instance-dir ~/.azad/instances/default terraform.tfplan
```

- `setup` reads the zone and Clerk's DNS targets, then writes
  `~/.azad/instances/default/terraform/gcp-celld/terraform.tfvars.json` once. It records the
  credential file's path; keep that file outside any checkout.
- Before the cluster exists, `plan` covers only the cluster and Clerk's DNS
  records (`gcp.ts phase` prints `cluster`), because the Kubernetes resources
  are planned against the cluster. Once it exists (`phase` prints `full`), the
  next plan covers everything else and deploys the app. Later updates are a
  single plan.
- Plan names such as `terraform.tfplan` are files in
  `~/.azad/instances/default/terraform/gcp-celld/`, beside the state. Every command finds the
  state, variables and Terraform's working data there; run `init` again after
  moving the directory. Plain `terraform` commands in azad-terraform's roots
  do not see them.

## After the install

- **Sign in** at `https://<hostname>`.
- **Agent machine:** in project setup, choose **A server over SSH** and enter
  the host, port and user from
  `bun --no-env-file "$TF/scripts/gcp.ts" output --instance-dir ~/.azad/instances/default agent_machine`
  and the key from
  `bun --no-env-file "$TF/scripts/gcp.ts" output --instance-dir ~/.azad/instances/default -raw agent_machine_private_key`
  (`azad` prints both). Terraform sets
  `SSH_ALLOWED_PRIVATE_CIDRS` to the cluster's subnet range (plus any
  `ssh_allowed_private_cidrs` you add), so the API may connect it there.
- **GitHub:** each person connects GitHub once from Azad's repository picker,
  which links the installation `azad` made. Install the App on any
  other organization your projects use.
- **Desktop and mobile apps:** turn on **Native API** in Clerk's dashboard, on
  the Native applications page. `azad` prints the exact link. Clerk has
  no API for this setting.
- **Official Mini Apps:** every deploy lists PartyTask, Release Queue and
  Remote iOS Simulator in your marketplace as Azad's apps (see
  "Official Mini Apps" in `docs/self-hosting.md` of the Azad source). If one
  fails, the deploy log names the command that retries only that step.
- **Back up** the instance directory. It holds the instance's signing and
  encryption keys; updates need it.

The instance directory holds everything this installation owns; the source
checkout only provides code, and any checkout of the same revision deploys it:

- `.env`: your answers, which the deploy reads directly.
- The Cloudflare token you pasted, and the scoped deployment token with its
  own Terraform state in `cloudflare-bootstrap/`.
- `terraform/gcp-celld/`: the installation's Terraform state, the
  `terraform.tfvars.json` that `setup` writes once, saved plans, Terraform's
  working data (`.terraform/`) and `celld-install/`, the deploy's keys, tools
  and log.

## Change settings

Rerun `azad --source ~/azad-source` with the same instance. Once a deployment
has started it asks **Resume the deployment with saved settings** (the
default) or **Change settings, then deploy**. Changing walks the questions
again with your saved answers filled in; Enter keeps each one. The changes are
saved in the instance directory's `.env`, and the deploy shows the plan and
asks the same confirmation as before; the apply then redeploys the app with
them. Answers only `azad` reads (`AZAD_CLI_*` lines) never redeploy.

Settings the first deploy fixed are shown, not asked: the target, the Google
Cloud project and region, the hostname and Cloudflare account, sizing, the
agent machine, disk backups and where files are stored. Changing the project,
region, hostname or storage would replace the installation or move its data,
so it means destroying the installation and [starting over](#start-over).
Disk backups, the agent machine and the other variables under
[Settings without a question](#settings-without-a-question) change in
`terraform/gcp-celld/terraform.tfvars.json` in the instance directory: edit,
plan, review and apply. `azad --non-interactive` never changes a deployed instance:
it reports a fixed setting as `immutable` and any other change as
`bound_instance`.

## Native push for the mobile apps

Web push works without any setup. The iOS and Android apps are woken through
Azad's push relay, which needs this instance claimed by an azad.pro account
(see "Native push through the Azad relay" in `docs/self-hosting.md` of the
Azad source).
The relay accepts a claim only from a signed-in azad.pro account, so it
cannot happen unattended. The deploy claims relay access itself when it has
your session and no relay token yet:

```sh
export AZAD_PUSH_RELAY_SESSION_TOKEN='<short-lived azad.pro session token>'
bun --no-env-file "$TF/scripts/gcp.ts" apply --source ~/azad-source --instance-dir ~/.azad/instances/default -replace='module.app[0].terraform_data.deploy'
unset AZAD_PUSH_RELAY_SESSION_TOKEN
```

- The claim runs at the end of the deploy, only if `api.<host>` resolves to
  public addresses and serves its discovery document. It redeploys the API
  with the relay's challenge, then with the relay token.
- The session token must still be valid when the claim runs. If it has
  expired, the deploy still succeeds, its log shows the relay's refusal, and
  native push stays off until a deploy with a fresh token.
- The relay token is kept in `terraform/gcp-celld/celld-install/secrets.json`
  in the instance directory and deployed on every later update. The session token is never written to a file.

## Differences from Azad on Cloudflare

- **Image previews:** uploaded images keep their dimensions but get no
  server-generated blurred preview (ThumbHash). On Cloudflare a private image
  Worker makes them through a service binding. celld can bind only another
  Worker in the API's own fleet bucket, and deploying a second Worker there
  would point the API fleet at it until the API is deployed again. The API
  logs `encoder_unbound` for each image it stores this way.

## Update

```sh
cd ~/azad-source && git pull --ff-only && bun install --frozen-lockfile
bun --no-env-file "$TF/scripts/gcp.ts" refresh --source ~/azad-source --instance-dir ~/.azad/instances/default   # records the new revision
bun --no-env-file "$TF/scripts/gcp.ts" init --instance-dir ~/.azad/instances/default
bun --no-env-file "$TF/scripts/gcp.ts" plan --source ~/azad-source --instance-dir ~/.azad/instances/default -out=terraform.tfplan
bun --no-env-file "$TF/scripts/gcp.ts" apply --source ~/azad-source --instance-dir ~/.azad/instances/default terraform.tfplan
```

The deploy waits until the API serves the new revision. To update `azad`
itself, rerun its install command; a newer release may pin a newer
azad-terraform, which its next deploy downloads (`azad --doctor` prints the
new `$TF`).

### Moving an install from the global to the regional load balancer

Installs made before the regional load balancer used Google's global one. The
new Gateway, certificates and IP are created beside the old ones, so traffic
keeps flowing, but the old pieces must go in order. Review each plan before
applying it:

1. Create the regional load balancer and move DNS. The apply waits until web,
   API and an `*.apps` host answer through the new IP with a valid
   certificate, then updates the `A` records:

   ```sh
   bun --no-env-file "$TF/scripts/gcp.ts" plan --source ~/azad-source --instance-dir ~/.azad/instances/default -target=module.dns -target=module.edge -out=lb1.tfplan
   bun --no-env-file "$TF/scripts/gcp.ts" apply --source ~/azad-source --instance-dir ~/.azad/instances/default lb1.tfplan
   ```

2. Remove the old Gateway and its routes, then wait until GKE has deleted
   the global load balancer behind them (`gcloud compute
   target-https-proxies list --global` no longer lists it). The certificate
   map cannot be deleted while that proxy exists:

   ```sh
   bun --no-env-file "$TF/scripts/gcp.ts" plan --source ~/azad-source --instance-dir ~/.azad/instances/default -target=module.gateway -out=lb2.tfplan
   bun --no-env-file "$TF/scripts/gcp.ts" apply --source ~/azad-source --instance-dir ~/.azad/instances/default lb2.tfplan
   ```

3. Remove the global IP, certificate map and certificates:

   ```sh
   bun --no-env-file "$TF/scripts/gcp.ts" plan --source ~/azad-source --instance-dir ~/.azad/instances/default -out=lb3.tfplan
   bun --no-env-file "$TF/scripts/gcp.ts" apply --source ~/azad-source --instance-dir ~/.azad/instances/default lb3.tfplan
   ```

Clients that cached the old IP fail for up to the DNS TTL (about five
minutes) after step 2, and open WebSockets reconnect once.

## Remove everything

```sh
bun --no-env-file "$TF/scripts/gcp.ts" destroy --source ~/azad-source --instance-dir ~/.azad/instances/default
```

- **Evaluation installs** are removed completely: the cluster, database,
  bucket, load balancer, certificates and the DNS records Terraform created.
- **Production installs** keep deletion protection on. Set
  `deletion_protection = false` in the variables and apply before you destroy.
- Destroy waits, using `gcloud`, until Kubernetes has deleted the cluster's
  disks.
- Cloud SQL reserves a deleted instance's name for up to a week. Each install
  appends a random suffix, so you can reinstall at once.
- **Clerk:** evaluation installs also delete the Clerk application `azad` created, through `azad`'s Clerk CLI login, so a reinstall
  can claim the same domain. Production installs keep it. The GitHub App is
  never deleted.

## Start over

To set up a new installation from scratch with the same instance directory,
first [remove everything](#remove-everything), then:

```sh
azad --reset --source ~/azad-source
```

Reset reads the installation's Terraform state in the instance directory and
the scoped token's state. While either still records resources it deletes
nothing, lists them and prints the commands that remove them: azad-terraform's
`gcp.ts init` and `gcp.ts destroy`, with the deletion-protection step above for
a production install, and, after it, because the destroy uses it, the scoped
Cloudflare token:

```sh
read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN   # paste a token that can edit API tokens
terraform -chdir=$HOME/.azad/instances/default/cloudflare-bootstrap/terraform destroy
```

Once nothing is recorded, it lists what it deletes and asks (default No): the
answers and private settings, the pasted token, the scoped token's records and
empty state, and, in `terraform/gcp-celld/`, the `terraform.tfvars.json`, saved
plans and `celld-install/` (the destroyed instance's keys). They hold
credentials, so they are deleted rather than backed up. The Terraform state,
its backups and your cloud accounts are not touched; delete the Clerk application (production installs) and the GitHub App in their
dashboards if you no longer need them. A new Clerk production instance for the
same hostname needs the old application deleted first. Without a terminal, add
`--yes`; `--json` prints one status (`reset_complete`, `needs_confirmation`,
`live_resources`, `state_unverified` or `nothing_to_reset`).

## Troubleshooting

- **The deploy log** is `terraform/gcp-celld/celld-install/install.log` in the
  instance directory.
- **The apply stops waiting for the load balancer:** the `A` records are left
  as they were. Check the certificate with `gcloud certificate-manager
  certificates describe <name>-tls --location=<region>` (Google issues it once
  the validation CNAMEs resolve, usually within minutes) and the Gateway with
  `kubectl -n azad describe gateway azad-regional`, then apply again.
- **The VPC already has a proxy-only subnet in the region:** Google allows one
  active subnet per region, so creating another fails. Set
  `proxy_only_subnet_range = null` to use the existing one, or another range if
  the default overlaps one of your networks.
- **Sign-in fails right after install:** Clerk verifies DNS and issues its
  certificate on its own schedule. **Verify** on Clerk's Domains page makes it
  check at once.
