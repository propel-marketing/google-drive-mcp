# Diagnose: Failure Chains

Read all inventory outputs and build failure chains:
`trigger -> action -> failure -> symptom -> impact`.

Write findings to `{{OUTPUT_PATH}}/diagnose/failure-chains.jsonl`.
Summary marker:
`{"_summary":true,"status":"complete","count":N,"category":"failure-chains"}`

Prioritize chains with user-visible breaks and repeated occurrence.
