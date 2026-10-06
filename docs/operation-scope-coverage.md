# Operation scope policy coverage

Reproduced from the plan's October 6, 2026 raw OpenAPI snapshot with:

```sh
npx tsx scripts/report-operation-scopes.ts /path/to/raw-openapi.json
```

- Raw schema SHA-256: `9c355045806033f1238e9bc11af08930a26e7fa856c63d710df0135bf2ee6d03`
- Imported catalog JSON serialization SHA-256: `1c77a199e085353b5d98fc35972cc5c452905400d564f836b4f7ee6ed1a7cfd3`
- Resolver: `exact-label-v1`

| Operation classification | Count |
| --- | ---: |
| Total (GET, POST, PUT, PATCH, DELETE) | 3,651 |
| Absent permission metadata | 698 |
| Complete exact label joins | 2,675 |
| Account/zone context candidates | 146 |
| Unmatched-label operations | 132 |
| Enabled challenge policies | **0** |

The five ambiguous labels remain distinct in the report even when leading resource context produces a candidate. The report also lists every unmatched label; recognized alternatives never hide unknown ones. Candidate coverage does not establish API-token-to-OAuth equivalence.

The production review registry is empty. Reviewed fixtures verify both tool modes, both MCP revisions, protocol and OpenAI tool response forms, actual Loader admission, replay safety, direct credentials, forged handles, mutable JavaScript intrinsics, and empty granted/refreshed token scopes. No live scope upgrade, target-host UI behavior, saved connection retry/storage change, or disposable resource creation has been verified. Those acceptance steps and authoritative mapping review are required before adding a production rule.
