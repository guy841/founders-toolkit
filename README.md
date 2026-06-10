# Helm

Free, no-login web tools for UK limited company directors — the deadlines, taxes
and obligations nobody hands you a manual for.

**Live:** https://guy841.github.io/founders-toolkit/

Every tool is a **single self-contained HTML file**: no build step, no server, no
database. Open it in a browser, host it on any static host, or embed it in another
site via an `<iframe>`.

## Structure

```
founders-toolkit/
├── index.html                     # The hub / landing page (tool directory + lead-gen CTA)
└── tools/
    ├── deadline-copilot/
    │   └── index.html             # Director's Deadline Copilot (live)
    ├── corporation-tax/
    │   └── index.html             # Corporation Tax Estimator (live)
    ├── company-records/
    │   └── index.html             # Company Records — private on-device store (live)
    ├── setup-checklist/
    │   └── index.html             # New Company Setup Checklist (live)
    ├── insurance-check/
    │   └── index.html             # Insurance Needs Check (live)
    ├── salary-dividends/
    │   └── index.html             # Salary vs Dividends Optimiser + director's loan (live)
    └── vat-checker/
        └── index.html             # VAT Registration Checker (live)
```

## Tools

| Tool | Status | What it does |
|------|--------|--------------|
| **Deadline Copilot** | ✅ Live | Calculates every company filing & payment deadline (accounts, Corporation Tax, confirmation statement, VAT, PAYE, Self Assessment), counted down from today, with `.ics` calendar export. |
| **Corporation Tax Estimator** | ✅ Live | Profit → tax owed, including 19%/25% bands and marginal relief. |
| **Company Records** | ✅ Live | A private, on-device store for key company details (CRN, UTR, VAT, PAYE, insurance, bank, advisers) with backup export/import and print. |
| **Salary vs Dividends Optimiser** | ✅ Live | Most tax-efficient director's salary/dividend split, plus a director's-loan comparison (BIK & s455). |
| **New Company Setup Checklist** | ✅ Live | Personalised list of registrations, insurances and legal duties, with progress tracking. |
| **Insurance Needs Check** | ✅ Live | Which cover is legally required vs advised, based on what the business does. |
| **VAT Registration Checker** | ✅ Live | Rolling 12-month turnover vs the £90k threshold, the forward-look test, and voluntary registration. |

## Branding & configuration

Each HTML file has a `CONFIG` block near the bottom of its `<script>`:

- `LOGO_URL` — set to your own logo image URL (falls back to a wordmark if blank/broken).
- `BOOKING_URL` (hub only) — where the "Book a free call" button points.

Colours and fonts live in the CSS `:root` variables at the top of each file — change
`--moss` etc. in one place to recolour everything.

## Hosting

Because every file is static, you can publish the whole folder with **GitHub Pages**,
Netlify, Cloudflare Pages, S3, or any static host. With GitHub Pages enabled, the hub
is served at the repo's Pages URL and each tool at `/tools/<name>/`.

## Disclaimer

These tools provide general estimates based on standard UK rules and are not a
substitute for professional advice. Always confirm exact obligations with HMRC,
Companies House or a qualified adviser.
