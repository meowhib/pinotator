import { z } from 'zod';

const requestSchema = z
  .object({
    templateId: z.enum(['review-team', 'project-bootstrap']),
    scope: z.enum(['global', 'project']),
    confirmed: z.literal(true),
  })
  .strict();

const TEAM = [
  {
    name: 'code-reviewer',
    content: `---\nname: code-reviewer\ndescription: Review a proposed change for correctness, security, and regressions.\nsystemPromptMode: append\ninheritProjectContext: true\ninheritGlobalContext: false\ninheritSkills: false\ntools:\n  - read\n  - grep\n  - find\n---\n\nReview the requested change. Prioritize concrete correctness, security, and regression findings. Cite exact files and lines where possible. Do not modify files. If no actionable issue is found, state that and mention remaining uncertainty.\n`,
  },
  {
    name: 'test-planner',
    content: `---\nname: test-planner\ndescription: Identify focused tests and verification gaps for a code change.\nsystemPromptMode: append\ninheritProjectContext: true\ninheritGlobalContext: false\ninheritSkills: false\ntools:\n  - read\n  - grep\n  - find\n---\n\nInspect the code and existing tests. Recommend the smallest effective verification plan, including missing edge cases and relevant commands. Do not edit files or claim tests were run unless the parent provides evidence.\n`,
  },
  {
    name: 'docs-reviewer',
    content: `---\nname: docs-reviewer\ndescription: Check whether documentation accurately describes a code change.\nsystemPromptMode: append\ninheritProjectContext: true\ninheritGlobalContext: false\ninheritSkills: false\ntools:\n  - read\n  - grep\n  - find\n---\n\nCompare the implementation with its documentation. Report stale claims, missing user-facing steps, and unsupported guarantees. Do not edit files. Distinguish observations from assumptions.\n`,
  },
];

const templates = [
  {
    id: 'review-team',
    name: 'Code review team',
    description: 'Stage a reviewer, test planner, and documentation reviewer as one changeset.',
    requiresAdapter: 'pi-subagents 0.84.0',
    files: TEAM.map((agent) => ({
      intent: 'create',
      createTarget: { scope: null, kind: 'agent', basename: agent.name },
      content: agent.content,
    })),
  },
  {
    id: 'project-bootstrap',
    name: 'Project instruction starter',
    description:
      'Stage a concise AGENTS.md checklist for documenting project-specific conventions.',
    requiresAdapter: null,
    files: [
      {
        intent: 'create',
        createTarget: { scope: null, kind: 'instruction', basename: 'AGENTS.md' },
        content: `# Project instructions\n\n## Repository conventions\n- Describe the build and test commands that contributors should use.\n- Record code style, architecture boundaries, and important invariants.\n- Identify generated files and files that must not be edited directly.\n\n## Change verification\n- Run focused tests for each change and the full suite when practical.\n- Report commands that were not run; do not claim unverified results.\n- Keep credentials and private data out of source, logs, and test fixtures.\n\n## Review expectations\n- Prefer minimal, reversible changes.\n- Cite evidence for behavior that depends on installed tools or runtime versions.\n`,
      },
    ],
  },
];

export function createTemplateService({ propose }) {
  const byId = new Map(templates.map((template) => [template.id, template]));
  return {
    list() {
      return templates.map(({ id, name, description, requiresAdapter }) => ({
        id,
        name,
        description,
        requiresAdapter,
        fileCount: byId.get(id).files.length,
      }));
    },
    async stage(payload) {
      const request = requestSchema.parse(payload);
      const template = byId.get(request.templateId);
      const edits = template.files.map((file) => ({
        ...file,
        createTarget: { ...file.createTarget, scope: request.scope },
      }));
      return propose({ edits });
    },
  };
}
