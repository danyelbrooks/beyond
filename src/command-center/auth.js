/**
 * auth.js — Shared authentication module for BPM Command Center
 *
 * Import this as an ES module on every page:
 *   <script type="module">
 *     import { requireAuth, renderHeader, renderSidebar } from './auth.js'
 *     ...
 *   </script>
 *
 * The Supabase client here uses the anon key (browser-safe).
 * Never import server-client.js from the browser.
 */

// =============================================================================
// SUPABASE CLIENT (browser — anon key)
// =============================================================================

// Load Supabase from the CDN script tag on the page, then create our client.
// The CDN bundle exposes `window.supabase` with a `createClient` method.
const SUPABASE_URL      = 'https://kyekqaxuzpozuhyhibcn.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt5ZWtxYXh1enBvenVoeWhpYmNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1MDE1MjksImV4cCI6MjA5ODA3NzUyOX0.UQp6Inqrvjfxax7AjRRujw6PXId9Whmknv5vkX8DcC8'

export const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// =============================================================================
// AUTH HELPERS
// =============================================================================

/**
 * Get the current user's profile row from the profiles table.
 * Returns the profile object, or null if not found.
 */
export async function getProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, role, active')
    .eq('id', userId)
    .single()

  if (error) {
    console.error('getProfile error:', error.message)
    return null
  }
  return data
}

/**
 * Check that the user is logged in. If not, redirect to index.html.
 * Returns { user, profile } if authenticated.
 */
export async function requireAuth() {
  const { data: { session } } = await supabase.auth.getSession()

  if (!session) {
    window.location.href = 'index.html'
    return null
  }

  const profile = await getProfile(session.user.id)

  if (!profile || !profile.active) {
    // Account deactivated — sign out and redirect
    await supabase.auth.signOut()
    window.location.href = 'index.html'
    return null
  }

  return { user: session.user, profile }
}

/**
 * Sign out and redirect to the login page.
 */
export async function logout() {
  await supabase.auth.signOut()
  window.location.href = 'index.html'
}

// =============================================================================
// SHARED HEADER
// =============================================================================

/**
 * Render the shared header into an element with id="app-header".
 * Shows the user's display_name and a logout button.
 */
export function renderHeader(profile) {
  const el = document.getElementById('app-header')
  if (!el) return

  el.innerHTML = `
    <span class="app-header-brand">BPM Command Center</span>
    <div class="app-header-right">
      <span class="app-header-user">${escHtml(profile.display_name)}</span>
      <button class="btn-logout" id="btn-logout">Sign Out</button>
    </div>
  `

  document.getElementById('btn-logout').addEventListener('click', logout)
}

// =============================================================================
// SHARED SIDEBAR
// =============================================================================

/**
 * Render the shared sidebar into an element with id="app-sidebar".
 *
 * @param {string} activeItem  - Key identifying the current page
 * @param {string} role        - The user's role: 'admin', 'manager', or 'staff'
 * @param {string} [email]     - The current user's email (used for role-gated links)
 */
export function renderSidebar(activeItem, role, email) {
  const el = document.getElementById('app-sidebar')
  if (!el) return

  const link = (href, label, key) => `
    <a href="${href}" class="nav-link${activeItem === key ? ' active' : ''}">${label}</a>
  `

  // Onboarding-only role — sees nothing but the onboarding tool
  if (role === 'onboarding') {
    el.innerHTML = `
      <div class="nav-section-label">Navigation</div>
      ${link('onboarding-dashboard.html', 'Onboarding', 'onboarding-dashboard')}
    `
    return
  }

  // KPI Entry — only visible to the data entry user
  const kpiEntryLink = email === 'care@bpmsd.com'
    ? link('kpi-entry.html', 'KPI Entry', 'kpi-entry')
    : ''

  // Hello@ Forwarding — the routing rules are a configuration page,
  // so only admin and manager see it
  const routingLink = (role === 'admin' || role === 'manager')
    ? link('routing-rules.html', 'Hello@ Forwarding', 'routing-rules')
    : ''

  // Analytics section — admin and manager only; KPI tracker visible to all
  let analyticsLinks = `
    <div class="nav-divider"></div>
    <div class="nav-section-label">Analytics</div>
    ${kpiEntryLink}
    ${link('team-scorecard.html',  'KPI Dashboard', 'team-scorecard')}
  `
  if (role === 'admin' || role === 'manager') {
    analyticsLinks += `
      ${link('portfolio.html',    'Portfolio',    'portfolio')}
      ${link('owner-health.html',    'Owner Health',      'owner-health')}
      ${link('owner-911.html',      '911 Take to 100%',  'owner-911')}
      ${link('resident-health.html','Resident Health',   'resident-health')}
    `
  }

  // Personal CFO — admin only
  if (role === 'admin') {
    analyticsLinks += `
      <div class="nav-divider"></div>
      <div class="nav-section-label">Personal</div>
      ${link('cfo-dashboard.html', 'Personal CFO', 'cfo-dashboard')}
    `
  }

  // Tools section — links to standalone apps (update hrefs to your deployment URLs)
  const toolsSection = `
    <div class="nav-divider"></div>
    <div class="nav-section-label">Tools</div>
    <a href="../turnover-board/turnover-board.html" class="nav-link nav-link-external" target="_blank">
      Turnover Board &#8599;
    </a>
    <a href="../utility-guardian/dashboard.html" class="nav-link nav-link-external" target="_blank">
      Utility Guardian &#8599;
    </a>
  `

  let adminSection = ''
  if (role === 'admin') {
    adminSection = `
      <div class="nav-divider"></div>
      <div class="nav-section-label">Admin</div>
      ${link('admin.html', 'Team', 'admin')}
    `
  }

  el.innerHTML = `
    <div class="nav-section-label">Navigation</div>
    ${link('dashboard.html',           'Dashboard',        'dashboard')}
    ${link('email-triage.html',        'Email Triage',     'email-triage')}
    ${routingLink}
    ${link('onboarding-dashboard.html','Onboarding',       'onboarding-dashboard')}
    ${link('sop-library.html',         'Best Practices',   'sop-library')}
    ${link('insurance-board.html',     'Project Mgmt',     'insurance-board')}
    ${analyticsLinks}
    ${toolsSection}
    ${adminSection}
  `
}

// =============================================================================
// INTERNAL HELPER
// =============================================================================

function escHtml(str) {
  if (str == null) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
