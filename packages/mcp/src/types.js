// What list_document_types says about each type. These lines describe a layout to an agent choosing one; they are
// never printed on a document. The public model each layout follows is in packages/core/templates/<type>/LINEAGE.md.
export const DOCUMENT_TYPES = {
  'msn': { title: 'Medicare Summary Notice (Part B)', orientation: 'portrait',
    description: 'Notice Original Medicare sends about Part B claims: a summary dashboard, how to read the notice, claim detail by provider with service lines and notes, and how to handle denied claims and appeals.' },
  'itemized-bill': { title: 'Hospital itemized statement', orientation: 'portrait',
    description: 'Itemized statement from a fictional hospital: statement details and amount due, charge lines grouped by revenue code with HCPCS codes, insurance summary, payment options, aging summary and a financial-assistance notice.' },
  'ppo-eob': { title: 'Medicare Advantage PPO explanation of benefits', orientation: 'portrait cover and back pages, landscape claim detail',
    description: 'Monthly Part C explanation of benefits from a fictional Medicare Advantage PPO: per-line billed, plan-approved, plan-paid and member amounts, year-to-date totals, deductible and out-of-pocket progress, and notices.' },
  'hmo-eob': { title: 'Medicare Advantage HMO explanation of benefits', orientation: 'portrait',
    description: 'Monthly Part C explanation of benefits from a fictional Medicare Advantage HMO: per-line billed, plan-approved, plan-paid and member amounts, year-to-date totals, out-of-pocket progress, and notices.' },
};
