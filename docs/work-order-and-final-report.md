# Work Orders & Final Report

## Overview

After a client submits their onboarding, the system automatically generates an internal work order with default task assignments and compiles a Final Report combining all collected data.

## Internal Work Order

### Default Onboarding Tasks (always generated)

| Task | Default Owner | Description |
|------|---------------|-------------|
| Core Vitals | Dev Team | Core Web Vitals optimization |
| Third Party Javascript | Dev Team | Audit and optimize 3rd-party scripts |
| Google Tag Manager (GTM) | Keith | GTM setup and configuration |
| Phone Number and Form Audit | Dev Team | Verify all phone numbers and forms |
| Hosting Stack | Predrag | Hosting infrastructure setup |
| WordPress Stack SOP | Dev Team | WordPress configuration and plugins |
| System Admin SOP | Predrag | System administration setup |
| Dev Ops SOP | Keith and Bogdan | DevOps pipeline and deployment |

### SOP-Triggered Tasks (conditional)

Added when SOP routing determines they're needed:

| SOP | Default Owner |
|-----|---------------|
| Registrar Migration SOP | Dev Team |
| DNS Migration SOP | Dev Team |
| Website Rebuild SOP | Dev Team |
| Written Content Replacement SOP | Content Team |
| Image Replacement SOP | Content Team |
| DNS Access SOP | Dev Team |
| Hosting Migration SOP | Predrag |

## Data Model

### `onboarding_work_orders` table

| Column | Type | Purpose |
|--------|------|---------|
| id | UUID PK | Record ID |
| session_id | UUID FK (unique) | Linked session |
| tasks | JSONB | Array of task objects |
| generated_at | TIMESTAMPTZ | When generated |
| final_report_status | TEXT | pending / in_progress / completed |
| assignees_defaulted | BOOLEAN | Whether default owners were used |

## Final Report

### Location
`/admin/onboarding/sessions/[id]/report`

### Sections
1. **Website Snapshot** — Screenshot, brand info, services, markets, colors
2. **SOP Routing — Big 5** — Grid showing each Big 5 answer (green/red/grey) + required SOPs list
3. **Internal Work Order** — Table of onboarding tasks + SOP tasks with owners and status
4. **Confirmed Onboarding Answers** — All submitted answers organized by step

### Export
- **Print/PDF** — Click "Print / Export PDF" button, uses browser print dialog
- **Printable layout** — Clean formatting with `@media print` styles

## When Work Orders Are Generated

1. **Automatically on submit** — Via `after()` callback in the submit endpoint
2. **Manually** — Admin can POST to `/api/admin/work-orders` with a sessionId

## API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/admin/work-orders` | POST | Generate work order for a session |
| `/api/admin/work-orders` | GET | Fetch work order for a session |
| `/api/admin/sop-routing` | POST | Compute SOP routing for a session |
| `/api/admin/sop-routing` | GET | Fetch SOP routing for a session |
