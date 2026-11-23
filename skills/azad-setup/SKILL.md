---
name: azad-setup
description: Install, resume, update or troubleshoot a self-hosted Azad instance, on Cloudflare (Workers, Pages, Hyperdrive) or on the person's own Google Cloud (GKE Autopilot, Cloud SQL, GCS), by driving the azad CLI. Use when someone asks to set up, deploy, redeploy, upgrade or fix their own Azad, connect its agent machine, or turn on its meetings, Mini Apps or media understanding.
---

# Set up a self-hosted Azad

You run the setup for the person: prepare their machine, agree the answers,
start each step, review every plan with them and finish the work after the
deploy. The `azad` CLI (https://github.com/kodu-ai/azad-cli) and the
azad-terraform drivers it runs (`scripts/gcp.ts`, `scripts/cloudflare.ts` and
`scripts/bootstrap.ts` of https://github.com/kodu-ai/azad-terraform) do the
work. Do not recreate their Terraform, provider calls, migrations, DNS
records, token scopes or resume logic, and do not hand-write cloud resources
beside them.

**No access to Azad's source code is needed.** `azad` downloads the signed
public Azad release from api.azad.pro, checks its signature against the key
it pins and every file against the signed manifest, and deploys that. Never
ask the person for access to a private repository, and never clone one.

The detailed guides are `docs/install-google-cloud.md`,
`docs/install-cloudflare.md` and `docs/reference.md` in the azad-cli
repository, and azad-terraform's README for the Terraform settings. Read the
relevant one when a step here is not enough.

## Rules that always apply

- **Secrets stay out of chat, arguments and logs.** Never ask for, read, print,
  paste or commit a token, key, password, connection string or webhook secret.
  The person types them into azad's masked prompts or into a private
  file they own (mode 0600); you pass only file paths. Never open, `cat`,
  `source` or upload: the instance directory's `.env`,
  `.cloudflare-bootstrap-credential/` and `.realtimekit.json`; under its
  `terraform/<root>/`, `terraform.tfstate*` (an azad 0.0.x state),
  `celld-install/` (except its `install.log`) and `installer-state/`;
  `show -json` of a plan; or `output -raw agent_machine_private_key`. If a
  secret shows up in
  output anyway, do not repeat it, and tell the person to rotate it.
- **Review a plan before every apply.** Show the person what will be created,
  changed, replaced or destroyed, and what costs money. Wait for an explicit yes.
  Never pass `-auto-approve` yourself.
- **Preserve state.** Never delete or edit the instance directory, Terraform
  state, `terraform.tfvars.json`, `celld-install/`, `installer-state/`,
  bootstrap receipts, the release cache (`~/.azad/cache/releases/`) or keys
  by hand. Rerun the same command with the same instance directory; every
  step resumes. The only way to start over is
  `azad --reset` (section 7), and only when the person asks to start over.
- **Destructive commands only on request.** `destroy`, `-replace`, deleting the
  Clerk or GitHub App, revoking tokens: only when the person asks, after the plan.
  `--take-over` and the drivers' `force-unlock` only after the person confirms
  the other run has stopped.
- **The person drives interactive prompts.** Do not feed the wizard keystrokes
  or run it through a pseudo-terminal. It needs their terminal and browser.
- **Report what is true.** Distinguish configured, planned, applied, serving
  (`/health`), signed in, and each integration checked.

## 1. Establish the situation

Ask only what you do not know yet:

1. New installation, resuming one, or updating/fixing a running one? For an
   existing one, ask for its instance directory (default
   `~/.azad/instances/default`).
2. **Target.** Help them choose:

   | | Cloudflare | Google Cloud |
   | --- | --- | --- |
   | Runs on | Workers, Durable Objects, Pages, Hyperdrive, R2, Queues in their Cloudflare account | GKE Autopilot (celld fleets), Cloud SQL, a GCS bucket, Forgejo and a regional load balancer in their Google Cloud project; Cloudflare serves DNS only |
   | They bring | Workers Paid plan (and R2 if files stay in R2); a database: Neon, any PostgreSQL 17+, or Cloud SQL that Terraform creates; a domain for Mini Apps | A billed project where they are Owner, or Editor plus Project IAM Admin, Kubernetes Engine Admin and Secret Manager Secret Accessor |
   | Mini Apps | On a domain of their own, asked by the wizard | At `*.apps.<hostname>`, nothing to ask |
   | Project source | Cloudflare Artifacts | Forgejo in the cluster |
   | Agent machine | Connect exe.dev or their own server per project | Optional Terraform VM, sized in the wizard |
   | First deploy | Minutes | About 30 minutes |

   Both need a domain whose zone is on their Cloudflare account, a Clerk
   account, and a GitHub organization (agents create repositories only under an
   organization).
3. **Hostname**, such as `azad.example.com`. The API is `api.<hostname>`.
4. **Mini Apps domain** (Cloudflare only). Recommended: a domain of their own,
   apart from Azad, in the same Cloudflare account. Either a separate zone
   (`example-apps.com`) or a subdomain inside one of the account's zones
   (`apps.example.com`). A subdomain needs Cloudflare's Advanced Certificate
   Manager turned on for its zone, because Terraform orders a wildcard
   certificate there; a separate zone does not. It must not be the hostname,
   sit under it or contain it. They can also choose **Not now**; the choice
   is fixed once a deploy has started.
5. **Instance.** `azad` keeps everything the installation owns, its answers,
   private settings and Terraform state, in `~/.azad/instances/default`
   (private, kept for every later run and backed up). For a second
   installation on the same machine pick a name, add `--instance NAME` to
   every `azad` command below and use `~/.azad/instances/NAME` wherever a path
   names the instance.

**What the person does by hand** (tell them up front; you cannot do these):

- **Cloudflare:** have the account (Workers Paid plan on Cloudflare), the
  hostname's zone and, on Cloudflare, the Mini Apps domain in it (plus
  Advanced Certificate Manager for a subdomain); create the one setup token
  on the form the wizard opens and paste it.
- **Clerk:** sign in through the Clerk CLI in the browser; turn on **Native
  API** on the Native applications page the wizard opens (no API exists for
  it) if people use the desktop or mobile apps.
- **Google sign-in** (optional): create the Web application OAuth client on
  the page the wizard opens, click **Download JSON**, then **Publish app**.
- **GitHub:** click **Create GitHub App** on the pre-filled page, and after
  the deploy **Install** on the App's install page.
- Type every secret into azad's masked prompts, and say yes to each plan.

## 2. Prepare the machine

1. **The azad CLI.** Install the latest release from GitHub (Linux glibc and
   macOS, x64 or arm64) into `~/.local/bin`, verified against the release's
   `SHA256SUMS`:

   ```sh
   curl -fsSL https://github.com/kodu-ai/azad-cli/releases/latest/download/install.sh | sh
   AZAD=~/.local/bin/azad
   "$AZAD" --version && "$AZAD" --doctor
   ```

   `AZAD_VERSION=0.5.0` (before `sh`) pins a release; `AZAD_INSTALL_DIR`
   chooses another directory. The deploy needs a Linux shell: on Windows, do
   everything in WSL (Ubuntu). Tell the person the full path; they run it in
   their own terminal.
2. **The Azad release.** Nothing to prepare. A new install takes the latest
   release (`--version x.y.z` picks another, 4.497.0 or newer); an existing
   one keeps the release it runs. The deploy downloads it, verifies it and
   keeps it in `~/.azad/cache/releases/<version>/`. The driver commands below
   call that directory `$R`; `--doctor` names the release an instance
   records:

   ```sh
   R=~/.azad/cache/releases/<Azad version>
   ```
3. **azad-terraform.** Each `azad` release pins one azad-terraform release.
   The first deploy downloads it from GitHub, checks its SHA-256 and keeps it
   in `~/.azad/cache/azad-terraform/<version>/`; `--doctor` prints the version
   and the directory. The driver commands below call that directory `$TF`:

   ```sh
   TF=~/.azad/cache/azad-terraform/<version from --doctor>
   ```

   For development only, `--terraform-dir PATH` (or `AZAD_TERRAFORM_DIR`)
   runs a local azad-terraform checkout instead, and `--source CHECKOUT`
   builds a local release from an Azad app checkout; neither is needed to
   install Azad.
4. **Tools.** `--doctor` lists each missing or too-old tool with its minimum
   version and official download page: Bun 1.4.4+, Terraform 1.13.4+, curl
   and tar, Node.js 20+ with npm (the wizard runs the Clerk CLI through npx),
   and the gcloud CLI for Google Cloud and Cloud SQL. No Git is needed. The
   wizard checks the same right after its first question and stops until
   they are installed.
5. **Google credentials** (Google Cloud target or Cloud SQL). The person runs,
   in their terminal, `gcloud auth login --update-adc` (or
   `gcloud auth application-default login`) and allows every access requested.
   Check without printing the token:
   `gcloud auth application-default print-access-token >/dev/null && echo ok`.

## 3. Agree the answers

Walk the wizard's questions with the person before they run it, in this order,
and write down the non-secret answers:

1. **Where should Azad run?** Cloudflare, or Your Google Cloud.
2. Cloudflare only, **database**: Neon (they paste the connection string; a
   pooled URL is switched to the direct endpoint, TLS is verified), Google Cloud
   SQL (project, region, and this machine's public IPv4 as a /32, prefilled), or
   other PostgreSQL 17+ (direct URL with `sslmode=require` or `verify-full`;
   leave room for Hyperdrive's 20 connections).
3. Google Cloud only:
   - **project** (picked from their gcloud account) and **region** (default
     `us-central1`);
   - **sizing**: Production (regular nodes, database backups, deletion
     protection) or Evaluation (Spot nodes, smallest database, no backups; its
     destroy deletes all data);
   - **agent machine**: 4 vCPU · 16 GB up to 32 vCPU · 128 GB (default
     8 vCPU · 16 GB), or None.
4. **Hostname.**
5. **One Cloudflare token**: the wizard opens Cloudflare's token form already
   filled in ("Azad setup (host)", permission to create API tokens). If the
   form comes up empty, they use the **Create additional tokens** template.
   They paste the token into the masked prompt. The wizard finds the account
   from the hostname's zone; deployment then creates narrowly scoped tokens
   from it.
6. Cloudflare only, **Where should Mini Apps run?** **On their own domain**
   (the default; they type the Mini Apps domain from section 1, and the
   wizard checks that a zone of the account holds it, asking again if not)
   or **Not now**.
7. **Clerk**: they sign in through the official Clerk CLI in the browser. The
   wizard creates (or reuses) the application and production instance, turns on
   email-code sign-in, adds the official clients' redirects and origins, creates
   the user-sync webhook, and sets Clerk Protect to record sign-ups without
   blocking them (its device check otherwise blocks ordinary browsers on new
   instances).
8. **GitHub App**: the owning organization, then **Create GitHub App** on the
   pre-filled page. GitHub returns the credentials straight to azad.
   The App is installed after the deploy, not now.
9. **Would you like to enable Sign in with Google?** (opt-in, default no;
   asked only when the wizard created the Clerk app). Google has no API for this:
   on the Google Cloud page the wizard opens they create an OAuth client of type
   **Web application**, paste Clerk's redirect URI from the clipboard, click
   **Download JSON** (the wizard reads it from Downloads, deletes it, checks it
   with Google and configures Clerk; pasting the ID and secret also works), then
   click **Publish app** on the Audience page. While the app is in Testing only
   listed test users can sign in. Set up the consent screen first if asked.
10. **Desktop or mobile apps?** If yes, they turn on **Native API** on Clerk's
   Native applications page, which the wizard opens. Clerk has no API for it.
11. **Configure optional settings?** (default no). With no, every optional
    setting keeps its default or saved answer:
    - Mini Apps as answered above (Cloudflare), or on (Google Cloud);
    - meetings on (Cloudflare RealtimeKit, both targets): deployment creates
      the app `azad-<first label of the hostname>` and a token limited to
      Realtime;
    - Cloudflare only, managed project source on Cloudflare Artifacts on (keep
      it on; projects cannot be created without it);
    - file storage in this installation's own bucket (R2 or GCS);
    - Google Cloud only, daily disk backups.

    With yes, the wizard also asks about those, plus their own R2, GCS or
    S3-compatible bucket, backups hourly/weekly/off, email (Resend), an
    existing RealtimeKit app, meeting titles (OpenAI), GIFs, branding, Sentry
    and runtime settings. Only say yes when the person wants to change one.

## 4. Run the setup wizard

The person runs, in their own terminal:

```sh
<full path of azad>
```

Answers are saved after each prompt; Ctrl+C and the same command resume.
Once the questions are answered the same run deploys (section 5).
Provider pages open after a three-second countdown. Saved valid answers are
kept with Enter. Meanwhile you can check progress without side effects:

```sh
"$AZAD" --status
```

It returns `configuration_ready`, or `needs_input` with field names (never
values) to explain.

## 5. Review the plan, then deploy

The deploy first shows a token preview and asks to create the scoped
Cloudflare tokens (and the RealtimeKit app). That creates credentials only.
It then downloads and verifies the Azad release ("Downloading Azad x.y.z …,
verified with its signed manifest") and prints which release it deploys.

**Cloudflare.** The wizard runs `cloudflare.ts setup`, prints the Terraform
plan and asks "Apply this plan to your Cloudflare account?" (with Cloud SQL,
"… and Google Cloud project <project>?"; default No). Review it together; you can print it again with
`bun --no-env-file "$TF/scripts/cloudflare.ts" show --root <root> --instance-dir ~/.azad/instances/default -no-color terraform.tfplan`,
where `<root>` is `postgres` (Neon or other PostgreSQL) or `cloudsql` (Cloud
SQL). The person answers Yes only after that; the wizard applies exactly that
saved plan.

**Google Cloud.** The wizard writes the variables, initializes Terraform, shows
the plan and asks to apply it (default No); a Yes applies exactly that saved
plan. A first install has two plans, because everything else is planned
against the cluster: plan 1 of 2 ("Apply plan 1 of 2 (the cluster and Clerk's
DNS records) …?") covers only the GKE cluster and Clerk's DNS records; once
they exist the wizard shows plan 2 of 2 (Cloud SQL, the bucket, Forgejo, the
regional load balancer, certificates, `A` records, the agent machine, disk
backups, the app) and asks again. Review each with the person; you can print
the saved one again with
`bun --no-env-file "$TF/scripts/gcp.ts" show --instance-dir ~/.azad/instances/default -no-color terraform.tfplan`.
A No applies nothing, and the next run of the wizard plans the same step
again. The apply waits (up to `ready_timeout_minutes`, 45 by default) until the
load balancer serves every host with a valid certificate, and only then writes
the `A` records. Existing DNS records are never changed.

**Both.** During the apply the wizard asks Clerk to recheck its DNS every two
minutes, then waits until sign-in works and prints the URL. With Mini Apps on,
every deploy also publishes Azad's official Mini Apps (PartyTask, Release Queue,
Remote iOS Simulator) to the marketplace, one line per app. The
Google Cloud deploy log is
`~/.azad/instances/default/terraform/gcp-celld/celld-install/install.log`.

Each installation's files are in its own instance directory; installations
on one machine share only the release cache. Never run two deploys of the
same installation at once.

## 6. Finish after the deploy

1. **Install the GitHub App.** The wizard opens its install page: install it on
   the organization (all repositories, or those Azad may use); the wizard
   confirms. If skipped, use `https://github.com/apps/<app slug>/installations/new`.
   Each person later connects GitHub once from Azad's repository picker; install
   the App on any other organization their projects use.
2. **Check it serves.** `curl -fsS https://api.<hostname>/health` reports the
   release's commit as `revision`; then the person signs in at
   `https://<hostname>`.
3. **Clerk.** Native API for the apps (the final message links it). Protect is
   recording without blocking: after reviewing its decisions in Clerk's
   dashboard, the person may turn enforcement on.
4. **Agent machine** (Google Cloud, if one was chosen). You may run
   `bun --no-env-file "$TF/scripts/gcp.ts" output --instance-dir ~/.azad/instances/default agent_machine`
   for its host, port, user and size. The person gets the key themselves, in
   their terminal (on macOS, `| pbcopy` puts it on the clipboard):
   `bun --no-env-file "$TF/scripts/gcp.ts" output --instance-dir ~/.azad/instances/default -raw agent_machine_private_key`.
   In Azad's project setup they choose **A server over SSH** and enter host,
   port, user and that key. Connect it to one project at a time. The VM has no
   public address; only the cluster reaches its SSH. Terraform sets the API's
   `SSH_ALLOWED_PRIVATE_CIDRS` to the cluster's subnet; for further private
   networks (a peered VPC) add CIDRs to `ssh_allowed_private_cidrs` in
   `~/.azad/instances/default/terraform/gcp-celld/terraform.tfvars.json`, then plan and apply.
   Other installations can set `SSH_ALLOWED_PRIVATE_CIDRS` (comma-separated
   ranges inside 10/8, 172.16/12, 192.168/16, 100.64/10 or fc00::/7) in their
   private settings file and redeploy, for networks the API can reach.
5. **Models and media understanding.** In a project: Settings → **Model
   Gateway** → add an OpenRouter API key (typed into Azad, not chat). Turn on
   **Media understanding** in the Add API key dialog, or later from the key's
   **⋯** menu. Exactly one key in the project should have it on. Without it,
   meeting transcription, voice memos and speech fail with "Media understanding
   is disabled". `AZAD_HOSTED_MEDIA_PROJECT_ID` (optional setting) makes one
   project's key pay for every project.
6. **Meetings.** Start a test meeting. If meetings were skipped, add them to the
   running installation, then redeploy (section 7):

   ```sh
   "$AZAD" --provision-meetings --web-host <hostname> \
     --bootstrap-file ~/.azad/instances/default/.cloudflare-bootstrap-credential/.env \
     --settings-file ~/.azad/instances/default/.env
   ```

   The deploy reads that `.env` on both targets. It prints names and ids only,
   and a rerun changes nothing already in place.
7. **Official Mini Apps** (with Mini Apps on). PartyTask and Release Queue
   need an agent machine; Remote iOS Simulator needs a paired Apple Silicon
   Mac. If an app failed to publish, run exactly the retry command the deploy
   printed.
8. **Native push** for the mobile apps needs a short-lived azad.pro session
   token that only the person handles, in their terminal; follow "Native push"
   in the target's guide. Never ask for the token. Web push works without it.
9. **Offline key copy.** Terraform's state and the keys live in the
   installation's own cloud (its bucket and secret store). Ask the person to
   run `azad --backup-keys <new folder>` in their terminal and keep that
   folder offline; never open it yourself.

## 7. Change settings, update, redeploy or start over

**Change a setting** (Sign in with Google, the desktop apps, meetings, email,
branding, error reporting and other optional settings): the person reruns the
wizard command from section 4 and picks **Change settings, then deploy**
instead of the default **Resume the deployment with saved settings**. Saved
answers are prefilled. Settings the first deploy fixed are printed as
`(fixed)` lines and not asked: the target, database and connection, Google
Cloud project and region, hostname, Cloudflare account, storage, Google Cloud
sizing, agent machine and disk backups, and on Cloudflare the Mini Apps
domain and managed source. Changing one of those replaces the installation;
say so, and offer a destroy and a start over only if the person wants it.
Review the plan as in section 5 before they confirm. Automation never changes
a deployed instance (`bound_instance`, or `immutable` for a fixed setting).

Every re-deploy, change of settings, `--backup-keys` and `--reset` uses the
release the installation runs now: the newer of the one the instance recorded
and the one the installation's receipt names (console updates and
`azad update` move it forward). An older release is never deployed over a
newer one.

**Update to a new release** with `azad update` (the release azad.pro runs;
`--version x.y.z` for another, `--status` to see what runs and what is newer).
It verifies the signed release and runs the updater it ships; it never runs
Terraform. A maintenance release needs `--accept-maintenance`: ask the person
before accepting downtime. If it says the release needs new infrastructure,
update azad if it says so, then have the person run
`<full path of azad> --version x.y.z`: it records the release in the
Terraform variables, shows the plan (review it as in section 5), applies
after their yes and deploys the release.

**Update the CLI** by rerunning the install command from section 2. A newer
`azad` may pin a newer azad-terraform; its next deploy downloads it, and
`--doctor` prints the new `$TF`.

**Driver commands.** With `$R` the release the installation runs and `<root>`
as in section 5, the drivers take `--release "$R"` on every command that
deploys or holds the operation record (`setup`, `refresh`, `init`, `plan`,
`apply`, `deploy`, `destroy`, `backup-keys`). Read-only ones (`show`,
`output`, `state list`, `phase`) take none. To redeploy the same release (for
example after the person changed a private setting), rerun the wizard and
pick Resume, or run `deploy`:

```sh
bun --no-env-file "$TF/scripts/gcp.ts" deploy --release "$R" --instance-dir ~/.azad/instances/default
bun --no-env-file "$TF/scripts/cloudflare.ts" deploy --root <root> --release "$R" --instance-dir ~/.azad/instances/default
```

Plan names are files in `~/.azad/instances/default/terraform/<root name>/`
(`gcp-celld`, `postgres` or `cloudsql`). Non-secret infrastructure settings
(`disk_backups`, `agent_machine`, `deletion_protection`,
`ssh_allowed_private_cidrs`, `proxy_only_subnet_range`) live in the instance's
`terraform/<root name>/terraform.tfvars.json`: edit, plan, review, apply. A
Google Cloud installation made before the regional load balancer moves with
the three targeted plan/apply steps in `docs/install-google-cloud.md`, in
order, each reviewed.

To remove an installation, only when asked: review
`bun --no-env-file "$TF/scripts/gcp.ts" plan -destroy --release "$R" --instance-dir ~/.azad/instances/default`
(or `"$TF/scripts/cloudflare.ts" plan --root <root> --release "$R" --instance-dir ~/.azad/instances/default -destroy`)
first, then `destroy` with the same arguments. Production Google Cloud
installs keep deletion protection until `deletion_protection = false` is
applied.

**Start over**, only when the person asks for it: `azad --reset` deletes the
instance directory's answers and credentials (and, in `terraform/<root name>/`,
the variables, saved plans and deploy state; the Terraform state stays) so the
next wizard run starts fresh. If anything was deployed, or tokens were
created, the installation must be destroyed first (above), then the scoped
Cloudflare tokens revoked through their own state, which the person does in
their terminal because it needs a token that can edit API tokens:
`read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN`, then
`terraform -chdir=$HOME/.azad/instances/default/cloudflare-bootstrap/terraform destroy`.
Then run, or have the person run:

```sh
"$AZAD" --reset --json
```

It returns `live_resources` or `state_unverified` (exit 1, with the exact
`commands` still needed, which name the release directory) while any
Terraform state records resources or cannot be read, and deletes nothing.
Otherwise it returns `needs_confirmation` with the files it would delete;
show them to the person and add `--yes` only after their explicit yes. Never
delete those files or Terraform state by hand instead. The Clerk application
and GitHub App stay until the person deletes them; a new Clerk production
instance for the same hostname needs the old one deleted first.

## 8. Troubleshooting

- `missing_prerequisites`, or the wizard stopped with "These tools are missing
  or too old": run `"$AZAD" --doctor` and have the person install what it lists
  from the pages it names; on Google Cloud also redo the application-default
  login.
- "belong to a different installation": the instance directory holds another
  installation's variables. Never replace state or point the instance at
  another installation's files.
- "The release manifest signature is invalid", "… does not match its signed
  manifest" or "… does not trust": the download is refused and nothing was
  deployed. Never bypass the check. Retry later; if it persists, the person
  reports it to the Azad maintainers (or updates azad, for a new key).
- "Could not reach https://api.azad.pro/api/v3/releases/…": the machine is
  offline or behind a proxy. Fix the connection and rerun the same command.
- "… has no installer … Installs start with Azad 4.497.0": the chosen release
  is too old for this azad. Choose that release or a newer one.
- "This installation runs Azad x, which is newer than y": a `--version` or
  local build older than what the installation runs. Use x or later.
- "Could not download azad-terraform …" (offline, a proxy, or a release that
  is not published) or "… does not match its published SHA-256 checksum":
  nothing was installed. Fix the connection and rerun the same command; never
  bypass the checksum. A person working offline can clone azad-terraform at
  the pinned tag and pass `--terraform-dir`.
- "… is not initialized for its own state yet": run the printed `init` (needed
  once per instance directory, and again after moving it).
- "… cannot change after a deploy has started": a fixed setting (section 7).
  Keep the saved value, or destroy and start over if the person asks.
- A step failed: azad names the phase and keeps everything. Fix the
  cause and rerun the same command. Read the deploy log for the error; do not
  ask the person to paste raw logs into chat.
- Google Cloud apply stops waiting for the load balancer: the `A` records are
  untouched. Check `gcloud certificate-manager certificates describe <name>-tls
  --location=<region>` (issued once the validation CNAMEs resolve) and
  `kubectl -n azad describe gateway azad-regional`, then plan and apply again.
- The VPC already has a proxy-only subnet in the region (a second installation
  in the same project and region): set `proxy_only_subnet_range = null` to share
  it, or another range if the default `10.127.0.0/23` overlaps their networks.
  Destroy the installation that created the subnet last.
- Sign-in fails right after the install: Clerk verifies DNS and issues its
  certificate on its own schedule (allow about 30 minutes). **Verify** on
  Clerk's Domains page makes it check at once.
- Sign-up blocked by Clerk Protect ("action_blocked", a device check): Protect
  is enforcing. The wizard's Clerk step turns enforcement off for the app it
  sets up; for keys entered by hand, the person turns Protect's rules off in
  Clerk's dashboard.
- Desktop or mobile app cannot sign in: Native API is off in Clerk.
- GitHub webhook deliveries failed with 401: the App was installed before the
  API had its secret. Redeliver them from the App's Advanced tab; connecting
  GitHub from Azad also links the installation. If azad says to set the
  App's webhook secret, the person copies `GITHUB_WEBHOOK_SECRET` from the file
  it names into the App's settings themselves.
- Conflicting DNS record: setup never changes existing records. The person
  reviews the named record, then you rerun.
- Projects cannot be created on Cloudflare: managed source (Cloudflare
  Artifacts) is off. Choose it during setup; it is fixed after the first
  deploy, so adding it later means starting over.
- Mini Apps fail on a subdomain of the hostname's zone: Advanced Certificate
  Manager is off for that zone, so its wildcard certificate is not issued.
  The person turns it on in Cloudflare, then rerun the deploy.
- Image uploads have no blurred preview on Google Cloud: expected there; the API
  logs `encoder_unbound`.
- Destroy failed partway on Google Cloud: rerun
  `bun --no-env-file "$TF/scripts/gcp.ts" destroy --release "$R" --instance-dir ~/.azad/instances/default`;
  once the cluster is gone it removes what is left in state.

## Unattended alternative

For a person who already has Clerk production keys and a GitHub App, the same
`azad` runs without prompts. The Clerk, GitHub, Google and Cloudflare
account steps above are not automated in this mode, and Google sign-in is not
offered.

1. `"$AZAD" --schema` lists every field and choice, marks secrets and gives
   defaults: `providers.<database>` for Cloudflare, `googleCloud` for
   `choices.target = "gcp"`. It needs no credentials.
2. You write a JSON file with only non-secret `fields` and `choices`. The
   person creates a private 0600 dotenv with the secret fields, and a separate
   0600 file with only `CLOUDFLARE_BOOTSTRAP_API_TOKEN`, whose path goes in
   `AZAD_CLI_CLOUDFLARE_BOOTSTRAP_FILE` with `choices.cloudflareAuth =
   "bootstrap"`. `GITHUB_APP_PRIVATE_KEY` holds the PEM itself. On
   Cloudflare, `fields.AZAD_CLI_MINIAPPS_DOMAIN` is the Mini Apps domain, or
   `choices.miniApps = "none"` leaves Mini Apps off.
3. Check, save, create tokens and plan:

   ```sh
   "$AZAD" --status --config setup.json --credentials /private/azad.env
   "$AZAD" --non-interactive --config setup.json --credentials /private/azad.env
   "$AZAD" --non-interactive --create-tokens
   "$AZAD" --non-interactive --plan
   ```

   Each prints one JSON status. `--plan` leaves `terraform.tfplan` in
   `~/.azad/instances/default/terraform/<root name>/` to review with the driver's `show` as in
   section 5 (on a first Google Cloud install, the first of its two plans).
4. `--apply` plans again and applies each plan it made in that run without
   pausing (on a first Google Cloud install, both plans); it never applies a
   plan saved by an earlier run. Run it only right after the reviewed plan,
   with the person's yes. Then do section 6; this mode does not open the GitHub install
   page.

## Report the outcome

Say which of these hold: configuration saved, tokens created, planned,
applied, `/health` serving the expected revision, signed in, GitHub App
installed, agent machine connected, media understanding on, meetings tested,
official Mini Apps listed, backups made. Name anything left for the person.
