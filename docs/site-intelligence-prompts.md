# Site Intelligence — Question Personalization Templates

## Design Principles

1. **"We noticed" language** — Present findings as observations, not facts
2. **Always confirm** — Every personalized question gives the client a way to correct
3. **Never claim private data** — No revenue, staff size, ad spend, or rankings
4. **Keep original fallback** — If override is dismissed, show the original question
5. **Editable always** — Even after confirmation, client can go back and change

## UI Patterns

### Confirmation Pattern

Used for high-confidence inferences. Shows a Yes/No prompt with the detected value.

```
┌─────────────────────────────────────────────────────┐
│ We noticed New York City looks like your primary    │
│ market, along with Brooklyn, Queens. Is that        │
│ correct?                                            │
│                                                     │
│ [Yes, that's correct]  [No, let me edit]           │
│                                                     │
│ ┌─────────────────────────────────────────────────┐ │
│ │ New York City, Brooklyn, Queens                 │ │
│ │ (textarea always visible for editing)           │ │
│ └─────────────────────────────────────────────────┘ │
│ Edit the areas below to adjust.                     │
└─────────────────────────────────────────────────────┘
```

### Suggest-Only Pattern

Used for moderate-confidence inferences. Shows a clickable chip.

```
┌─────────────────────────────────────────────────────┐
│ What cities or areas do you want to target? *       │
│ ┌─────────────────────────────────────────────────┐ │
│ │                                                 │ │
│ └─────────────────────────────────────────────────┘ │
│ 💡 Use suggestion: New York City, Brooklyn          │
└─────────────────────────────────────────────────────┘
```

## Override Templates

### Location Confirmation
- **Trigger:** `primary_locations[0].confidence >= 0.55`
- **Label:** `"We noticed {CITY} looks like your primary market{, along with OTHER_CITIES}. Is that correct?"`
- **Help:** `"Edit the areas below to adjust. Add or remove cities as needed."`

### Services Confirmation
- **Trigger:** `primary_services.length > 0` and top confidence >= 0.55
- **Label:** `"We noticed you focus on {SERVICE_LIST}. Is that accurate?"`
- **Help:** `"Edit the list below to add, remove, or reorder your services."`

### Platform/CMS Confirmation
- **Trigger:** `tech_stack.cms` detected
- **Label:** `"It looks like your site is built on {CMS}. Is that correct?"`
- **Help:** `"Select the correct platform if this doesn't look right."`

### Business Name Confirmation
- **Trigger:** `insights.brand_name` detected
- **Label:** `"We found your business name is \"{NAME}\". Is that correct?"`
- **Help:** `"Edit if this isn't quite right."`

### Address Confirmation
- **Trigger:** `insights.contact_public.address` detected
- **Label:** `"We found this address on your website. Is it correct?"`
- **Help:** `"Edit if your address has changed or this isn't your main office."`

### Phone Confirmation
- **Trigger:** `insights.contact_public.phone` detected
- **Label:** `"We found this phone number on your website. Is it your main business line?"`
- **Help:** `"Update if this is not the best number for us to use."`

## Guardrails

### What we NEVER infer or display:
- Revenue, profit, or financial data
- Staff size or headcount
- Rankings, conversions, or ad spend
- Private business data not on public pages
- Negative assessments of the website

### PageSpeed language (if enabled):
- Frame positively: "We grabbed a quick technical snapshot so we can prioritize improvements together."
- Show scores without judgment — no red/green unless extreme
- Never say "your site is slow" or "your SEO needs work"
