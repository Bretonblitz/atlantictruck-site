# Facebook Integration Setup

The gallery and homepage sidebar pull photos/posts from your Facebook page.
To enable this, you need to set two environment variables in Netlify.

## Step 1 — Get your Facebook Page Access Token

1. Go to https://developers.facebook.com
2. Log in with the Facebook account that manages your Atlantic Truck page
3. Go to "My Apps" → create an app (type: Business)
4. Add the "Pages API" product
5. Go to Tools → Graph API Explorer
6. Select your App and your Page from the dropdowns
7. Request these permissions: `pages_show_list`, `pages_read_engagement`, `pages_read_user_content`
8. Generate a Page Access Token
9. To make it long-lived (60 days): exchange via https://graph.facebook.com/oauth/access_token?grant_type=fb_exchange_token&client_id=APP_ID&client_secret=APP_SECRET&fb_exchange_token=SHORT_TOKEN

## Step 2 — Add to Netlify

1. Go to https://app.netlify.com
2. Click your site → Site configuration → Environment variables
3. Add these two variables:

| Key | Value |
|-----|-------|
| `FB_PAGE_ID` | `61579126693357` |
| `FB_PAGE_ACCESS_TOKEN` | your token from Step 1 |

4. Click Save
5. Go to Deploys → Trigger deploy → Deploy site

## Step 3 — Verify

After deploying, visit:
https://www.atlantictruck.ca/.netlify/functions/get-facebook-posts?debug=1

If it shows `"ok": true` and posts, Facebook is connected.
If it shows an error, check the token hasn't expired.

## Token Renewal

Facebook Page Access tokens expire after 60 days.
When the gallery goes blank again, repeat Step 1 and update the token in Netlify.

## Your Page ID
`61579126693357`
