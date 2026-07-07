# Client Onboarding Tool - Complete Technical Documentation

## Table of Contents
1. [Overview](#overview)
2. [Live URLs & Access](#live-urls--access)
3. [Technology Stack](#technology-stack)
4. [Project Structure](#project-structure)
5. [Database Schema](#database-schema)
6. [API Endpoints](#api-endpoints)
7. [Authentication & Security](#authentication--security)
8. [Frontend Components](#frontend-components)
9. [Data Flow](#data-flow)
10. [Environment Variables](#environment-variables)
11. [Deployment Architecture](#deployment-architecture)
12. [Onboarding Steps](#onboarding-steps)

---

## Overview

The Client Onboarding Tool is a multi-step wizard application designed for digital marketing agencies to collect comprehensive information from new clients. It features:

- **12 comprehensive onboarding sections** covering business info, goals, brand, technical access, analytics, SEO, PPC, and more
- **Auto-save functionality** - Progress saved automatically after each step
- **Resume capability** - Clients can close and return anytime via their unique token URL
- **Token-based access** - Secure 64-character hex tokens, no client login required
- **Admin dashboard** - Create sessions, view all sessions, see detailed responses
- **Logo upload** - Custom client branding throughout the wizard

---

## Live URLs & Access

| Resource | URL |
|----------|-----|
| **Production App** | https://client-onboarding-tool.vercel.app |
| **GitHub Repository** | https://github.com/JLcilliers/client-onboarding-tool |
| **Supabase Dashboard** | https://supabase.com/dashboard/project/gmvdmgcueveuedhkucsh |
| **Vercel Dashboard** | https://vercel.com/johan-cilliers-projects/client-onboarding-tool |

### Key Application Routes

| Route | Purpose |
|-------|---------|
| `/` | Homepage with feature overview |
| `/admin/onboarding/new` | Create new onboarding session |
| `/admin/onboarding/sessions` | View all onboarding sessions |
| `/admin/onboarding/sessions/[id]` | View specific session details |
| `/onboarding/[token]` | Client-facing wizard (token-based access) |

---

## Technology Stack

### Frontend
- **Next.js 16.1.0** - React framework with App Router
- **TypeScript** - Type-safe JavaScript
- **Tailwind CSS v4** - Utility-first CSS framework
- **React Hooks** - State management (useState, useEffect)

### Backend
- **Next.js API Routes** - Serverless functions
- **Supabase** - Backend-as-a-Service
  - PostgreSQL database
  - Row Level Security (RLS)
  - Storage buckets for file uploads

### Infrastructure
- **Vercel** - Hosting and deployment
- **GitHub** - Source control
- **Supabase Cloud** - Database hosting

### Key Dependencies
```json
{
  "next": "16.1.0",
  "@supabase/supabase-js": "^2.x",
  "@supabase/ssr": "^0.x",
  "zod": "^3.x",
  "uuid": "^9.x",
  "tailwindcss": "^4.x"
}
```

---

## Project Structure

```
client-onboarding-tool/
├── src/
│   ├── app/                          # Next.js App Router
│   │   ├── page.tsx                  # Homepage
│   │   ├── layout.tsx                # Root layout
│   │   ├── globals.css               # Global styles
│   │   ├── admin/
│   │   │   └── onboarding/
│   │   │       ├── new/
│   │   │       │   └── page.tsx      # Create new session
│   │   │       └── sessions/
│   │   │           ├── page.tsx      # Sessions list
│   │   │           └── [id]/
│   │   │               └── page.tsx  # Session detail
│   │   ├── onboarding/
│   │   │   └── [token]/
│   │   │       ├── page.tsx          # Client wizard entry
│   │   │       └── not-found.tsx     # 404 for invalid tokens
│   │   └── api/
│   │       ├── admin/
│   │       │   └── onboarding/
│   │       │       ├── create/
│   │       │       │   └── route.ts  # POST: Create session
│   │       │       └── sessions/
│   │       │           ├── route.ts  # GET: List sessions
│   │       │           └── [id]/
│   │       │               └── route.ts  # GET: Session detail
│   │       └── public/
│   │           └── onboarding/
│   │               ├── session/
│   │               │   └── route.ts  # GET: Fetch by token
│   │               ├── save-step/
│   │               │   └── route.ts  # POST: Save step answers
│   │               └── submit/
│   │                   └── route.ts  # POST: Submit onboarding
│   ├── components/
│   │   └── onboarding/
│   │       └── Wizard.tsx            # Main wizard component
│   └── lib/
│       ├── supabase/
│       │   ├── client.ts             # Browser Supabase client
│       │   └── server.ts             # Server Supabase client
│       └── onboarding/
│           └── steps.ts              # Step definitions & schemas
├── .env.local                        # Environment variables
├── package.json
├── tailwind.config.ts
├── tsconfig.json
└── next.config.ts
```

---

## Database Schema

### Supabase PostgreSQL Tables

#### 1. agency_accounts
Stores agency/admin account information.

```sql
CREATE TABLE agency_accounts (
  id UUID PRIMARY KEY,
  agency_name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### 2. clients
Stores client information linked to agencies.

```sql
CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id UUID REFERENCES agency_accounts(id),
  client_name TEXT NOT NULL,
  primary_contact_name TEXT,
  primary_contact_email TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### 3. onboarding_sessions
Stores onboarding session state and progress.

```sql
CREATE TABLE onboarding_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id UUID REFERENCES agency_accounts(id),
  client_id UUID REFERENCES clients(id),
  token TEXT UNIQUE NOT NULL,           -- 64-char hex token
  status TEXT DEFAULT 'draft',           -- draft, in_progress, submitted
  current_step INTEGER DEFAULT 0,
  last_saved_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  logo_path TEXT,                        -- Storage path for logo
  logo_url TEXT,                         -- Signed URL for logo
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### 4. onboarding_answers
Stores answers for each step of the onboarding.

```sql
CREATE TABLE onboarding_answers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES onboarding_sessions(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,                -- e.g., 'business_overview'
  answers JSONB NOT NULL,                -- Step answers as JSON
  completed BOOLEAN DEFAULT FALSE,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(session_id, step_key)           -- One answer per step per session
);
```

#### 5. onboarding_audit_events
Tracks session access and events for auditing.

```sql
CREATE TABLE onboarding_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES onboarding_sessions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,              -- e.g., 'session_accessed'
  payload JSONB,                         -- Event metadata
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Storage Buckets

| Bucket Name | Purpose | Access |
|-------------|---------|--------|
| `onboarding-logos` | Client logo uploads | Authenticated users |

---

## API Endpoints

### Admin API Endpoints (Server-side, uses Service Role Key)

#### POST `/api/admin/onboarding/create`
Creates a new onboarding session.

**Request Body:**
```json
{
  "clientName": "Test Corp",
  "contactName": "Jane Doe",
  "contactEmail": "jane@testcorp.com",
  "logoBase64": "data:image/png;base64,...",  // Optional
  "logoFileName": "logo.png"                   // Optional
}
```

**Response:**
```json
{
  "success": true,
  "token": "25ec09492c761c63cd88cfb0c6441e41594cd0c19b139dcb2cc081ebddd62f23",
  "sessionId": "431316e1-62b7-4d72-80be-db1ba166dcc8"
}
```

#### GET `/api/admin/onboarding/sessions`
Lists all onboarding sessions.

**Response:**
```json
{
  "sessions": [
    {
      "id": "431316e1-62b7-4d72-80be-db1ba166dcc8",
      "token": "25ec09...",
      "status": "in_progress",
      "current_step": 1,
      "last_saved_at": "2025-12-21T12:59:00Z",
      "created_at": "2025-12-21T12:57:00Z",
      "clients": {
        "client_name": "Test Corp",
        "primary_contact_email": "jane@testcorp.com"
      }
    }
  ]
}
```

#### GET `/api/admin/onboarding/sessions/[id]`
Gets detailed session information including answers.

**Response:**
```json
{
  "session": {
    "id": "...",
    "token": "...",
    "status": "in_progress",
    "current_step": 1,
    "clients": {
      "client_name": "Test Corp",
      "primary_contact_name": "Jane Doe",
      "primary_contact_email": "jane@testcorp.com"
    }
  },
  "answers": [
    {
      "step_key": "business_overview",
      "answers": {
        "legalBusinessName": "Test Corp LLC",
        "websiteUrl": "https://testcorp.com"
      },
      "completed": true,
      "updated_at": "2025-12-21T12:59:00Z"
    }
  ]
}
```

### Public API Endpoints (Token-based access)

#### GET `/api/public/onboarding/session?token=xxx`
Fetches session data for the wizard.

**Response:**
```json
{
  "session": {
    "id": "...",
    "status": "in_progress",
    "currentStep": 1,
    "logoUrl": "https://...",
    "lastSavedAt": "2025-12-21T12:59:00Z"
  },
  "answers": {
    "business_overview": {
      "answers": {...},
      "completed": true
    }
  },
  "steps": [
    {
      "key": "business_overview",
      "title": "Business Overview",
      "description": "...",
      "estimatedTime": "5 min"
    }
  ],
  "totalSteps": 12
}
```

#### POST `/api/public/onboarding/save-step`
Saves answers for a specific step.

**Request Body:**
```json
{
  "token": "25ec09...",
  "stepKey": "business_overview",
  "answers": {
    "legalBusinessName": "Test Corp LLC",
    "websiteUrl": "https://testcorp.com"
  },
  "currentStep": 1
}
```

**Response:**
```json
{
  "success": true,
  "lastSavedAt": "2025-12-21T12:59:00Z"
}
```

#### POST `/api/public/onboarding/submit`
Submits the completed onboarding.

**Request Body:**
```json
{
  "token": "25ec09..."
}
```

**Response:**
```json
{
  "success": true,
  "submittedAt": "2025-12-21T13:30:00Z"
}
```

---

## Authentication & Security

### Token-Based Access (Client-Facing)
- **64-character hexadecimal tokens** generated using `crypto.randomBytes(32)`
- Tokens are unique per session and stored in `onboarding_sessions.token`
- No authentication required - tokens act as secure, shareable links
- Example: `/onboarding/25ec09492c761c63cd88cfb0c6441e41594cd0c19b139dcb2cc081ebddd62f23`

### Admin Access
- Admin API routes use **Supabase Service Role Key**
- Service Role Key bypasses Row Level Security (RLS)
- Only used server-side, never exposed to browser

### Supabase Clients

#### Browser Client (`src/lib/supabase/client.ts`)
```typescript
import { createBrowserClient } from '@supabase/ssr';

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
```

#### Server Client (`src/lib/supabase/server.ts`)
```typescript
import { createClient } from '@supabase/supabase-js';

export function createServiceRoleClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );
}
```

---

## Frontend Components

### Wizard Component (`src/components/onboarding/Wizard.tsx`)
The main wizard component handles:

1. **Step Navigation** - Previous/Next buttons, step indicators
2. **Form Rendering** - Dynamic fields based on step configuration
3. **Auto-save** - Saves on Continue click, shows "Saving..." indicator
4. **Progress Tracking** - Shows current step and percentage complete
5. **Logo Display** - Shows client logo with spinning animation

**Props:**
```typescript
interface WizardProps {
  token: string;
  initialStep: number;
  initialAnswers: Record<string, { answers: Record<string, unknown>; completed: boolean }>;
  logoUrl: string | null;
  sessionStatus: 'draft' | 'in_progress' | 'submitted';
}
```

### Step Definitions (`src/lib/onboarding/steps.ts`)
Defines all 12 onboarding steps with:
- **key** - Unique identifier (e.g., 'business_overview')
- **title** - Display name
- **description** - Step description
- **estimatedTime** - Time estimate for user
- **fields** - Array of form field definitions
- **schema** - Zod validation schema

---

## Data Flow

### Creating a New Session

```
Admin Form → POST /api/admin/onboarding/create
                    ↓
           createServiceRoleClient()
                    ↓
           INSERT agency_accounts (if needed)
                    ↓
           INSERT clients
                    ↓
           INSERT onboarding_sessions (with token)
                    ↓
           Upload logo to Storage (if provided)
                    ↓
           Return { token, sessionId }
                    ↓
           Display shareable URL to admin
```

### Client Completing Onboarding

```
Client visits /onboarding/[token]
                    ↓
GET /api/public/onboarding/session?token=xxx
                    ↓
Fetch session + answers from Supabase
                    ↓
Render Wizard with initial data
                    ↓
Client fills step → Clicks Continue
                    ↓
POST /api/public/onboarding/save-step
                    ↓
UPSERT onboarding_answers
UPDATE onboarding_sessions (current_step, status)
                    ↓
Show "Saved" indicator → Advance to next step
                    ↓
... repeat for each step ...
                    ↓
Final step → POST /api/public/onboarding/submit
                    ↓
UPDATE status = 'submitted', submitted_at = NOW()
```

### Admin Viewing Sessions

```
Admin visits /admin/onboarding/sessions
                    ↓
GET /api/admin/onboarding/sessions
                    ↓
SELECT from onboarding_sessions JOIN clients
                    ↓
Display sessions table
                    ↓
Click View → /admin/onboarding/sessions/[id]
                    ↓
GET /api/admin/onboarding/sessions/[id]
                    ↓
Fetch session + all answers
                    ↓
Display expandable sections with answers
```

---

## Environment Variables

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL | `https://xxxx.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anonymous key | `eyJhbGc...` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key | `eyJhbGc...` |
| `NEXT_PUBLIC_SITE_URL` | Production site URL | `https://client-onboarding-tool.vercel.app` |

### Local Development (.env.local)
```env
# Supabase Configuration
NEXT_PUBLIC_SUPABASE_URL=https://gmvdmgcueveuedhkucsh.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

### Vercel Environment Variables
All variables are configured in Vercel Dashboard → Settings → Environment Variables for the Production environment.

---

## Deployment Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         VERCEL                                   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    Next.js App                           │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐ │   │
│  │  │   Static    │  │   Server    │  │   API Routes    │ │   │
│  │  │   Pages     │  │ Components  │  │  (Serverless)   │ │   │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘ │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                   │
│                              ▼                                   │
│                    Environment Variables                         │
│                    (SUPABASE_*, NEXT_PUBLIC_*)                  │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                        SUPABASE                                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│  │   PostgreSQL    │  │    Storage      │  │      Auth       │ │
│  │   Database      │  │   (Logos)       │  │   (optional)    │ │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘ │
│           │                    │                                 │
│           ▼                    ▼                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              Row Level Security (RLS)                    │   │
│  │         + Service Role Key bypass for admin             │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                         GITHUB                                   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Repository: JLcilliers/client-onboarding-tool          │   │
│  │  Branch: main                                            │   │
│  │  Auto-deploy to Vercel on push                          │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Onboarding Steps

The wizard includes 12 comprehensive steps:

| # | Key | Title | Est. Time | Description |
|---|-----|-------|-----------|-------------|
| 1 | `business_overview` | Business Overview | 5 min | Company info, contacts, competitors |
| 2 | `goals_kpis` | Goals & KPIs | 4 min | Primary goals, targets, metrics |
| 3 | `brand_compliance` | Brand & Compliance | 3 min | Brand guidelines, legal requirements |
| 4 | `website_technical` | Website & Technical Access | 5 min | CMS, hosting, technical details |
| 5 | `analytics_tracking` | Analytics & Tracking | 4 min | Google Analytics, tracking setup |
| 6 | `search_console` | Google Search Console | 3 min | GSC access and configuration |
| 7 | `local_seo` | Local SEO & GBP | 4 min | Google Business Profile, local presence |
| 8 | `seo_discovery` | SEO Discovery | 5 min | Keywords, content, SEO history |
| 9 | `ppc_paid_media` | PPC & Paid Media | 5 min | Ad accounts, budgets, platforms |
| 10 | `social_creative` | Social & Creative | 4 min | Social accounts, creative assets |
| 11 | `sales_operations` | Sales Pipeline & Ops | 4 min | CRM, sales process, operations |
| 12 | `review_submit` | Review & Submit | 2 min | Final review and submission |

### Field Types Supported
- `text` - Single line text input
- `textarea` - Multi-line text
- `email` - Email validation
- `url` - URL validation
- `phone` - Phone number
- `select` - Dropdown selection
- `multiselect` - Multiple selection
- `checkbox` - Boolean checkbox
- `radio` - Radio button group
- `file` - File upload

---

## Summary

The Client Onboarding Tool is a production-ready application that:

1. **Simplifies client onboarding** with a guided 12-step wizard
2. **Ensures data is never lost** with automatic saving
3. **Provides flexibility** with token-based access (no client accounts needed)
4. **Gives admins full visibility** into all sessions and responses
5. **Is built on modern, scalable infrastructure** (Next.js, Supabase, Vercel)

For any questions or issues, refer to:
- GitHub Issues: https://github.com/JLcilliers/client-onboarding-tool/issues
- Supabase Logs: https://supabase.com/dashboard/project/gmvdmgcueveuedhkucsh/logs
- Vercel Logs: https://vercel.com/johan-cilliers-projects/client-onboarding-tool

---

*Documentation generated: December 21, 2025*
