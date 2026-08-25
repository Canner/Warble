# synthetic_shop — raw business notes

Readable raw business docs that back a knowledge enrichment (`raw_docs_readable`).
These are pre-MDL prose, not a semantic layer — `enrich_knowledge` reads them to
propose `knowledge/` entries.

- **amount** is stored in USD (minor unit already scaled to dollars).
- **status** is one of `placed`, `shipped`, `completed`, `cancelled`.
- A **completed order** is one whose `status = 'completed'`; revenue counts completed orders only.
- **region** groups customers into `NA`, `EMEA`, `APAC`.
