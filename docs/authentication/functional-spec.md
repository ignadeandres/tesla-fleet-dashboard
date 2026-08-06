# Functional Spec — Authentication

**Feature:** Dashboard session auth (JWT/httpOnly cookie) + Tesla account linking (OAuth)
**Status:** Already implemented and shipped. Elaborates `docs/authentication/business-requirements.md`.

## Functional Behavior

### US-1 — Register a dashboard account

**Flow**
1. User submits the register form with email and password.
2. System checks whether the submitted email equals the reserved demo account email. If so, treat as already registered (see Business rules).
3. System checks whether a user with that email already exists in the database.
4. If neither check trips, system hashes the password (bcrypt, cost factor 10) and creates a new user record.
5. System issues a session token (JWT, 30-day expiry) and sets it as an httpOnly session cookie on the response.
6. Client navigates to `/`.

**Business rules / validation**
- Email and password are required to submit the form; no minimum length, complexity, or format validation is performed beyond the browser's native "required" enforcement — the server accepts any non-empty string as a password.
- Email uniqueness is enforced at the database level (not just checked at request time), so a race between two concurrent registrations with the same email cannot both succeed.
- The reserved demo account email is rejected using the identical error and error code as a duplicate email, so it cannot be distinguished from a normal "already registered" case.

**System states**
- **Success:** session cookie set, client redirected to `/`.
- **Error (duplicate/reserved email):** registration is rejected with message "Email already registered" (code `BAD_USER_INPUT`); no user row is created; no session cookie is set; error is shown inline on the form.
- **Error (any other submission failure):** form remains on-screen with the returned error message shown inline; no navigation occurs.

---

### US-2 — Log in

**Flow**
1. User submits the login form with email and password.
2. System looks up the user by email.
3. If found, system compares the submitted password against the stored bcrypt hash.
4. If the comparison succeeds, system issues a session token (JWT, 30-day expiry) and sets the session cookie.
5. Client navigates to `/`.

**Business rules / validation**
- Whether the email doesn't exist or the password is wrong, the system returns the exact same error message ("Invalid email or password", code `UNAUTHENTICATED`) — no signal is given about which part was wrong, preventing account enumeration via the login form.
- No session cookie is set on failure.
- No throttling/lockout after repeated failed attempts (explicitly out of scope).

**System states**
- **Success:** session cookie set, redirected to `/`.
- **Error:** inline error message shown on the form; no cookie set; user stays on the login form with values retained (email/password fields are not cleared by the app, only re-rendered).

---

### US-3 — Stay logged in across visits

**Flow**
1. On every app load (full page load/refresh), the client issues a "who am I" query against the backend, bypassing any local cache (network-only), so a stale cached identity is never trusted.
2. Server reads the session cookie from the request, verifies the JWT signature and expiry.
3. If valid, server resolves the current user (including their linked vehicles) and returns it.
4. If missing, malformed, or expired, server resolves an empty/null identity — this is not treated as an error condition by this query specifically (see US-6 exception).
5. Client stores the resolution result and renders accordingly.

**Business rules / validation**
- JWT expiry defaults to 30 days from issuance; after that point, verification fails and is treated identically to "no cookie present" — the session simply lapses, no distinct "session expired" messaging exists.
- There is no server-side session revocation: a still-valid (non-expired) token remains usable even after logout on another device/browser, since logout only clears the cookie on the client that called it.

**System states**
- **Loading:** while the identity check is in flight, the app shows a loading indicator; neither the login page nor any protected/dashboard content is rendered during this window.
- **Success (valid session):** protected route tree is rendered with the resolved user and vehicle list available.
- **Empty/unauthenticated (no session, invalid session, or expired session):** identity resolves to null/none; app falls back to the login page.

---

### US-4 — Log out

**Flow**
1. User triggers logout.
2. Server clears the session cookie on the response.
3. Client re-runs the identity check (same network-only query as on load).
4. Identity resolves to null; UI reverts to the login page.

**Business rules / validation**
- Logout only invalidates the local browser cookie. It does not revoke or otherwise interact with any linked Tesla OAuth grant — a previously linked Tesla account remains linked and its stored tokens remain valid/usable server-side.
- There is no "log out of all sessions" capability; a JWT copied elsewhere (e.g., another browser) remains valid until its own 30-day expiry regardless of this logout action.

**System states**
- **Success:** cookie cleared, identity check returns null, login page rendered.
- No distinct error state is defined for logout in the current behavior — it clears the cookie unconditionally.

---

### US-5 — Route access gated by auth state

**Flow**
1. On every render, the app checks the current auth loading/identity state (see US-3).
2. While loading: show loading indicator only, regardless of URL.
3. Once resolved, branch:
   - **No identity:** render only the unauthenticated route set — login form for every path (register form specifically at the register path), regardless of what path was typed in the browser. No dashboard/vehicle route is reachable by directly typing its URL while unauthenticated.
   - **Identity present:** render only the authenticated route set (vehicles list, per-vehicle pages, etc.). This route set has no dedicated login path; if the browser is navigated to a login-style path while authenticated, it doesn't match any authenticated route and falls through to the catch-all, which redirects to `/`.
4. The root path `/` is not a page itself — it always redirects: to the authenticated user's first linked vehicle's overview page if they have at least one vehicle linked, otherwise to the vehicles list page.

**Business rules / validation**
- Auth state (not URL) is the sole gate for which route tree is available — there is no per-route guard to bypass, since unauthenticated users literally cannot reach authenticated route components.
- The "first vehicle" used for the `/` redirect is determined by the order vehicles come back with the user's identity (no user-configurable "default vehicle" concept exists).

**System states**
- **Loading:** spinner only, no route content of either kind is shown (avoids a login-page flash for an already-authenticated returning user).
- **Unauthenticated:** login (or register) form only, for any URL.
- **Authenticated, has vehicles:** redirected to first vehicle's overview.
- **Authenticated, no vehicles:** redirected to the vehicles list, which itself shows an empty state (see US-10).

---

### US-6 — Protected GraphQL operations reject unauthenticated requests

**Flow**
1. For each protected operation (fetching a specific vehicle, triggering a refresh of a vehicle's data), the resolver first checks whether the request context carries an authenticated user (derived from the same session-cookie verification as US-3).
2. If no authenticated user is present, the operation is rejected immediately before any further logic (e.g., vehicle lookup) runs.
3. If a user is present, the operation proceeds using that user's identity for subsequent ownership checks (US-7).

**Business rules / validation**
- The identity ("who am I") lookup is explicitly exempted from this rule: it returns an empty/null result for unauthenticated requests instead of throwing, since it's the mechanism the client uses to determine auth state in the first place (US-3) — it must be callable without a session.
- Every other protected operation throws a generic "Not authenticated" error (code `UNAUTHENTICATED`) with no further detail.

**System states**
- **Authenticated request:** operation proceeds to its normal logic/ownership checks.
- **Unauthenticated request (protected operation):** request fails immediately with "Not authenticated".
- **Unauthenticated request (identity query):** succeeds and returns an empty/null result — not an error state.

---

### US-7 — Users can only access their own vehicles

**Flow**
1. For an operation targeting a specific vehicle (fetch vehicle detail, trigger refresh), after confirming the requester is authenticated (US-6), the system loads the target vehicle record by its identifier.
2. System compares the loaded vehicle's owning user against the requesting user's identity.
3. If the vehicle doesn't exist at all, or it exists but belongs to a different user, the operation is rejected the same way in both cases.
4. Only if the vehicle exists and belongs to the requesting user does the operation proceed with the vehicle's data.

**Business rules / validation**
- Non-existence and "belongs to someone else" are deliberately collapsed into a single outcome ("Vehicle not found", code `NOT_FOUND`) rather than distinguished (e.g., via a "forbidden" code), so a user cannot use the error type/message to probe whether a given vehicle ID exists and is simply owned by someone else.
- This ownership check is applied uniformly to both read (fetch vehicle) and write-adjacent (trigger refresh) operations that take a vehicle identifier — there is no operation that accepts a vehicle ID and skips the ownership check.

**System states**
- **Owned vehicle:** operation proceeds normally.
- **Vehicle doesn't exist:** rejected with "Vehicle not found".
- **Vehicle exists but owned by another user:** rejected with the identical "Vehicle not found" message/code — indistinguishable from the previous case from the caller's perspective.

---

### US-8 — Initiate Tesla account linking

**Flow**
1. User triggers linking from the vehicles page via a plain link (full page navigation, not an in-app API call) — necessary because the destination of this flow is eventually Tesla's own site, which a client-side data call cannot navigate the browser to.
2. Server receives the request and first verifies the caller has a valid dashboard session cookie (same verification as US-3/US-6).
3. If the session is missing or invalid, the server redirects the browser to the login page with an indicator that authentication is required, and the flow stops — Tesla is never contacted.
4. If the session is valid, the server generates a short-lived, signed token (10-minute expiry) that encodes the dashboard user's identity. This token is not stored server-side; it is entirely self-verifying when it comes back on the callback.
5. Server redirects the browser to Tesla's authorization page, requesting the specific scopes needed (device data and location access, plus offline/refresh-token access) and passing along the signed token as the OAuth "state" parameter.

**Business rules / validation**
- The link-initiation entry point is only reachable by a full-page browser navigation (not a background/API call), by necessity of ending in a third-party redirect.
- Requiring a valid dashboard session before contacting Tesla ensures an unauthenticated visitor can never start (or be tricked into starting) a linking flow.
- The signed state token serves two purposes at once: it tells the callback which dashboard user to attribute the linked vehicle(s) to, and it acts as CSRF protection (only a token this server signed will verify successfully), without needing to persist any pending-link record.
- The control to trigger this is not shown at all to a demo-mode user (demo mode itself is out of scope, but this gating exists in the vehicles page today).

**System states**
- **Authenticated user:** browser is redirected onward to Tesla's authorization screen.
- **Unauthenticated user (missing/invalid session):** browser is redirected to the login page with an "authentication required" indicator; nothing is sent to Tesla.

---

### US-9 — Complete Tesla OAuth callback and auto-provision vehicles

**Flow**
1. Tesla redirects the browser back to the callback endpoint with an authorization code and the state value that was originally generated in US-8.
2. Server verifies that both the code is present and the state successfully verifies (correct signature, not expired — 10 minutes).
3. If either check fails, server redirects to the vehicles page with an "invalid request" link-error indicator and performs no database writes.
4. If both checks pass, server extracts the dashboard user's identity from the verified state and exchanges the authorization code with Tesla for an access/refresh token pair.
5. Server fetches the list of vehicles associated with the now-linked Tesla account.
6. For each vehicle returned by Tesla:
   - Server checks whether a vehicle record already exists for that Tesla vehicle identifier (e.g., from a prior linking, possibly by a different dashboard user or a previous link by this same user).
   - If none exists, a new vehicle record is created, attributed to the dashboard user from the verified state, capturing VIN and display name (no model is set at this stage).
   - If one already exists, it is reused as-is (not reattributed to the current user).
   - Regardless of new/existing vehicle, the vehicle's stored Tesla token pair and expiry are written/updated (an existing token record for that vehicle is overwritten rather than duplicated) — so re-linking the same account refreshes credentials rather than creating redundant records.
7. On completion of all vehicles, server redirects to the vehicles page with a success indicator.
8. If the code exchange or the vehicle-list fetch fails partway through, the server logs the underlying error for operators, and redirects to the vehicles page with a generic "exchange failed" link-error indicator — no details about which step failed, or how many vehicles (if any) were processed before the failure, are exposed to the browser.

**Business rules / validation**
- Both `code` and a valid `state` are required; failing either check short-circuits before any Tesla API call or database write.
- Re-linking the same Tesla account is idempotent for vehicles: existing vehicle rows are not duplicated, only their token credentials are refreshed.
- If Tesla's account has zero vehicles, the loop simply does nothing and the flow still redirects with the success indicator (no vehicles were added, but this isn't surfaced as a distinct case from a normal successful link).
- No re-authentication or re-confirmation step exists between initiating the link (US-8) and this callback completing — trust is placed entirely in the signed, time-limited state token.
- Failure detail is deliberately generic in the redirect (a single error code) — the underlying exception message/stack is only available in server logs, not the response.

**System states**
- **Success (invalid_request avoided, exchange succeeds):** vehicles created/reused and tokens stored, redirected to vehicles page with success indicator.
- **Success, zero vehicles on the Tesla account:** no vehicle rows written, still redirected to vehicles page with success indicator.
- **Error — invalid request (missing code, or state missing/invalid/expired):** no writes performed, redirected to vehicles page with "invalid_request" error indicator.
- **Error — exchange/API failure (token exchange or vehicle fetch throws):** partial writes possible only for vehicles already processed before the failure in that single pass; error logged server-side; redirected to vehicles page with "exchange_failed" error indicator.

---

### US-10 — See link result feedback

**Flow**
1. Vehicles page loads and reads the link-related indicators carried on its URL (set by the redirects in US-9).
2. If a success indicator is present, a success message is displayed on the page ("Vehicle linked.").
3. If an error indicator is present, an error message is displayed that includes the specific error code from the URL ("Linking failed (`<code>`). Try again."), covering both the `invalid_request` and `exchange_failed` cases with the same message template, just a different embedded code.
4. If neither indicator is present (normal navigation to the vehicles page, not arriving from the OAuth callback), no such message is shown.

**Business rules / validation**
- Feedback is purely a reflection of URL state at page load — it is not derived from any persisted "last link attempt" record, so refreshing the page after arriving with these indicators would still show the message again (URL params persist across refresh) but revisiting the page later via normal navigation (without the params) will not show it.
- The two distinct failure codes (`invalid_request`, `exchange_failed`) are shown to the user via the same generic message shape; the code itself is the only differentiator visible, with no user-facing explanation of what either code specifically means.

**System states**
- **Empty (no vehicles, no link params):** page shows "No vehicles linked yet." and the option to start linking (subject to the demo-mode gating noted in US-8).
- **Empty with vehicles present:** vehicle list is shown instead of the empty message.
- **Success feedback:** success alert shown in addition to whatever vehicle list state applies.
- **Error feedback:** error alert (with embedded code) shown in addition to whatever vehicle list state applies.

## User Flow

### 1. First-time visit / registration

- **Entry point:** any URL, unauthenticated browser (no valid session).
- App mounts → `AuthProvider` fires `ME_QUERY` (network-only) → `App.jsx` renders a centered `CircularProgress` spinner while `auth.loading` is true.
- Query resolves with `me: null` → `auth.user` is `null` → route tree collapses to two routes, both rendering `LoginPage`: `/register` → `LoginPage register` (register mode), everything else (`*`) → `LoginPage` (login mode). There is no dedicated registration screen component — it's the same form with a `register` boolean toggling copy, submit handler, and the footer link.
- On `LoginPage`, user toggles between modes via the footer `Link` (`/login` ↔ `/register`).
- **Register submit:** `auth.register(email, password)` → `REGISTER_MUTATION` → on success, `refetch()` on `ME_QUERY` → `AuthProvider` re-renders with `user` populated → `LoginPage`'s own `navigate("/")` fires.
- **Exit point:** `/` now hits `HomeRedirect` inside the authenticated tree → new user has zero linked vehicles → redirects to `/vehicles`, landing on `VehiclesPage` in its empty state ("No vehicles linked yet.").
- **Error state:** mutation throws (e.g., duplicate email) → caught in `LoginPage.handleSubmit` → inline `Alert severity="error"` rendered above the form with `err.message`; user stays on the same screen, no navigation occurs, form fields retain their values.

### 2. Returning login

- **Entry point:** same as above — unauthenticated visit lands on `LoginPage` (login mode by default, since any non-`/register` path matches `*`).
- Submit → `auth.login(email, password)` → `LOGIN_MUTATION` → `refetch()` → same success path as registration: `user` populates, `navigate("/")` fires, `HomeRedirect` evaluates `auth.user.vehicles[0]`.
- **Exit points diverge by account state:**
  - Has ≥1 linked vehicle → redirected straight to `/v/{firstVehicleId}/overview` inside `Layout`.
  - Has 0 linked vehicles → redirected to `/vehicles`.
- **Error state:** identical inline `Alert` treatment as registration (bad credentials, etc.) — user remains on `LoginPage`.

### 3. Session persistence across reload

- **Entry point:** any reload/direct URL hit while a valid session cookie/token exists.
- `AuthProvider` re-fires `ME_QUERY` from scratch on every mount (network-only, no cache reuse) → spinner shown during `auth.loading`.
- Resolves with populated `me` → `App.jsx` renders the full authenticated `Routes` tree under `Layout`, and the router resolves whatever path was actually requested (deep link into `/v/:vehicleId/trips`, etc. works directly — reload does not force a redirect to `/`, only `/` itself routes through `HomeRedirect`).
- **Exit point:** none distinct from the requested route rendering normally; if the session is invalid/expired, `me` resolves `null` and the user is dropped back to `LoginPage` regardless of what path they reloaded on (the `*` catch-all in the unauthenticated branch swallows the original path).

### 4. Logout

- **Entry point:** logout `Button` in `Layout` header (`frontend/src/components/Layout.jsx:37`), available on any authenticated screen.
- Click → `auth.logout()` → `LOGOUT_MUTATION` → `refetch()` on `ME_QUERY`.
- `me` resolves `null` → `App.jsx` swaps the entire route tree back to the unauthenticated branch → user lands on `LoginPage` (login mode, via `*`) regardless of what screen they logged out from. No confirmation dialog, no intermediate "logged out" screen — it's a direct, synchronous bounce.
- **Exit point:** `LoginPage`, ready for flow 2 (returning login) again.

### 5. Tesla account linking round-trip

- **Entry point:** `VehiclesPage`, "Link Tesla Account" button — only rendered when `!auth.user.isDemo` (`frontend/src/pages/VehiclesPage.jsx:29`). This is a plain `<a href="/auth/tesla/login">` via MUI `Button component="a"`, i.e. a **full page navigation**, not a client-side route or fetch call.
- **This leaves the SPA entirely:** browser does a hard navigation to the backend, which redirects server-side to Tesla's OAuth consent screen (outside app control — Tesla's UI/states are not part of this app's flow to specify).
- Tesla redirects back to the backend's `/auth/tesla/callback` (also outside SPA), which performs a server-side redirect back **into** the SPA at one of two states:
  - Success: `/vehicles?linked=1`
  - Failure: `/vehicles?linkError=<code>`
- Browser re-loads the SPA fresh at that URL → same bootstrap as any reload: spinner during `ME_QUERY`, then (since session persisted) the authenticated tree renders `VehiclesPage` again.
- `VehiclesPage` reads `useSearchParams()` and renders one of two states purely from the query string, independent of `auth.user` data freshness:
  - `linked` present → `Alert severity="success"`: "Vehicle linked."
  - `linkError` present → `Alert severity="error"`: "Linking failed ({code}). Try again." — code surfaced directly from the query param, no mapping to friendlier copy.
  - Neither present (normal visit to `/vehicles`) → no alert, just the vehicle list / empty state.
- **Note:** the newly-linked vehicle should already be present in `vehicles` by the time this screen renders, since the hard navigation remounts `AuthProvider` and re-runs `ME_QUERY` fresh.
- **Exit points:** user either clicks a listed vehicle (→ `/v/{id}/overview`) or retries linking (error state, same button still present since `isDemo` hasn't changed).

## Implementation notes worth carrying forward

- `/register` is a real route but only reachable pre-auth; post-login it isn't part of the authenticated route tree at all, so it falls through to a redirect to `/`.
- `ME_QUERY` uses `fetchPolicy: "network-only"` — identity is always re-verified against the server, never trusted from cache.
- "Link Tesla Account" is hidden entirely for demo-mode users (`auth.user.isDemo`).

**Files consulted** (read-only, not modified): see file lists in `docs/authentication/business-requirements.md`, plus `frontend/src/components/Layout.jsx`.
