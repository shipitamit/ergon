"""A browsing agent that navigates and reads a page.

    pip install ergon[browser] anthropic
    playwright install chromium
    export ANTHROPIC_API_KEY=sk-ant-...
    python examples/browsing.py

Act-tools (click/type/submit) are approval-gated. This example is read-only by
leaving the default unattended policy in place, so the agent can navigate and
read but not act. To let it act, pass an ApprovalPolicy with standing
allow-rules — and never do that against untrusted sites.
"""
from ergon import Agent, BrowserSession, browser_tools

with BrowserSession(headless=True) as browser:
    agent = Agent(
        "researcher",
        system="Use the browser tools to answer the question. Navigate, then read the page.",
        model="claude-sonnet-4-6",
        tools=browser_tools(browser),
    )
    result = agent.run("Go to https://example.com and tell me what the page says.")
    print(result.text)
    print(result.usage)
