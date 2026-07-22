# Setup Guide

One-time setup in external dashboards before this app can go live. Do them in order.

Replace `YOUR_APP_NAME` below with `license-manager` and `YOUR_DOMAIN` with the
subdomain you'll host it at (e.g. `licenses.sil.org`).

---

## 1. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) and sign in
2. **New project** → Name: `YOUR_APP_NAME` → pick a region
3. Wait for it to provision
4. **Project Settings > API** → copy **Project URL** (`VITE_SUPABASE_URL`) and
   **anon public** key (`VITE_SUPABASE_ANON_KEY`)

### Run the database schema
1. **SQL Editor > New query**, paste the contents of `supabase/schema.sql`, run it
2. New query again, paste the contents of `supabase/schema_licenses.sql`, run it
   (this adds the licenses/subscriptions/approvals domain schema — see its
   header comment for what's intentionally not ported from the original GAS app)

---

## 2. Set up Google OAuth, restricted to SIL staff

This is the one step where you make a real decision: **how strictly should
this be limited to sil.org accounts?**

### Option A — enforce at the Google Cloud OAuth consent screen (recommended if everyone has a Workspace account)
1. [console.cloud.google.com](https://console.cloud.google.com) → new project `YOUR_APP_NAME`
2. **APIs & Services > OAuth consent screen**
   - User type: **Internal** (only available if this Google Cloud project lives
     inside the sil.org Workspace org — this makes Google itself reject any
     non-sil.org sign-in, no app code needed)
3. **APIs & Services > Credentials > Create Credentials > OAuth client ID**
   - Application type: **Web application**
   - Authorised JavaScript origins: `https://YOUR_DOMAIN`
   - Authorised redirect URIs: `https://your-project-id.supabase.co/auth/v1/callback`
4. Copy **Client ID** and **Client Secret**

### Option B — External consent screen + enforce in the database
If Internal isn't available to you, use **External**, then uncomment the
domain check inside the `resolve_profile()` function in `supabase/schema.sql`
(rejects any non-`@sil.org` email at profile-creation time). Treat this as
required, not optional, if you go this route — a client-side check alone can
be bypassed.

### In Supabase
1. **Authentication > Providers > Google** → enable, paste Client ID/Secret
2. **Authentication > URL Configuration**:
   - Site URL: `https://YOUR_DOMAIN`
   - Redirect URLs: `https://YOUR_DOMAIN/auth/callback`, plus
     `http://localhost:5173/auth/callback` for local dev

---

## 3. Connect AWS Amplify Hosting

1. **Amplify > New app > Host web app**, connect the GitHub repo, branch `main`
2. Framework detection should recognize the Vite app automatically; if it
   offers a build spec, the defaults (`npm ci`, `npm run build`, artifacts
   from `dist/`) are correct — no custom `amplify.yml` needed
3. **App settings > Environment variables** — add:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   (from Supabase Project Settings > API)
4. **App settings > Rewrites and redirects** — add a rule so React Router's
   client-side routes don't 404 on refresh/direct link (Amplify's own SPA
   shorthand — simpler than a CloudFront-style regex):
   ```json
   { "source": "/<*>", "status": "404-200", "target": "/index.html" }
   ```
   `<*>` matches any path; `404-200` only kicks in when the request would
   otherwise 404, so real static files still serve normally.
5. Optional custom domain: **App settings > Domain management > Add domain**
   → `YOUR_DOMAIN`, follow the DNS validation steps (Amplify manages the
   certificate itself, no separate ACM/Route 53 setup needed)
6. Trigger a deploy (push to `main`, or **Run build** in the console) and
   confirm the app loads at the Amplify-assigned URL (or your custom domain)

---

## 4. Set up Resend (transactional email)

Emails (approval requests, SuiteKey verification, activation notices) send
via the `send-email` Edge Function, which calls [Resend](https://resend.com).

1. Sign in to Resend, add the sending domain (e.g. `em.sil.org` — a
   subdomain keeps this isolated from sil.org's main mail setup) under
   **Domains > Add Domain**
2. Add the DNS records Resend gives you (SPF/DKIM/DMARC-related TXT/MX/CNAME
   records) at your DNS provider, then wait for the domain to show
   **Verified** in Resend
3. **API Keys > Create API Key** — copy the key
4. If the `from` address in `supabase/functions/send-email/index.ts` doesn't
   match your verified domain, update the `FROM` constant
5. Set the key as a secret on the linked Supabase project (requires
   `supabase link --project-ref YOUR_PROJECT_REF` first):
   ```bash
   supabase secrets set RESEND_API_KEY=re_your_key_here
   ```
6. Deploy the function (or just push to `main` — see the GitHub Secrets step
   below, which the deploy workflow needs):
   ```bash
   supabase functions deploy send-email
   ```

---

## 5. Add GitHub Secrets (Edge Functions only)

Frontend deploys happen entirely inside Amplify — GitHub Actions here is
only for Supabase Edge Functions (`supabase/functions/`). If you're not
using Edge Functions yet, delete `.github/workflows/deploy.yml` entirely.
Otherwise, **Settings > Secrets and variables > Actions**:

| Secret name | Value |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | Supabase account menu > Access Tokens > generate new |
| `SUPABASE_PROJECT_REF` | Supabase Project Settings > General > Reference ID |

---

## 6. Push and deploy

```bash
git push -u origin main
```

Amplify picks up the push and builds/deploys the frontend on its own. The
GitHub Action only runs the Edge Functions deploy.

---

## 7. Local development

```bash
cp .env.example .env
# fill in .env with your Supabase URL and anon key
npm install
npm run dev
# open http://localhost:5173
```

---

## 8. Make yourself admin

After your first sign-in:

```sql
update profiles set role = 'admin'
where primary_email = 'your-email@sil.org';
```
