"""
Test which OAuth scopes work with Cloudflare's OAuth flow AFTER login.

The script opens a browser, waits for you to log in to Cloudflare,
then uses your session to rapidly test increasing scope counts and
individual scopes to find what breaks.

Usage:
    uv run --with playwright scripts/test-oauth-scopes.py

First time setup:
    uv run --with playwright python -m playwright install chromium
"""

from __future__ import annotations

import json
import urllib.parse
import hashlib
import base64
import secrets
import asyncio
from dataclasses import dataclass, field

# All registered scopes from scopes.ts
ALL_SCOPES = [
    "offline_access",
    "user:read",
    "account:read",
    "access:read",
    "access:write",
    "workers:read",
    "workers:write",
    "workers_scripts:write",
    "workers_kv:write",
    "workers_routes:write",
    "workers_tail:read",
    "workers_builds:read",
    "workers_builds:write",
    "workers_observability:read",
    "workers_observability:write",
    "workers_observability_telemetry:write",
    "pages:read",
    "pages:write",
    "d1:write",
    "ai:read",
    "ai:write",
    "aig:read",
    "aig:write",
    "agw:read",
    "agw:run",
    "agw:write",
    "aiaudit:read",
    "aiaudit:write",
    "ai-search:read",
    "ai-search:write",
    "ai-search:run",
    "rag:read",
    "rag:write",
    "dns_records:read",
    "dns_records:edit",
    "dns_settings:read",
    "dns_analytics:read",
    "zone:read",
    "logpush:read",
    "logpush:write",
    "auditlogs:read",
    "ssl_certs:write",
    "lb:read",
    "lb:edit",
    "notification:read",
    "notification:write",
    "queues:write",
    "pipelines:read",
    "pipelines:setup",
    "pipelines:write",
    "r2_catalog:write",
    "vectorize:write",
    "query_cache:write",
    "secrets_store:read",
    "secrets_store:write",
    "browser:read",
    "browser:write",
    "containers:write",
    "constellation:write",
    "cloudchamber:write",
    "teams:read",
    "teams:write",
    "teams:pii",
    "teams:secure_location",
    "sso-connector:read",
    "sso-connector:write",
    "connectivity:admin",
    "connectivity:bind",
    "connectivity:read",
    "cfone:read",
    "cfone:write",
    "dex:read",
    "dex:write",
    "url_scanner:read",
    "url_scanner:write",
    "radar:read",
    "billing:read",
    "billing:write",
    "notebook-examples:read",
    "notebook-managed:read",
    "firstpartytags:write",
]

CLIENT_ID = "2d0ad4d1-1d40-4767-9538-dc1a91f94773"
REDIRECT_URI = "https://mcp.cloudflare.com/oauth/callback"
AUTH_BASE = "https://dash.cloudflare.com/oauth2/auth"


def generate_pkce():
    code_verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(code_verifier.encode()).digest()
    code_challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    return code_verifier, code_challenge


def build_auth_url(scopes):
    _, code_challenge = generate_pkce()
    state_obj = {"clientId": CLIENT_ID, "redirectUri": REDIRECT_URI, "scope": scopes}
    state_b64 = base64.b64encode(json.dumps(state_obj).encode()).decode()
    params = {
        "response_type": "code",
        "client_id": CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "state": state_b64,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
        "scope": " ".join(scopes),
    }
    return f"{AUTH_BASE}?{urllib.parse.urlencode(params)}"


@dataclass
class TestResult:
    num_scopes: int
    url_length: int
    success: bool
    scopes: list = field(default_factory=list)
    error: str = ""
    final_url: str = ""
    page_title: str = ""


async def click_allow_if_consent(page):
    """If we're on the Cloudflare consent form, click Allow and wait for redirect."""
    current = page.url
    if "consent-form" not in current and "consent" not in current:
        return

    # Try multiple selectors for the Allow/Accept button
    for selector in [
        'button:has-text("Allow")',
        'button:has-text("Accept")',
        'button:has-text("Authorize")',
        'button[type="submit"]',
        'input[type="submit"]',
    ]:
        try:
            btn = page.locator(selector).first
            if await btn.is_visible(timeout=2000):
                await btn.click()
                # Wait for navigation after clicking
                await page.wait_for_timeout(3000)
                return
        except Exception:
            continue


async def test_single(page, scopes, label=""):
    """Navigate to OAuth URL, click Allow on consent, check the final result.

    Returns a TestResult. Since the user is already logged in, Cloudflare
    will show a consent form. We click Allow and check whether the redirect
    to the callback succeeds or fails.
    """
    url = build_auth_url(scopes)
    result = TestResult(
        num_scopes=len(scopes),
        url_length=len(url),
        success=False,
        scopes=list(scopes),
    )

    try:
        response = await page.goto(url, wait_until="domcontentloaded", timeout=30000)
        # Wait for page to settle (redirects to consent form)
        await page.wait_for_timeout(3000)

        # Click Allow if we landed on the consent form
        await click_allow_if_consent(page)

        # Wait for final redirect
        await page.wait_for_timeout(2000)

        final_url = page.url
        title = await page.title()
        result.final_url = final_url
        result.page_title = title

        # Success = we got redirected to the MCP callback with a code param
        hit_callback = "mcp.cloudflare.com/oauth/callback" in final_url
        has_code = "code=" in final_url
        has_error_param = "error=" in final_url

        if hit_callback and has_code and not has_error_param:
            result.success = True
        elif has_error_param:
            result.success = False
            parsed = urllib.parse.urlparse(final_url)
            qs = urllib.parse.parse_qs(parsed.query)
            result.error = qs.get("error_description", qs.get("error", ["unknown"]))[0]
        elif "consent" in final_url:
            # Still on consent but no error - scopes were accepted by OAuth server
            result.success = True
            result.error = "consent-shown"
        else:
            body_text = await page.inner_text("body")
            body_lower = body_text.lower()
            has_error_text = any(
                x in body_lower
                for x in [
                    "invalid_scope", "invalid scope", "unknown scope",
                    "the requested scope is invalid",
                    "request-uri too large", "414", "413",
                ]
            )
            if has_error_text:
                result.success = False
                result.error = body_text[:200].strip()
            elif "dash.cloudflare.com" in final_url:
                result.success = True
            else:
                status = response.status if response else 0
                result.success = status < 400
                if not result.success:
                    result.error = f"status={status} url={final_url[:100]}"

    except Exception as e:
        result.error = str(e)[:200]

    return result


async def main():
    from playwright.async_api import async_playwright

    print("=" * 80)
    print("CLOUDFLARE OAUTH SCOPE LIMIT TESTER")
    print("=" * 80)
    print()
    print(f"Total scopes to test: {len(ALL_SCOPES)}")
    print()

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False)
        context = await browser.new_context()
        page = await context.new_page()

        # Step 1: Open with minimal scopes so user can log in
        login_scopes = ["offline_access", "user:read", "account:read"]
        login_url = build_auth_url(login_scopes)

        print("Opening Cloudflare OAuth login page...")
        print("Please log in to Cloudflare in the browser window.")
        print()
        await page.goto(login_url, wait_until="domcontentloaded")

        # Wait for the user to complete login
        # We detect login completion by watching for a redirect away from dash.cloudflare.com/login
        print("Waiting for you to log in... ", flush=True)
        print("(The script will continue automatically after login)")
        print()

        # Poll until we leave the login page or get redirected to callback
        for _ in range(600):  # 5 minute timeout
            await page.wait_for_timeout(1000)
            current_url = page.url
            # Redirected to MCP callback = login succeeded
            if "mcp.cloudflare.com" in current_url:
                print("Login successful! Detected redirect to MCP callback.")
                break
            # Still on a non-login cloudflare page = consent/processing
            if "dash.cloudflare.com" in current_url and "/login" not in current_url and "/oauth2/auth" not in current_url:
                print(f"Login detected! Now on: {current_url[:80]}")
                await page.wait_for_timeout(3000)
                break
        else:
            print("Timeout waiting for login. Continuing anyway...")

        print()
        print("=" * 80)
        print("PHASE 1: SCOPE COUNT LIMIT TEST")
        print("=" * 80)
        print()
        print("Testing increasing numbers of scopes to find the breakpoint...")
        print("(Using your authenticated session - no re-login needed)")
        print()

        # Test increasing scope counts
        test_counts = [3, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, len(ALL_SCOPES)]
        test_counts = sorted(set(c for c in test_counts if c <= len(ALL_SCOPES)))

        results = []
        for count in test_counts:
            scopes = ALL_SCOPES[:count]
            url = build_auth_url(scopes)
            print(f"  {count:>3} scopes (URL: {len(url)} chars)... ", end="", flush=True)

            result = await test_single(page, scopes)
            results.append(result)

            if result.success:
                print(f"OK -> {result.final_url[:80]}")
            else:
                print(f"FAILED: {result.error[:80]}")

            await page.wait_for_timeout(1500)

        # Find breakpoint
        last_ok = 0
        first_fail = None
        for r in results:
            if r.success:
                last_ok = r.num_scopes
            elif first_fail is None:
                first_fail = r.num_scopes

        print()
        if first_fail:
            print(f">> BREAKPOINT: Works with {last_ok} scopes, fails at {first_fail}")

            # Binary search for exact breakpoint
            print()
            print(f"Binary searching between {last_ok} and {first_fail}...")
            lo, hi = last_ok, first_fail
            while hi - lo > 1:
                mid = (lo + hi) // 2
                scopes = ALL_SCOPES[:mid]
                print(f"  Testing {mid} scopes... ", end="", flush=True)
                r = await test_single(page, scopes)
                results.append(r)
                if r.success:
                    lo = mid
                    print("OK")
                else:
                    hi = mid
                    print(f"FAILED: {r.error[:60]}")
                await page.wait_for_timeout(1500)

            print(f"\n>> EXACT LIMIT: {lo} scopes work, {hi} scopes fail")
            print(f"   Last working URL length: {len(build_auth_url(ALL_SCOPES[:lo]))}")
            print(f"   First failing URL length: {len(build_auth_url(ALL_SCOPES[:hi]))}")
        else:
            print(f">> All scope counts worked (up to {last_ok})!")

        # Phase 2: Test each scope individually
        print()
        print("=" * 80)
        print("PHASE 2: INDIVIDUAL SCOPE TEST")
        print("=" * 80)
        print()
        print("Testing each scope individually (base + 1) to find broken scopes...")
        print()

        base_scopes = ["offline_access", "user:read", "account:read"]
        broken = []
        working = []

        for scope in ALL_SCOPES:
            if scope in base_scopes:
                continue

            test_scopes = base_scopes + [scope]
            print(f"  {scope:.<45s} ", end="", flush=True)

            r = await test_single(page, test_scopes)
            if r.success:
                working.append(scope)
                print("OK")
            else:
                broken.append((scope, r.error))
                print(f"BROKEN: {r.error[:60]}")

            await page.wait_for_timeout(1000)

        await browser.close()

    # Final summary
    print()
    print("=" * 80)
    print("FINAL SUMMARY")
    print("=" * 80)
    print()

    print("SCOPE COUNT RESULTS:")
    print(f"{'Count':>6} | {'URL Len':>8} | {'Result':>8} | Detail")
    print("-" * 70)
    for r in sorted(results, key=lambda x: x.num_scopes):
        status = "OK" if r.success else "FAILED"
        detail = r.error[:40] if r.error else ""
        print(f"{r.num_scopes:>6} | {r.url_length:>8} | {status:>8} | {detail}")

    if broken:
        print()
        print(f"BROKEN SCOPES ({len(broken)}):")
        for scope, err in broken:
            print(f"  - {scope}: {err[:60]}")
    else:
        print()
        print("All individual scopes work fine.")

    print()
    print(f"Working scopes: {len(working) + len(base_scopes)}/{len(ALL_SCOPES)}")
    if broken:
        print(f"Broken scopes:  {len(broken)}/{len(ALL_SCOPES)}")


if __name__ == "__main__":
    asyncio.run(main())
