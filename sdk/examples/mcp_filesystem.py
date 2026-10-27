"""Use an MCP server's tools from an Ergon agent.

    pip install ergon[mcp] anthropic
    export ANTHROPIC_API_KEY=sk-ant-...
    # needs Node for this particular server:
    python examples/mcp_filesystem.py

Points the agent at the official filesystem MCP server and lets it read files.
MCP act-tools are approval-gated by default; this stays safe by only allowing
the read-only tools unattended.
"""
from ergon import Agent, MCPClient, mcp_tools, mcp_resource_tools

with MCPClient.stdio("npx", ["-y", "@modelcontextprotocol/server-filesystem", "."]) as mcp:
    agent = Agent(
        "fs",
        system="Use the filesystem tools to answer the question.",
        model="claude-sonnet-4-6",
        # trust the server's read-only annotations so reads run without prompts;
        # anything that writes still needs approval
        # tools + the server's data resources (read-only), both exposed to the agent
        tools=[*mcp_tools(mcp, trust_readonly_hint=True), *mcp_resource_tools(mcp)],
    )
    print(agent.run("List the files here and summarize the README if there is one.").text)
