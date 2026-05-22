# Video Ad Agent on Render

This version uses one Render Web Service for the frontend and backend.

## Current real workflow

Shopify SKU/product lookup -> OpenRouter text/video generation -> poll video job -> save MP4 to Google Drive -> show video and Drive link in the frontend.

Ad platform APIs are not required for the current stage.

## Required Render environment variables

Set these in Render Dashboard -> Web Service -> Environment:

- `SHOPIFY_STORE_DOMAIN` such as `78053a-15.myshopify.com`; do not include `https://`.
- `SHOPIFY_ADMIN_TOKEN` from Shopify custom app Admin API access token.
- `OPENROUTER_API_KEY`.
- `OPENROUTER_TEXT_MODEL`, recommended `anthropic/claude-3.7-sonnet`.
- `OPENROUTER_VIDEO_MODEL`, recommended `google/veo-3.1-lite` for first tests.
- `OPENROUTER_VIDEO_DURATION=4`.
- `OPENROUTER_VIDEO_RESOLUTION=720p`.
- `OPENROUTER_VIDEO_ASPECT_RATIO=16:9`.
- `GOOGLE_CLIENT_EMAIL`.
- `GOOGLE_PRIVATE_KEY`.
- `GOOGLE_DRIVE_FOLDER_ID`.

## Render settings

Build Command:

```bash
npm install
```

Start Command:

```bash
npm start
```

Health Check Path:

```txt
/health
```

## Testing

1. Open `/health` and confirm it returns JSON.
2. Enter a real Shopify SKU and press Enter.
3. Click video generation.
4. Wait for OpenRouter async video generation to complete.
5. Confirm an MP4 appears in the configured Google Drive folder.

OpenRouter video generation is asynchronous, so generation can take minutes depending on model and queue.
