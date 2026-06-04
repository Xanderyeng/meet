# Local Deployment of LaSuite Meet on WSL2 (Windows)

This guide walks through running Meet locally on Windows using WSL2 and Docker Desktop.
It uses Cloudflare Tunnel for HTTPS — since you already have `cloudflared` running, this
is the fastest path to a working local instance with real SSL certificates and no
self-signed cert headaches.

---

## What You'll End Up With

| Service | Local URL | Public URL (via Cloudflare Tunnel) |
|---|---|---|
| Meet app | `http://localhost:8080` | `https://meet-local.cyberseclaunchpad.com` |
| Keycloak | `http://localhost:8081` | `https://id-local.cyberseclaunchpad.com` |
| LiveKit | `http://localhost:7880` | `https://livekit-local.cyberseclaunchpad.com` |
| MinIO console | `http://localhost:9001` | `https://s3-local.cyberseclaunchpad.com` |

> You can use any subdomain names you like. The `-local` suffix keeps them distinct
> from your production services.

---

## Prerequisites

### 1. Windows Requirements

- Windows 10/11 with WSL2 enabled
- [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop/) installed with **WSL2 backend** enabled
- A Cloudflare account with `cyberseclaunchpad.com` already managed there

### 2. Enable WSL2 Integration in Docker Desktop

1. Open Docker Desktop → Settings → Resources → WSL Integration
2. Enable integration for your WSL2 distro (Ubuntu)
3. Apply & Restart

### 3. Verify Docker Works in WSL2

Open your WSL2 terminal and run:

```bash
docker --version
docker compose version
```

Both should return version numbers. If not, restart Docker Desktop and try again.

---

## Step 1: Create the Working Directory

In your WSL2 terminal:

```bash
mkdir -p ~/meet/{data/db,data/minio}
cd ~/meet
```

All config files and the compose file live here. Volume data is stored in `~/meet/data/`.

---

## Step 2: Create Config Files

### LiveKit Server Config

```bash
cat > ~/meet/livekit-server.yaml << 'EOF'
port: 7880
redis:
  address: redis:6379
keys:
  meet: REPLACE_WITH_LIVEKIT_API_SECRET
rtc:
  udp_port: 7882
  tcp_port: 7881
  use_external_ip: false
EOF
```

> `use_external_ip: false` is required for WSL2 — there is no public IP to discover via
> STUN. WebRTC will use the local network IP instead, which works fine for same-machine
> testing.

### Nginx Config

```bash
cat > ~/meet/nginx.conf << 'EOF'
upstream meet_backend {
    server backend:8000 fail_timeout=0;
}

server {
    listen 8080;
    server_name localhost;
    server_tokens off;

    root /usr/share/nginx/html;

    location @proxy_to_meet_backend {
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_redirect off;
        proxy_pass http://meet_backend;
    }

    location /api {
        try_files $uri @proxy_to_meet_backend;
    }

    location /admin {
        try_files $uri @proxy_to_meet_backend;
    }

    location /static {
        try_files $uri @proxy_to_meet_backend;
    }

    location / {
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache, no-store, must-revalidate";
        add_header Pragma "no-cache";
        add_header Expires 0;
    }

    error_page 404 =200 /index.html;
}
EOF
```

### Egress Config

**Create this file before running `docker compose up`** — if it does not exist, Docker
creates a directory at the mount point and the egress container crashes in a restart loop.

```bash
cat > ~/meet/egress.yaml << 'EOF'
api_key: meet
api_secret: REPLACE_WITH_LIVEKIT_API_SECRET
ws_url: wss://livekit-local.cyberseclaunchpad.com
redis:
  address: redis:6379
s3:
  access_key: REPLACE_WITH_MINIO_USER
  secret: REPLACE_WITH_MINIO_PASSWORD
  endpoint: http://minio:9000
  bucket: recordings
EOF
```

Replace the placeholders — `LIVEKIT_API_SECRET` must match exactly what is in
`livekit-server.yaml` and your `.env` file.

---

## Step 3: Generate Secrets

Run these in your WSL2 terminal to generate secure values:

```bash
echo "DJANGO_SECRET_KEY:"
python3 -c "import secrets; print(secrets.token_urlsafe(50))"

echo "LIVEKIT_API_SECRET:"
python3 -c "import secrets; print(secrets.token_urlsafe(32))"

echo "DB_PASSWORD:"
python3 -c "import secrets; print(secrets.token_urlsafe(24))"

echo "MINIO_PASSWORD:"
python3 -c "import secrets; print(secrets.token_urlsafe(24))"
```

Save these — you will need them in the next step.

---

## Step 4: Create the Environment File

```bash
cat > ~/meet/.env << 'EOF'
# Domains — update these to match your Cloudflare Tunnel subdomains
MEET_HOST=meet-local.cyberseclaunchpad.com
KEYCLOAK_HOST=id-local.cyberseclaunchpad.com
LIVEKIT_HOST=livekit-local.cyberseclaunchpad.com
REALM_NAME=meet

# Secrets — paste the values generated in Step 3
DJANGO_SECRET_KEY=REPLACE_ME
LIVEKIT_API_SECRET=REPLACE_ME
DB_PASSWORD=REPLACE_ME
OIDC_CLIENT_SECRET=REPLACE_AFTER_KEYCLOAK_SETUP

# Keycloak admin
KEYCLOAK_ADMIN_PASSWORD=REPLACE_ME

# MinIO
MINIO_USER=minioadmin
MINIO_PASSWORD=REPLACE_ME

# Email (Postmark — optional for local testing, safe to leave as-is)
SMTP_HOST=smtp.postmarkapp.com
SMTP_PORT=587
SMTP_USER=REPLACE_WITH_POSTMARK_TOKEN
SMTP_PASSWORD=REPLACE_WITH_POSTMARK_TOKEN
SMTP_FROM=noreply@cyberseclaunchpad.com
EOF
```

Edit the file to fill in your generated values:

```bash
nano ~/meet/.env
```

> **OIDC_CLIENT_SECRET** cannot be set yet — you get it from Keycloak after the first
> deploy. Leave it as `REPLACE_AFTER_KEYCLOAK_SETUP` for now and update it in Step 8.

---

## Step 5: Docker Compose File

```bash
cat > ~/meet/docker-compose.yml << 'COMPOSEOF'
services:
  postgresql:
    image: postgres:16
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -d $${POSTGRES_DB} -U $${POSTGRES_USER}"]
      interval: 1s
      timeout: 2s
      retries: 300
    environment:
      POSTGRES_DB: meet
      POSTGRES_USER: meet
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - ./data/db:/var/lib/postgresql/data

  redis:
    image: redis:7

  keycloak:
    image: quay.io/keycloak/keycloak:26.1
    command: start-dev
    environment:
      KC_DB: dev-mem
      KC_HOSTNAME: id-local.cyberseclaunchpad.com
      KC_HTTP_ENABLED: "true"
      KC_HOSTNAME_STRICT_HTTPS: "false"
      KC_PROXY: edge
      KEYCLOAK_ADMIN: admin
      KEYCLOAK_ADMIN_PASSWORD: ${KEYCLOAK_ADMIN_PASSWORD}
    ports:
      - "8081:8080"

  livekit:
    image: livekit/livekit-server:latest
    command: --config /config.yaml
    ports:
      - "7880:7880"
      - "7881:7881/tcp"
      - "7882:7882/udp"
    volumes:
      - ./livekit-server.yaml:/config.yaml
    depends_on:
      - redis

  backend:
    image: lasuite/meet-backend:latest
    restart: always
    environment:
      DJANGO_ALLOWED_HOSTS: ${MEET_HOST}
      DJANGO_SECRET_KEY: ${DJANGO_SECRET_KEY}
      DJANGO_SETTINGS_MODULE: meet.settings
      DJANGO_CONFIGURATION: Production
      PYTHONPATH: /app
      DB_HOST: postgresql
      DB_NAME: meet
      DB_USER: meet
      DB_PASSWORD: ${DB_PASSWORD}
      DB_PORT: "5432"
      REDIS_URL: redis://redis:6379/1
      # Server-side OIDC calls use the Docker service name
      OIDC_OP_JWKS_ENDPOINT: http://keycloak:8080/realms/${REALM_NAME}/protocol/openid-connect/certs
      OIDC_OP_TOKEN_ENDPOINT: http://keycloak:8080/realms/${REALM_NAME}/protocol/openid-connect/token
      OIDC_OP_USER_ENDPOINT: http://keycloak:8080/realms/${REALM_NAME}/protocol/openid-connect/userinfo
      OIDC_OP_LOGOUT_ENDPOINT: http://keycloak:8080/realms/${REALM_NAME}/protocol/openid-connect/logout
      # Browser-facing redirect uses the public Cloudflare Tunnel URL
      OIDC_OP_AUTHORIZATION_ENDPOINT: https://${KEYCLOAK_HOST}/realms/${REALM_NAME}/protocol/openid-connect/auth
      OIDC_RP_CLIENT_ID: meet
      OIDC_RP_CLIENT_SECRET: ${OIDC_CLIENT_SECRET}
      OIDC_RP_SIGN_ALGO: RS256
      OIDC_RP_SCOPES: "openid email"
      LOGIN_REDIRECT_URL: https://${MEET_HOST}
      LOGIN_REDIRECT_URL_FAILURE: https://${MEET_HOST}
      LOGOUT_REDIRECT_URL: https://${MEET_HOST}
      OIDC_REDIRECT_ALLOWED_HOSTS: '["https://${MEET_HOST}"]'
      LIVEKIT_API_KEY: meet
      LIVEKIT_API_SECRET: ${LIVEKIT_API_SECRET}
      LIVEKIT_API_URL: https://${LIVEKIT_HOST}
      MEET_BASE_URL: https://${MEET_HOST}
      ALLOW_UNREGISTERED_ROOMS: "False"
      RECORDING_ENABLE: "true"
      AWS_S3_ENDPOINT_URL: http://minio:9000
      AWS_S3_ACCESS_KEY_ID: ${MINIO_USER}
      AWS_S3_SECRET_ACCESS_KEY: ${MINIO_PASSWORD}
      AWS_STORAGE_BUCKET_NAME: recordings
      DJANGO_EMAIL_HOST: ${SMTP_HOST}
      DJANGO_EMAIL_HOST_USER: ${SMTP_USER}
      DJANGO_EMAIL_HOST_PASSWORD: ${SMTP_PASSWORD}
      DJANGO_EMAIL_PORT: ${SMTP_PORT}
      DJANGO_EMAIL_FROM: ${SMTP_FROM}
      DJANGO_EMAIL_USE_TLS: "true"
      DJANGO_EMAIL_BRAND_NAME: Meet
      DJANGO_EMAIL_LOGO_IMG: https://${MEET_HOST}/assets/logo-suite-numerique.png
    healthcheck:
      test: ["CMD", "python", "manage.py", "check"]
      interval: 15s
      timeout: 30s
      retries: 20
      start_period: 10s
    depends_on:
      postgresql:
        condition: service_healthy
      redis:
        condition: service_started
      keycloak:
        condition: service_started
      livekit:
        condition: service_started

  frontend:
    image: lasuite/meet-frontend:latest
    entrypoint: ["/docker-entrypoint.sh"]
    command: ["nginx", "-g", "daemon off;"]
    ports:
      - "8080:8080"
    environment:
      MEET_HOST: ${MEET_HOST}
      BACKEND_INTERNAL_HOST: backend
      FRONTEND_INTERNAL_HOST: frontend
      LIVEKIT_INTERNAL_HOST: livekit
    volumes:
      - ./nginx.conf:/etc/nginx/conf.d/default.conf
    depends_on:
      backend:
        condition: service_healthy

  minio:
    image: quay.io/minio/minio:latest
    command: server /data --console-address ":9001"
    ports:
      - "9000:9000"
      - "9001:9001"
    environment:
      MINIO_ROOT_USER: ${MINIO_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_PASSWORD}
    volumes:
      - ./data/minio:/data
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 5s
      timeout: 20s
      retries: 10

  egress:
    image: livekit/egress:latest
    environment:
      EGRESS_CONFIG_FILE: /config.yaml
    volumes:
      - ./egress.yaml:/config.yaml
    depends_on:
      - livekit
      - redis
      - minio
COMPOSEOF
```

---

## Step 6: Set Up Cloudflare Tunnels

You need four tunnel routes — one per public-facing service.

### In the Cloudflare Zero Trust dashboard

1. Go to [one.dash.cloudflare.com](https://one.dash.cloudflare.com) → Networks → Tunnels
2. Find your existing tunnel → click **Configure** → **Public Hostname** tab
3. Add these four routes:

| Subdomain | Domain | Type | URL |
|---|---|---|---|
| `meet-local` | `cyberseclaunchpad.com` | HTTP | `localhost:8080` |
| `id-local` | `cyberseclaunchpad.com` | HTTP | `localhost:8081` |
| `livekit-local` | `cyberseclaunchpad.com` | HTTP | `localhost:7880` |
| `s3-local` | `cyberseclaunchpad.com` | HTTP | `localhost:9001` |

> Cloudflare Tunnel handles HTTPS termination automatically. All four services get valid
> SSL certificates with no extra configuration.

### For LiveKit WebSocket support

The `livekit-local` route needs WebSocket passthrough. In the tunnel config for that
route, enable:
- **No TLS Verify**: on (LiveKit speaks plain HTTP internally)
- **HTTP2 Connection**: on

---

## Step 7: First Deploy

```bash
cd ~/meet
docker compose up -d
```

Watch the startup:
```bash
docker compose logs -f
```

Wait for all containers to show healthy. This takes 2–3 minutes on first run due to
image pulls and the backend health check delay.

Check status:
```bash
docker compose ps
```

All services should show `healthy` or `running`.

---

## Step 8: Configure Keycloak

### Access the admin console

Open your browser and go to `http://localhost:8081` (or `https://id-local.cyberseclaunchpad.com`).

Log in with:
- Username: `admin`
- Password: the `KEYCLOAK_ADMIN_PASSWORD` from your `.env`

### Create the Meet realm

1. Top-left dropdown → **Create realm**
2. Realm name: `meet` → **Create**

### Create the Meet client

1. **Clients** → **Create client**
2. Client type: `OpenID Connect`
3. Client ID: `meet` → **Next**
4. Enable **Client authentication** → **Next**
5. Valid redirect URIs: `https://meet-local.cyberseclaunchpad.com/*`
6. Valid post logout redirect URIs: `https://meet-local.cyberseclaunchpad.com/*`
7. Web origins: `https://meet-local.cyberseclaunchpad.com`
8. **Save**

### Copy the client secret

1. Go to **Credentials** tab of the `meet` client
2. Copy the secret value

### Update your .env with the secret

```bash
nano ~/meet/.env
# Replace REPLACE_AFTER_KEYCLOAK_SETUP with the copied secret
```

### Create a test user

1. **Users** → **Add user**
2. Username: your email address
3. Email: your email address
4. Email verified: **On** → **Save**
5. **Credentials** tab → **Set password** → Temporary: **Off**

### Restart the backend to pick up the new OIDC secret

```bash
docker compose restart backend
```

---

## Step 9: Run Migrations

```bash
docker compose exec backend python manage.py migrate
docker compose exec backend python manage.py createsuperuser --email admin@cyberseclaunchpad.com
```

---

## Step 10: Set Up MinIO Recordings Bucket

1. Open `http://localhost:9001` (or `https://s3-local.cyberseclaunchpad.com`)
2. Log in with `MINIO_USER` / `MINIO_PASSWORD` from your `.env`
3. Click **Buckets** → **Create Bucket**
4. Bucket name: `recordings` → **Create**

---

## Step 11: Access the App

Visit `https://meet-local.cyberseclaunchpad.com` in your browser.

You should be redirected to Keycloak at `https://id-local.cyberseclaunchpad.com`.
Log in with the test user you created. After login you land on the Meet home screen.

---

## Verify Everything Works

```bash
# All containers healthy?
docker compose ps

# API responding with JSON?
docker compose exec frontend wget -qO- http://localhost:8080/api/v1.0/config/

# Backend logs clean?
docker compose logs backend --tail 30

# LiveKit running?
docker compose logs livekit --tail 20
```

---

## Daily Usage

```bash
# Start
cd ~/meet && docker compose up -d

# Stop
docker compose down

# Stop and wipe all data (full reset)
docker compose down -v
rm -rf ~/meet/data
```

> **Keycloak data is lost on restart** because it uses `KC_DB: dev-mem` (in-memory
> database). You will need to re-create the realm, client, and users after each restart.
> To avoid this, replace the Keycloak service with a persistent PostgreSQL-backed config
> (see the note below).

### Make Keycloak data persistent (optional)

Add a dedicated Keycloak database to the compose file:

```yaml
  kc_postgresql:
    image: postgres:16
    environment:
      POSTGRES_DB: keycloak
      POSTGRES_USER: keycloak
      POSTGRES_PASSWORD: ${KC_DB_PASSWORD}
    volumes:
      - ./data/kc_db:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -d $${POSTGRES_DB} -U $${POSTGRES_USER}"]
      interval: 1s
      timeout: 2s
      retries: 300
```

Then update the Keycloak service environment:
```yaml
  keycloak:
    ...
    environment:
      KC_DB: postgres
      KC_DB_URL: jdbc:postgresql://kc_postgresql/keycloak
      KC_DB_USERNAME: keycloak
      KC_DB_PASSWORD: ${KC_DB_PASSWORD}
      KC_HOSTNAME: id-local.cyberseclaunchpad.com
      KC_HTTP_ENABLED: "true"
      KC_HOSTNAME_STRICT_HTTPS: "false"
      KC_PROXY: edge
      KEYCLOAK_ADMIN: admin
      KEYCLOAK_ADMIN_PASSWORD: ${KEYCLOAK_ADMIN_PASSWORD}
    depends_on:
      kc_postgresql:
        condition: service_healthy
```

Add `KC_DB_PASSWORD=<generate>` to your `.env`.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `loading...` forever | API returning HTML instead of JSON | Check `nginx.conf` is mounted; verify frontend port 8080 is exposed |
| Keycloak login redirect fails | `OIDC_CLIENT_SECRET` not updated after Keycloak setup | Copy secret from Keycloak Credentials tab → update `.env` → `docker compose restart backend` |
| `read /config.yaml: is a directory` | Config file didn't exist before first deploy | `rm -rf ~/meet/egress.yaml` or `~/meet/livekit-server.yaml`, recreate as file, `docker compose up -d` |
| WebSocket to LiveKit fails | Cloudflare Tunnel route not created for `livekit-local` | Add the tunnel route in Zero Trust dashboard |
| Keycloak realm/users lost on restart | `KC_DB: dev-mem` in-memory storage | Add persistent PostgreSQL for Keycloak (see above) |
| Port already in use | Another service on the host using 8080/8081/7880 | Change the host port in the `ports:` mapping, e.g. `"8082:8080"` |
| Backend can't reach Keycloak | `OIDC_OP_TOKEN_ENDPOINT` uses wrong hostname | Server-side endpoints must use `http://keycloak:8080`, not the public URL |
| Video freezes locally | WSL2 UDP port not forwarded correctly | Ensure ports 7881/7882 are not blocked by Windows Firewall |

---

## File Structure Reference

```
~/meet/
├── docker-compose.yml
├── .env
├── nginx.conf
├── livekit-server.yaml
├── egress.yaml
└── data/
    ├── db/          ← PostgreSQL data
    ├── kc_db/       ← Keycloak data (if using persistent KC)
    └── minio/       ← Recording files
```
