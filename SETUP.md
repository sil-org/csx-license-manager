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

## 3. Create the S3 bucket + CloudFront distribution

### S3 bucket
1. **S3 > Create bucket** → name `YOUR_APP_NAME-web` (globally unique), region `us-east-1`
2. Uncheck "Block all public access" → confirm
3. **Permissions > Bucket policy**:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": "*",
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::YOUR_APP_NAME-web/*"
  }]
}
```

4. **Properties > Static website hosting > Enable** — Index document: `index.html`,
   Error document: `index.html` (required for React Router)

### SSL certificate (ACM, must be in us-east-1)
1. **Certificate Manager > Request a public certificate** for `YOUR_DOMAIN`
2. DNS validation → create the validation record in Route 53
3. Wait for status **Issued**

### CloudFront distribution
1. **CloudFront > Create distribution**
2. Origin: the S3 bucket's **website endpoint** (not the bucket name directly)
3. Viewer protocol policy: **Redirect HTTP to HTTPS**
4. Alternate domain name (CNAME): `YOUR_DOMAIN`
5. Custom SSL certificate: the one from above
6. Default root object: `index.html`
7. Copy the **Distribution ID**

### Route 53 DNS
Create an **A** record (Alias) for `YOUR_DOMAIN` pointing at the CloudFront distribution.

---

## 4. Add GitHub Secrets

**Settings > Secrets and variables > Actions**:

| Secret name | Value |
|---|---|
| `AWS_ACCESS_KEY_ID` | IAM credentials with S3 + CloudFront permissions |
| `AWS_SECRET_ACCESS_KEY` | " |
| `AWS_REGION` | `us-east-1` |
| `S3_BUCKET` | `YOUR_APP_NAME-web` |
| `CLOUDFRONT_DISTRIBUTION_ID` | from step 3 |
| `VITE_SUPABASE_URL` | Supabase Project Settings > API |
| `VITE_SUPABASE_ANON_KEY` | Supabase Project Settings > API |

If you're not using Edge Functions yet, delete the `deploy-edge-functions`
job from `.github/workflows/deploy.yml` (otherwise also add
`SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF`).

---

## 5. Push and deploy

```bash
git push -u origin main
```

The GitHub Action deploys to S3 + invalidates CloudFront automatically.

---

## 6. Local development

```bash
cp .env.example .env
# fill in .env with your Supabase URL and anon key
npm install
npm run dev
# open http://localhost:5173
```

---

## 7. Make yourself admin

After your first sign-in:

```sql
update profiles set role = 'admin'
where primary_email = 'your-email@sil.org';
```
