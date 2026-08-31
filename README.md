# StockSimple

StockSimple turns paper stock sheets into reviewable inventory records.

## Environment

Set these Vercel environment variables before using **Approve & save**:

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (server-only; never expose this in client code)

The current UI intentionally keeps OCR out of the final-save path until the real handwritten form is available for field mapping and testing.
