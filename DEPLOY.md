# Deploying the BPM Owner Onboarding Portal

This guide walks you through putting the Owner Onboarding Portal live at
`https://portal.beyondpropertymanagement.com`. Written for Danyel — no
technical background required.

---

## What this sets up

The portal is a small web server that handles the owner onboarding steps
(management agreement, questionnaire, tax forms, insurance, etc.). It runs on a
hosting service called **Render** (render.com), which is built for exactly this
kind of Node.js app. Your main website (www.beyondpropertymanagement.com) stays
on HostGator and is not touched.

Render hosts the portal. HostGator points `portal.beyondpropertymanagement.com`
at Render. That is the whole picture.

---

## Step 1 — Create a Render account

1. Go to **render.com** and click "Get Started."
2. Sign up with your GitHub account (the same one that owns the `beyond` repo).
   This lets Render deploy directly from your code.
3. You may be asked to authorize Render to access your GitHub repos — approve it.

If you already have a Render account connected to GitHub, skip to Step 2.

---

## Step 2 — Create the web service on Render

1. In Render, click **New +** → **Web Service**.
2. Choose **Connect a repository**, then select `danyelbrooks/beyond`.
3. Render will automatically find the `render.yaml` file in the repo and read
   the settings from it. You do not need to configure the build or start
   commands manually.
4. Give the service a name — `bpm-onboarding-portal` is fine.
5. Choose the **Free** tier to start (you can upgrade later if the portal is
   slow to wake up after inactivity).
6. Before clicking Deploy, Render will show you a list of environment variables
   to fill in. Enter each one using the table below.

### Environment variables to enter in Render

These are your secrets. Enter them in Render's dashboard. Do NOT put the real
values in any code file.

| Variable name | What it is | Where to find it |
|---|---|---|
| `SUPABASE_URL` | Your Supabase project URL | Supabase → Project Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret database key (full access — keep safe) | Supabase → Project Settings → API → service_role key |
| `ANTHROPIC_API_KEY` | Claude AI key (used to scan insurance docs) | console.anthropic.com → API Keys |
| `GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY` | The full contents of your Drive service account JSON file — see note below | See "Google Drive note" below |
| `GOOGLE_DRIVE_ONBOARDING_FOLDER_ID` | The Google Drive folder ID where onboarding docs are stored | Open the folder in Drive → copy the ID from the URL (the long string after `/folders/`) |
| `APPFOLIO_STACK_CLIENT_ID` | AppFolio Stack API client ID | AppFolio → Settings → API Settings |
| `APPFOLIO_STACK_CLIENT_SECRET` | AppFolio Stack API secret | AppFolio → Settings → API Settings |

Three variables are already set for you in the config file and do not need
manual entry: `ONBOARDING_PORT`, `PORTAL_BASE_URL`, and `BPM_MAILING_ADDRESS`.

### Google Drive note — how to get the value for Render

1. Find the file `bpm-drive-account.json` in your `C:\Code\beyond` folder.
2. Open it with Notepad (right-click → Open with → Notepad).
3. Select all the text (Ctrl+A), copy it (Ctrl+C).
4. In Render, paste that entire block as the value for `GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY`.

That's it — the code will detect it's JSON and use it directly. Your local setup is unchanged and still reads from the file.

7. Click **Create Web Service**. Render will build and start the server. This
   takes about 2–3 minutes. You will see a green "Live" badge when it is up.
8. Copy the URL Render gives you — it looks like
   `bpm-onboarding-portal.onrender.com`. You need this for the DNS step.

---

## Step 3 — Add the DNS record in HostGator

This step tells your domain (`beyondpropertymanagement.com`) to send anyone
who visits `portal.beyondpropertymanagement.com` over to Render.

1. Log into HostGator at **cpanel.hostgator.com** (or through
   hostgator.com → Login → Web Hosting).
2. Find **Zone Editor** (sometimes listed under "Domains").
3. Next to `beyondpropertymanagement.com`, click **Manage**.
4. Click **Add Record** and fill it in exactly like this:

   | Field | Value |
   |---|---|
   | Name | `portal` |
   | Type | `CNAME` |
   | Value | `bpm-onboarding-portal.onrender.com` (your actual Render URL) |
   | TTL | `3600` |

5. Save the record.

DNS changes take anywhere from a few minutes to 24 hours to spread across the
internet. Most of the time it is under an hour.

---

## Step 4 — Test

Once DNS has had time to propagate (wait at least 15–30 minutes after adding
the record):

1. Go to Render and open any active onboarding to copy a portal link. It looks
   like `/onboard/[long string of letters and numbers]`.
2. In your browser, visit:
   `https://portal.beyondpropertymanagement.com/onboard/[that token]`
3. You should see the owner onboarding portal load with the BPM branding.
4. The browser should show a padlock (https) in the address bar — Render
   provides the SSL certificate automatically.

---

## What to do if it does not work

### "This site can't be reached" or similar DNS error

DNS has not propagated yet. Wait another 30 minutes and try again. If it still
does not work after 2 hours, log back into HostGator and confirm the CNAME
record was saved correctly (Name = `portal`, Value = your Render URL).

### The page loads but shows an error message

Open Render → select your service → click **Logs** in the left sidebar. The
logs will show exactly what went wrong (a missing environment variable, a
database connection failure, etc.).

Common causes:
- A typo in one of the environment variables (especially `SUPABASE_URL` or
  `SUPABASE_SERVICE_ROLE_KEY`)
- The `GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY` issue described in Step 2 (Drive file
  not available)
- The server is still starting up — on the free tier, Render "sleeps" the
  server after 15 minutes of inactivity. The first request after a sleep takes
  about 30 seconds to wake up. This is normal.

### "Deploy failed" in Render

Click on the failed deploy to see the build log. The most common cause is a
missing dependency in `package.json`. Share the error with your developer.

### Render URL works but custom domain does not

Confirm that the CNAME record in HostGator points to the exact Render URL
(including `.onrender.com`). Also check that you typed `portal` (not
`portal.beyondpropertymanagement.com`) in the Name field — HostGator adds the
domain automatically.

---

## Going live checklist

Before telling owners to use the portal:

- [ ] Render shows the service as "Live"
- [ ] `https://portal.beyondpropertymanagement.com` loads in your browser
- [ ] SSL padlock is visible
- [ ] You have completed the Drive credentials fix (or accepted that PDFs will
      not save to Drive until that is done)
- [ ] You have tested one full onboarding with a real token
