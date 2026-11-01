/**
 * dsh-webot — Host half (M1 skeleton).
 *
 * M1 owns exactly one thing: a status endpoint the settings panel can read, so the
 * button, the panel and the transport are all proven to work before any WeChat
 * protocol code exists.
 *
 * The route is registered on the shared browser connection channel
 * (`ctx.connection.fetch`) rather than on the raw web server, so it inherits
 * Harness authentication, Host/Origin admission and the request middleware. A raw
 * `webServer.register` route would answer unauthenticated requests, which is not
 * acceptable for a channel that will later expose account state.
 *
 * M2 replaces the constant body below with the real channel state (bound accounts,
 * long-poll liveness, last error). The wire shape is already the one the panel
 * reads, so the panel does not change at that point.
 *
 * @module dsh-webot
 */

/** The row needs the browser connection channel to serve the panel. */
export const inject = ['connection']

/** Exact path the Client half reads. Kept in sync with `STATUS_URL` in client.js. */
const STATUS_PATH = '/api/webot/status'

/** Plugin version reported to the panel; kept in sync with package.json. */
const VERSION = '0.1.0'

/**
 * Build the status document.
 *
 * Every field is a fact the panel renders verbatim. `phase` is the channel's own
 * state machine value: `idle` until an account is bound, then `connected` /
 * `reconnecting` / `failed`. Only `idle` is reachable in M1.
 *
 * @returns the status wire shape.
 */
function readStatus() {
  return {
    ok: true,
    plugin: 'dsh-webot',
    version: VERSION,
    milestone: 'M1',
    connected: false,
    needsLogin: false,
    phase: 'idle',
    accounts: [],
    errors: [],
    checkedAt: new Date().toISOString(),
  }
}

/**
 * Register the status route for the plugin's lifetime.
 *
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: STATUS_PATH,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: () => Response.json(readStatus()),
      }),
    'dsh-webot: status route',
  )
}
