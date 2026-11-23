# Install Azad on Cloudflare

Azad runs in your own Cloudflare account. You bring:

- **Clerk** for sign-in.
- **A PostgreSQL database:** Neon, any PostgreSQL 17+, or Cloud SQL, which
  Terraform creates for you.
- **Optionally, your own S3-compatible bucket**, such as Google Cloud Storage,
  Amazon S3, R2 or MinIO.

One `terraform apply` creates the Cloudflare resources, and a deploy step
installs Azad on them. The `azad` setup wizard gathers the credentials
Terraform cannot create, downloads the signed Azad release and runs both with
[azad-terraform](https://github.com/kodu-ai/azad-terraform). You need no
access to Azad's source code.

To run Azad on your own Google Cloud instead, see
[Install Azad on your Google Cloud](install-google-cloud.md). The Terraform
details for this target are in azad-terraform's README.

## What gets created

| Part | Where |
| --- | --- |
| API | A Worker with its Durable Objects, queue and cron triggers, on the custom domain `api.<host>` |
| Web app | A Pages project on `<host>` |
| Database connection | Hyperdrive, to your database's direct endpoint |
| Files and Agent Connect releases | This installation's R2 buckets, or your own bucket (`STORAGE_*` settings) |
| Mini Apps (unless you choose Not now) | Inside the API Worker, on their own domain: each app is a Dynamic Worker with a SQLite Durable Object as its database, at `<app>.<Mini Apps domain>` |
| Managed project source (optional) | Cloudflare Artifacts |
| DNS | Clerk's CNAMEs, one Worker-free route per Board hostname (so a zone-wide wildcard route never serves another Worker on them), and the Mini Apps domain's wildcard record, route and certificate |

Names derive from the API hostname, so several installations can share one
account.

## Before you start

- A Cloudflare account on the Workers Paid plan that holds your domain's zone.
  If files stay in R2, enable R2 too.
- A domain for Mini Apps in the same account, apart from Azad's hostname
  (not the hostname, not under it and not containing it):
  - a separate zone, such as `example-apps.com`; or
  - a subdomain of one of the account's zones, such as `apps.example.com`.
    Turn on Cloudflare's Advanced Certificate Manager for that zone: Terraform
    orders the subdomain's wildcard certificate there.

  You can also skip Mini Apps (**Not now**); the domain cannot be added later
  without starting over.
- A database, unless you choose Cloud SQL:
  - PostgreSQL 17+, reachable from Cloudflare and from the machine you install
    from.
  - Use a schema-owning user and `sslmode=require` or `verify-full`.
  - For Neon, use the direct endpoint. `azad` switches a pasted pooler URL
    automatically.
  - Leave room for Hyperdrive's 20 connections.
- Tools: Bun 1.4.4+, Terraform 1.13.4+, curl and tar, and Node.js 20+ with
  npm for the Clerk CLI; for Cloud SQL, also the
  [gcloud CLI](https://cloud.google.com/sdk/docs/install). Run `azad --doctor`
  to list any that are missing. Cloud SQL deploys need Google Application
  Default Credentials: `azad` signs you in with
  `gcloud auth login --update-adc` when it picks the project, and stops
  before changing anything if they are missing.
- On Windows, install from WSL (Ubuntu): the deploy's Terraform steps need a
  Linux shell.

## Install with azad

Both targets start the same way. Install `azad` from its GitHub releases
(see the [README](../README.md#install) for pinned versions, other
directories and Windows):

```sh
curl -fsSL https://github.com/kodu-ai/azad-cli/releases/latest/download/install.sh | sh
```

Then run:

```sh
azad
```

The deploy downloads two things, checks them and keeps them:

- The latest Azad release (or the one `--version x.y.z` names), from
  `https://api.azad.pro/api/v3/releases/`. Its manifest must carry a valid
  signature by the key this `azad` pins, and every file must match the
  manifest. It is kept in `~/.azad/cache/releases/<version>/`, which the
  commands below call `$R`.
- The azad-terraform release this `azad` pins, checked against its SHA-256,
  in `~/.azad/cache/azad-terraform/<version>/`, which the commands below call
  `$TF`.

`azad --doctor` prints the azad-terraform directory and, once an instance
has deployed, the release it records:

```sh
TF=~/.azad/cache/azad-terraform/<version>
R=~/.azad/cache/releases/<Azad version>
```

Your answers and private settings are kept in the instance directory
`~/.azad/instances/default` (`%USERPROFILE%\.azad\instances\default` on
Windows), readable only by you. For a second installation, add
`--instance NAME` (`~/.azad/instances/NAME`) to every command; `--directory
PATH` uses another directory instead.

`azad` asks only for what it cannot decide for you. It saves each
answer, so you can stop at any point and rerun the same command to continue.
In order:

1. **Where should Azad run?** Choose **Cloudflare**. `azad` then lists
   what it will ask for. Right after this question `azad` checks the tools it needs (Node.js
   20+ and npm for the Clerk CLI, the deployment tools above, and gcloud where
   it applies). If any is missing or too old it lists each with its minimum
   version and download page, then stops; install them and rerun. Choosing Cloud SQL below adds
   gcloud.
2. **Database:** Neon (the default), Google Cloud SQL or other PostgreSQL.
   - **Neon** opens the Neon console; paste the connection string from your
     project's **Connect** panel. A pooled URL is switched to the direct
     endpoint and to certificate-verified TLS.
   - **Other PostgreSQL** asks for the direct connection URL, and for
     `sslmode=verify-full` also the ID of its CA certificate uploaded to
     Cloudflare.
   - **Cloud SQL** picks the project from `gcloud projects list` (signing in
     with `gcloud auth login --update-adc` when needed), then asks for the
     region (default `us-central1`) and this machine's public IPv4, which is
     detected and pre-filled.
3. **Hostname**, such as `azad.example.com`. The API is `api.<hostname>`.
4. **One Cloudflare token.**
   - `azad` opens Cloudflare's token form with **User → API Tokens →
     Edit** filled in. Click **Continue to summary**, then **Create Token**,
     and paste it. If the form shows no permission, use the **Create
     additional tokens** template instead.
   - `azad` finds your account from the hostname's zone.
   - It then creates narrowly scoped tokens: one to deploy, which also covers
     the zone of your Mini Apps domain, and, with managed source, two for
     Artifacts and its events.
   - Your token is used for nothing else.
5. **Where should Mini Apps run?**
   - **On their own domain** (the default, recommended): enter the Mini Apps
     domain from [Before you start](#before-you-start). `azad` looks it up in
     your account and asks again if no zone there holds it. For a subdomain
     it reminds you to turn on Advanced Certificate Manager.
   - **Not now**: Mini Apps stay off.
6. **Clerk:**
   - Sign in through the official Clerk CLI.
   - `azad` creates the application and its production instance, turns on
     sign-in by emailed code, and adds the official clients' redirect URLs and
     allowed origins.
   - Clerk Protect, Clerk's fraud screening, is set to record sign-ups without
     blocking them. Its device check otherwise blocks ordinary browsers on new
     instances. Turn enforcement on in Clerk's dashboard once you have reviewed
     its decisions.
   - It creates the webhook for user sync. It asks for the signing secret only
     if Clerk refuses.
7. **GitHub App:** enter the GitHub organization that owns the App (Enter for
   your own account), then click **Create GitHub App** on the pre-filled page
   `azad` opens. After the deploy, `azad` opens the App's install
   page: install it on your organization, and `azad` confirms it.
8. **Would you like to enable Sign in with Google?** (default no; asked when
   `azad` created the Clerk application). If yes, create a **Web application**
   OAuth client on the Google Cloud page `azad` opens, with Clerk's
   redirect URI from your clipboard, and click **Download JSON**. `azad`
   reads and deletes the file, checks the client with Google and configures
   Clerk. Then click **Publish app** on the Audience page it opens.
9. **Will people use the Azad desktop or mobile apps?** (default yes): turn on
   **Native API** on the Clerk page `azad` opens. Clerk has no API for
   this setting.
10. **Configure optional settings?** (default no). `azad` first prints
   the defaults that apply without it:
    - Mini Apps on your Mini Apps domain, or off.
    - Meetings on: the deploy creates a Cloudflare RealtimeKit app and a token
      limited to Realtime.
    - Managed project repositories on Cloudflare Artifacts, with tokens
      `azad` creates. New projects need them.
    - Files and Agent Connect releases in this installation's R2 buckets.

    Answering yes asks, in order: managed project source, meetings, where
    uploaded files go (this installation's R2 buckets, or your R2, GCS or S3
    bucket), email through Resend, an existing RealtimeKit app, OpenAI
    meeting titles, GIFs through Klipy, and branding, error reporting and
    runtime settings.

Then `azad` deploys:

1. It creates the scoped tokens.
2. It downloads and verifies the release (see above).
3. azad-terraform's `scripts/cloudflare.ts setup` writes the Terraform
   variables into the instance directory, with the Mini Apps domain
   (`--miniapps-domain`). Your credentials stay in its private `.env`.
4. It shows the Terraform plan.
5. After you confirm, it applies the plan: Terraform creates Clerk's DNS
   records, the hostname routes and the Mini Apps domain's record, route and
   certificate.
6. The deploy step runs the release's installer. It waits for Clerk, checks
   the database and the storage bucket, runs migrations, and deploys the API
   Worker and the web app.

While the apply runs, `azad` keeps asking Clerk to check its DNS. It
finishes when sign-in works, then prints your URL.

### Settings without a question

`azad`'s own options are flags: `azad --doctor` checks the tools for the
saved target, `azad --schema` lists every field and choice for
`--non-interactive` setup (including scoped tokens you create yourself,
`choices.cloudflareAuth: "manual"`), and `azad --provision-meetings` adds
meetings to a running installation (see the [reference](reference.md)).
Terraform settings without a prompt, such as a Cloud SQL tier or your bucket's
region and endpoint, are in azad-terraform's README and the
`terraform/<root>/terraform.tfvars.json` that `setup` writes in the instance
directory.

## Install with Terraform only

azad-terraform's README has the full reference and an example credential
file. Every command names the instance directory that keeps this
installation's settings, Terraform state and variables, and the commands that
deploy name the release directory `$R`; azad-terraform and the release only
provide code. `azad` downloads and verifies `$R` on its first deploy run; a
release directory you build yourself must have the same layout (see the
[reference](reference.md#releases)). For an existing database:

```sh
bun --no-env-file "$TF/scripts/cloudflare.ts" setup --database-provider postgres \
  --web-host azad.example.com --credentials /private/azad.env \
  --miniapps-domain example-apps.com \
  --root postgres --release "$R" --instance-dir ~/.azad/instances/default
bun --no-env-file "$TF/scripts/cloudflare.ts" init --root postgres --release "$R" --instance-dir ~/.azad/instances/default
bun --no-env-file "$TF/scripts/cloudflare.ts" plan --root postgres --release "$R" --instance-dir ~/.azad/instances/default -out=terraform.tfplan
bun --no-env-file "$TF/scripts/cloudflare.ts" apply --root postgres --release "$R" --instance-dir ~/.azad/instances/default terraform.tfplan
bun --no-env-file "$TF/scripts/cloudflare.ts" deploy --root postgres --release "$R" --instance-dir ~/.azad/instances/default
```

`--miniapps-domain none` deploys without Mini Apps.

`setup` copies the credential file to `~/.azad/instances/default/.env` with the settings it
derives; edit that copy from then on. For Cloud SQL, use
`--database-provider cloudsql --project-id <project>` and `--root cloudsql`.

## After the install

- **Sign in** at `https://<hostname>`.
- **GitHub:** each person connects GitHub once from Azad's repository picker,
  which links the installation `azad` made. Install the App on any
  other organization your projects use.
- **Desktop and mobile apps:** turn on **Native API** in Clerk's dashboard, on
  the Native applications page. `azad` prints the exact link. Clerk has no
  API for this setting.
- **Official Mini Apps:** with Mini Apps on, every deploy lists PartyTask,
  Release Queue and Remote iOS Simulator in your marketplace as Azad's apps.
  If one fails, the deploy names the command that retries only that step.
- **Keep an offline copy of the keys:** `azad --backup-keys ~/azad-keys`
  writes them to a new folder. The deploy keeps them in your account's
  Secrets Store, which only the installation's own Worker can read back.

Terraform's state and the app's receipts live in your account's R2 bucket
`<resource prefix>-install`, and the keys in its Secrets Store. The instance
directory holds the rest; the release in `~/.azad/cache/releases/` only
provides code:

- `.env`: your answers, the private settings the deploy reads, and the
  release it deploys (`AZAD_CLI_RELEASE_VERSION`, `AZAD_CLI_RELEASE_SHA`).
- The Cloudflare token you pasted and the scoped tokens it created, with their
  own Terraform state in `cloudflare-bootstrap/`.
- `terraform/postgres/` (`terraform/cloudsql/` for Cloud SQL): the
  `terraform.tfvars.json` setup wrote, the state bucket's configuration,
  saved plans, Terraform's working data (`.terraform/`) and the deploy's cache
  of the keys and receipt (`installer-state/`).

## Change settings

Rerun `azad` with the same instance. Once a deployment has started it asks
**Resume the deployment with saved settings** (the default) or **Change
settings, then deploy**. Changing walks the questions
again with your saved answers filled in; Enter keeps each one. A changed
setting is saved to the instance directory's `.env`, which the deploy reads,
and the deploy shows the Terraform plan (a redeploy of the API and web app)
before it asks to apply. It deploys the release the installation runs now:
the newer of the one the instance recorded and the one the installation's
receipt names, so a console update or `azad update` is never rolled back.

Settings the first deploy fixed are shown, not asked: the target, the database
and its connection, the hostname and Cloudflare account, where files are
stored, the Mini Apps domain and managed project source, which the scoped
tokens were created for. Changing one would replace the installation or move its data, so
it means destroying the installation and [starting over](#start-over).
`azad --non-interactive` never changes a deployed instance: it reports a
fixed setting as `immutable` and any other change as `bound_instance`.

## Update

```sh
azad update            # the release azad.pro runs now
azad update --status   # what runs, and what is newer
```

`azad update` installs a published release without Terraform (see
[Updates](reference.md#updates)). When a release needs new infrastructure it
stops before changing anything; then run

```sh
azad --version <x.y.z>
```

which downloads and verifies that release, records it in the Terraform
variables (`refresh`), shows the plan, applies it after your yes and deploys
the release. A release older than the one the installation runs is refused.

To update `azad` itself, rerun its install command. A newer `azad` may pin a
newer azad-terraform, which its next deploy downloads (`azad --doctor`
prints the new `$TF`).

## Remove everything

```sh
bun --no-env-file "$TF/scripts/cloudflare.ts" destroy --root postgres --release "$R" --instance-dir ~/.azad/instances/default
```

Use the release the installation runs (`azad --doctor` names it, and
`azad --reset` prints this command with its directory).

Before Terraform deletes its own resources, an uninstall step removes what the
Azad installer step created, in this order:

1. The API Worker, with its custom domain and queue consumer.
2. This installation's Artifacts repositories.
3. Its event subscriptions.
4. The Pages project and domain.
5. The Hyperdrive.
6. The contents of this installation's R2 buckets, which also hold the Mini
   Apps' releases and database snapshots.

Nothing else in a shared account is touched.

## Start over

To set up a new installation from scratch with the same instance directory,
first [remove everything](#remove-everything), then:

```sh
azad --reset
```

Reset reads the installation's Terraform state (in its bucket, through
azad-terraform) and the scoped tokens' state. While either still records resources it deletes
nothing, lists them and prints the commands that remove them: the destroy
above (after an `init`), with this `azad`'s azad-terraform and the release
the installation runs (downloaded first if it is not cached), and, after it,
because the destroy uses them, the scoped Cloudflare tokens:

```sh
read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN   # paste a token that can edit API tokens
terraform -chdir=$HOME/.azad/instances/default/cloudflare-bootstrap/terraform destroy
```

Once nothing is recorded, it lists what it deletes and asks (default No): the
answers and private settings, the pasted token, the scoped tokens' records and
empty state, and, in `terraform/<root>/`, the `terraform.tfvars.json`, saved
plans and `installer-state/`. They hold credentials, so they are deleted rather than
backed up. The Terraform state, the keys in your Secrets Store and your cloud
accounts are not touched; delete the Clerk
application and GitHub App `azad` created in their dashboards if you no
longer need them. A new Clerk production instance for the same hostname needs
the old application deleted first. Without a terminal, add `--yes`; `--json`
prints one status (`reset_complete`, `needs_confirmation`, `live_resources`,
`state_unverified` or `nothing_to_reset`).

Destroy keeps:

- your database and its data. A Cloud SQL instance that Terraform created stays
  while its deletion protection is on, which is the default;
- your own bucket;
- your Clerk application and GitHub App. The Clerk application holds the user
  accounts that the kept database refers to; a reinstall can adopt it.

Run the same apply again to reinstall. Mini Apps and managed repositories
recorded in a kept database do not come back with a reinstall.
