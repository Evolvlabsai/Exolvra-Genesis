# Genesis control panel

The panel can run as a Node process on your computer, under a service manager,
or in a container. In shared mode, team members sign in through an HTTPS URL
and operate projects accessible to that process. The examples below are
deployment patterns for this open-source project, not a provisioned service.
Replace example domains, paths and account names for your environment.

## Direct Node process and local use

Build the CLI, then start the panel in the project you want to operate:

```sh
cd cli
npm install
npm run build
node dist/cli.js dashboard -C .. --open
```

With an installed CLI, use `exolvra-genesis dashboard --open`. The default
address is `http://127.0.0.1:4317`. `--port 0` chooses a free port; the CLI prints
the actual address. Keep the command running while using the panel. It inherits
the same Claude credentials and plugin settings as the CLI. Loading the panel
or checking local diagnostics makes no model call.

## Operating projects

The interface uses Genesis's recorded runs and live process observations:

- **Operations** shows active work, lifecycle counts, service status and recent
  events. Polling refreshes live observations every two seconds.
- **Runs** filters recorded runs by project, state or text. A run opens its
  lifecycle, event stream, process observations, pieces, measured budget,
  captured input and downloadable artifacts. Events support filters, tailing
  and older pages. JSON export contains the data currently loaded.
- **Plans** shows panel-launched planning commands and their captured output.
- **Projects** registers existing directories on the panel's host and their
  named goals.
  Removing a project only removes its registration. Active work must settle first.
- **Agents** reads the lead, builder, critic and available auditor definitions
  from the selected plugin's Markdown.
- **Telemetry** shows observed usage and run outcomes. Exact provider-reported
  totals remain exact; missing receipts and nested local cost splits remain
  unavailable.
- **Events** shows recent cross-project events. **Settings** checks local
  prerequisites and controls the panel's display preferences.

Use the sun/moon button in the top bar or sign-in screen to switch between light
and dark mode. Your browser remembers the choice. Settings also offers a
**System** theme that follows your device's appearance preference.

Use **New run** to enter a goal, named goal or spec path and select a project.
Model and permission choices go to the existing CLI. Builds run unattended
after submission, including the small execution preflight, and can spend money.
Set cost, round or turn caps in the form. Planning captures the proposed bar
and pieces; it does not start builders. Chart actions use the local tracker in
AFK mode, so interactive decisions and handoffs remain pending in the CLI.

Stop requests use Genesis's existing graceful-settlement behavior. Resume
uses the run's saved models and provider session. Availability follows recorded
ownership and liveness; an unavailable resume is not offered as a successful
action. Commands show their actual output and exit status, including startup
failures before a run record exists. Closing the browser does not stop work.
Stopping the dashboard with Ctrl+C or SIGTERM asks its owned commands to settle;
commands started outside the panel remain under their original owner's control.

Panel registrations and bounded command receipts are stored under the initial
project's `.exolvra-genesis/control-panel/`. Run evidence stays in its existing
project location. Start subsequent sessions with the same `-C` directory to
reuse the registry. The initial directory is also the first registered project.
Generated HTML artifacts download instead of executing with control-panel
privileges. The panel adds no runtime dependencies or external tracking service.

## Shared access through HTTPS

Run one panel process behind an HTTPS reverse proxy. Genesis serves HTTP on its
listener; your proxy or ingress terminates TLS. With a proxy on the same host,
keep Genesis on `127.0.0.1:4317`. The proxy must preserve the browser's Host,
forward requests to the backend, and provide the exact HTTPS origin configured
in Genesis. A Caddy configuration and a Linux service are optional examples:
[control-panel.service](../examples/control-panel.service) and
[control-panel.Caddyfile](../examples/control-panel.Caddyfile).

Set `EXOLVRA_GENESIS_PANEL_TOKEN` to a random shared access key of 24–4096
printable ASCII characters without spaces. A 32-byte random value encoded as
hex works. The key is required for a non-loopback listener or a shared public
URL. Supply it through the process environment; the service example uses an
environment file. Do not put the key in a URL or command flag.

The service starts the equivalent of:

```sh
exolvra-genesis dashboard -C /srv/genesis/workspace \
  --host 127.0.0.1 --port 4317 \
  --public-url https://genesis.example.com
```

`--public-url` is the exact browser origin: scheme, hostname and optional port.
It must not contain a subpath, query, fragment or credentials. Shared public
origins require HTTPS. Genesis checks Host and Origin against this configured
origin. For example, keep Caddy's default Host forwarding; do not rewrite Host
to `127.0.0.1:4317`.
[Caddy's proxy header documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#defaults)
describes this default. Other proxies must provide the same Host behavior.

`--host 0.0.0.0` and `--host ::` support a reverse proxy on a separate network
interface, such as a container network. They require an access key and
`--public-url`. Restrict the backend port to that proxy. For a proxy on the same
host, keep the default loopback binding and expose only the HTTPS proxy.

Open the HTTPS URL and enter the shared access key. The browser receives an
opaque HttpOnly, SameSite=Strict session cookie, marked Secure for HTTPS, plus
a token for authenticated writes. Sessions expire after eight hours; signing
out revokes that browser's session. A server restart invalidates all browser
sessions. Signing out or closing a browser does not stop commands.

Every member with the key has the same operating authority. Members can
register directories accessible to the service account, inspect shared project
records, start code execution and spend the account's model budget. There are
no individual roles or per-user project boundaries. Use a dedicated host or
service account with access to the repositories and credentials this team
needs. Project directories and spec paths refer to the **server filesystem**;
selecting a path does not upload files from the member's computer.

## Optional Linux systemd service

The service example assumes a dedicated `genesis` user and group, home directory
`/var/lib/genesis`, and an existing writable project at
`/srv/genesis/workspace`. These are replaceable deployment choices, not required
host paths. Create your service account and prepare its project access before
starting the service. Install Node, Git, the project's build tools and the same
Claude authentication used by the CLI. An interactive login under your own
account does not authenticate the service account.

For this example, install the built Genesis package under `/opt/genesis`.
For an unreleased checkout, run `npm install` and `npm pack` in `cli/` to create a
package that includes the compiled CLI, panel assets and plugin files. Transfer
that tarball to the server, then install it there, substituting its actual path:

```sh
sudo npm install --prefix /opt/genesis /absolute/path/exolvra-genesis-0.10.0.tgz
```

The service example invokes `/usr/bin/node` with
`/opt/genesis/node_modules/exolvra-genesis/dist/cli.js`. Check `command -v node`
and the installed file, then edit `ExecStart` if either path differs. Also edit
`WorkingDirectory`, `-C`, `HOME` and `PATH` for your host. systemd does not load
your interactive shell's Node version manager or shell profile. Keep installed
application files separate from the writable project directories.

Create `/etc/genesis/panel.env` as a root-owned file with mode `0600`. Generate
the panel key on the server, for example with:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Put the generated value in the file. The `REPLACE_ME` values below are
placeholders; the panel refuses the short placeholder access key:

```dotenv
EXOLVRA_GENESIS_PANEL_TOKEN=REPLACE_ME
ANTHROPIC_API_KEY=REPLACE_ME
```

For Claude Code login authentication, omit `ANTHROPIC_API_KEY` and authenticate
as the `genesis` user with the configured home directory. Add any project tool
environment or plugin override needed by your normal CLI workflow to the same
file. Use plain `NAME=value` assignments, without `export` or shell command
substitution. systemd reads these values into the service's environment. See the
[systemd environment-file reference](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml).

Copy the service example to `/etc/systemd/system/control-panel.service`, edit
its paths and public URL, then validate and start it:

```sh
sudo systemd-analyze verify /etc/systemd/system/control-panel.service
sudo systemctl daemon-reload
sudo systemctl enable --now control-panel.service
sudo journalctl -u control-panel.service -f
```

### Optional Caddy HTTPS proxy

Point your hostname's DNS at the server and allow inbound ports 80 and 443.
Replace `genesis.example.com` in the Caddy example with the same hostname as
`--public-url`. Add that site block to the installed Caddy service's Caddyfile
(commonly `/etc/caddy/Caddyfile`), preserving any existing sites. A public
hostname enables Caddy's automatic HTTPS certificate management; see the
[official reverse-proxy quick start](https://caddyserver.com/docs/quick-starts/reverse-proxy).
Validate the merged configuration and reload Caddy:

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Use the public HTTPS URL to verify sign-in, the registered initial project and
Settings diagnostics before starting a paid run. A Host/Origin rejection
usually means the browser URL, configured public origin or proxy Host header
does not match. Service startup errors appear in the journal; check the Node
path, environment-file values and project permissions there.

## Containers

The repository includes a [Dockerfile](../Dockerfile) and an optional
[Compose example](../examples/control-panel.compose.yml). The image builds the
CLI, bundled plugin and panel assets, and runs as the non-root `node` user with
Node 22 and common command-line tools. Extend it with the compilers, browsers
or other tools your project's verification commands require.

The Compose example requires three variables: `GENESIS_PUBLIC_URL`,
`GENESIS_PROJECT_DIR` and `EXOLVRA_GENESIS_PANEL_TOKEN`. Put these in a private
environment file outside the checkout, substituting an existing absolute
project path, your HTTPS origin and a generated access key. Configure one
supported Claude authentication method; this example uses an API key:

```dotenv
GENESIS_PUBLIC_URL=https://genesis.example.com
GENESIS_PROJECT_DIR=/absolute/host/project
EXOLVRA_GENESIS_PANEL_TOKEN=REPLACE_ME
ANTHROPIC_API_KEY=REPLACE_ME
```

Run from the repository root, substituting your private file's actual path:

```sh
docker compose --env-file /absolute/private/genesis.env \
  -f examples/control-panel.compose.yml up --build -d
```

The `genesis` service mounts that project at `/workspace` and publishes only
`127.0.0.1:4317` on the host for your HTTPS proxy. Its default user is UID/GID
1000; prepare the project permissions for that user before starting. The named
`genesis-home` volume preserves `/home/node`, including private CLI settings
and authentication state. `CLAUDE_CODE_OAUTH_TOKEN` is also forwarded when set.
`GENESIS_IMAGE` changes the local image name, and `GENESIS_PANEL_PORT` changes
the published host port; update the proxy's backend port to match.

The image supplies Node, Bash, Git and basic command-line tools. Extend it with
the toolchains your projects require, such as Python or a native compiler.

Choose these deployment details explicitly:

- **Projects and state:** mount the initial project read-write and keep its
  container path stable across restarts. This preserves its
  `.exolvra-genesis/control-panel/` registry and run evidence. Mount additional
  repositories at stable paths before registering them in the panel. A project
  path entered in the browser is a path inside the container.
- **Permissions:** run as a non-root user with read/write access to the mounted
  projects. Match the user or group to the host directory permissions. Mount
  only directories that authorized panel members should be able to operate.
- **Credentials:** inject the shared access key and Claude credentials at
  runtime using your container platform's environment or secret mechanism.
  If using Claude Code login, persist its service user's home/authentication
  data as well. Keep credentials out of the image and source control.
- **Network:** bind Genesis to `0.0.0.0` inside the container and configure the
  exact HTTPS `--public-url`. Keep the backend on a private proxy network or
  publish it only on host loopback for a host-based proxy. The proxy still
  preserves the browser's Host header.

For a custom container deployment, a host project mounted at `/workspace`
would use these CLI arguments after the image's CLI entrypoint:

```sh
dashboard -C /workspace --host 0.0.0.0 --port 4317 \
  --public-url https://genesis.example.com
```

With Docker, `--mount type=bind,src=/absolute/host/project,dst=/workspace`
persists that project's changes on the Docker host. Create the source directory
first. For a host-based proxy, `-p 127.0.0.1:4317:4317` publishes the backend on
host loopback. `--env-file /absolute/path/panel.env` supplies runtime environment
variables. Substitute your own paths and key values; these options are not
image-specific defaults. See Docker's
[bind-mount guide](https://docs.docker.com/engine/storage/bind-mounts/) and
[container-run reference](https://docs.docker.com/reference/cli/docker/container/run/).

Settle active commands through the panel before replacing or stopping a
container. Container termination can end remaining child processes, so a
recorded pending command is not proof that its final provider receipt has
arrived. Preserve the mounted project data when recreating containers.

## Shutdown, upgrades and key rotation

Stop active commands in the panel and wait for their outcome and billing to
settle before maintenance. `systemctl stop control-panel.service` sends SIGTERM
to the dashboard, which requests graceful settlement of commands it owns.
After 15 seconds without settlement, the dashboard reports pending commands
instead of inventing a successful stop.

The example uses `KillMode=mixed` and `SendSIGKILL=no`: systemd signals the
dashboard first and does not force-kill remaining command processes when the
dashboard exits. Remaining children can keep settling. systemd refuses to
restart this service while those prior processes remain; inspect the journal
and the run's recorded owner before taking further action. This behavior is
defined in the [systemd kill reference](https://github.com/systemd/systemd/blob/main/man/systemd.kill.xml).

After commands settle, stop the service, update the installed package or the
access key in `/etc/genesis/panel.env`, and start it again. Keep the same `-C`
directory to preserve the project registry and command receipts. Share a new
key with authorized members; previous browser sessions end with the restart.
Project ledgers and artifacts remain in each registered project directory.
