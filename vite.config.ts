import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * The Vibe SDK is origin-relative by design: it calls `/api/runtime/...` on
 * `window.location.origin` and relies on a session cookie set for that host
 * ("No CORS is required for the supported deployment model" — @facilio/vibe-sdk).
 *
 * In production that origin is the deployed app, so it just works. On a dev
 * server it is `localhost`, where nothing answers `/api/runtime` — every
 * function call 404s and the app renders empty.
 *
 * These proxies close that gap: the runtime and identity paths are forwarded to
 * the deployed app, and `cookieDomainRewrite` re-hosts the session cookie onto
 * localhost so it flows back on the next request. Dev only — the production
 * build never sees this config.
 */
/**
 * Where the dev server sends runtime calls. Defaults to the deployed app; set
 * VIBE_PROXY_TARGET to point at a local stand-in when working on the UI without
 * a Facilio session.
 */
const VIBE_APP_ORIGIN =
  process.env.VIBE_PROXY_TARGET ?? 'https://condition-assessment-agent.vibe.facilio.com'

const proxyToVibe = {
  target: VIBE_APP_ORIGIN,
  changeOrigin: true,
  secure: true,
  cookieDomainRewrite: 'localhost',
  configure(proxy: any) {
    proxy.on('proxyRes', (proxyRes: any) => {
      // identity-service marks its CSRF cookie `Secure`, which the dev server —
      // plain http on localhost — cannot be relied on to store. Without that
      // cookie the login POST has no CSRF token and the sign-in form fails with
      // "Unable to login, please try again". Dropping the flag is safe here and
      // only ever runs against localhost.
      const cookies = proxyRes.headers['set-cookie']
      if (cookies) {
        proxyRes.headers['set-cookie'] = cookies.map((c: string) =>
          c.replace(/;\s*Secure/gi, '').replace(/;\s*SameSite=None/gi, '; SameSite=Lax'),
        )
      }
    })
  },
}

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/runtime': proxyToVibe,
      '/identity': proxyToVibe,
    },
  },
})
