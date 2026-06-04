# My Recordings — Feature Documentation

## Overview

The **My Recordings** feature gives logged-in users a dedicated page (`/recordings`) where they can see all recordings they own or have access to, and download them directly — without needing an email link.

---

## Implementation Plan

### What was built

| File | Change |
|------|--------|
| `src/frontend/src/features/recording/api/fetchRecordings.ts` | New — calls `GET /api/v1.0/recordings/` |
| `src/frontend/src/features/recording/routes/RecordingsList.tsx` | New — the My Recordings page component |
| `src/frontend/src/features/recording/index.ts` | Export `RecordingsListRoute` |
| `src/frontend/src/routes.ts` | Add `recordingsList` route at `/recordings` |
| `src/frontend/src/features/settings/components/tabs/AccountTab.tsx` | Add "My Recordings" link in the Account tab (shown when logged in) |
| `src/frontend/src/locales/en/recording.json` | New `list.*` translation keys |
| `src/frontend/src/locales/fr/recording.json` | French translations for `list.*` keys |
| `src/frontend/src/locales/en/settings.json` | `account.myRecordings` key |
| `src/frontend/src/locales/fr/settings.json` | French translation for `account.myRecordings` |

### Backend — no changes needed

The backend already provides everything required:

- `GET /api/v1.0/recordings/` — lists recordings for the authenticated user (via `RecordingViewSet` with `ListModelMixin`). Results are filtered to the user's own recordings and their teams' recordings. Paginated, ordered by `-created_at`.
- `GET /api/v1.0/recordings/{id}/` — retrieve a single recording (used by the existing download page).
- `GET /api/v1.0/recordings/media-auth/` — Nginx subrequest authentication for media files; no changes needed.

### Data flow

```
User navigates to /recordings
  → RecordingsList component mounts
  → useQuery calls fetchRecordings()
  → GET /api/v1.0/recordings/  (session cookie auth)
  → Backend returns paginated list of RecordingApi objects
  → Component renders one card per recording

For each "ready" recording:
  → "View" button  → navigates to /recording/{id}  (existing download page)
  → "Download" button → href to /media/{key}
       → Nginx intercepts, sends subrequest to /api/v1.0/recordings/media-auth/
       → Backend validates user access, returns S3 auth headers
       → Nginx proxies the file from S3
```

---

## How to Wire It Up

### Prerequisites

1. The backend must be running and accessible (default: `http://localhost:8000`).
2. Recording feature must be enabled in Django settings:
   ```python
   RECORDING_ENABLE = True
   ```
3. LiveKit and a storage backend (MinIO / S3) must be configured. See [recording.md](./recording.md) for the full infrastructure setup.
4. The `RECORDING_DOWNLOAD_BASE_URL` setting (or `SCREEN_RECORDING_BASE_URL`) must be set to your frontend origin so email links resolve correctly:
   ```python
   RECORDING_DOWNLOAD_BASE_URL = "https://your-frontend.example.com/recording"
   ```

### Nginx media proxy

The `/media/` path must be proxied through Nginx with the subrequest auth pattern. Refer to the existing [recording.md](./recording.md) and your Nginx config for the `auth_request` setup pointing to `/api/v1.0/recordings/media-auth/`.

### Frontend env var

Ensure `VITE_API_BASE_URL` is set in your frontend `.env` (or `.env.local`) to point at your backend:

```env
VITE_API_BASE_URL=http://localhost:8000
```

---

## How to Test

### 1. Manual smoke test

1. Start the full stack (backend + frontend + MinIO + LiveKit).
2. Log in as a user who has at least one completed recording.
3. Open **Settings → Profile** tab — you should see a **"My Recordings"** link.
4. Click it; you should be taken to `/recordings`.
5. Verify that your recordings are listed with correct room name, date, and status badge.
6. For a recording with status `saved` or `notification_succeeded`:
   - Click **View** → should navigate to `/recording/{id}` (existing download page).
   - Click **Download** → browser should download the video file.

### 2. Test the list API directly

```bash
# Replace SESSION_COOKIE with a valid session cookie value
curl -s \
  -H "Cookie: sessionid=<SESSION_COOKIE>" \
  http://localhost:8000/api/v1.0/recordings/ | python3 -m json.tool
```

Expected response shape:
```json
{
  "count": 3,
  "next": null,
  "previous": null,
  "results": [
    {
      "id": "uuid",
      "room": { "id": "...", "name": "My Room", "slug": "...", "access_level": "..." },
      "created_at": "2025-01-01T12:00:00Z",
      "key": "recordings/uuid.mp4",
      "mode": "screen_recording",
      "status": "notification_succeeded",
      "is_expired": false,
      "expired_at": null
    }
  ]
}
```

### 3. Test the download (media-auth)

```bash
# Fetch the media file — Nginx will call media-auth internally
curl -v \
  -H "Cookie: sessionid=<SESSION_COOKIE>" \
  http://localhost:8080/media/recordings/<uuid>.mp4 \
  -o recording.mp4
```

- A `200` with file data means auth passed and the file streamed correctly.
- A `403` means the user does not have access to that recording.
- A `404` from the storage backend means the file key is wrong or the file was deleted.

### 4. Test the "unauthenticated" guard

1. Log out.
2. Navigate to `/recordings` directly.
3. You should see the **"Authentication required"** error screen, not an empty list.

### 5. Test the empty state

Log in as a user with no recordings. The page should display the empty-state illustration and message instead of a list.

### 6. Test expiration

Create a recording and set `RECORDING_EXPIRATION_DAYS = 0` (or manually expire it in the DB). Reload `/recordings`. The expired recording should still appear in the list, but the **Download** button should be hidden (only **View** remains, which then shows the "Recording expired" screen).

### 7. Backend unit tests (existing)

The backend list endpoint already has full test coverage:

```bash
cd src/backend
pytest core/tests/recording/test_api_recordings_list.py -v
```

Key cases covered: anonymous returns 401, own recordings appear, team recordings appear, pagination works, distinct results.

---

## Status Badge Mapping

| Recording status (backend) | Badge shown |
|---|---|
| `saved` / `notification_succeeded` / `failedToStop` | **Ready** (green) |
| `active` | **Recording** (grey) |
| `initiated` / `stopped` | **Processing** (grey) |
| `aborted` / `failedToStart` | **Failed** (red) |

---

## Known Limitations

- **Pagination**: The page currently loads only the first page of results (default backend page size). A "load more" or pagination control is not yet implemented; a note is shown when results are truncated.
- **Link sharing**: Sharing a recording link with non-owners is not yet supported by the backend (access control is owner/admin only). This is the same limitation as the existing download page.
- **Real-time status updates**: The list does not auto-refresh when a recording transitions from `processing` to `ready`. Users need to reload the page manually.
