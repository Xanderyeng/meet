# Self-Hosting LaSuite Meet on Coolify (Contabo)

This guide documents a working deployment of [LaSuite Meet](https://github.com/suitenumerique/meet) on a Coolify instance running on a Contabo VPS using Docker Compose. The deployment uses Coolify's built-in Traefik reverse proxy for SSL termination.

---

## Architecture Overview

| Service | Purpose | Domain |
|---|---|---|
| **Frontend** (nginx) | Serves React app + proxies API | `meet.cyberseclaunchpad.com` |
| **Backend** (Django/Gunicorn) | REST API | Internal only |
| **PostgreSQL** | Main database | Internal only |
| **Redis** | Cache & sessions | Internal only |
| **LiveKit** | WebRTC SFU for video | `livekit.cyberseclaunchpad.com` |
| **Keycloak** | OIDC identity provider | `id.cyberseclaunchpad.com` (existing) |
| **MinIO** *(optional)* | S3-compatible storage for recordings | `s3.cyberseclaunchpad.com` |
| **LiveKit Egress** *(optional)* | Records meetings and uploads to MinIO | Internal only |

---

## Server Requirements

### Without Recording (core stack only)

| Resource | Minimum | Recommended |
|---|---|---|
| **vCPU** | 4 cores | 6 cores |
| **RAM** | 8 GB | 12 GB |
| **Disk** | 40 GB SSD | 80 GB SSD |
| **Bandwidth** | 200 Mbit/s | 500 Mbit/s |

### With Recording (full stack including MinIO + Egress)

| Resource | Minimum | Recommended |
|---|---|---|
| **vCPU** | 8 cores | 12 cores |
| **RAM** | 16 GB | 24 GB |
| **Disk** | 100 GB SSD | 500 GB SSD |
| **Bandwidth** | 500 Mbit/s | 1 Gbit/s |

> **Why so much more for recording?** LiveKit Egress performs real-time video compositing and encoding (essentially running a headless browser + ffmpeg). A single recording session can consume 2–4 vCPUs and 2–3 GB RAM on its own. Disk fills up fast — a 1-hour meeting at 720p is roughly 1–2 GB.

### What happens if you underspec

The screenshot below shows a 4-core / 6 GB VPS running the full stack at startup — backend alone hitting **149% CPU**, load average **10.19** on a 4-core machine (2.5× overloaded), and RAM at **67%** before any active meetings. This leaves almost no headroom for actual video traffic.

| Symptom | Likely cause |
|---|---|
| CPU pinned at 90–96% at idle | Too few cores for the number of running services |
| High load average (>2× core count) | CPU scheduler is overwhelmed — containers starved |
| RAM at 90% with no active meetings | Insufficient RAM; risk of OOM kills under load |
| Video freezes or drops during calls | LiveKit can't get CPU time to process WebRTC packets |
| Recording fails or produces corrupted files | Egress gets OOM-killed mid-encode |

### Contabo VPS sizing guide

| Plan | vCPU | RAM | Suitable for |
|---|---|---|---|
| VPS S | 4 cores | 8 GB | Core Meet only, <5 concurrent users |
| VPS M | 6 cores | 16 GB | Core Meet, 10–20 concurrent users |
| VPS L | 8 cores | 24 GB | Full stack with recording, 20–30 users |
| VPS XL | 12 cores | 48 GB | Full stack with recording, 50+ users |

> LiveKit's own recommendation for production WebRTC is a minimum of **4 dedicated cores and 8 GB RAM** for the SFU alone, before accounting for Django, PostgreSQL, Redis, and the other services sharing the same machine.

---

## Prerequisites

### 1. DNS Records

Create three A records pointing to your Contabo server IP:

| Subdomain | Type | Value | |
|---|---|---|---|
| `meet.cyberseclaunchpad.com` | A | `<server IP>` | |
| `id.cyberseclaunchpad.com` | A | `<server IP>` | |
| `livekit.cyberseclaunchpad.com` | A | `<server IP>` | |
| `s3.cyberseclaunchpad.com` | A | `<server IP>` | *(add if enabling recording)* |

### 2. Firewall Rules

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw allow 7881/tcp
sudo ufw allow 7882/tcp
sudo ufw allow 7882/udp
sudo ufw enable
```

### 3. Generate Secrets

Run these on any machine with Python:

```bash
# Django secret key
python3 -c "import secrets; print(secrets.token_urlsafe(50))"

# LiveKit API secret
python3 -c "import secrets; print(secrets.token_urlsafe(32))"

# Database password
python3 -c "import secrets; print(secrets.token_urlsafe(24))"
```

---

## Step 1: Prepare the Server Directory

SSH into your Contabo server and set up the working directory:

```bash
sudo mkdir -p /opt/meet/data/db
sudo chown -R alex:alex /opt/meet
cd /opt/meet
```

> If your user is not UID 1000, also run: `sudo chown -R 1000:1000 /opt/meet/data`

---

## Step 2: Create Config Files

### LiveKit Server Config

```bash
cat > /opt/meet/livekit-server.yaml << 'EOF'
port: 7880
redis:
  address: redis:6379
keys:
  meet: <YOUR_LIVEKIT_API_SECRET>
rtc:
  udp_port: 7882
  tcp_port: 7881
  use_external_ip: true
EOF
```

Replace `<YOUR_LIVEKIT_API_SECRET>` with your generated secret.

### Nginx Config

This single config replaces the image's built-in nginx config. It serves static files on port 8080 and proxies `/api`, `/admin`, and `/static` to the Django backend.

```bash
cat > /opt/meet/nginx.conf << 'EOF'
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

---

## Step 3: Docker Compose File

In Coolify, create a new **Docker Compose** stack and paste the following. All domain-specific values are injected via environment variables — the only file you edit per deployment is the `.env`.

```yaml
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
      - /opt/meet/data/db:/var/lib/postgresql/data

  redis:
    image: redis:7

  livekit:
    image: livekit/livekit-server:latest
    command: --config /config.yaml
    ports:
      - 7881:7881/tcp
      - 7882:7882/udp
    volumes:
      - /opt/meet/livekit-server.yaml:/config.yaml
    depends_on:
      - redis

  backend:
    image: lasuite/meet-backend:latest
    user: "1000"
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
      OIDC_OP_JWKS_ENDPOINT: https://${KEYCLOAK_HOST}/realms/${REALM_NAME}/protocol/openid-connect/certs
      OIDC_OP_AUTHORIZATION_ENDPOINT: https://${KEYCLOAK_HOST}/realms/${REALM_NAME}/protocol/openid-connect/auth
      OIDC_OP_TOKEN_ENDPOINT: https://${KEYCLOAK_HOST}/realms/${REALM_NAME}/protocol/openid-connect/token
      OIDC_OP_USER_ENDPOINT: https://${KEYCLOAK_HOST}/realms/${REALM_NAME}/protocol/openid-connect/userinfo
      OIDC_OP_LOGOUT_ENDPOINT: https://${KEYCLOAK_HOST}/realms/${REALM_NAME}/protocol/openid-connect/logout
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
      livekit:
        condition: service_started

  frontend:
    image: lasuite/meet-frontend:latest
    user: "1000"
    entrypoint:
      - /docker-entrypoint.sh
    command:
      - nginx
      - "-g"
      - "daemon off;"
    environment:
      MEET_HOST: ${MEET_HOST}
      BACKEND_INTERNAL_HOST: backend
      FRONTEND_INTERNAL_HOST: frontend
      LIVEKIT_INTERNAL_HOST: livekit
    volumes:
      - /opt/meet/nginx.conf:/etc/nginx/conf.d/default.conf
    depends_on:
      backend:
        condition: service_healthy
```

> **Why no `ports` on frontend?** Coolify's Traefik connects directly to the container on the internal Docker network. Host port mappings are not needed and cause conflicts (port 8080 is used by Coolify's own Traefik dashboard).

> **Why no `ports` on livekit for 7880?** Traefik proxies HTTP/WebSocket to LiveKit internally. Only the raw WebRTC ports (7881/7882) need direct host mappings.

---

## Step 4: Environment Variables in Coolify

In Coolify, set these as environment variables on the stack (not in a file on the server):

```env
# Domains
MEET_HOST=meet.cyberseclaunchpad.com
KEYCLOAK_HOST=id.cyberseclaunchpad.com
LIVEKIT_HOST=livekit.cyberseclaunchpad.com
REALM_NAME=meet

# Secrets
DJANGO_SECRET_KEY=<generated 50-char secret>
LIVEKIT_API_SECRET=<generated 32-char secret — must match livekit-server.yaml>
DB_PASSWORD=<generated password>
OIDC_CLIENT_SECRET=<copied from Keycloak client credentials tab>

# Email (Postmark)
SMTP_HOST=smtp.postmarkapp.com
SMTP_PORT=587
SMTP_USER=<postmark server api token>
SMTP_PASSWORD=<postmark server api token>
SMTP_FROM=noreply@cyberseclaunchpad.com
```

> **Postmark note:** `SMTP_USER` and `SMTP_PASSWORD` are the same value (the Server API Token). Do not add inline comments to env var values in Coolify — they will be included as part of the value.

---

## Step 5: Coolify Domain Configuration

Set domains on these two services inside the Coolify stack UI:

| Service | Domain |
|---|---|
| `frontend` | `https://meet.cyberseclaunchpad.com:8080` |
| `livekit` | `https://livekit.cyberseclaunchpad.com:7880` |

The `:PORT` suffix tells Traefik which container port to route traffic to internally. The public URL remains on port 443.

> Coolify/Traefik automatically provisions and renews Let's Encrypt SSL certificates when domains are added. After adding a domain, allow ~60 seconds after deployment for the cert to be issued.

---

## Step 6: Keycloak Configuration

This deployment reuses an existing Keycloak instance at `https://id.cyberseclaunchpad.com`. No new Keycloak deployment is needed.

### Create the Meet Realm

1. Log into Keycloak admin console
2. Top-left dropdown → **Create realm**
3. Realm name: `meet` → **Create**

### Create the Meet Client

1. In the `meet` realm → **Clients** → **Create client**
2. Client type: `OpenID Connect`
3. Client ID: `meet` → **Next**
4. Enable **Client authentication** → **Next**
5. Valid redirect URIs: `https://meet.cyberseclaunchpad.com/*`
6. Valid post logout redirect URIs: `https://meet.cyberseclaunchpad.com/*`
7. Web origins: `https://meet.cyberseclaunchpad.com`
8. **Save**

### Copy the Client Secret

1. Go to the **Credentials** tab of the `meet` client
2. Copy the secret → set as `OIDC_CLIENT_SECRET` in Coolify

### Create a User

1. **Users** → **Add user**
2. Username: your email
3. Email: your email
4. Email verified: **On** → **Save**
5. **Credentials** tab → **Set password** → Temporary: **Off**

---

## Step 7: Deploy and Run Migrations

Deploy the stack in Coolify. Once all containers are healthy, run the database migrations:

```bash
sudo docker ps | grep backend   # get container name
sudo docker exec <backend_container_name> python manage.py migrate
sudo docker exec <backend_container_name> python manage.py createsuperuser --email admin@cyberseclaunchpad.com
```

---

## Step 8: Verify Everything Works

```bash
# 1. Check all containers are running and healthy
sudo docker ps --format "table {{.Names}}\t{{.Status}}"

# 2. Confirm nginx is serving the API correctly (should return JSON)
sudo docker exec <frontend_container_name> wget -qO- http://localhost:8080/api/v1.0/config/

# 3. Confirm LiveKit SSL cert is valid
curl -sv https://livekit.cyberseclaunchpad.com 2>&1 | grep -E "subject|issuer|verify"

# 4. Check LiveKit is running
sudo docker logs <livekit_container_name> --tail 20
```

---

## Accessing the App

| URL | Purpose |
|---|---|
| `https://meet.cyberseclaunchpad.com` | Main app — create and join meetings |
| `https://meet.cyberseclaunchpad.com/admin` | Django admin panel |
| `https://id.cyberseclaunchpad.com` | Keycloak admin console |

---

## Optional: Enable Meeting Recording

Recording requires two additional services — **MinIO** (S3-compatible storage) and **LiveKit Egress** (handles the recording process). The core Meet deployment must be working before adding these.

### Step 1: Add DNS Record

Add an A record for `s3.cyberseclaunchpad.com` pointing to your server IP.

### Step 2: Create the Egress Config File

**Create the file on the server before deploying** — if the file does not exist at deploy time, Docker creates a directory at the mount point instead and the container crashes in a restart loop.

```bash
cat > /opt/meet/egress.yaml << 'EOF'
api_key: meet
api_secret: <YOUR_LIVEKIT_API_SECRET>
ws_url: wss://livekit.cyberseclaunchpad.com
redis:
  address: redis:6379
s3:
  access_key: <YOUR_MINIO_USER>
  secret: <YOUR_MINIO_PASSWORD>
  endpoint: http://minio:9000
  bucket: recordings
EOF
```

> Use the same `LIVEKIT_API_SECRET` value as in `livekit-server.yaml` and your Coolify env vars.

Verify it was created as a file (not a directory):
```bash
ls -la /opt/meet/egress.yaml
# Must start with - (file), not d (directory)
```

If it shows as a directory, remove it and recreate:
```bash
sudo rm -rf /opt/meet/egress.yaml
# then run the cat > ... command above again
```

### Step 3: Add Services to Compose

Add these two services to your existing compose file in Coolify:

```yaml
  minio:
    image: quay.io/minio/minio:latest
    command: server /data --console-address ":9001"
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.minio-console.rule=Host(`s3.cyberseclaunchpad.com`)"
      - "traefik.http.routers.minio-console.tls=true"
      - "traefik.http.routers.minio-console.tls.certresolver=letsencrypt"
      - "traefik.http.services.minio-console.loadbalancer.server.port=9001"
    environment:
      MINIO_SERVER_URL: ${MINIO_SERVER_URL}
      MINIO_BROWSER_REDIRECT_URL: ${MINIO_BROWSER_REDIRECT_URL}
      MINIO_ROOT_USER: ${SERVICE_USER_MINIO}
      MINIO_ROOT_PASSWORD: ${SERVICE_PASSWORD_MINIO}
    volumes:
      - minio-data:/data
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
      - /opt/meet/egress.yaml:/config.yaml
    depends_on:
      - livekit
      - redis
      - minio
```

Also add the named volume at the bottom of the compose file:

```yaml
volumes:
  minio-data:
```

### Step 4: Add Backend Recording Environment Variables

Add these to the `backend` service `environment` block in the compose:

```yaml
      RECORDING_ENABLE: "true"
      AWS_S3_ENDPOINT_URL: http://minio:9000
      AWS_S3_ACCESS_KEY_ID: ${SERVICE_USER_MINIO}
      AWS_S3_SECRET_ACCESS_KEY: ${SERVICE_PASSWORD_MINIO}
      AWS_STORAGE_BUCKET_NAME: recordings
```

### Step 5: Add Environment Variables in Coolify

```env
MINIO_SERVER_URL=https://s3.cyberseclaunchpad.com
MINIO_BROWSER_REDIRECT_URL=https://s3.cyberseclaunchpad.com
SERVICE_USER_MINIO=<minio admin username>
SERVICE_PASSWORD_MINIO=<strong password>
```

### Step 6: Add Coolify Domain for MinIO

Since MinIO is part of the Docker Compose stack (not a standalone Coolify service), there is no domain field in the Coolify UI for it. The domain is configured via Traefik labels directly in the compose (already included in Step 3 above). Coolify will pick up the labels on redeploy and issue the SSL cert automatically.

### Step 7: Deploy and Create the Recordings Bucket

1. Redeploy the full stack in Coolify
2. Once MinIO is healthy, log into the MinIO console at `https://s3.cyberseclaunchpad.com`
3. Create a bucket named `recordings`

### Step 8: Verify Recording Works

Start a meeting at `https://meet.cyberseclaunchpad.com`, join the room, and look for the **Record** button in the meeting controls. After stopping the recording, the file will appear in the `recordings` bucket in the MinIO console.

> **Common issue — `read /config.yaml: is a directory`:** This means `/opt/meet/egress.yaml` did not exist on the host when Docker created the container. Stop the stack, delete the bad mount with `sudo rm -rf /opt/meet/egress.yaml`, recreate the file, then redeploy.

---

## Troubleshooting Reference

| Symptom | Cause | Fix |
|---|---|---|
| `loading...` forever on homepage | `/api` requests returning HTML instead of JSON | Confirm `nginx.conf` volume mount is active; check Coolify domain port is `:8080` |
| `read /config.yaml: is a directory` in LiveKit logs | Volume mount used relative path; Docker created a directory | Use absolute path `/opt/meet/livekit-server.yaml:/config.yaml` |
| `ERR_CERT_AUTHORITY_INVALID` for LiveKit WebSocket | SSL cert not yet issued for `livekit.cyberseclaunchpad.com` | Remove and re-add domain in Coolify, redeploy, wait 60s |
| `port is already allocated` on frontend | Host port 8080 in use by Coolify's Traefik dashboard | Remove `ports` from frontend service entirely |
| Backend returns 400 on direct curl | Django `ALLOWED_HOSTS` rejecting request without correct Host header | Normal when testing without proper Host header; not an error |
| WebRTC connects but video drops | UDP port 7882 blocked | `sudo ufw allow 7882/udp && sudo ufw reload` |
| LiveKit logs show no connection attempts | WebSocket blocked at Traefik/cert level before reaching LiveKit | Fix cert issue first |
| `read /config.yaml: is a directory` in Egress logs | `/opt/meet/egress.yaml` didn't exist when Docker created the container | `sudo rm -rf /opt/meet/egress.yaml`, recreate the file, redeploy |
| Egress container restarts in a loop | Same as above — Docker created a directory at the mount point | Same fix as above |
| Recording button not visible in UI | `RECORDING_ENABLE` env var missing from backend | Add `RECORDING_ENABLE: "true"` to backend environment and redeploy |

---

## Upgrading

Before upgrading, check [UPGRADE.md](https://github.com/suitenumerique/meet/blob/main/UPGRADE.md) for any breaking changes.

```bash
# Pull latest images
sudo docker compose pull

# Restart containers
sudo docker compose restart

# Run any new migrations
sudo docker exec <backend_container_name> python manage.py migrate
```

To pin to a specific version, replace `latest` with the desired tag in the compose image fields (e.g., `lasuite/meet-backend:1.5.0`).
