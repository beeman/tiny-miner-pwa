# Backend Session Implementation Plan

**Goal:** Authenticate the connected wallet into a persistent server session and show its identity with sign-out.

**Architecture:** Hono delegates authentication to Better Auth with the Solana plugin. Drizzle stores users, wallet identities, challenges, and sessions in local SQLite. Vite proxies `/api` to the backend so browser requests use same-origin cookies.

**Tech Stack:** Bun, Hono, Better Auth, better-auth-solana, Drizzle, SQLite, and the existing React Query and wallet controls.

1. Add the required backend dependencies, SQLite schema and migration, server configuration, and protected identity endpoint.
2. Add a client session control that requests a server challenge, signs it with the connected account, verifies it on the server, restores the session, and signs out.
3. Test signature and challenge validation, unauthenticated rejection, session persistence, and sign-out with real cryptographic signatures and SQLite.
4. Run build, lint, formatting, backend typecheck, and browser checks where available.
5. Package one commit and a separate PR. Reference: https://github.com/solana-mobile/templates/pull/8 at revision `53c93c6351d50c80f4c407fd88a47f6d79aa9419`.
