/**
 * Inbox polling worker.
 *
 * Against a 0.6+ broker this is a **long-poll**: one held request that the
 * broker answers the instant a message lands, so delivery latency stops being
 * "up to one poll period" and the empty-response chatter disappears (the
 * pre-2026-09-19 shape burned ~39k requests/day to move 27 messages). The
 * adaptive backoff is kept for the *error* path only, and it doubles as the
 * fallback cadence for an older broker that ignores `wait_seconds`.
 *
 * Logging is rate-limited: first failure, backoff-step changes and every
 * ~10 minutes at the cap log one line; recovery logs exactly once.
 *
 * Extracted from lib/index.js (2026-08-29 stabilization split).
 */
export function createInboxWorker({ cfg, diag, getClient, handleMessage, isStopping }) {
  let inboxBusy = false
  let lastError = null
  let lastPollAt = null
  let pollTimer = null
  let retryAfterMs = 0
  let consecutiveFailures = 0
  let lastLoggedBackoffMs = 0
  let lastActivityAt = Date.now()

  async function inboxTick() {
    const client = getClient()
    if (!client || inboxBusy || isStopping()) return
    inboxBusy = true
    try {
      const messages = await client.pull({ limit: 4, waitSeconds: cfg.longPollSeconds })
      if (lastError && consecutiveFailures > 0) {
        // 恢复只报一次（2026-08-29 整治：连败期间限流日志，避免 agent-relay-boot.log 无限膨胀）
        diag('broker reachable again after ' + consecutiveFailures + ' failed attempt(s)')
      }
      retryAfterMs = 0
      consecutiveFailures = 0
      for (const m of messages) {
        if (isStopping()) break
        lastActivityAt = Date.now()
        try {
          await handleMessage(m)
        } catch (e) {
          diag('message ' + m.message_id + ' handling failed: ' + e.message)
          try { await client.ack(m.message_id, 'retry', String(e?.message || 'error').slice(0, 300)) } catch { /* best-effort */ }
        }
      }
      lastError = null
      return messages.length
    } catch (e) {
      retryAfterMs = retryAfterMs === 0 ? 2000 : Math.min(retryAfterMs * 2, 30000)
      lastError = e?.message || String(e)
      consecutiveFailures += 1
      // First failure, each backoff step change, and one line every ~10 min at
      // the cap get logged; the rest stay silent.
      const shouldLog = consecutiveFailures === 1
        || retryAfterMs !== lastLoggedBackoffMs
        || consecutiveFailures % 20 === 0
      if (shouldLog) {
        lastLoggedBackoffMs = retryAfterMs
        diag('broker unreachable, backing off ' + retryAfterMs + 'ms (consecutive ' + consecutiveFailures + '): ' + lastError)
      }
      return 0
    } finally {
      inboxBusy = false
      lastPollAt = new Date().toISOString()
    }
  }

  function scheduleNextPoll() {
    if (isStopping()) return
    let delay = cfg.fastPollSeconds * 1000
    if (retryAfterMs > 0) {
      delay = retryAfterMs
    } else if (Date.now() - lastActivityAt > cfg.idleAfterSeconds * 1000) {
      delay = cfg.idlePollSeconds * 1000
    }
    // Use a plain setTimeout (not ctx.timeout, which is registered as a cordis
    // effect and can drop the recursive chain on some harnesses).
    pollTimer = setTimeout(() => {
      pollTimer = null
      inboxTick()
        .then((count) => {
          // Backlog: drain immediately instead of idling for another period.
          if (count > 0 && !isStopping()) return inboxTick()
          return undefined
        })
        .catch((e) => diag('inbox tick error: ' + e.message))
        .finally(() => scheduleNextPoll())
    }, delay)
  }

  function stop() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null }
  }

  return {
    scheduleNextPoll,
    stop,
    getLastError: () => lastError,
    getLastPollAt: () => lastPollAt,
  }
}
