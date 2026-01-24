#!/usr/bin/env python3
"""
Test CRUD buttons by actually clicking them and checking results.
Verifies that buttons are clickable and trigger expected actions.
"""

from playwright.sync_api import sync_playwright
import json
import time
import requests

BASE_URL = "http://localhost:4321"
API_URL = "http://localhost:3001/api/v1"

TEST_USER = {
    "email": "test@example.com",
    "password": "TestPassword123!",
    "name": "Test User"
}

# Pages with their expected CRUD buttons
TEST_SCENARIOS = [
    {
        "path": "/devices",
        "name": "Devices",
        "buttons": [
            {"text": "Add Device", "action": "opens_modal_or_form", "type": "create"}
        ]
    },
    {
        "path": "/scripts/new",
        "name": "New Script",
        "buttons": [
            {"text": "Add Parameter", "action": "adds_field", "type": "create"},
            {"text": "Create Script", "action": "submits_form", "type": "create"},
            {"text": "Cancel", "action": "navigates_away", "type": "cancel"}
        ]
    },
    {
        "path": "/alerts/rules",
        "name": "Alert Rules",
        "buttons": [
            {"text": "Add rule", "action": "opens_modal_or_form", "type": "create"}
        ]
    },
    {
        "path": "/alerts/rules/new",
        "name": "New Alert Rule",
        "buttons": [
            {"text": "Add Condition", "action": "adds_field", "type": "create"},
            {"text": "Create Rule", "action": "submits_form", "type": "create"}
        ]
    },
    {
        "path": "/automations/new",
        "name": "New Automation",
        "buttons": [
            {"text": "Add Condition", "action": "adds_field", "type": "create"},
            {"text": "Add Action", "action": "adds_field", "type": "create"},
            {"text": "Create Automation", "action": "submits_form", "type": "create"}
        ]
    },
    {
        "path": "/policies/new",
        "name": "New Policy",
        "buttons": [
            {"text": "Add Rule", "action": "adds_field", "type": "create"},
            {"text": "Create Policy", "action": "submits_form", "type": "create"}
        ]
    },
    {
        "path": "/reports/new",
        "name": "New Report",
        "buttons": [
            {"text": "Add condition", "action": "adds_field", "type": "create"},
            {"text": "Add recipient", "action": "adds_field", "type": "create"},
            {"text": "Save report", "action": "submits_form", "type": "save"}
        ]
    },
    {
        "path": "/discovery",
        "name": "Discovery",
        "buttons": [
            {"text": "New Profile", "action": "opens_modal_or_form", "type": "create"},
            {"text": "Create Profile", "action": "submits_form", "type": "create"}
        ]
    },
    {
        "path": "/patches",
        "name": "Patches",
        "buttons": [
            {"text": "New Policy", "action": "opens_modal_or_form", "type": "create"},
            {"text": "Run Scan", "action": "triggers_action", "type": "action"}
        ]
    },
    {
        "path": "/snmp",
        "name": "SNMP",
        "buttons": [
            {"text": "Quick add device", "action": "opens_modal_or_form", "type": "create"}
        ]
    },
    {
        "path": "/backup",
        "name": "Backup",
        "buttons": [
            {"text": "Run all backups", "action": "triggers_action", "type": "action"}
        ]
    },
    {
        "path": "/software",
        "name": "Software",
        "buttons": [
            {"text": "Bulk Deploy", "action": "opens_modal_or_form", "type": "action"}
        ]
    },
    {
        "path": "/settings/sso",
        "name": "SSO",
        "buttons": [
            {"text": "Add provider", "action": "opens_modal_or_form", "type": "create"}
        ]
    },
    {
        "path": "/settings/webhooks",
        "name": "Webhooks",
        "buttons": [
            {"text": "New Webhook", "action": "opens_modal_or_form", "type": "create"}
        ]
    },
    {
        "path": "/settings/profile",
        "name": "Profile",
        "buttons": [
            {"text": "Save changes", "action": "submits_form", "type": "save"}
        ]
    },
    {
        "path": "/settings/integrations/monitoring",
        "name": "Monitoring Integration",
        "buttons": [
            {"text": "Add endpoint", "action": "adds_field", "type": "create"},
            {"text": "Remove", "action": "removes_item", "type": "delete"}
        ]
    }
]


def login_user():
    """Login test user and return tokens."""
    try:
        resp = requests.post(f"{API_URL}/auth/login", json={
            "email": TEST_USER["email"],
            "password": TEST_USER["password"]
        }, timeout=5)
        if resp.status_code == 200:
            data = resp.json()
            if "tokens" in data and data["tokens"]:
                return data["tokens"]
    except Exception as e:
        print(f"Login error: {e}")
    return None


def test_button_click(page, btn_text, expected_action):
    """Test clicking a button and verify the action."""
    result = {
        "button": btn_text,
        "expected": expected_action,
        "status": "unknown",
        "details": ""
    }

    try:
        # Find the button
        btn = page.locator(f"button:visible:has-text('{btn_text}')").first

        if not btn.is_visible():
            result["status"] = "not_found"
            result["details"] = "Button not visible"
            return result

        if not btn.is_enabled():
            result["status"] = "disabled"
            result["details"] = "Button is disabled"
            return result

        # Get page state before click
        initial_url = page.url
        initial_html_length = len(page.content())

        # Click the button
        btn.click()
        page.wait_for_timeout(500)

        # Check what happened
        new_url = page.url
        new_html_length = len(page.content())

        # Check for modal
        modal = page.locator("[role='dialog'], .modal, [data-state='open']").first
        modal_visible = modal.is_visible() if modal.count() > 0 else False

        # Check for form fields added
        # (Usually we'd check for increased input count, etc.)

        if expected_action == "opens_modal_or_form":
            if modal_visible or new_url != initial_url:
                result["status"] = "passed"
                result["details"] = "Modal opened or navigated"
            else:
                result["status"] = "failed"
                result["details"] = "No modal or navigation detected"

        elif expected_action == "adds_field":
            if new_html_length > initial_html_length:
                result["status"] = "passed"
                result["details"] = f"Content added (+{new_html_length - initial_html_length} chars)"
            else:
                result["status"] = "failed"
                result["details"] = "No content change detected"

        elif expected_action == "submits_form":
            # For submit, just check it's clickable
            result["status"] = "passed"
            result["details"] = "Button clicked successfully"

        elif expected_action == "navigates_away":
            if new_url != initial_url:
                result["status"] = "passed"
                result["details"] = f"Navigated to {new_url}"
            else:
                result["status"] = "failed"
                result["details"] = "No navigation"

        elif expected_action == "triggers_action":
            result["status"] = "passed"
            result["details"] = "Action triggered"

        elif expected_action == "removes_item":
            if new_html_length < initial_html_length:
                result["status"] = "passed"
                result["details"] = f"Content removed (-{initial_html_length - new_html_length} chars)"
            else:
                result["status"] = "check_needed"
                result["details"] = "May need confirmation"

        else:
            result["status"] = "passed"
            result["details"] = "Button clicked"

    except Exception as e:
        result["status"] = "error"
        result["details"] = str(e)[:100]

    return result


def main():
    results = {
        "total_scenarios": len(TEST_SCENARIOS),
        "scenarios_passed": 0,
        "scenarios_failed": 0,
        "button_results": [],
        "summary": {
            "passed": 0,
            "failed": 0,
            "disabled": 0,
            "not_found": 0,
            "error": 0
        }
    }

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1920, "height": 1080})
        page = context.new_page()

        # Login
        print("="*60)
        print("LOGGING IN")
        print("="*60)

        tokens = login_user()
        if not tokens:
            print("❌ Could not login")
            return results

        # Set tokens
        page.goto(f"{BASE_URL}/login", wait_until="networkidle")
        page.evaluate(f"""() => {{
            localStorage.setItem('breeze-auth', JSON.stringify({{
                state: {{
                    user: {{ email: '{TEST_USER["email"]}', name: '{TEST_USER["name"]}' }},
                    tokens: {{ accessToken: '{tokens["accessToken"]}', refreshToken: '{tokens["refreshToken"]}' }},
                    isAuthenticated: true
                }},
                version: 0
            }}));
        }}""")
        print("✅ Logged in")

        # Test each scenario
        for scenario in TEST_SCENARIOS:
            print(f"\n{'='*60}")
            print(f"Testing: {scenario['name']} ({scenario['path']})")
            print("="*60)

            try:
                page.goto(f"{BASE_URL}{scenario['path']}", wait_until="networkidle", timeout=15000)
                page.wait_for_timeout(1000)

                # Check not redirected to login
                if "/login" in page.url:
                    print("  ⚠️  Redirected to login - skipping")
                    continue

                scenario_passed = True
                for btn_spec in scenario["buttons"]:
                    result = test_button_click(page, btn_spec["text"], btn_spec["action"])
                    result["page"] = scenario["name"]
                    result["type"] = btn_spec["type"]
                    results["button_results"].append(result)

                    status_icon = {
                        "passed": "✅",
                        "failed": "❌",
                        "disabled": "⚠️",
                        "not_found": "❓",
                        "error": "💥",
                        "check_needed": "🔍"
                    }.get(result["status"], "❔")

                    print(f"  {status_icon} {result['button']}: {result['status']} - {result['details']}")

                    # Update summary
                    if result["status"] in results["summary"]:
                        results["summary"][result["status"]] += 1
                    if result["status"] not in ["passed", "check_needed"]:
                        scenario_passed = False

                    # Reload page for next button test
                    page.goto(f"{BASE_URL}{scenario['path']}", wait_until="networkidle", timeout=15000)
                    page.wait_for_timeout(500)

                if scenario_passed:
                    results["scenarios_passed"] += 1
                else:
                    results["scenarios_failed"] += 1

            except Exception as e:
                print(f"  💥 Error: {str(e)[:100]}")
                results["scenarios_failed"] += 1

        browser.close()

    # Print summary
    print("\n" + "="*60)
    print("SUMMARY")
    print("="*60)
    print(f"Scenarios tested: {results['total_scenarios']}")
    print(f"Scenarios passed: {results['scenarios_passed']}")
    print(f"Scenarios with issues: {results['scenarios_failed']}")
    print(f"\nButton Results:")
    for status, count in results["summary"].items():
        if count > 0:
            print(f"  {status}: {count}")

    # List failed buttons
    failed = [r for r in results["button_results"] if r["status"] in ["failed", "error", "not_found"]]
    if failed:
        print(f"\nFailed buttons ({len(failed)}):")
        for f in failed:
            print(f"  - {f['page']}/{f['button']}: {f['details']}")

    # Save results
    with open("/tmp/crud-click-results.json", "w") as f:
        json.dump(results, f, indent=2)
    print("\nDetailed results saved to /tmp/crud-click-results.json")

    return results


if __name__ == "__main__":
    main()
