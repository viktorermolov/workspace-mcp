# First-time setup for the owner

This is done once, after the service is deployed and reachable at its public address. It takes a few minutes and needs:

- the public address (`PUBLIC_URL`), for example `https://workspace.example.com`;
- the one-time setup code, printed in the service log (whoever deployed the service gives it to you);
- a device that can create a passkey: a phone, or a computer with a password manager, Touch ID, Windows Hello or a security key with a PIN. The device must verify you (PIN, fingerprint or face); a plain touch is not enough.

There is no password. You sign in with the passkey, to the web interface and when you approve an AI platform.

## 1. Register your passkey

1. Open `https://<your address>/setup` in the browser of the device that will hold the passkey.
2. Enter the setup code (for example `ABCD-EFGH-JKLM-NPQR`; dashes and letter case do not matter) and choose **Create passkey**.
3. Confirm the passkey prompt of your device or password manager.
4. **Workspace is ready** appears. Choose **Continue**.

A code works once and expires after 30 minutes. If it has expired, restart the service (`docker compose restart workspace`) and use the new code from the log. After your passkey exists, no setup code is printed any more.

Add a second passkey right away, so you do not lose access if a device is lost: **More → Passkeys**, then **Add a passkey on this device** (for another password manager or a security key on the same device) or **Add on another device** (shows a one-time code to enter at `/setup` on the other device).

## 2. Connect your first AI platform

The **Connections** screen shows the MCP address to give to platforms:

```text
https://<your address>/mcp
```

Add it as a custom connector in the platform, then follow the platform's sign-in:

- [Claude](platforms/claude.md)
- [ChatGPT](platforms/chatgpt.md)
- [Grok](platforms/grok.md)
- [Any other MCP client with OAuth](platforms/other.md): give it the address above; it discovers everything else.

When the platform opens the consent screen of your workspace:

1. Sign in with your passkey if asked.
2. Check the platform name and the address it will return to.
3. Give the connection a name you will recognise (for example "Claude on my phone") and choose **Approve**.

The connection then appears on **Connections** with its last activity. There you confirm the roles the platform may act as and, when several named bots share one platform, add each of them as an agent with its own roles. **Revoke** cuts it off at once. If a connection fails, open **Diagnostics** on the same screen: every step of each attempt is recorded there without secrets.

## 3. Fill the workspace

The workspace starts empty. Either:

- tell the connected agent: *"This is my workspace. Call `start` and fill it from what you know about me: working rules, roles, projects, documents and open tasks."* The agent sees instructions for an empty workspace in `start` and builds it through MCP; or
- create roles, projects, documents and tasks yourself in the web interface, and write the working rules under **More → Working rules**.

For each new platform afterwards, connect it and say: *"This is my workspace, call `start` with your role and continue from there."* A ready-made instruction to paste into a platform is in [agent-instruction.md](agent-instruction.md).

## 4. Watch what agents change

Agents change the workspace directly, without asking you. The **Changes** tab shows everything changed since your last visit: who, when and exactly what, line by line, with a one-tap rollback. Changes to working rules and role instructions come first, because they change how every later session behaves. **Mark all reviewed** clears the list. After a very busy stretch (more than 200 changes) the screen shows the oldest ones first; marking them reviewed shows the next ones, so nothing is skipped.

## If you lose your passkey

Ask whoever runs the server (or do it yourself on the server) to print a recovery code:

```sh
docker compose stop workspace
docker compose run --rm workspace cli recovery-code
docker compose start workspace
```

Open `https://<your address>/setup`, enter the code and register a new passkey for the same owner. The workspace and its connections are unchanged; remove the lost passkey under **More → Passkeys**.
