# AI Business Ecosystem — Setup Guide

This template gives you a ready-made command center for your business.
Follow these steps in order.

---

## Step 1 — Copy this repo to your own account

Click **"Use this template"** on GitHub to get your own private copy.
Then open it in Claude Code.

---

## Step 2 — Tell Claude about your business

Open the file called `CLAUDE.md` in the root folder.
Replace everything in `[BRACKETS]` with your own information:
- Your name and role
- Your company name
- Your team members
- The tools and software you use
- Your core values

This file is the brain. The more detail you put in, the smarter your assistant gets.

---

## Step 3 — Set up your database

Your command center stores data in a database called Supabase (free to start).
Ask Claude: *"Help me set up my Supabase database for this ecosystem."*
Claude will walk you through it step by step.

---

## Step 4 — Customize your pages

The `template/command-center/` folder contains your web pages.
Open each one and look for `[YOUR COMPANY]` and `[YOUR ...]` placeholders.
Replace them with your actual information, or ask Claude to do it for you.

**Pages included:**
| Page | What it does |
|---|---|
| `index.html` | Home / command center dashboard |
| `email-triage.html` | Manage your inbox |
| `email-detail.html` | Read and reply to emails |
| `sop-library.html` | Store your procedures and playbooks |
| `sop-editor.html` | Write and edit SOPs |
| `sop-detail.html` | View a single SOP |
| `sop-reminders.html` | SOP reminder alerts |
| `kpi-tracker.html` | Track your key metrics |
| `kpi-entry.html` | Log new KPI data |
| `kpi-dashboard.html` | View KPI trends |
| `team-scorecard.html` | Weekly team performance |
| `reset-password.html` | Login / password reset |

---

## Step 5 — Add your email addresses

Open `email-triage.html` and find this section near line 463:

```js
const inboxes = [
  'you@yourdomain.com',
  'help@yourdomain.com',
  ...
]
```

Replace with your actual business email addresses.

---

## Step 6 — Define your KPIs

Open `team-scorecard.html` and find the `CHEATSHEET` section.
Replace the `[DEFINE YOUR METRIC HERE]` placeholders with your own KPI definitions.
Add as many or as few as you need.

---

## That's it

Once set up, your command center lives at `http://localhost:3005` when running locally.
Ask Claude to add new pages or features anytime — that's what it's here for.
