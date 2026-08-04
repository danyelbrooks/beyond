/**
 * token.js — Generates secure random tokens for owner portal links.
 * Each token is 32 cryptographically random bytes encoded as hex (64 chars).
 */

import crypto from 'crypto'

export function generateToken() {
  return crypto.randomBytes(32).toString('hex')
}
