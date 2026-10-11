# Tiny Miner Android webshell

Generated with `bun x solana-mobile@latest webshell init` (CLI 0.5.0).
The Kotlin WebView loads `http://localhost:5173/`; application ID is
`dev.beeman.tinyminer`, version code `1`, version name `0.1.0`.

## Local USB development

This shell requires the computer's frontend and backend plus USB forwarding.
It does not bundle the web app or introduce hosting.

1. Install web dependencies with `bun install` from the repository root.
2. Configure the ignored root `.env` using `.env.example`. Set
   `BETTER_AUTH_URL=http://localhost:5173` and a locally generated
   `BETTER_AUTH_SECRET` of at least 32 characters.
3. Run `bun run dev:server` and `bun run dev --host 127.0.0.1` in separate terminals.
4. Forward the frontend port to the connected Seeker:

   ```bash
   bun x solana-mobile@latest device open http://localhost:5173 --device <serial>
   ```

   This also opens the URL in the phone's browser. Launch **Tiny Miner** separately
   to test the installed shell. Repeat forwarding after reconnecting USB.

The shell requests `/api` on the frontend origin. Vite proxies it to Hono at
`http://127.0.0.1:3001`; SQLite remains on the computer. Cookies and wallet origin
use `localhost:5173`, so `BETTER_AUTH_URL` must match exactly. The generated
network security configuration permits HTTP only for localhost and 127.0.0.1.

## Build and install

The generated `twa-manifest.json` references `android.keystore` in this directory,
with alias `android`. The keystore is ignored. Keep signing passwords in local
environment variables, never in tracked files. For this development build, the
password is stored in the ignored root `.env.webshell.local`.

From the repository root:

```bash
set -a
source .env.webshell.local
set +a
bun x solana-mobile@latest webshell build ./webshell
bun x solana-mobile@latest device install ./webshell/app/build/outputs/apk/release/app-release.apk --device <serial>
```

A fresh checkout needs its own local development keystore and passwords. Generate
one using `keytool` or regenerate the shell in a separate directory with the CLI,
then copy only the keystore here. Keep the same signing key for app updates.

The CLI builds a signed release APK at
`app/build/outputs/apk/release/app-release.apk`. Build output and signing secrets
are ignored. The generated shell handles wallet intents, persistent WebView
storage, external links, and pull-to-refresh.

For a standalone deployment, configure a hosted HTTPS URL in
`gradle.properties` (`SOLANA_MOBILE_URL`), keep the manifest URL metadata in sync,
and serve the frontend and `/api` on that same origin with a matching
`BETTER_AUTH_URL`. Hosting is outside this development PR.

## Verification

The signed release APK was built with CLI 0.5.0 and installed on a physical
Seeker. Mobile Wallet Adapter connected the test wallet, server sign-in succeeded,
and two rock taps saved count 2 in SQLite. Returning from Home preserved the
active session and count. After an immediate force-stop/relaunch the wallet
reconnected, but the server session was unavailable; signing in again restored
count 2. Automatic server-session restoration after process termination remains
a limitation of this tested shell. No compatibility fix was added.

Web build, lint, formatting, server typecheck, and all five backend tests passed.
