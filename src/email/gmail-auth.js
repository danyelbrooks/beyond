/**
 * gmail-auth.js — One-time Gmail authorization script
 *
 * Run this once to connect your Gmail account to the app:
 *
 *   node src/email/gmail-auth.js
 *
 * What it does:
 *   1. Opens your browser automatically to the Google sign-in page
 *   2. You sign in and click Allow
 *   3. Google redirects back to this script automatically
 *   4. Saves the token — you never need to run this again
 */

import 'dotenv/config'
import { readFile, writeFile } from 'fs/promises'
import { createServer }        from 'http'
import { exec }                from 'child_process'
import { google }              from 'googleapis'

const CLIENT_PATH   = process.env.GOOGLE_OAUTH_CLIENT_PATH
const TOKEN_PATH    = process.env.GOOGLE_TOKEN_PATH
const REDIRECT_PORT = 3001
const REDIRECT_URI  = `http://localhost:${REDIRECT_PORT}`

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify'
]

async function main() {
  if (!CLIENT_PATH) {
    console.error('Error: GOOGLE_OAUTH_CLIENT_PATH is not set in your .env file.')
    process.exit(1)
  }
  if (!TOKEN_PATH) {
    console.error('Error: GOOGLE_TOKEN_PATH is not set in your .env file.')
    process.exit(1)
  }

  // Read the OAuth client credentials file
  let clientCredentials
  try {
    const raw = await readFile(CLIENT_PATH, 'utf8')
    clientCredentials = JSON.parse(raw)
  } catch (err) {
    console.error(`Error: Could not read OAuth client file at "${CLIENT_PATH}".\n${err.message}`)
    process.exit(1)
  }

  const creds = clientCredentials.web || clientCredentials.installed
  if (!creds) {
    console.error(`Error: The file at "${CLIENT_PATH}" doesn't look like an OAuth client file.`)
    process.exit(1)
  }

  const { client_id, client_secret } = creds

  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI)

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt:      'consent',
    scope:       SCOPES
  })

  console.log('\nOpening your browser to authorize Gmail access...')
  console.log('If the browser does not open, copy and paste this URL:\n')
  console.log(authUrl + '\n')

  // Open the browser automatically
  exec(`start "" "${authUrl}"`)

  // Start a local server to catch the redirect from Google
  const code = await waitForCode()

  // Exchange the code for tokens
  let tokens
  try {
    const response = await oauth2Client.getToken(code)
    tokens = response.tokens
  } catch (err) {
    console.error(`Error: Could not exchange the code for a token.\n${err.message}`)
    process.exit(1)
  }

  if (!tokens.refresh_token) {
    console.error(
      'Warning: No refresh token received.\n' +
      'Go to https://myaccount.google.com/permissions, remove access for "BPM Command Center", then run this script again.'
    )
    process.exit(1)
  }

  await writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2), 'utf8')

  console.log(`\nAuthorization complete. Token saved.`)
  console.log('You can now run: npm run sync:email\n')
  process.exit(0)
}

/** Start a temporary HTTP server on localhost to catch the OAuth redirect. */
function waitForCode() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url    = new URL(req.url, `http://localhost:${REDIRECT_PORT}`)
      const code   = url.searchParams.get('code')
      const error  = url.searchParams.get('error')

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<h2>Authorization cancelled.</h2><p>You can close this tab.</p>')
        server.close()
        reject(new Error(`Authorization cancelled: ${error}`))
        return
      }

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<h2>Authorization complete!</h2><p>You can close this tab and return to the terminal.</p>')
        server.close()
        resolve(code)
      }
    })

    server.listen(REDIRECT_PORT, () => {
      console.log(`Waiting for Google to redirect back... (listening on port ${REDIRECT_PORT})`)
    })

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`Error: Port ${REDIRECT_PORT} is already in use. Close whatever is running on it and try again.`)
      } else {
        console.error(`Server error: ${err.message}`)
      }
      process.exit(1)
    })
  })
}

main()
