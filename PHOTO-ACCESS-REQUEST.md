# Request: let an app read a work-order attachment's contents

**Ask:** have `facilio-cmms.download-work-order-attachment` return `file_base64`
alongside `file_signed_url`, exactly as `facilio-cmms.download-a-file-field` already
does.

**Who this affects:** any Vibe app or connected app that needs the *contents* of a file
held in Facilio — photos, scans, documents. Not one app.

---

## The gap

A browser-based app can locate a work order's before-photos and can obtain a download
URL for each, but cannot read a single byte of any of them.

| Action | Returns | Usable from a browser? |
|---|---|---|
| `list-workorder-attachments` | metadata only — id, fileName, fileSize, contentType, type | n/a |
| `download-work-order-attachment` | `file_signed_url` | **No** |
| `download-a-file-field` | **`file_base64`** | Yes — but cannot target an attachment |

The signed URL is unusable from a browser because the storage host sends no
`Access-Control-Allow-Origin` header. Verified with a GET carrying an `Origin` header —
every header returned:

```
HTTP/1.1 200 OK
x-amz-id-2, x-amz-request-id, Date, Last-Modified, ETag,
x-amz-server-side-encryption, Accept-Ranges,
Content-Type: image/jpeg;charset=ISO-8859-1
Content-Length: 253005
Server: AmazonS3
```

Eleven headers, no `Access-Control-*` among them. The browser discards the body and
rejects `fetch()` with a bare `TypeError` — no status, no headers — so the page cannot
even report the cause.

## The capability already exists

`download-a-file-field` returns file contents inline as base64. Its own description
says so: *"Returns the file base64-encoded, ready to decode, parse, save, or forward."*

And it demonstrably works over this exact path. Calling it with a deliberately wrong
module name returned:

```
file_base64: "eyJzdWNjZXNzIjpmYWxzZSwiZXJyb3IiOn…"
  → decodes to {"success":false,"error":{"code":"MODULE_NOT_FOUND",
                "message":"Module 'attachment' does not exist"}}
```

So the base64 return path is real and end-to-end functional. It simply cannot be aimed
at an attachment:

- `attachment`, `workorderattachment`, `attachments`, `workorderattachments` →
  `MODULE_NOT_FOUND`. Attachments are not among the org's 44 modules.
- `workorder` + `content` → `INVALID_FIELD`. The work-order module has no FILE-type
  field at all; its data types are BOOLEAN, DATE_TIME, LOOKUP, NUMBER, STRING and
  SYSTEM_ENUM.

Hence the request: add the field that the sibling action already returns.

## Why this is preferable to a CORS policy

Both would work, but this one needs no browser exemption at all. A Vibe app calls
connection actions through its own origin (`POST /api/runtime/connections/…/execute`),
so JSON containing base64 arrives normally, with no cross-origin question raised. It is
also a smaller change: one field on one action, consistent with an action already
shipping in the same connection.

If a CORS policy on `us-facilio-connections-files` is preferred instead:

```json
[{ "AllowedOrigins": ["https://*.vibe.facilio.com", "https://*.vibes.facilio.studio"],
   "AllowedMethods": ["GET"], "AllowedHeaders": ["*"],
   "ExposeHeaders": ["Content-Type", "Content-Length"], "MaxAgeSeconds": 3000 }]
```

That grants a browser nothing another client does not already have: the URLs are
pre-signed, unauthenticated, documented as publicly accessible, expire after 900
seconds, and point at a per-call throwaway copy. CORS governs which page origins may
*read a response*, not who may fetch — so leaving it unset closes no gap while blocking
first-party apps.

## Why there is no workaround on the app side

- **A server function cannot relay the bytes.** Its `fetch` response exposes only
  `text` and `json`; `arrayBuffer` raises `TypeError: not a function`, and there is no
  `btoa` or `Buffer`. Reading the JPEG as text yields 186,304 characters for a
  253,005-byte file with 78,878 U+FFFD replacement characters.
- **The bytes must reach the browser.** `vibe.uploadFile` is browser-only and
  `vibe.executeAgent` accepts only `fileIds`, which exist only for uploaded files. So
  the browser is the one participant that must hold the file, and the only one refused.
- **No proxy exists.** `vibe.executeAction` proxies the call and returns the JSON
  verbatim; it handles `__file__` / `output_type` nowhere in the SDK.
- **A function cannot reach the agents service either** — `process.system` exposes
  `AGENTS_TOKEN` but no `AGENTS_URL`.

## A second, smaller issue nearby

Every `download-work-order-attachment` call copies the attachment into
`connections/<org>/action-outputs/` under a new random name, and nothing appears to
clean up. Two consecutive calls for the same photo returned `file_id` 475 and 476 with
different objects; the counter moved 420 → 476 during one afternoon of testing — around
fifty orphaned 250 KB copies of the same few files. A lifecycle rule on that prefix
would help.

---

## What changes on the app side once this lands

Small. The app already calls `download-work-order-attachment` per photo. With
`file_base64` present it decodes the string to a `Uint8Array`, wraps it in a `Blob`, and
continues into the existing upload-and-analyse path. No architectural change.
