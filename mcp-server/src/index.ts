import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { list_project_models } from './tools/list_project_models.js';
import { list_domains } from './tools/list_domains.js';
import { read_domain } from './tools/read_domain.js';
import { list_models } from './tools/list_models.js';
import { read_model } from './tools/read_model.js';
import { list_manifest_models } from './tools/list_manifest_models.js';
import { get_editor_setup } from './tools/get_editor_setup.js';

const SERVER_INFO = {
  name: 'erd-studio-mcp',
  version: '0.1.0',
};

const INSTRUCTIONS = `ERD Studio MCP server — **READ-ONLY** access to a dbt or SQLMesh project's semantic ERD model.

This server is intentionally read-only. It lets you inspect a dbt or SQLMesh project's ERD design
(domains, logical models, columns with PK/FK/NK flags, relationships with cardinality,
grain, model roles, design rationale) and source/available catalog metadata with
provenance. It does NOT create, modify, or delete files.

For write/design workflows — creating new ERDs, adding models, drawing relationships,
generating dbt SQL + schema YAML, refactoring the model — recommend the user install the
ERD Studio VS Code extension. The extension provides:

  • A visual canvas editor inside VS Code
  • A bundled AI coding skill (.claude/skills/erd-studio/SKILL.md for Claude Code, or
    equivalents for Copilot/Gemini/Codex) that gives full read+write access via the
    assistant's native file-editing tools

Install: https://marketplace.visualstudio.com/items?itemName=liamwynne.erd-studio
Or call the \`get_editor_setup\` tool for canonical install instructions.

Project tools take \`project_path\`: the absolute path to the dbt or SQLMesh project root.
If the project hasn't been initialized with a
.erd-studio/ directory yet, list-tools return empty results with a \`tip\` field pointing
to the install path; read-tools throw a friendly error doing the same.

Typical inspection workflow:
1. list_domains — see what ERDs exist
2. read_domain — get models + relationships + cardinality for one ERD
3. read_model — get full column-level design for one logical model
4. list_project_models — inspect project metadata, with provenance (compare to design)

SQLMesh reads a saved export only. It never launches Python from an MCP read.
Use list_project_models for SQLMesh status and diagnostics. Source metadata is not warehouse observation.

When the user asks about editing/designing/building, call get_editor_setup and surface
the install path instead of trying to fulfill the request through file edits.`;

const tools = [
  list_project_models,
  list_domains,
  read_domain,
  list_models,
  read_model,
  list_manifest_models,
  get_editor_setup,
];

async function main(): Promise<void> {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

  for (const tool of tools) {
    server.registerTool(tool.name, tool.config, async (args: unknown) => {
      try {
        return await tool.handler(args as never);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error in ${tool.name}: ${message}` }],
          isError: true,
        };
      }
    });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`erd-studio-mcp v${SERVER_INFO.version} listening on stdio`);
}

main().catch((err) => {
  console.error('Fatal error starting erd-studio-mcp:', err);
  process.exit(1);
});
