# Keycloak on Coolify — Complete Setup & Integration Guide

This guide walks you through configuring your already-deployed Keycloak 26.1 instance
(hosted on Coolify / Contabo VPS) so it works as the OIDC identity provider for the
**Meet** application.

---

## Table of Contents

1. [Reference Values](#1-reference-values)
2. [Verify Keycloak is Reachable](#2-verify-keycloak-is-reachable)
3. [Log In to the Admin Console](#3-log-in-to-the-admin-console)
4. [Create the `meet` Realm](#4-create-the-meet-realm)
5. [Create Realm Roles](#5-create-realm-roles)
6. [Create the `meet` OIDC Client](#6-create-the-meet-oidc-client)
7. [Configure Client Scopes](#7-configure-client-scopes)
8. [Create Test Users](#8-create-test-users)
9. [Verify the OIDC Discovery Endpoint](#9-verify-the-oidc-discovery-endpoint)
10. [Configure the Django Backend (`.env`)](#10-configure-the-django-backend-env)
11. [Test the Full Login Flow](#11-test-the-full-login-flow)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Reference Values

Keep these handy throughout the guide.

| Variable | Value |
|---|---|
| Keycloak public URL | `https://keycloak-mwss40wwos04ocko8c40wgo0.nmcyber.com` |
| Admin username | `tz0O7BaxZoLiHFmT` |
| Admin password | `RmDTVqELD85INe4Sqa6i1lkiULH0Ioxm` |
| Realm name | `meet` |
| OIDC client ID | `meet` |
| Keycloak version | `26.1` |
| PostgreSQL DB | `keycloak` |
| DB user | `3OulilBDewpW6Lus` |

> **Security note:** Rotate the admin password and client secret before exposing this
> instance to the internet beyond your own testing.

---

## 2. Verify Keycloak is Reachable

From any machine with `curl` or a browser, confirm the instance is up:

```bash
curl -s https://keycloak-mwss40wwos04ocko8c40wgo0.nmcyber.com/health/ready
```

Expected response:

```json
{"status":"UP","checks":[]}
```

Also confirm the OIDC discovery document is accessible (this URL will work **after**
you create the `meet` realm in step 4):

```bash
curl -s https://keycloak-mwss40wwos04ocko8c40wgo0.nmcyber.com/realms/meet/.well-known/openid-configuration | python3 -m json.tool | head -20
```

---

## 3. Log In to the Admin Console

1. Open your browser and navigate to:

   ```
   https://keycloak-mwss40wwos04ocko8c40wgo0.nmcyber.com/admin
   ```

2. Enter your credentials:
   - **Username:** `tz0O7BaxZoLiHFmT`
   - **Password:** `RmDTVqELD85INe4Sqa6i1lkiULH0Ioxm`

3. You will land on the **master** realm dashboard. You can see the realm selector
   in the top-left corner — it currently shows `master`.

---

## 4. Create the `meet` Realm

The Meet application expects a realm called **`meet`**. This is a hard-coded default
in the dev `realm.json` and in all OIDC endpoint paths the Django backend uses.

### 4.1 Create the realm

1. Click the realm selector (top-left, shows **master**).
2. Click **Create realm**.
3. Fill in:
   - **Realm name:** `meet`
   - **Enabled:** ON
4. Click **Create**.

You are now inside the `meet` realm. All remaining steps take place here.

### 4.2 Adjust realm token settings

1. In the left sidebar go to **Realm settings → Tokens** tab.
2. Set the following (adjust to your security requirements):

   | Setting | Recommended value |
   |---|---|
   | Access Token Lifespan | `5 minutes` (300 s) |
   | SSO Session Idle | `30 minutes` (1800 s) |
   | SSO Session Max | `10 hours` (36000 s) |
   | Offline Session Idle | `30 days` (2592000 s) |

3. Click **Save**.

### 4.3 Enable user registration (optional)

1. Go to **Realm settings → Login** tab.
2. Toggle **User registration** ON if you want users to self-register.
3. Toggle **Login with email** ON.
4. Click **Save**.

---

## 5. Create Realm Roles

The Meet backend checks for a `user` role on tokens.

1. Go to **Realm roles** in the left sidebar.
2. Click **Create role**.
3. **Role name:** `user`
4. Click **Save**.

---

## 6. Create the `meet` OIDC Client

This is the most important step. The Django backend authenticates users through this
client.

### 6.1 Create the client

1. Go to **Clients** → **Create client**.
2. **Client type:** `OpenID Connect`
3. **Client ID:** `meet`
4. Click **Next**.

### 6.2 Capability config

| Setting | Value |
|---|---|
| Client authentication | **ON** (confidential client — required for a server-side Django app) |
| Authorization | OFF |
| Standard flow | **ON** |
| Implicit flow | OFF |
| Direct access grants | OFF |
| Service accounts roles | OFF |

Click **Next**.

### 6.3 Login settings

Replace `https://your-meet-domain.example.com` with your actual Meet frontend/backend
URLs. Use the real URLs below and add more rows as needed.

| Setting | Value(s) |
|---|---|
| Root URL | *(leave blank)* |
| Home URL | *(leave blank)* |
| Valid redirect URIs | `https://your-meet-frontend.example.com/*` and `https://your-meet-backend.example.com/*` |
| Valid post-logout redirect URIs | `https://your-meet-frontend.example.com/*` |
| Web origins | `https://your-meet-frontend.example.com` |

> For local development add `http://localhost:3000/*`, `http://localhost:8071/*`, etc.

Click **Save**.

### 6.4 Copy the client secret

1. After saving, open the **Credentials** tab.
2. Copy the value under **Client secret** — you will need it for `OIDC_RP_CLIENT_SECRET`
   in the Django `.env` file.
3. Optionally click **Regenerate** to create a fresh secret, then copy the new value.

### 6.5 Set the access token lifespan (optional)

1. Open the **Advanced** tab of the client.
2. Under **Advanced settings**, set **Access Token Lifespan** to `-1` (inherit from realm)
   or a specific number of seconds.
3. Click **Save**.

---

## 7. Configure Client Scopes

The Meet backend needs `email` and `profile` claims in the token.

### 7.1 Verify default scopes

1. On the `meet` client, open the **Client scopes** tab.
2. Confirm these scopes are listed under **Assigned default client scopes**:
   - `email`
   - `profile`
   - `roles`
   - `web-origins`
   - `acr`

   If any are missing, click **Add client scope**, find the scope, and add it as **Default**.

### 7.2 Add `sub` to token (already default — verify only)

The Django OIDC library uses `sub` as the unique user identifier. This is included by
default in Keycloak's built-in `openid` scope. No extra configuration needed.

---

## 8. Create Test Users

### 8.1 Create a user

1. Go to **Users** → **Create new user** (or **Add user** depending on the UI version).
2. Fill in:
   - **Username:** `meet`
   - **Email:** `meet@meet.world`
   - **First name:** `John`
   - **Last name:** `Doe`
   - **Email verified:** ON
3. Click **Create**.

### 8.2 Set a password

1. Open the **Credentials** tab of the user.
2. Click **Set password**.
3. Enter a password (e.g., `meet`) and confirm it.
4. Toggle **Temporary** to **OFF** (so the user is not forced to change it on first login).
5. Click **Save password**.

### 8.3 Assign the `user` role

1. Open the **Role mapping** tab of the user.
2. Click **Assign role**.
3. Filter by **realm roles**, select `user`, click **Assign**.

### 8.4 Repeat for additional test users (optional)

Create at least a second user so you can test multi-user meetings:

| Username | Email | Password |
|---|---|---|
| `alice` | `alice@example.com` | `password` |
| `bob` | `bob@example.com` | `password` |

Give both users the `user` realm role.

---

## 9. Verify the OIDC Discovery Endpoint

After completing the above steps, confirm Keycloak exposes the discovery document:

```bash
curl -s \
  https://keycloak-mwss40wwos04ocko8c40wgo0.nmcyber.com/realms/meet/.well-known/openid-configuration \
  | python3 -m json.tool
```

Key fields to verify in the response:

```json
{
  "issuer": "https://keycloak-mwss40wwos04ocko8c40wgo0.nmcyber.com/realms/meet",
  "authorization_endpoint": "https://keycloak-mwss40wwos04ocko8c40wgo0.nmcyber.com/realms/meet/protocol/openid-connect/auth",
  "token_endpoint": "https://keycloak-mwss40wwos04ocko8c40wgo0.nmcyber.com/realms/meet/protocol/openid-connect/token",
  "userinfo_endpoint": "https://keycloak-mwss40wwos04ocko8c40wgo0.nmcyber.com/realms/meet/protocol/openid-connect/userinfo",
  "jwks_uri": "https://keycloak-mwss40wwos04ocko8c40wgo0.nmcyber.com/realms/meet/protocol/openid-connect/certs",
  "end_session_endpoint": "https://keycloak-mwss40wwos04ocko8c40wgo0.nmcyber.com/realms/meet/protocol/openid-connect/logout"
}
```

Also test the JWKS endpoint (public keys used to verify JWTs):

```bash
curl -s \
  https://keycloak-mwss40wwos04ocko8c40wgo0.nmcyber.com/realms/meet/protocol/openid-connect/certs \
  | python3 -m json.tool | head -10
```

---

## 10. Configure the Django Backend (`.env`)

Edit `env.d/development/common` (or your production equivalent) and replace the
localhost Keycloak endpoints with your live URLs.

```dotenv
# ---------------------------------------------------------------------------
# OIDC — point to your Coolify-hosted Keycloak
# ---------------------------------------------------------------------------
OIDC_OP_JWKS_ENDPOINT=https://keycloak-mwss40wwos04ocko8c40wgo0.nmcyber.com/realms/meet/protocol/openid-connect/certs
OIDC_OP_AUTHORIZATION_ENDPOINT=https://keycloak-mwss40wwos04ocko8c40wgo0.nmcyber.com/realms/meet/protocol/openid-connect/auth
OIDC_OP_TOKEN_ENDPOINT=https://keycloak-mwss40wwos04ocko8c40wgo0.nmcyber.com/realms/meet/protocol/openid-connect/token
OIDC_OP_USER_ENDPOINT=https://keycloak-mwss40wwos04ocko8c40wgo0.nmcyber.com/realms/meet/protocol/openid-connect/userinfo
OIDC_OP_INTROSPECTION_ENDPOINT=https://keycloak-mwss40wwos04ocko8c40wgo0.nmcyber.com/realms/meet/protocol/openid-connect/token/introspect
OIDC_OP_URL=https://keycloak-mwss40wwos04ocko8c40wgo0.nmcyber.com/realms/meet

OIDC_RP_CLIENT_ID=meet
OIDC_RP_CLIENT_SECRET=<paste-client-secret-from-step-6.4>
OIDC_RP_SIGN_ALGO=RS256
OIDC_RP_SCOPES="openid email profile"

# The resource server (API token introspection) uses the same client
OIDC_RS_CLIENT_ID=meet
OIDC_RS_CLIENT_SECRET=<paste-client-secret-from-step-6.4>

# Redirect URLs — update to match your deployed Meet frontend/backend
LOGIN_REDIRECT_URL=https://your-meet-frontend.example.com
LOGIN_REDIRECT_URL_FAILURE=https://your-meet-frontend.example.com
LOGOUT_REDIRECT_URL=https://your-meet-frontend.example.com

OIDC_REDIRECT_ALLOWED_HOSTS=keycloak-mwss40wwos04ocko8c40wgo0.nmcyber.com,your-meet-frontend.example.com
OIDC_AUTH_REQUEST_EXTRA_PARAMS={"acr_values": "eidas1"}
```

> If you are running Meet locally against this remote Keycloak, also add
> `localhost:3000,localhost:8071` to `OIDC_REDIRECT_ALLOWED_HOSTS`.

---

## 11. Test the Full Login Flow

### 11.1 Direct browser test

Open this URL in your browser (replace the `redirect_uri` with your actual callback):

```
https://keycloak-mwss40wwos04ocko8c40wgo0.nmcyber.com/realms/meet/protocol/openid-connect/auth?client_id=meet&response_type=code&scope=openid%20email%20profile&redirect_uri=https://your-meet-backend.example.com/oidc/callback/
```

You should see the Keycloak login page. Log in with `meet` / `meet`. After login
you will be redirected to the `redirect_uri` with a `?code=...` query parameter.
This confirms the authorization flow is working.

### 11.2 Token exchange test (curl)

Exchange the code for tokens using the client credentials:

```bash
# Step 1 — get a token via Resource Owner Password Credentials (for testing only)
KC_URL="https://keycloak-mwss40wwos04ocko8c40wgo0.nmcyber.com"
REALM="meet"
CLIENT_ID="meet"
CLIENT_SECRET="<your-client-secret>"

curl -s -X POST \
  "${KC_URL}/realms/${REALM}/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password" \
  -d "client_id=${CLIENT_ID}" \
  -d "client_secret=${CLIENT_SECRET}" \
  -d "username=meet" \
  -d "password=meet" \
  -d "scope=openid email profile" \
  | python3 -m json.tool
```

A successful response looks like:

```json
{
  "access_token": "eyJhbGci...",
  "expires_in": 300,
  "refresh_expires_in": 1800,
  "refresh_token": "eyJhbGci...",
  "token_type": "Bearer",
  "id_token": "eyJhbGci...",
  "scope": "openid email profile"
}
```

### 11.3 Decode and inspect the access token

```bash
# Paste your access_token here
TOKEN="eyJhbGci..."

# Decode the payload (no verification — for inspection only)
echo "$TOKEN" | cut -d'.' -f2 | base64 -d 2>/dev/null | python3 -m json.tool
```

Verify that the payload contains:
- `"iss"`: `https://keycloak-mwss40wwos04ocko8c40wgo0.nmcyber.com/realms/meet`
- `"azp"`: `meet`
- `"email"`: `meet@meet.world`
- `"realm_access"` → `"roles"`: `["user", "offline_access", "uma_authorization"]`

### 11.4 Introspect the token (server-side verification)

```bash
curl -s -X POST \
  "${KC_URL}/realms/${REALM}/protocol/openid-connect/token/introspect" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -u "${CLIENT_ID}:${CLIENT_SECRET}" \
  -d "token=${TOKEN}" \
  | python3 -m json.tool
```

Expected: `"active": true` in the response.

### 11.5 Userinfo endpoint

```bash
curl -s \
  -H "Authorization: Bearer ${TOKEN}" \
  "${KC_URL}/realms/${REALM}/protocol/openid-connect/userinfo" \
  | python3 -m json.tool
```

Expected: JSON with `sub`, `email`, `name`, etc.

### 11.6 End-to-end: Meet app login

1. Start the Meet backend with the updated `.env`.
2. Open the Meet frontend in your browser.
3. Click **Login** — you should be redirected to the Keycloak login page.
4. Log in with `meet` / `meet`.
5. You should be redirected back to Meet and logged in.

---

## 12. Troubleshooting

### `Invalid redirect_uri`

The redirect URI used by the Django OIDC library must exactly match (including
trailing slashes) one of the **Valid Redirect URIs** configured in step 6.3.

Check what URI Django is sending:

```bash
# In the browser address bar after clicking Login, look for:
# redirect_uri=https%3A%2F%2F...
```

Decode it and add that exact value to the client's **Valid Redirect URIs** in
Keycloak.

---

### `Client not found` or `Unauthorized`

- Verify `OIDC_RP_CLIENT_ID=meet` in your `.env`.
- Verify the client exists in the **`meet`** realm (not `master`).
- Verify `OIDC_RP_CLIENT_SECRET` matches the value in **Clients → meet → Credentials**.

---

### `SSL: CERTIFICATE_VERIFY_FAILED`

Your VPS certificate is valid (Coolify manages it via Let's Encrypt). If you see
this error it means the Django container cannot reach the OIDC endpoint, or the
cert chain is incomplete.

Test reachability from inside the Django container:

```bash
docker exec -it <app-container> curl -v \
  https://keycloak-mwss40wwos04ocko8c40wgo0.nmcyber.com/realms/meet/.well-known/openid-configuration
```

---

### `Token signature verification failed`

This happens when `OIDC_RP_SIGN_ALGO` does not match the algorithm Keycloak uses.
Keycloak 26 defaults to `RS256`. Your env already has `OIDC_RP_SIGN_ALGO=RS256`
which is correct.

---

### Keycloak `403` on admin console after idle

Keycloak admin sessions expire. Simply refresh the page and log in again.

---

### `KC_PROXY_HEADERS=xforwarded` — importance

Your Coolify setup passes `KC_PROXY_HEADERS=xforwarded`. This tells Keycloak to
trust `X-Forwarded-For` and `X-Forwarded-Proto` headers from the Coolify reverse
proxy. Without this, Keycloak would generate token issuer URLs with `http://`
instead of `https://`, breaking signature verification. Confirm the Coolify proxy
is actually setting these headers if you see issuer URL mismatches.

---

### Health check endpoints

| Endpoint | Expected |
|---|---|
| `/health/ready` | `{"status":"UP","checks":[]}` |
| `/health/live` | `{"status":"UP","checks":[]}` |
| `/health` | full health report |
| `/metrics` | Prometheus metrics (if `KC_METRICS_ENABLED=true`) |
