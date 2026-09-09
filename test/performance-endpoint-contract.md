# Contract test notes

Expected success:
- HTTP 200
- `ok: true`
- `schema_version: wdc018.performance-result.v1`
- integer `performance_score` from 0 to 100
- `metrics`, `issues_text`, `opportunities_text`, `performance_hash`

Expected invalid input:
- HTTP 400
- `ok: false`
- error message without leaking credentials

The endpoint reuses `A11Y_API_TOKEN` and the existing public-URL/SSRF guard.
