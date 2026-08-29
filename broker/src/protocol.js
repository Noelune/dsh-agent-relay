/**
 * v2/v3 wire protocol primitives.
 *
 * Single canonical copy: lib/protocol.js (inside the publishable,
 * self-contained dsh-agent-relay package). This file is a re-export shim so
 * broker code can keep importing './protocol.js'. Do not add protocol logic
 * here — change lib/protocol.js instead.
 */
export * from '../../lib/protocol.js'
