# GraphQL Quick Examples

Quick copy-paste examples for common GraphQL queries with cloudflare-mcp.

## Zone Analytics

### Last 7 Days Traffic
```javascript
{
  code: `async () => {
    const response = await cloudflare.request({
      method: "POST",
      path: "/client/v4/graphql",
      body: {
        query: \`
          query {
            viewer {
              zones(filter: { zoneTag: "YOUR_ZONE_ID" }) {
                httpRequests1dGroups(limit: 7, orderBy: [date_ASC]) {
                  dimensions { date }
                  sum {
                    requests
                    bytes
                    cachedBytes
                    cachedRequests
                  }
                }
              }
            }
          }
        \`
      }
    });
    return response.result;
  }`
}
```

### Hourly Traffic (Last 24 Hours)
```javascript
{
  code: `async () => {
    const response = await cloudflare.request({
      method: "POST",
      path: "/client/v4/graphql",
      body: {
        query: \`
          query {
            viewer {
              zones(filter: { zoneTag: "YOUR_ZONE_ID" }) {
                httpRequests1hGroups(limit: 24, orderBy: [datetime_DESC]) {
                  dimensions { datetime }
                  sum { requests, bytes }
                  uniq { uniques }
                }
              }
            }
          }
        \`
      }
    });
    return response.result;
  }`
}
```

### Top Countries by Traffic
```javascript
{
  code: `async () => {
    const response = await cloudflare.request({
      method: "POST",
      path: "/client/v4/graphql",
      body: {
        query: \`
          query {
            viewer {
              zones(filter: { zoneTag: "YOUR_ZONE_ID" }) {
                httpRequests1dGroups(
                  limit: 10
                  orderBy: [sum_requests_DESC]
                  filter: { date_gt: "2026-02-09" }
                ) {
                  dimensions { clientCountryName }
                  sum { requests }
                }
              }
            }
          }
        \`
      }
    });
    return response.result;
  }`
}
```

### Response Status Codes
```javascript
{
  code: `async () => {
    const response = await cloudflare.request({
      method: "POST",
      path: "/client/v4/graphql",
      body: {
        query: \`
          query {
            viewer {
              zones(filter: { zoneTag: "YOUR_ZONE_ID" }) {
                httpRequests1dGroups(
                  limit: 1
                  filter: { date: "2026-02-15" }
                ) {
                  sum {
                    responseStatusMap {
                      edgeResponseStatus
                      requests
                    }
                  }
                }
              }
            }
          }
        \`
      }
    });
    return response.result;
  }`
}
```

## Workers Analytics

### Worker Invocations
```javascript
{
  code: `async () => {
    const response = await cloudflare.request({
      method: "POST",
      path: "/client/v4/graphql",
      body: {
        query: \`
          query {
            viewer {
              accounts(filter: { accountTag: "\${accountId}" }) {
                workersInvocationsAdaptive(
                  limit: 100
                  filter: {
                    datetime_geq: "2026-02-15T00:00:00Z"
                    datetime_lt: "2026-02-16T00:00:00Z"
                  }
                ) {
                  dimensions {
                    scriptName
                    datetime
                  }
                  sum {
                    requests
                    errors
                    subrequests
                  }
                  quantiles {
                    cpuTimeP50
                    cpuTimeP99
                  }
                }
              }
            }
          }
        \`
      }
    });
    return response.result;
  }`,
  account_id: "YOUR_ACCOUNT_ID"
}
```

### Worker Errors by Script
```javascript
{
  code: `async () => {
    const response = await cloudflare.request({
      method: "POST",
      path: "/client/v4/graphql",
      body: {
        query: \`
          query {
            viewer {
              accounts(filter: { accountTag: "\${accountId}" }) {
                workersInvocationsAdaptive(
                  limit: 10
                  orderBy: [sum_errors_DESC]
                  filter: {
                    datetime_geq: "2026-02-15T00:00:00Z"
                  }
                ) {
                  dimensions { scriptName }
                  sum { errors, requests }
                }
              }
            }
          }
        \`
      }
    });
    return response.result;
  }`,
  account_id: "YOUR_ACCOUNT_ID"
}
```

## Firewall Analytics

### Recent Firewall Events
```javascript
{
  code: `async () => {
    const response = await cloudflare.request({
      method: "POST",
      path: "/client/v4/graphql",
      body: {
        query: \`
          query {
            viewer {
              zones(filter: { zoneTag: "YOUR_ZONE_ID" }) {
                firewallEventsAdaptive(
                  limit: 100
                  orderBy: [datetime_DESC]
                  filter: {
                    datetime_geq: "2026-02-15T00:00:00Z"
                  }
                ) {
                  action
                  clientCountryName
                  clientIP
                  clientRequestHTTPHost
                  clientRequestPath
                  datetime
                  source
                  userAgent
                }
              }
            }
          }
        \`
      }
    });
    return response.result;
  }`
}
```

### Firewall Actions Summary
```javascript
{
  code: `async () => {
    const response = await cloudflare.request({
      method: "POST",
      path: "/client/v4/graphql",
      body: {
        query: \`
          query {
            viewer {
              zones(filter: { zoneTag: "YOUR_ZONE_ID" }) {
                firewallEventsAdaptiveGroups(
                  limit: 10
                  orderBy: [count_DESC]
                  filter: {
                    datetime_geq: "2026-02-15T00:00:00Z"
                  }
                ) {
                  dimensions { action }
                  count
                }
              }
            }
          }
        \`
      }
    });
    return response.result;
  }`
}
```

### Top Blocked IPs
```javascript
{
  code: `async () => {
    const response = await cloudflare.request({
      method: "POST",
      path: "/client/v4/graphql",
      body: {
        query: \`
          query {
            viewer {
              zones(filter: { zoneTag: "YOUR_ZONE_ID" }) {
                firewallEventsAdaptiveGroups(
                  limit: 20
                  orderBy: [count_DESC]
                  filter: {
                    datetime_geq: "2026-02-15T00:00:00Z"
                    action: "block"
                  }
                ) {
                  dimensions {
                    clientIP
                    clientCountryName
                  }
                  count
                }
              }
            }
          }
        \`
      }
    });
    return response.result;
  }`
}
```

## Load Balancer Analytics

### Load Balancer Health
```javascript
{
  code: `async () => {
    const response = await cloudflare.request({
      method: "POST",
      path: "/client/v4/graphql",
      body: {
        query: \`
          query {
            viewer {
              zones(filter: { zoneTag: "YOUR_ZONE_ID" }) {
                loadBalancingRequestsAdaptive(
                  limit: 100
                  orderBy: [datetime_DESC]
                  filter: {
                    datetime_geq: "2026-02-15T00:00:00Z"
                  }
                ) {
                  dimensions {
                    lbName
                    poolName
                    datetime
                  }
                  sum {
                    requests
                  }
                  avg {
                    originResponseTime
                  }
                }
              }
            }
          }
        \`
      }
    });
    return response.result;
  }`
}
```

## Multi-Zone Queries

### Traffic Across All Zones
```javascript
{
  code: `async () => {
    const response = await cloudflare.request({
      method: "POST",
      path: "/client/v4/graphql",
      body: {
        query: \`
          query {
            viewer {
              zones {
                zoneTag
                httpRequests1dGroups(
                  limit: 1
                  filter: { date: "2026-02-15" }
                ) {
                  sum { requests, bytes }
                }
              }
            }
          }
        \`
      }
    });
    return response.result;
  }`
}
```

## SaaS / Multi-Tenant Queries

### Per-Hostname Analytics
```javascript
{
  code: `async () => {
    const response = await cloudflare.request({
      method: "POST",
      path: "/client/v4/graphql",
      body: {
        query: \`
          query {
            viewer {
              zones(filter: { zoneTag: "YOUR_ZONE_ID" }) {
                httpRequests1hGroups(
                  limit: 100
                  orderBy: [datetime_DESC]
                  filter: {
                    clientRequestHTTPHost: "customer1.example.com"
                  }
                ) {
                  dimensions {
                    datetime
                    clientRequestHTTPHost
                  }
                  sum { requests, bytes }
                  uniq { uniques }
                }
              }
            }
          }
        \`
      }
    });
    return response.result;
  }`
}
```

### Top Customer Hostnames by Traffic
```javascript
{
  code: `async () => {
    const response = await cloudflare.request({
      method: "POST",
      path: "/client/v4/graphql",
      body: {
        query: \`
          query {
            viewer {
              zones(filter: { zoneTag: "YOUR_ZONE_ID" }) {
                httpRequests1dGroups(
                  limit: 10
                  orderBy: [sum_requests_DESC]
                  filter: { date: "2026-02-15" }
                ) {
                  dimensions { clientRequestHTTPHost }
                  sum { requests, bytes }
                }
              }
            }
          }
        \`
      }
    });
    return response.result;
  }`
}
```

## Using Variables

### Parameterized Query
```javascript
{
  code: `async () => {
    const response = await cloudflare.request({
      method: "POST",
      path: "/client/v4/graphql",
      body: {
        query: \`
          query GetZoneTraffic($zoneTag: string!, $since: Time!, $until: Time!) {
            viewer {
              zones(filter: { zoneTag: $zoneTag }) {
                httpRequests1hGroups(
                  limit: 100
                  orderBy: [datetime_ASC]
                  filter: {
                    datetime_geq: $since
                    datetime_lt: $until
                  }
                ) {
                  dimensions { datetime }
                  sum { requests, bytes }
                }
              }
            }
          }
        \`,
        variables: {
          zoneTag: "YOUR_ZONE_ID",
          since: "2026-02-15T00:00:00Z",
          until: "2026-02-16T00:00:00Z"
        }
      }
    });
    return response.result;
  }`
}
```

## Tips

1. **Always use `limit`** to avoid overwhelming responses
2. **Order results** with `orderBy` for consistent pagination
3. **Filter by time** to reduce query cost and response size
4. **Use variables** for dynamic values instead of string concatenation
5. **Request only needed fields** to minimize response size
6. **Check rate limits** - default is 300 queries per 5 minutes

## Common Filters

### Time Filters
- `datetime_geq: "2026-02-15T00:00:00Z"` - Greater than or equal
- `datetime_lt: "2026-02-16T00:00:00Z"` - Less than
- `date: "2026-02-15"` - Exact date match
- `date_gt: "2026-02-10"` - Greater than date

### String Filters
- `clientRequestHTTPHost: "example.com"` - Exact match
- `clientCountryName: "United States"` - Exact match

### Order By
- `[datetime_DESC]` - Most recent first
- `[datetime_ASC]` - Oldest first
- `[sum_requests_DESC]` - Highest traffic first
- `[count_DESC]` - Highest count first
