#!/usr/bin/env python3
"""
Crawl all navigation pages and test CRUD action buttons.
First registers/logs in a test user, then crawls authenticated pages.
"""

from playwright.sync_api import sync_playwright
import json
import time
import requests

BASE_URL = "http://localhost:4321"
API_URL = "http://localhost:3001/api/v1"

# Test user credentials
TEST_USER = {
    "email": "test@example.com",
    "password": "TestPassword123!",
    "name": "Test User"
}

# Main navigation pages to test
PAGES = [
    # Dashboard
    {"path": "/", "name": "Dashboard"},

    # Devices
    {"path": "/devices", "name": "Devices"},
    {"path": "/devices/groups", "name": "Device Groups"},

    # Scripts
    {"path": "/scripts", "name": "Scripts"},
    {"path": "/scripts/new", "name": "New Script"},

    # Alerts
    {"path": "/alerts", "name": "Alerts"},
    {"path": "/alerts/rules", "name": "Alert Rules"},
    {"path": "/alerts/rules/new", "name": "New Alert Rule"},
    {"path": "/alerts/channels", "name": "Notification Channels"},

    # Automations
    {"path": "/automations", "name": "Automations"},
    {"path": "/automations/new", "name": "New Automation"},

    # Policies
    {"path": "/policies", "name": "Policies"},
    {"path": "/policies/new", "name": "New Policy"},
    {"path": "/policies/compliance", "name": "Compliance"},

    # Reports
    {"path": "/reports", "name": "Reports"},
    {"path": "/reports/new", "name": "New Report"},
    {"path": "/reports/builder", "name": "Report Builder"},

    # Remote
    {"path": "/remote", "name": "Remote"},
    {"path": "/remote/sessions", "name": "Remote Sessions"},
    {"path": "/remote/tools", "name": "Remote Tools"},

    # Patches
    {"path": "/patches", "name": "Patches"},

    # Discovery
    {"path": "/discovery", "name": "Discovery"},

    # Analytics
    {"path": "/analytics", "name": "Analytics"},

    # SNMP
    {"path": "/snmp", "name": "SNMP"},

    # Backup
    {"path": "/backup", "name": "Backup"},

    # Software
    {"path": "/software", "name": "Software"},

    # Security
    {"path": "/security", "name": "Security"},

    # Compliance
    {"path": "/compliance", "name": "Compliance Dashboard"},

    # Audit
    {"path": "/audit", "name": "Audit"},

    # Partner
    {"path": "/partner", "name": "Partner Dashboard"},

    # Settings
    {"path": "/settings", "name": "Settings"},
    {"path": "/settings/organizations", "name": "Organizations"},
    {"path": "/settings/organization", "name": "Organization Settings"},
    {"path": "/settings/users", "name": "Users"},
    {"path": "/settings/sites", "name": "Sites"},
    {"path": "/settings/roles", "name": "Roles"},
    {"path": "/settings/api-keys", "name": "API Keys"},
    {"path": "/settings/sso", "name": "SSO"},
    {"path": "/settings/access-reviews", "name": "Access Reviews"},
    {"path": "/settings/profile", "name": "Profile"},
    {"path": "/settings/webhooks", "name": "Webhooks"},

    # Integrations
    {"path": "/integrations/webhooks", "name": "Webhooks Integration"},
    {"path": "/integrations/psa", "name": "PSA Integration"},
    {"path": "/settings/integrations/ticketing", "name": "Ticketing Integration"},
    {"path": "/settings/integrations/communication", "name": "Communication Integration"},
    {"path": "/settings/integrations/monitoring", "name": "Monitoring Integration"},
    {"path": "/settings/integrations/psa", "name": "PSA Settings"},
]

# CRUD button patterns to look for
CRUD_PATTERNS = [
    # Create patterns
    ("Create", "text=Create"),
    ("Add", "text=Add"),
    ("New", "text=New"),
    ("Add New", "text=Add New"),

    # Read/View patterns
    ("View", "text=View"),
    ("Details", "text=Details"),

    # Update patterns
    ("Edit", "text=Edit"),
    ("Update", "text=Update"),
    ("Save", "text=Save"),

    # Delete patterns
    ("Delete", "text=Delete"),
    ("Remove", "text=Remove"),

    # Other action patterns
    ("Run", "text=Run"),
    ("Execute", "text=Execute"),
    ("Start", "text=Start"),
    ("Stop", "text=Stop"),
    ("Refresh", "text=Refresh"),
    ("Export", "text=Export"),
    ("Import", "text=Import"),
    ("Download", "text=Download"),
    ("Upload", "text=Upload"),
    ("Approve", "text=Approve"),
    ("Apply", "text=Apply"),
    ("Cancel", "text=Cancel"),
    ("Submit", "text=Submit"),
    ("Test", "text=Test"),
    ("Trigger", "text=Trigger"),
    ("Deploy", "text=Deploy"),
    ("Schedule", "text=Schedule"),
    ("Configure", "text=Configure"),
    ("Connect", "text=Connect"),
    ("Scan", "text=Scan"),
    ("Sync", "text=Sync"),
    ("Discover", "text=Discover"),
]


def register_or_login_user():
    """Register a test user or login if already exists."""
    # Try to register
    try:
        resp = requests.post(f"{API_URL}/auth/register", json=TEST_USER, timeout=5)
        if resp.status_code == 200:
            data = resp.json()
            if "tokens" in data and data["tokens"]:
                print("✅ Registered new test user")
                return data["tokens"]
    except Exception as e:
        print(f"Registration error: {e}")

    # Try to login
    try:
        resp = requests.post(f"{API_URL}/auth/login", json={
            "email": TEST_USER["email"],
            "password": TEST_USER["password"]
        }, timeout=5)
        if resp.status_code == 200:
            data = resp.json()
            if "tokens" in data and data["tokens"]:
                print("✅ Logged in as test user")
                return data["tokens"]
    except Exception as e:
        print(f"Login error: {e}")

    return None


def find_crud_buttons(page):
    """Find all CRUD-related buttons on a page."""
    buttons = []

    # Find all buttons
    for btn in page.locator("button:visible").all():
        try:
            text = btn.inner_text(timeout=1000).strip()
            is_enabled = btn.is_enabled()
            if text and len(text) < 100:
                buttons.append({
                    "type": "button",
                    "text": text[:50],
                    "enabled": is_enabled,
                    "tag": "BUTTON"
                })
        except:
            pass

    # Find action links (buttons styled as links)
    for link in page.locator("a:visible").all():
        try:
            text = link.inner_text(timeout=1000).strip()
            classes = link.get_attribute("class") or ""
            href = link.get_attribute("href") or ""
            # Only include links that look like action buttons
            if ("btn" in classes.lower() or "button" in classes.lower()) and text and len(text) < 100:
                buttons.append({
                    "type": "link-button",
                    "text": text[:50],
                    "enabled": True,
                    "tag": "A",
                    "href": href
                })
        except:
            pass

    return buttons


def categorize_buttons(buttons):
    """Categorize buttons by CRUD type."""
    categories = {
        "Create": [],
        "Read": [],
        "Update": [],
        "Delete": [],
        "Other Actions": []
    }

    create_words = ["create", "add", "new", "+"]
    read_words = ["view", "details", "show", "open"]
    update_words = ["edit", "update", "save", "modify"]
    delete_words = ["delete", "remove", "trash"]

    for btn in buttons:
        text = btn["text"].lower()
        categorized = False

        if any(w in text for w in create_words):
            categories["Create"].append(btn)
            categorized = True
        elif any(w in text for w in read_words):
            categories["Read"].append(btn)
            categorized = True
        elif any(w in text for w in update_words):
            categories["Update"].append(btn)
            categorized = True
        elif any(w in text for w in delete_words):
            categories["Delete"].append(btn)
            categorized = True

        # Check for other action words
        action_words = ["run", "execute", "start", "stop", "refresh", "export", "import",
                       "download", "upload", "approve", "apply", "cancel", "submit",
                       "test", "trigger", "deploy", "schedule", "configure", "connect",
                       "scan", "sync", "discover", "generate", "reset", "enable", "disable"]
        if not categorized and any(w in text for w in action_words):
            categories["Other Actions"].append(btn)

    return categories


def main():
    results = {
        "pages_tested": 0,
        "pages_with_content": 0,
        "pages_login_required": 0,
        "total_buttons": 0,
        "crud_summary": {
            "Create": 0,
            "Read": 0,
            "Update": 0,
            "Delete": 0,
            "Other Actions": 0
        },
        "errors": [],
        "page_results": []
    }

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1920, "height": 1080})
        page = context.new_page()

        # First, try to login via the UI
        print("="*60)
        print("ATTEMPTING TO LOGIN")
        print("="*60)

        # Navigate to login page
        page.goto(f"{BASE_URL}/login", wait_until="networkidle", timeout=15000)
        page.wait_for_timeout(1000)

        # Fill login form
        try:
            # Try to register first via API
            tokens = register_or_login_user()

            if tokens:
                # Set tokens in localStorage
                page.evaluate(f"""() => {{
                    localStorage.setItem('auth-token', '{tokens["accessToken"]}');
                    localStorage.setItem('refresh-token', '{tokens["refreshToken"]}');
                    localStorage.setItem('breeze-auth', JSON.stringify({{
                        state: {{
                            user: {{ email: '{TEST_USER["email"]}', name: '{TEST_USER["name"]}' }},
                            tokens: {{ accessToken: '{tokens["accessToken"]}', refreshToken: '{tokens["refreshToken"]}' }},
                            isAuthenticated: true
                        }},
                        version: 0
                    }}));
                }}""")
                print("✅ Set authentication tokens in browser")
            else:
                print("⚠️  Could not authenticate - will try pages anyway")
        except Exception as e:
            print(f"⚠️  Login error: {e}")

        # Navigate to each page
        for page_info in PAGES:
            url = f"{BASE_URL}{page_info['path']}"
            print(f"\n{'='*60}")
            print(f"Testing: {page_info['name']} ({page_info['path']})")
            print("="*60)

            try:
                # Navigate to page
                response = page.goto(url, wait_until="networkidle", timeout=15000)

                if response and response.status >= 400:
                    print(f"  ❌ HTTP {response.status}")
                    results["errors"].append({
                        "page": page_info["name"],
                        "error": f"HTTP {response.status}"
                    })
                    continue

                # Wait for React to hydrate
                page.wait_for_timeout(1500)

                # Check if we're on login page (redirected)
                current_url = page.url
                if "/login" in current_url and page_info["path"] != "/login":
                    print(f"  ⚠️  Redirected to login")
                    results["pages_login_required"] += 1
                    continue

                # Find all buttons
                buttons = find_crud_buttons(page)
                categories = categorize_buttons(buttons)

                # Count CRUD buttons
                total_crud = sum(len(v) for v in categories.values())

                print(f"  ✅ Page loaded")
                print(f"  📊 Found {len(buttons)} total buttons, {total_crud} CRUD-related")

                # Show categorized buttons
                for cat, btns in categories.items():
                    if btns:
                        results["crud_summary"][cat] += len(btns)
                        print(f"  📌 {cat} ({len(btns)}):")
                        for btn in btns[:5]:  # Limit to 5 per category
                            status = "✓" if btn["enabled"] else "✗ disabled"
                            print(f"     - {btn['text']} [{btn['tag']}] {status}")
                        if len(btns) > 5:
                            print(f"     ... and {len(btns) - 5} more")

                results["pages_tested"] += 1
                if total_crud > 0:
                    results["pages_with_content"] += 1
                results["total_buttons"] += len(buttons)

                results["page_results"].append({
                    "page": page_info["name"],
                    "path": page_info["path"],
                    "total_buttons": len(buttons),
                    "crud_buttons": total_crud,
                    "categories": {k: len(v) for k, v in categories.items()},
                    "button_details": [b for b in buttons if any(
                        w in b["text"].lower() for w in
                        ["create", "add", "new", "edit", "update", "save", "delete", "remove",
                         "run", "execute", "start", "stop", "refresh", "export", "import"]
                    )][:20]
                })

            except Exception as e:
                print(f"  ❌ Error: {str(e)[:100]}")
                results["errors"].append({
                    "page": page_info["name"],
                    "error": str(e)[:200]
                })

        browser.close()

    # Print summary
    print("\n" + "="*60)
    print("SUMMARY")
    print("="*60)
    print(f"Pages tested: {results['pages_tested']}")
    print(f"Pages with CRUD content: {results['pages_with_content']}")
    print(f"Pages requiring login: {results['pages_login_required']}")
    print(f"Total buttons found: {results['total_buttons']}")
    print(f"\nCRUD Button Summary:")
    for cat, count in results["crud_summary"].items():
        print(f"  {cat}: {count}")

    if results["errors"]:
        print(f"\nErrors ({len(results['errors'])}):")
        for err in results["errors"][:10]:
            print(f"  - {err['page']}: {err['error'][:50]}")

    # Save detailed results
    with open("/tmp/crud-button-results.json", "w") as f:
        json.dump(results, f, indent=2)
    print("\nDetailed results saved to /tmp/crud-button-results.json")

    return results


if __name__ == "__main__":
    main()
