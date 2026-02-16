# GraphQL Support in cloudflare-mcp

This document provides comprehensive information about using Cloudflare's GraphQL Analytics API through the cloudflare-mcp server.

## Overview

Cloudflare provides a GraphQL Analytics API that allows you to query aggregated analytics data across various products. The cloudflare-mcp server automatically detects and normalizes GraphQL responses, so you can use the same `execute` tool for both REST and GraphQL endpoints.

## Endpoint

- **URL**: `https://api.cloudflare.com/client/v4/graphql`
- **Method**: `POST`
- **Authentication**: Uses the same Bearer token as REST API calls

## Basic Usage

### Simple Query

```javascript
execute({
  code: `async () => {
    const response = await cloudflare.request({
      method: "POST",
      path: "/client/v4/graphql",
      body: {
        query: "{ viewer { __typename } }",
        variables: {}
      }
    });
    return response.result;
  }`
});
```

### Zone Traffic Analytics

Get the last 7 days of HTTP request data for a zone:

```javascript
execute({
  code: `async () => {
    const response = await cloudflare.request({
      method: "POST",
      path: "/client/v4/graphql",
      body: {
        query: \`
          query ZoneTraffic($zoneTag: string) {
            viewer {
              zones(filter: { zoneTag: $zoneTag }) {
                httpRequests1dGroups(
                  limit: 7
                  orderBy: [date_ASC]
                ) {
                  dimensions {
                    date
                  }
                  sum {
                    requests
                    bytes
                    cachedBytes
                    cachedRequests
                  }
                  uniq {
                    uniques
                  }
                }
              }
            }
          }
        \`,
        variables: {
          zoneTag: "your-zone-id"
        }
      }
    });
    return response.result;
  }`
});
```

### Workers Analytics

Query Workers invocation metrics:

```javascript
execute({
  code: `async () => {
    const response = await cloudflare.request({
      method: "POST",
      path: "/client/v4/graphql",
      body: {
        query: \`
          query WorkersMetrics($accountTag: string!) {
            viewer {
              accounts(filter: { accountTag: $accountTag }) {
                workersInvocationsAdaptive(
                  limit: 100
                  filter: {
                    datetime_geq: "2026-02-01T00:00:00Z"
                    datetime_lt: "2026-02-16T00:00:00Z"
                  }
                  orderBy: [datetime_DESC]
                ) {
                  sum {
                    requests
                    errors
                    subrequests
                  }
                  quantiles {
                    cpuTimeP50
                    cpuTimeP99
                  }
                  dimensions {
                    scriptName
                    datetime
                  }
                }
              }
            }
          }
        \`,
        variables: {
          accountTag: accountId
        }
      }
    });
    return response.result;
  }`,
  account_id: "your-account-id"
});
```

### Firewall Events

Query recent firewall events:

```javascript
execute({
  code: `async () => {
    const response = await cloudflare.request({
      method: "POST",
      path: "/client/v4/graphql",
      body: {
        query: \`
          query FirewallEvents($zoneTag: string!) {
            viewer {
              zones(filter: { zoneTag: $zoneTag }) {
                firewallEventsAdaptive(
                  limit: 100
                  filter: {
                    datetime_geq: "2026-02-15T00:00:00Z"
                    datetime_lt: "2026-02-16T00:00:00Z"
                  }
                  orderBy: [datetime_DESC]
                ) {
                  action
                  clientAsn
                  clientCountryName
                  clientIP
                  clientRequestHTTPHost
                  clientRequestHTTPMethodName
                  clientRequestPath
                  datetime
                  source
                  userAgent
                  ruleId
                }
              }
            }
          }
        \`,
        variables: {
          zoneTag: "your-zone-id"
        }
      }
    });
    return response.result;
  }`
});
```

### HTTP Request Logs by Hostname

Useful for SaaS applications serving multiple customers:

```javascript
execute({
  code: `async () => {
    const response = await cloudflare.request({
      method: "POST",
      path: "/client/v4/graphql",
      body: {
        query: \`
          query RequestsByHost($zoneTag: string!, $hostname: string!) {
            viewer {
              zones(filter: { zoneTag: $zoneTag }) {
                httpRequests1hGroups(
                  limit: 24
                  filter: {
                    clientRequestHTTPHost: $hostname
                  }
                  orderBy: [datetime_DESC]
                ) {
                  dimensions {
                    datetime
                    clientRequestHTTPHost
                  }
                  sum {
                    requests
                    bytes
                  }
                  uniq {
                    uniques
                  }
                }
              }
            }
          }
        \`,
        variables: {
          zoneTag: "your-zone-id",
          hostname: "customer.example.com"
        }
      }
    });
    return response.result;
  }`
});
```

## Response Format

The server automatically normalizes GraphQL responses to match the REST API format:

### GraphQL Response (from Cloudflare)

```json
{
  "data": {
    "viewer": {
      "zones": [
        {
          "httpRequests1dGroups": [...]
        }
      ]
    }
  },
  "errors": null
}
```

### Normalized Response (returned to you)

```json
{
  "success": true,
  "status": 200,
  "result": {
    "viewer": {
      "zones": [
        {
          "httpRequests1dGroups": [...]
        }
      ]
    }
  },
  "errors": [],
  "messages": []
}
```

## Error Handling

### Query Errors

If your GraphQL query has syntax errors or requests invalid fields:

```javascript
// This will throw an error
execute({
  code: `async () => {
    const response = await cloudflare.request({
      method: "POST",
      path: "/client/v4/graphql",
      body: {
        query: "{ viewer { invalidField } }"
      }
    });
    return response.result;
  }`
});
```

**Error thrown:**
```
GraphQL error: Cannot query field 'invalidField' on type 'Viewer' (at viewer.invalidField) [line 1, col 12]
```

### Partial Responses

If some fields succeed and others fail, you get both:

```javascript
const response = await cloudflare.request({
  method: "POST",
  path: "/client/v4/graphql",
  body: {
    query: `{
      viewer {
        zones { zoneTag }
        invalidField
      }
    }`
  }
});

// Response:
{
  "success": false,  // false because there are errors
  "status": 200,
  "result": {
    "viewer": {
      "zones": [{ "zoneTag": "..." }]  // Successful field data
    }
  },
  "errors": [
    {
      "code": 0,
      "message": "Cannot query field 'invalidField' on type 'Viewer' (at viewer.invalidField)"
    }
  ],
  "messages": [
    {
      "code": 0,
      "message": "Partial response: 1 error(s)"
    }
  ]
}
```

## Schema Introspection

Discover available fields using introspection:

```javascript
execute({
  code: `async () => {
    const response = await cloudflare.request({
      method: "POST",
      path: "/client/v4/graphql",
      body: {
        query: \`
          {
            __type(name: "Viewer") {
              fields {
                name
                description
                type {
                  name
                  kind
                }
              }
            }
          }
        \`
      }
    });
    return response.result;
  }`
});
```

## Rate Limits

- **Default quota**: 300 queries per 5 minutes
- **Burst capacity**: Can do 300 queries immediately, then wait 5 minutes
- **Sustained rate**: ~1 query per second

Rate limit information may be included in the response extensions (preserved in `result_info` field).

## Best Practices

1. **Use variables for dynamic values**: Don't concatenate strings into queries
   ```javascript
   // ❌ Bad
   query: `{ viewer { zones(filter: { zoneTag: "${zoneId}" }) { ... } } }`

   // ✅ Good
   query: `query($zoneTag: string!) { viewer { zones(filter: { zoneTag: $zoneTag }) { ... } } }`,
   variables: { zoneTag: zoneId }
   ```

2. **Limit result sets**: Always use `limit` to avoid huge responses
   ```javascript
   httpRequests1dGroups(limit: 100)  // ✅ Good
   httpRequests1dGroups()            // ❌ May return too much data
   ```

3. **Order results**: Use `orderBy` for consistent results
   ```javascript
   httpRequests1dGroups(limit: 10, orderBy: [datetime_DESC])
   ```

4. **Filter by time range**: Reduce data volume and query time
   ```javascript
   filter: {
     datetime_geq: "2026-02-01T00:00:00Z",
     datetime_lt: "2026-02-16T00:00:00Z"
   }
   ```

5. **Request only needed fields**: Reduce response size
   ```javascript
   // ❌ Bad - requests all fields
   httpRequests1dGroups { dimensions { ... } sum { ... } }

   // ✅ Good - only what you need
   httpRequests1dGroups {
     dimensions { date }
     sum { requests }
   }
   ```

## Available Datasets

Some commonly used datasets in the GraphQL API:

| Dataset | Description | Time Granularity |
|---------|-------------|------------------|
| `httpRequests1mGroups` | HTTP request metrics | 1 minute |
| `httpRequests1hGroups` | HTTP request metrics | 1 hour |
| `httpRequests1dGroups` | HTTP request metrics | 1 day |
| `firewallEventsAdaptive` | Firewall events | Variable |
| `firewallEventsAdaptiveGroups` | Aggregated firewall data | Variable |
| `workersInvocationsAdaptive` | Workers invocation metrics | Variable |
| `loadBalancingRequestsAdaptive` | Load balancer metrics | Variable |
| `healthCheckEventsAdaptive` | Health check results | Variable |

## Additional Resources

- [Cloudflare GraphQL API Documentation](https://developers.cloudflare.com/analytics/graphql-api/)
- [GraphQL API Getting Started](https://developers.cloudflare.com/analytics/graphql-api/getting-started/)
- [GraphQL API Tutorials](https://developers.cloudflare.com/analytics/graphql-api/tutorials/)
- [GraphQL API Schema](https://developers.cloudflare.com/analytics/graphql-api/getting-started/explore-graphql-schema/)

## Implementation Details

### How It Works

1. **Path Detection**: The server detects GraphQL endpoints by checking if the path is `/client/v4/graphql` or ends with `/graphql`

2. **Response Normalization**: GraphQL responses are converted to REST format:
   - `data` field becomes `result`
   - `errors` array is transformed to include error codes and enhanced messages
   - `success` field is set based on presence of errors
   - Partial responses (both data and errors) are preserved

3. **Error Enhancement**: Error messages are enhanced with:
   - Field path (e.g., "at viewer.zones.invalidField")
   - Line and column numbers from query
   - Error codes from extensions

4. **Backward Compatibility**: REST API calls continue to work unchanged. The GraphQL handling is completely transparent and only activates for GraphQL endpoints.

### Source Code

The GraphQL support implementation is in `src/executor.ts:79-107`. The code handles:
- Path detection with query parameter and trailing slash handling
- Robust null/undefined checking for data and errors
- Partial response support
- Error message enhancement with path information
- Response format normalization

Tests are in `src/executor.test.ts` and verify:
- Path detection logic
- Partial response handling
- Error message formatting
- REST API backward compatibility
