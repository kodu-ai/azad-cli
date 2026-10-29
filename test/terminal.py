"""Exercise the compiled wizard in a real terminal, without network access.

Every provider is a local fake. PATH shims stand in for Node.js and npx (only
their versions; npx cannot start the Clerk CLI unless a scenario adds one),
the Clerk CLI (npx), gcloud, the desktop browser (open/xdg-open, which also
plays GitHub's App manifest redirect) and the clipboard. One loopback HTTP server answers the
Cloudflare, Clerk and GitHub APIs through the CLI's documented API base
overrides (CLOUDFLARE_API_BASE_URL, CLERK_API_URL, GITHUB_API_URL). A refused
HTTPS proxy keeps any other request off the network. All credentials are inert
fixtures.
"""

import base64
import io
import json
import os
import pathlib
import shutil
import sys
import tempfile
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pexpect
import subprocess

APP_PEM = subprocess.run(["openssl", "genrsa", "2048"], capture_output=True, text=True, check=True).stdout
APP_PEM_SECRET = APP_PEM.splitlines()[1]

ACCOUNT = "a" * 32
LOOKUP_ID = "2" * 32
ROOT_TOKEN = "fixture-root-secret"
WRONG_TOKEN = "fixture-wrong-secret"
LOOKUP_TOKEN = "fixture-lookup-secret"
CLERK_SECRET = "sk_live_fixture-clerk-secret"
DB_SECRET = "fixture-db-secret"
SECRETS = [
    ROOT_TOKEN,
    WRONG_TOKEN,
    LOOKUP_TOKEN,
    CLERK_SECRET,
    "fixture-manual-clerk-secret",
    "fixture-hook-secret",
    "fixture-client-secret",
    APP_PEM_SECRET,
    "fixture-github-hook-secret",
    "GOCSPX-fixture-google",
]
WEB = "board.example.com"
WEBHOOK = "https://api.board.example.com/api/clerk/webhooks"
NEON_PAGE = "https://console.neon.tech"
# Cloudflare's token form, pre-filled with User > API Tokens > Edit and a name.
TOKENS_PAGE = ("https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys="
               + urllib.parse.quote(json.dumps([{"key": "api_tokens", "type": "edit"}], separators=(",", ":")), safe="")
               + "&accountId=%2A&zoneId=all&name=" + urllib.parse.quote("Azad setup (board.example.com)", safe="()"))
PUBLISHABLE = "pk_live_" + base64.b64encode(b"clerk.board.example.com$").decode()
GOOGLE_ID = "123-fixture.apps.googleusercontent.com"
GOOGLE_SECRET = "GOCSPX-fixture-google"
GOOGLE_CALLBACK = "https://clerk.board.example.com/v1/oauth_callback"

root = pathlib.Path(tempfile.mkdtemp(prefix="azad-cli-terminal-"))
binary = str(pathlib.Path(sys.argv[1]).resolve())
browser_log = root / "browser.log"
clipboard_log = root / "clipboard.log"
github_log = root / "github.log"
api_requests = []
google_checks = []
children = []


class Api(BaseHTTPRequestHandler):
    """Cloudflare (/client/v4), Clerk (/v1/instance), GitHub (/app-manifests) and Google (/token) fakes."""

    def log_message(self, *args):
        pass

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def route(self, method):
        url = urllib.parse.urlsplit(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        auth = self.headers.get("Authorization", "")
        api_requests.append((method, url.path, auth))
        if url.path == "/token" and method == "POST":
            # Google's token endpoint: an impossible code with the right client is invalid_grant.
            form = urllib.parse.parse_qs(raw.decode())
            google_checks.append(form["client_id"][0])
            if form.get("client_secret") == [GOOGLE_SECRET]:
                return self.reply(400, {"error": "invalid_grant", "error_description": "Malformed auth code."})
            return self.reply(401, {"error": "invalid_client", "error_description": "The provided client secret is invalid."})
        body = json.loads(raw) if raw else {}
        refused = {"success": False, "errors": [{"code": 1000, "message": "Invalid API Token"}]}
        if url.path == "/client/v4/user/tokens/permission_groups":
            if auth != "Bearer " + ROOT_TOKEN:
                return self.reply(401, refused)
            return self.reply(200, {"success": True, "result": [
                {"id": "1" * 32, "name": "Zone Read", "scopes": ["com.cloudflare.api.account.zone"]}]})
        if url.path == "/client/v4/user/tokens" and method == "POST" and auth == "Bearer " + ROOT_TOKEN:
            return self.reply(200, {"success": True, "result": {"id": LOOKUP_ID, "value": LOOKUP_TOKEN}})
        if url.path == "/client/v4/zones" and auth == "Bearer " + LOOKUP_TOKEN:
            name = urllib.parse.parse_qs(url.query)["name"][0]
            zones = [{"name": name, "status": "active", "account": {"id": ACCOUNT, "name": "Fixture Account"}}]
            return self.reply(200, {"success": True, "result": zones if name == "example.com" else []})
        if url.path == "/client/v4/user/tokens/" + LOOKUP_ID and method == "DELETE":
            return self.reply(200, {"success": True, "result": {"id": LOOKUP_ID}})
        if url.path == "/v1/instance/protect" and method == "PATCH" and auth == "Bearer " + CLERK_SECRET:
            return self.reply(200, {"object": "instance_protect", "rules_enabled": body.get("rules_enabled")})
        if url.path == "/v1/instance" and auth == "Bearer " + CLERK_SECRET:
            return self.reply(200, {"allowed_origins": body.get("allowed_origins", [])})
        if url.path == "/app-manifests/fixture-code/conversions" and method == "POST":
            return self.reply(201, {
                "id": 4242,
                "slug": "azad-board-example-com",
                "client_id": "Iv1.fixture",
                "client_secret": "fixture-client-secret",
                "webhook_secret": "fixture-github-hook-secret",
                "pem": APP_PEM,
            })
        if url.path == "/app" and auth.startswith("Bearer ey"):
            return self.reply(200, {"permissions": {"email_addresses": "read", "contents": "write"}})
        if url.path == "/app/installations" and auth.startswith("Bearer ey"):
            return self.reply(200, [{"account": {"login": "acme-inc"}}])
        return self.reply(403, refused)

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_PATCH(self):
        self.route("PATCH")

    def do_DELETE(self):
        self.route("DELETE")


def shim(directory, name, source):
    """A PATH command that runs `source` with this Python; paths are baked in."""
    directory.mkdir(parents=True, exist_ok=True)
    script = root / "tools" / f"{directory.name}-{name}.py"
    script.parent.mkdir(exist_ok=True)
    script.write_text(source)
    command = directory / name
    command.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{script}" "$@"\n')
    command.chmod(0o755)


BROWSER = f"""
import html, json, os, pathlib, re, sys, urllib.parse, urllib.request
url = sys.argv[1]
with open({str(browser_log)!r}, "a") as log:
    log.write(url + "\\n")
if url.startswith("https://console.cloud.google.com/auth/clients/create"):
    # Play Google: the person creates the client and clicks Download JSON.
    downloads = pathlib.Path(os.environ["HOME"]) / "Downloads"
    downloads.mkdir(exist_ok=True)
    client = {{"web": {{"client_id": {GOOGLE_ID!r}, "client_secret": {GOOGLE_SECRET!r},
                        "redirect_uris": [{GOOGLE_CALLBACK!r}]}}}}
    (downloads / "client_secret_{GOOGLE_ID}.json").write_text(json.dumps(client))
if re.fullmatch(r"http://127\\.0\\.0\\.1:\\d+/github", url):
    # Play GitHub: read the manifest form, then redirect back with a code.
    direct = urllib.request.build_opener(urllib.request.ProxyHandler({{}}))
    page = direct.open(url).read().decode()
    action = html.unescape(re.search(r'action="([^"]*)"', page).group(1))
    manifest = json.loads(html.unescape(re.search(r'name="manifest" value="([^"]*)"', page).group(1)))
    with open({str(github_log)!r}, "a") as log:
        log.write(json.dumps({{"action": action, "manifest": manifest}}) + "\\n")
    state = urllib.parse.parse_qs(urllib.parse.urlsplit(action).query)["state"][0]
    query = urllib.parse.urlencode({{"code": "fixture-code", "state": state}})
    direct.open(manifest["redirect_url"] + "?" + query).read()
"""
CLIPBOARD = f"""
import sys
with open({str(clipboard_log)!r}, "a") as log:
    log.write(sys.stdin.read() + "\\n")
"""
GCLOUD = """
import json, os, pathlib, sys
signed_in = pathlib.Path(os.environ["HOME"]) / ".fake-gcloud"
args = sys.argv[1:]
if args == ["--version"]:
    print("Google Cloud SDK 540.0.0")
    sys.exit(0)
if args == ["auth", "login", "--update-adc"]:
    signed_in.write_text("1")
    print("You are now logged in as fixture@example.com.")
    sys.exit(0)
if args[:2] == ["projects", "list"] and signed_in.exists():
    print(json.dumps([{"projectId": "customer-project", "name": "Customer"},
                      {"projectId": "other-project", "name": "Other"}]))
    sys.exit(0)
sys.exit(1)
"""
# The official Clerk CLI through `npx --yes clerk@4.0.0`, backed by a per-HOME
# Platform API: first login creates Clerk's default "My Application".
CLERK = f"""
import base64, json, os, pathlib, sys
args = sys.argv[1:]
if args == ["--version"]:
    print("10.9.0")
    sys.exit(0)
if args[:2] != ["--yes", "clerk@4.0.0"]:
    sys.exit(2)
args = args[2:]
state = pathlib.Path(os.environ["HOME"]) / ".fake-clerk.json"
data = json.loads(state.read_text()) if state.exists() else {{"login": False, "apps": [], "redirects": []}}
def done(body=None):
    state.write_text(json.dumps(data))
    if body is not None:
        print(json.dumps(body))
    sys.exit(0)
if args == ["--version"]:
    print("4.0.0")
    sys.exit(0)
if args == ["auth", "login"]:
    print("Fake Clerk sign-in complete.")
    data["login"] = True
    data["apps"] = [{{"application_id": "app_fixture", "name": "My Application", "instances": [
        {{"instance_id": "ins_dev", "environment_type": "development", "publishable_key": "pk_test_fixture"}}]}}]
    done()
if not data["login"]:
    sys.exit(1)
method = args[args.index("-X") + 1] if "-X" in args else "GET"
body = json.loads(pathlib.Path(args[args.index("--file") + 1]).read_text()) if "--file" in args else None
path = args[-1]
if path == "/v1/platform/applications":
    done(data["apps"])
app = data["apps"][0]
base = "/v1/platform/applications/app_fixture"
instance = base + "/instances/ins_prod"
if path == base and method == "PATCH":
    app["name"] = body["name"]
    done(app)
if path == base + "?include_secret_keys=true":
    done({{**app, "instances": [{{**i, "secret_key": {CLERK_SECRET!r} if i["environment_type"] == "production" else "sk_test_x"}} for i in app["instances"]]}})
if path == base + "/instances" and method == "POST":
    key = "pk_live_" + base64.b64encode(("clerk." + body["domain"] + "$").encode()).decode()
    app["instances"].append({{"instance_id": "ins_prod", "environment_type": "production", "publishable_key": key}})
    done({{"id": "ins_prod"}})
if path == instance + "/config":
    done({{}})
if path == instance + "/redirect_urls":
    if method == "POST":
        data["redirects"].append(body)
        done(body)
    done({{"data": data["redirects"]}})
sys.exit(1)
"""

# Node.js and npx as the wizard's tool check reads them. This npx cannot start
# the Clerk CLI (as when the npm registry is unreachable).
NODE = """
import sys
print("v22.11.0")
"""
NPX = """
import sys
if sys.argv[1:] == ["--version"]:
    print("10.9.0")
    sys.exit(0)
sys.exit(1)
"""
node = root / "node"
shim(node, "node", NODE)
shim(node, "npx", NPX)
common = root / "bin"
for name in ["open", "xdg-open"]:
    shim(common, name, BROWSER)
for name in ["pbcopy", "wl-copy", "xclip"]:
    shim(common, name, CLIPBOARD)
shim(common, "gcloud", GCLOUD)
clerk_cli = root / "clerk-cli"
shim(clerk_cli, "npx", CLERK)
clerk_offline = root / "clerk-offline"
shim(clerk_offline, "npx", NPX)

server = ThreadingHTTPServer(("127.0.0.1", 0), Api)
threading.Thread(target=server.serve_forever, daemon=True).start()
api = f"http://127.0.0.1:{server.server_port}"


def start(directory, clerk=None, args=(), tools=True, cwd=None):
    """Runs the binary with only the shims on PATH: Node.js and npx unless not
    `tools`, and the Clerk CLI only with `clerk`. Without `directory` the
    instance is chosen as a person's plain `azad` would, from `cwd`."""
    home = root / "home" / (directory.name if directory else cwd.name)
    home.mkdir(parents=True, exist_ok=True)
    refused = "http://127.0.0.1:9"
    env = {
        "PATH": ":".join(str(p) for p in ([clerk] if clerk else []) + ([node] if tools else []) + [common]),
        "HOME": str(home),
        "TERM": "xterm-256color",
        "HTTPS_PROXY": refused, "https_proxy": refused,
        "HTTP_PROXY": refused, "http_proxy": refused,
        "NO_PROXY": "127.0.0.1", "no_proxy": "127.0.0.1",
        "CLOUDFLARE_API_BASE_URL": api + "/client/v4",
        "CLERK_API_URL": api,
        "GITHUB_API_URL": api,
        "CLOUDSDK_AUTH_TOKEN_HOST": api + "/token",
    }
    if "TMPDIR" in os.environ:
        env["TMPDIR"] = os.environ["TMPDIR"]
    transcript = io.StringIO()
    selection = ["--directory", str(directory)] if directory else []
    child = pexpect.spawn(binary, [*selection, *args], env=env, cwd=str(cwd or root),
                          encoding="utf-8", timeout=20, dimensions=(60, 240))
    children.append(child)
    child.logfile_read = transcript
    return child, transcript


def lines(path):
    return path.read_text().splitlines() if path.exists() else []


def opened(page):
    return lines(browser_log).count(page)


def finish(child, status):
    child.expect(pexpect.EOF)
    child.close()
    assert child.exitstatus == status, child.exitstatus


def cancel(child):
    child.sendcontrol("c")
    finish(child, 130)


def env_file(directory):
    path = directory / ".env"
    assert path.stat().st_mode & 0o777 == 0o600
    return path.read_text()


def masked(transcript, visible_database=False):
    for secret in SECRETS + ([] if visible_database else [DB_SECRET]):
        assert secret not in transcript.getvalue(), secret


def token(child, value=ROOT_TOKEN):
    before = opened(TOKENS_PAGE)
    child.expect_exact("Opening Cloudflare in 3 seconds")
    assert opened(TOKENS_PAGE) == before, "Cloudflare opened before the countdown"
    child.expect_exact("Cloudflare token")
    assert opened(TOKENS_PAGE) == before + 1
    child.send(value + "\r")


def clerk_by_cli(child):
    child.expect_exact("Fake Clerk sign-in complete.")
    child.expect_exact(f"Clerk production instance for {WEB} ready")


def clerk_by_hand(child, reason):
    child.expect_exact(reason)
    child.expect_exact("Continuing with manual Clerk steps.")
    child.expect_exact("Opening Clerk in 3 seconds")
    child.expect_exact("Clerk publishable key (production)")
    child.send(PUBLISHABLE + "\r")
    child.expect_exact("Clerk secret key (production)")
    child.send("fixture-manual-clerk-secret\r")


def webhook_and_github(child, owner="", clerk_automated=False, google=False):
    child.expect_exact("The URL above is on your clipboard.")
    child.expect_exact("Opening Clerk in 3 seconds")
    child.expect_exact("Clerk webhook signing secret")
    child.send("fixture-hook-secret\r")
    child.expect_exact("GitHub organization that owns the App")
    child.send(owner + "\r")
    if not owner:
        child.expect_exact("(your account)")
    child.expect_exact("Opening GitHub in 3 seconds")
    # The install page opens only after deploy, once the API can receive GitHub's webhook.
    child.expect_exact("GitHub App azad-board-example-com created. Setup opens its install page once Azad is deployed.")
    if not clerk_automated:
        return
    # Sign in with Google is an opt-in: Enter answers No.
    child.expect_exact("Would you like to enable Sign in with Google?")
    if not google:
        child.send("\r")
        child.expect_exact("Will people use the Azad desktop or mobile apps?")
        child.send("n")
        return
    child.send("y")
    child.expect_exact("The URL above is on your clipboard.")
    child.expect_exact("Opening Google Cloud in 3 seconds")
    # The browser shim downloads the client JSON; setup reads it without a paste.
    child.expect_exact("Waiting for the downloaded JSON")
    child.expect_exact("Read the OAuth client " + GOOGLE_ID + " from Downloads.")
    child.expect_exact("Google accepted the OAuth client.")
    child.expect_exact("Opening Google Cloud in 3 seconds")
    child.expect_exact("Is the app published (or Internal)?")
    child.send("\r")
    child.expect_exact("Sign in with Google is on in Clerk.")
    child.expect_exact("Will people use the Azad desktop or mobile apps?")
    child.send("\r")
    child.expect_exact("Opening Clerk in 3 seconds")
    child.expect_exact("Is Native API on?")
    child.send("\r")


try:
    # Ctrl+C during a countdown never opens the browser.
    child, transcript = start(root / "cancelled-browser")
    child.expect_exact("Where should Azad run?")
    child.send("\r")
    child.expect_exact("Where would you like to host your database?")
    child.send("\r")
    child.expect_exact("Opening Neon in 3 seconds")
    cancel(child)
    assert not browser_log.exists(), "Cancellation during countdown opened the browser"
    print("Ctrl+C during the countdown stops before the browser opens PASS")

    # Missing tools stop the wizard right after the target question.
    missing = root / "missing-tools"
    child, transcript = start(missing, tools=False)
    child.expect_exact("Where should Azad run?")
    child.send("\r")
    child.expect_exact("These tools are missing or too old. Please install them, then run azad again:")
    child.expect_exact("- Node.js 20.0.0 or newer (not installed): https://nodejs.org/en/download")
    child.expect_exact("- npm (npx) 7.0.0 or newer (not installed): https://nodejs.org/en/download")
    finish(child, 1)
    assert "host your database" not in transcript.getvalue()
    assert "AZAD_CLI_TARGET='cloudflare'" in env_file(missing)
    print("Missing tools stop the wizard right after the target question, with minimums and download pages PASS")

    # A deploy also needs Git, Bun, Node.js 26.12.1+ and Terraform: a saved
    # target is checked before the first question.
    checkout = root / "source-checkout"
    checkout.mkdir()
    child, transcript = start(missing, args=["--source", str(checkout)])
    child.expect_exact("These tools are missing or too old. Please install them, then run azad again:")
    child.expect_exact("- Git 2.0.0 or newer (not installed): https://git-scm.com/downloads")
    child.expect_exact("- Bun 1.4.4 or newer (not installed): https://bun.sh/docs/installation")
    child.expect_exact("- Node.js 26.12.1 or newer (found 22.11.0): https://nodejs.org/en/download")
    child.expect_exact("- Terraform 1.13.4 or newer (not installed): https://developer.hashicorp.com/terraform/install")
    finish(child, 1)
    assert "Where should Azad run?" not in transcript.getvalue()
    assert "npm (npx)" not in transcript.getvalue()
    print("A deploy lists missing and too-old deployment tools before any question PASS")

    # Without --directory the instance lives in the home folder.
    fresh = root / "fresh-cwd"
    fresh.mkdir()
    child, transcript = start(None, cwd=fresh)
    child.expect_exact("Where should Azad run?")
    child.send("\r")
    child.expect_exact("Where would you like to host your database?")
    cancel(child)
    instances = root / "home" / fresh.name / ".azad" / "instances"
    assert "AZAD_CLI_TARGET='cloudflare'" in env_file(instances / "default")
    assert (instances / "default").stat().st_mode & 0o777 == 0o700
    assert (instances.parent).stat().st_mode & 0o777 == 0o700
    print("Without --directory the default instance is private in ~/.azad/instances/default PASS")

    # Cloudflare + Neon: every automatic step, a mistyped token, one Clerk line.
    neon = root / "neon"
    child, transcript = start(neon, clerk_cli)
    child.expect_exact("Where should Azad run?")
    child.send("\r")
    child.expect_exact("Where would you like to host your database?")
    child.send("\r")
    child.expect_exact("Opening Neon in 3 seconds")
    assert not opened(NEON_PAGE), "Neon opened before the countdown"
    child.expect_exact("Neon connection string")
    assert opened(NEON_PAGE) == 1
    child.send(f"postgresql://user:{DB_SECRET}@ep-test-pooler.aws.neon.tech/azad?sslmode=require&channel_binding=require\r")
    child.expect_exact("Using Neon's direct endpoint ep-test.aws.neon.tech")
    child.expect_exact("Azad web hostname")
    child.send(WEB + "\r")
    token(child, WRONG_TOKEN)
    child.expect_exact("Cloudflare rejected the token (HTTP 401).")
    child.expect_exact("Cloudflare token")
    child.send(ROOT_TOKEN + "\r")
    child.expect_exact("Cloudflare account: Fixture Account")
    clerk_by_cli(child)
    webhook_and_github(child, clerk_automated=True, google=True)
    # Everything else keeps its default unless the person opens optional settings.
    child.expect_exact("Defaults: Mini Apps on, meetings on (Cloudflare RealtimeKit), project repositories on Cloudflare Artifacts")
    child.expect_exact("Configure optional settings?")
    child.send("n")
    child.expect_exact("Settings saved.")
    finish(child, 0)
    masked(transcript, visible_database=True)
    output = transcript.getvalue()
    assert "Enable Mini Apps" not in output and "Review branding" not in output
    assert "Enable projects" not in output and "Enable meetings" not in output
    assert "uploaded files" not in output
    assert "Clerk application ready" not in output, "Clerk printed two success lines"
    saved = env_file(neon)
    for expected in ["AZAD_CLI_TARGET='cloudflare'", "AZAD_CLI_DATABASE_SERVICE='neon'",
                     "AZAD_CLI_DATABASE_PROVIDER='postgres'", f"CLOUDFLARE_ACCOUNT_ID='{ACCOUNT}'",
                     f"CLERK_PUBLISHABLE_KEY='{PUBLISHABLE}'", "AZAD_CLI_CLERK_INSTANCE_ID='ins_prod'",
                     "GITHUB_APP_ID='4242'", "AZAD_SELF_HOST_MINIAPPS='enabled'",
                     f"V3_CF_ACCOUNT_ID='{ACCOUNT}'", "AZAD_SELF_HOST_DATABASE_CA='neon-isrg-root-x1'",
                     "AZAD_CLI_MANAGED_SOURCE='enabled'", "AZAD_CLI_MEETINGS='enabled'",
                     "AZAD_CLI_STORAGE='default'",
                     "@ep-test.aws.neon.tech/azad?sslmode=verify-full'"]:
        assert expected in saved, expected
    assert ROOT_TOKEN not in saved and WRONG_TOKEN not in saved and "channel_binding" not in saved
    assert "AZAD_CLI_CLERK_GITHUB_SIGN_IN" not in saved
    assert "AZAD_CLI_CLERK_GOOGLE_SIGN_IN='enabled'" in saved
    assert GOOGLE_SECRET not in output, "The Google client secret was displayed"
    assert f"AZAD_CLI_GOOGLE_CLIENT_ID='{GOOGLE_ID}'" in saved
    assert not any((root / "home" / neon.name / "Downloads").iterdir()), "The downloaded client JSON was kept"
    assert google_checks == [GOOGLE_ID], google_checks
    credential = neon / ".cloudflare-bootstrap-credential/.env"
    assert credential.stat().st_mode & 0o777 == 0o600
    assert ROOT_TOKEN in credential.read_text() and WRONG_TOKEN not in credential.read_text()
    assert lines(browser_log)[:3] == [NEON_PAGE, TOKENS_PAGE,
                                      "https://dashboard.clerk.com/apps/app_fixture/instances/ins_prod/webhooks"]
    assert lines(browser_log)[3].startswith("http://127.0.0.1:") and len(lines(browser_log)) == 7
    assert "https://github.com/apps/azad-board-example-com/installations/new" not in lines(browser_log)
    # Google's OAuth client page, with Clerk's callback on the clipboard.
    assert lines(browser_log)[4] == "https://console.cloud.google.com/auth/clients/create"
    # Then the Audience page, where a Testing app is published.
    assert lines(browser_log)[5] == "https://console.cloud.google.com/auth/audience"
    assert lines(browser_log)[6] == "https://dashboard.clerk.com/apps/app_fixture/instances/ins_prod/native-applications"
    assert lines(clipboard_log) == [WEBHOOK, "https://clerk.board.example.com/v1/oauth_callback"]
    form = json.loads(lines(github_log)[0])
    assert form["action"].startswith("https://github.com/settings/apps/new?state=")
    assert form["manifest"]["hook_attributes"]["url"] == "https://api.board.example.com/api/github/webhooks"
    assert ("DELETE", "/client/v4/user/tokens/" + LOOKUP_ID, "Bearer " + ROOT_TOKEN) in api_requests
    # Clerk Protect records sign-ups without blocking them on the new instance.
    assert ("PATCH", "/v1/instance/protect", "Bearer " + CLERK_SECRET) in api_requests
    assert ("GET", "/client/v4/user/tokens/permission_groups", "Bearer " + WRONG_TOKEN) in api_requests
    print("cloudflare/neon: automatic account, Clerk and GitHub with masked secrets and private files PASS")

    # A complete configuration deploys (here: is kept) with one confirmation.
    before = env_file(neon)
    opens, calls = len(lines(browser_log)), len(api_requests)
    child, transcript = start(neon, clerk_cli)
    child.expect_exact("Your saved settings are complete.")
    child.expect_exact("Keep them? (No to change settings)")
    child.send("y")
    child.expect_exact("Settings saved.")
    finish(child, 0)
    assert "Where should Azad run?" not in transcript.getvalue()
    assert (len(lines(browser_log)), len(api_requests)) == (opens, calls)
    assert env_file(neon) == before
    masked(transcript)
    print("Complete saved settings are kept with one confirmation PASS")

    # Changing settings walks the questions; valid saved answers keep with Enter.
    child, transcript = start(neon, clerk_cli)
    child.expect_exact("Keep them? (No to change settings)")
    child.send("n")
    child.expect_exact("Where should Azad run?")
    child.send("\r")
    child.expect_exact("Where would you like to host your database?")
    child.send("\r")
    child.expect_exact("Neon connection string")
    child.expect_exact(DB_SECRET)
    child.send("\r")
    child.expect_exact("Azad web hostname")
    child.send("\r")
    child.expect_exact("Cloudflare token (Enter keeps saved token)")
    child.send("\r")
    child.expect_exact("Cloudflare account: Fixture Account")
    child.expect_exact("Clerk: using the saved application keys.")
    child.expect_exact("Clerk webhook signing secret (Enter keeps saved value)")
    child.send("\r")
    child.expect_exact("GitHub: using the saved App 4242.")
    # A saved Google client that Google still accepts is reused and reapplied to Clerk.
    # The saved answer (Yes) is the default now.
    child.expect_exact("Would you like to enable Sign in with Google?")
    child.send("\r")
    child.expect_exact("Google: using the saved OAuth client " + GOOGLE_ID + ".")
    child.expect_exact("Sign in with Google is on in Clerk.")
    child.expect_exact("Will people use the Azad desktop or mobile apps?")
    child.send("\r")
    child.expect_exact("Configure optional settings?")
    cancel(child)
    assert len(lines(browser_log)) == opens, "A valid saved answer reopened a provider page"
    masked(transcript, visible_database=True)
    print("Changing settings shows the saved Neon URL and keeps other saved answers without reopening pages PASS")

    child, transcript = start(neon, clerk_cli)
    child.expect_exact("Keep them? (No to change settings)")
    child.send("n")
    child.expect_exact("Where should Azad run?")
    child.send("\r")
    child.expect_exact("Where would you like to host your database?")
    child.send("\r")
    child.expect_exact(DB_SECRET)
    child.sendcontrol("u")
    child.send("\r")
    child.expect_exact("Enter a value to continue")
    cancel(child)
    assert len(lines(browser_log)) == opens
    assert env_file(neon) == before
    print("Replacing a saved Neon URL requires nonempty input PASS")

    checkpoint = neon / ".env"
    checkpoint.write_text(before.replace("sslmode=verify-full", "sslmode=require&channel_binding=require"))
    child, transcript = start(neon, clerk_cli)
    child.expect_exact("Keep them? (No to change settings)")
    child.send("y")
    finish(child, 0)
    resumed = env_file(neon)
    assert "sslmode=verify-full" in resumed and "channel_binding" not in resumed
    assert "Use certificate-verified TLS instead" not in transcript.getvalue()
    print("A resumed Neon URL uses verified TLS without another policy question PASS")

    # Cancelling the Cloudflare countdown, then an empty token, then the token.
    resume = root / "bootstrap-input"
    child, transcript = start(resume)
    child.expect_exact("Where should Azad run?")
    child.send("\r")
    child.expect_exact("Where would you like to host your database?")
    child.send("\r")
    child.expect_exact("Neon connection string")
    child.send(f"postgresql://u:{DB_SECRET}@ep-fixture.us-east-2.aws.neon.tech/db?sslmode=require\r")
    child.expect_exact("Azad web hostname")
    child.send(WEB + "\r")
    opens_before = opened(TOKENS_PAGE)
    child.expect_exact("Opening Cloudflare in 3 seconds")
    cancel(child)
    assert opened(TOKENS_PAGE) == opens_before
    assert not (resume / ".cloudflare-bootstrap-credential").exists()
    child, transcript = start(resume)
    child.expect_exact("Where should Azad run?")
    child.send("\r")
    child.expect_exact("Where would you like to host your database?")
    child.send("\r")
    child.expect_exact("Neon connection string")
    child.send("\r")
    child.expect_exact("Azad web hostname")
    child.send("\r")
    token(child, "")
    child.expect_exact("Paste the Cloudflare API token value only")
    assert opened(TOKENS_PAGE) == opens_before + 1
    child.send(ROOT_TOKEN + "\r")
    child.expect_exact("Cloudflare account: Fixture Account")
    child.expect_exact("The Clerk CLI could not start")
    child.expect_exact("Clerk publishable key (production)")
    cancel(child)
    masked(transcript, visible_database=True)
    assert ROOT_TOKEN not in env_file(resume) and "CLOUDFLARE_BOOTSTRAP_API_TOKEN" not in env_file(resume)
    admin = resume / ".cloudflare-bootstrap-credential" / ".env"
    assert ROOT_TOKEN in admin.read_text() and admin.stat().st_mode & 0o777 == 0o600
    print("One masked bootstrap token is saved separately; cancellation and resume keep answers PASS")

    # Other PostgreSQL when the Clerk CLI cannot start: manual Clerk, an organization App, optional settings.
    postgres = root / "postgres"
    child, transcript = start(postgres)
    child.expect_exact("Where should Azad run?")
    child.send("\r")
    child.expect_exact("Where would you like to host your database?")
    child.send("\x1b[B\x1b[B\r")
    child.expect_exact("Direct PostgreSQL connection URL")
    child.send(f"postgresql://user:{DB_SECRET}@db.example.com/azad?sslmode=require\r")
    child.expect_exact("Azad web hostname")
    child.send(WEB + "\r")
    token(child)
    child.expect_exact("Cloudflare account: Fixture Account")
    clerk_by_hand(child, "The Clerk CLI could not start (offline, or the npm registry is blocked)")
    webhook_and_github(child, "acme-inc")
    child.expect_exact("Configure optional settings?")
    child.send("y")
    child.expect_exact("Enable Mini Apps?")
    child.send("n")
    child.expect_exact("Enable projects (managed project source on Cloudflare Artifacts)?")
    child.send("n")
    child.expect_exact("Enable meetings (Cloudflare RealtimeKit)?")
    child.send("\r")
    child.expect_exact("Where should uploaded files be stored?")
    child.send("\r")
    child.expect_exact("Set up email, meetings or media services?")
    child.send("n")
    child.expect_exact("Review branding, error reporting or runtime settings?")
    child.send("n")
    child.expect_exact("Settings saved.")
    finish(child, 0)
    masked(transcript)
    saved = env_file(postgres)
    for expected in ["AZAD_CLI_DATABASE_SERVICE='postgres'", "AZAD_CLI_DATABASE_PROVIDER='postgres'",
                     "AZAD_SELF_HOST_MINIAPPS='disabled'", f"CLERK_PUBLISHABLE_KEY='{PUBLISHABLE}'",
                     "AZAD_CLI_MANAGED_SOURCE='disabled'"]:
        assert expected in saved, expected
    assert "V3_CF_ACCOUNT_ID" not in saved
    assert json.loads(lines(github_log)[-1])["action"].startswith(
        "https://github.com/organizations/acme-inc/settings/apps/new?state=")
    print("cloudflare/postgres: manual Clerk when its CLI cannot start, organization App, Mini Apps off in optional settings PASS")

    # Cloud SQL with a Clerk CLI that cannot start.
    cloudsql = root / "cloudsql"
    child, transcript = start(cloudsql, clerk_offline)
    child.expect_exact("Where should Azad run?")
    child.send("\r")
    child.expect_exact("Where would you like to host your database?")
    child.send("\x1b[B\r")
    # The same gcloud sign-in and project picker as the Google Cloud target.
    child.expect_exact("You are now logged in as fixture@example.com.")
    child.expect_exact("Google Cloud project")
    child.send("\r")
    child.expect_exact("Cloud SQL region")
    child.sendcontrol("u")
    child.send("europe-west1\r")
    child.expect_exact("This machine's public IPv4")
    child.send("203.0.113.1/32\r")
    child.expect_exact("Azad web hostname")
    child.send(WEB + "\r")
    token(child)
    child.expect_exact("Cloudflare account: Fixture Account")
    clerk_by_hand(child, "The Clerk CLI could not start (offline, or the npm registry is blocked)")
    webhook_and_github(child)
    child.expect_exact("Configure optional settings?")
    child.send("n")
    finish(child, 0)
    masked(transcript)
    saved = env_file(cloudsql)
    assert "Google Cloud project ID" not in transcript.getvalue()
    for expected in ["AZAD_CLI_DATABASE_SERVICE='cloudsql'", "AZAD_CLI_GCP_PROJECT='customer-project'",
                     "AZAD_CLI_GCP_REGION='europe-west1'",
                     "AZAD_CLI_RUNNER_CIDR='203.0.113.1/32'"]:
        assert expected in saved, expected
    assert "DATABASE_URL" not in saved
    print("cloudflare/cloudsql: gcloud project picker, region and runner network; manual Clerk when its CLI cannot start PASS")

    # Your Google Cloud: no database question (Terraform creates Cloud SQL),
    # gcloud sign-in, project picker, sizing, Mini Apps on the loader.
    gcp = root / "gcp"
    child, transcript = start(gcp, clerk_cli)
    child.expect_exact("Where should Azad run?")
    child.send("\x1b[B\r")
    child.expect_exact("You are now logged in as fixture@example.com.")
    child.expect_exact("Google Cloud project")
    child.send("\r")
    child.expect_exact("Google Cloud region")
    child.send("\r")
    child.expect_exact("Google Cloud sizing")
    child.send("\r")
    # The agent machine defaults to 8 vCPU · 16 GB.
    child.expect_exact("What size machine should run your agents?")
    child.send("\r")
    child.expect_exact("Azad web hostname")
    child.send(WEB + "\r")
    token(child)
    child.expect_exact("Cloudflare account: Fixture Account")
    clerk_by_cli(child)
    webhook_and_github(child, clerk_automated=True)
    # Meetings default on (deployment creates the RealtimeKit app); disk
    # backups default to daily; both change under optional settings.
    child.expect_exact("Defaults: Mini Apps on, meetings on (Cloudflare RealtimeKit), daily disk backups")
    child.expect_exact("Configure optional settings?")
    child.send("n")
    finish(child, 0)
    masked(transcript)
    output = transcript.getvalue()
    assert "Enable projects" not in output and "Enable Mini Apps" not in output
    assert "How often should the disks" not in output and "uploaded files" not in output
    assert "host your database" not in output
    saved = env_file(gcp)
    for expected in ["AZAD_CLI_TARGET='gcp'", "AZAD_CLI_GCP_PROJECT='customer-project'",
                     "AZAD_CLI_GCP_REGION='us-central1'", "AZAD_CLI_GCP_SIZING='production'",
                     "AZAD_CLI_GCP_DISK_BACKUPS='daily'",
                     "MINIAPP_PROVIDER='loader'", "AZAD_SELF_HOST_MINIAPPS='enabled'",
                     "AZAD_CLI_MEETINGS='enabled'"]:
        assert expected in saved, expected
    assert "DATABASE_URL" not in saved
    print("gcp: no database question; gcloud sign-in, project picker, sizing and agent machine; Mini Apps on the loader PASS")

    # Once a deployment has started, Enter resumes it with the saved settings.
    deployed = env_file(neon) + f"AZAD_CLI_SOURCE_REVISION='{'a' * 40}'\n"
    (neon / ".env").write_text(deployed)
    opens = len(lines(browser_log))
    child, transcript = start(neon, clerk_cli)
    child.expect_exact("A deployment of this instance has started. What next?")
    child.send("\r")
    child.expect_exact("Resuming the deployment of this instance with its saved settings.")
    child.expect_exact("Settings saved.")
    finish(child, 0)
    assert "Where should Azad run?" not in transcript.getvalue()
    assert env_file(neon) == deployed
    print("After a deploy has started, Enter resumes with the saved settings PASS")

    # Change settings: fixed settings are shown, not asked; the rest keep with Enter.
    child, transcript = start(neon, clerk_cli)
    child.expect_exact("A deployment of this instance has started. What next?")
    child.send("\x1b[B\r")
    child.expect_exact("Settings the first deploy fixed are shown, not asked")
    child.expect_exact("Where should Azad run: Cloudflare (fixed)")
    child.expect_exact("Where would you like to host your database: Neon (fixed)")
    child.expect_exact("Neon connection string: saved (fixed)")
    child.expect_exact(f"Azad web hostname: {WEB} (fixed)")
    child.expect_exact("Cloudflare token (Enter keeps saved token)")
    child.send("\r")
    child.expect_exact(f"Cloudflare account ID: {ACCOUNT} (fixed)")
    child.expect_exact("Clerk: using the saved application keys.")
    child.expect_exact("Clerk webhook signing secret (Enter keeps saved value)")
    child.send("\r")
    child.expect_exact("GitHub: using the saved App 4242.")
    child.expect_exact("Would you like to enable Sign in with Google?")
    child.send("\r")
    child.expect_exact("Google: using the saved OAuth client " + GOOGLE_ID + ".")
    child.expect_exact("Will people use the Azad desktop or mobile apps?")
    child.send("\r")
    child.expect_exact("Configure optional settings?")
    child.send("y")
    child.expect_exact("Enable Mini Apps: yes (fixed)")
    child.expect_exact("Enable projects (managed project source on Cloudflare Artifacts): yes (fixed)")
    child.expect_exact("Enable meetings (Cloudflare RealtimeKit)?")
    child.send("n")
    child.expect_exact("Where should uploaded files be stored: This installation's Cloudflare R2 bucket (fixed)")
    child.expect_exact("Set up email, meetings or media services?")
    child.send("n")
    child.expect_exact("Review branding, error reporting or runtime settings?")
    child.send("n")
    child.expect_exact("Saved changes to AZAD_CLI_MEETINGS")
    child.expect_exact("Settings saved.")
    finish(child, 0)
    masked(transcript)
    changed = env_file(neon)
    assert "AZAD_CLI_MEETINGS='disabled'" in changed and f"AZAD_CLI_WEB_HOST='{WEB}'" in changed
    assert "AZAD_CLI_DATABASE_SERVICE='neon'" in changed and "sslmode=verify-full" in changed
    assert len(lines(browser_log)) == opens, "Changing settings reopened a provider page"
    print("Change settings shows fixed settings read-only and saves only the change PASS")

    # Reset refuses while the scoped tokens' Terraform state still records them.
    tokens = neon / "cloudflare-bootstrap" / "terraform"
    tokens.mkdir(parents=True)
    token_state = {"version": 4, "resources": [{"mode": "managed", "type": "cloudflare_api_token",
                                                "name": "scoped", "instances": [{"index_key": "deployment"}]}]}
    (tokens / "terraform.tfstate").write_text(json.dumps(token_state))
    child, transcript = start(neon, args=["--reset"])
    child.expect_exact("Nothing was removed: Terraform still records resources for this instance.")
    child.expect_exact(f"terraform -chdir={tokens} destroy")
    finish(child, 1)
    assert (neon / ".env").exists() and (tokens / "terraform.tfstate").exists()
    print("Reset refuses while Terraform state records resources and prints the removal commands PASS")

    # Once the state is empty, reset lists what it deletes and defaults to No.
    token_state["resources"] = []
    (tokens / "terraform.tfstate").write_text(json.dumps(token_state))
    checkout = root / "deployed-source"
    checkout.mkdir()
    reset = ["--reset", "--source", str(checkout)]
    child, transcript = start(neon, args=reset)
    child.expect_exact(str(neon / ".cloudflare-bootstrap-credential"))
    child.expect_exact("Delete these files and start over?")
    child.send("\r")
    child.expect_exact("Nothing was removed.")
    finish(child, 0)
    assert (neon / ".env").exists()
    child, transcript = start(neon, args=reset)
    child.expect_exact("Delete these files and start over?")
    child.send("y")
    child.expect_exact(f"Run azad --directory {neon} to start over.")
    finish(child, 0)
    masked(transcript)
    assert sorted(path.name for path in neon.iterdir()) == [".gitignore"], list(neon.iterdir())
    print("Reset deletes the saved settings and credentials only after a confirmation that defaults to No PASS")
finally:
    for child in children:
        child.close(force=True)
    server.shutdown()
    shutil.rmtree(root)
